// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TestBase} from "../utils/TestBase.sol";
import {HorizonGuardVault} from "../../src/HorizonGuardVault.sol";
import {MockHSKSwapRouter, MockV3Pool} from "../../src/MockHSKSwapRouter.sol";
import {MockERC20} from "../../src/MockERC20.sol";

/// @title HorizonVaultHandler
/// @notice Bounded multi-actor stateful fuzzing handler exercising owner flows, bidirectional swaps,
///         keeper TWAP syncs, pause/breaker toggles, time warps, and adversarial attacks against HorizonGuardVault.
contract HorizonVaultHandler is TestBase {
    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant AGENT_PK = 0xB0B;
    uint256 internal constant KEEPER_PK = 0xC0DE;
    uint256 internal constant ATTACKER_PK = 0xBAD;

    uint160 internal constant PARITY_SQRT_PRICE_X96 = 25054485400000000000000;
    int24 internal constant PARITY_TICK = -299_351;

    HorizonGuardVault public immutable vault;
    MockHSKSwapRouter public immutable router;
    MockV3Pool public immutable pool;
    MockERC20 public immutable usdt;
    MockERC20 public immutable whsk;

    address public immutable owner;
    address public immutable agent;
    address public immutable keeper;
    address public immutable attacker;

    uint256 public ghostSuccessfulSwaps;
    uint256 public ghostAdversarialSwapsSucceeded;
    uint256 public ghostUnauthorizedSyncsSucceeded;
    uint256 public ghostUnauthorizedWithdrawsSucceeded;
    uint256 public ghostBypassWhilePausedOrTripped;
    uint256 public ghostCapBypassSucceeded;
    uint256 public ghostStaleOrZeroOracleSucceeded;
    uint256 public ghostRoleEscalationSucceeded;

    constructor(
        HorizonGuardVault vault_,
        MockHSKSwapRouter router_,
        MockV3Pool pool_,
        MockERC20 usdt_,
        MockERC20 whsk_
    ) {
        vault = vault_;
        router = router_;
        pool = pool_;
        usdt = usdt_;
        whsk = whsk_;
        owner = vm.addr(OWNER_PK);
        agent = vm.addr(AGENT_PK);
        keeper = vm.addr(KEEPER_PK);
        attacker = vm.addr(ATTACKER_PK);
    }

    function _signIntent(uint256 pk, HorizonGuardVault.TradeIntent memory intent) internal view returns (bytes memory) {
        bytes32 digest = vault.getTradeIntentDigest(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function handler_depositUsdt(uint256 rawAmount) external {
        uint256 amount = bound(rawAmount, 50e6, 10_000e6);
        usdt.mint(owner, amount);
        vm.startPrank(owner);
        usdt.approve(address(vault), amount);
        vault.deposit(address(usdt), amount);
        vm.stopPrank();
    }

    function handler_withdrawUsdt(uint256 rawPct) external {
        uint256 bal = usdt.balanceOf(address(vault));
        if (bal < 100e6) return;
        uint256 pct = bound(rawPct, 1, 40);
        uint256 amount = (bal * pct) / 100;
        if (amount == 0) return;

        vm.prank(owner);
        vault.withdraw(address(usdt), amount, owner);
    }

    function handler_executeValidUsdtToWhskSwap(uint256 rawPct) external {
        uint256 bal = usdt.balanceOf(address(vault));
        if (bal < 500e6) return;
        uint256 pct = bound(rawPct, 1, 20); // strictly inside 25% cap
        uint256 amountIn = (bal * pct) / 100;
        if (amountIn == 0) return;

        bool wasBlocked = vault.paused() || vault.circuitBreakerTripped();

        // Refresh TWAP mark via authorized keeper if near expiry
        vm.prank(keeper);
        try vault.syncPriceFromV3Pool(address(whsk)) {} catch {}

        try vault.quoteOracleMinAmountOut(address(usdt), address(whsk), 500, amountIn, 50) returns (
            uint256 fairOut,
            uint256 minOut
        ) {
            HorizonGuardVault.TradeIntent memory intent = HorizonGuardVault.TradeIntent({
                router: address(router),
                tokenIn: address(usdt),
                tokenOut: address(whsk),
                fee: 500,
                amountIn: amountIn,
                minAmountOut: minOut,
                expectedAmountOut: fairOut,
                maxSlippageBps: 50,
                deadline: block.timestamp + 300,
                nonce: vault.nonces(agent),
                strategyTag: keccak256("INVARIANT_SWAP_BUY"),
                signalHash: keccak256(abi.encodePacked(block.timestamp, amountIn))
            });
            bytes memory sig = _signIntent(AGENT_PK, intent);
            try vault.executeGuardedSwap(intent, sig) {
                ghostSuccessfulSwaps += 1;
                if (wasBlocked) {
                    ghostBypassWhilePausedOrTripped += 1;
                }
            } catch {}
        } catch {}
    }

    function handler_executeValidWhskToUsdtSwap(uint256 rawPct) external {
        uint256 bal = whsk.balanceOf(address(vault));
        if (bal < 5_000e18) return;
        uint256 pct = bound(rawPct, 1, 20);
        uint256 amountIn = (bal * pct) / 100;
        if (amountIn == 0) return;

        bool wasBlocked = vault.paused() || vault.circuitBreakerTripped();

        vm.prank(keeper);
        try vault.syncPriceFromV3Pool(address(whsk)) {} catch {}

        try vault.quoteOracleMinAmountOut(address(whsk), address(usdt), 500, amountIn, 50) returns (
            uint256 fairOut,
            uint256 minOut
        ) {
            HorizonGuardVault.TradeIntent memory intent = HorizonGuardVault.TradeIntent({
                router: address(router),
                tokenIn: address(whsk),
                tokenOut: address(usdt),
                fee: 500,
                amountIn: amountIn,
                minAmountOut: minOut,
                expectedAmountOut: fairOut,
                maxSlippageBps: 50,
                deadline: block.timestamp + 300,
                nonce: vault.nonces(agent),
                strategyTag: keccak256("INVARIANT_SWAP_SELL"),
                signalHash: keccak256(abi.encodePacked(block.timestamp, amountIn))
            });
            bytes memory sig = _signIntent(AGENT_PK, intent);
            try vault.executeGuardedSwap(intent, sig) {
                ghostSuccessfulSwaps += 1;
                if (wasBlocked) {
                    ghostBypassWhilePausedOrTripped += 1;
                }
            } catch {}
        } catch {}
    }

    function handler_attemptAdversarialOneWeiSwap(uint256 rawAmount) external {
        uint256 bal = usdt.balanceOf(address(vault));
        if (bal < 200e6) return;
        uint256 amountIn = bound(rawAmount, 100e6, bal / 5);

        HorizonGuardVault.TradeIntent memory malicious = HorizonGuardVault.TradeIntent({
            router: address(router),
            tokenIn: address(usdt),
            tokenOut: address(whsk),
            fee: 500,
            amountIn: amountIn,
            minAmountOut: 1,
            expectedAmountOut: 1,
            maxSlippageBps: 50,
            deadline: block.timestamp + 300,
            nonce: vault.nonces(agent),
            strategyTag: keccak256("ADVERSARIAL_1_WEI"),
            signalHash: keccak256("ATTACK")
        });
        bytes memory sig = _signIntent(AGENT_PK, malicious);
        try vault.executeGuardedSwap(malicious, sig) {
            ghostAdversarialSwapsSucceeded += 1;
        } catch {}
    }

    function handler_attemptOversizedOrHighSlippageSwap(uint256 rawPct, uint16 rawSlip) external {
        uint256 bal = usdt.balanceOf(address(vault));
        if (bal < 500e6) return;

        vm.prank(keeper);
        try vault.syncPriceFromV3Pool(address(whsk)) {} catch {}

        // Case A: Position size > 25% cap (26% - 80%)
        uint256 overPct = bound(rawPct, 26, 80);
        uint256 overAmountIn = (bal * overPct) / 100;
        try vault.quoteOracleMinAmountOut(address(usdt), address(whsk), 500, overAmountIn, 50) returns (
            uint256 fairOut,
            uint256 minOut
        ) {
            HorizonGuardVault.TradeIntent memory oversized = HorizonGuardVault.TradeIntent({
                router: address(router),
                tokenIn: address(usdt),
                tokenOut: address(whsk),
                fee: 500,
                amountIn: overAmountIn,
                minAmountOut: minOut,
                expectedAmountOut: fairOut,
                maxSlippageBps: 50,
                deadline: block.timestamp + 300,
                nonce: vault.nonces(agent),
                strategyTag: keccak256("ADV_OVERSIZED"),
                signalHash: keccak256(abi.encodePacked("OVER", overAmountIn))
            });
            try vault.executeGuardedSwap(oversized, _signIntent(AGENT_PK, oversized)) {
                ghostCapBypassSucceeded += 1;
            } catch {}
        } catch {}

        // Case B: Slippage cap > 50 bps (51 - 500 bps)
        uint16 excessiveSlip = uint16(bound(rawSlip, 51, 500));
        uint256 safeAmt = bal / 10;
        HorizonGuardVault.TradeIntent memory highSlip = HorizonGuardVault.TradeIntent({
            router: address(router),
            tokenIn: address(usdt),
            tokenOut: address(whsk),
            fee: 500,
            amountIn: safeAmt,
            minAmountOut: 1e18,
            expectedAmountOut: 1e18,
            maxSlippageBps: excessiveSlip,
            deadline: block.timestamp + 300,
            nonce: vault.nonces(agent),
            strategyTag: keccak256("ADV_HIGH_SLIP"),
            signalHash: keccak256(abi.encodePacked("SLIP", excessiveSlip))
        });
        try vault.executeGuardedSwap(highSlip, _signIntent(AGENT_PK, highSlip)) {
            ghostCapBypassSucceeded += 1;
        } catch {}
    }

    function handler_attemptStaleOrZeroOracleSwap() external {
        // 1. Zero pool price / locked pool sync must always fail
        pool.setSqrtPriceX96(0, PARITY_TICK);
        vm.prank(keeper);
        try vault.syncPriceFromV3Pool(address(whsk)) {
            ghostStaleOrZeroOracleSucceeded += 1;
        } catch {}
        pool.setSqrtPriceX96(PARITY_SQRT_PRICE_X96, PARITY_TICK);

        pool.setUnlocked(false);
        vm.prank(keeper);
        try vault.syncPriceFromV3Pool(address(whsk)) {
            ghostStaleOrZeroOracleSucceeded += 1;
        } catch {}
        pool.setUnlocked(true);

        // 2. If oracle is currently stale (> 3600s), executing a valid swap without syncing must fail
        uint64 updatedAt = vault.lastPriceUpdatedAt(address(whsk));
        uint256 bal = usdt.balanceOf(address(vault));
        if (block.timestamp > uint256(updatedAt) + 3_600 && bal >= 500e6) {
            uint256 amt = bal / 10;
            HorizonGuardVault.TradeIntent memory staleIntent = HorizonGuardVault.TradeIntent({
                router: address(router),
                tokenIn: address(usdt),
                tokenOut: address(whsk),
                fee: 500,
                amountIn: amt,
                minAmountOut: amt * 9 * 1e12,
                expectedAmountOut: amt * 10 * 1e12,
                maxSlippageBps: 50,
                deadline: block.timestamp + 300,
                nonce: vault.nonces(agent),
                strategyTag: keccak256("ADV_STALE_ORACLE"),
                signalHash: keccak256("STALE")
            });
            try vault.executeGuardedSwap(staleIntent, _signIntent(AGENT_PK, staleIntent)) {
                ghostStaleOrZeroOracleSucceeded += 1;
            } catch {}
        }
    }

    function handler_attemptDrawdownShockAndBypass(uint256 rawShockPrice) external {
        uint256 whskBal = whsk.balanceOf(address(vault));
        uint256 usdtBal = usdt.balanceOf(address(vault));
        if (whskBal < 10_000e18 || usdtBal < 500e6) return;

        // Apply a shock price low enough to breach 300 bps drawdown if WHSK weight is meaningful
        uint256 shockPrice = bound(rawShockPrice, 0.04e18, 0.085e18);
        uint256 prevPrice = vault.referencePriceE18(address(whsk));

        vm.prank(owner);
        vault.setReferencePrice(address(whsk), shockPrice);

        uint256 ddBps = vault.currentDailyDrawdownBps();
        if (ddBps >= 300) {
            // Attempt swap during drawdown breach (both pre-latch and post-latch)
            uint256 amt = usdtBal / 10;
            HorizonGuardVault.TradeIntent memory intent = HorizonGuardVault.TradeIntent({
                router: address(router),
                tokenIn: address(usdt),
                tokenOut: address(whsk),
                fee: 500,
                amountIn: amt,
                minAmountOut: amt * 10 * 1e12,
                expectedAmountOut: amt * 10 * 1e12,
                maxSlippageBps: 50,
                deadline: block.timestamp + 300,
                nonce: vault.nonces(agent),
                strategyTag: keccak256("ADV_DRAWDOWN_BYPASS"),
                signalHash: keccak256(abi.encodePacked("DD", ddBps))
            });
            try vault.executeGuardedSwap(intent, _signIntent(AGENT_PK, intent)) {
                ghostBypassWhilePausedOrTripped += 1;
            } catch {}

            vault.checkAndTripCircuitBreaker();

            try vault.executeGuardedSwap(intent, _signIntent(AGENT_PK, intent)) {
                ghostBypassWhilePausedOrTripped += 1;
            } catch {}
        }

        // Restore parity reference price (breaker remains latched if tripped until owner reset)
        vm.prank(owner);
        vault.setReferencePrice(address(whsk), prevPrice > 0 ? prevPrice : 0.10e18);
    }

    function handler_attemptUnauthorizedKeeperAndWithdraw(uint256 rawAmt, uint8 actorSeed) external {
        uint256 amt = bound(rawAmt, 1, 1_000e6);
        vm.prank(attacker);
        try vault.syncPriceFromV3Pool(address(whsk)) {
            ghostUnauthorizedSyncsSucceeded += 1;
        } catch {}

        vm.prank(agent);
        try vault.withdraw(address(usdt), amt, agent) {
            ghostUnauthorizedWithdrawsSucceeded += 1;
        } catch {}

        vm.prank(attacker);
        try vault.withdraw(address(usdt), amt, attacker) {
            ghostUnauthorizedWithdrawsSucceeded += 1;
        } catch {}

        // Role escalation probes across attacker, agent, and keeper
        address actor = actorSeed % 3 == 0 ? attacker : (actorSeed % 3 == 1 ? agent : keeper);
        vm.startPrank(actor);
        try vault.setPaused(true) {
            ghostRoleEscalationSucceeded += 1;
        } catch {}
        try vault.resetCircuitBreaker() {
            ghostRoleEscalationSucceeded += 1;
        } catch {}
        try vault.setPriceKeeper(attacker, true) {
            ghostRoleEscalationSucceeded += 1;
        } catch {}
        try vault.transferOwnership(actor) {
            ghostRoleEscalationSucceeded += 1;
        } catch {}
        try vault.emergencyWithdraw(address(usdt), actor) {
            ghostRoleEscalationSucceeded += 1;
        } catch {}
        try vault.registerToken(address(usdt), 18, 2e18) {
            ghostRoleEscalationSucceeded += 1;
        } catch {}
        vm.stopPrank();
    }

    function handler_togglePauseAndTestBlock(bool shouldPause) external {
        vm.prank(owner);
        vault.setPaused(shouldPause);

        if (shouldPause) {
            uint256 bal = usdt.balanceOf(address(vault));
            if (bal >= 500e6) {
                uint256 amt = bal / 10;
                HorizonGuardVault.TradeIntent memory intent = HorizonGuardVault.TradeIntent({
                    router: address(router),
                    tokenIn: address(usdt),
                    tokenOut: address(whsk),
                    fee: 500,
                    amountIn: amt,
                    minAmountOut: amt * 9 * 1e12,
                    expectedAmountOut: amt * 10 * 1e12,
                    maxSlippageBps: 50,
                    deadline: block.timestamp + 300,
                    nonce: vault.nonces(agent),
                    strategyTag: keccak256("ADV_PAUSED_SWAP"),
                    signalHash: keccak256("PAUSED")
                });
                try vault.executeGuardedSwap(intent, _signIntent(AGENT_PK, intent)) {
                    ghostBypassWhilePausedOrTripped += 1;
                } catch {}
            }
        }
    }

    function handler_warpTime(uint256 rawSec) external {
        uint256 delta = bound(rawSec, 15, 7_200);
        // Stay within the 30-day test session window
        if (block.timestamp + delta < 1_766_500_000) {
            vm.warp(block.timestamp + delta);
        }
    }

    function handler_checkOrResetBreaker(bool shouldReset) external {
        if (shouldReset && vault.circuitBreakerTripped()) {
            vm.prank(owner);
            vault.resetCircuitBreaker();
        } else {
            vault.checkAndTripCircuitBreaker();
        }
    }
}

/// @title HorizonGuardVaultInvariantTest
/// @notice Foundry stateful invariant fuzzing suite (`256 runs x 32 depth = 8,192 calls/invariant`).
contract HorizonGuardVaultInvariantTest is TestBase {
    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant AGENT_PK = 0xB0B;
    uint256 internal constant KEEPER_PK = 0xC0DE;

    HorizonGuardVault internal vault;
    MockHSKSwapRouter internal router;
    MockV3Pool internal pool;
    MockERC20 internal usdt;
    MockERC20 internal whsk;
    HorizonVaultHandler internal handler;

    address internal owner;
    address internal agent;
    address internal keeper;

    function setUp() public {
        vm.chainId(177);
        vm.warp(1_764_000_000);

        owner = vm.addr(OWNER_PK);
        agent = vm.addr(AGENT_PK);
        keeper = vm.addr(KEEPER_PK);

        usdt = new MockERC20("Tether USD", "USDT", 6);
        whsk = new MockERC20("Wrapped HSK", "WHSK", 18);
        router = new MockHSKSwapRouter(address(0xD136e36610f35E0Cc3cAd40de858c151f2AA65D4), address(whsk));

        router.setRate(address(whsk), address(usdt), 1e5);
        router.setRate(address(usdt), address(whsk), 1e31);
        usdt.mint(address(router), 50_000_000e6);
        whsk.mint(address(router), 500_000_000e18);

        pool = new MockV3Pool(
            address(whsk),
            address(usdt),
            500,
            25054485400000000000000,
            -299_351,
            2_830_955_089_632
        );

        HorizonGuardVault.RiskPolicy memory initialPolicy = HorizonGuardVault.RiskPolicy({
            maxSlippageBps: 50,
            maxPositionBps: 2_500,
            dailyDrawdownCapBps: 300,
            minTradeIntervalSec: 60,
            maxDailyTrades: 24
        });

        vault = new HorizonGuardVault(owner, address(usdt), 6, initialPolicy);

        vm.startPrank(owner);
        vault.registerToken(address(whsk), 18, 0.10e18);
        vault.setAllowedRouter(address(router), true);
        vault.setAllowedPair(address(usdt), address(whsk), 500, true);
        vault.setAllowedPair(address(whsk), address(usdt), 500, true);
        vault.setOraclePool(address(whsk), address(pool), 300, 1_000, 3_600, 1_000_000_000_000);
        vault.setPriceKeeper(keeper, true);
        vault.setAgentSessionKey(agent, uint64(block.timestamp + 30 days), 250_000e18);

        usdt.mint(owner, 50_000e6);
        whsk.mint(owner, 200_000e18);
        usdt.approve(address(vault), type(uint256).max);
        whsk.approve(address(vault), type(uint256).max);
        vault.deposit(address(usdt), 50_000e6);
        vault.deposit(address(whsk), 200_000e18);
        vm.stopPrank();

        handler = new HorizonVaultHandler(vault, router, pool, usdt, whsk);
        targetContract(address(handler));
    }

    function invariant_ZeroResidualRouterAllowance() public view {
        assertEq(usdt.allowance(address(vault), address(router)), 0, "USDT router allowance must always be 0");
        assertEq(whsk.allowance(address(vault), address(router)), 0, "WHSK router allowance must always be 0");
    }

    function invariant_AgentNeverOwnsOrExtractsCustody() public view {
        assertEq(vault.owner(), owner, "owner must remain cold owner");
        assertTrue(agent != vault.owner(), "agent must never equal owner");
        assertEq(usdt.balanceOf(agent), 0, "agent must never hold extracted USDT");
        assertEq(whsk.balanceOf(agent), 0, "agent must never hold extracted WHSK");
        assertEq(usdt.balanceOf(handler.attacker()), 0, "attacker must never hold extracted USDT");
        assertEq(whsk.balanceOf(handler.attacker()), 0, "attacker must never hold extracted WHSK");
    }

    function invariant_SessionVolumeNonceAndAuditLogMonotonic() public view {
        (, , uint128 maxVol, uint128 usedVol,) = vault.session();
        assertLe(usedVol, maxVol, "cumulative session volume must never exceed cap");
        assertEq(vault.nonces(agent), handler.ghostSuccessfulSwaps(), "agent nonce must equal successful swaps");
        assertEq(vault.getExecutionCount(), handler.ghostSuccessfulSwaps(), "audit log length must equal successful swaps");
    }

    function invariant_AdversarialAttacksNeverSucceed() public view {
        assertEq(handler.ghostAdversarialSwapsSucceeded(), 0, "1-wei adversarial swap must never succeed");
        assertEq(handler.ghostUnauthorizedSyncsSucceeded(), 0, "unauthorized oracle sync must never succeed");
        assertEq(handler.ghostUnauthorizedWithdrawsSucceeded(), 0, "unauthorized withdraw must never succeed");
    }

    function invariant_PolicyAlwaysWithinProtocolHardCeilings() public view {
        (uint16 maxSlip, uint16 maxPos, uint16 ddCap, uint32 cooldown, uint32 maxTrades) = vault.policy();
        assertLe(maxSlip, vault.HARD_MAX_SLIPPAGE_BPS(), "slippage exceeds hard protocol ceiling");
        assertLe(maxPos, vault.HARD_MAX_POSITION_BPS(), "position exceeds 100%");
        assertLe(ddCap, vault.HARD_MAX_DRAWDOWN_BPS(), "drawdown exceeds hard protocol ceiling");
        assertGe(cooldown, vault.MIN_TRADE_INTERVAL_SEC(), "cooldown below hard floor");
        assertGt(maxTrades, 0, "maxDailyTrades must be positive");
    }

    function invariant_CircuitBreakerAndEmergencyPauseNeverBypassed() public view {
        assertEq(
            handler.ghostBypassWhilePausedOrTripped(),
            0,
            "swaps must never bypass emergency pause or drawdown circuit breaker"
        );
        (uint16 maxSlip, , , ,) = vault.policy();
        uint256 execCount = vault.getExecutionCount();
        for (uint256 i = 0; i < execCount; ++i) {
            HorizonGuardVault.ExecutionRecord memory rec = vault.getExecution(i);
            assertLe(rec.realizedSlippageBps, maxSlip, "recorded swap slippage exceeded policy ceiling");
        }
    }

    function invariant_PerTradeNotionalSlippageAndOracleGuardsHold() public view {
        assertEq(handler.ghostCapBypassSucceeded(), 0, "position cap or slippage cap must never be bypassed");
        assertEq(handler.ghostStaleOrZeroOracleSucceeded(), 0, "stale, locked, or zero oracle must never pass");
        (, , , , uint32 maxTrades) = vault.policy();
        assertLe(vault.dailyTradeCount(), maxTrades, "daily trade count must never exceed policy cap");
    }

    function invariant_RoleEscalationBlockedAndQuoteTokenPinned() public view {
        assertEq(handler.ghostRoleEscalationSucceeded(), 0, "non-owner role escalation must never succeed");
        assertEq(vault.pendingOwner(), address(0), "pendingOwner must never be hijacked");
        assertEq(vault.referencePriceE18(address(usdt)), 1e18, "quoteToken reference price must stay pinned at 1e18");
    }
}
