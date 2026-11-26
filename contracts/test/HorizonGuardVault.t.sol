// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TestBase} from "./utils/TestBase.sol";
import {HorizonGuardVault} from "../src/HorizonGuardVault.sol";
import {MockHSKSwapRouter, MockV3Pool} from "../src/MockHSKSwapRouter.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// @title HorizonGuardVaultTest
/// @notice Unit, adversarial red-team regression, and stateless fuzz suite for HorizonGuardVault on HashKey Chain (177).
contract HorizonGuardVaultTest is TestBase {
    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant AGENT_PK = 0xB0B;
    uint256 internal constant KEEPER_PK = 0xC0DE;
    uint256 internal constant ATTACKER_PK = 0xBAD;

    address internal owner;
    address internal agent;
    address internal keeper;
    address internal relayer = address(0xCAFE);
    address internal attacker;

    MockERC20 internal usdt; // 6 decimals (matches HSK Chain USDT 0xF1B5...9029)
    MockERC20 internal whsk; // 18 decimals (matches HSK Chain WHSK 0xB210...1Cf1)

    MockHSKSwapRouter internal router;
    MockV3Pool internal whskUsdtPool;
    HorizonGuardVault internal vault;

    uint24 internal constant FEE_LOW = 500; // 0.05% live HSKSwap tier
    uint24 internal constant FEE_MID = 3000; // 0.30% live HSKSwap tier

    // Live HSKSwap mainnet WHSK/USDT 0.05% pool state observed at block 30,589,426 (~$0.100013 per WHSK)
    uint160 internal constant LIVE_WHSK_USDT_SQRT_PRICE_X96 = 25055738251564958613595;
    int24 internal constant LIVE_WHSK_USDT_TICK = -299_350;
    uint128 internal constant LIVE_WHSK_USDT_LIQUIDITY = 2_830_955_089_632;

    // Exact ~$0.100003/WHSK tick for clean unit math (within 0.3 bps of $0.10)
    int24 internal constant PARITY_WHSK_TICK = -299_351;
    uint160 internal constant PARITY_WHSK_SQRT_PRICE_X96 = 25054485400000000000000;

    function setUp() public {
        vm.chainId(177); // HashKey Chain Mainnet
        vm.warp(1_764_000_000); // Deterministic UTC timestamp

        owner = vm.addr(OWNER_PK);
        agent = vm.addr(AGENT_PK);
        keeper = vm.addr(KEEPER_PK);
        attacker = vm.addr(ATTACKER_PK);

        usdt = new MockERC20("Tether USD", "USDT", 6);
        whsk = new MockERC20("Wrapped HSK", "WHSK", 18);

        router = new MockHSKSwapRouter(address(0xD136e36610f35E0Cc3cAd40de858c151f2AA65D4), address(whsk));

        // 1 WHSK (1e18) = 0.10 USDT (1e5 raw); 1 USDT (1e6) = 10 WHSK (10e18 raw)
        router.setRate(address(whsk), address(usdt), 1e5);
        router.setRate(address(usdt), address(whsk), 1e31);

        // Seed router liquidity
        usdt.mint(address(router), 5_000_000e6);
        whsk.mint(address(router), 50_000_000e18);

        // Deploy live-anchored WHSK/USDT V3 pool mock (token0 = WHSK, token1 = USDT)
        whskUsdtPool = new MockV3Pool(
            address(whsk),
            address(usdt),
            FEE_LOW,
            PARITY_WHSK_SQRT_PRICE_X96,
            PARITY_WHSK_TICK,
            LIVE_WHSK_USDT_LIQUIDITY
        );

        HorizonGuardVault.RiskPolicy memory initialPolicy = HorizonGuardVault.RiskPolicy({
            maxSlippageBps: 50, // 0.50% max slippage
            maxPositionBps: 2_500, // 25.00% max single-trade share
            dailyDrawdownCapBps: 300, // 3.00% daily stop-loss circuit breaker
            minTradeIntervalSec: 60, // 60s cooldown between swaps
            maxDailyTrades: 24 // Up to 24 autonomous executions per UTC day
        });

        vault = new HorizonGuardVault(owner, address(usdt), 6, initialPolicy);

        vm.startPrank(owner);
        vault.registerToken(address(whsk), 18, 0.10e18); // $0.10 / WHSK
        vault.setAllowedRouter(address(router), true);
        vault.setAllowedPair(address(usdt), address(whsk), FEE_LOW, true);
        vault.setAllowedPair(address(whsk), address(usdt), FEE_LOW, true);
        vault.setAllowedPair(address(usdt), address(whsk), FEE_MID, true);
        vault.setAllowedPair(address(whsk), address(usdt), FEE_MID, true);

        // Pin canonical HSKSwap V3 TWAP oracle (5m window, 10% max deviation, 1h staleness TTL, liquidity floor)
        vault.setOraclePool(address(whsk), address(whskUsdtPool), 300, 1_000, 3_600, 1_000_000_000_000);
        vault.setPriceKeeper(keeper, true);

        vault.setAgentSessionKey(agent, uint64(block.timestamp + 7 days), 250_000e18);

        // Owner funds vault with 50,000 USDT + 200,000 WHSK ($20,000) = $70,000 initial NAV
        usdt.mint(owner, 100_000e6);
        whsk.mint(owner, 500_000e18);
        usdt.approve(address(vault), type(uint256).max);
        whsk.approve(address(vault), type(uint256).max);
        vault.deposit(address(usdt), 50_000e6);
        vault.deposit(address(whsk), 200_000e18);
        vm.stopPrank();
    }

    // =========================================================================
    // Helper Functions
    // =========================================================================

    function _signIntent(
        uint256 pk,
        HorizonGuardVault.TradeIntent memory intent
    ) internal view returns (bytes memory) {
        bytes32 digest = vault.getTradeIntentDigest(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _buildDefaultUsdtToWhskIntent(uint256 amountInUsdt)
        internal
        view
        returns (HorizonGuardVault.TradeIntent memory)
    {
        (uint256 fairOut, uint256 minOut) =
            vault.quoteOracleMinAmountOut(address(usdt), address(whsk), FEE_LOW, amountInUsdt, 50);
        return HorizonGuardVault.TradeIntent({
            router: address(router),
            tokenIn: address(usdt),
            tokenOut: address(whsk),
            fee: FEE_LOW,
            amountIn: amountInUsdt,
            minAmountOut: minOut,
            expectedAmountOut: fairOut,
            maxSlippageBps: 50,
            deadline: block.timestamp + 300,
            nonce: vault.nonces(agent),
            strategyTag: keccak256("HSK_MOMENTUM_V1"),
            signalHash: keccak256("SIGNAL_EMA9_CROSS_20261124")
        });
    }

    // =========================================================================
    // Core Unit Tests
    // =========================================================================

    function test_InitialStateAndNavAccounting() public view {
        assertEq(vault.owner(), owner, "owner mismatch");
        assertEq(vault.computeTotalNavE18(), 70_000e18, "initial NAV must equal 70,000 USD");
        assertEq(vault.dayStartNavE18(), 70_000e18, "dayStartNav mismatch");
        assertEq(vault.dayHighWaterNavE18(), 70_000e18, "dayHighWaterNav mismatch");
        assertFalse(vault.paused(), "vault must start unpaused");
        assertFalse(vault.circuitBreakerTripped(), "circuit breaker must start disarmed");
    }

    function test_ExecuteGuardedSwap_SuccessZeroResidualAllowanceAndSqrtLimit() public {
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(10_000e6); // 20% of 50k USDT
        bytes memory sig = _signIntent(AGENT_PK, intent);

        vm.prank(relayer);
        uint256 out = vault.executeGuardedSwap(intent, sig);

        assertGe(out, intent.minAmountOut, "output must satisfy oracle floor");
        assertGt(uint256(router.lastSqrtPriceLimitX96()), 0, "non-zero directional sqrtPriceLimitX96 must be set");
        assertEq(usdt.balanceOf(address(vault)), 40_000e6, "USDT balance decremented");
        assertEq(whsk.balanceOf(address(vault)), 200_000e18 + out, "WHSK balance incremented");
        assertEq(usdt.allowance(address(vault), address(router)), 0, "residual allowance must be reset to zero");
        assertEq(vault.nonces(agent), 1, "agent nonce must increment");
        assertEq(vault.dailyTradeCount(), 1, "daily trade count must increment");
        assertEq(vault.getExecutionCount(), 1, "execution audit log recorded");

        HorizonGuardVault.ExecutionRecord memory rec = vault.getExecution(0);
        assertEq(rec.agent, agent, "record agent mismatch");
        assertEq(rec.strategyTag, intent.strategyTag, "record strategyTag mismatch");
        assertEq(rec.signalHash, intent.signalHash, "record signalHash mismatch");
    }

    function test_RevertOnInvalidSignatureOrAttackerSigner() public {
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(5_000e6);
        bytes memory badSig = _signIntent(ATTACKER_PK, intent);

        vm.expectRevert(HorizonGuardVault.InvalidSignature.selector);
        vault.executeGuardedSwap(intent, badSig);
    }

    function test_RevertOnSignatureReplay() public {
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(5_000e6);
        bytes memory sig = _signIntent(AGENT_PK, intent);

        vault.executeGuardedSwap(intent, sig);

        vm.warp(block.timestamp + 120);
        vm.expectRevert(abi.encodeWithSelector(HorizonGuardVault.InvalidNonce.selector, 1, 0));
        vault.executeGuardedSwap(intent, sig);
    }

    function test_RevertOnHighSMalleableSignature() public {
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(5_000e6);
        bytes32 digest = vault.getTradeIntentDigest(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, digest);

        uint256 secp256k1N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(secp256k1N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        bytes memory malleableSig = abi.encodePacked(r, highS, flippedV);

        vm.expectRevert(HorizonGuardVault.InvalidSignature.selector);
        vault.executeGuardedSwap(intent, malleableSig);
    }

    function test_RevertOnExpiredDeadlineAndExpiredSession() public {
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(5_000e6);
        intent.deadline = block.timestamp - 1;
        bytes memory sig = _signIntent(AGENT_PK, intent);

        vm.expectRevert(abi.encodeWithSelector(HorizonGuardVault.IntentExpired.selector, intent.deadline, block.timestamp));
        vault.executeGuardedSwap(intent, sig);

        // Warp past 7-day session expiry
        vm.warp(block.timestamp + 8 days);
        HorizonGuardVault.TradeIntent memory intent2 = HorizonGuardVault.TradeIntent({
            router: address(router),
            tokenIn: address(usdt),
            tokenOut: address(whsk),
            fee: FEE_LOW,
            amountIn: 5_000e6,
            minAmountOut: 49_000e18,
            expectedAmountOut: 50_000e18,
            maxSlippageBps: 50,
            deadline: block.timestamp + 300,
            nonce: vault.nonces(agent),
            strategyTag: keccak256("HSK_MOMENTUM_V1"),
            signalHash: keccak256("SIG_EXPIRED_SESSION")
        });
        bytes memory sig2 = _signIntent(AGENT_PK, intent2);
        vm.expectRevert();
        vault.executeGuardedSwap(intent2, sig2);
    }

    function test_RevertOnDisallowedRouterAndPair() public {
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(5_000e6);
        intent.router = address(0xDEAD);
        bytes memory sig = _signIntent(AGENT_PK, intent);

        vm.expectRevert(abi.encodeWithSelector(HorizonGuardVault.RouterNotAllowed.selector, address(0xDEAD)));
        vault.executeGuardedSwap(intent, sig);

        HorizonGuardVault.TradeIntent memory intent2 = _buildDefaultUsdtToWhskIntent(5_000e6);
        intent2.fee = 10_000;
        bytes memory sig2 = _signIntent(AGENT_PK, intent2);

        vm.expectRevert(
            abi.encodeWithSelector(HorizonGuardVault.PairNotAllowed.selector, address(usdt), address(whsk), 10_000)
        );
        vault.executeGuardedSwap(intent2, sig2);
    }

    function test_RevertOnSlippageCapAndAdverseRouterFill() public {
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(5_000e6);
        intent.maxSlippageBps = 100;
        bytes memory sig = _signIntent(AGENT_PK, intent);

        vm.expectRevert(abi.encodeWithSelector(HorizonGuardVault.SlippageCapExceeded.selector, 100, 50));
        vault.executeGuardedSwap(intent, sig);

        router.setSimulatedSlippageBps(80);
        HorizonGuardVault.TradeIntent memory intent2 = _buildDefaultUsdtToWhskIntent(5_000e6);
        bytes memory sig2 = _signIntent(AGENT_PK, intent2);

        vm.expectRevert();
        vault.executeGuardedSwap(intent2, sig2);
    }

    function test_RevertOnPositionSizeCap() public {
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(12_501e6);
        bytes memory sig = _signIntent(AGENT_PK, intent);

        vm.expectRevert(
            abi.encodeWithSelector(HorizonGuardVault.PositionSizeExceeded.selector, 12_501e6, 12_500e6)
        );
        vault.executeGuardedSwap(intent, sig);
    }

    function test_RevertOnCooldownAndDailyTradeCount() public {
        HorizonGuardVault.TradeIntent memory intent1 = _buildDefaultUsdtToWhskIntent(2_000e6);
        vault.executeGuardedSwap(intent1, _signIntent(AGENT_PK, intent1));

        HorizonGuardVault.TradeIntent memory intent2 = _buildDefaultUsdtToWhskIntent(2_000e6);
        bytes memory sig2 = _signIntent(AGENT_PK, intent2);
        vm.expectRevert(
            abi.encodeWithSelector(
                HorizonGuardVault.TradeCooldownActive.selector,
                block.timestamp + 60,
                block.timestamp
            )
        );
        vault.executeGuardedSwap(intent2, sig2);

        vm.warp(block.timestamp + 61);
        HorizonGuardVault.TradeIntent memory intent3 = _buildDefaultUsdtToWhskIntent(2_000e6);
        vault.executeGuardedSwap(intent3, _signIntent(AGENT_PK, intent3));
        assertEq(vault.dailyTradeCount(), 2, "second trade after cooldown should succeed");
    }

    function test_DailyDrawdownCircuitBreaker_TripsAndBlocksFurtherTrades() public {
        // Drop WHSK reference price from $0.10 to $0.088 => -3.428% NAV drawdown > 3.00% cap
        vm.prank(owner);
        vault.setReferencePrice(address(whsk), 0.088e18);

        assertGt(vault.currentDailyDrawdownBps(), 300, "drawdown must exceed 300 bps");

        // Sentinel persistently latches circuit breaker
        bool tripped = vault.checkAndTripCircuitBreaker();
        assertTrue(tripped, "sentinel must trip circuit breaker");
        assertTrue(vault.circuitBreakerTripped(), "circuit breaker flag must persist");

        // Even after price recovers intraday, latched circuit breaker still blocks trades
        vm.prank(owner);
        vault.setReferencePrice(address(whsk), 0.10e18);
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(2_000e6);
        bytes memory sig = _signIntent(AGENT_PK, intent);
        vm.expectRevert(HorizonGuardVault.CircuitBreakerActive.selector);
        vault.executeGuardedSwap(intent, sig);

        // Owner inspects and resets circuit breaker
        vm.prank(owner);
        vault.resetCircuitBreaker();
        assertFalse(vault.circuitBreakerTripped(), "circuit breaker should clear after owner reset");

        vault.executeGuardedSwap(intent, sig);
        assertEq(vault.getExecutionCount(), 1, "trade executes after owner reset");
    }

    function test_EmergencyWithdrawPausesAndRecoversAllFunds() public {
        vm.startPrank(owner);
        uint256 ownerBefore = usdt.balanceOf(owner);
        vault.emergencyWithdraw(address(usdt), owner);
        vm.stopPrank();

        assertTrue(vault.paused(), "emergency withdraw must pause vault");
        assertEq(usdt.balanceOf(address(vault)), 0, "vault USDT drained to owner");
        assertEq(usdt.balanceOf(owner), ownerBefore + 50_000e6, "owner recovered full USDT");

        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(1_000e6);
        bytes memory sig = _signIntent(AGENT_PK, intent);
        vm.expectRevert(HorizonGuardVault.VaultIsPaused.selector);
        vault.executeGuardedSwap(intent, sig);
    }

    function test_PostTradeDrawdownTripsCircuitBreakerAutomatically() public {
        vm.prank(owner);
        vault.updateRiskPolicy(
            HorizonGuardVault.RiskPolicy({
                maxSlippageBps: 100,
                maxPositionBps: 5_000,
                dailyDrawdownCapBps: 50,
                minTradeIntervalSec: 10,
                maxDailyTrades: 24
            })
        );

        // Small mark drift drops initial NAV by $300 (~42.8 bps, still < 50 bps pre-trade)
        // Update pool TWAP and reference price consistently to $0.0985 (tick -299502)
        whskUsdtPool.setSqrtPriceX96(24865880000000000000000, -299_502);
        whskUsdtPool.setTwapTick(-299_502);
        vm.prank(keeper);
        vault.syncPriceFromV3Pool(address(whsk));
        assertLt(vault.currentDailyDrawdownBps(), 50, "pre-trade drawdown must remain below cap");

        // Align router rate to $0.0985/WHSK (1 USDT = 10.15228 WHSK -> 1.015228e31) and inject 80 bps adverse slippage
        router.setRate(address(usdt), address(whsk), 10_152_284_263_959_390_862_944_162_436_548);
        router.setSimulatedSlippageBps(80);

        uint256 amountIn = 20_000e6;
        (uint256 fairOut, uint256 minOut) =
            vault.quoteOracleMinAmountOut(address(usdt), address(whsk), FEE_LOW, amountIn, 100);

        HorizonGuardVault.TradeIntent memory intent = HorizonGuardVault.TradeIntent({
            router: address(router),
            tokenIn: address(usdt),
            tokenOut: address(whsk),
            fee: FEE_LOW,
            amountIn: amountIn,
            minAmountOut: minOut,
            expectedAmountOut: fairOut,
            maxSlippageBps: 100,
            deadline: block.timestamp + 300,
            nonce: vault.nonces(agent),
            strategyTag: keccak256("STRESS_POST_TRADE_CB"),
            signalHash: keccak256("STRESS_SIG_1")
        });

        vault.executeGuardedSwap(intent, _signIntent(AGENT_PK, intent));
        assertTrue(vault.circuitBreakerTripped(), "post-trade drawdown breach must auto-trip circuit breaker");

        vm.warp(block.timestamp + 30);
        HorizonGuardVault.TradeIntent memory intent2 = _buildDefaultUsdtToWhskIntent(1_000e6);
        bytes memory sig2 = _signIntent(AGENT_PK, intent2);
        vm.expectRevert(HorizonGuardVault.CircuitBreakerActive.selector);
        vault.executeGuardedSwap(intent2, sig2);
    }

    function test_TwoStepOwnershipTransferAndOnlyOwnerGuards() public {
        address newOwner = address(0x123456);
        vm.prank(owner);
        vault.transferOwnership(newOwner);
        assertEq(vault.pendingOwner(), newOwner, "pendingOwner set");

        vm.prank(attacker);
        vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
        vault.acceptOwnership();

        vm.prank(newOwner);
        vault.acceptOwnership();
        assertEq(vault.owner(), newOwner, "ownership transferred cleanly");
        assertEq(vault.pendingOwner(), address(0), "pendingOwner cleared");

        vm.startPrank(attacker);
        vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
        vault.withdraw(address(usdt), 1e6, attacker);
        vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
        vault.setPaused(true);
        vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
        vault.revokeAgentSessionKey();
        vm.stopPrank();
    }

    // =========================================================================
    // Adversarial Red-Team Regression Tests (H-1, H-2, M-1, M-2, L-1)
    // =========================================================================

    function test_H1_SyncPriceFromLiveMainnetV3TwapAndRejectUnauthorizedCaller() public {
        // Deploy a pool matching exact live HSK Mainnet WHSK/USDT 0.05% pool state
        MockV3Pool livePool = new MockV3Pool(
            address(whsk),
            address(usdt),
            FEE_LOW,
            LIVE_WHSK_USDT_SQRT_PRICE_X96,
            LIVE_WHSK_USDT_TICK,
            LIVE_WHSK_USDT_LIQUIDITY
        );

        vm.prank(owner);
        vault.setOraclePool(address(whsk), address(livePool), 300, 1_000, 3_600, 1_000_000_000_000);

        // Unauthorized attacker cannot sync price
        vm.prank(attacker);
        vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
        vault.syncPriceFromV3Pool(address(whsk));

        // Authorized keeper syncs TWAP cleanly
        vm.prank(keeper);
        uint256 synced = vault.syncPriceFromV3Pool(address(whsk));
        assertApproxEqRel(synced, 0.100013e18, 0.001e18, "live V3 TWAP conversion must equal ~$0.100013");
        assertEq(vault.referencePriceE18(address(whsk)), synced, "referencePriceE18 updated from pinned TWAP");
    }

    function test_H1_RevertOnSpotVsTwapFlashManipulation() public {
        // Flash-manipulate spot slot0 by +25% while 5m TWAP tick remains at parity -> must revert OracleDeviationExceeded
        whskUsdtPool.setSqrtPriceX96(28011760000000000000000, -297_120);

        vm.prank(keeper);
        vm.expectRevert();
        vault.syncPriceFromV3Pool(address(whsk));
    }

    function test_H1_RevertOnExcessiveTwapStepDeviationAndLowLiquidity() public {
        // Case A: TWAP + spot jump +20% (exceeds 10% maxDeviationBps bound)
        whskUsdtPool.setSqrtPriceX96(27445800000000000000000, -297_528);
        whskUsdtPool.setTwapTick(-297_528);
        vm.prank(keeper);
        vm.expectRevert();
        vault.syncPriceFromV3Pool(address(whsk));

        // Reset price, then drain liquidity below configured floor
        whskUsdtPool.setSqrtPriceX96(PARITY_WHSK_SQRT_PRICE_X96, PARITY_WHSK_TICK);
        whskUsdtPool.setTwapTick(PARITY_WHSK_TICK);
        whskUsdtPool.setLiquidity(100);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                HorizonGuardVault.InsufficientPoolLiquidity.selector,
                address(whskUsdtPool),
                uint128(100),
                uint128(1_000_000_000_000)
            )
        );
        vault.syncPriceFromV3Pool(address(whsk));
    }

    function test_H1_RevertOnStaleOracleMark() public {
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(5_000e6);
        uint64 updatedAt = vault.lastPriceUpdatedAt(address(whsk));

        // Warp past 3,600s staleness TTL (stay within 7-day session)
        vm.warp(block.timestamp + 3_601);
        intent.deadline = block.timestamp + 300;
        bytes memory sig = _signIntent(AGENT_PK, intent);

        vm.expectRevert(
            abi.encodeWithSelector(HorizonGuardVault.OraclePriceStale.selector, address(whsk), updatedAt, uint32(3_600))
        );
        vault.executeGuardedSwap(intent, sig);
    }

    function test_H2_RevertOnOneWeiExpectedAmountOutAttack() public {
        // Compromised or hallucinating session key signs expectedAmountOut = 1 wei, minAmountOut = 1 wei
        // on a 10,000 USDT -> WHSK swap. Vault MUST reject against independent on-chain oracle floor!
        (, uint256 requiredOracleFloor) =
            vault.quoteOracleMinAmountOut(address(usdt), address(whsk), FEE_LOW, 10_000e6, 50);

        HorizonGuardVault.TradeIntent memory malicious = HorizonGuardVault.TradeIntent({
            router: address(router),
            tokenIn: address(usdt),
            tokenOut: address(whsk),
            fee: FEE_LOW,
            amountIn: 10_000e6,
            minAmountOut: 1,
            expectedAmountOut: 1,
            maxSlippageBps: 50,
            deadline: block.timestamp + 300,
            nonce: vault.nonces(agent),
            strategyTag: keccak256("MALICIOUS_1_WEI_SANDWICH"),
            signalHash: keccak256("EXPLOIT_ATTEMPT")
        });

        bytes memory sig = _signIntent(AGENT_PK, malicious);

        vm.expectRevert(
            abi.encodeWithSelector(HorizonGuardVault.MinAmountOutBelowOracleFloor.selector, 1, requiredOracleFloor)
        );
        vault.executeGuardedSwap(malicious, sig);
    }

    function test_M1_ProRataScalingPreservesDrawdownOnDepositAndWithdrawDuringLoss() public {
        // Start with $70,000 NAV (50k USDT + 200k WHSK @ $0.10).
        // Drop WHSK to $0.065 => WHSK value = $13,000 => NAV = $63,000 => EXACT 10.00% (1,000 bps) drawdown.
        vm.prank(owner);
        vault.setReferencePrice(address(whsk), 0.065e18);
        assertEq(vault.computeTotalNavE18(), 63_000e18, "NAV should be $63,000");
        assertEq(vault.currentDailyDrawdownBps(), 1_000, "initial drawdown must be 10.00%");

        // Owner deposits 7,000 USDT (+10% of peak): drawdown MUST stay 10.00% (not diluted to 9.09%)
        vm.prank(owner);
        vault.deposit(address(usdt), 7_000e6);
        assertEq(vault.computeTotalNavE18(), 70_000e18, "NAV after deposit is $70,000");
        assertEq(vault.currentDailyDrawdownBps(), 1_000, "deposit must preserve exact 10.00% drawdown");

        // Owner withdraws 35,000 USDT (half of current NAV): drawdown MUST stay 10.00% (not jump to 20%)
        vm.prank(owner);
        vault.withdraw(address(usdt), 35_000e6, owner);
        assertEq(vault.computeTotalNavE18(), 35_000e18, "NAV after withdraw is $35,000");
        assertEq(vault.currentDailyDrawdownBps(), 1_000, "withdraw must preserve exact 10.00% drawdown");
        assertFalse(vault.circuitBreakerTripped(), "withdraw alone must not falsely latch breaker");
    }

    function test_M2_AgentCannotBeOwnerAndNativeHskRescueWorks() public {
        vm.prank(owner);
        vm.expectRevert(HorizonGuardVault.AgentCannotBeOwner.selector);
        vault.setAgentSessionKey(owner, uint64(block.timestamp + 1 days), 10_000e18);

        // Forced native HSK recovery
        vm.deal(address(vault), 2 ether);
        uint256 beforeBal = owner.balance;
        vm.prank(owner);
        vault.rescueNative(payable(owner));
        assertEq(address(vault).balance, 0, "vault native balance cleared");
        assertEq(owner.balance, beforeBal + 2 ether, "owner recovered forced native HSK");
    }

    function test_L1_RevertOnZeroCooldownAndExcessiveIntentDeadline() public {
        // Cooldown below MIN_TRADE_INTERVAL_SEC (10s) must revert
        vm.prank(owner);
        vm.expectRevert(HorizonGuardVault.InvalidRiskPolicy.selector);
        vault.updateRiskPolicy(
            HorizonGuardVault.RiskPolicy({
                maxSlippageBps: 50,
                maxPositionBps: 2_500,
                dailyDrawdownCapBps: 300,
                minTradeIntervalSec: 0,
                maxDailyTrades: 24
            })
        );

        // Intent deadline beyond MAX_INTENT_DEADLINE_WINDOW (15 minutes) must revert
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(1_000e6);
        intent.deadline = block.timestamp + 1 hours;
        bytes memory sig = _signIntent(AGENT_PK, intent);

        vm.expectRevert(
            abi.encodeWithSelector(
                HorizonGuardVault.IntentDeadlineTooFar.selector,
                block.timestamp + 1 hours,
                block.timestamp + 15 minutes
            )
        );
        vault.executeGuardedSwap(intent, sig);
    }

    // =========================================================================
    // Stateless Fuzz Tests (256 runs each = 1,280 total runs)
    // =========================================================================

    function testFuzz_MaxPositionCapEnforced(uint256 rawAmount) public {
        uint256 vaultUsdt = usdt.balanceOf(address(vault)); // 50,000e6
        uint256 maxAllowed = (vaultUsdt * 2_500) / 10_000; // 12,500e6
        uint256 amountIn = bound(rawAmount, 100e6, vaultUsdt);

        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(amountIn);
        bytes memory sig = _signIntent(AGENT_PK, intent);

        if (amountIn > maxAllowed) {
            vm.expectRevert(abi.encodeWithSelector(HorizonGuardVault.PositionSizeExceeded.selector, amountIn, maxAllowed));
            vault.executeGuardedSwap(intent, sig);
        } else {
            uint256 out = vault.executeGuardedSwap(intent, sig);
            assertGe(out, intent.minAmountOut, "output must satisfy minAmountOut");
            assertEq(usdt.allowance(address(vault), address(router)), 0, "zero residual approval");
        }
    }

    function testFuzz_OracleFloorBlocksAdversarialMinOut(uint256 amountInRaw, uint256 forgedMinOutRaw) public {
        uint256 amountIn = bound(amountInRaw, 100e6, 12_500e6);
        (, uint256 oracleFloor) = vault.quoteOracleMinAmountOut(address(usdt), address(whsk), FEE_LOW, amountIn, 50);
        uint256 forgedMinOut = bound(forgedMinOutRaw, 1, oracleFloor - 1);

        HorizonGuardVault.TradeIntent memory intent = HorizonGuardVault.TradeIntent({
            router: address(router),
            tokenIn: address(usdt),
            tokenOut: address(whsk),
            fee: FEE_LOW,
            amountIn: amountIn,
            minAmountOut: forgedMinOut,
            expectedAmountOut: forgedMinOut,
            maxSlippageBps: 50,
            deadline: block.timestamp + 300,
            nonce: vault.nonces(agent),
            strategyTag: keccak256("FUZZ_ORACLE_FLOOR"),
            signalHash: keccak256(abi.encodePacked(amountIn, forgedMinOut))
        });

        bytes memory sig = _signIntent(AGENT_PK, intent);
        vm.expectRevert(
            abi.encodeWithSelector(HorizonGuardVault.MinAmountOutBelowOracleFloor.selector, forgedMinOut, oracleFloor)
        );
        vault.executeGuardedSwap(intent, sig);
    }

    function testFuzz_SlippageGuardBlocksExcessiveSlippage(uint16 intentSlippage, uint16 routerSlippage) public {
        uint16 cappedIntentSlip = uint16(bound(intentSlippage, 1, 500));
        uint16 simSlip = uint16(bound(routerSlippage, 0, 500));

        router.setSimulatedSlippageBps(simSlip);

        uint256 amountIn = 5_000e6;
        uint256 fairOut;
        uint256 minOut;
        if (cappedIntentSlip <= 50) {
            (fairOut, minOut) =
                vault.quoteOracleMinAmountOut(address(usdt), address(whsk), FEE_LOW, amountIn, cappedIntentSlip);
        } else {
            fairOut = (amountIn * 999_500 * 1e13) / 1_000_000;
            minOut = (fairOut * (10_000 - cappedIntentSlip)) / 10_000;
        }

        HorizonGuardVault.TradeIntent memory intent = HorizonGuardVault.TradeIntent({
            router: address(router),
            tokenIn: address(usdt),
            tokenOut: address(whsk),
            fee: FEE_LOW,
            amountIn: amountIn,
            minAmountOut: minOut,
            expectedAmountOut: fairOut,
            maxSlippageBps: cappedIntentSlip,
            deadline: block.timestamp + 300,
            nonce: vault.nonces(agent),
            strategyTag: keccak256("FUZZ_SLIPPAGE"),
            signalHash: keccak256(abi.encodePacked(cappedIntentSlip, simSlip))
        });

        bytes memory sig = _signIntent(AGENT_PK, intent);

        if (cappedIntentSlip > 50) {
            vm.expectRevert(abi.encodeWithSelector(HorizonGuardVault.SlippageCapExceeded.selector, cappedIntentSlip, 50));
            vault.executeGuardedSwap(intent, sig);
        } else if (simSlip > cappedIntentSlip) {
            vm.expectRevert();
            vault.executeGuardedSwap(intent, sig);
        } else {
            uint256 out = vault.executeGuardedSwap(intent, sig);
            assertGe(out, minOut, "realized output must respect oracle minOut");
        }
    }

    function testFuzz_SessionVolumeBudgetEnforced(uint128 budgetRaw, uint256 tradeUsdRaw) public {
        uint128 budgetE18 = uint128(bound(budgetRaw, 1_000e18, 25_000e18));
        uint256 tradeUsdt = bound(tradeUsdRaw, 500e6, 12_500e6);

        vm.prank(owner);
        vault.setAgentSessionKey(agent, uint64(block.timestamp + 3 days), budgetE18);

        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(tradeUsdt);
        bytes memory sig = _signIntent(AGENT_PK, intent);

        uint256 notionalE18 = tradeUsdt * 1e12;
        if (notionalE18 > budgetE18) {
            vm.expectRevert(
                abi.encodeWithSelector(HorizonGuardVault.SessionVolumeBudgetExceeded.selector, notionalE18, budgetE18)
            );
            vault.executeGuardedSwap(intent, sig);
        } else {
            vault.executeGuardedSwap(intent, sig);
            (, , , uint128 usedVol,) = vault.session();
            assertEq(usedVol, notionalE18, "consumed session volume must equal trade notional");
        }
    }

    function testFuzz_DailyDrawdownCircuitBreakerThreshold(uint256 newWhskPriceRaw) public {
        uint256 newPrice = bound(newWhskPriceRaw, 0.05e18, 0.15e18);

        vm.prank(owner);
        vault.setReferencePrice(address(whsk), newPrice);

        uint256 nav = vault.computeTotalNavE18();
        uint256 ddBps = nav >= 70_000e18 ? 0 : ((70_000e18 - nav) * 10_000) / 70_000e18;

        bool tripped = vault.checkAndTripCircuitBreaker();
        if (ddBps >= 300) {
            assertTrue(tripped, "must trip when drawdown >= 300 bps");
            assertTrue(vault.circuitBreakerTripped(), "flag must be set");
        } else {
            assertFalse(tripped, "must not trip when drawdown < 300 bps");
            assertFalse(vault.circuitBreakerTripped(), "flag must remain clear");
        }
    }

    // =========================================================================
    // Expanded Security Hardening Regression & Fuzz Tests
    // =========================================================================

    function test_RevertOnZeroLockedAndUninitializedOraclePrice() public {
        // Case A: zero sqrtPriceX96 in pool reverts sync
        whskUsdtPool.setSqrtPriceX96(0, PARITY_WHSK_TICK);
        vm.prank(keeper);
        vm.expectRevert(HorizonGuardVault.ZeroAmount.selector);
        vault.syncPriceFromV3Pool(address(whsk));

        // Case B: locked V3 pool reverts sync with PoolLocked
        whskUsdtPool.setSqrtPriceX96(PARITY_WHSK_SQRT_PRICE_X96, PARITY_WHSK_TICK);
        whskUsdtPool.setUnlocked(false);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(HorizonGuardVault.PoolLocked.selector, address(whskUsdtPool)));
        vault.syncPriceFromV3Pool(address(whsk));
        whskUsdtPool.setUnlocked(true);

        // Case C: zero manual reference price override rejected
        vm.prank(owner);
        vm.expectRevert(HorizonGuardVault.ZeroAmount.selector);
        vault.setReferencePrice(address(whsk), 0);

        // Case D: uninitialized pool with observationCardinality == 0 rejected
        MockUninitializedV3Pool uninitPool = new MockUninitializedV3Pool(
            address(whsk),
            address(usdt),
            PARITY_WHSK_SQRT_PRICE_X96,
            PARITY_WHSK_TICK,
            LIVE_WHSK_USDT_LIQUIDITY
        );
        vm.prank(owner);
        vault.setOraclePool(address(whsk), address(uninitPool), 300, 1_000, 3_600, 1_000_000_000_000);
        vm.prank(keeper);
        vm.expectRevert(HorizonGuardVault.InvalidOracleConfig.selector);
        vault.syncPriceFromV3Pool(address(whsk));
    }

    function test_RevertOnRegisterQuoteTokenOverrideAndInvalidFee() public {
        vm.startPrank(owner);
        vm.expectRevert(HorizonGuardVault.InvalidOracleConfig.selector);
        vault.registerToken(address(usdt), 18, 2e18);

        vm.expectRevert(HorizonGuardVault.InvalidOracleConfig.selector);
        vault.setAllowedPair(address(usdt), address(whsk), 1_000_000, true);

        MockERC20 badDec = new MockERC20("BadDec", "BAD", 18);
        vm.expectRevert(HorizonGuardVault.InvalidOracleConfig.selector);
        vault.registerToken(address(badDec), 19, 1e18);
        vm.stopPrank();

        vm.expectRevert(HorizonGuardVault.InvalidOracleConfig.selector);
        vault.quoteOracleMinAmountOut(address(usdt), address(whsk), 1_000_000, 1_000e6, 50);

        assertEq(vault.referencePriceE18(address(usdt)), 1e18, "quote token price must remain pinned at 1e18");
    }

    function test_RevertOnRoleEscalationByAgentKeeperAndAttacker() public {
        address[3] memory nonOwners = [agent, keeper, attacker];
        HorizonGuardVault.RiskPolicy memory loosePolicy = HorizonGuardVault.RiskPolicy({
            maxSlippageBps: 500,
            maxPositionBps: 10_000,
            dailyDrawdownCapBps: 2_500,
            minTradeIntervalSec: 10,
            maxDailyTrades: 100
        });

        for (uint256 i = 0; i < nonOwners.length; ++i) {
            address actor = nonOwners[i];
            vm.startPrank(actor);

            vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
            vault.setPaused(true);

            vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
            vault.resetCircuitBreaker();

            vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
            vault.updateRiskPolicy(loosePolicy);

            vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
            vault.setAgentSessionKey(actor, uint64(block.timestamp + 1 days), 1_000_000e18);

            vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
            vault.setPriceKeeper(actor, true);

            vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
            vault.setOraclePool(address(whsk), address(whskUsdtPool), 300, 1_000, 3_600, 1);

            vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
            vault.setAllowedRouter(address(0xDEAD), true);

            vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
            vault.setAllowedPair(address(usdt), address(whsk), 100, true);

            vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
            vault.setReferencePrice(address(whsk), 1e18);

            vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
            vault.transferOwnership(actor);

            vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
            vault.withdraw(address(usdt), 1e6, actor);

            vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
            vault.emergencyWithdraw(address(usdt), actor);

            vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
            vault.rescueNative(payable(actor));

            if (actor != keeper) {
                vm.expectRevert(HorizonGuardVault.Unauthorized.selector);
                vault.syncPriceFromV3Pool(address(whsk));
            }
            vm.stopPrank();
        }
    }

    function test_EmergencyPauseImmediatelyHaltsSwapAndUnpauseResumes() public {
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(5_000e6);
        bytes memory sig = _signIntent(AGENT_PK, intent);

        vm.prank(owner);
        vault.setPaused(true);
        assertTrue(vault.paused(), "vault must be paused");

        vm.expectRevert(HorizonGuardVault.VaultIsPaused.selector);
        vault.executeGuardedSwap(intent, sig);
        assertEq(vault.nonces(agent), 0, "nonce must not advance while paused");

        // Owner custody remains accessible while paused
        vm.prank(owner);
        vault.withdraw(address(usdt), 1_000e6, owner);
        assertEq(usdt.balanceOf(address(vault)), 49_000e6, "owner withdraw allowed while paused");

        // Unpause restores autonomous execution cleanly
        vm.prank(owner);
        vault.setPaused(false);
        uint256 out = vault.executeGuardedSwap(intent, sig);
        assertGe(out, intent.minAmountOut, "swap executes cleanly after unpause");
        assertEq(vault.nonces(agent), 1, "nonce increments after unpause");
    }

    function test_DailyTradeCountHardCapAndUtcDayRolloverReset() public {
        uint256 t0 = 1_764_000_000;
        vm.prank(owner);
        vault.updateRiskPolicy(
            HorizonGuardVault.RiskPolicy({
                maxSlippageBps: 50,
                maxPositionBps: 2_500,
                dailyDrawdownCapBps: 300,
                minTradeIntervalSec: 10,
                maxDailyTrades: 2
            })
        );

        HorizonGuardVault.TradeIntent memory intent1 = _buildDefaultUsdtToWhskIntent(1_000e6);
        intent1.deadline = t0 + 300;
        vault.executeGuardedSwap(intent1, _signIntent(AGENT_PK, intent1));

        vm.warp(t0 + 15);
        HorizonGuardVault.TradeIntent memory intent2 = _buildDefaultUsdtToWhskIntent(1_000e6);
        intent2.deadline = t0 + 315;
        vault.executeGuardedSwap(intent2, _signIntent(AGENT_PK, intent2));
        assertEq(vault.dailyTradeCount(), 2, "two trades recorded");

        vm.warp(t0 + 30);
        HorizonGuardVault.TradeIntent memory intent3 = _buildDefaultUsdtToWhskIntent(1_000e6);
        intent3.deadline = t0 + 330;
        bytes memory sig3 = _signIntent(AGENT_PK, intent3);
        vm.expectRevert(abi.encodeWithSelector(HorizonGuardVault.MaxDailyTradesReached.selector, 2, 2));
        vault.executeGuardedSwap(intent3, sig3);

        // Roll into next UTC day, refresh TWAP oracle, verify counter resets cleanly
        vm.warp(t0 + 1 days + 30);
        vm.prank(keeper);
        vault.syncPriceFromV3Pool(address(whsk));

        HorizonGuardVault.TradeIntent memory intentNextDay = _buildDefaultUsdtToWhskIntent(1_000e6);
        intentNextDay.deadline = t0 + 1 days + 330;
        vault.executeGuardedSwap(intentNextDay, _signIntent(AGENT_PK, intentNextDay));
        assertEq(vault.dailyTradeCount(), 1, "daily trade count resets on new UTC day");
    }

    function test_RevokedSessionKeyImmediatelyBlocksExecution() public {
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(2_000e6);
        bytes memory sig = _signIntent(AGENT_PK, intent);

        vm.prank(owner);
        vault.revokeAgentSessionKey();

        vm.expectRevert(HorizonGuardVault.SessionNotActive.selector);
        vault.executeGuardedSwap(intent, sig);
    }

    function test_PreTradeDrawdownBreachRevertsBeforeSpendingFunds() public {
        // Drop WHSK reference price from $0.10 to $0.088 => 3.428% drawdown (>= 3.00% cap)
        // WITHOUT calling checkAndTripCircuitBreaker() first
        vm.prank(owner);
        vault.setReferencePrice(address(whsk), 0.088e18);
        assertFalse(vault.circuitBreakerTripped(), "breaker flag not yet latched");

        // Align pool TWAP to $0.088 so oracle check passes and pre-trade drawdown check triggers
        whskUsdtPool.setSqrtPriceX96(23503651000000000000000, -300_629);
        whskUsdtPool.setTwapTick(-300_629);

        uint256 usdtBefore = usdt.balanceOf(address(vault));
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(2_000e6);
        bytes memory sig = _signIntent(AGENT_PK, intent);

        uint256 expectedDd = vault.currentDailyDrawdownBps();
        vm.expectRevert(abi.encodeWithSelector(HorizonGuardVault.DailyDrawdownExceeded.selector, expectedDd, 300));
        vault.executeGuardedSwap(intent, sig);

        assertEq(usdt.balanceOf(address(vault)), usdtBefore, "no funds spent on pre-trade drawdown revert");
        assertEq(usdt.allowance(address(vault), address(router)), 0, "no router allowance left");
        assertEq(vault.nonces(agent), 0, "nonce untouched");
    }

    function test_ReadOnlyAndStateReentrancyBlockedDuringCallback() public {
        ReentrantCallbackERC20 evilToken = new ReentrantCallbackERC20(vault);

        vm.startPrank(owner);
        vault.registerToken(address(evilToken), 18, 1e18);
        evilToken.mint(owner, 1_000e18);
        evilToken.approve(address(vault), type(uint256).max);
        vault.deposit(address(evilToken), 500e18);
        vm.stopPrank();

        assertTrue(evilToken.navReentryReverted(), "read-only computeTotalNavE18 reentry must revert");
        assertTrue(evilToken.drawdownReentryReverted(), "read-only currentDailyDrawdownBps reentry must revert");
        assertTrue(evilToken.withdrawReentryReverted(), "state-mutating withdraw reentry must revert");
    }

    function test_BidirectionalWhskToUsdtSwapAndDirectionalSqrtPriceLimit() public {
        uint256 amountInWhsk = 40_000e18; // 20% of 200,000 WHSK balance
        (uint256 fairOut, uint256 minOut) =
            vault.quoteOracleMinAmountOut(address(whsk), address(usdt), FEE_LOW, amountInWhsk, 50);

        HorizonGuardVault.TradeIntent memory intent = HorizonGuardVault.TradeIntent({
            router: address(router),
            tokenIn: address(whsk),
            tokenOut: address(usdt),
            fee: FEE_LOW,
            amountIn: amountInWhsk,
            minAmountOut: minOut,
            expectedAmountOut: fairOut,
            maxSlippageBps: 50,
            deadline: block.timestamp + 300,
            nonce: vault.nonces(agent),
            strategyTag: keccak256("HSK_ROTATE_TO_USDT"),
            signalHash: keccak256("SELL_WHSK_SIGNAL")
        });

        uint256 outUsdt = vault.executeGuardedSwap(intent, _signIntent(AGENT_PK, intent));
        assertGe(outUsdt, minOut, "WHSK->USDT output must satisfy oracle floor");
        assertEq(whsk.allowance(address(vault), address(router)), 0, "zero residual WHSK router allowance");
        assertGt(uint256(router.lastSqrtPriceLimitX96()), 4295128739, "sqrtPriceLimitX96 above MIN_SQRT_RATIO");
        assertLt(
            uint256(router.lastSqrtPriceLimitX96()),
            uint256(PARITY_WHSK_SQRT_PRICE_X96),
            "directional zeroForOne sqrtPriceLimitX96 must sit below spot"
        );
    }

    function test_MaxTrackedTokensCeilingEnforced() public {
        // Already tracked: USDT + WHSK = 2 tokens; register 14 more to reach MAX_TRACKED_TOKENS = 16
        vm.startPrank(owner);
        for (uint256 i = 2; i < 16; ++i) {
            MockERC20 tok = new MockERC20("Extra", "EXT", 18);
            vault.registerToken(address(tok), 18, 1e18);
        }
        assertEq(vault.getTrackedTokens().length, 16, "must reach MAX_TRACKED_TOKENS");

        MockERC20 overflowTok = new MockERC20("Overflow", "OVF", 18);
        vm.expectRevert(HorizonGuardVault.MaxTrackedTokensReached.selector);
        vault.registerToken(address(overflowTok), 18, 1e18);
        vm.stopPrank();
    }

    function testFuzz_MulDiv512BitNewtonRaphsonExact(
        uint128 rawK,
        uint128 rawM,
        uint128 rawD,
        uint128 rawR
    ) public {
        VaultMathHarness harness = new VaultMathHarness(owner, address(usdt), 6);
        uint256 k = bound(rawK, 1 << 110, (1 << 124) - 1);
        uint256 m = bound(rawM, 1 << 110, (1 << 124) - 1);
        uint256 d = bound(rawD, 1 << 110, (1 << 124) - 1);
        uint256 r = bound(rawR, 0, d - 1);

        // a = k*d + r (< 2^249), b = m (< 2^124) => a*b > 2^256 (forces 512-bit Newton-Raphson path!)
        uint256 a = k * d + r;
        uint256 expected = k * m + (r * m) / d;
        uint256 actual = harness.exposedMulDiv(a, m, d);
        assertEq(actual, expected, "512-bit _mulDiv must match exact floor arithmetic");
    }

    function testFuzz_ProRataScalingPreservesDrawdownInvariant(
        uint256 priceRaw,
        uint256 flowRaw,
        bool isDeposit
    ) public {
        uint256 shockedPrice = bound(priceRaw, 0.04e18, 0.098e18);
        vm.prank(owner);
        vault.setReferencePrice(address(whsk), shockedPrice);

        uint256 ddBefore = vault.currentDailyDrawdownBps();
        if (isDeposit) {
            uint256 dep = bound(flowRaw, 100e6, 50_000e6);
            usdt.mint(owner, dep);
            vm.prank(owner);
            vault.deposit(address(usdt), dep);
        } else {
            uint256 wd = bound(flowRaw, 100e6, 25_000e6);
            vm.prank(owner);
            vault.withdraw(address(usdt), wd, owner);
        }

        uint256 ddAfter = vault.currentDailyDrawdownBps();
        // Because high-water baseline rounds UP on pro-rata scaling, drawdown never dilutes downward
        assertGe(ddAfter, ddBefore, "pro-rata flow must never dilute existing drawdown");
        assertLe(ddAfter, ddBefore + 1, "pro-rata flow must not distort drawdown by more than 1 bps rounding");
    }
}

contract MockUninitializedV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint128 public immutable liquidity;
    uint160 internal immutable _sqrtPriceX96;
    int24 internal immutable _tick;

    constructor(address t0, address t1, uint160 sqrtPriceX96_, int24 tick_, uint128 liq_) {
        token0 = t0;
        token1 = t1;
        _sqrtPriceX96 = sqrtPriceX96_;
        _tick = tick_;
        liquidity = liq_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (_sqrtPriceX96, _tick, 0, 0, 0, 0, true);
    }
}

contract ReentrantCallbackERC20 {
    HorizonGuardVault public immutable targetVault;
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public navReentryReverted;
    bool public drawdownReentryReverted;
    bool public withdrawReentryReverted;

    constructor(HorizonGuardVault vault_) {
        targetVault = vault_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "INSUFFICIENT_BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "INSUFFICIENT_ALLOWANCE");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        require(balanceOf[from] >= amount, "INSUFFICIENT_BALANCE");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;

        if (to == address(targetVault)) {
            try targetVault.computeTotalNavE18() {} catch {
                navReentryReverted = true;
            }
            try targetVault.currentDailyDrawdownBps() {} catch {
                drawdownReentryReverted = true;
            }
            try targetVault.withdraw(address(this), 1, msg.sender) {} catch {
                withdrawReentryReverted = true;
            }
        }
        return true;
    }
}

contract VaultMathHarness is HorizonGuardVault {
    constructor(address initialOwner, address quoteTokenAddress, uint8 quoteTokenDecimals)
        HorizonGuardVault(
            initialOwner,
            quoteTokenAddress,
            quoteTokenDecimals,
            RiskPolicy({
                maxSlippageBps: 50,
                maxPositionBps: 2_500,
                dailyDrawdownCapBps: 300,
                minTradeIntervalSec: 60,
                maxDailyTrades: 24
            })
        )
    {}

    function exposedMulDiv(uint256 a, uint256 b, uint256 denominator) external pure returns (uint256) {
        return _mulDiv(a, b, denominator);
    }
}
