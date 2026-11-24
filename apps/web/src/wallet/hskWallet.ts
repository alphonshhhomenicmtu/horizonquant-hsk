import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import {
  buildVaultDomain,
  EIP712_TRADE_INTENT_TYPES,
  HASHKEY_MAINNET,
  HORIZON_GUARD_VAULT_ABI,
  type AdversarialCheckResult,
  type RiskPolicyConfig,
  type TradeIntentPayload,
} from "@horizonquant/agent";

interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

function getInjectedProvider(): EthereumProvider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: EthereumProvider }).ethereum;
  return eth ?? null;
}

export const hskMainnetChain = defineChain({
  id: HASHKEY_MAINNET.chainId,
  name: HASHKEY_MAINNET.name,
  nativeCurrency: HASHKEY_MAINNET.nativeCurrency,
  rpcUrls: { default: { http: HASHKEY_MAINNET.rpcUrls } },
  blockExplorers: {
    default: { name: "HashKey Blockscout", url: HASHKEY_MAINNET.explorerUrl },
  },
});

export function createHskPublicClient() {
  return createPublicClient({
    chain: hskMainnetChain,
    transport: http(HASHKEY_MAINNET.rpcUrls[0]),
  });
}

export async function connectHskWallet(): Promise<{
  address: Address;
  chainId: number;
  switchedToHsk: boolean;
}> {
  const provider = getInjectedProvider();
  if (!provider) {
    throw new Error("No EIP-1193 browser wallet detected (install MetaMask or Rabby to sign live HSK Chain transactions).");
  }

  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts || accounts.length === 0 || !isAddress(accounts[0])) {
    throw new Error("Wallet did not return an authorized account.");
  }

  const hexChainId = `0x${HASHKEY_MAINNET.chainId.toString(16)}`;
  let currentChainId = Number(BigInt((await provider.request({ method: "eth_chainId" })) as string));
  let switchedToHsk = currentChainId === HASHKEY_MAINNET.chainId;

  if (!switchedToHsk) {
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexChainId }],
      });
      currentChainId = HASHKEY_MAINNET.chainId;
      switchedToHsk = true;
    } catch {
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: hexChainId,
              chainName: HASHKEY_MAINNET.name,
              nativeCurrency: HASHKEY_MAINNET.nativeCurrency,
              rpcUrls: HASHKEY_MAINNET.rpcUrls,
              blockExplorerUrls: [HASHKEY_MAINNET.explorerUrl],
            },
          ],
        });
        currentChainId = HASHKEY_MAINNET.chainId;
        switchedToHsk = true;
      } catch {
        switchedToHsk = false;
      }
    }
  }

  return {
    address: accounts[0] as Address,
    chainId: currentChainId,
    switchedToHsk,
  };
}

export async function broadcastPolicyUpdateOnChain(
  vaultAddress: Address,
  walletAddress: Address,
  newPolicy: RiskPolicyConfig,
): Promise<{ txHash: Hex; explorerUrl: string }> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("Connect an EIP-1193 wallet first.");

  const publicClient = createHskPublicClient();
  const walletClient = createWalletClient({
    account: walletAddress,
    chain: hskMainnetChain,
    transport: custom(provider),
  });

  const { request } = await publicClient.simulateContract({
    account: walletAddress,
    address: vaultAddress,
    abi: HORIZON_GUARD_VAULT_ABI,
    functionName: "updateRiskPolicy",
    args: [newPolicy],
  });

  const txHash = await walletClient.writeContract(request);
  return {
    txHash,
    explorerUrl: `${HASHKEY_MAINNET.explorerUrl}/tx/${txHash}`,
  };
}

export async function broadcastVaultControlOnChain(
  vaultAddress: Address,
  walletAddress: Address,
  action: "PAUSE" | "UNPAUSE" | "RESET_CB" | "SYNC_TWAP",
): Promise<{ txHash: Hex; explorerUrl: string }> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("Connect an EIP-1193 wallet first.");

  const publicClient = createHskPublicClient();
  const walletClient = createWalletClient({
    account: walletAddress,
    chain: hskMainnetChain,
    transport: custom(provider),
  });

  let txHash: Hex;
  if (action === "PAUSE" || action === "UNPAUSE") {
    const { request } = await publicClient.simulateContract({
      account: walletAddress,
      address: vaultAddress,
      abi: HORIZON_GUARD_VAULT_ABI,
      functionName: "setPaused",
      args: [action === "PAUSE"],
    });
    txHash = await walletClient.writeContract(request);
  } else if (action === "RESET_CB") {
    const { request } = await publicClient.simulateContract({
      account: walletAddress,
      address: vaultAddress,
      abi: HORIZON_GUARD_VAULT_ABI,
      functionName: "resetCircuitBreaker",
      args: [],
    });
    txHash = await walletClient.writeContract(request);
  } else {
    const { request } = await publicClient.simulateContract({
      account: walletAddress,
      address: vaultAddress,
      abi: HORIZON_GUARD_VAULT_ABI,
      functionName: "syncPriceFromV3Pool",
      args: [HASHKEY_MAINNET.tokens.WHSK.address],
    });
    txHash = await walletClient.writeContract(request);
  }

  return {
    txHash,
    explorerUrl: `${HASHKEY_MAINNET.explorerUrl}/tx/${txHash}`,
  };
}

export async function signAndBroadcastGuardedSwap(
  vaultAddress: Address,
  walletAddress: Address,
  intent: TradeIntentPayload,
): Promise<{ txHash: Hex; signature: Hex; explorerUrl: string }> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("Connect an EIP-1193 wallet first.");

  const publicClient = createHskPublicClient();
  const walletClient = createWalletClient({
    account: walletAddress,
    chain: hskMainnetChain,
    transport: custom(provider),
  });

  const signature = await walletClient.signTypedData({
    account: walletAddress,
    domain: buildVaultDomain(vaultAddress, HASHKEY_MAINNET.chainId),
    types: EIP712_TRADE_INTENT_TYPES,
    primaryType: "TradeIntent",
    message: intent,
  });

  const { request } = await publicClient.simulateContract({
    account: walletAddress,
    address: vaultAddress,
    abi: HORIZON_GUARD_VAULT_ABI,
    functionName: "executeGuardedSwap",
    args: [intent, signature],
  });

  const txHash = await walletClient.writeContract(request);
  return {
    txHash,
    signature,
    explorerUrl: `${HASHKEY_MAINNET.explorerUrl}/tx/${txHash}`,
  };
}

export async function verifyAdversarialRevertLive(
  vaultAddress: Address,
  baseline: AdversarialCheckResult,
): Promise<AdversarialCheckResult> {
  const publicClient = createHskPublicClient();
  try {
    await publicClient.call({
      to: vaultAddress,
      data: baseline.calldataPreview,
      account: "0x000000000000000000000000000000000000bEEF",
    });
    return {
      ...baseline,
      reverted: false,
      decodedReason: "WARNING: Live eth_call did not revert — inspect deployed vault configuration.",
      executionMode: "ON_CHAIN_ETH_CALL",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ...baseline,
      reverted: true,
      decodedReason: `Live HSK Mainnet eth_call reverted on ${vaultAddress.slice(0, 10)}...: ${msg.slice(0, 190)}`,
      executionMode: "ON_CHAIN_ETH_CALL",
    };
  }
}
