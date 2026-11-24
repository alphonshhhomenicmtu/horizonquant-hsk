// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Minimal, ISwapRouter, IUniswapV3PoolMinimal} from "./interfaces/ISwapRouter.sol";

/// @title HorizonGuardVault
/// @notice Non-custodial Session-Key & Guarded AI Trading Vault for HashKey Chain (Chain ID 177 / 133).
/// @dev Enforces hard on-chain trading invariants that off-chain AI agents cannot bypass:
///      1. Scoped EIP-712 session keys with expiry, cumulative volume cap, and trade cooldown.
///      2. Hard per-trade slippage ceiling and minimum output verification.
///      3. Max single-trade position size relative to vault token balance.
///      4. Rolling UTC 24-hour high-water daily drawdown circuit breaker (normalized for owner deposits/withdrawals).
///      5. Strict allowlists for DEX routers (HSKSwap V3 SwapRouter) and directed (tokenIn, tokenOut, fee) pairs.
///      6. Exact-amount approvals reset to zero post-swap, reentrancy protection, emergency pause, and owner exit.
///      7. Verifiable on-chain audit trail of AI strategy tags and keccak256 signal hashes.
contract HorizonGuardVault {
    // =========================================================================
    // Constants & EIP-712 Domain
    // =========================================================================

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant HARD_MAX_SLIPPAGE_BPS = 500; // 5.00% absolute protocol ceiling
    uint16 public constant HARD_MAX_DRAWDOWN_BPS = 2_500; // 25.00% absolute protocol ceiling
    uint16 public constant HARD_MAX_POSITION_BPS = 10_000; // 100.00%
    uint256 private constant SECP256K1_HALF_N =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    uint256 private constant Q96 = 1 << 96;

    bytes32 public constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant NAME_HASH = keccak256("HorizonGuardVault");
    bytes32 public constant VERSION_HASH = keccak256("1");

    bytes32 public constant TRADE_INTENT_TYPEHASH = keccak256(
        "TradeIntent(address router,address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint256 minAmountOut,uint256 expectedAmountOut,uint16 maxSlippageBps,uint256 deadline,uint256 nonce,bytes32 strategyTag,bytes32 signalHash)"
    );

    // =========================================================================
    // Data Structures
    // =========================================================================

    struct RiskPolicy {
        uint16 maxSlippageBps; // Max per-trade slippage (e.g., 50 = 0.50%)
        uint16 maxPositionBps; // Max share of vault tokenIn balance per swap (e.g., 2500 = 25%)
        uint16 dailyDrawdownCapBps; // Max daily high-water NAV drawdown before circuit breaker trips (e.g., 300 = 3%)
        uint32 minTradeIntervalSec; // Cooldown between autonomous trades
        uint32 maxDailyTrades; // Maximum number of swaps allowed per UTC day
    }

    struct AgentSession {
        address agent; // Ephemeral session key signer authorized to sign TradeIntents
        uint64 expiresAt; // Unix timestamp when session key expires
        uint128 maxCumulativeVolumeQuoteE18; // Lifetime notional cap in 18-decimal quote units
        uint128 cumulativeVolumeQuoteE18; // Consumed notional volume
        bool active;
    }

    struct TradeIntent {
        address router;
        address tokenIn;
        address tokenOut;
        uint24 fee;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 expectedAmountOut;
        uint16 maxSlippageBps;
        uint256 deadline;
        uint256 nonce;
        bytes32 strategyTag;
        bytes32 signalHash;
    }

    struct ExecutionRecord {
        uint64 timestamp;
        address agent;
        address tokenIn;
        address tokenOut;
        uint24 fee;
        uint256 amountIn;
        uint256 amountOut;
        uint16 realizedSlippageBps;
        uint256 postTradeNavE18;
        bytes32 strategyTag;
        bytes32 signalHash;
    }

    // =========================================================================
    // Storage
    // =========================================================================

    address public owner;
    address public pendingOwner;
    address public immutable quoteToken; // Reference settlement token (e.g., USDT on HSK Chain)
    uint8 public immutable quoteDecimals;

    bool public paused;
    bool public circuitBreakerTripped;
    uint256 private _reentrancyLock = 1;

    RiskPolicy public policy;
    AgentSession public session;

    uint64 public lastTradeTimestamp;
    uint256 public currentDayIndex;
    uint256 public dayStartNavE18;
    uint256 public dayHighWaterNavE18;
    uint32 public dailyTradeCount;

    mapping(address => bool) public allowedRouters;
    mapping(bytes32 => bool) public allowedPairs;
    mapping(address => uint256) public nonces;

    // Multi-asset valuation registry for on-chain NAV and drawdown accounting
    address[] public trackedTokens;
    mapping(address => bool) public isTrackedToken;
    mapping(address => uint8) public tokenDecimals;
    mapping(address => uint256) public referencePriceE18; // 1.0 whole token valued in quote USD * 1e18

    ExecutionRecord[] private _executions;

    // =========================================================================
    // Events
    // =========================================================================

    event Deposited(address indexed sender, address indexed token, uint256 amount, uint256 newNavE18);
    event Withdrawn(address indexed recipient, address indexed token, uint256 amount, uint256 newNavE18);
    event EmergencyWithdrawn(address indexed recipient, address indexed token, uint256 amount);
    event RiskPolicyUpdated(
        uint16 maxSlippageBps,
        uint16 maxPositionBps,
        uint16 dailyDrawdownCapBps,
        uint32 minTradeIntervalSec,
        uint32 maxDailyTrades
    );
    event AgentSessionUpdated(address indexed agent, uint64 expiresAt, uint128 maxCumulativeVolumeQuoteE18, bool active);
    event RouterAllowlistUpdated(address indexed router, bool allowed);
    event PairAllowlistUpdated(address indexed tokenIn, address indexed tokenOut, uint24 fee, bool allowed);
    event ReferencePriceUpdated(address indexed token, uint256 priceE18, address indexed sourcePool);
    event VaultPaused(address indexed caller, bool isPaused);
    event CircuitBreakerTripped(uint256 currentNavE18, uint256 highWaterNavE18, uint256 drawdownBps);
    event CircuitBreakerReset(uint256 baselineNavE18);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed newPendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TradeExecuted(
        uint256 indexed executionId,
        address indexed agent,
        address indexed router,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOut,
        uint16 realizedSlippageBps,
        uint256 postTradeNavE18,
        uint256 nonce,
        bytes32 strategyTag,
        bytes32 signalHash
    );

    // =========================================================================
    // Custom Errors
    // =========================================================================

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error ReentrancyDetected();
    error VaultIsPaused();
    error CircuitBreakerActive();
    error InvalidRiskPolicy();
    error SessionNotActive();
    error SessionExpired(uint64 expiresAt, uint256 currentTime);
    error InvalidSignature();
    error InvalidNonce(uint256 expected, uint256 provided);
    error IntentExpired(uint256 deadline, uint256 currentTime);
    error RouterNotAllowed(address router);
    error PairNotAllowed(address tokenIn, address tokenOut, uint24 fee);
    error SlippageCapExceeded(uint256 providedBps, uint256 maxAllowedBps);
    error MinAmountOutBelowGuard(uint256 providedMinOut, uint256 requiredMinOut);
    error InsufficientSwapOutput(uint256 actualOut, uint256 requiredMinOut);
    error PositionSizeExceeded(uint256 amountIn, uint256 maxAllowedIn);
    error TradeCooldownActive(uint256 nextAllowedTime, uint256 currentTime);
    error MaxDailyTradesReached(uint32 currentCount, uint32 maxDailyTrades);
    error SessionVolumeBudgetExceeded(uint256 projectedVolumeE18, uint256 maxVolumeE18);
    error DailyDrawdownExceeded(uint256 drawdownBps, uint256 capBps);
    error UntrackedToken(address token);
    error InvalidPoolForToken(address pool, address token);
    error TokenTransferFailed();

    // =========================================================================
    // Modifiers
    // =========================================================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyLock != 1) revert ReentrancyDetected();
        _reentrancyLock = 2;
        _;
        _reentrancyLock = 1;
    }

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor(
        address initialOwner,
        address quoteTokenAddress,
        uint8 quoteTokenDecimals,
        RiskPolicy memory initialPolicy
    ) {
        if (initialOwner == address(0) || quoteTokenAddress == address(0)) revert ZeroAddress();
        _validatePolicy(initialPolicy);

        owner = initialOwner;
        quoteToken = quoteTokenAddress;
        quoteDecimals = quoteTokenDecimals;
        policy = initialPolicy;
        currentDayIndex = block.timestamp / 1 days;

        // Register quote token with unit price = 1.0e18
        _registerToken(quoteTokenAddress, quoteTokenDecimals, 1e18);

        emit OwnershipTransferred(address(0), initialOwner);
        emit RiskPolicyUpdated(
            initialPolicy.maxSlippageBps,
            initialPolicy.maxPositionBps,
            initialPolicy.dailyDrawdownCapBps,
            initialPolicy.minTradeIntervalSec,
            initialPolicy.maxDailyTrades
        );
    }

    // =========================================================================
    // Owner Custody & Emergency Controls
    // =========================================================================

    /// @notice Deposit tracked ERC-20 tokens into the non-custodial vault.
    /// @dev Adjusts daily NAV baselines proportionally so capital inflows never mask trading losses.
    function deposit(address token, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!isTrackedToken[token]) revert UntrackedToken(token);

        _rollDayIfNeeded();
        uint256 deltaNavE18 = _valueInQuoteE18(token, amount);

        _safeTransferFrom(token, msg.sender, address(this), amount);

        dayStartNavE18 += deltaNavE18;
        dayHighWaterNavE18 += deltaNavE18;

        emit Deposited(msg.sender, token, amount, computeTotalNavE18());
    }

    /// @notice Withdraw ERC-20 tokens back to the owner or a designated recipient.
    /// @dev Adjusts daily NAV baselines proportionally so withdrawals never trigger false drawdown trips.
    function withdraw(address token, uint256 amount, address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        _rollDayIfNeeded();
        uint256 deltaNavE18 = isTrackedToken[token] ? _valueInQuoteE18(token, amount) : 0;

        _safeTransfer(token, recipient, amount);

        dayStartNavE18 = dayStartNavE18 > deltaNavE18 ? dayStartNavE18 - deltaNavE18 : 0;
        dayHighWaterNavE18 = dayHighWaterNavE18 > deltaNavE18 ? dayHighWaterNavE18 - deltaNavE18 : 0;

        emit Withdrawn(recipient, token, amount, computeTotalNavE18());
    }

    /// @notice Emergency exit: pauses autonomous execution and transfers full balance of a token to owner.
    function emergencyWithdraw(address token, address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        paused = true;
        emit VaultPaused(msg.sender, true);

        uint256 balance = IERC20Minimal(token).balanceOf(address(this));
        if (balance > 0) {
            _safeTransfer(token, recipient, balance);
        }

        uint256 navAfter = computeTotalNavE18();
        dayStartNavE18 = navAfter;
        dayHighWaterNavE18 = navAfter;

        emit EmergencyWithdrawn(recipient, token, balance);
    }

    function setPaused(bool shouldPause) external onlyOwner {
        paused = shouldPause;
        emit VaultPaused(msg.sender, shouldPause);
    }

    function resetCircuitBreaker() external onlyOwner {
        circuitBreakerTripped = false;
        currentDayIndex = block.timestamp / 1 days;
        uint256 nav = computeTotalNavE18();
        dayStartNavE18 = nav;
        dayHighWaterNavE18 = nav;
        dailyTradeCount = 0;
        emit CircuitBreakerReset(nav);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, owner);
    }

    // =========================================================================
    // Owner Risk Policy, Session Key, Allowlists & Valuation Config
    // =========================================================================

    function updateRiskPolicy(RiskPolicy calldata newPolicy) external onlyOwner {
        _validatePolicy(newPolicy);
        policy = newPolicy;
        emit RiskPolicyUpdated(
            newPolicy.maxSlippageBps,
            newPolicy.maxPositionBps,
            newPolicy.dailyDrawdownCapBps,
            newPolicy.minTradeIntervalSec,
            newPolicy.maxDailyTrades
        );
    }

    function setAgentSessionKey(
        address agent,
        uint64 expiresAt,
        uint128 maxCumulativeVolumeQuoteE18
    ) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        if (expiresAt <= block.timestamp) revert SessionExpired(expiresAt, block.timestamp);
        if (maxCumulativeVolumeQuoteE18 == 0) revert ZeroAmount();

        session = AgentSession({
            agent: agent,
            expiresAt: expiresAt,
            maxCumulativeVolumeQuoteE18: maxCumulativeVolumeQuoteE18,
            cumulativeVolumeQuoteE18: 0,
            active: true
        });

        emit AgentSessionUpdated(agent, expiresAt, maxCumulativeVolumeQuoteE18, true);
    }

    function revokeAgentSessionKey() external onlyOwner {
        session.active = false;
        emit AgentSessionUpdated(session.agent, session.expiresAt, session.maxCumulativeVolumeQuoteE18, false);
    }

    function setAllowedRouter(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        allowedRouters[router] = allowed;
        emit RouterAllowlistUpdated(router, allowed);
    }

    function setAllowedPair(address tokenIn, address tokenOut, uint24 fee, bool allowed) external onlyOwner {
        if (tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut) revert ZeroAddress();
        allowedPairs[pairKey(tokenIn, tokenOut, fee)] = allowed;
        emit PairAllowlistUpdated(tokenIn, tokenOut, fee, allowed);
    }

    function registerToken(address token, uint8 decimals_, uint256 initialPriceE18) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (initialPriceE18 == 0) revert ZeroAmount();
        _registerToken(token, decimals_, initialPriceE18);
        emit ReferencePriceUpdated(token, initialPriceE18, address(0));
    }

    function setReferencePrice(address token, uint256 newPriceE18) external onlyOwner {
        if (!isTrackedToken[token]) revert UntrackedToken(token);
        if (newPriceE18 == 0) revert ZeroAmount();
        referencePriceE18[token] = newPriceE18;
        emit ReferencePriceUpdated(token, newPriceE18, address(0));
    }

    /// @notice Synchronize a tracked token's reference price directly from a live HSKSwap V3 pool paired with quoteToken.
    /// @dev Reads `slot0().sqrtPriceX96` on-chain so mark-to-market NAV tracks live HSKSwap liquidity without external oracles.
    function syncPriceFromV3Pool(address token, address pool) external returns (uint256 priceE18) {
        if (!isTrackedToken[token]) revert UntrackedToken(token);
        if (pool == address(0)) revert ZeroAddress();

        IUniswapV3PoolMinimal v3Pool = IUniswapV3PoolMinimal(pool);
        address t0 = v3Pool.token0();
        address t1 = v3Pool.token1();
        if (!((t0 == token && t1 == quoteToken) || (t1 == token && t0 == quoteToken))) {
            revert InvalidPoolForToken(pool, token);
        }

        (uint160 sqrtPriceX96,,,,,,) = v3Pool.slot0();
        if (sqrtPriceX96 == 0) revert ZeroAmount();

        uint8 tokDec = tokenDecimals[token];
        priceE18 = _computeSpotPriceE18(sqrtPriceX96, t0 == token, tokDec, quoteDecimals);
        if (priceE18 == 0) revert ZeroAmount();

        referencePriceE18[token] = priceE18;
        emit ReferencePriceUpdated(token, priceE18, pool);
    }

    /// @notice Permissionless sentinel hook: trips the on-chain circuit breaker if current NAV breaches dailyDrawdownCapBps.
    function checkAndTripCircuitBreaker() external returns (bool tripped) {
        _rollDayIfNeeded();
        uint256 nav = computeTotalNavE18();
        uint256 ddBps = _computeDrawdownBps(nav, dayHighWaterNavE18);
        if (ddBps >= policy.dailyDrawdownCapBps) {
            circuitBreakerTripped = true;
            emit CircuitBreakerTripped(nav, dayHighWaterNavE18, ddBps);
            return true;
        }
        return false;
    }

    // =========================================================================
    // Autonomous Guarded Execution (EIP-712 Signed Trade Intents)
    // =========================================================================

    /// @notice Execute an AI agent's EIP-712 signed swap intent on an allowlisted HSKSwap router under hard on-chain guardrails.
    function executeGuardedSwap(
        TradeIntent calldata intent,
        bytes calldata signature
    ) external nonReentrant returns (uint256 amountOut) {
        if (paused) revert VaultIsPaused();
        if (circuitBreakerTripped) revert CircuitBreakerActive();

        _rollDayIfNeeded();

        // 1. Validate session key, EIP-712 signature, replay nonce, and deadline
        address signer = _verifyAgentIntent(intent, signature);

        // 2. Enforce router, pair, frequency, slippage, position size, volume budget, and pre-trade drawdown caps
        uint256 tradeNotionalE18 = _enforcePreTradeGuards(intent);

        // 3. Consume monotonic nonce and update session / rate-limit state before external call (CEI pattern)
        nonces[signer] = intent.nonce + 1;
        lastTradeTimestamp = uint64(block.timestamp);
        dailyTradeCount += 1;
        session.cumulativeVolumeQuoteE18 += uint128(tradeNotionalE18);

        // 4. Execute exact-allowance swap on allowlisted HSKSwap V3 SwapRouter and clear residual allowance
        uint256 balanceOutBefore = IERC20Minimal(intent.tokenOut).balanceOf(address(this));
        _safeApprove(intent.tokenIn, intent.router, 0);
        _safeApprove(intent.tokenIn, intent.router, intent.amountIn);

        uint256 routerReportedOut = ISwapRouter(intent.router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: intent.tokenIn,
                tokenOut: intent.tokenOut,
                fee: intent.fee,
                recipient: address(this),
                deadline: intent.deadline,
                amountIn: intent.amountIn,
                amountOutMinimum: intent.minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );

        _safeApprove(intent.tokenIn, intent.router, 0);

        uint256 balanceOutAfter = IERC20Minimal(intent.tokenOut).balanceOf(address(this));
        amountOut = balanceOutAfter - balanceOutBefore;
        if (amountOut < intent.minAmountOut || routerReportedOut < intent.minAmountOut) {
            revert InsufficientSwapOutput(amountOut, intent.minAmountOut);
        }

        // 5. Post-trade mark-to-market NAV evaluation & automatic circuit breaker tripping
        uint16 realizedSlippageBps = _computeRealizedSlippageBps(intent.expectedAmountOut, amountOut);
        if (realizedSlippageBps > intent.maxSlippageBps) {
            revert SlippageCapExceeded(realizedSlippageBps, intent.maxSlippageBps);
        }

        uint256 postNavE18 = computeTotalNavE18();
        if (postNavE18 > dayHighWaterNavE18) {
            dayHighWaterNavE18 = postNavE18;
        }

        uint256 postDrawdownBps = _computeDrawdownBps(postNavE18, dayHighWaterNavE18);
        if (postDrawdownBps >= policy.dailyDrawdownCapBps) {
            circuitBreakerTripped = true;
            emit CircuitBreakerTripped(postNavE18, dayHighWaterNavE18, postDrawdownBps);
        }

        // 6. Append immutable on-chain execution record for verifiable signal provenance
        uint256 executionId = _executions.length;
        _executions.push(
            ExecutionRecord({
                timestamp: uint64(block.timestamp),
                agent: signer,
                tokenIn: intent.tokenIn,
                tokenOut: intent.tokenOut,
                fee: intent.fee,
                amountIn: intent.amountIn,
                amountOut: amountOut,
                realizedSlippageBps: realizedSlippageBps,
                postTradeNavE18: postNavE18,
                strategyTag: intent.strategyTag,
                signalHash: intent.signalHash
            })
        );

        emit TradeExecuted(
            executionId,
            signer,
            intent.router,
            intent.tokenIn,
            intent.tokenOut,
            intent.fee,
            intent.amountIn,
            amountOut,
            realizedSlippageBps,
            postNavE18,
            intent.nonce,
            intent.strategyTag,
            intent.signalHash
        );
    }

    // =========================================================================
    // View Functions & EIP-712 Helpers
    // =========================================================================

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
    }

    function hashTradeIntent(TradeIntent calldata intent) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TRADE_INTENT_TYPEHASH,
                intent.router,
                intent.tokenIn,
                intent.tokenOut,
                intent.fee,
                intent.amountIn,
                intent.minAmountOut,
                intent.expectedAmountOut,
                intent.maxSlippageBps,
                intent.deadline,
                intent.nonce,
                intent.strategyTag,
                intent.signalHash
            )
        );
    }

    function getTradeIntentDigest(TradeIntent calldata intent) external view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), hashTradeIntent(intent)));
    }

    function pairKey(address tokenIn, address tokenOut, uint24 fee) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(tokenIn, tokenOut, fee));
    }

    function computeTotalNavE18() public view returns (uint256 totalNavE18) {
        uint256 len = trackedTokens.length;
        for (uint256 i = 0; i < len; ++i) {
            address tok = trackedTokens[i];
            uint256 bal = IERC20Minimal(tok).balanceOf(address(this));
            if (bal > 0) {
                totalNavE18 += _valueInQuoteE18(tok, bal);
            }
        }
    }

    function currentDailyDrawdownBps() external view returns (uint256) {
        uint256 nav = computeTotalNavE18();
        uint256 highWater = (block.timestamp / 1 days > currentDayIndex) ? nav : dayHighWaterNavE18;
        return _computeDrawdownBps(nav, highWater);
    }

    function getExecutionCount() external view returns (uint256) {
        return _executions.length;
    }

    function getExecution(uint256 index) external view returns (ExecutionRecord memory) {
        return _executions[index];
    }

    function getTrackedTokens() external view returns (address[] memory) {
        return trackedTokens;
    }

    // =========================================================================
    // Internal Helpers
    // =========================================================================

    function _verifyAgentIntent(
        TradeIntent calldata intent,
        bytes calldata signature
    ) internal view returns (address signer) {
        if (!session.active) revert SessionNotActive();
        if (block.timestamp > session.expiresAt) revert SessionExpired(session.expiresAt, block.timestamp);
        if (block.timestamp > intent.deadline) revert IntentExpired(intent.deadline, block.timestamp);

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), hashTradeIntent(intent)));
        signer = _recoverSigner(digest, signature);
        if (signer == address(0) || signer != session.agent) revert InvalidSignature();

        uint256 expectedNonce = nonces[signer];
        if (intent.nonce != expectedNonce) revert InvalidNonce(expectedNonce, intent.nonce);
    }

    function _enforcePreTradeGuards(TradeIntent calldata intent) internal view returns (uint256 tradeNotionalE18) {
        if (intent.amountIn == 0 || intent.expectedAmountOut == 0) revert ZeroAmount();
        if (!allowedRouters[intent.router]) revert RouterNotAllowed(intent.router);
        if (!allowedPairs[pairKey(intent.tokenIn, intent.tokenOut, intent.fee)]) {
            revert PairNotAllowed(intent.tokenIn, intent.tokenOut, intent.fee);
        }
        if (!isTrackedToken[intent.tokenIn] || !isTrackedToken[intent.tokenOut]) {
            revert UntrackedToken(!isTrackedToken[intent.tokenIn] ? intent.tokenIn : intent.tokenOut);
        }

        // Trade frequency & daily trade count caps
        if (lastTradeTimestamp != 0 && block.timestamp < uint256(lastTradeTimestamp) + policy.minTradeIntervalSec) {
            revert TradeCooldownActive(uint256(lastTradeTimestamp) + policy.minTradeIntervalSec, block.timestamp);
        }
        if (dailyTradeCount >= policy.maxDailyTrades) {
            revert MaxDailyTradesReached(dailyTradeCount, policy.maxDailyTrades);
        }

        // Hard slippage ceiling check
        if (intent.maxSlippageBps > policy.maxSlippageBps) {
            revert SlippageCapExceeded(intent.maxSlippageBps, policy.maxSlippageBps);
        }
        uint256 minGuardOut = (intent.expectedAmountOut * (BPS_DENOMINATOR - intent.maxSlippageBps)) / BPS_DENOMINATOR;
        if (intent.minAmountOut < minGuardOut) {
            revert MinAmountOutBelowGuard(intent.minAmountOut, minGuardOut);
        }

        // Max single-trade position size relative to current tokenIn balance
        uint256 tokenInBalance = IERC20Minimal(intent.tokenIn).balanceOf(address(this));
        uint256 maxAllowedIn = (tokenInBalance * policy.maxPositionBps) / BPS_DENOMINATOR;
        if (intent.amountIn > maxAllowedIn) {
            revert PositionSizeExceeded(intent.amountIn, maxAllowedIn);
        }

        // Cumulative session notional budget check
        tradeNotionalE18 = _valueInQuoteE18(intent.tokenIn, intent.amountIn);
        uint256 projectedVolume = uint256(session.cumulativeVolumeQuoteE18) + tradeNotionalE18;
        if (projectedVolume > session.maxCumulativeVolumeQuoteE18) {
            revert SessionVolumeBudgetExceeded(projectedVolume, session.maxCumulativeVolumeQuoteE18);
        }

        // Pre-trade daily drawdown circuit breaker verification
        uint256 preNav = computeTotalNavE18();
        uint256 preDrawdownBps = _computeDrawdownBps(preNav, dayHighWaterNavE18);
        if (preDrawdownBps >= policy.dailyDrawdownCapBps) {
            revert DailyDrawdownExceeded(preDrawdownBps, policy.dailyDrawdownCapBps);
        }
    }

    function _rollDayIfNeeded() internal {
        uint256 dayIdx = block.timestamp / 1 days;
        if (dayIdx > currentDayIndex) {
            currentDayIndex = dayIdx;
            uint256 nav = computeTotalNavE18();
            dayStartNavE18 = nav;
            dayHighWaterNavE18 = nav;
            dailyTradeCount = 0;
        } else if (dayHighWaterNavE18 == 0) {
            uint256 nav = computeTotalNavE18();
            dayStartNavE18 = nav;
            dayHighWaterNavE18 = nav;
        }
    }

    function _registerToken(address token, uint8 decimals_, uint256 initialPriceE18) internal {
        if (!isTrackedToken[token]) {
            isTrackedToken[token] = true;
            trackedTokens.push(token);
        }
        tokenDecimals[token] = decimals_;
        referencePriceE18[token] = initialPriceE18;
    }

    function _valueInQuoteE18(address token, uint256 rawAmount) internal view returns (uint256) {
        uint256 scale = 10 ** uint256(tokenDecimals[token]);
        return (rawAmount * referencePriceE18[token]) / scale;
    }

    function _computeDrawdownBps(uint256 navE18, uint256 highWaterE18) internal pure returns (uint256) {
        if (highWaterE18 == 0 || navE18 >= highWaterE18) return 0;
        return ((highWaterE18 - navE18) * BPS_DENOMINATOR) / highWaterE18;
    }

    function _computeRealizedSlippageBps(
        uint256 expectedAmountOut,
        uint256 actualAmountOut
    ) internal pure returns (uint16) {
        if (actualAmountOut >= expectedAmountOut || expectedAmountOut == 0) return 0;
        uint256 bps = ((expectedAmountOut - actualAmountOut) * BPS_DENOMINATOR) / expectedAmountOut;
        return bps > type(uint16).max ? type(uint16).max : uint16(bps);
    }

    function _validatePolicy(RiskPolicy memory p) internal pure {
        if (
            p.maxSlippageBps == 0 ||
            p.maxSlippageBps > HARD_MAX_SLIPPAGE_BPS ||
            p.maxPositionBps == 0 ||
            p.maxPositionBps > HARD_MAX_POSITION_BPS ||
            p.dailyDrawdownCapBps == 0 ||
            p.dailyDrawdownCapBps > HARD_MAX_DRAWDOWN_BPS ||
            p.maxDailyTrades == 0
        ) {
            revert InvalidRiskPolicy();
        }
    }

    function _recoverSigner(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > SECP256K1_HALF_N) return address(0);
        return ecrecover(digest, v, r, s);
    }

    /// @dev Overflow-safe conversion of Uniswap V3 sqrtPriceX96 to 1e18-scaled quote USD price per 1 whole token.
    function _computeSpotPriceE18(
        uint160 sqrtPriceX96,
        bool tokenIsToken0,
        uint8 tokDec,
        uint8 qDec
    ) internal pure returns (uint256) {
        uint256 s = uint256(sqrtPriceX96);
        // Step 1: priceX96 = (s * s) / 2^96 (so raw token1/token0 ratio = priceX96 / 2^96)
        uint256 priceX96 = _mulDiv(s, s, Q96);
        if (priceX96 == 0) return 0;

        if (tokenIsToken0) {
            // price(1 whole token0 in whole token1) * 1e18 = (priceX96 / 2^96) * 10^(tokDec - qDec) * 1e18
            if (tokDec >= qDec) {
                uint256 factor = 1e18 * (10 ** uint256(tokDec - qDec));
                return _mulDiv(priceX96, factor, Q96);
            } else {
                uint256 denomScale = 10 ** uint256(qDec - tokDec);
                return _mulDiv(priceX96, 1e18, Q96 * denomScale);
            }
        } else {
            // price(1 whole token1 in whole token0) * 1e18 = (2^96 / priceX96) * 10^(tokDec - qDec) * 1e18
            if (tokDec >= qDec) {
                uint256 factor = 1e18 * (10 ** uint256(tokDec - qDec));
                return _mulDiv(Q96, factor, priceX96);
            } else {
                uint256 denomScale = 10 ** uint256(qDec - tokDec);
                return _mulDiv(Q96, 1e18, priceX96 * denomScale);
            }
        }
    }

    /// @dev 512-bit precision floor(a * b / denominator) based on Remco Bloemen's FullMath.
    function _mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                require(denominator > 0, "DIV0");
                assembly {
                    result := div(prod0, denominator)
                }
                return result;
            }
            require(denominator > prod1, "MUL_OVERFLOW");
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = denominator & (~denominator + 1);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            result = prod0 * inv;
        }
    }

    function _safeTransfer(address token, address to, uint256 value) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, value));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, value));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }

    function _safeApprove(address token, address spender, uint256 value) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, value));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }
}
