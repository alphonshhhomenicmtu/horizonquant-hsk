import type { RiskPolicyConfig } from "../vault/eip712.js";

export interface BacktestPoint {
  day: number;
  label: string;
  guardedNavUsd: number;
  unguardedNavUsd: number;
  benchmarkNavUsd: number;
  guardedDrawdownPct: number;
  regime: "MOMENTUM" | "MEAN_REVERSION" | "HOLD_FEE_GUARD" | "SHOCK_PROTECTED";
  circuitBreakerTriggered: boolean;
}

export interface StrategyAttributionRow {
  strategy: string;
  trades: number;
  blockedEvents: number;
  grossPnlUsd: number;
  feesAndGasUsd: number;
  netPnlUsd: number;
  guardImpactNote: string;
}

export interface BacktestReport {
  disclaimer: string;
  profile: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
  horizonDays: number;
  initialNavUsd: number;
  finalGuardedNavUsd: number;
  finalUnguardedNavUsd: number;
  netPnlUsd: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  unguardedMaxDrawdownPct: number;
  drawdownSavedPct: number;
  slippageSavedUsd: number;
  circuitBreakerActivations: number;
  blockedAdverseSwaps: number;
  totalTrades: number;
  totalGasHsk: number;
  totalGasUsd: number;
  equityCurve: BacktestPoint[];
  attribution: StrategyAttributionRow[];
}

// Illustrative 30-day synthetic stress scenario tape (NOT a live historical backtest).
// Models normal WHSK/USDT swings plus 3 liquidity/MEV shocks to compare HorizonGuardVault caps vs an unguarded bot.
const STRESS_SCENARIO_TAPE: Array<{
  hskRetPct: number;
  regime: "MOMENTUM" | "MEAN_REVERSION" | "HOLD_FEE_GUARD" | "SHOCK_PROTECTED";
  adverseSlippageEventBps: number;
}> = [
  { hskRetPct: 0.9, regime: "MOMENTUM", adverseSlippageEventBps: 14 },
  { hskRetPct: 1.4, regime: "MOMENTUM", adverseSlippageEventBps: 18 },
  { hskRetPct: -0.8, regime: "MEAN_REVERSION", adverseSlippageEventBps: 21 },
  { hskRetPct: 0.3, regime: "HOLD_FEE_GUARD", adverseSlippageEventBps: 12 },
  { hskRetPct: -1.6, regime: "MEAN_REVERSION", adverseSlippageEventBps: 28 },
  { hskRetPct: 1.8, regime: "MOMENTUM", adverseSlippageEventBps: 16 },
  { hskRetPct: 0.4, regime: "HOLD_FEE_GUARD", adverseSlippageEventBps: 15 },
  { hskRetPct: -0.5, regime: "MEAN_REVERSION", adverseSlippageEventBps: 22 },
  { hskRetPct: -7.2, regime: "SHOCK_PROTECTED", adverseSlippageEventBps: 165 },
  { hskRetPct: -3.4, regime: "SHOCK_PROTECTED", adverseSlippageEventBps: 120 },
  { hskRetPct: 1.9, regime: "MEAN_REVERSION", adverseSlippageEventBps: 25 },
  { hskRetPct: 1.1, regime: "MOMENTUM", adverseSlippageEventBps: 14 },
  { hskRetPct: 0.2, regime: "HOLD_FEE_GUARD", adverseSlippageEventBps: 11 },
  { hskRetPct: -1.2, regime: "MEAN_REVERSION", adverseSlippageEventBps: 24 },
  { hskRetPct: 1.0, regime: "MOMENTUM", adverseSlippageEventBps: 17 },
  { hskRetPct: 1.5, regime: "MOMENTUM", adverseSlippageEventBps: 19 },
  { hskRetPct: -0.2, regime: "HOLD_FEE_GUARD", adverseSlippageEventBps: 13 },
  { hskRetPct: -1.5, regime: "MEAN_REVERSION", adverseSlippageEventBps: 26 },
  { hskRetPct: 1.2, regime: "MOMENTUM", adverseSlippageEventBps: 15 },
  { hskRetPct: -5.8, regime: "SHOCK_PROTECTED", adverseSlippageEventBps: 140 },
  { hskRetPct: 1.4, regime: "MEAN_REVERSION", adverseSlippageEventBps: 22 },
  { hskRetPct: 0.8, regime: "MOMENTUM", adverseSlippageEventBps: 14 },
  { hskRetPct: 0.1, regime: "HOLD_FEE_GUARD", adverseSlippageEventBps: 10 },
  { hskRetPct: 0.9, regime: "MOMENTUM", adverseSlippageEventBps: 13 },
  { hskRetPct: -0.9, regime: "MEAN_REVERSION", adverseSlippageEventBps: 18 },
  { hskRetPct: 1.1, regime: "MOMENTUM", adverseSlippageEventBps: 16 },
  { hskRetPct: 0.2, regime: "HOLD_FEE_GUARD", adverseSlippageEventBps: 12 },
  { hskRetPct: 0.7, regime: "MOMENTUM", adverseSlippageEventBps: 14 },
  { hskRetPct: -0.6, regime: "MEAN_REVERSION", adverseSlippageEventBps: 17 },
  { hskRetPct: 0.8, regime: "MOMENTUM", adverseSlippageEventBps: 13 },
];

export function runGuardrailStressScenario(
  initialNavUsd = 1_000,
  policy: RiskPolicyConfig = {
    maxSlippageBps: 50,
    maxPositionBps: 2500,
    dailyDrawdownCapBps: 300,
    minTradeIntervalSec: 300,
    maxDailyTrades: 24,
  },
  profile: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE" = "BALANCED",
  whskSpotUsd = 0.100013,
): BacktestReport {
  const posFraction = Math.min(1, policy.maxPositionBps / 10_000);
  const ddCapFraction = policy.dailyDrawdownCapBps / 10_000;
  const profileMultiplier = profile === "CONSERVATIVE" ? 0.65 : profile === "AGGRESSIVE" ? 1.2 : 1.0;

  let guardedNav = initialNavUsd;
  let unguardedNav = initialNavUsd;
  let benchmarkNav = initialNavUsd;

  let guardedPeak = initialNavUsd;
  let unguardedPeak = initialNavUsd;
  let maxGuardedDd = 0;
  let maxUnguardedDd = 0;

  let slippageSavedUsd = 0;
  let circuitBreakerActivations = 0;
  let blockedAdverseSwaps = 0;
  let totalTrades = 0;
  let totalGasHsk = 0;

  const buckets = {
    MOMENTUM: { trades: 0, blocked: 0, gross: 0, costs: 0 },
    MEAN_REVERSION: { trades: 0, blocked: 0, gross: 0, costs: 0 },
    HOLD_FEE_GUARD: { trades: 0, blocked: 0, gross: 0, costs: 0 },
    SHOCK_CB: { trades: 0, blocked: 0, gross: 0, costs: 0 },
  };

  const equityCurve: BacktestPoint[] = [
    {
      day: 0,
      label: "D0",
      guardedNavUsd: initialNavUsd,
      unguardedNavUsd: initialNavUsd,
      benchmarkNavUsd: initialNavUsd,
      guardedDrawdownPct: 0,
      regime: "MOMENTUM",
      circuitBreakerTriggered: false,
    },
  ];

  for (let i = 0; i < STRESS_SCENARIO_TAPE.length; i++) {
    const bar = STRESS_SCENARIO_TAPE[i];

    // 50% WHSK / 50% USDT passive hold reference
    benchmarkNav = benchmarkNav * (1 + (bar.hskRetPct / 100) * 0.5);

    const notional = Math.min(guardedNav, guardedNav * posFraction * profileMultiplier);
    const tradesToday = bar.regime === "HOLD_FEE_GUARD" ? 0 : Math.min(policy.maxDailyTrades, 2);
    const gasHskToday = tradesToday * 0.115;
    const gasUsdToday = gasHskToday * whskSpotUsd;

    // Unguarded bot executes blindly even during spread/MEV shocks without slippage floor or circuit breaker
    const unguardedNotional = unguardedNav * 0.45;
    const unguardedDayDelta =
      bar.regime === "SHOCK_PROTECTED"
        ? unguardedNav * (bar.hskRetPct / 100) * 0.65 - (unguardedNotional * bar.adverseSlippageEventBps) / 10_000
        : bar.regime === "HOLD_FEE_GUARD"
          ? -(unguardedNotional * 35) / 10_000 // unguarded bot churns unprofitable 35 bps fee spreads
          : unguardedNotional * ((bar.hskRetPct * 0.35) / 100) -
            (unguardedNotional * bar.adverseSlippageEventBps) / 10_000;
    unguardedNav = Math.max(initialNavUsd * 0.1, unguardedNav + unguardedDayDelta - 2 * 0.115 * whskSpotUsd);

    let cbTriggered = false;
    let dayGrossPnl = 0;
    let dayCosts = tradesToday > 0 ? gasUsdToday + (notional * 5) / 10_000 : 0;

    if (bar.regime === "SHOCK_PROTECTED") {
      if (bar.adverseSlippageEventBps > policy.maxSlippageBps) {
        const saved = (notional * (bar.adverseSlippageEventBps - policy.maxSlippageBps)) / 10_000;
        slippageSavedUsd += saved;
        blockedAdverseSwaps += 1;
        buckets.SHOCK_CB.blocked += 1;
      }
      // Existing spot WHSK inventory still takes mark-to-market hit up to dailyDrawdownCapBps before breaker latches
      const rawInventoryLoss = -guardedNav * Math.abs(bar.hskRetPct / 100) * (posFraction * 0.9);
      const realizedShockLoss = -guardedNav * Math.min(ddCapFraction, Math.abs(rawInventoryLoss / guardedNav));
      dayGrossPnl = realizedShockLoss;
      dayCosts = gasUsdToday * 0.5;
      cbTriggered = Math.abs(rawInventoryLoss / guardedNav) >= ddCapFraction * 0.5;
      if (cbTriggered) circuitBreakerActivations += 1;
      buckets.SHOCK_CB.trades += 1;
      buckets.SHOCK_CB.gross += dayGrossPnl;
      buckets.SHOCK_CB.costs += dayCosts;
      totalTrades += 1;
      totalGasHsk += gasHskToday * 0.5;
    } else if (bar.regime === "HOLD_FEE_GUARD") {
      // Agent Decision Ledger explicitly HOLDS when spread < 35 bps fee hurdle (zero fee bleed)
      buckets.HOLD_FEE_GUARD.blocked += 1;
      dayGrossPnl = 0;
      dayCosts = 0;
    } else if (bar.regime === "MOMENTUM") {
      dayGrossPnl = notional * ((bar.hskRetPct * 0.55) / 100);
      buckets.MOMENTUM.trades += tradesToday;
      buckets.MOMENTUM.gross += dayGrossPnl;
      buckets.MOMENTUM.costs += dayCosts;
      totalTrades += tradesToday;
      totalGasHsk += gasHskToday;
    } else {
      // Mean reversion includes both winning and losing days honestly
      const capture = bar.hskRetPct < -1.3 ? -Math.abs(bar.hskRetPct) * 0.18 : Math.abs(bar.hskRetPct) * 0.35;
      dayGrossPnl = notional * (capture / 100);
      buckets.MEAN_REVERSION.trades += tradesToday;
      buckets.MEAN_REVERSION.gross += dayGrossPnl;
      buckets.MEAN_REVERSION.costs += dayCosts;
      totalTrades += tradesToday;
      totalGasHsk += gasHskToday;
    }

    const dayNetPnl = dayGrossPnl - dayCosts;
    guardedNav = Math.max(initialNavUsd * 0.1, guardedNav + dayNetPnl);

    if (guardedNav > guardedPeak) guardedPeak = guardedNav;
    if (unguardedNav > unguardedPeak) unguardedPeak = unguardedNav;

    const gDdPct = ((guardedPeak - guardedNav) / guardedPeak) * 100;
    const uDdPct = ((unguardedPeak - unguardedNav) / unguardedPeak) * 100;
    if (gDdPct > maxGuardedDd) maxGuardedDd = gDdPct;
    if (uDdPct > maxUnguardedDd) maxUnguardedDd = uDdPct;

    equityCurve.push({
      day: i + 1,
      label: `D${i + 1}`,
      guardedNavUsd: Number(guardedNav.toFixed(2)),
      unguardedNavUsd: Number(unguardedNav.toFixed(2)),
      benchmarkNavUsd: Number(benchmarkNav.toFixed(2)),
      guardedDrawdownPct: Number(gDdPct.toFixed(2)),
      regime: bar.regime,
      circuitBreakerTriggered: cbTriggered,
    });
  }

  const netPnlUsd = Number((guardedNav - initialNavUsd).toFixed(2));
  const netReturnPct = Number(((netPnlUsd / initialNavUsd) * 100).toFixed(2));

  const attribution: StrategyAttributionRow[] = [
    {
      strategy: "WHSK/USDT Trend Sleeve (0.05% Pool)",
      trades: buckets.MOMENTUM.trades,
      blockedEvents: buckets.MOMENTUM.blocked,
      grossPnlUsd: Number(buckets.MOMENTUM.gross.toFixed(2)),
      feesAndGasUsd: Number(buckets.MOMENTUM.costs.toFixed(2)),
      netPnlUsd: Number((buckets.MOMENTUM.gross - buckets.MOMENTUM.costs).toFixed(2)),
      guardImpactNote: "Capped by maxPositionBps & 2% active pool depth",
    },
    {
      strategy: "WHSK/USDT Mean-Reversion Sleeve",
      trades: buckets.MEAN_REVERSION.trades,
      blockedEvents: buckets.MEAN_REVERSION.blocked,
      grossPnlUsd: Number(buckets.MEAN_REVERSION.gross.toFixed(2)),
      feesAndGasUsd: Number(buckets.MEAN_REVERSION.costs.toFixed(2)),
      netPnlUsd: Number((buckets.MEAN_REVERSION.gross - buckets.MEAN_REVERSION.costs).toFixed(2)),
      guardImpactNote: "Includes negative whipsaw days when spot overshoots",
    },
    {
      strategy: "Cross-Tier Spread Hold Guard (0.05% vs 0.30%)",
      trades: buckets.HOLD_FEE_GUARD.trades,
      blockedEvents: buckets.HOLD_FEE_GUARD.blocked,
      grossPnlUsd: 0,
      feesAndGasUsd: 0,
      netPnlUsd: 0,
      guardImpactNote: "Explicitly HELD when gross spread < 35 bps fee hurdle (avoided churn)",
    },
    {
      strategy: "Shock Days — Oracle Slippage Floor & Circuit Breaker",
      trades: buckets.SHOCK_CB.trades,
      blockedEvents: buckets.SHOCK_CB.blocked,
      grossPnlUsd: Number(buckets.SHOCK_CB.gross.toFixed(2)),
      feesAndGasUsd: Number(buckets.SHOCK_CB.costs.toFixed(2)),
      netPnlUsd: Number((buckets.SHOCK_CB.gross - buckets.SHOCK_CB.costs).toFixed(2)),
      guardImpactNote: `Blocked ${blockedAdverseSwaps} MEV slippage spikes; tripped CB ${circuitBreakerActivations}x`,
    },
  ];

  return {
    disclaimer:
      "Illustrative 30-day synthetic stress scenario modeling HorizonGuardVault drawdown & slippage caps against an unguarded bot — not a historical live trading backtest.",
    profile,
    horizonDays: STRESS_SCENARIO_TAPE.length,
    initialNavUsd,
    finalGuardedNavUsd: Number(guardedNav.toFixed(2)),
    finalUnguardedNavUsd: Number(unguardedNav.toFixed(2)),
    netPnlUsd,
    netReturnPct,
    maxDrawdownPct: Number(maxGuardedDd.toFixed(2)),
    unguardedMaxDrawdownPct: Number(maxUnguardedDd.toFixed(2)),
    drawdownSavedPct: Number(Math.max(0, maxUnguardedDd - maxGuardedDd).toFixed(2)),
    slippageSavedUsd: Number(slippageSavedUsd.toFixed(2)),
    circuitBreakerActivations,
    blockedAdverseSwaps,
    totalTrades,
    totalGasHsk: Number(totalGasHsk.toFixed(3)),
    totalGasUsd: Number((totalGasHsk * whskSpotUsd).toFixed(2)),
    equityCurve,
    attribution,
  };
}

// Backward-compatible export alias
export const runDeterministicBacktest = runGuardrailStressScenario;
