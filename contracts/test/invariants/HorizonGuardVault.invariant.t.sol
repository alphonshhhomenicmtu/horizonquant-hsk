// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TestBase} from "../utils/TestBase.sol";
import {HorizonGuardVault} from "../../src/HorizonGuardVault.sol";
import {MockHSKSwapRouter, MockV3Pool} from "../../src/MockHSKSwapRouter.sol";
import {MockERC20} from "../../src/MockERC20.sol";

/// @title HorizonVaultHandler
/// @notice Bounded multi-actor stateful fuzzing handler exercising owner flows, valid swaps,
///         keeper TWAP syncs, time warps, and adversarial attacks against HorizonGuardVault.
contract HorizonVaultHandler is TestBase {
    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant AGENT_PK = 0xB0B;
    uint256 internal constant KEEPER_PK = 0xC0DE;
    uint256 internal constant ATTACKER_PK = 0xBAD;

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
                strategyTag: keccak256("INVARIANT_SWAP"),
                signalHash: keccak256(abi.encodePacked(block.timestamp, amountIn))
            });
            bytes memory sig = _signIntent(AGENT_PK, intent);
            try vault.executeGuardedSwap(intent, sig) {
                ghostSuccessfulSwaps += 1;
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

    function handler_attemptUnauthorizedKeeperAndWithdraw(uint256 rawAmt) external {
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
/// @notice Foundry stateful invariant fuzzing suite (`128 runs x 32 depth = 4,096 calls/invariant`).
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
}
