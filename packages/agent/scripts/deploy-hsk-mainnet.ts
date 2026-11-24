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
const DEPLOY_OUTPUT_PATH = path.resolve(__dirname, "../../../deployments/mainnet-177.json");

const POOL_CARDINALITY_ABI = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "increaseObservationCardinalityNext",
    stateMutability: "nonpayable",
    inputs: [{ name: "observationCardinalityNext", type: "uint16" }],
    outputs: [],
  },
] as const;

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
  deployedBytecode?: { object: Hex };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run") || !process.env.DEPLOYER_PRIVATE_KEY;
  const rpcUrl = process.env.HSK_MAINNET_RPC_URL ?? HASHKEY_MAINNET.rpcUrls[0];
  const sessionBudgetUsd = BigInt(process.env.SESSION_BUDGET_USD ?? "1000");

  if (!fs.existsSync(ARTIFACT_PATH)) {
    throw new Error(
      `Compiled Foundry artifact missing at ${ARTIFACT_PATH}. Run 'forge build' inside contracts/ first.`,
    );
  }

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf-8")) as ForgeArtifact;
  const publicClient = createPublicClient({
    chain: hskMainnetChain,
    transport: http(rpcUrl, {
      fetchOptions: { headers: { "User-Agent": "HorizonQuant-Deployer/2.0" } },
    }),
  });

  const [chainId, blockNumber, gasPrice, deployerBal] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
    publicClient.getGasPrice(),
    publicClient.getBalance({ address: HASHKEY_MAINNET.deployerAddress }),
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

  // Approximate gas budget: deploy (~4.4M) + 10 config txs (~1.1M) = ~5.5M gas
  const estimatedGasUnits = 5_500_000n;
  const estimatedCostWei = estimatedGasUnits * gasPrice;
  const initBytes = (artifact.bytecode.object.length - 2) / 2;
  const runtimeBytes = artifact.deployedBytecode ? (artifact.deployedBytecode.object.length - 2) / 2 : 0;

  console.log("=== HorizonQuant Agent — HashKey Chain Mainnet (177) Deployment ===");
  console.log(`RPC Endpoint        : ${rpcUrl}`);
  console.log(`Verified Chain ID   : ${chainId} (Block #${blockNumber})`);
  console.log(`Live Gas Price      : ${(Number(gasPrice) / 1e9).toFixed(3)} gwei`);
  console.log(`Target Deployer EOA : ${HASHKEY_MAINNET.deployerAddress} (Balance: ${formatEther(deployerBal)} HSK)`);
  console.log(`Est. Deploy Budget  : ${formatEther(estimatedCostWei)} HSK (~3.0-5.0 HSK recommended)`);
  console.log(`HSKSwap Router      : ${HASHKEY_MAINNET.hskSwapRouter}`);
  console.log(`Live WHSK/USDT 0.05%: ${HASHKEY_MAINNET.pools[0].address} (TWAP Oracle)`);
  console.log(`Live WHSK/USDT 0.30%: ${HASHKEY_MAINNET.pools[1].address}`);
  console.log(`Session Budget Cap  : $${sessionBudgetUsd.toString()} USD`);
  console.log(`Bytecode Size       : init=${initBytes} B, runtime=${runtimeBytes} B (limit 24,576 B)`);

  if (dryRun) {
    console.log(
      "\n[DRY-RUN COMPLETE] Once ~3-5 HSK arrives on 0x57A46E4E5F538452E4D672EF9D48e3e90E10A81C, broadcast with:",
    );
    console.log("  DEPLOYER_PRIVATE_KEY=0x... AGENT_ADDRESS=0x<DISTINCT_SESSION_KEY> npm run deploy:mainnet");
    return;
  }

  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex;
  const account = privateKeyToAccount(pk);
  const agentAddress = process.env.AGENT_ADDRESS as Address | undefined;

  if (!agentAddress) {
    throw new Error(
      "AGENT_ADDRESS is required and must be a distinct ephemeral session key (never reuse the deployer owner key).",
    );
  }
  if (agentAddress.toLowerCase() === account.address.toLowerCase()) {
    throw new Error(
      "AGENT_ADDRESS cannot equal the deployer owner address (HorizonGuardVault enforces AgentCannotBeOwner).",
    );
  }

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`\nDeployer Address    : ${account.address}`);
  console.log(`Agent Session Key   : ${agentAddress}`);
  console.log(`Deployer Balance    : ${formatEther(balance)} HSK`);
  if (balance < estimatedCostWei) {
    throw new Error(
      `Insufficient HSK balance (${formatEther(balance)} HSK < estimated ${formatEther(estimatedCostWei)} HSK). Fund deployer with ~3-5 HSK.`,
    );
  }

  const walletClient = createWalletClient({
    account,
    chain: hskMainnetChain,
    transport: http(rpcUrl, {
      fetchOptions: { headers: { "User-Agent": "HorizonQuant-Deployer/2.0" } },
    }),
  });

  console.log("\n1. Deploying hardened HorizonGuardVault...");
  const deployHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [account.address, HASHKEY_MAINNET.tokens.USDT.address, 6, initialPolicy],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const vaultAddress = receipt.contractAddress;
  if (!vaultAddress) throw new Error("Deployment receipt missing contractAddress");

  console.log(`   Deployed HorizonGuardVault: ${vaultAddress}`);
  console.log(`   Deploy Tx: ${HASHKEY_MAINNET.explorerUrl}/tx/${deployHash}`);

  const pool500 = HASHKEY_MAINNET.pools[0].address;
  const slot0 = await publicClient.readContract({
    address: pool500,
    abi: POOL_CARDINALITY_ABI,
    functionName: "slot0",
  });
  const txHashes: Record<string, Hex> = { deploy: deployHash };

  if (Number(slot0[4]) < 16) {
    console.log("2. Expanding WHSK/USDT 0.05% pool TWAP observation cardinality to 16...");
    const cardHash = await walletClient.writeContract({
      address: pool500,
      abi: POOL_CARDINALITY_ABI,
      functionName: "increaseObservationCardinalityNext",
      args: [16],
    });
    await publicClient.waitForTransactionReceipt({ hash: cardHash });
    txHashes.increaseObservationCardinalityNext = cardHash;
    console.log(`   Confirmed cardinality growth: ${cardHash}`);
  }

  console.log("3. Configuring live WHSK/USDT pairs, pinned TWAP oracle, keeper, and scoped session key...");
  const configCalls: Array<{ label: string; fn: string; args: unknown[] }> = [
    { label: "registerWHSK", fn: "registerToken", args: [HASHKEY_MAINNET.tokens.WHSK.address, 18, 100_013_000_000_000_000n] },
    { label: "allowRouter", fn: "setAllowedRouter", args: [HASHKEY_MAINNET.hskSwapRouter, true] },
    { label: "allowUsdtWhsk500", fn: "setAllowedPair", args: [HASHKEY_MAINNET.tokens.USDT.address, HASHKEY_MAINNET.tokens.WHSK.address, 500, true] },
    { label: "allowWhskUsdt500", fn: "setAllowedPair", args: [HASHKEY_MAINNET.tokens.WHSK.address, HASHKEY_MAINNET.tokens.USDT.address, 500, true] },
    { label: "allowUsdtWhsk3000", fn: "setAllowedPair", args: [HASHKEY_MAINNET.tokens.USDT.address, HASHKEY_MAINNET.tokens.WHSK.address, 3000, true] },
    { label: "allowWhskUsdt3000", fn: "setAllowedPair", args: [HASHKEY_MAINNET.tokens.WHSK.address, HASHKEY_MAINNET.tokens.USDT.address, 3000, true] },
    {
      label: "pinTwapOracle",
      fn: "setOraclePool",
      args: [HASHKEY_MAINNET.tokens.WHSK.address, pool500, 300, 1000, 3600, 1_000_000_000_000n],
    },
    { label: "setKeeper", fn: "setPriceKeeper", args: [agentAddress, true] },
    { label: "syncInitialTwap", fn: "syncPriceFromV3Pool", args: [HASHKEY_MAINNET.tokens.WHSK.address] },
    {
      label: "setSessionKey",
      fn: "setAgentSessionKey",
      args: [agentAddress, BigInt(Math.floor(Date.now() / 1000) + 30 * 86400), sessionBudgetUsd * 10n ** 18n],
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
    txHashes[call.label] = hash;
    console.log(`   Confirmed ${call.label} (${call.fn}): ${hash}`);
  }

  fs.mkdirSync(path.dirname(DEPLOY_OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(
    DEPLOY_OUTPUT_PATH,
    JSON.stringify(
      {
        chainId,
        deployedAtIso: new Date().toISOString(),
        owner: account.address,
        agentSessionKey: agentAddress,
        vaultAddress,
        router: HASHKEY_MAINNET.hskSwapRouter,
        oraclePool: pool500,
        sessionBudgetUsd: sessionBudgetUsd.toString(),
        explorerUrl: `${HASHKEY_MAINNET.explorerUrl}/address/${vaultAddress}`,
        txHashes,
      },
      null,
      2,
    ),
  );

  console.log("\n=== Mainnet Deployment Verified ===");
  console.log(`Vault Explorer : ${HASHKEY_MAINNET.explorerUrl}/address/${vaultAddress}`);
  console.log(`Saved Manifest : ${DEPLOY_OUTPUT_PATH}`);
  console.log(`Live UI Link   : https://alphonshhhomenicmtu.github.io/horizonquant-hsk/?vault=${vaultAddress}`);
  console.log(
    `Blockscout Verify:\n  cd contracts && forge verify-contract ${vaultAddress} src/HorizonGuardVault.sol:HorizonGuardVault --verifier blockscout --verifier-url https://hsk.blockscout.com/api/ --chain-id 177`,
  );
}

main().catch((err) => {
  console.error("[Deploy Error]", err instanceof Error ? err.message : err);
  process.exit(1);
});
