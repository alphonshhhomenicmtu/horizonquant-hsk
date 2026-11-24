import { describe, expect, it } from "vitest";
import { runGuardrailStressScenario } from "../src/backtest/attributionEngine.js";

describe("Guardrail Stress Scenario Model", () => {
  it("bounds tail drawdown and saves adverse slippage versus an unguarded bot", () => {
    const report = runGuardrailStressScenario(1_000, {
      maxSlippageBps: 50,
      maxPositionBps: 2500,
      dailyDrawdownCapBps: 300,
      minTradeIntervalSec: 300,
      maxDailyTrades: 24,
    });

    expect(report.disclaimer).toContain("not a historical live trading backtest");
    expect(report.horizonDays).toBe(30);
    expect(report.equityCurve).toHaveLength(31);
    expect(report.finalGuardedNavUsd).toBeGreaterThan(report.finalUnguardedNavUsd);
    expect(report.maxDrawdownPct).toBeLessThan(report.unguardedMaxDrawdownPct);
    expect(report.drawdownSavedPct).toBeGreaterThan(0);
    expect(report.slippageSavedUsd).toBeGreaterThan(0);
    expect(report.circuitBreakerActivations).toBeGreaterThanOrEqual(1);
    expect(report.blockedAdverseSwaps).toBeGreaterThanOrEqual(1);
    expect(report.attribution).toHaveLength(4);
  });

  it("scales exposure across Conservative, Balanced, and Aggressive profiles", () => {
    const conservative = runGuardrailStressScenario(1_000, undefined, "CONSERVATIVE");
    const aggressive = runGuardrailStressScenario(1_000, undefined, "AGGRESSIVE");
    expect(aggressive.slippageSavedUsd).toBeGreaterThan(conservative.slippageSavedUsd);
    expect(conservative.maxDrawdownPct).toBeLessThan(conservative.unguardedMaxDrawdownPct);
    expect(aggressive.maxDrawdownPct).toBeLessThan(aggressive.unguardedMaxDrawdownPct);
  });
});
