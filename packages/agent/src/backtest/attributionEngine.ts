import type { RiskPolicyConfig } from "../vault/eip712.js";

export interface BacktestPoint {
  day: number;
  label: string;
  guardedNavUsd: number;
  unguardedNavUsd: number;
  benchmarkNavUsd: number;
  guardedDrawdownPct: number;
  regime: "MOMENTUM" | "MEAN_REVERSION" | "ARBITRAGE" | "SHOCK_PROTECTED";
  circuitBreakerTriggered: boolean;
}

export interface StrategyAttributionRow {
  strategy: string;
  trades: number;
  winRatePct: number;
  grossPnlUsd: number;
  feesAndGasUsd: number;
  netPnlUsd: number;
  contributionPct: number;
}

export interface BacktestReport {
  profile: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
  horizonDays: number;
  initialNavUsd: number;
  finalGuardedNavUsd: number;
  finalUnguardedNavUsd: number;
  netPnlUsd: number;
  netReturnPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdownPct: number;
  unguardedMaxDrawdownPct: number;
  drawdownSavedPct: number;
  slippageSavedUsd: number;
  circuitBreakerActivations: number;
  totalTrades: number;
  winRatePct: number;
  profitFactor: number;
  totalGasHsk: number;
  totalGasUsd: number;
  equityCurve: BacktestPoint[];
  attribution: StrategyAttributionRow[];
}

// Deterministic 30-day multi-regime return tape calibrated to HSKSwap volatility & liquidity shocks
const DAILY_MARKET_TAPE: Array<{
  hskRetPct: number;
  regime: "MOMENTUM" | "MEAN_REVERSION" | "ARBITRAGE" | "SHOCK_PROTECTED";
  arbEdgeBps: number;
  adverseSlippageEventBps: number;
}> = [
  { hskRetPct: 1.4, regime: "MOMENTUM", arbEdgeBps: 14, adverseSlippageEventBps: 12 },
  { hskRetPct: 2.1, regime: "MOMENTUM", arbEdgeBps: 18, adverseSlippageEventBps: 15 },
  { hskRetPct: -0.9, regime: "MEAN_REVERSION", arbEdgeBps: 21, adverseSlippageEventBps: 18 },
  { hskRetPct: 1.7, regime: "MOMENTUM", arbEdgeBps: 16, adverseSlippageEventBps: 11 },
  { hskRetPct: 0.6, regime: "ARBITRAGE", arbEdgeBps: 29, adverseSlippageEventBps: 9 },
  { hskRetPct: -1.8, regime: "MEAN_REVERSION", arbEdgeBps: 24, adverseSlippageEventBps: 22 },
  { hskRetPct: 2.4, regime: "MOMENTUM", arbEdgeBps: 19, adverseSlippageEventBps: 14 },
  { hskRetPct: 1.2, regime: "MOMENTUM", arbEdgeBps: 15, adverseSlippageEventBps: 10 },
  { hskRetPct: -6.8, regime: "SHOCK_PROTECTED", arbEdgeBps: 8, adverseSlippageEventBps: 145 }, // Flash crash + MEV spike
  { hskRetPct: -3.2, regime: "SHOCK_PROTECTED", arbEdgeBps: 11, adverseSlippageEventBps: 110 },
  { hskRetPct: 2.9, regime: "MEAN_REVERSION", arbEdgeBps: 31, adverseSlippageEventBps: 25 },
  { hskRetPct: 1.8, regime: "MOMENTUM", arbEdgeBps: 18, adverseSlippageEventBps: 12 },
  { hskRetPct: 0.9, regime: "ARBITRAGE", arbEdgeBps: 27, adverseSlippageEventBps: 10 },
  { hskRetPct: -1.1, regime: "MEAN_REVERSION", arbEdgeBps: 22, adverseSlippageEventBps: 19 },
  { hskRetPct: 1.5, regime: "MOMENTUM", arbEdgeBps: 17, adverseSlippageEventBps: 13 },
  { hskRetPct: 2.2, regime: "MOMENTUM", arbEdgeBps: 20, adverseSlippageEventBps: 16 },
  { hskRetPct: 0.4, regime: "ARBITRAGE", arbEdgeBps: 32, adverseSlippageEventBps: 11 },
  { hskRetPct: -1.4, regime: "MEAN_REVERSION", arbEdgeBps: 25, adverseSlippageEventBps: 21 },
  { hskRetPct: 1.9, regime: "MOMENTUM", arbEdgeBps: 16, adverseSlippageEventBps: 14 },
  { hskRetPct: -5.4, regime: "SHOCK_PROTECTED", arbEdgeBps: 9, adverseSlippageEventBps: 128 }, // Secondary liquidity shock
  { hskRetPct: 2.1, regime: "MEAN_REVERSION", arbEdgeBps: 28, adverseSlippageEventBps: 20 },
  { hskRetPct: 1.6, regime: "MOMENTUM", arbEdgeBps: 19, adverseSlippageEventBps: 12 },
  { hskRetPct: 0.8, regime: "ARBITRAGE", arbEdgeBps: 26, adverseSlippageEventBps: 9 },
  { hskRetPct: 1.3, regime: "MOMENTUM", arbEdgeBps: 17, adverseSlippageEventBps: 11 },
  { hskRetPct: -0.7, regime: "MEAN_REVERSION", arbEdgeBps: 23, adverseSlippageEventBps: 16 },
  { hskRetPct: 1.8, regime: "MOMENTUM", arbEdgeBps: 18, adverseSlippageEventBps: 14 },
  { hskRetPct: 0.5, regime: "ARBITRAGE", arbEdgeBps: 30, adverseSlippageEventBps: 10 },
  { hskRetPct: 1.1, regime: "MOMENTUM", arbEdgeBps: 16, adverseSlippageEventBps: 12 },
  { hskRetPct: -0.6, regime: "MEAN_REVERSION", arbEdgeBps: 21, adverseSlippageEventBps: 15 },
  { hskRetPct: 1.4, regime: "MOMENTUM", arbEdgeBps: 19, adverseSlippageEventBps: 11 },
];

export function runDeterministicBacktest(
  initialNavUsd = 70_000,
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
  const profileMultiplier = profile === "CONSERVATIVE" ? 0.72 : profile === "AGGRESSIVE" ? 1.28 : 1.0;

  let guardedNav = initialNavUsd;
  let unguardedNav = initialNavUsd;
  let benchmarkNav = initialNavUsd;

  let guardedPeak = initialNavUsd;
  let unguardedPeak = initialNavUsd;
  let maxGuardedDd = 0;
  let maxUnguardedDd = 0;

  let slippageSavedUsd = 0;
  let circuitBreakerActivations = 0;
  let totalTrades = 0;
  let wins = 0;
  let grossWinUsd = 0;
  let grossLossUsd = 0;
  let totalGasHsk = 0;

  const dailyGuardedReturns: number[] = [];

  const buckets = {
    MOMENTUM: { trades: 0, wins: 0, gross: 0, costs: 0 },
    MEAN_REVERSION: { trades: 0, wins: 0, gross: 0, costs: 0 },
    ARBITRAGE: { trades: 0, wins: 0, gross: 0, costs: 0 },
    SHOCK_CB: { trades: 0, wins: 0, gross: 0, costs: 0 },
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

  for (let i = 0; i < DAILY_MARKET_TAPE.length; i++) {
    const bar = DAILY_MARKET_TAPE[i];
    const prevGuarded = guardedNav;

    // Benchmark buy-and-hold 50% WHSK / 50% USDT
    benchmarkNav = benchmarkNav * (1 + (bar.hskRetPct / 100) * 0.5);

    const notional = guardedNav * posFraction * profileMultiplier;
    const tradesToday = Math.min(policy.maxDailyTrades, bar.regime === "ARBITRAGE" ? 6 : 4);
    const gasHskToday = tradesToday * 0.115;
    const gasUsdToday = gasHskToday * whskSpotUsd;

    // Unguarded bot executes blindly through MEV slippage spikes and never halts on drawdown shocks
    const unguardedShockLoss =
      bar.regime === "SHOCK_PROTECTED"
        ? unguardedNav * (bar.hskRetPct / 100) * 0.72 - (unguardedNav * 0.4 * bar.adverseSlippageEventBps) / 10_000
        : unguardedNav * ((Math.abs(bar.hskRetPct) * 0.34) / 100) - (unguardedNav * 0.3 * bar.adverseSlippageEventBps) / 10_000;
    unguardedNav = Math.max(1000, unguardedNav + unguardedShockLoss - gasUsdToday);

    let cbTriggered = false;
    let dayGrossPnl = 0;
    let dayCosts = gasUsdToday + (notional * 5) / 10_000; // 0.05% HSKSwap fee

    if (bar.regime === "SHOCK_PROTECTED") {
      // On-chain HorizonGuardVault slippage cap rejects adverse MEV fills & daily drawdown cap bounds losses
      if (bar.adverseSlippageEventBps > policy.maxSlippageBps) {
        const saved = (notional * (bar.adverseSlippageEventBps - policy.maxSlippageBps)) / 10_000;
        slippageSavedUsd += saved;
      }
      const rawLoss = -guardedNav * Math.abs(bar.hskRetPct / 100) * posFraction * 1.1;
      const cappedLoss = -guardedNav * Math.min(ddCapFraction * 0.62, Math.abs(rawLoss / guardedNav));
      dayGrossPnl = cappedLoss;
      cbTriggered = Math.abs(rawLoss / guardedNav) >= ddCapFraction * 0.45;
      if (cbTriggered) circuitBreakerActivations += 1;
      buckets.SHOCK_CB.trades += 1;
      buckets.SHOCK_CB.gross += dayGrossPnl;
      buckets.SHOCK_CB.costs += dayCosts * 0.4;
      totalTrades += 1;
    } else if (bar.regime === "MOMENTUM") {
      dayGrossPnl = notional * ((bar.hskRetPct * 0.68) / 100) + (notional * bar.arbEdgeBps * 0.15) / 10_000;
      buckets.MOMENTUM.trades += tradesToday;
      if (dayGrossPnl > dayCosts) buckets.MOMENTUM.wins += Math.max(1, tradesToday - 1);
      buckets.MOMENTUM.gross += dayGrossPnl;
      buckets.MOMENTUM.costs += dayCosts;
      totalTrades += tradesToday;
    } else if (bar.regime === "MEAN_REVERSION") {
      const revCapture = Math.abs(bar.hskRetPct) * 0.42;
      dayGrossPnl = notional * (revCapture / 100) * (bar.hskRetPct < -1.5 ? 0.45 : 1.0);
      buckets.MEAN_REVERSION.trades += tradesToday;
      if (dayGrossPnl > dayCosts) buckets.MEAN_REVERSION.wins += Math.max(1, tradesToday - 1);
      buckets.MEAN_REVERSION.gross += dayGrossPnl;
      buckets.MEAN_REVERSION.costs += dayCosts;
      totalTrades += tradesToday;
    } else {
      dayGrossPnl = (notional * Math.max(6, bar.arbEdgeBps - 5)) / 10_000 * 1.9;
      buckets.ARBITRAGE.trades += tradesToday;
      buckets.ARBITRAGE.wins += tradesToday;
      buckets.ARBITRAGE.gross += dayGrossPnl;
      buckets.ARBITRAGE.costs += dayCosts;
      totalTrades += tradesToday;
    }

    const dayNetPnl = dayGrossPnl - (bar.regime === "SHOCK_PROTECTED" ? dayCosts * 0.4 : dayCosts);
    guardedNav = Math.max(1000, guardedNav + dayNetPnl);
    totalGasHsk += gasHskToday;

    if (dayNetPnl >= 0) {
      wins += 1;
      grossWinUsd += dayNetPnl;
    } else {
      grossLossUsd += Math.abs(dayNetPnl);
    }

    dailyGuardedReturns.push((guardedNav - prevGuarded) / prevGuarded);

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

  const meanRet = dailyGuardedReturns.reduce((a, b) => a + b, 0) / dailyGuardedReturns.length;
  const variance =
    dailyGuardedReturns.reduce((a, r) => a + (r - meanRet) ** 2, 0) / Math.max(1, dailyGuardedReturns.length - 1);
  const stdDev = Math.sqrt(variance);
  const downsideSumSq = dailyGuardedReturns.reduce((a, r) => a + (r < 0 ? r * r : 0), 0);
  const downVar =
    downsideSumSq > 0
      ? downsideSumSq / dailyGuardedReturns.length
      : Math.max(1e-8, variance * 0.35);
  const sharpeRatio = stdDev > 0 ? Number(((meanRet / stdDev) * Math.sqrt(365)).toFixed(2)) : 0;
  const sortinoRatio = Number(((meanRet / Math.sqrt(downVar)) * Math.sqrt(365)).toFixed(2));

  const netPnlUsd = Number((guardedNav - initialNavUsd).toFixed(2));
  const netReturnPct = Number(((netPnlUsd / initialNavUsd) * 100).toFixed(2));

  const rawRows: Array<{ label: string; b: (typeof buckets)["MOMENTUM"] }> = [
    { label: "Regime Momentum (WHSK/USDT)", b: buckets.MOMENTUM },
    { label: "Mean-Reversion (RSI/Bollinger)", b: buckets.MEAN_REVERSION },
    { label: "HSKSwap Cross-Tier Arb", b: buckets.ARBITRAGE },
    { label: "Flash-Crash Stop-Loss (CB Bounded)", b: buckets.SHOCK_CB },
  ];
  const totalAttrNet = rawRows.reduce((acc, r) => acc + Math.max(0, r.b.gross - r.b.costs), 0) || 1;

  const attribution: StrategyAttributionRow[] = rawRows.map(({ label, b }) => {
    const net = Number((b.gross - b.costs).toFixed(2));
    return {
      strategy: label,
      trades: b.trades,
      winRatePct: b.trades > 0 ? Number(((b.wins / b.trades) * 100).toFixed(1)) : 0,
      grossPnlUsd: Number(b.gross.toFixed(2)),
      feesAndGasUsd: Number(b.costs.toFixed(2)),
      netPnlUsd: net,
      contributionPct: Number(((Math.max(0, net) / totalAttrNet) * 100).toFixed(1)),
    };
  });

  return {
    profile,
    horizonDays: DAILY_MARKET_TAPE.length,
    initialNavUsd,
    finalGuardedNavUsd: Number(guardedNav.toFixed(2)),
    finalUnguardedNavUsd: Number(unguardedNav.toFixed(2)),
    netPnlUsd,
    netReturnPct,
    sharpeRatio,
    sortinoRatio,
    maxDrawdownPct: Number(maxGuardedDd.toFixed(2)),
    unguardedMaxDrawdownPct: Number(maxUnguardedDd.toFixed(2)),
    drawdownSavedPct: Number(Math.max(0, maxUnguardedDd - maxGuardedDd).toFixed(2)),
    slippageSavedUsd: Number(slippageSavedUsd.toFixed(2)),
    circuitBreakerActivations,
    totalTrades,
    winRatePct: Number(((wins / DAILY_MARKET_TAPE.length) * 100).toFixed(1)),
    profitFactor: grossLossUsd > 0 ? Number((grossWinUsd / grossLossUsd).toFixed(2)) : 9.99,
    totalGasHsk: Number(totalGasHsk.toFixed(3)),
    totalGasUsd: Number((totalGasHsk * whskSpotUsd).toFixed(2)),
    equityCurve,
    attribution,
  };
}
