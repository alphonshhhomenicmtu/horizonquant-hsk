import {
  encodeFunctionData,
  hashTypedData,
  keccak256,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { HASHKEY_MAINNET, HORIZON_GUARD_VAULT_ABI } from "../config/networks.js";

export interface RiskPolicyConfig {
  maxSlippageBps: number;
  maxPositionBps: number;
  dailyDrawdownCapBps: number;
  minTradeIntervalSec: number;
  maxDailyTrades: number;
}

export interface TradeIntentPayload {
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
  minAmountOut: bigint;
  expectedAmountOut: bigint;
  maxSlippageBps: number;
  deadline: bigint;
  nonce: bigint;
  strategyTag: Hex;
  signalHash: Hex;
}

export const EIP712_TRADE_INTENT_TYPES = {
  TradeIntent: [
    { name: "router", type: "address" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "expectedAmountOut", type: "uint256" },
    { name: "maxSlippageBps", type: "uint16" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "strategyTag", type: "bytes32" },
    { name: "signalHash", type: "bytes32" },
  ],
} as const;

export function buildVaultDomain(verifyingContract: Address, chainId = HASHKEY_MAINNET.chainId) {
  return {
    name: "HorizonGuardVault",
    version: "1",
    chainId,
    verifyingContract,
  } as const;
}

/**
 * Deterministic off-chain domain used only when no vault address is configured.
 * Name, version, and verifyingContract differ from HorizonGuardVault and from the HSKSwap router.
 */
export const PAPER_GUARD_VERIFYING_CONTRACT =
  "0x0000000000000000000000000000000000007171" as Address;

export function buildPaperGuardDomain(chainId = HASHKEY_MAINNET.chainId) {
  return {
    name: "HorizonGuardPaper",
    version: "paper",
    chainId,
    verifyingContract: PAPER_GUARD_VERIFYING_CONTRACT,
  } as const;
}

export type IntentDomainMode = "vault" | "paper";

export function resolveIntentDomain(vaultAddress: Address | null, chainId = HASHKEY_MAINNET.chainId) {
  if (vaultAddress) {
    return { mode: "vault" as const, domain: buildVaultDomain(vaultAddress, chainId) };
  }
  return { mode: "paper" as const, domain: buildPaperGuardDomain(chainId) };
}

export function hashStrategyTag(label: string): Hex {
  return keccak256(stringToHex(label));
}

export function computeSignalHash(signalPayload: Record<string, unknown>): Hex {
  const canonical = JSON.stringify(signalPayload, Object.keys(signalPayload).sort());
  return keccak256(toHex(canonical));
}

export function computeTradeIntentDigest(
  intent: TradeIntentPayload,
  verifyingContract: Address,
  chainId = HASHKEY_MAINNET.chainId,
): Hex {
  return hashTypedData({
    domain: buildVaultDomain(verifyingContract, chainId),
    types: EIP712_TRADE_INTENT_TYPES,
    primaryType: "TradeIntent",
    message: intent,
  });
}

export function computeTradeIntentDigestForDomain(
  intent: TradeIntentPayload,
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  },
): Hex {
  return hashTypedData({
    domain,
    types: EIP712_TRADE_INTENT_TYPES,
    primaryType: "TradeIntent",
    message: intent,
  });
}

export function encodeUpdateRiskPolicyCalldata(policy: RiskPolicyConfig): Hex {
  return encodeFunctionData({
    abi: HORIZON_GUARD_VAULT_ABI,
    functionName: "updateRiskPolicy",
    args: [policy],
  });
}

export function encodeSetPausedCalldata(shouldPause: boolean): Hex {
  return encodeFunctionData({
    abi: HORIZON_GUARD_VAULT_ABI,
    functionName: "setPaused",
    args: [shouldPause],
  });
}

export function encodeResetCircuitBreakerCalldata(): Hex {
  return encodeFunctionData({
    abi: HORIZON_GUARD_VAULT_ABI,
    functionName: "resetCircuitBreaker",
    args: [],
  });
}

export function encodeSyncPriceCalldata(token: Address): Hex {
  return encodeFunctionData({
    abi: HORIZON_GUARD_VAULT_ABI,
    functionName: "syncPriceFromV3Pool",
    args: [token],
  });
}

export function encodeExecuteGuardedSwapCalldata(intent: TradeIntentPayload, signature: Hex): Hex {
  return encodeFunctionData({
    abi: HORIZON_GUARD_VAULT_ABI,
    functionName: "executeGuardedSwap",
    args: [intent, signature],
  });
}

export function computeErrorSelector(signature: string): Hex {
  return (`0x${keccak256(stringToHex(signature)).slice(2, 10)}`) as Hex;
}

export function serializeIntentForDisplay(intent: TradeIntentPayload): Record<string, string | number> {
  return {
    router: intent.router,
    tokenIn: intent.tokenIn,
    tokenOut: intent.tokenOut,
    fee: intent.fee,
    amountIn: intent.amountIn.toString(),
    minAmountOut: intent.minAmountOut.toString(),
    expectedAmountOut: intent.expectedAmountOut.toString(),
    maxSlippageBps: intent.maxSlippageBps,
    deadline: intent.deadline.toString(),
    nonce: intent.nonce.toString(),
    strategyTag: intent.strategyTag,
    signalHash: intent.signalHash,
  };
}
