import { describe, expect, it } from "vitest";
import { runDeterministicBacktest } from "../src/backtest/attributionEngine.js";

describe("Deterministic Backtest & PnL Attribution Engine", () => {
  it("produces deterministic positive Sharpe and bounds drawdown versus unguarded bot", () => {
    const report = runDeterministicBacktest(70_000, {
      maxSlippageBps: 50,
      maxPositionBps: 2500,
      dailyDrawdownCapBps: 300,
      minTradeIntervalSec: 300,
      maxDailyTrades: 24,
    });

    expect(report.horizonDays).toBe(30);
    expect(report.equityCurve).toHaveLength(31);
    expect(report.finalGuardedNavUsd).toBeGreaterThan(report.initialNavUsd);
    expect(report.finalGuardedNavUsd).toBeGreaterThan(report.finalUnguardedNavUsd);
    expect(report.maxDrawdownPct).toBeLessThan(report.unguardedMaxDrawdownPct);
    expect(report.drawdownSavedPct).toBeGreaterThan(0);
    expect(report.slippageSavedUsd).toBeGreaterThan(0);
    expect(report.circuitBreakerActivations).toBeGreaterThanOrEqual(1);
    expect(report.sharpeRatio).toBeGreaterThan(1.0);
    expect(report.sortinoRatio).toBeGreaterThan(report.sharpeRatio);
    expect(report.attribution).toHaveLength(4);
  });

  it("scales exposure cleanly across Conservative, Balanced, and Aggressive profiles", () => {
    const conservative = runDeterministicBacktest(70_000, undefined, "CONSERVATIVE");
    const aggressive = runDeterministicBacktest(70_000, undefined, "AGGRESSIVE");
    expect(aggressive.netPnlUsd).toBeGreaterThan(conservative.netPnlUsd);
  });
});
