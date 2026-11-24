import { describe, expect, it } from "vitest";
import { parseAndExecuteCopilotCommand } from "../src/copilot/commandParser.js";
import { VERIFIED_MAINNET_SNAPSHOT } from "../src/rpc/hskTelemetry.js";
import type { VaultRuntimeState } from "../src/strategy/signalEngine.js";

const baseVault: VaultRuntimeState = {
  vaultAddress: null,
  ownerAddress: "0x57A46E4E5F538452E4D672EF9D48e3e90E10A81C",
  agentAddress: "0x000000000000000000000000000000000000dEaD",
  isLiveOnChain: false,
  paused: false,
  circuitBreakerTripped: false,
  currentDrawdownBps: 45,
  dailyTradeCount: 2,
  secondsSinceLastTrade: 360,
  oracleAgeSec: 45,
  oracleMaxStalenessSec: 3600,
  oracleMaxDeviationBps: 1000,
  sessionVolumeUsedUsd: 120,
  sessionVolumeCapUsd: 1_000,
  nonce: 2,
  balances: { USDT: 500, WHSK: 5_000 },
  policy: {
    maxSlippageBps: 50,
    maxPositionBps: 2500,
    dailyDrawdownCapBps: 300,
    minTradeIntervalSec: 300,
    maxDailyTrades: 24,
  },
  strategyMode: "HYBRID",
  riskAppetite: "BALANCED",
  targetPairs: ["WHSK/USDT"],
};

describe("Deterministic Policy Compiler", () => {
  it("compiles flagship risk directive into ABI calldata", () => {
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

  it("rejects slippage above HARD_MAX_SLIPPAGE_BPS (500 bps) and sub-10s cooldowns", () => {
    const res = parseAndExecuteCopilotCommand(
      "Set max slippage to 800bps, cooldown 3 seconds, allocate 30%",
      baseVault,
      VERIFIED_MAINNET_SNAPSHOT,
    );

    expect(res.rejectedConstraints.length).toBe(2);
    expect(res.rejectedConstraints[0]).toContain("HARD_MAX_SLIPPAGE_BPS");
    expect(res.rejectedConstraints[1]).toContain("MIN_TRADE_INTERVAL_SEC");
    expect(res.appliedPolicy.maxSlippageBps).toBe(50);
    expect(res.appliedPolicy.minTradeIntervalSec).toBe(300);
    expect(res.appliedPolicy.maxPositionBps).toBe(3000);
  });

  it("warns when targeting WETH/USDT or WBTC/USDT where Factory.getPool returns address(0)", () => {
    const res = parseAndExecuteCopilotCommand(
      "Switch to conservative mean-reversion on WHSK/USDT and WETH/USDT, trade every 15 minutes, max 10 trades per day",
      baseVault,
      VERIFIED_MAINNET_SNAPSHOT,
    );

    expect(res.patch.riskAppetite).toBe("CONSERVATIVE");
    expect(res.patch.strategyMode).toBe("MEAN_REVERSION");
    expect(res.patch.targetPairs).toEqual(["WHSK/USDT"]);
    expect(res.warnings.length).toBeGreaterThanOrEqual(1);
    expect(res.warnings[0]).toContain("WETH/USDT");
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

  it("answers live positions, NAV, and honest cross-tier spread queries", () => {
    const pos = parseAndExecuteCopilotCommand(
      "Show live positions, NAV, and drawdown buffer",
      baseVault,
      VERIFIED_MAINNET_SNAPSHOT,
    );
    expect(pos.intentType).toBe("PORTFOLIO_QUERY");
    expect(pos.reply).toContain("Vault NAV");

    const arb = parseAndExecuteCopilotCommand(
      "Scan HSKSwap spread arbitrage opportunities",
      baseVault,
      VERIFIED_MAINNET_SNAPSHOT,
    );
    expect(arb.intentType).toBe("ARB_SCAN");
    expect(arb.reply).toContain("HOLD — BELOW FEE HURDLE");
    expect(arb.reply).toContain("address(0)");
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
