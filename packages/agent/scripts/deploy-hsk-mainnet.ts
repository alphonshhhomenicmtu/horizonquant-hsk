import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HASHKEY_MAINNET } from "../src/config/networks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = path.resolve(
  __dirname,
  "../../../contracts/out/HorizonGuardVault.sol/HorizonGuardVault.json",
);

const hskMainnetChain = defineChain({
  id: HASHKEY_MAINNET.chainId,
  name: HASHKEY_MAINNET.name,
  nativeCurrency: HASHKEY_MAINNET.nativeCurrency,
  rpcUrls: {
    default: { http: HASHKEY_MAINNET.rpcUrls },
  },
  blockExplorers: {
    default: { name: "HashKey Blockscout", url: HASHKEY_MAINNET.explorerUrl },
  },
});

interface ForgeArtifact {
  abi: Abi;
  bytecode: { object: Hex };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run") || !process.env.DEPLOYER_PRIVATE_KEY;
  const rpcUrl = process.env.HSK_MAINNET_RPC_URL ?? HASHKEY_MAINNET.rpcUrls[0];

  if (!fs.existsSync(ARTIFACT_PATH)) {
    throw new Error(
      `Compiled Foundry artifact missing at ${ARTIFACT_PATH}. Run 'forge build' inside contracts/ first.`,
    );
  }

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf-8")) as ForgeArtifact;
  const publicClient = createPublicClient({
    chain: hskMainnetChain,
    transport: http(rpcUrl, {
      fetchOptions: { headers: { "User-Agent": "HorizonQuant-Deployer/1.0" } },
    }),
  });

  const [chainId, blockNumber, gasPrice] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
    publicClient.getGasPrice(),
  ]);

  if (chainId !== HASHKEY_MAINNET.chainId) {
    throw new Error(`Expected HashKey Chain Mainnet (${HASHKEY_MAINNET.chainId}), got ${chainId}`);
  }

  const initialPolicy = {
    maxSlippageBps: 50,
    maxPositionBps: 2500,
    dailyDrawdownCapBps: 300,
    minTradeIntervalSec: 300,
    maxDailyTrades: 24,
  };

  // Approximate gas budget: deploy (~3.1M) + 9 configuration txs (~0.7M) = ~3.8M gas
  const estimatedGasUnits = 3_800_000n;
  const estimatedCostWei = estimatedGasUnits * gasPrice;

  console.log("=== HorizonQuant Agent — HashKey Chain Mainnet (177) Deployment ===");
  console.log(`RPC Endpoint      : ${rpcUrl}`);
  console.log(`Verified Chain ID : ${chainId} (Block #${blockNumber})`);
  console.log(`Live Gas Price    : ${(Number(gasPrice) / 1e9).toFixed(3)} gwei`);
  console.log(`Est. Deploy Budget: ${formatEther(estimatedCostWei)} HSK (~3-5 HSK recommended)`);
  console.log(`HSKSwap Router    : ${HASHKEY_MAINNET.hskSwapRouter}`);
  console.log(`Quote Token (USDT): ${HASHKEY_MAINNET.tokens.USDT.address}`);
  console.log(`WHSK Token        : ${HASHKEY_MAINNET.tokens.WHSK.address}`);
  console.log(`Bytecode Size     : ${(artifact.bytecode.object.length - 2) / 2} bytes`);

  if (dryRun) {
    console.log("\n[DRY-RUN COMPLETE] Set DEPLOYER_PRIVATE_KEY and AGENT_ADDRESS with ~3-5 HSK gas to broadcast.");
    console.log(
      "Command: DEPLOYER_PRIVATE_KEY=0x... AGENT_ADDRESS=0x... npm run deploy:mainnet",
    );
    return;
  }

  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex;
  const account = privateKeyToAccount(pk);
  const agentAddress = (process.env.AGENT_ADDRESS ?? account.address) as Address;

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`\nDeployer Address  : ${account.address}`);
  console.log(`Deployer Balance  : ${formatEther(balance)} HSK`);
  if (balance < estimatedCostWei) {
    throw new Error(
      `Insufficient HSK balance (${formatEther(balance)} HSK < estimated ${formatEther(estimatedCostWei)} HSK). Fund deployer with ~3-5 HSK.`,
    );
  }

  const walletClient = createWalletClient({
    account,
    chain: hskMainnetChain,
    transport: http(rpcUrl, {
      fetchOptions: { headers: { "User-Agent": "HorizonQuant-Deployer/1.0" } },
    }),
  });

  console.log("\n1. Deploying HorizonGuardVault...");
  const deployHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [account.address, HASHKEY_MAINNET.tokens.USDT.address, 6, initialPolicy],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const vaultAddress = receipt.contractAddress;
  if (!vaultAddress) throw new Error("Deployment receipt missing contractAddress");

  console.log(`   Deployed HorizonGuardVault: ${vaultAddress}`);
  console.log(`   Explorer: ${HASHKEY_MAINNET.explorerUrl}/address/${vaultAddress}`);

  console.log("2. Registering canonical tokens & allowlisting HSKSwap V3 SwapRouter...");
  const configCalls: Array<{ fn: string; args: unknown[] }> = [
    { fn: "registerToken", args: [HASHKEY_MAINNET.tokens.WHSK.address, 18, 100_000_000_000_000_000n] },
    { fn: "registerToken", args: [HASHKEY_MAINNET.tokens.WETH.address, 18, 3_240_000_000_000_000_000_000n] },
    { fn: "registerToken", args: [HASHKEY_MAINNET.tokens.WBTC.address, 8, 96_400_000_000_000_000_000_000n] },
    { fn: "setAllowedRouter", args: [HASHKEY_MAINNET.hskSwapRouter, true] },
    { fn: "setAllowedPair", args: [HASHKEY_MAINNET.tokens.USDT.address, HASHKEY_MAINNET.tokens.WHSK.address, 500, true] },
    { fn: "setAllowedPair", args: [HASHKEY_MAINNET.tokens.WHSK.address, HASHKEY_MAINNET.tokens.USDT.address, 500, true] },
    { fn: "setAllowedPair", args: [HASHKEY_MAINNET.tokens.USDT.address, HASHKEY_MAINNET.tokens.WHSK.address, 3000, true] },
    { fn: "setAllowedPair", args: [HASHKEY_MAINNET.tokens.WHSK.address, HASHKEY_MAINNET.tokens.USDT.address, 3000, true] },
    { fn: "syncPriceFromV3Pool", args: [HASHKEY_MAINNET.tokens.WHSK.address, HASHKEY_MAINNET.pools[0].address] },
    {
      fn: "setAgentSessionKey",
      args: [agentAddress, BigInt(Math.floor(Date.now() / 1000) + 30 * 86400), 100_000n * 10n ** 18n],
    },
  ];

  for (const call of configCalls) {
    const hash = await walletClient.writeContract({
      address: vaultAddress,
      abi: artifact.abi,
      functionName: call.fn,
      args: call.args,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`   Confirmed ${call.fn}: ${hash}`);
  }

  console.log("\n=== Mainnet Deployment Verified ===");
  console.log(`HorizonGuardVault: ${HASHKEY_MAINNET.explorerUrl}/address/${vaultAddress}`);
}

main().catch((err) => {
  console.error("[Deploy Error]", err instanceof Error ? err.message : err);
  process.exit(1);
});
