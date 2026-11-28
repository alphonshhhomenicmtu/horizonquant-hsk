import { describe, expect, it } from "vitest";
import { HASHKEY_MAINNET } from "../src/config/networks.js";
import { VERIFIED_MAINNET_SNAPSHOT } from "../src/rpc/hskTelemetry.js";
import {
  evaluateDecisionCycle,
  evaluatePairSignal,
  generateDeterministicPriceSeries,
  type VaultRuntimeState,
} from "../src/strategy/signalEngine.js";
import {
  buildPaperGuardDomain,
  computeTradeIntentDigest,
  computeTradeIntentDigestForDomain,
  PAPER_GUARD_VERIFYING_CONTRACT,
} from "../src/vault/eip712.js";

const baseVault: VaultRuntimeState = {
  vaultAddress: null,
  ownerAddress: "0x57A46E4E5F538452E4D672EF9D48e3e90E10A81C",
  agentAddress: "0x000000000000000000000000000000000000dEaD",
  isLiveOnChain: false,
  paused: false,
  circuitBreakerTripped: false,
  currentDrawdownBps: 35,
  dailyTradeCount: 1,
  secondsSinceLastTrade: 400,
  oracleAgeSec: 60,
  oracleMaxStalenessSec: 3600,
  oracleMaxDeviationBps: 1000,
  sessionVolumeUsedUsd: 100,
  sessionVolumeCapUsd: 1_000,
  nonce: 1,
  balances: { USDT: 500, WHSK: 5_000 },
  policy: {
    maxSlippageBps: 50,
    maxPositionBps: 2500,
    dailyDrawdownCapBps: 300,
    minTradeIntervalSec: 300,
    maxDailyTrades: 24,
  },
  strategyMode: "MOMENTUM",
  riskAppetite: "BALANCED",
  targetPairs: ["WHSK/USDT"],
};

describe("P1-1 paper EIP-712 domain is not the HSKSwap router", () => {
  it("binds a null vault to HorizonGuardPaper and labels ACT as a dry-run", () => {
    const series = generateDeterministicPriceSeries(0.100013, 36, 9.5);
    const sig = evaluatePairSignal("WHSK/USDT", series, baseVault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);
    expect(sig.intent).not.toBeNull();
    expect(sig.intentDomain).toBe("paper");
    expect(PAPER_GUARD_VERIFYING_CONTRACT.toLowerCase()).not.toBe(
      HASHKEY_MAINNET.hskSwapRouter.toLowerCase(),
    );

    const paperDigest = computeTradeIntentDigestForDomain(
      sig.intent!,
      buildPaperGuardDomain(HASHKEY_MAINNET.chainId),
    );
    const routerDigest = computeTradeIntentDigest(
      sig.intent!,
      HASHKEY_MAINNET.hskSwapRouter,
      HASHKEY_MAINNET.chainId,
    );
    expect(sig.intentDigest).toBe(paperDigest);
    expect(sig.intentDigest).not.toBe(routerDigest);
    expect(sig.intent!.router.toLowerCase()).toBe(HASHKEY_MAINNET.hskSwapRouter.toLowerCase());

    const decision = evaluateDecisionCycle(VERIFIED_MAINNET_SNAPSHOT, baseVault, sig);
    expect(decision.verdict).toBe("ACT");
    expect(decision.evidence).toContain("dry-run guards");
    expect(decision.evidence).not.toContain("on-chain guards");
  });

  it("uses the vault domain and on-chain ACT text only when a vault is live", () => {
    const vaultAddress = "0x2a07706473244BC757E10F2a9E86fB532828afe3" as const;
    const liveVault: VaultRuntimeState = {
      ...baseVault,
      vaultAddress,
      isLiveOnChain: true,
    };
    const series = generateDeterministicPriceSeries(0.100013, 36, 9.5);
    const sig = evaluatePairSignal("WHSK/USDT", series, liveVault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);
    expect(sig.intentDomain).toBe("vault");
    expect(sig.intentDigest).toBe(
      computeTradeIntentDigest(sig.intent!, vaultAddress, HASHKEY_MAINNET.chainId),
    );
    const decision = evaluateDecisionCycle(VERIFIED_MAINNET_SNAPSHOT, liveVault, sig);
    expect(decision.verdict).toBe("ACT");
    expect(decision.evidence).toContain("on-chain guards green");
  });
});
