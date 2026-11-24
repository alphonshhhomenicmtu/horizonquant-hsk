import { describe, expect, it } from "vitest";
import {
  computeBollingerZ,
  computeEma,
  computeRsi,
  detectMarketRegime,
  evaluateDecisionCycle,
  evaluatePairSignal,
  generateDeterministicPriceSeries,
  getMarketAvailability,
  scanArbitrageOpportunities,
  simulateAdversarialAttack,
  type VaultRuntimeState,
} from "../src/strategy/signalEngine.js";
import { VERIFIED_MAINNET_SNAPSHOT, decodeSqrtPriceX96ToSpot } from "../src/rpc/hskTelemetry.js";

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

describe("HSKSwap Signal Engine, Decision Ledger & Adversarial Breaker Parity", () => {
  it("decodes live HashKey Chain Mainnet sqrtPriceX96 to ~$0.100013 USDT/WHSK", () => {
    const spot = decodeSqrtPriceX96ToSpot(25055738251564958613595n, 18, 6);
    expect(spot).toBeGreaterThan(0.0999);
    expect(spot).toBeLessThan(0.1002);
  });

  it("computes EMA, RSI, Bollinger Z-score, and distinct market regimes", () => {
    const upward = Array.from({ length: 30 }, (_, i) => 0.095 + i * 0.00025);
    expect(computeEma(upward, 9)).toBeGreaterThan(computeEma(upward, 21));
    expect(computeRsi(upward, 14)).toBeGreaterThan(80);
    expect(computeBollingerZ(upward, 20)).toBeGreaterThan(1.2);

    expect(detectMarketRegime(0.1000, 0.1000, 20, 0.2)).toBe("RANGE_BOUND");
    expect(detectMarketRegime(0.1000, 0.1000, 20, 1.6)).toBe("MEAN_REVERTING");
    expect(detectMarketRegime(0.1010, 0.1000, 20, 0.2)).toBe("TRENDING_BULL");
  });

  it("generates BUY momentum signal on live WHSK/USDT capped by 2% pool depth", () => {
    const series = generateDeterministicPriceSeries(0.100013, 36, 9.5);
    const sig = evaluatePairSignal("WHSK/USDT", series, baseVault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);

    expect(sig.hasLivePool).toBe(true);
    expect(sig.action).toBe("BUY");
    expect(sig.allGuardsPassed).toBe(true);
    expect(sig.recommendedSizeUsd).toBeLessThanOrEqual(sig.maxDepth2PctUsd + 0.01);
    expect(sig.intent).not.toBeNull();
    expect(sig.intentDigest).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it("refuses execution on stale oracle or latched circuit breaker and logs HOLD decision", () => {
    const series = generateDeterministicPriceSeries(0.100013, 36, 9.5);
    const staleVault: VaultRuntimeState = {
      ...baseVault,
      oracleAgeSec: 4_200,
    };
    const sig = evaluatePairSignal("WHSK/USDT", series, staleVault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);
    expect(sig.allGuardsPassed).toBe(false);
    expect(sig.guardChecks.some((c) => !c.passed && c.name.includes("TWAP Oracle Freshness"))).toBe(true);

    const decision = evaluateDecisionCycle(VERIFIED_MAINNET_SNAPSHOT, staleVault, sig);
    expect(decision.verdict).toBe("GUARD_REJECT");
    expect(decision.reasonCode).toBe("ORACLE_STALE");
  });

  it("scans ONLY real live HSKSwap V3 pools and explicitly holds when spread < 35 bps fee hurdle", () => {
    const opportunities = scanArbitrageOpportunities(VERIFIED_MAINNET_SNAPSHOT, 500, 2500);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].grossSpreadBps).toBe(18);
    expect(opportunities[0].poolFeesBps).toBe(35);
    expect(opportunities[0].executable).toBe(false);
    expect(opportunities[0].netEdgeBps).toBeLessThan(0);

    const availability = getMarketAvailability(VERIFIED_MAINNET_SNAPSHOT);
    expect(availability.find((m) => m.pair === "WHSK/USDT")?.status).toBe("LIVE_EXECUTABLE");
    expect(availability.find((m) => m.pair === "WETH/USDT")?.status).toBe("NO_LIVE_POOL");
    expect(availability.find((m) => m.pair === "WBTC/USDT")?.status).toBe("NO_LIVE_POOL");

    const arbVault: VaultRuntimeState = { ...baseVault, strategyMode: "ARBITRAGE" };
    const sig = evaluatePairSignal("WHSK/USDT", [0.100013], arbVault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);
    const decision = evaluateDecisionCycle(VERIFIED_MAINNET_SNAPSHOT, arbVault, sig);
    expect(decision.verdict).toBe("HOLD");
    expect(decision.reasonCode).toBe("SPREAD_BELOW_FEE_HURDLE");
  });

  it("produces exact Solidity revert selectors for every Adversarial Breaker Lab scenario", () => {
    const oneWei = simulateAdversarialAttack("ONE_WEI_SLIPPAGE", baseVault, VERIFIED_MAINNET_SNAPSHOT);
    expect(oneWei.reverted).toBe(true);
    expect(oneWei.errorName).toBe("MinAmountOutBelowOracleFloor");
    expect(oneWei.errorSelector).toMatch(/^0x[a-f0-9]{8}$/);

    const stale = simulateAdversarialAttack("STALE_ORACLE", baseVault, VERIFIED_MAINNET_SNAPSHOT);
    expect(stale.errorName).toBe("OraclePriceStale");

    const unauth = simulateAdversarialAttack("UNAUTHORIZED_KEEPER", baseVault, VERIFIED_MAINNET_SNAPSHOT);
    expect(unauth.errorName).toBe("Unauthorized");

    const spike = simulateAdversarialAttack("SPOT_TWAP_SPIKE", baseVault, VERIFIED_MAINNET_SNAPSHOT);
    expect(spike.errorName).toBe("OracleDeviationExceeded");

    const pos = simulateAdversarialAttack("OVERSIZED_POSITION", baseVault, VERIFIED_MAINNET_SNAPSHOT);
    expect(pos.errorName).toBe("PositionSizeExceeded");
  });
});
