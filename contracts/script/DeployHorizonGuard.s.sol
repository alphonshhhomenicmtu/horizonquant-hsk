// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TestBase} from "../test/utils/TestBase.sol";
import {HorizonGuardVault} from "../src/HorizonGuardVault.sol";

/// @title DeployHorizonGuard
/// @notice Foundry deployment script for HorizonGuardVault on HashKey Chain Mainnet (chainId 177).
/// @dev Usage:
///      DEPLOYER_PRIVATE_KEY=0x... AGENT_ADDRESS=0x... forge script script/DeployHorizonGuard.s.sol \
///        --rpc-url https://mainnet.hsk.xyz --broadcast
contract DeployHorizonGuard is TestBase {
    // Official verified HashKey Chain Mainnet (chainId 177) addresses
    address internal constant HSK_SWAP_ROUTER = 0x1f3858C46F8F6fE76260b8208995D228C5cddc64;
    address internal constant WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1;
    address internal constant USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029;
    address internal constant WETH = 0xefd4bC9afD210517803f293ABABd701CaeeCdfd0;
    address internal constant WBTC = 0x6119ca49a79f5825c8b345f8d7ac36b272565b14;
    address internal constant WHSK_USDT_POOL_500 = 0xEB33d6666dd2359cB1BF6Ea6D72286Cc1b4a778A;

    function run() external returns (HorizonGuardVault vault) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(deployerPk);
        address agentSigner = vm.envAddress("AGENT_ADDRESS");

        HorizonGuardVault.RiskPolicy memory initialPolicy = HorizonGuardVault.RiskPolicy({
            maxSlippageBps: 50, // 0.50% hard cap
            maxPositionBps: 2_500, // 25.00% max single-trade share
            dailyDrawdownCapBps: 300, // 3.00% daily drawdown circuit breaker
            minTradeIntervalSec: 300, // 5-minute cooldown
            maxDailyTrades: 24 // 24 swaps / UTC day
        });

        vm.startBroadcast(deployerPk);

        vault = new HorizonGuardVault(owner, USDT, 6, initialPolicy);

        // Register canonical HSK Chain tokens and allowlist official HSKSwap V3 SwapRouter & pairs
        vault.registerToken(WHSK, 18, 0.10e18);
        vault.registerToken(WETH, 18, 3_200e18);
        vault.registerToken(WBTC, 8, 95_000e18);

        vault.setAllowedRouter(HSK_SWAP_ROUTER, true);
        vault.setAllowedPair(USDT, WHSK, 500, true);
        vault.setAllowedPair(WHSK, USDT, 500, true);
        vault.setAllowedPair(USDT, WHSK, 3000, true);
        vault.setAllowedPair(WHSK, USDT, 3000, true);
        vault.setAllowedPair(USDT, WETH, 500, true);
        vault.setAllowedPair(WETH, USDT, 500, true);
        vault.setAllowedPair(USDT, WBTC, 3000, true);
        vault.setAllowedPair(WBTC, USDT, 3000, true);

        // Sync live WHSK mark price directly from on-chain HSKSwap V3 pool if on Mainnet (chainId 177)
        if (block.chainid == 177) {
            vault.syncPriceFromV3Pool(WHSK, WHSK_USDT_POOL_500);
        }

        // Authorize scoped 30-day agent session key with $100k cumulative notional budget
        vault.setAgentSessionKey(agentSigner, uint64(block.timestamp + 30 days), 100_000e18);

        vm.stopBroadcast();
    }
}
