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

function extractTargetPairs(input: string): { livePairs: string[]; unavailablePairs: string[] } {
  const normalized = input.toUpperCase();
  const livePairs: string[] = [];
  const unavailablePairs: string[] = [];
  if (/(?:W?HSK\s*\/\s*USDT|HSK\s+MOMENTUM|HSK\s+PAIR|WHSK)/.test(normalized)) {
    livePairs.push("WHSK/USDT");
  }
  if (/(?:W?ETH\s*\/\s*USDT|WETH|\bETH\b)/.test(normalized)) {
    unavailablePairs.push("WETH/USDT");
  }
  if (/(?:W?BTC\s*\/\s*USDT|WBTC|\bBTC\b)/.test(normalized)) {
    unavailablePairs.push("WBTC/USDT");
  }
  return {
    livePairs: Array.from(new Set(livePairs)),
    unavailablePairs: Array.from(new Set(unavailablePairs)),
  };
}

export function computeVaultNavUsd(vault: VaultRuntimeState, telemetry: ChainTelemetrySnapshot): number {
  const whskPrice = telemetry.whskTwapUsdt || telemetry.whskUsdtSpot;
  return Number((vault.balances.USDT + vault.balances.WHSK * whskPrice).toFixed(2));
}

/**
 * Deterministic natural-language policy compiler.
 * Translates plain-English risk parameters into ABI-encoded HorizonGuardVault calldata
 * and enforces hard Solidity ceilings before wallet signing.
 */
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
        "Emergency pause compiled. HorizonGuardVault.setPaused(true) calldata is ready for owner wallet signature — autonomous EIP-712 swaps will revert with VaultIsPaused() while owner withdrawals remain open.",
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
        "Vault recovery compiled. Circuit breaker reset and unpause calldata are ready for owner wallet signature with a refreshed UTC high-water NAV baseline.",
      patch,
      warnings,
      rejectedConstraints,
      onChainActions,
      appliedPolicy: { ...currentVault.policy },
    };
  }

  // 2. Stress test simulation
  if (/\b(simulate|stress\s*test|trip\s+circuit)\b/.test(lower) && /\b(drawdown|crash|loss|circuit)\b/.test(lower)) {
    const simPct = extractNumberAfter(lower, [/(\d+(?:\.\d+)?)\s*%/]) ?? 3.5;
    const simBps = Math.round(simPct * 100);
    patch.simulateDrawdownBps = simBps;
    const willTrip = simBps >= currentVault.policy.dailyDrawdownCapBps;
    return {
      intentType: "STRESS_TEST",
      reply: willTrip
        ? `Drawdown stress scenario simulated at -${simPct.toFixed(2)}% (${simBps} bps >= ${(currentVault.policy.dailyDrawdownCapBps / 100).toFixed(2)}% cap). Circuit breaker LATCHED — all further swaps revert with CircuitBreakerActive() until owner calls resetCircuitBreaker().`
        : `Drawdown stress scenario simulated at -${simPct.toFixed(2)}% (${simBps} bps). Still inside ${(currentVault.policy.dailyDrawdownCapBps / 100).toFixed(2)}% daily stop-loss cap; vault remains armed.`,
      patch,
      warnings,
      rejectedConstraints,
      onChainActions,
      appliedPolicy: { ...currentVault.policy },
    };
  }

  // 3. Arbitrage & Spread Scan Query (live pools only)
  if (
    /\b(scan|spot|check|find|show)\b/.test(lower) &&
    /\b(arb|arbitrage|spread|dislocation|tier|pool)\b/.test(lower) &&
    !/\b(cap|set|allocate|max|switch|change)\b/.test(lower)
  ) {
    const arbs = scanArbitrageOpportunities(telemetry, currentVault.balances.USDT, currentVault.policy.maxPositionBps);
    const live = arbs[0];
    return {
      intentType: "ARB_SCAN",
      reply:
        `HSKSwap V3 Live Spread Check (Block #${telemetry.blockNumber.toLocaleString()}, Gas ${telemetry.gasPriceGwei} gwei):\n` +
        `• ${live.route}: gross ${live.grossSpreadBps.toFixed(1)} bps, fees ${live.poolFeesBps.toFixed(1)} bps, gas ${live.gasImpactBps.toFixed(1)} bps -> net ${live.netEdgeBps > 0 ? "+" : ""}${live.netEdgeBps.toFixed(1)} bps (${live.executable ? "EXECUTABLE" : "HOLD — BELOW FEE HURDLE"})\n` +
        `• WETH/USDT & WBTC/USDT: Factory.getPool() returns address(0) on chainId 177 (excluded from execution).`,
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
        `Vault Telemetry (Chain ID ${telemetry.chainId} · Block #${telemetry.blockNumber.toLocaleString()} · ${currentVault.isLiveOnChain ? "ON-CHAIN VAULT" : "PRE-DEPLOY SANDBOX"}):\n` +
        `• Vault NAV: $${nav.toLocaleString(undefined, { minimumFractionDigits: 2 })} | Mode: ${currentVault.strategyMode} (${currentVault.riskAppetite})\n` +
        `• Live Assets: ${currentVault.balances.USDT.toLocaleString()} USDT · ${currentVault.balances.WHSK.toLocaleString()} WHSK (@ $${telemetry.whskTwapUsdt.toFixed(6)} 5m TWAP)\n` +
        `• Stop-Loss Headroom: ${(headroomBps / 100).toFixed(2)}% remaining (${(currentVault.currentDrawdownBps / 100).toFixed(2)}% / ${(currentVault.policy.dailyDrawdownCapBps / 100).toFixed(2)}% cap)\n` +
        `• Guardrails: Max Slippage ${currentVault.policy.maxSlippageBps} bps (oracle floor) · Max Pos ${(currentVault.policy.maxPositionBps / 100).toFixed(1)}% · Cooldown ${currentVault.policy.minTradeIntervalSec}s · ${currentVault.dailyTradeCount}/${currentVault.policy.maxDailyTrades} daily swaps.`,
      patch,
      warnings,
      rejectedConstraints,
      onChainActions,
      appliedPolicy: { ...currentVault.policy },
    };
  }

  // 5. Deterministic Policy & Strategy Compilation
  const nextPolicy: RiskPolicyConfig = { ...currentVault.policy };
  const policyChanges: string[] = [];

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

  const drawdownPct = extractNumberAfter(lower, [
    /(?:daily\s+loss|drawdown|stop[\s-]?loss)[^\d]{0,20}(\d+(?:\.\d+)?)\s*%/,
    /cap\s+(?:daily\s+)?(?:loss|drawdown)\s+(?:at|to)\s+(\d+(?:\.\d+)?)\s*%/,
  ]);
  if (drawdownPct !== null) {
    const ddBps = Math.round(drawdownPct * 100);
    if (ddBps <= 0 || ddBps > PROTOCOL_HARD_LIMITS.MAX_DRAWDOWN_BPS) {
      rejectedConstraints.push(
        `Daily drawdown cap ${drawdownPct}% violates HorizonGuardVault HARD_MAX_DRAWDOWN_BPS (0.01% - 25.00%).`,
      );
    } else {
      nextPolicy.dailyDrawdownCapBps = ddBps;
      policyChanges.push(`Daily Drawdown Cap -> ${drawdownPct.toFixed(2)}% (${ddBps} bps)`);
    }
  }

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

  const intervalMin = extractNumberAfter(lower, [
    /(?:every|cooldown|interval)[^\d]{0,12}(\d+(?:\.\d+)?)\s*(?:min|mins|minutes|m\b)/,
  ]);
  const intervalSec =
    intervalMin === null
      ? extractNumberAfter(lower, [/(?:every|cooldown|interval)[^\d]{0,12}(\d+)\s*(?:sec|secs|seconds|s\b)/])
      : null;

  if (intervalMin !== null || intervalSec !== null) {
    const rawSecs = Math.round(intervalMin !== null ? intervalMin * 60 : intervalSec!);
    if (rawSecs < PROTOCOL_HARD_LIMITS.MIN_COOLDOWN_SEC) {
      rejectedConstraints.push(
        `Cooldown ${rawSecs}s violates Solidity MIN_TRADE_INTERVAL_SEC (${PROTOCOL_HARD_LIMITS.MIN_COOLDOWN_SEC}s floor).`,
      );
    } else {
      nextPolicy.minTradeIntervalSec = rawSecs;
      policyChanges.push(`Min Trade Interval -> ${rawSecs}s`);
    }
  }

  const maxTrades = extractNumberAfter(lower, [
    /(?:max|limit|cap)[^\d]{0,12}(\d+)\s*(?:trades|swaps)(?:\s*(?:per|\/)\s*day)?/,
    /(\d+)\s*(?:daily\s+)?(?:trades|swaps)\s*(?:per\s+day|max|cap)/,
  ]);
  if (maxTrades !== null && maxTrades >= 1 && maxTrades <= PROTOCOL_HARD_LIMITS.MAX_DAILY_TRADES) {
    nextPolicy.maxDailyTrades = Math.round(maxTrades);
    policyChanges.push(`Max Daily Trades -> ${Math.round(maxTrades)}/day`);
  }

  const { livePairs, unavailablePairs } = extractTargetPairs(text);
  if (unavailablePairs.length > 0) {
    warnings.push(
      `Skipped ${unavailablePairs.join(", ")}: HSKSwap V3 Factory.getPool() returns address(0) on chainId 177. Active allowlist restricted to live WHSK/USDT pools.`,
    );
  }
  if (livePairs.length > 0) {
    patch.targetPairs = livePairs;
    policyChanges.push(`Target Market -> ${livePairs.join(", ")}`);
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

  if (policyChanges.length === 0 && rejectedConstraints.length === 0 && warnings.length === 0) {
    return {
      intentType: "PORTFOLIO_QUERY",
      reply:
        "Deterministic policy compiler found no policy delta. Try: \"Cap daily loss at 2.5%, allocate 20% into WHSK/USDT momentum with 40bps max slippage\", \"Scan HSKSwap spread\", or \"Show live positions and NAV\".",
      patch,
      warnings,
      rejectedConstraints,
      onChainActions,
      appliedPolicy: nextPolicy,
    };
  }

  const summaryParts: string[] = [];
  if (policyChanges.length > 0) {
    summaryParts.push(`Compiled policy changes:\n• ${policyChanges.join("\n• ")}`);
  }
  if (warnings.length > 0) {
    summaryParts.push(`Market reality notes:\n• ${warnings.join("\n• ")}`);
  }
  if (rejectedConstraints.length > 0) {
    summaryParts.push(`Solidity invariant rejections:\n• ${rejectedConstraints.join("\n• ")}`);
  }
  if (onChainActions.length > 0) {
    summaryParts.push(
      `Ready for owner wallet signature on HorizonGuardVault.updateRiskPolicy (Chain ID ${telemetry.chainId}).`,
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
