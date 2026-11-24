// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TestBase} from "./utils/TestBase.sol";
import {HorizonGuardVault} from "../src/HorizonGuardVault.sol";
import {MockHSKSwapRouter, MockV3Pool} from "../src/MockHSKSwapRouter.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// @title HorizonGuardVaultTest
/// @notice Comprehensive Foundry unit + fuzz test suite for HorizonGuardVault on HashKey Chain (Chain ID 177).
contract HorizonGuardVaultTest is TestBase {
    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant AGENT_PK = 0xB0B;
    uint256 internal constant ATTACKER_PK = 0xBAD;

    address internal owner;
    address internal agent;
    address internal relayer = address(0xCAFE);
    address internal attacker;

    MockERC20 internal usdt; // 6 decimals (matches HSK Chain USDT 0xF1B5...9029)
    MockERC20 internal whsk; // 18 decimals (matches HSK Chain WHSK 0xB210...1Cf1)
    MockERC20 internal weth; // 18 decimals (matches HSK Chain WETH 0xefd4...dfd0)

    MockHSKSwapRouter internal router;
    MockV3Pool internal whskUsdtPool;
    HorizonGuardVault internal vault;

    uint24 internal constant FEE_LOW = 500; // 0.05% live HSKSwap tier
    uint24 internal constant FEE_MID = 3000; // 0.30% live HSKSwap tier

    // Live HSKSwap mainnet WHSK/USDT 0.05% pool sqrtPriceX96 observed on 2026-11-24 (~$0.100013 per WHSK)
    uint160 internal constant LIVE_WHSK_USDT_SQRT_PRICE_X96 = 25055738251564958613595;

    function setUp() public {
        vm.chainId(177); // HashKey Chain Mainnet
        vm.warp(1_764_000_000); // Deterministic UTC timestamp

        owner = vm.addr(OWNER_PK);
        agent = vm.addr(AGENT_PK);
        attacker = vm.addr(ATTACKER_PK);

        usdt = new MockERC20("Tether USD", "USDT", 6);
        whsk = new MockERC20("Wrapped HSK", "WHSK", 18);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);

        router = new MockHSKSwapRouter(address(0xD136e36610f35E0Cc3cAd40de858c151f2AA65D4), address(whsk));

        // Configure realistic HSK Chain exchange rates:
        // 1 WHSK (1e18) = 0.10 USDT (1e5 raw) => rate(WHSK->USDT) = 1e5 (since 1e18 * 1e5 / 1e18 = 1e5)
        // 1 USDT (1e6)  = 10 WHSK (10e18 raw) => rate(USDT->WHSK) = 1e31 (since 1e6 * 1e31 / 1e18 = 10e18)
        router.setRate(address(whsk), address(usdt), 1e5);
        router.setRate(address(usdt), address(whsk), 1e31);

        // 1 WETH (1e18) = 3,200 USDT (3200e6 raw) => rate(WETH->USDT) = 3200e6
        // 1 USDT (1e6)  = 1/3200 WETH => rate(USDT->WETH) = 312_500_000_000_000_000_000_000_000 (3.125e26)
        router.setRate(address(weth), address(usdt), 3_200e6);
        router.setRate(address(usdt), address(weth), 312_500_000_000_000_000_000_000_000);

        // Seed router liquidity
        usdt.mint(address(router), 5_000_000e6);
        whsk.mint(address(router), 50_000_000e18);
        weth.mint(address(router), 1_000e18);

        // Deploy live-anchored WHSK/USDT V3 pool mock (token0 = WHSK, token1 = USDT)
        whskUsdtPool = new MockV3Pool(
            address(whsk),
            address(usdt),
            FEE_LOW,
            LIVE_WHSK_USDT_SQRT_PRICE_X96,
            2_830_955_089_632
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
        vault.registerToken(address(weth), 18, 3_200e18); // $3,200 / WETH
        vault.setAllowedRouter(address(router), true);
        vault.setAllowedPair(address(usdt), address(whsk), FEE_LOW, true);
        vault.setAllowedPair(address(whsk), address(usdt), FEE_LOW, true);
        vault.setAllowedPair(address(usdt), address(whsk), FEE_MID, true);
        vault.setAllowedPair(address(usdt), address(weth), FEE_LOW, true);

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
        // At 0.05% fee & 10 WHSK per USDT: expectedOut = amountIn * 9995 / 10000 * 1e13
        uint256 expectedOut = (amountInUsdt * 999_500 * 1e13) / 1_000_000;
        uint256 minOut = (expectedOut * (10_000 - 50)) / 10_000;
        return HorizonGuardVault.TradeIntent({
            router: address(router),
            tokenIn: address(usdt),
            tokenOut: address(whsk),
            fee: FEE_LOW,
            amountIn: amountInUsdt,
            minAmountOut: minOut,
            expectedAmountOut: expectedOut,
            maxSlippageBps: 50,
            deadline: block.timestamp + 300,
            nonce: vault.nonces(agent),
            strategyTag: keccak256("HSK_MOMENTUM_V1"),
            signalHash: keccak256("SIGNAL_EMA9_CROSS_20261124")
        });
    }

    // =========================================================================
    // Unit Tests
    // =========================================================================

    function test_InitialStateAndNavAccounting() public view {
        assertEq(vault.owner(), owner, "owner mismatch");
        assertEq(vault.computeTotalNavE18(), 70_000e18, "initial NAV must equal 70,000 USD");
        assertEq(vault.dayStartNavE18(), 70_000e18, "dayStartNav mismatch");
        assertEq(vault.dayHighWaterNavE18(), 70_000e18, "dayHighWaterNav mismatch");
        assertFalse(vault.paused(), "vault must start unpaused");
        assertFalse(vault.circuitBreakerTripped(), "circuit breaker must start disarmed");
    }

    function test_ExecuteGuardedSwap_SuccessAndZeroResidualAllowance() public {
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(10_000e6); // 20% of 50k USDT
        bytes memory sig = _signIntent(AGENT_PK, intent);

        vm.prank(relayer);
        uint256 out = vault.executeGuardedSwap(intent, sig);

        assertEq(out, intent.expectedAmountOut, "exact swap output expected");
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

        // Compute malleable counterpart (s' = secp256k1.n - s, flipped v)
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
        HorizonGuardVault.TradeIntent memory intent2 = _buildDefaultUsdtToWhskIntent(5_000e6);
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

        // Disallowed fee tier (10000 not allowlisted)
        HorizonGuardVault.TradeIntent memory intent2 = _buildDefaultUsdtToWhskIntent(5_000e6);
        intent2.fee = 10_000;
        bytes memory sig2 = _signIntent(AGENT_PK, intent2);

        vm.expectRevert(
            abi.encodeWithSelector(HorizonGuardVault.PairNotAllowed.selector, address(usdt), address(whsk), 10_000)
        );
        vault.executeGuardedSwap(intent2, sig2);
    }

    function test_RevertOnSlippageCapAndAdverseRouterFill() public {
        // Case A: Intent requests slippage cap higher than policy (100 bps > 50 bps)
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(5_000e6);
        intent.maxSlippageBps = 100;
        bytes memory sig = _signIntent(AGENT_PK, intent);

        vm.expectRevert(abi.encodeWithSelector(HorizonGuardVault.SlippageCapExceeded.selector, 100, 50));
        vault.executeGuardedSwap(intent, sig);

        // Case B: Intent adheres to 50 bps, but router suffers 80 bps adverse price impact (MEV / thin liquidity)
        router.setSimulatedSlippageBps(80);
        HorizonGuardVault.TradeIntent memory intent2 = _buildDefaultUsdtToWhskIntent(5_000e6);
        bytes memory sig2 = _signIntent(AGENT_PK, intent2);

        vm.expectRevert(); // MockHSKSwapRouter reverts InsufficientOutputAmount before vault loses capital
        vault.executeGuardedSwap(intent2, sig2);
    }

    function test_RevertOnPositionSizeCap() public {
        // Vault holds 50,000 USDT; maxPositionBps = 2500 (25%) => max single trade = 12,500 USDT
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

        // Immediate second trade inside 60s cooldown must revert
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

        // After cooldown elapses, second trade succeeds
        vm.warp(block.timestamp + 61);
        HorizonGuardVault.TradeIntent memory intent3 = _buildDefaultUsdtToWhskIntent(2_000e6);
        vault.executeGuardedSwap(intent3, _signIntent(AGENT_PK, intent3));
        assertEq(vault.dailyTradeCount(), 2, "second trade after cooldown should succeed");
    }

    function test_DailyDrawdownCircuitBreaker_TripsAndBlocksFurtherTrades() public {
        // Vault holds 50,000 USDT ($50k) + 200,000 WHSK ($20k) = $70,000 NAV
        // Drop WHSK reference price from $0.10 to $0.088 => WHSK value drops $2,400 (-3.428% > 3.00% cap)
        vm.prank(owner);
        vault.setReferencePrice(address(whsk), 0.088e18);

        assertGt(vault.currentDailyDrawdownBps(), 300, "drawdown must exceed 300 bps");

        // Pre-trade guard immediately rejects swap even before sentinel trips
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(2_000e6);
        bytes memory sig = _signIntent(AGENT_PK, intent);
        vm.expectRevert();
        vault.executeGuardedSwap(intent, sig);

        // Permissionless sentinel permanently trips on-chain circuit breaker
        bool tripped = vault.checkAndTripCircuitBreaker();
        assertTrue(tripped, "sentinel must trip circuit breaker");
        assertTrue(vault.circuitBreakerTripped(), "circuit breaker flag must persist");

        // Even if price recovers intraday, circuit breaker remains latched until owner resets
        vm.prank(owner);
        vault.setReferencePrice(address(whsk), 0.10e18);
        vm.expectRevert(HorizonGuardVault.CircuitBreakerActive.selector);
        vault.executeGuardedSwap(intent, sig);

        // Owner inspects and resets circuit breaker
        vm.prank(owner);
        vault.resetCircuitBreaker();
        assertFalse(vault.circuitBreakerTripped(), "circuit breaker should be cleared after owner reset");

        // Autonomous trading resumes cleanly
        vault.executeGuardedSwap(intent, sig);
        assertEq(vault.getExecutionCount(), 1, "trade executes after owner reset");
    }

    function test_OwnerDepositWithdrawDoesNotFalselyTripCircuitBreaker() public {
        // Owner withdraws 25,000 USDT (35.7% of vault NAV) — must adjust baseline and keep drawdown = 0 bps!
        vm.prank(owner);
        vault.withdraw(address(usdt), 25_000e6, owner);

        assertEq(vault.computeTotalNavE18(), 45_000e18, "NAV reflects withdrawal");
        assertEq(vault.currentDailyDrawdownBps(), 0, "owner withdrawal must not register as trading drawdown");
        assertFalse(vault.circuitBreakerTripped(), "circuit breaker must remain disarmed");
    }

    function test_SyncPriceFromLiveHSKSwapV3PoolSlot0() public {
        // Sync directly from live mainnet sqrtPriceX96 = 25055738251564958613595 (~$0.100013 per WHSK)
        uint256 synced = vault.syncPriceFromV3Pool(address(whsk), address(whskUsdtPool));
        assertApproxEqRel(synced, 0.100013e18, 0.001e18, "live V3 sqrtPriceX96 conversion must equal ~$0.100013");
        assertEq(vault.referencePriceE18(address(whsk)), synced, "referencePriceE18 updated from V3 pool");
    }

    function test_EmergencyWithdrawPausesAndRecoversAllFunds() public {
        vm.startPrank(owner);
        uint256 ownerBefore = usdt.balanceOf(owner);
        vault.emergencyWithdraw(address(usdt), owner);
        vm.stopPrank();

        assertTrue(vault.paused(), "emergency withdraw must pause vault");
        assertEq(usdt.balanceOf(address(vault)), 0, "vault USDT drained to owner");
        assertEq(usdt.balanceOf(owner), ownerBefore + 50_000e6, "owner recovered full USDT");

        // Any agent intent while paused must revert
        HorizonGuardVault.TradeIntent memory intent = _buildDefaultUsdtToWhskIntent(1_000e6);
        bytes memory sig = _signIntent(AGENT_PK, intent);
        vm.expectRevert(HorizonGuardVault.VaultIsPaused.selector);
        vault.executeGuardedSwap(intent, sig);
    }

    function test_PostTradeDrawdownTripsCircuitBreakerAutomatically() public {
        // Set tight 50 bps daily drawdown cap and execute a swap with 45 bps router slippage + 5 bps pool fee + slight mark drift
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

        // Slight mark price drift on WHSK from $0.10 to $0.0985 drops initial NAV by $300 (~42.8 bps, still < 50 bps pre-trade)
        vm.prank(owner);
        vault.setReferencePrice(address(whsk), 0.0985e18);
        assertLt(vault.currentDailyDrawdownBps(), 50, "pre-trade drawdown must remain below cap");

        // Router suffers 80 bps adverse execution (still under updated 100 bps slippage cap), pushing post-trade drawdown >= 50 bps
        router.setSimulatedSlippageBps(80);
        uint256 amountIn = 20_000e6;
        uint256 expectedOut = (amountIn * 999_500 * 1e13) / 1_000_000;
        uint256 minOut = (expectedOut * (10_000 - 100)) / 10_000;

        HorizonGuardVault.TradeIntent memory intent = HorizonGuardVault.TradeIntent({
            router: address(router),
            tokenIn: address(usdt),
            tokenOut: address(whsk),
            fee: FEE_LOW,
            amountIn: amountIn,
            minAmountOut: minOut,
            expectedAmountOut: expectedOut,
            maxSlippageBps: 100,
            deadline: block.timestamp + 300,
            nonce: vault.nonces(agent),
            strategyTag: keccak256("STRESS_POST_TRADE_CB"),
            signalHash: keccak256("STRESS_SIG_1")
        });

        bytes memory sig = _signIntent(AGENT_PK, intent);
        vault.executeGuardedSwap(intent, sig);

        assertTrue(vault.circuitBreakerTripped(), "post-trade drawdown breach must auto-trip circuit breaker");

        // Next swap immediately blocked by latched circuit breaker
        vm.warp(block.timestamp + 30);
        HorizonGuardVault.TradeIntent memory intent2 = _buildDefaultUsdtToWhskIntent(1_000e6);
        bytes memory sig2 = _signIntent(AGENT_PK, intent2);
        vm.expectRevert(HorizonGuardVault.CircuitBreakerActive.selector);
        vault.executeGuardedSwap(intent2, sig2);
    }

    function test_TwoStepOwnershipTransfer() public {
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
    }

    function assertLt(uint256 a, uint256 b, string memory message) internal pure {
        require(a < b, message);
    }

    function test_OnlyOwnerCanMutatePolicyOrWithdraw() public {
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
    // Fuzz Tests (256 runs each)
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

    function testFuzz_SlippageGuardBlocksExcessiveSlippage(uint16 intentSlippage, uint16 routerSlippage) public {
        uint16 cappedIntentSlip = uint16(bound(intentSlippage, 1, 500));
        uint16 simSlip = uint16(bound(routerSlippage, 0, 500));

        router.setSimulatedSlippageBps(simSlip);

        uint256 amountIn = 5_000e6;
        uint256 expectedOut = (amountIn * 999_500 * 1e13) / 1_000_000;
        uint256 minOut = (expectedOut * (10_000 - cappedIntentSlip)) / 10_000;

        HorizonGuardVault.TradeIntent memory intent = HorizonGuardVault.TradeIntent({
            router: address(router),
            tokenIn: address(usdt),
            tokenOut: address(whsk),
            fee: FEE_LOW,
            amountIn: amountIn,
            minAmountOut: minOut,
            expectedAmountOut: expectedOut,
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
            assertGe(out, minOut, "realized output must respect minOut");
        }
    }

    function testFuzz_SessionVolumeBudgetEnforced(uint128 budgetRaw, uint256 tradeUsdRaw) public {
        uint128 budgetE18 = uint128(bound(budgetRaw, 1_000e18, 25_000e18));
        uint256 tradeUsdt = bound(tradeUsdRaw, 500e6, 12_500e6); // within 25% position cap

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
            (, , , uint128 usedVol, ) = vault.session();
            assertEq(usedVol, notionalE18, "consumed session volume must equal trade notional");
        }
    }

    function testFuzz_DailyDrawdownCircuitBreakerThreshold(uint256 newWhskPriceRaw) public {
        // Initial NAV: 50,000 USDT + 200,000 WHSK * $0.10 = $70,000
        // Bound WHSK price between $0.05 and $0.15
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
}
