// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TestBase} from "../test/utils/TestBase.sol";
import {HorizonGuardVault} from "../src/HorizonGuardVault.sol";
import {IUniswapV3PoolMinimal} from "../src/interfaces/ISwapRouter.sol";

/// @title DeployHorizonGuard
/// @notice Foundry deployment script for HorizonGuardVault on HashKey Chain Mainnet (chainId 177).
/// @dev Allowlists ONLY verified live HSKSwap V3 pools (WHSK/USDT 0.05% and 0.30%).
///      Requires AGENT_ADDRESS != deployer so custody and execution keys remain strictly separated.
contract DeployHorizonGuard is TestBase {
    // Official verified HashKey Chain Mainnet (chainId 177) addresses
    address internal constant HSK_SWAP_ROUTER = 0x1f3858C46F8F6fE76260b8208995D228C5cddc64;
    address internal constant WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1;
    address internal constant USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029;
    address internal constant WHSK_USDT_POOL_500 = 0xEB33d6666dd2359cB1BF6Ea6D72286Cc1b4a778A;

    function run() external returns (HorizonGuardVault vault) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(deployerPk);
        address agentSigner = vm.envAddress("AGENT_ADDRESS");
        require(agentSigner != address(0) && agentSigner != owner, "AGENT_MUST_DIFFER_FROM_OWNER");

        HorizonGuardVault.RiskPolicy memory initialPolicy = HorizonGuardVault.RiskPolicy({
            maxSlippageBps: 50, // 0.50% hard cap
            maxPositionBps: 2_500, // 25.00% max single-trade share
            dailyDrawdownCapBps: 300, // 3.00% daily drawdown circuit breaker
            minTradeIntervalSec: 300, // 5-minute cooldown
            maxDailyTrades: 24 // 24 swaps / UTC day
        });

        vm.startBroadcast(deployerPk);

        vault = new HorizonGuardVault(owner, USDT, 6, initialPolicy);

        // Register ONLY live HSKSwap V3 market assets (WHSK + quote USDT)
        vault.registerToken(WHSK, 18, 0.100013e18);

        vault.setAllowedRouter(HSK_SWAP_ROUTER, true);
        vault.setAllowedPair(USDT, WHSK, 500, true);
        vault.setAllowedPair(WHSK, USDT, 500, true);
        vault.setAllowedPair(USDT, WHSK, 3000, true);
        vault.setAllowedPair(WHSK, USDT, 3000, true);

        // Pin official 0.05% WHSK/USDT pool TWAP oracle (5-min window, 10% max deviation, 1h TTL, liquidity floor)
        if (block.chainid == 177) {
            IUniswapV3PoolMinimal(WHSK_USDT_POOL_500).increaseObservationCardinalityNext(16);
            vault.setOraclePool(WHSK, WHSK_USDT_POOL_500, 300, 1_000, 3_600, 1_000_000_000_000);
            vault.setPriceKeeper(agentSigner, true);
            vault.syncPriceFromV3Pool(WHSK);
        }

        // Authorize scoped 30-day agent session key with $1,000 initial mainnet demo cap
        vault.setAgentSessionKey(agentSigner, uint64(block.timestamp + 30 days), 1_000e18);

        vm.stopBroadcast();
    }
}
