import { describe, expect, it } from "vitest";
import { parseAndExecuteCopilotCommand } from "../src/copilot/commandParser.js";
import { VERIFIED_MAINNET_SNAPSHOT } from "../src/rpc/hskTelemetry.js";
import type { VaultRuntimeState } from "../src/strategy/signalEngine.js";

const baseVault: VaultRuntimeState = {
  vaultAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  agentAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  paused: false,
  circuitBreakerTripped: false,
  currentDrawdownBps: 45,
  dailyTradeCount: 5,
  secondsSinceLastTrade: 360,
  sessionVolumeUsedUsd: 32_000,
  sessionVolumeCapUsd: 250_000,
  nonce: 5,
  balances: { USDT: 46_250, WHSK: 237_500, WETH: 2.4, WBTC: 0.08 },
  policy: {
    maxSlippageBps: 50,
    maxPositionBps: 2500,
    dailyDrawdownCapBps: 300,
    minTradeIntervalSec: 300,
    maxDailyTrades: 24,
  },
  strategyMode: "HYBRID",
  riskAppetite: "BALANCED",
  targetPairs: ["WHSK/USDT", "WETH/USDT"],
};

describe("Conversational Strategy & Risk Command Parser", () => {
  it("parses flagship natural-language policy directive accurately", () => {
    const res = parseAndExecuteCopilotCommand(
      "Cap daily loss at 2.5%, allocate 20% into HSK/USDT momentum with 40bps max slippage",
      baseVault,
      VERIFIED_MAINNET_SNAPSHOT,
    );

    expect(res.intentType).toBe("POLICY_UPDATE");
    expect(res.appliedPolicy.dailyDrawdownCapBps).toBe(250);
    expect(res.appliedPolicy.maxPositionBps).toBe(2000);
    expect(res.appliedPolicy.maxSlippageBps).toBe(40);
    expect(res.patch.strategyMode).toBe("MOMENTUM");
    expect(res.patch.targetPairs).toEqual(["WHSK/USDT"]);
    expect(res.onChainActions).toHaveLength(1);
    expect(res.onChainActions[0].functionName).toBe("updateRiskPolicy(RiskPolicy)");
    expect(res.onChainActions[0].calldata).toMatch(/^0x[a-f0-9]+$/);
  });

  it("rejects slippage above HorizonGuardVault hard protocol ceiling (500 bps)", () => {
    const res = parseAndExecuteCopilotCommand(
      "Set max slippage to 800bps and allocate 30%",
      baseVault,
      VERIFIED_MAINNET_SNAPSHOT,
    );

    expect(res.rejectedConstraints.length).toBe(1);
    expect(res.rejectedConstraints[0]).toContain("HARD_MAX_SLIPPAGE_BPS");
    expect(res.appliedPolicy.maxSlippageBps).toBe(50); // unchanged
    expect(res.appliedPolicy.maxPositionBps).toBe(3000); // valid portion still applied
  });

  it("handles trade frequency, conservative preset, and multiple target pairs", () => {
    const res = parseAndExecuteCopilotCommand(
      "Switch to conservative mean-reversion on WHSK/USDT and WETH/USDT, trade every 15 minutes, max 10 trades per day",
      baseVault,
      VERIFIED_MAINNET_SNAPSHOT,
    );

    expect(res.patch.riskAppetite).toBe("CONSERVATIVE");
    expect(res.patch.strategyMode).toBe("MEAN_REVERSION");
    expect(res.patch.targetPairs).toEqual(["WHSK/USDT", "WETH/USDT"]);
    expect(res.appliedPolicy.minTradeIntervalSec).toBe(900);
    expect(res.appliedPolicy.maxDailyTrades).toBe(10);
  });

  it("encodes emergency pause calldata cleanly", () => {
    const res = parseAndExecuteCopilotCommand(
      "Emergency pause vault and halt trading immediately",
      baseVault,
      VERIFIED_MAINNET_SNAPSHOT,
    );

    expect(res.intentType).toBe("EMERGENCY_CONTROL");
    expect(res.patch.paused).toBe(true);
    expect(res.onChainActions[0].functionName).toBe("setPaused(bool)");
  });

  it("answers live positions, PnL, and arbitrage spread queries", () => {
    const pos = parseAndExecuteCopilotCommand("Show live positions, NAV, and drawdown buffer", baseVault, VERIFIED_MAINNET_SNAPSHOT);
    expect(pos.intentType).toBe("PORTFOLIO_QUERY");
    expect(pos.reply).toContain("Total Vault NAV");

    const arb = parseAndExecuteCopilotCommand("Scan HSKSwap spread arbitrage opportunities", baseVault, VERIFIED_MAINNET_SNAPSHOT);
    expect(arb.intentType).toBe("ARB_SCAN");
    expect(arb.reply).toContain("HSKSwap V3 Spread Radar");
  });

  it("simulates drawdown shock and trips circuit breaker when exceeding policy cap", () => {
    const stress = parseAndExecuteCopilotCommand(
      "Simulate 3.5% drawdown crash to test circuit breaker",
      baseVault,
      VERIFIED_MAINNET_SNAPSHOT,
    );
    expect(stress.intentType).toBe("STRESS_TEST");
    expect(stress.patch.simulateDrawdownBps).toBe(350);
    expect(stress.reply).toContain("LATCHED");
  });
});
