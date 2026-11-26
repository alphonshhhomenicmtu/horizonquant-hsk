// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Minimal, ISwapRouter, IUniswapV3PoolMinimal} from "./interfaces/ISwapRouter.sol";

/// @title HorizonGuardVault
/// @notice Non-custodial session-key trading vault for HashKey Chain (Chain ID 177 / 133).
/// @dev Enforces hard on-chain trading and valuation guardrails that off-chain agents cannot bypass:
///      1. Cold-owner custody with two-step ownership transfer; agent session key can never equal owner or withdraw funds.
///      2. Scoped EIP-712 TradeIntents with low-s check, monotonic nonces, bounded deadline window (<= 15m),
///         cumulative session notional cap, cooldown floor (>= 10s), and daily trade count cap.
///      3. Protected TWAP oracle sync: owner-pinned HSKSwap V3 pools only, authorized owner/keeper callers only,
///         minimum pool liquidity floor, spot-vs-TWAP flash-manipulation guard, step-change deviation cap, and freshness TTL.
///      4. Independent on-chain oracle floor for `minAmountOut` and directional `sqrtPriceLimitX96` (never trusts
///         agent-supplied `expectedAmountOut` down to 1 wei).
///      5. Pro-rata high-water NAV scaling on deposits and withdrawals so owner flows preserve drawdown percentage exactly.
///      6. Rolling UTC 24h daily drawdown circuit breaker: pre-trade breaches revert before spending capital; post-trade
///         breaches and `checkAndTripCircuitBreaker()` persistently latch `circuitBreakerTripped` until owner resets.
///      7. Exact-amount router approvals reset to zero immediately after `exactInputSingle`, full `nonReentrant` coverage,
///         and an immutable on-chain `ExecutionRecord[]` audit log.
contract HorizonGuardVault {
    // =========================================================================
    // Constants & EIP-712 Domain
    // =========================================================================

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant FEE_DENOMINATOR = 1_000_000;
    uint16 public constant HARD_MAX_SLIPPAGE_BPS = 500; // 5.00% absolute protocol ceiling
    uint16 public constant HARD_MAX_DRAWDOWN_BPS = 2_500; // 25.00% absolute protocol ceiling
    uint16 public constant HARD_MAX_POSITION_BPS = 10_000; // 100.00%
    uint32 public constant MIN_TRADE_INTERVAL_SEC = 10; // Hard cooldown floor (seconds)
    uint256 public constant MAX_INTENT_DEADLINE_WINDOW = 15 minutes; // Max validity of a signed TradeIntent
    uint256 public constant MAX_TRACKED_TOKENS = 16; // Bounds NAV loop gas

    uint32 public constant MIN_TWAP_WINDOW_SEC = 60;
    uint32 public constant MAX_TWAP_WINDOW_SEC = 3_600;
    uint16 public constant MIN_ORACLE_DEVIATION_BPS = 100; // 1.00%
    uint16 public constant MAX_ORACLE_DEVIATION_BPS = 5_000; // 50.00%
    uint32 public constant MIN_STALENESS_SEC = 60;
    uint32 public constant MAX_STALENESS_SEC = 7 days;
    uint32 public constant DEFAULT_MAX_STALENESS_SEC = 1 hours;

    int24 internal constant MAX_TICK = 887_272;
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

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
        uint16 dailyDrawdownCapBps; // Max daily high-water NAV drawdown cap (e.g., 300 = 3%)
        uint32 minTradeIntervalSec; // Cooldown between autonomous trades (>= 10s)
        uint32 maxDailyTrades; // Maximum number of swaps allowed per UTC day
    }

    struct AgentSession {
        address agent; // Ephemeral session key signer authorized to sign TradeIntents
        uint64 expiresAt; // Unix timestamp when session key expires
        uint128 maxCumulativeVolumeQuoteE18; // Lifetime notional cap in 18-decimal quote units
        uint128 cumulativeVolumeQuoteE18; // Consumed notional volume
        bool active;
    }

    struct OracleConfig {
        address pool; // Owner-pinned canonical HSKSwap V3 pool paired with quoteToken
        uint32 twapWindowSec; // TWAP lookback window in seconds (e.g., 300)
        uint16 maxDeviationBps; // Max allowed spot-vs-TWAP and step-change deviation in bps
        uint32 maxStalenessSec; // Max age of referencePriceE18 before trades revert
        uint128 minLiquidity; // Minimum active pool liquidity required for oracle sync
    }

    struct TradeIntent {
        address router;
        address tokenIn;
        address tokenOut;
        uint24 fee;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 expectedAmountOut; // Audit-only off-chain estimate; never trusted as slippage floor
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

    struct SwapQuoteContext {
        uint256 tradeNotionalE18;
        uint256 oracleFairOut;
        uint256 oracleMinOut;
        uint160 sqrtPriceLimitX96;
    }

    // =========================================================================
    // Storage
    // =========================================================================

    address public owner;
    address public pendingOwner;
    address public immutable quoteToken; // Settlement token (e.g., USDT on HSK Chain)
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
    mapping(address => bool) public priceKeepers;

    // Multi-asset valuation registry for on-chain NAV, oracle freshness, and slippage floor checks
    address[] public trackedTokens;
    mapping(address => bool) public isTrackedToken;
    mapping(address => uint8) public tokenDecimals;
    mapping(address => uint256) public referencePriceE18; // 1.0 whole token valued in quote USD * 1e18
    mapping(address => uint64) public lastPriceUpdatedAt;
    mapping(address => OracleConfig) public oracleConfigs;

    ExecutionRecord[] private _executions;

    // =========================================================================
    // Events
    // =========================================================================

    event Deposited(address indexed sender, address indexed token, uint256 amount, uint256 newNavE18);
    event Withdrawn(address indexed recipient, address indexed token, uint256 amount, uint256 newNavE18);
    event EmergencyWithdrawn(address indexed recipient, address indexed token, uint256 amount);
    event NativeRescued(address indexed recipient, uint256 amount);
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
    event PriceKeeperUpdated(address indexed keeper, bool allowed);
    event OraclePoolConfigured(
        address indexed token,
        address indexed pool,
        uint32 twapWindowSec,
        uint16 maxDeviationBps,
        uint32 maxStalenessSec,
        uint128 minLiquidity
    );
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
    error InvalidOracleConfig();
    error AgentCannotBeOwner();
    error MaxTrackedTokensReached();
    error SessionNotActive();
    error SessionExpired(uint64 expiresAt, uint256 currentTime);
    error InvalidSignature();
    error InvalidNonce(uint256 expected, uint256 provided);
    error IntentExpired(uint256 deadline, uint256 currentTime);
    error IntentDeadlineTooFar(uint256 deadline, uint256 maxAllowedDeadline);
    error RouterNotAllowed(address router);
    error PairNotAllowed(address tokenIn, address tokenOut, uint24 fee);
    error SlippageCapExceeded(uint256 providedBps, uint256 maxAllowedBps);
    error MinAmountOutBelowOracleFloor(uint256 providedMinOut, uint256 oracleFloorOut);
    error InsufficientSwapOutput(uint256 actualOut, uint256 requiredMinOut);
    error PositionSizeExceeded(uint256 amountIn, uint256 maxAllowedIn);
    error TradeCooldownActive(uint256 nextAllowedTime, uint256 currentTime);
    error MaxDailyTradesReached(uint32 currentCount, uint32 maxDailyTrades);
    error SessionVolumeBudgetExceeded(uint256 projectedVolumeE18, uint256 maxVolumeE18);
    error DailyDrawdownExceeded(uint256 drawdownBps, uint256 capBps);
    error UntrackedToken(address token);
    error OracleNotConfigured(address token);
    error OraclePriceStale(address token, uint64 updatedAt, uint32 maxStalenessSec);
    error OracleDeviationExceeded(address token, uint256 deviationBps, uint256 maxDeviationBps);
    error InsufficientPoolLiquidity(address pool, uint128 actualLiquidity, uint128 minLiquidity);
    error PoolLocked(address pool);
    error InvalidPoolForToken(address pool, address token);
    error InvalidTick();
    error TokenTransferFailed();
    error NativeTransferFailed();

    // =========================================================================
    // Modifiers
    // =========================================================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOwnerOrKeeper() {
        if (msg.sender != owner && !priceKeepers[msg.sender]) revert Unauthorized();
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

        // Register quote token with permanent 1.0e18 unit valuation
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
    /// @dev Scales daily NAV baselines pro-rata (`baseline * navAfter / navBefore`) so inflows preserve
    ///      existing drawdown percentages without masking trading losses.
    // slither-disable-next-line reentrancy-no-eth
    function deposit(address token, uint256 amount) external nonReentrant onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (!isTrackedToken[token]) revert UntrackedToken(token);

        _rollDayIfNeeded();
        uint256 navBefore = _computeTotalNavE18();

        _safeTransferFrom(token, msg.sender, address(this), amount);

        uint256 navAfter = _computeTotalNavE18();
        _scaleBaselinesProRata(navBefore, navAfter);

        emit Deposited(msg.sender, token, amount, navAfter);
    }

    /// @notice Withdraw ERC-20 tokens back to the owner or a designated recipient.
    /// @dev Scales daily NAV baselines pro-rata (`baseline * navAfter / navBefore`) so withdrawals preserve
    ///      existing drawdown percentages without falsely tripping the circuit breaker.
    // slither-disable-next-line reentrancy-no-eth
    function withdraw(address token, uint256 amount, address recipient) external nonReentrant onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        _rollDayIfNeeded();
        uint256 navBefore = _computeTotalNavE18();

        _safeTransfer(token, recipient, amount);

        uint256 navAfter = _computeTotalNavE18();
        if (isTrackedToken[token]) {
            _scaleBaselinesProRata(navBefore, navAfter);
        }

        emit Withdrawn(recipient, token, amount, navAfter);
    }

    /// @notice Emergency exit: pauses autonomous execution and transfers full balance of a token to recipient.
    function emergencyWithdraw(address token, address recipient) external nonReentrant onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        paused = true;
        emit VaultPaused(msg.sender, true);

        uint256 balance = IERC20Minimal(token).balanceOf(address(this));
        if (balance > 0) {
            _safeTransfer(token, recipient, balance);
        }

        uint256 navAfter = _computeTotalNavE18();
        dayStartNavE18 = navAfter;
        dayHighWaterNavE18 = navAfter;

        emit EmergencyWithdrawn(recipient, token, balance);
    }

    /// @notice Rescues any native HSK accidentally forced into the vault (vault intentionally has no receive()).
    function rescueNative(address payable recipient) external nonReentrant onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 bal = address(this).balance;
        if (bal < 1) revert ZeroAmount();
        (bool ok,) = recipient.call{value: bal}("");
        if (!ok) revert NativeTransferFailed();
        emit NativeRescued(recipient, bal);
    }

    function setPaused(bool shouldPause) external onlyOwner {
        paused = shouldPause;
        emit VaultPaused(msg.sender, shouldPause);
    }

    function resetCircuitBreaker() external nonReentrant onlyOwner {
        circuitBreakerTripped = false;
        currentDayIndex = block.timestamp / 1 days;
        uint256 nav = _computeTotalNavE18();
        dayStartNavE18 = nav;
        dayHighWaterNavE18 = nav;
        dailyTradeCount = 0;
        emit CircuitBreakerReset(nav);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        if (session.active && newOwner == session.agent) revert AgentCannotBeOwner();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        // If the new owner somehow held an inactive legacy session, keep it disabled
        if (session.agent == owner) {
            session.active = false;
        }
        emit OwnershipTransferred(prev, owner);
    }

    // =========================================================================
    // Owner Risk Policy, Session Key, Allowlists & Protected TWAP Oracle Config
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
        if (agent == owner || agent == pendingOwner) revert AgentCannotBeOwner();
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
        if (fee >= FEE_DENOMINATOR) revert InvalidOracleConfig();
        allowedPairs[pairKey(tokenIn, tokenOut, fee)] = allowed;
        emit PairAllowlistUpdated(tokenIn, tokenOut, fee, allowed);
    }

    function setPriceKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        priceKeepers[keeper] = allowed;
        emit PriceKeeperUpdated(keeper, allowed);
    }

    function registerToken(address token, uint8 decimals_, uint256 initialPriceE18) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (token == quoteToken) revert InvalidOracleConfig();
        if (initialPriceE18 == 0) revert ZeroAmount();
        _registerToken(token, decimals_, initialPriceE18);
        emit ReferencePriceUpdated(token, initialPriceE18, address(0));
    }

    /// @notice Owner manual reference price override (used for bootstrapping or post-shock governance recovery).
    function setReferencePrice(address token, uint256 newPriceE18) external onlyOwner {
        if (!isTrackedToken[token]) revert UntrackedToken(token);
        if (token == quoteToken) revert InvalidOracleConfig();
        if (newPriceE18 == 0) revert ZeroAmount();
        referencePriceE18[token] = newPriceE18;
        lastPriceUpdatedAt[token] = uint64(block.timestamp);
        emit ReferencePriceUpdated(token, newPriceE18, address(0));
    }

    /// @notice Pin an official HSKSwap V3 pool as the canonical TWAP oracle for a tracked token.
    function setOraclePool(
        address token,
        address pool,
        uint32 twapWindowSec,
        uint16 maxDeviationBps,
        uint32 maxStalenessSec,
        uint128 minLiquidity
    ) external nonReentrant onlyOwner {
        if (!isTrackedToken[token]) revert UntrackedToken(token);
        if (token == quoteToken) revert InvalidOracleConfig();
        if (pool == address(0)) revert ZeroAddress();
        if (
            twapWindowSec < MIN_TWAP_WINDOW_SEC ||
            twapWindowSec > MAX_TWAP_WINDOW_SEC ||
            maxDeviationBps < MIN_ORACLE_DEVIATION_BPS ||
            maxDeviationBps > MAX_ORACLE_DEVIATION_BPS ||
            maxStalenessSec < MIN_STALENESS_SEC ||
            maxStalenessSec > MAX_STALENESS_SEC
        ) {
            revert InvalidOracleConfig();
        }

        IUniswapV3PoolMinimal v3Pool = IUniswapV3PoolMinimal(pool);
        address t0 = v3Pool.token0();
        address t1 = v3Pool.token1();
        if (!((t0 == token && t1 == quoteToken) || (t1 == token && t0 == quoteToken))) {
            revert InvalidPoolForToken(pool, token);
        }

        uint128 liq = v3Pool.liquidity();
        if (liq < minLiquidity) revert InsufficientPoolLiquidity(pool, liq, minLiquidity);

        oracleConfigs[token] = OracleConfig({
            pool: pool,
            twapWindowSec: twapWindowSec,
            maxDeviationBps: maxDeviationBps,
            maxStalenessSec: maxStalenessSec,
            minLiquidity: minLiquidity
        });

        emit OraclePoolConfigured(token, pool, twapWindowSec, maxDeviationBps, maxStalenessSec, minLiquidity);
    }

    /// @notice Synchronize a tracked token's reference price from its owner-pinned HSKSwap V3 TWAP oracle.
    /// @dev Restricted to owner or authorized price keepers. Rejects locked pools, thin liquidity,
    ///      spot-vs-TWAP flash divergence, and excessive step-change jumps.
    function syncPriceFromV3Pool(address token) external nonReentrant onlyOwnerOrKeeper returns (uint256 twapPriceE18) {
        if (!isTrackedToken[token]) revert UntrackedToken(token);
        if (token == quoteToken) revert InvalidOracleConfig();

        OracleConfig memory cfg = oracleConfigs[token];
        if (cfg.pool == address(0)) revert OracleNotConfigured(token);

        (twapPriceE18,,) = _readValidatedPoolTwapE18(token, cfg);

        uint256 prevPrice = referencePriceE18[token];
        if (prevPrice > 0) {
            uint256 stepDevBps = _computeDeviationBps(twapPriceE18, prevPrice);
            if (stepDevBps > cfg.maxDeviationBps) {
                revert OracleDeviationExceeded(token, stepDevBps, cfg.maxDeviationBps);
            }
        }

        referencePriceE18[token] = twapPriceE18;
        lastPriceUpdatedAt[token] = uint64(block.timestamp);
        emit ReferencePriceUpdated(token, twapPriceE18, cfg.pool);
    }

    /// @notice Sentinel hook: latches `circuitBreakerTripped` if current NAV breaches `dailyDrawdownCapBps`.
    /// @dev Safe to keep callable by watchdogs because `referencePriceE18` can only be moved by owner or guarded TWAP keepers.
    function checkAndTripCircuitBreaker() external nonReentrant returns (bool tripped) {
        _rollDayIfNeeded();
        uint256 nav = _computeTotalNavE18();
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
    /// @dev Protected by `nonReentrant` and read-only reentrancy guards on NAV/drawdown views; balance delta and
    ///      post-trade NAV/circuit-breaker updates intentionally observe actual post-swap balances.
    // slither-disable-next-line reentrancy-no-eth,reentrancy-balance
    function executeGuardedSwap(
        TradeIntent calldata intent,
        bytes calldata signature
    ) external nonReentrant returns (uint256 amountOut) {
        if (paused) revert VaultIsPaused();
        if (circuitBreakerTripped) revert CircuitBreakerActive();

        _rollDayIfNeeded();

        // 1. Validate session key, EIP-712 signature, replay nonce, and bounded deadline window
        address signer = _verifyAgentIntent(intent, signature);

        // 2. Enforce allowlists, rate limits, oracle freshness, independent oracle slippage floor, position cap & drawdown
        SwapQuoteContext memory ctx = _enforcePreTradeGuards(intent);

        // 3. Consume monotonic nonce and update session / rate-limit state before external call (CEI pattern)
        nonces[signer] = intent.nonce + 1;
        lastTradeTimestamp = uint64(block.timestamp);
        dailyTradeCount += 1;
        session.cumulativeVolumeQuoteE18 += uint128(ctx.tradeNotionalE18);

        // 4. Execute exact-allowance swap on allowlisted HSKSwap V3 SwapRouter and clear residual allowance
        uint256 effectiveMinOut = intent.minAmountOut > ctx.oracleMinOut ? intent.minAmountOut : ctx.oracleMinOut;
        _safeApprove(intent.tokenIn, intent.router, 0);
        _safeApprove(intent.tokenIn, intent.router, intent.amountIn);

        uint256 balanceOutBefore = IERC20Minimal(intent.tokenOut).balanceOf(address(this));
        uint256 routerReportedOut = ISwapRouter(intent.router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: intent.tokenIn,
                tokenOut: intent.tokenOut,
                fee: intent.fee,
                recipient: address(this),
                deadline: intent.deadline,
                amountIn: intent.amountIn,
                amountOutMinimum: effectiveMinOut,
                sqrtPriceLimitX96: ctx.sqrtPriceLimitX96
            })
        );
        uint256 balanceOutAfter = IERC20Minimal(intent.tokenOut).balanceOf(address(this));

        _safeApprove(intent.tokenIn, intent.router, 0);

        amountOut = balanceOutAfter - balanceOutBefore;
        if (amountOut < effectiveMinOut || routerReportedOut < effectiveMinOut) {
            revert InsufficientSwapOutput(amountOut, effectiveMinOut);
        }

        // 5. Measure realized slippage strictly against independent on-chain oracle quote (never agent self-report)
        uint16 realizedSlippageBps = _computeRealizedSlippageBps(ctx.oracleFairOut, amountOut);
        if (realizedSlippageBps > intent.maxSlippageBps) {
            revert SlippageCapExceeded(realizedSlippageBps, intent.maxSlippageBps);
        }

        // 6. Post-trade mark-to-market NAV evaluation & automatic circuit breaker latch
        uint256 postNavE18 = _computeTotalNavE18();
        if (postNavE18 > dayHighWaterNavE18) {
            dayHighWaterNavE18 = postNavE18;
        }

        uint256 postDrawdownBps = _computeDrawdownBps(postNavE18, dayHighWaterNavE18);
        if (postDrawdownBps >= policy.dailyDrawdownCapBps) {
            circuitBreakerTripped = true;
            emit CircuitBreakerTripped(postNavE18, dayHighWaterNavE18, postDrawdownBps);
        }

        // 7. Append immutable on-chain execution record for verifiable signal provenance
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
    // View Functions & EIP-712 / Oracle Helpers
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

    /// @notice Preview the vault's hard on-chain oracle quote and minimum acceptable output for a candidate swap.
    function quoteOracleMinAmountOut(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint16 maxSlippageBps
    ) external view returns (uint256 oracleFairOut, uint256 oracleMinOut) {
        if (!isTrackedToken[tokenIn]) revert UntrackedToken(tokenIn);
        if (!isTrackedToken[tokenOut]) revert UntrackedToken(tokenOut);
        if (fee >= FEE_DENOMINATOR) revert InvalidOracleConfig();
        if (amountIn == 0) revert ZeroAmount();
        if (maxSlippageBps == 0 || maxSlippageBps > policy.maxSlippageBps) {
            revert SlippageCapExceeded(maxSlippageBps, policy.maxSlippageBps);
        }

        uint256 priceInE18 = _getFreshPriceE18(tokenIn);
        uint256 priceOutE18 = _getFreshPriceE18(tokenOut);
        uint256 quoteValE18 = _mulDiv(amountIn, priceInE18, 10 ** uint256(tokenDecimals[tokenIn]));
        uint256 grossFairOut = _mulDiv(quoteValE18, 10 ** uint256(tokenDecimals[tokenOut]), priceOutE18);
        oracleFairOut = _mulDiv(grossFairOut, FEE_DENOMINATOR - uint256(fee), FEE_DENOMINATOR);
        oracleMinOut = _mulDiv(oracleFairOut, BPS_DENOMINATOR - uint256(maxSlippageBps), BPS_DENOMINATOR);
    }

    /// @notice Computes mark-to-market NAV in 1e18 quote USD. Guards against read-only reentrancy during callbacks.
    function computeTotalNavE18() public view returns (uint256 totalNavE18) {
        if (_reentrancyLock != 1) revert ReentrancyDetected();
        return _computeTotalNavE18();
    }

    function currentDailyDrawdownBps() external view returns (uint256) {
        if (_reentrancyLock != 1) revert ReentrancyDetected();
        uint256 nav = _computeTotalNavE18();
        uint256 highWater = (block.timestamp / 1 days > currentDayIndex) ? nav : dayHighWaterNavE18;
        return _computeDrawdownBps(nav, highWater);
    }

    function _computeTotalNavE18() internal view returns (uint256 totalNavE18) {
        uint256 len = trackedTokens.length;
        for (uint256 i = 0; i < len; ++i) {
            address tok = trackedTokens[i];
            uint256 bal = IERC20Minimal(tok).balanceOf(address(this));
            if (bal > 0) {
                totalNavE18 += _valueInQuoteE18(tok, bal);
            }
        }
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
    // Internal Guards & Oracle Logic
    // =========================================================================

    function _verifyAgentIntent(
        TradeIntent calldata intent,
        bytes calldata signature
    ) internal view returns (address signer) {
        if (!session.active) revert SessionNotActive();
        if (block.timestamp > session.expiresAt) revert SessionExpired(session.expiresAt, block.timestamp);
        if (block.timestamp > intent.deadline) revert IntentExpired(intent.deadline, block.timestamp);
        uint256 maxDeadline = block.timestamp + MAX_INTENT_DEADLINE_WINDOW;
        if (intent.deadline > maxDeadline) revert IntentDeadlineTooFar(intent.deadline, maxDeadline);

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), hashTradeIntent(intent)));
        signer = _recoverSigner(digest, signature);
        if (signer == address(0) || signer != session.agent) revert InvalidSignature();

        uint256 expectedNonce = nonces[signer];
        if (intent.nonce != expectedNonce) revert InvalidNonce(expectedNonce, intent.nonce);
    }

    function _enforcePreTradeGuards(TradeIntent calldata intent) internal view returns (SwapQuoteContext memory ctx) {
        _validateTradeAllowlistsAndLimits(intent);
        ctx = _enforceOracleAndRiskCaps(intent);
    }

    function _validateTradeAllowlistsAndLimits(TradeIntent calldata intent) internal view {
        if (intent.amountIn == 0 || intent.minAmountOut == 0) revert ZeroAmount();
        if (!allowedRouters[intent.router]) revert RouterNotAllowed(intent.router);
        if (!allowedPairs[pairKey(intent.tokenIn, intent.tokenOut, intent.fee)]) {
            revert PairNotAllowed(intent.tokenIn, intent.tokenOut, intent.fee);
        }
        if (!isTrackedToken[intent.tokenIn] || !isTrackedToken[intent.tokenOut]) {
            revert UntrackedToken(!isTrackedToken[intent.tokenIn] ? intent.tokenIn : intent.tokenOut);
        }

        if (lastTradeTimestamp != 0 && block.timestamp < uint256(lastTradeTimestamp) + policy.minTradeIntervalSec) {
            revert TradeCooldownActive(uint256(lastTradeTimestamp) + policy.minTradeIntervalSec, block.timestamp);
        }
        if (dailyTradeCount >= policy.maxDailyTrades) {
            revert MaxDailyTradesReached(dailyTradeCount, policy.maxDailyTrades);
        }
        if (intent.maxSlippageBps == 0 || intent.maxSlippageBps > policy.maxSlippageBps) {
            revert SlippageCapExceeded(intent.maxSlippageBps, policy.maxSlippageBps);
        }
    }

    function _enforceOracleAndRiskCaps(TradeIntent calldata intent) internal view returns (SwapQuoteContext memory ctx) {
        // 1. Freshness-checked on-chain reference prices (and live TWAP consistency when pool is pinned)
        uint256 priceInE18 = _getFreshPriceE18(intent.tokenIn);
        uint256 priceOutE18 = _getFreshPriceE18(intent.tokenOut);

        // 2. Compute independent on-chain oracle quote & hard minAmountOut floor
        ctx.tradeNotionalE18 = _mulDiv(intent.amountIn, priceInE18, 10 ** uint256(tokenDecimals[intent.tokenIn]));
        uint256 grossFairOut = _mulDiv(ctx.tradeNotionalE18, 10 ** uint256(tokenDecimals[intent.tokenOut]), priceOutE18);
        ctx.oracleFairOut = _mulDiv(grossFairOut, FEE_DENOMINATOR - uint256(intent.fee), FEE_DENOMINATOR);
        if (ctx.oracleFairOut < 1) revert ZeroAmount();

        ctx.oracleMinOut = _mulDiv(ctx.oracleFairOut, BPS_DENOMINATOR - uint256(intent.maxSlippageBps), BPS_DENOMINATOR);
        if (ctx.oracleMinOut < 1) revert ZeroAmount();
        if (intent.minAmountOut < ctx.oracleMinOut) {
            revert MinAmountOutBelowOracleFloor(intent.minAmountOut, ctx.oracleMinOut);
        }

        // 3. Derive directional non-zero sqrtPriceLimitX96 when trading against a pinned quoteToken oracle pool
        ctx.sqrtPriceLimitX96 = _computeSqrtPriceLimitX96(intent);

        // 4. Max single-trade position size relative to current tokenIn balance
        uint256 tokenInBalance = IERC20Minimal(intent.tokenIn).balanceOf(address(this));
        uint256 maxAllowedIn = _mulDiv(tokenInBalance, policy.maxPositionBps, BPS_DENOMINATOR);
        if (intent.amountIn > maxAllowedIn) {
            revert PositionSizeExceeded(intent.amountIn, maxAllowedIn);
        }

        // 5. Cumulative session notional budget check
        uint256 projectedVolume = uint256(session.cumulativeVolumeQuoteE18) + ctx.tradeNotionalE18;
        if (projectedVolume > session.maxCumulativeVolumeQuoteE18) {
            revert SessionVolumeBudgetExceeded(projectedVolume, session.maxCumulativeVolumeQuoteE18);
        }

        // 6. Pre-trade daily drawdown check (reverts immediately before spending funds)
        uint256 preNav = _computeTotalNavE18();
        uint256 preDrawdownBps = _computeDrawdownBps(preNav, dayHighWaterNavE18);
        if (preDrawdownBps >= policy.dailyDrawdownCapBps) {
            revert DailyDrawdownExceeded(preDrawdownBps, policy.dailyDrawdownCapBps);
        }
    }

    function _getFreshPriceE18(address token) internal view returns (uint256 priceE18) {
        priceE18 = referencePriceE18[token];
        if (priceE18 < 1) revert ZeroAmount();
        if (token == quoteToken) return priceE18;

        OracleConfig memory cfg = oracleConfigs[token];
        uint32 maxStaleness = cfg.maxStalenessSec > 0 ? cfg.maxStalenessSec : DEFAULT_MAX_STALENESS_SEC;
        uint64 updatedAt = lastPriceUpdatedAt[token];
        if (block.timestamp > uint256(updatedAt) + uint256(maxStaleness)) {
            revert OraclePriceStale(token, updatedAt, maxStaleness);
        }

        // If an owner-pinned V3 pool exists, cross-check stored mark against live on-chain TWAP
        if (cfg.pool != address(0)) {
            (uint256 liveTwapE18,,) = _readValidatedPoolTwapE18(token, cfg);
            uint256 devBps = _computeDeviationBps(liveTwapE18, priceE18);
            if (devBps > cfg.maxDeviationBps) {
                revert OracleDeviationExceeded(token, devBps, cfg.maxDeviationBps);
            }
            return liveTwapE18;
        }
    }

    function _computeSqrtPriceLimitX96(TradeIntent calldata intent) internal view returns (uint160) {
        address nonQuote = intent.tokenIn == quoteToken
            ? intent.tokenOut
            : (intent.tokenOut == quoteToken ? intent.tokenIn : address(0));
        if (nonQuote == address(0)) return 0;

        OracleConfig memory cfg = oracleConfigs[nonQuote];
        if (cfg.pool == address(0)) return 0;

        (, uint160 anchorSqrtPriceX96, uint160 spotSqrtPriceX96) = _readValidatedPoolTwapE18(nonQuote, cfg);

        bool zeroForOne = intent.tokenIn < intent.tokenOut;
        uint256 limitMoveBps = uint256(intent.maxSlippageBps) + (uint256(intent.fee) / 100) + 50;
        if (limitMoveBps >= BPS_DENOMINATOR / 2) {
            limitMoveBps = BPS_DENOMINATOR / 2 - 1;
        }

        if (zeroForOne) {
            uint160 baseSqrt = spotSqrtPriceX96 < anchorSqrtPriceX96 ? spotSqrtPriceX96 : anchorSqrtPriceX96;
            uint256 rawLimit = _mulDiv(uint256(baseSqrt), BPS_DENOMINATOR - limitMoveBps, BPS_DENOMINATOR);
            return rawLimit <= MIN_SQRT_RATIO ? MIN_SQRT_RATIO + 1 : uint160(rawLimit);
        } else {
            uint160 baseSqrt = spotSqrtPriceX96 > anchorSqrtPriceX96 ? spotSqrtPriceX96 : anchorSqrtPriceX96;
            uint256 rawLimit = _mulDiv(uint256(baseSqrt), BPS_DENOMINATOR + limitMoveBps, BPS_DENOMINATOR);
            return rawLimit >= MAX_SQRT_RATIO ? MAX_SQRT_RATIO - 1 : uint160(rawLimit);
        }
    }

    function _readValidatedPoolTwapE18(
        address token,
        OracleConfig memory cfg
    ) internal view returns (uint256 twapPriceE18, uint160 twapSqrtPriceX96, uint160 spotSqrtPriceX96) {
        IUniswapV3PoolMinimal v3Pool = IUniswapV3PoolMinimal(cfg.pool);

        uint128 liq = v3Pool.liquidity();
        if (liq < cfg.minLiquidity) {
            revert InsufficientPoolLiquidity(cfg.pool, liq, cfg.minLiquidity);
        }

        int24 spotTick;
        uint16 obsIdx;
        uint16 obsCard;
        uint16 obsCardNext;
        uint8 feeProto;
        bool unlocked;
        (spotSqrtPriceX96, spotTick, obsIdx, obsCard, obsCardNext, feeProto, unlocked) = v3Pool.slot0();
        if (!unlocked) revert PoolLocked(cfg.pool);
        if (spotSqrtPriceX96 < MIN_SQRT_RATIO || spotSqrtPriceX96 > MAX_SQRT_RATIO) revert ZeroAmount();
        if (spotTick < -MAX_TICK || spotTick > MAX_TICK) revert InvalidTick();
        if (obsCard < 1 || obsIdx >= obsCard || obsCardNext < obsCard || (feeProto == 0xFF && obsCard < 1)) {
            revert InvalidOracleConfig();
        }

        address t0 = v3Pool.token0();
        address t1 = v3Pool.token1();
        if (!((t0 == token && t1 == quoteToken) || (t1 == token && t0 == quoteToken))) {
            revert InvalidPoolForToken(cfg.pool, token);
        }

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = cfg.twapWindowSec;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives, uint160[] memory secPerLiq) = v3Pool.observe(secondsAgos);
        if (tickCumulatives.length < 2 || secPerLiq.length < 2) revert InvalidOracleConfig();
        int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
        int56 window = int56(uint56(cfg.twapWindowSec));
        int24 twapTick = int24(tickDelta / window);
        if (tickDelta < 0 && (tickDelta % window != 0)) {
            twapTick -= 1;
        }

        twapSqrtPriceX96 = _getSqrtRatioAtTick(twapTick);
        uint8 tokDec = tokenDecimals[token];
        bool tokenIsToken0 = (t0 == token);

        twapPriceE18 = _computeSpotPriceE18(twapSqrtPriceX96, tokenIsToken0, tokDec, quoteDecimals);
        uint256 spotPriceE18 = _computeSpotPriceE18(spotSqrtPriceX96, tokenIsToken0, tokDec, quoteDecimals);
        if (twapPriceE18 < 1 || spotPriceE18 < 1) revert ZeroAmount();

        // Reject single-block spot manipulation away from TWAP
        uint256 spotTwapDevBps = _computeDeviationBps(spotPriceE18, twapPriceE18);
        if (spotTwapDevBps > cfg.maxDeviationBps) {
            revert OracleDeviationExceeded(token, spotTwapDevBps, cfg.maxDeviationBps);
        }
    }

    function _scaleBaselinesProRata(uint256 navBefore, uint256 navAfter) internal {
        if (navAfter < 1) {
            dayStartNavE18 = 0;
            dayHighWaterNavE18 = 0;
            return;
        }
        if (navBefore < 1 || dayHighWaterNavE18 < 1) {
            dayStartNavE18 = navAfter;
            dayHighWaterNavE18 = navAfter;
            return;
        }
        // Round high-water baseline UP to favor safety (inflows/outflows never round drawdown down)
        dayStartNavE18 = _mulDivRoundingUp(dayStartNavE18, navAfter, navBefore);
        dayHighWaterNavE18 = _mulDivRoundingUp(dayHighWaterNavE18, navAfter, navBefore);
    }

    function _mulDivRoundingUp(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        result = _mulDiv(a, b, denominator);
        if (mulmod(a, b, denominator) > 0) {
            result += 1;
        }
    }

    function _rollDayIfNeeded() internal {
        uint256 dayIdx = block.timestamp / 1 days;
        if (dayIdx > currentDayIndex) {
            currentDayIndex = dayIdx;
            uint256 nav = _computeTotalNavE18();
            dayStartNavE18 = nav;
            dayHighWaterNavE18 = nav;
            dailyTradeCount = 0;
        } else if (dayHighWaterNavE18 < 1) {
            uint256 nav = _computeTotalNavE18();
            dayStartNavE18 = nav;
            dayHighWaterNavE18 = nav;
        }
    }

    function _registerToken(address token, uint8 decimals_, uint256 initialPriceE18) internal {
        if (decimals_ > 18) revert InvalidOracleConfig();
        if (!isTrackedToken[token]) {
            if (trackedTokens.length >= MAX_TRACKED_TOKENS) revert MaxTrackedTokensReached();
            isTrackedToken[token] = true;
            trackedTokens.push(token);
        }
        tokenDecimals[token] = decimals_;
        referencePriceE18[token] = initialPriceE18;
        lastPriceUpdatedAt[token] = uint64(block.timestamp);
    }

    function _valueInQuoteE18(address token, uint256 rawAmount) internal view returns (uint256) {
        return _mulDiv(rawAmount, referencePriceE18[token], 10 ** uint256(tokenDecimals[token]));
    }

    function _computeDrawdownBps(uint256 navE18, uint256 highWaterE18) internal pure returns (uint256) {
        if (highWaterE18 < 1 || navE18 >= highWaterE18) return 0;
        return _mulDiv(highWaterE18 - navE18, BPS_DENOMINATOR, highWaterE18);
    }

    function _computeDeviationBps(uint256 a, uint256 b) internal pure returns (uint256) {
        if (b < 1) return BPS_DENOMINATOR;
        uint256 diff = a >= b ? a - b : b - a;
        return _mulDiv(diff, BPS_DENOMINATOR, b);
    }

    function _computeRealizedSlippageBps(
        uint256 referenceExpectedOut,
        uint256 actualAmountOut
    ) internal pure returns (uint16) {
        if (referenceExpectedOut < 1 || actualAmountOut >= referenceExpectedOut) return 0;
        uint256 bps = _mulDiv(referenceExpectedOut - actualAmountOut, BPS_DENOMINATOR, referenceExpectedOut);
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
            p.minTradeIntervalSec < MIN_TRADE_INTERVAL_SEC ||
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

    /// @dev Exact Uniswap V3 TickMath.getSqrtRatioAtTick conversion for TWAP tick -> sqrtPriceX96.
    // slither-disable-next-line divide-before-multiply
    function _getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            if (absTick > uint256(int256(MAX_TICK))) revert InvalidTick();

            uint256 ratio = absTick & 0x1 != 0
                ? 0xfffcb933bd6fad37aa2d162d1a594001
                : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

            if (tick > 0) ratio = type(uint256).max / ratio;
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }

    /// @dev Overflow-safe conversion of Uniswap V3 sqrtPriceX96 to 1e18-scaled quote USD price per 1 whole token.
    function _computeSpotPriceE18(
        uint160 sqrtPriceX96,
        bool tokenIsToken0,
        uint8 tokDec,
        uint8 qDec
    ) internal pure returns (uint256) {
        uint256 s = uint256(sqrtPriceX96);
        uint256 priceX96 = _mulDiv(s, s, Q96);
        if (priceX96 < 1) return 0;

        if (tokenIsToken0) {
            if (tokDec >= qDec) {
                uint256 factor = 1e18 * (10 ** uint256(tokDec - qDec));
                return _mulDiv(priceX96, factor, Q96);
            } else {
                uint256 denomScale = 10 ** uint256(qDec - tokDec);
                return _mulDiv(priceX96, 1e18, Q96 * denomScale);
            }
        } else {
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
    ///      `denominator := div(denominator, twos)` is exact power-of-2 stripping before Newton-Raphson inversion.
    // slither-disable-next-line divide-before-multiply
    function _mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 < 1) {
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
                prod0 := or(prod0, mul(prod1, twos))
                let t := mul(3, denominator)
                let inv := sub(add(t, 2), shl(1, and(t, 2)))
                inv := mul(inv, sub(2, mul(denominator, inv)))
                inv := mul(inv, sub(2, mul(denominator, inv)))
                inv := mul(inv, sub(2, mul(denominator, inv)))
                inv := mul(inv, sub(2, mul(denominator, inv)))
                inv := mul(inv, sub(2, mul(denominator, inv)))
                inv := mul(inv, sub(2, mul(denominator, inv)))
                result := mul(prod0, inv)
            }
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
