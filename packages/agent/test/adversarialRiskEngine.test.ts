import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeBollingerZ,
  computeEma,
  computeRealizedVolPct,
  computeRsi,
  detectMarketRegime,
  evaluateDecisionCycle,
  evaluatePairSignal,
  generateDeterministicPriceSeries,
  scanArbitrageOpportunities,
  type VaultRuntimeState,
} from "../src/strategy/signalEngine.js";
import {
  computeCrossTierSpread,
  decodeSqrtPriceX96ToSpot,
  estimatePool2PctDepthUsd,
  fetchMainnetTelemetry,
  tickToSpotPrice,
  VERIFIED_MAINNET_SNAPSHOT,
  type ChainTelemetrySnapshot,
} from "../src/rpc/hskTelemetry.js";
import { computeVaultNavUsd, parseAndExecuteCopilotCommand } from "../src/copilot/commandParser.js";
import { runGuardrailStressScenario } from "../src/backtest/attributionEngine.js";

const makeVault = (overrides: Partial<VaultRuntimeState> = {}): VaultRuntimeState => ({
  vaultAddress: null,
  ownerAddress: "0x57A46E4E5F538452E4D672EF9D48e3e90E10A81C",
  agentAddress: "0x000000000000000000000000000000000000dEaD",
  isLiveOnChain: false,
  paused: false,
  circuitBreakerTripped: false,
  currentDrawdownBps: 25,
  dailyTradeCount: 1,
  secondsSinceLastTrade: 400,
  oracleAgeSec: 40,
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
  ...overrides,
});

const makeTelemetry = (overrides: Partial<ChainTelemetrySnapshot> = {}): ChainTelemetrySnapshot => ({
  ...VERIFIED_MAINNET_SNAPSHOT,
  pools: VERIFIED_MAINNET_SNAPSHOT.pools.map((p) => ({ ...p })),
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Adversarial Quant Indicators & Corrupted Candle Hygiene", () => {
  it("sanitizes NaN, Infinity, zero, and negative prices across EMA, RSI, Bollinger Z, and realized volatility", () => {
    const poisoned = [
      NaN,
      0,
      -0.05,
      Infinity,
      0.098,
      0.099,
      -Infinity,
      0.1,
      0,
      0.101,
      NaN,
      0.102,
      0.103,
    ];

    const ema = computeEma(poisoned, 9);
    const rsi = computeRsi(poisoned, 14);
    const z = computeBollingerZ(poisoned, 20);
    const vol = computeRealizedVolPct(poisoned);

    expect(Number.isFinite(ema)).toBe(true);
    expect(ema).toBeGreaterThan(0.098);
    expect(Number.isFinite(rsi)).toBe(true);
    expect(rsi).toBe(100);
    expect(Number.isFinite(z)).toBe(true);
    expect(z).toBeGreaterThan(0);
    expect(Number.isFinite(vol)).toBe(true);
    expect(vol).toBeGreaterThanOrEqual(0);
  });

  it("returns safe neutral defaults when every candle is NaN, zero, or negative", () => {
    const allBad = [NaN, 0, -1, Infinity, -Infinity];
    expect(computeEma(allBad, 9)).toBe(0);
    expect(computeRsi(allBad, 14)).toBe(50);
    expect(computeBollingerZ(allBad, 20)).toBe(0);
    expect(computeRealizedVolPct(allBad)).toBe(0);
  });

  it("handles non-positive or non-finite indicator periods without dividing by zero", () => {
    const clean = [0.1, 0.101, 0.102, 0.103, 0.104];
    expect(Number.isFinite(computeEma(clean, 0))).toBe(true);
    expect(Number.isFinite(computeEma(clean, NaN))).toBe(true);
    expect(Number.isFinite(computeRsi(clean, 0))).toBe(true);
    expect(Number.isFinite(computeRsi(clean, -5))).toBe(true);
    expect(Number.isFinite(computeBollingerZ(clean, 1))).toBe(true);
    expect(Number.isFinite(computeBollingerZ(clean, NaN))).toBe(true);
  });

  it("fails closed to VOLATILE_CAUTION when regime inputs contain NaN or Infinity", () => {
    expect(detectMarketRegime(NaN, 0.1, 20, 0.1)).toBe("VOLATILE_CAUTION");
    expect(detectMarketRegime(0.1, Infinity, 20, 0.1)).toBe("VOLATILE_CAUTION");
    expect(detectMarketRegime(0.1, 0.1, NaN, 0.1)).toBe("VOLATILE_CAUTION");
    expect(detectMarketRegime(0.1, 0.1, 20, -Infinity)).toBe("VOLATILE_CAUTION");
    expect(detectMarketRegime(0.1, 0.1, 95, 0.1)).toBe("VOLATILE_CAUTION");
  });

  it("guards generateDeterministicPriceSeries against zero, negative, or NaN anchors and zero length", () => {
    expect(generateDeterministicPriceSeries(0, 36, 5)).toEqual([]);
    expect(generateDeterministicPriceSeries(-0.1, 36, 5)).toEqual([]);
    expect(generateDeterministicPriceSeries(NaN, 36, 5)).toEqual([]);
    expect(generateDeterministicPriceSeries(0.1, 0, 5)).toEqual([]);
    const series = generateDeterministicPriceSeries(0.1, 12, Infinity);
    expect(series).toHaveLength(12);
    expect(series.every((p) => Number.isFinite(p) && p > 0)).toBe(true);
  });
});

describe("Zero-Liquidity Pools, Flash-Crash Drawdown Spikes & Stale-Feed Fallback", () => {
  it("blocks execution and zeroes recommended size on zero-liquidity pools", () => {
    const zeroLiqTelemetry = makeTelemetry({
      pools: [
        { ...VERIFIED_MAINNET_SNAPSHOT.pools[0], liquidity: "0", approxDepth2PctUsd: 0 },
        { ...VERIFIED_MAINNET_SNAPSHOT.pools[1], liquidity: "0", approxDepth2PctUsd: 0 },
      ],
      crossTierSpreadBps: 120,
    });
    const series = generateDeterministicPriceSeries(0.100013, 36, 9.5);
    const vault = makeVault();

    const sig = evaluatePairSignal("WHSK/USDT", series, vault, zeroLiqTelemetry, 1_764_000_000);
    expect(sig.recommendedSizeUsd).toBe(0);
    expect(sig.intent).toBeNull();
    expect(sig.allGuardsPassed).toBe(false);
    expect(sig.guardChecks.some((g) => !g.passed && g.name.includes("Pool Depth"))).toBe(true);

    const arbs = scanArbitrageOpportunities(zeroLiqTelemetry, 500, 2500);
    expect(arbs[0].executable).toBe(false);
    expect(arbs[0].recommendedNotionalUsd).toBe(0);
    expect(arbs[0].holdReason).toContain("Zero active liquidity");

    const decision = evaluateDecisionCycle(zeroLiqTelemetry, vault, sig);
    expect(decision.verdict).toBe("GUARD_REJECT");
  });

  it("rejects immediately on flash-crash drawdown spike even before circuitBreakerTripped flag latches", () => {
    const series = generateDeterministicPriceSeries(0.100013, 36, 9.5);
    const shockedVault = makeVault({
      circuitBreakerTripped: false,
      currentDrawdownBps: 420, // > 300 bps policy cap
    });

    const sig = evaluatePairSignal("WHSK/USDT", series, shockedVault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);
    expect(sig.allGuardsPassed).toBe(false);
    expect(sig.guardChecks.some((g) => !g.passed && g.name.includes("Daily Drawdown"))).toBe(true);

    const decision = evaluateDecisionCycle(VERIFIED_MAINNET_SNAPSHOT, shockedVault, sig);
    expect(decision.verdict).toBe("GUARD_REJECT");
    expect(decision.reasonCode).toBe("CIRCUIT_BREAKER_LATCHED");
  });

  it("rejects zero or NaN TWAP oracle prices and non-finite spot-vs-TWAP divergence", () => {
    const series = generateDeterministicPriceSeries(0.100013, 36, 9.5);
    const badTwapTelemetry = makeTelemetry({ whskTwapUsdt: 0, whskUsdtSpot: 0 });
    const vault = makeVault();

    const sigZero = evaluatePairSignal("WHSK/USDT", series, vault, badTwapTelemetry, 1_764_000_000);
    expect(sigZero.intent).toBeNull();
    expect(sigZero.allGuardsPassed).toBe(false);
    expect(evaluateDecisionCycle(badTwapTelemetry, vault, sigZero).reasonCode).toBe("ORACLE_STALE");

    const nanDivTelemetry = makeTelemetry({ spotVsTwapDiffBps: NaN });
    const sigNanDiv = evaluatePairSignal("WHSK/USDT", series, vault, nanDivTelemetry, 1_764_000_000);
    expect(sigNanDiv.allGuardsPassed).toBe(false);
    expect(evaluateDecisionCycle(nanDivTelemetry, vault, sigNanDiv).reasonCode).toBe("SPOT_TWAP_DIVERGENCE");

    const nanAgeVault = makeVault({ oracleAgeSec: NaN });
    const sigNanAge = evaluatePairSignal("WHSK/USDT", series, nanAgeVault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);
    expect(sigNanAge.allGuardsPassed).toBe(false);
    expect(evaluateDecisionCycle(VERIFIED_MAINNET_SNAPSHOT, nanAgeVault, sigNanAge).reasonCode).toBe("ORACLE_STALE");
  });

  it("falls back cleanly to VERIFIED_MAINNET_SNAPSHOT when RPC endpoints return HTTP 500 or timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));

    const snap = await fetchMainnetTelemetry(["https://dead-primary.invalid", "https://dead-backup.invalid"]);
    expect(snap.source).toBe("VERIFIED_SNAPSHOT");
    expect(snap.chainId).toBe(177);
    expect(snap.whskTwapUsdt).toBeCloseTo(0.100013, 6);
    expect(snap.pools).toHaveLength(2);
  });

  it("rejects wrong-chainId RPC responses and falls back to VERIFIED_MAINNET_SNAPSHOT", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x3e7" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const snap = await fetchMainnetTelemetry(["https://wrong-chain.invalid"]);
    expect(snap.source).toBe("VERIFIED_SNAPSHOT");
    expect(snap.chainId).toBe(177);
  });

  it("guards V3 telemetry math against zero sqrtPriceX96, out-of-range ticks, and NaN spreads", () => {
    expect(decodeSqrtPriceX96ToSpot(0n, 18, 6)).toBe(0);
    expect(decodeSqrtPriceX96ToSpot(-1n, 18, 6)).toBe(0);
    expect(tickToSpotPrice(NaN, 18, 6)).toBe(0);
    expect(tickToSpotPrice(900_000, 18, 6)).toBe(0);
    expect(tickToSpotPrice(-900_000, 18, 6)).toBe(0);
    expect(estimatePool2PctDepthUsd(0n, 25055738251564958613595n, 6)).toBe(0);
    expect(estimatePool2PctDepthUsd(2830955089632n, 0n, 6)).toBe(0);

    const nanPools = [
      { ...VERIFIED_MAINNET_SNAPSHOT.pools[0], spotPriceUsdt: NaN },
      { ...VERIFIED_MAINNET_SNAPSHOT.pools[1], spotPriceUsdt: 0.1001 },
    ];
    const spread = computeCrossTierSpread(nanPools);
    expect(spread.crossTierSpreadBps).toBe(0);
    expect(Number.isFinite(spread.crossTierSpreadBps)).toBe(true);
  });
});

describe("Deterministic Order-Sizing Rounding, Direction Caps & Policy Boundaries", () => {
  it("floors BUY order sizing deterministically so amountIn never rounds up past maxPositionBps or 2% depth", () => {
    const deepTelemetry = makeTelemetry({
      pools: [
        { ...VERIFIED_MAINNET_SNAPSHOT.pools[0], approxDepth2PctUsd: 12.34569 },
        { ...VERIFIED_MAINNET_SNAPSHOT.pools[1] },
      ],
    });
    const vault = makeVault({
      balances: { USDT: 33.3333, WHSK: 5_000 },
      policy: {
        maxSlippageBps: 50,
        maxPositionBps: 3333, // maxPositionUsd = 11.10998889
        dailyDrawdownCapBps: 300,
        minTradeIntervalSec: 300,
        maxDailyTrades: 24,
      },
      riskAppetite: "AGGRESSIVE", // 0.95 scalar -> 10.5544894...
    });
    const series = generateDeterministicPriceSeries(0.100013, 36, 9.5);
    const sig = evaluatePairSignal("WHSK/USDT", series, vault, deepTelemetry, 1_764_000_000);

    const maxPosUsd = (vault.balances.USDT * vault.policy.maxPositionBps) / 10_000;
    expect(sig.action).toBe("BUY");
    expect(sig.recommendedSizeUsd).toBeLessThanOrEqual(maxPosUsd);
    expect(sig.recommendedSizeUsd).toBeLessThanOrEqual(12.34569);
    expect(sig.recommendedSizeUsd).toBe(10.5544); // floored, never rounded up to 10.5545
    expect(sig.intent).not.toBeNull();
    expect(sig.intent!.amountIn).toBeLessThanOrEqual(BigInt(Math.floor(maxPosUsd * 1e6)));
    expect(sig.intent!.minAmountOut).toBeGreaterThan(0n);
    expect(sig.intent!.minAmountOut).toBeLessThanOrEqual(sig.intent!.expectedAmountOut);
  });

  it("sizes SELL intents strictly against WHSK inventory rather than USDT balance", () => {
    // Oscillating downtrend: EMA(9) < EMA(21) by > 15 bps while RSI stays ~38 (> 30)
    const downtrend = [
      ...Array.from({ length: 20 }, () => 0.11),
      0.1092, 0.1098, 0.1088, 0.1095, 0.1082, 0.109, 0.1076, 0.1084, 0.107, 0.1078, 0.1065, 0.1073, 0.106, 0.1068,
      0.1055,
    ];
    const deepTelemetry = makeTelemetry({
      pools: [
        { ...VERIFIED_MAINNET_SNAPSHOT.pools[0], approxDepth2PctUsd: 50 },
        { ...VERIFIED_MAINNET_SNAPSHOT.pools[1] },
      ],
    });

    // Zero USDT but ample WHSK -> SELL still computes valid WHSK notional capped by WHSK balance
    const whskOnlyVault = makeVault({
      balances: { USDT: 0, WHSK: 400 }, // $40.0052 WHSK -> 25% cap = $10.0013
      riskAppetite: "AGGRESSIVE",
    });
    const sigSell = evaluatePairSignal("WHSK/USDT", downtrend, whskOnlyVault, deepTelemetry, 1_764_000_000);
    expect(sigSell.action).toBe("SELL");
    expect(sigSell.recommendedSizeUsd).toBeGreaterThan(0);
    expect(sigSell.recommendedSizeUsd).toBeLessThanOrEqual(400 * deepTelemetry.whskTwapUsdt * 0.25);
    expect(sigSell.intent).not.toBeNull();

    // Zero WHSK -> SELL produces zero size and null intent
    const emptyWhskVault = makeVault({ balances: { USDT: 5_000, WHSK: 0 } });
    const sigEmpty = evaluatePairSignal("WHSK/USDT", downtrend, emptyWhskVault, deepTelemetry, 1_764_000_000);
    expect(sigEmpty.action).toBe("SELL");
    expect(sigEmpty.recommendedSizeUsd).toBe(0);
    expect(sigEmpty.intent).toBeNull();
  });

  it("blocks execution immediately while vault is paused and logs VAULT_PAUSED decision", () => {
    const series = generateDeterministicPriceSeries(0.100013, 36, 9.5);
    const pausedVault = makeVault({ paused: true });
    const sig = evaluatePairSignal("WHSK/USDT", series, pausedVault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);
    expect(sig.allGuardsPassed).toBe(false);
    expect(sig.guardChecks.some((g) => !g.passed && g.name.includes("Vault Operational"))).toBe(true);

    const decision = evaluateDecisionCycle(VERIFIED_MAINNET_SNAPSHOT, pausedVault, sig);
    expect(decision.verdict).toBe("GUARD_REJECT");
    expect(decision.reasonCode).toBe("VAULT_PAUSED");
  });

  it("enforces session volume cap, cooldown floor, daily trade cap, and slippage bounds", () => {
    const series = generateDeterministicPriceSeries(0.100013, 36, 9.5);

    const exhaustedSession = makeVault({ sessionVolumeUsedUsd: 1_000, sessionVolumeCapUsd: 1_000 });
    const sigSession = evaluatePairSignal("WHSK/USDT", series, exhaustedSession, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);
    expect(sigSession.allGuardsPassed).toBe(false);
    expect(sigSession.guardChecks.some((g) => !g.passed && g.name.includes("Session Notional"))).toBe(true);

    const maxTradesVault = makeVault({ dailyTradeCount: 24 });
    const sigTrades = evaluatePairSignal("WHSK/USDT", series, maxTradesVault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);
    expect(sigTrades.allGuardsPassed).toBe(false);
    expect(sigTrades.guardChecks.some((g) => !g.passed && g.name.includes("Cooldown"))).toBe(true);

    const badSlipVault = makeVault({
      policy: {
        maxSlippageBps: 750, // > 500 hard cap
        maxPositionBps: 2500,
        dailyDrawdownCapBps: 300,
        minTradeIntervalSec: 300,
        maxDailyTrades: 24,
      },
    });
    const sigSlip = evaluatePairSignal("WHSK/USDT", series, badSlipVault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);
    expect(sigSlip.allGuardsPassed).toBe(false);
    expect(sigSlip.intent).toBeNull();
  });

  it("produces identical deterministic EIP-712 intentDigest for repeated evaluations at the same timestamp", () => {
    const series = generateDeterministicPriceSeries(0.100013, 36, 9.5);
    const vault = makeVault();
    const s1 = evaluatePairSignal("WHSK/USDT", series, vault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);
    const s2 = evaluatePairSignal("WHSK/USDT", series, vault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);

    expect(s1.intentDigest).not.toBeNull();
    expect(s1.intentDigest).toBe(s2.intentDigest);
    expect(s1.intent).toEqual(s2.intent);
  });
});

describe("Circuit-Breaker State Recovery & Stress Engine Resilience", () => {
  it("completes full trip -> block -> reset -> resume circuit-breaker recovery lifecycle", () => {
    const series = generateDeterministicPriceSeries(0.100013, 36, 9.5);
    let vault = makeVault();

    // 1. Trip via 4.0% drawdown stress command
    const tripRes = parseAndExecuteCopilotCommand(
      "Simulate 4.0% drawdown crash to test circuit breaker",
      vault,
      VERIFIED_MAINNET_SNAPSHOT,
    );
    expect(tripRes.patch.simulateDrawdownBps).toBe(400);
    vault = {
      ...vault,
      currentDrawdownBps: tripRes.patch.simulateDrawdownBps!,
      circuitBreakerTripped: tripRes.patch.simulateDrawdownBps! >= vault.policy.dailyDrawdownCapBps,
    };
    expect(vault.circuitBreakerTripped).toBe(true);

    // 2. Verify trading is blocked while tripped
    const blockedSig = evaluatePairSignal("WHSK/USDT", series, vault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);
    expect(blockedSig.allGuardsPassed).toBe(false);
    expect(evaluateDecisionCycle(VERIFIED_MAINNET_SNAPSHOT, vault, blockedSig).reasonCode).toBe(
      "CIRCUIT_BREAKER_LATCHED",
    );

    // 3. Compile recovery calldata via copilot
    const resetRes = parseAndExecuteCopilotCommand(
      "Reset circuit breaker and resume trading",
      vault,
      VERIFIED_MAINNET_SNAPSHOT,
    );
    expect(resetRes.intentType).toBe("EMERGENCY_CONTROL");
    expect(resetRes.patch.resetCircuitBreaker).toBe(true);
    expect(resetRes.patch.paused).toBe(false);
    expect(resetRes.onChainActions.map((a) => a.functionName)).toEqual([
      "resetCircuitBreaker()",
      "setPaused(bool)",
    ]);

    // 4. Apply reset state and verify execution resumes cleanly
    vault = {
      ...vault,
      circuitBreakerTripped: false,
      currentDrawdownBps: 0,
      paused: false,
    };
    const recoveredSig = evaluatePairSignal("WHSK/USDT", series, vault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);
    expect(recoveredSig.allGuardsPassed).toBe(true);
    expect(evaluateDecisionCycle(VERIFIED_MAINNET_SNAPSHOT, vault, recoveredSig).verdict).toBe("ACT");
  });

  it("compiles dual recovery actions when vault is both paused and circuit-breaker latched", () => {
    const dualLocked = makeVault({ paused: true, circuitBreakerTripped: true, currentDrawdownBps: 350 });
    const res = parseAndExecuteCopilotCommand("Unpause vault", dualLocked, VERIFIED_MAINNET_SNAPSHOT);

    expect(res.patch.resetCircuitBreaker).toBe(true);
    expect(res.patch.paused).toBe(false);
    expect(res.onChainActions).toHaveLength(2);
    expect(res.onChainActions[0].calldata).toMatch(/^0x[a-f0-9]+$/);
    expect(res.onChainActions[1].calldata).toMatch(/^0x[a-f0-9]+$/);
  });

  it("rejects out-of-range drawdown (>25%), position (>100%), and daily trade limits (>200 or 0)", () => {
    const vault = makeVault();
    const res = parseAndExecuteCopilotCommand(
      "Cap daily loss at 30%, allocate 150%, max 500 trades per day",
      vault,
      VERIFIED_MAINNET_SNAPSHOT,
    );

    expect(res.rejectedConstraints).toHaveLength(3);
    expect(res.appliedPolicy.dailyDrawdownCapBps).toBe(300);
    expect(res.appliedPolicy.maxPositionBps).toBe(2500);
    expect(res.appliedPolicy.maxDailyTrades).toBe(24);
  });

  it("guards computeVaultNavUsd against NaN balances and zero/NaN oracle marks", () => {
    const poisonedVault = makeVault({ balances: { USDT: NaN, WHSK: -100 } });
    expect(computeVaultNavUsd(poisonedVault, VERIFIED_MAINNET_SNAPSHOT)).toBe(0);

    const fallbackTelemetry = makeTelemetry({ whskTwapUsdt: NaN, whskUsdtSpot: 0.1 });
    expect(computeVaultNavUsd(makeVault({ balances: { USDT: 100, WHSK: 1_000 } }), fallbackTelemetry)).toBe(200);
  });

  it("produces finite, bounded stress-scenario metrics even under NaN, zero, or extreme inputs", () => {
    const report = runGuardrailStressScenario(
      NaN,
      {
        maxSlippageBps: 0,
        maxPositionBps: 99_999,
        dailyDrawdownCapBps: 0,
        minTradeIntervalSec: 0,
        maxDailyTrades: 0,
      },
      "BALANCED",
      -1,
    );

    expect(report.initialNavUsd).toBe(1_000);
    expect(Number.isFinite(report.finalGuardedNavUsd)).toBe(true);
    expect(Number.isFinite(report.maxDrawdownPct)).toBe(true);
    expect(Number.isFinite(report.slippageSavedUsd)).toBe(true);
    expect(report.equityCurve.every((pt) => Number.isFinite(pt.guardedNavUsd) && Number.isFinite(pt.guardedDrawdownPct))).toBe(true);
  });
});
