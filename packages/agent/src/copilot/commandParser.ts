import type { Hex } from "viem";
import { PROTOCOL_HARD_LIMITS } from "../config/networks.js";
import type { ChainTelemetrySnapshot } from "../rpc/hskTelemetry.js";
import {
  scanArbitrageOpportunities,
  type StrategyMode,
  type VaultRuntimeState,
} from "../strategy/signalEngine.js";
import {
  encodeResetCircuitBreakerCalldata,
  encodeSetPausedCalldata,
  encodeUpdateRiskPolicyCalldata,
  type RiskPolicyConfig,
} from "../vault/eip712.js";

export interface PolicyPatch {
  policy?: Partial<RiskPolicyConfig>;
  strategyMode?: StrategyMode;
  riskAppetite?: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
  targetPairs?: string[];
  paused?: boolean;
  resetCircuitBreaker?: boolean;
  simulateDrawdownBps?: number;
}

export interface OnChainActionPreview {
  functionName: string;
  argsSummary: string;
  calldata: Hex;
}

export interface CopilotResponse {
  intentType: "POLICY_UPDATE" | "PORTFOLIO_QUERY" | "ARB_SCAN" | "EMERGENCY_CONTROL" | "STRESS_TEST";
  reply: string;
  patch: PolicyPatch;
  warnings: string[];
  rejectedConstraints: string[];
  onChainActions: OnChainActionPreview[];
  appliedPolicy: RiskPolicyConfig;
}

const RISK_PRESETS: Record<"CONSERVATIVE" | "BALANCED" | "AGGRESSIVE", Partial<RiskPolicyConfig>> = {
  CONSERVATIVE: {
    maxSlippageBps: 30,
    maxPositionBps: 1500,
    dailyDrawdownCapBps: 200,
    minTradeIntervalSec: 900,
    maxDailyTrades: 12,
  },
  BALANCED: {
    maxSlippageBps: 50,
    maxPositionBps: 2500,
    dailyDrawdownCapBps: 300,
    minTradeIntervalSec: 300,
    maxDailyTrades: 24,
  },
  AGGRESSIVE: {
    maxSlippageBps: 85,
    maxPositionBps: 4000,
    dailyDrawdownCapBps: 500,
    minTradeIntervalSec: 120,
    maxDailyTrades: 48,
  },
};

function extractNumberAfter(input: string, patterns: RegExp[]): number | null {
  for (const re of patterns) {
    const match = input.match(re);
    if (match && match[1]) {
      const val = Number.parseFloat(match[1]);
      if (Number.isFinite(val)) return val;
    }
  }
  return null;
}

function extractTargetPairs(input: string): string[] {
  const normalized = input.toUpperCase();
  const pairs: string[] = [];
  if (/(?:W?HSK\s*\/\s*USDT|HSK\s+MOMENTUM|HSK\s+PAIR|WHSK)/.test(normalized)) {
    pairs.push("WHSK/USDT");
  }
  if (/(?:W?ETH\s*\/\s*USDT|WETH|\bETH\b)/.test(normalized)) {
    pairs.push("WETH/USDT");
  }
  if (/(?:W?BTC\s*\/\s*USDT|WBTC|\bBTC\b)/.test(normalized)) {
    pairs.push("WBTC/USDT");
  }
  return Array.from(new Set(pairs));
}

export function computeVaultNavUsd(vault: VaultRuntimeState, telemetry: ChainTelemetrySnapshot): number {
  const whskPrice = telemetry.whskUsdtSpot;
  return Number(
    (
      vault.balances.USDT +
      vault.balances.WHSK * whskPrice +
      vault.balances.WETH * 3240 +
      vault.balances.WBTC * 96400
    ).toFixed(2),
  );
}

export function parseAndExecuteCopilotCommand(
  rawCommand: string,
  currentVault: VaultRuntimeState,
  telemetry: ChainTelemetrySnapshot,
): CopilotResponse {
  const text = rawCommand.trim();
  const lower = text.toLowerCase();
  const warnings: string[] = [];
  const rejectedConstraints: string[] = [];
  const onChainActions: OnChainActionPreview[] = [];
  const patch: PolicyPatch = {};

  // 1. Emergency Pause / Resume / Circuit Breaker Reset
  if (/\b(emergency\s+pause|pause\s+vault|halt\s+trading|stop\s+agent|kill\s*switch)\b/.test(lower)) {
    patch.paused = true;
    onChainActions.push({
      functionName: "setPaused(bool)",
      argsSummary: "shouldPause = true",
      calldata: encodeSetPausedCalldata(true),
    });
    return {
      intentType: "EMERGENCY_CONTROL",
      reply:
        "Emergency pause armed. HorizonGuardVault.setPaused(true) calldata prepared — all autonomous EIP-712 TradeIntents are now halted while non-custodial owner withdrawals remain open.",
      patch,
      warnings,
      rejectedConstraints,
      onChainActions,
      appliedPolicy: { ...currentVault.policy },
    };
  }

  if (/\b(resume\s+trading|unpause|reset\s+circuit\s+breaker|re-enable)\b/.test(lower)) {
    if (lower.includes("circuit") || currentVault.circuitBreakerTripped) {
      patch.resetCircuitBreaker = true;
      onChainActions.push({
        functionName: "resetCircuitBreaker()",
        argsSummary: "Resets daily high-water NAV baseline & clears circuit breaker",
        calldata: encodeResetCircuitBreakerCalldata(),
      });
    }
    if (currentVault.paused || lower.includes("unpause") || lower.includes("resume")) {
      patch.paused = false;
      onChainActions.push({
        functionName: "setPaused(bool)",
        argsSummary: "shouldPause = false",
        calldata: encodeSetPausedCalldata(false),
      });
    }
    return {
      intentType: "EMERGENCY_CONTROL",
      reply:
        "Vault trading state restored. Circuit breaker reset and unpause calldata prepared with refreshed UTC daily high-water NAV baseline.",
      patch,
      warnings,
      rejectedConstraints,
      onChainActions,
      appliedPolicy: { ...currentVault.policy },
    };
  }

  // 2. Stress test simulation
  if (/\b(simulate|stress\s*test|trip\s+circuit)\b/.test(lower) && /\b(drawdown|crash|loss|circuit)\b/.test(lower)) {
    const simPct = extractNumberAfter(lower, [/(\d+(?:\.\d+)?)\s*%/]) ?? 3.4;
    const simBps = Math.round(simPct * 100);
    patch.simulateDrawdownBps = simBps;
    const willTrip = simBps >= currentVault.policy.dailyDrawdownCapBps;
    return {
      intentType: "STRESS_TEST",
      reply: willTrip
        ? `Drawdown shock simulated at -${simPct.toFixed(2)}% (${simBps} bps >= ${(currentVault.policy.dailyDrawdownCapBps / 100).toFixed(2)}% cap). HorizonGuardVault circuit breaker LATCHED — all agent swaps blocked on-chain until owner resets.`
        : `Drawdown shock simulated at -${simPct.toFixed(2)}% (${simBps} bps). Still inside ${(currentVault.policy.dailyDrawdownCapBps / 100).toFixed(2)}% daily stop-loss envelope; vault remains operational.`,
      patch,
      warnings,
      rejectedConstraints,
      onChainActions,
      appliedPolicy: { ...currentVault.policy },
    };
  }

  // 3. Arbitrage & Spread Scan Query
  if (
    /\b(scan|spot|check|find|show)\b/.test(lower) &&
    /\b(arb|arbitrage|spread|dislocation|tier|pool)\b/.test(lower) &&
    !/\b(cap|set|allocate|max|switch|change)\b/.test(lower)
  ) {
    const arbs = scanArbitrageOpportunities(telemetry, currentVault.balances.USDT, currentVault.policy.maxPositionBps);
    const best = arbs.reduce((a, b) => (b.netEdgeBps > a.netEdgeBps ? b : a), arbs[0]);
    const lines = arbs.map(
      (a) =>
        `• ${a.route}: gross ${a.grossSpreadBps} bps, fees ${a.poolFeesBps} bps, net ${a.netEdgeBps > 0 ? "+" : ""}${a.netEdgeBps} bps (${a.executable ? "EXECUTABLE" : "BELOW FEE HURDLE"})`,
    );
    return {
      intentType: "ARB_SCAN",
      reply: `HSKSwap V3 Spread Radar (Block #${telemetry.blockNumber.toLocaleString()}, Gas ${telemetry.gasPriceGwei} gwei):\n${lines.join("\n")}\nTop executable edge: ${best.route} at ${best.netEdgeBps > 0 ? "+" : ""}${best.netEdgeBps} bps net.`,
      patch,
      warnings,
      rejectedConstraints,
      onChainActions,
      appliedPolicy: { ...currentVault.policy },
    };
  }

  // 4. Portfolio / Positions / PnL Query
  if (
    /\b(show|status|report|what|how|summary)\b/.test(lower) &&
    /\b(position|pnl|profit|nav|balance|drawdown|exposure|risk)\b/.test(lower) &&
    !/\b(cap|set|allocate|limit|switch|change|tighten)\b/.test(lower)
  ) {
    const nav = computeVaultNavUsd(currentVault, telemetry);
    const headroomBps = Math.max(0, currentVault.policy.dailyDrawdownCapBps - currentVault.currentDrawdownBps);
    return {
      intentType: "PORTFOLIO_QUERY",
      reply:
        `Live Vault Telemetry (Chain ID ${telemetry.chainId} · Block #${telemetry.blockNumber.toLocaleString()}):\n` +
        `• Total Vault NAV: $${nav.toLocaleString(undefined, { minimumFractionDigits: 2 })} | Mode: ${currentVault.strategyMode} (${currentVault.riskAppetite})\n` +
        `• Holdings: ${currentVault.balances.USDT.toLocaleString()} USDT · ${currentVault.balances.WHSK.toLocaleString()} WHSK ($${(currentVault.balances.WHSK * telemetry.whskUsdtSpot).toFixed(0)}) · ${currentVault.balances.WETH} WETH · ${currentVault.balances.WBTC} WBTC\n` +
        `• Daily Stop-Loss Buffer: ${(headroomBps / 100).toFixed(2)}% remaining (${(currentVault.currentDrawdownBps / 100).toFixed(2)}% / ${(currentVault.policy.dailyDrawdownCapBps / 100).toFixed(2)}% cap)\n` +
        `• Active Guardrails: Max Slippage ${currentVault.policy.maxSlippageBps} bps · Max Position ${(currentVault.policy.maxPositionBps / 100).toFixed(1)}% · Cooldown ${currentVault.policy.minTradeIntervalSec}s · ${currentVault.dailyTradeCount}/${currentVault.policy.maxDailyTrades} daily trades.`,
      patch,
      warnings,
      rejectedConstraints,
      onChainActions,
      appliedPolicy: { ...currentVault.policy },
    };
  }

  // 5. Natural-Language Risk Policy & Strategy Mutation
  const nextPolicy: RiskPolicyConfig = { ...currentVault.policy };
  const policyChanges: string[] = [];

  // Risk appetite preset first (explicit numeric parameters below override preset defaults)
  if (/\bconservative|defensive|low\s+risk\b/.test(lower)) {
    patch.riskAppetite = "CONSERVATIVE";
    Object.assign(nextPolicy, RISK_PRESETS.CONSERVATIVE);
    policyChanges.push("Risk Appetite -> CONSERVATIVE");
  } else if (/\baggressive|high\s+risk|high\s+conviction\b/.test(lower)) {
    patch.riskAppetite = "AGGRESSIVE";
    Object.assign(nextPolicy, RISK_PRESETS.AGGRESSIVE);
    policyChanges.push("Risk Appetite -> AGGRESSIVE");
  } else if (/\bbalanced|moderate|medium\s+risk\b/.test(lower)) {
    patch.riskAppetite = "BALANCED";
    Object.assign(nextPolicy, RISK_PRESETS.BALANCED);
    policyChanges.push("Risk Appetite -> BALANCED");
  }

  // Strategy regime mode
  if (/\bmomentum|trend\b/.test(lower)) {
    patch.strategyMode = "MOMENTUM";
    policyChanges.push("Strategy -> MOMENTUM");
  } else if (/\bmean[\s-]?reversion|reversion|range\b/.test(lower)) {
    patch.strategyMode = "MEAN_REVERSION";
    policyChanges.push("Strategy -> MEAN_REVERSION");
  } else if (/\barbitrage|arb|spread\b/.test(lower)) {
    patch.strategyMode = "ARBITRAGE";
    policyChanges.push("Strategy -> ARBITRAGE");
  } else if (/\bhybrid|adaptive|multi[\s-]?strategy\b/.test(lower)) {
    patch.strategyMode = "HYBRID";
    policyChanges.push("Strategy -> HYBRID");
  }

  // Daily loss / drawdown cap
  const drawdownPct = extractNumberAfter(lower, [
    /(?:daily\s+loss|drawdown|stop[\s-]?loss)[^\d]{0,20}(\d+(?:\.\d+)?)\s*%/,
    /cap\s+(?:daily\s+)?(?:loss|drawdown)\s+(?:at|to)\s+(\d+(?:\.\d+)?)\s*%/,
  ]);
  if (drawdownPct !== null) {
    const ddBps = Math.round(drawdownPct * 100);
    if (ddBps <= 0 || ddBps > PROTOCOL_HARD_LIMITS.MAX_DRAWDOWN_BPS) {
      rejectedConstraints.push(
        `Daily drawdown cap ${drawdownPct}% violates HorizonGuardVault hard limit (0.01% - 25.00%).`,
      );
    } else {
      nextPolicy.dailyDrawdownCapBps = ddBps;
      policyChanges.push(`Daily Drawdown Cap -> ${drawdownPct.toFixed(2)}% (${ddBps} bps)`);
    }
  }

  // Max position allocation %
  const posPct = extractNumberAfter(lower, [
    /(?:allocate|position(?:\s+size)?|max\s+position|sizing)[^\d]{0,18}(\d+(?:\.\d+)?)\s*%/,
    /(\d+(?:\.\d+)?)\s*%\s+(?:max\s+)?(?:position|allocation|size)/,
  ]);
  if (posPct !== null) {
    const posBps = Math.round(posPct * 100);
    if (posBps <= 0 || posBps > PROTOCOL_HARD_LIMITS.MAX_POSITION_BPS) {
      rejectedConstraints.push(`Max position size ${posPct}% must be within 0.01% - 100%.`);
    } else {
      nextPolicy.maxPositionBps = posBps;
      policyChanges.push(`Max Position Size -> ${posPct.toFixed(1)}% (${posBps} bps)`);
      if (posBps > 5000) {
        warnings.push("Position cap above 50% increases single-swap concentration risk on HSKSwap.");
      }
    }
  }

  // Slippage cap (bps or %)
  const slipBps = extractNumberAfter(lower, [
    /(\d+(?:\.\d+)?)\s*bps\s*(?:max\s+)?slippage/,
    /slippage[^\d]{0,18}(\d+(?:\.\d+)?)\s*bps/,
  ]);
  const slipPct =
    slipBps === null
      ? extractNumberAfter(lower, [
          /slippage[^\d]{0,18}(\d+(?:\.\d+)?)\s*%/,
          /(\d+(?:\.\d+)?)\s*%\s*(?:max\s+)?slippage/,
        ])
      : null;
  const resolvedSlipBps = slipBps !== null ? Math.round(slipBps) : slipPct !== null ? Math.round(slipPct * 100) : null;

  if (resolvedSlipBps !== null) {
    if (resolvedSlipBps <= 0 || resolvedSlipBps > PROTOCOL_HARD_LIMITS.MAX_SLIPPAGE_BPS) {
      rejectedConstraints.push(
        `Requested slippage ${resolvedSlipBps} bps exceeds HorizonGuardVault HARD_MAX_SLIPPAGE_BPS (${PROTOCOL_HARD_LIMITS.MAX_SLIPPAGE_BPS} bps). Rejected on-chain.`,
      );
    } else {
      nextPolicy.maxSlippageBps = resolvedSlipBps;
      policyChanges.push(`Max Slippage -> ${resolvedSlipBps} bps (${(resolvedSlipBps / 100).toFixed(2)}%)`);
    }
  }

  // Trade frequency / cooldown
  const intervalMin = extractNumberAfter(lower, [
    /(?:every|cooldown|interval)[^\d]{0,12}(\d+(?:\.\d+)?)\s*(?:min|mins|minutes|m\b)/,
  ]);
  const intervalSec =
    intervalMin === null
      ? extractNumberAfter(lower, [/(?:every|cooldown|interval)[^\d]{0,12}(\d+)\s*(?:sec|secs|seconds|s\b)/])
      : null;

  if (intervalMin !== null || intervalSec !== null) {
    const secs = Math.max(
      PROTOCOL_HARD_LIMITS.MIN_COOLDOWN_SEC,
      Math.round(intervalMin !== null ? intervalMin * 60 : intervalSec!),
    );
    nextPolicy.minTradeIntervalSec = secs;
    policyChanges.push(`Min Trade Interval -> ${secs}s`);
  }

  const maxTrades = extractNumberAfter(lower, [
    /(?:max|limit|cap)[^\d]{0,12}(\d+)\s*(?:trades|swaps)(?:\s*(?:per|\/)\s*day)?/,
    /(\d+)\s*(?:daily\s+)?(?:trades|swaps)\s*(?:per\s+day|max|cap)/,
  ]);
  if (maxTrades !== null && maxTrades >= 1 && maxTrades <= PROTOCOL_HARD_LIMITS.MAX_DAILY_TRADES) {
    nextPolicy.maxDailyTrades = Math.round(maxTrades);
    policyChanges.push(`Max Daily Trades -> ${Math.round(maxTrades)}/day`);
  }

  // Target assets / pairs
  const pairs = extractTargetPairs(text);
  if (pairs.length > 0) {
    patch.targetPairs = pairs;
    policyChanges.push(`Target Assets -> ${pairs.join(", ")}`);
  }

  const policyMutated =
    nextPolicy.maxSlippageBps !== currentVault.policy.maxSlippageBps ||
    nextPolicy.maxPositionBps !== currentVault.policy.maxPositionBps ||
    nextPolicy.dailyDrawdownCapBps !== currentVault.policy.dailyDrawdownCapBps ||
    nextPolicy.minTradeIntervalSec !== currentVault.policy.minTradeIntervalSec ||
    nextPolicy.maxDailyTrades !== currentVault.policy.maxDailyTrades;

  if (policyMutated) {
    patch.policy = nextPolicy;
    onChainActions.push({
      functionName: "updateRiskPolicy(RiskPolicy)",
      argsSummary: `slip=${nextPolicy.maxSlippageBps}bps, pos=${nextPolicy.maxPositionBps}bps, dd=${nextPolicy.dailyDrawdownCapBps}bps, cd=${nextPolicy.minTradeIntervalSec}s, maxTrades=${nextPolicy.maxDailyTrades}`,
      calldata: encodeUpdateRiskPolicyCalldata(nextPolicy),
    });
  }

  if (policyChanges.length === 0 && rejectedConstraints.length === 0) {
    return {
      intentType: "PORTFOLIO_QUERY",
      reply:
        "No policy delta detected. Try commands like: \"Cap daily loss at 3%, allocate 25% into HSK/USDT momentum with 50bps max slippage\", \"Scan HSKSwap spread arbitrage\", or \"Show live positions and PnL\".",
      patch,
      warnings,
      rejectedConstraints,
      onChainActions,
      appliedPolicy: nextPolicy,
    };
  }

  const summaryParts: string[] = [];
  if (policyChanges.length > 0) {
    summaryParts.push(`Updated strategy & vault risk guardrails:\n• ${policyChanges.join("\n• ")}`);
  }
  if (rejectedConstraints.length > 0) {
    summaryParts.push(`On-chain invariant rejections:\n• ${rejectedConstraints.join("\n• ")}`);
  }
  if (onChainActions.length > 0) {
    summaryParts.push(
      `Ready for owner signature on HorizonGuardVault.updateRiskPolicy (Chain ID ${telemetry.chainId}).`,
    );
  }

  return {
    intentType: "POLICY_UPDATE",
    reply: summaryParts.join("\n\n"),
    patch,
    warnings,
    rejectedConstraints,
    onChainActions,
    appliedPolicy: nextPolicy,
  };
}
