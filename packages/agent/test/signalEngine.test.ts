import { describe, expect, it } from "vitest";
import {
  computeBollingerZ,
  computeEma,
  computeRsi,
  evaluatePairSignal,
  generateDeterministicPriceSeries,
  scanArbitrageOpportunities,
  type VaultRuntimeState,
} from "../src/strategy/signalEngine.js";
import { VERIFIED_MAINNET_SNAPSHOT, decodeSqrtPriceX96ToSpot } from "../src/rpc/hskTelemetry.js";

const baseVault: VaultRuntimeState = {
  vaultAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  agentAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  paused: false,
  circuitBreakerTripped: false,
  currentDrawdownBps: 35,
  dailyTradeCount: 4,
  secondsSinceLastTrade: 400,
  sessionVolumeUsedUsd: 24_000,
  sessionVolumeCapUsd: 250_000,
  nonce: 4,
  balances: { USDT: 50_000, WHSK: 200_000, WETH: 2, WBTC: 0.05 },
  policy: {
    maxSlippageBps: 50,
    maxPositionBps: 2500,
    dailyDrawdownCapBps: 300,
    minTradeIntervalSec: 300,
    maxDailyTrades: 24,
  },
  strategyMode: "MOMENTUM",
  riskAppetite: "BALANCED",
  targetPairs: ["WHSK/USDT", "WETH/USDT"],
};

describe("HSKSwap Signal Engine & Live Telemetry Math", () => {
  it("decodes live HashKey Chain Mainnet sqrtPriceX96 to ~$0.100013 USDT/WHSK", () => {
    const spot = decodeSqrtPriceX96ToSpot(25055738251564958613595n, 18, 6);
    expect(spot).toBeGreaterThan(0.0999);
    expect(spot).toBeLessThan(0.1002);
  });

  it("computes EMA, RSI, and Bollinger Z-score accurately on trending series", () => {
    const upward = Array.from({ length: 30 }, (_, i) => 0.095 + i * 0.00025);
    expect(computeEma(upward, 9)).toBeGreaterThan(computeEma(upward, 21));
    expect(computeRsi(upward, 14)).toBeGreaterThan(80);
    expect(computeBollingerZ(upward, 20)).toBeGreaterThan(1.2);
  });

  it("generates BUY momentum signal with valid EIP-712 TradeIntent respecting maxPositionBps", () => {
    const series = generateDeterministicPriceSeries(0.100013, 36, 9.5);
    const sig = evaluatePairSignal("WHSK/USDT", series, baseVault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);

    expect(sig.action).toBe("BUY");
    expect(sig.allGuardsPassed).toBe(true);
    expect(sig.recommendedSizeUsd).toBeLessThanOrEqual(12_500);
    expect(sig.intent).not.toBeNull();
    expect(sig.intentDigest).toMatch(/^0x[a-f0-9]{64}$/);
    expect(sig.intent!.minAmountOut).toBeLessThan(sig.intent!.expectedAmountOut);
  });

  it("blocks execution pre-trade when circuit breaker is latched or cooldown active", () => {
    const series = generateDeterministicPriceSeries(0.100013, 36, 9.5);
    const trippedVault: VaultRuntimeState = {
      ...baseVault,
      circuitBreakerTripped: true,
      currentDrawdownBps: 315,
    };
    const sig = evaluatePairSignal("WHSK/USDT", series, trippedVault, VERIFIED_MAINNET_SNAPSHOT, 1_764_000_000);
    expect(sig.allGuardsPassed).toBe(false);
    expect(sig.guardChecks.some((c) => !c.passed && c.name === "Vault Operational State")).toBe(true);
    expect(sig.guardChecks.some((c) => !c.passed && c.name === "Daily Drawdown Stop-Loss")).toBe(true);
  });

  it("scans cross-fee-tier HSKSwap V3 spread arbitrage opportunities accurately", () => {
    const opportunities = scanArbitrageOpportunities(VERIFIED_MAINNET_SNAPSHOT, 50_000, 2500);
    expect(opportunities).toHaveLength(3);
    expect(opportunities[0].grossSpreadBps).toBe(18);
    expect(opportunities[1].executable).toBe(true);
    expect(opportunities[1].netEdgeBps).toBeGreaterThan(0);
  });
});
