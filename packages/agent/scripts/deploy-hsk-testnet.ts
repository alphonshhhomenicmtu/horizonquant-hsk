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
import { HASHKEY_TESTNET } from "../src/config/networks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../contracts/out");

const hskTestnetChain = defineChain({
  id: HASHKEY_TESTNET.chainId,
  name: HASHKEY_TESTNET.name,
  nativeCurrency: HASHKEY_TESTNET.nativeCurrency,
  rpcUrls: {
    default: { http: HASHKEY_TESTNET.rpcUrls },
  },
  blockExplorers: {
    default: { name: "HSK Testnet Explorer", url: HASHKEY_TESTNET.explorerUrl },
  },
});

interface ForgeArtifact {
  abi: Abi;
  bytecode: { object: Hex };
}

function loadArtifact(relPath: string): ForgeArtifact {
  const full = path.join(OUT_DIR, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Compiled artifact missing at ${full}. Run 'forge build' inside contracts/ first.`);
  }
  return JSON.parse(fs.readFileSync(full, "utf-8")) as ForgeArtifact;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run") || !process.env.DEPLOYER_PRIVATE_KEY;
  const rpcUrl = process.env.HSK_TESTNET_RPC_URL ?? HASHKEY_TESTNET.rpcUrls[0];

  const vaultArtifact = loadArtifact("HorizonGuardVault.sol/HorizonGuardVault.json");
  const routerArtifact = loadArtifact("MockHSKSwapRouter.sol/MockHSKSwapRouter.json");
  const tokenArtifact = loadArtifact("MockERC20.sol/MockERC20.json");

  const publicClient = createPublicClient({
    chain: hskTestnetChain,
    transport: http(rpcUrl, {
      fetchOptions: { headers: { "User-Agent": "HorizonQuant-Deployer/1.0" } },
    }),
  });

  const [chainId, blockNumber, gasPrice] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
    publicClient.getGasPrice(),
  ]);

  if (chainId !== HASHKEY_TESTNET.chainId) {
    throw new Error(`Expected HashKey Chain Testnet (${HASHKEY_TESTNET.chainId}), got ${chainId}`);
  }

  const estimatedCostWei = 5_000_000n * gasPrice;

  console.log("=== HorizonQuant Agent — HashKey Chain Testnet (133) Sandbox Deployment ===");
  console.log(`RPC Endpoint      : ${rpcUrl}`);
  console.log(`Verified Chain ID : ${chainId} (Block #${blockNumber})`);
  console.log(`Live Gas Price    : ${(Number(gasPrice) / 1e9).toFixed(3)} gwei`);
  console.log(`Est. Sandbox Cost : ${formatEther(estimatedCostWei)} testnet HSK`);
  console.log(`Vault Bytecode    : ${(vaultArtifact.bytecode.object.length - 2) / 2} bytes`);
  console.log(`MockRouter Size   : ${(routerArtifact.bytecode.object.length - 2) / 2} bytes`);

  if (dryRun) {
    console.log("\n[DRY-RUN COMPLETE] Set DEPLOYER_PRIVATE_KEY with testnet HSK to deploy full sandbox (MockUSDT + MockWHSK + MockHSKSwapRouter + HorizonGuardVault).");
    return;
  }

  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex;
  const account = privateKeyToAccount(pk);
  const agentAddress = (process.env.AGENT_ADDRESS ?? account.address) as Address;

  const walletClient = createWalletClient({
    account,
    chain: hskTestnetChain,
    transport: http(rpcUrl, {
      fetchOptions: { headers: { "User-Agent": "HorizonQuant-Deployer/1.0" } },
    }),
  });

  const deploy = async (artifact: ForgeArtifact, args: unknown[], label: string): Promise<Address> => {
    const hash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`${label} missing contractAddress`);
    console.log(`   Deployed ${label}: ${receipt.contractAddress}`);
    return receipt.contractAddress;
  };

  const mockUsdt = await deploy(tokenArtifact, ["Tether USD (Test)", "USDT", 6], "MockUSDT");
  const mockWhsk = await deploy(tokenArtifact, ["Wrapped HSK (Test)", "WHSK", 18], "MockWHSK");
  const mockRouter = await deploy(routerArtifact, [account.address, mockWhsk], "MockHSKSwapRouter");

  const vault = await deploy(
    vaultArtifact,
    [
      account.address,
      mockUsdt,
      6,
      {
        maxSlippageBps: 50,
        maxPositionBps: 2500,
        dailyDrawdownCapBps: 300,
        minTradeIntervalSec: 60,
        maxDailyTrades: 24,
      },
    ],
    "HorizonGuardVault",
  );

  // Wire rates, liquidity, allowlists, and session key
  const writes: Array<{ to: Address; abi: Abi; fn: string; args: unknown[] }> = [
    { to: mockRouter, abi: routerArtifact.abi, fn: "setRate", args: [mockWhsk, mockUsdt, 100_000n] },
    { to: mockRouter, abi: routerArtifact.abi, fn: "setRate", args: [mockUsdt, mockWhsk, 10n ** 31n] },
    { to: mockUsdt, abi: tokenArtifact.abi, fn: "mint", args: [mockRouter, 1_000_000n * 10n ** 6n] },
    { to: mockWhsk, abi: tokenArtifact.abi, fn: "mint", args: [mockRouter, 10_000_000n * 10n ** 18n] },
    { to: vault, abi: vaultArtifact.abi, fn: "registerToken", args: [mockWhsk, 18, 100_000_000_000_000_000n] },
    { to: vault, abi: vaultArtifact.abi, fn: "setAllowedRouter", args: [mockRouter, true] },
    { to: vault, abi: vaultArtifact.abi, fn: "setAllowedPair", args: [mockUsdt, mockWhsk, 500, true] },
    { to: vault, abi: vaultArtifact.abi, fn: "setAllowedPair", args: [mockWhsk, mockUsdt, 500, true] },
    {
      to: vault,
      abi: vaultArtifact.abi,
      fn: "setAgentSessionKey",
      args: [agentAddress, BigInt(Math.floor(Date.now() / 1000) + 30 * 86400), 100_000n * 10n ** 18n],
    },
  ];

  for (const w of writes) {
    const hash = await walletClient.writeContract({
      address: w.to,
      abi: w.abi,
      functionName: w.fn,
      args: w.args,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  console.log(`\n=== Testnet Sandbox Ready (${HASHKEY_TESTNET.explorerUrl}/address/${vault}) ===`);
}

main().catch((err) => {
  console.error("[Testnet Deploy Error]", err instanceof Error ? err.message : err);
  process.exit(1);
});
