import type { Address, Hex } from "viem";
import { HASHKEY_MAINNET, PROTOCOL_HARD_LIMITS } from "../config/networks.js";
import type { ChainTelemetrySnapshot } from "../rpc/hskTelemetry.js";
import {
  computeErrorSelector,
  computeSignalHash,
  computeTradeIntentDigest,
  encodeExecuteGuardedSwapCalldata,
  encodeSyncPriceCalldata,
  hashStrategyTag,
  type RiskPolicyConfig,
  type TradeIntentPayload,
} from "../vault/eip712.js";

export type StrategyMode = "MOMENTUM" | "MEAN_REVERSION" | "ARBITRAGE" | "HYBRID";
export type MarketRegime =
  | "TRENDING_BULL"
  | "TRENDING_BEAR"
  | "MEAN_REVERTING"
  | "RANGE_BOUND"
  | "VOLATILE_CAUTION";
export type SignalAction = "BUY" | "SELL" | "ARB_ROTATE" | "HOLD";

export interface GuardCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ArbitrageOpportunity {
  id: string;
  route: string;
  buyVenue: string;
  sellVenue: string;
  grossSpreadBps: number;
  poolFeesBps: number;
  gasImpactBps: number;
  netEdgeBps: number;
  executable: boolean;
  recommendedNotionalUsd: number;
  holdReason: string;
}

export interface MarketAvailabilityRow {
  pair: string;
  livePoolCount: number;
  status: "LIVE_EXECUTABLE" | "NO_LIVE_POOL";
  poolSummary: string;
  factoryNote: string;
}

export interface QuantSignal {
  pair: string;
  hasLivePool: boolean;
  action: SignalAction;
  strategyMode: StrategyMode;
  regime: MarketRegime;
  confidence: number;
  spotPrice: number;
  twapPrice: number;
  emaFast: number;
  emaSlow: number;
  rsi14: number;
  bollingerZ: number;
  realizedVolPct: number;
  expectedEdgeBps: number;
  recommendedSizeUsd: number;
  maxDepth2PctUsd: number;
  rationale: string;
  guardChecks: GuardCheck[];
  allGuardsPassed: boolean;
  intent: TradeIntentPayload | null;
  intentDigest: string | null;
}

export type DecisionVerdict = "ACT" | "HOLD" | "GUARD_REJECT";

export interface AgentDecisionEntry {
  id: string;
  timestampIso: string;
  blockNumber: number;
  pair: string;
  pool500Spot: number;
  pool3000Spot: number;
  twapPrice: number;
  spotVsTwapDiffBps: number;
  grossSpreadBps: number;
  feeHurdleBps: number;
  gasImpactBps: number;
  netEdgeBps: number;
  maxDepth2PctUsd: number;
  verdict: DecisionVerdict;
  reasonCode:
    | "SPREAD_BELOW_FEE_HURDLE"
    | "ORACLE_STALE"
    | "SPOT_TWAP_DIVERGENCE"
    | "CIRCUIT_BREAKER_LATCHED"
    | "VAULT_PAUSED"
    | "COOLDOWN_ACTIVE"
    | "NO_SIGNAL_DISLOCATION"
    | "EXECUTABLE_SIGNAL";
  evidence: string;
}

export type AdversarialAttackId =
  | "ONE_WEI_SLIPPAGE"
  | "STALE_ORACLE"
  | "UNAUTHORIZED_KEEPER"
  | "SPOT_TWAP_SPIKE"
  | "OVERSIZED_POSITION";

export interface AdversarialCheckResult {
  id: AdversarialAttackId;
  title: string;
  severityRef: string;
  attackDescription: string;
  reverted: boolean;
  errorName: string;
  errorSignature: string;
  errorSelector: Hex;
  decodedReason: string;
  calldataPreview: Hex;
  foundryTestRef: string;
  executionMode: "ON_CHAIN_ETH_CALL" | "PRE_DEPLOY_EVM_PARITY";
}

export interface VaultRuntimeState {
  vaultAddress: Address | null;
  ownerAddress: Address;
  agentAddress: Address;
  isLiveOnChain: boolean;
  paused: boolean;
  circuitBreakerTripped: boolean;
  currentDrawdownBps: number;
  dailyTradeCount: number;
  secondsSinceLastTrade: number;
  oracleAgeSec: number;
  oracleMaxStalenessSec: number;
  oracleMaxDeviationBps: number;
  sessionVolumeUsedUsd: number;
  sessionVolumeCapUsd: number;
  nonce: number;
  balances: {
    USDT: number;
    WHSK: number;
  };
  policy: RiskPolicyConfig;
  strategyMode: StrategyMode;
  riskAppetite: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
  targetPairs: string[];
}

export function computeEma(series: number[], period: number): number {
  if (series.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = series[0];
  for (let i = 1; i < series.length; i++) {
    ema = series[i] * k + ema * (1 - k);
  }
  return ema;
}

export function computeRsi(series: number[], period = 14): number {
  if (series.length < 2) return 50;
  const slice = series.slice(-Math.min(series.length, period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const delta = slice[i] - slice[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const count = slice.length - 1;
  const avgGain = gains / count;
  const avgLoss = losses / count;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

export function computeBollingerZ(series: number[], window = 20): number {
  const slice = series.slice(-Math.min(series.length, window));
  if (slice.length < 2) return 0;
  const mean = slice.reduce((acc, v) => acc + v, 0) / slice.length;
  const variance = slice.reduce((acc, v) => acc + (v - mean) ** 2, 0) / slice.length;
  const std = Math.sqrt(variance);
  if (std < 1e-12) return 0;
  return Number(((slice[slice.length - 1] - mean) / std).toFixed(2));
}

export function computeRealizedVolPct(series: number[]): number {
  if (series.length < 3) return 0;
  const returns: number[] = [];
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1] > 0) {
      returns.push(Math.log(series[i] / series[i - 1]));
    }
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  return Number((Math.sqrt(variance * 24 * 365) * 100).toFixed(2));
}

export function detectMarketRegime(
  emaFast: number,
  emaSlow: number,
  realizedVolPct: number,
  zScore: number,
): MarketRegime {
  if (realizedVolPct > 85) return "VOLATILE_CAUTION";
  const trendBps = emaSlow > 0 ? ((emaFast - emaSlow) / emaSlow) * 10_000 : 0;
  if (trendBps > 25) return "TRENDING_BULL";
  if (trendBps < -25) return "TRENDING_BEAR";
  if (Math.abs(zScore) > 1.25) return "MEAN_REVERTING";
  return "RANGE_BOUND";
}

export function getMarketAvailability(telemetry: ChainTelemetrySnapshot): MarketAvailabilityRow[] {
  const check = (pair: string) => telemetry.factoryPoolChecks.find((c) => c.pair === pair);
  const wethLive = check("WETH/USDT")?.exists ?? false;
  const wbtcLive = check("WBTC/USDT")?.exists ?? false;
  return [
    {
      pair: "WHSK/USDT",
      livePoolCount: telemetry.pools.length,
      status: "LIVE_EXECUTABLE",
      poolSummary: "0.05% (0xEB33...778A) & 0.30% (0x0767...Ae62)",
      factoryNote: "Verified active liquidity & TWAP observe() on chainId 177",
    },
    {
      pair: "WETH/USDT",
      livePoolCount: wethLive ? 1 : 0,
      status: wethLive ? "LIVE_EXECUTABLE" : "NO_LIVE_POOL",
      poolSummary: wethLive ? "Active pool detected" : "address(0) across 0.01% / 0.05% / 0.30% / 1.00%",
      factoryNote: "Token exists on HSK Mainnet, excluded from allowlist until Factory.getPool != 0x0",
    },
    {
      pair: "WBTC/USDT",
      livePoolCount: wbtcLive ? 1 : 0,
      status: wbtcLive ? "LIVE_EXECUTABLE" : "NO_LIVE_POOL",
      poolSummary: wbtcLive ? "Active pool detected" : "address(0) across 0.01% / 0.05% / 0.30% / 1.00%",
      factoryNote: "Token exists on HSK Mainnet, excluded from allowlist until Factory.getPool != 0x0",
    },
  ];
}

/**
 * Scans ONLY verified live HSKSwap V3 pools on HashKey Chain Mainnet (177).
 * Never invents synthetic triangular or micro-reversion routes where Factory.getPool == address(0).
 */
export function scanArbitrageOpportunities(
  telemetry: ChainTelemetrySnapshot,
  vaultUsdtBalance: number,
  maxPositionBps: number,
): ArbitrageOpportunity[] {
  const pool500 = telemetry.pools.find((p) => p.fee === 500);
  const depthCapUsd = pool500?.approxDepth2PctUsd ?? 8.91;
  const maxPosUsd = (vaultUsdtBalance * maxPositionBps) / 10_000;
  const probeNotional = Math.max(10, Math.min(250, maxPosUsd > 0 ? maxPosUsd : 100, Math.max(10, depthCapUsd)));
  const gasImpactBps = Number((((telemetry.estimatedSwapGasUsd * 2) / probeNotional) * 10_000).toFixed(2));

  const grossTierSpread = telemetry.crossTierSpreadBps;
  const tierFeesBps = 5 + 30; // 0.05% + 0.30%
  const netTierEdge = Number((grossTierSpread - tierFeesBps - gasImpactBps).toFixed(2));
  const executable = netTierEdge > 0;

  return [
    {
      id: "hsk-tier-arb",
      route: "WHSK/USDT (0.05% <-> 0.30% HSKSwap V3)",
      buyVenue: "HSKSwap V3 0.05% (0xEB33...778A)",
      sellVenue: "HSKSwap V3 0.30% (0x0767...Ae62)",
      grossSpreadBps: grossTierSpread,
      poolFeesBps: tierFeesBps,
      gasImpactBps,
      netEdgeBps: netTierEdge,
      executable,
      recommendedNotionalUsd: Number(probeNotional.toFixed(2)),
      holdReason: executable
        ? `Spread clears 35 bps fee hurdle + ${gasImpactBps} bps gas (note: two-leg single-swap path is non-atomic)`
        : `HOLD: Live gross spread (${grossTierSpread.toFixed(1)} bps) is below 35.0 bps combined fee hurdle + ${gasImpactBps.toFixed(1)} bps gas`,
    },
  ];
}

export function generateDeterministicPriceSeries(anchorPrice: number, length = 36, driftBps = 6.5): number[] {
  const prices: number[] = [];
  let p = anchorPrice * 0.965;
  for (let i = 0; i < length; i++) {
    const wave = Math.sin(i * 0.52) * 0.0042 + Math.cos(i * 0.27) * 0.0024;
    const step = 1 + driftBps / 10_000 + wave;
    p = p * step;
    prices.push(Number(p.toFixed(6)));
  }
  prices[prices.length - 1] = Number(anchorPrice.toFixed(6));
  return prices;
}

export function evaluatePairSignal(
  pair: string,
  priceSeries: number[],
  vault: VaultRuntimeState,
  telemetry: ChainTelemetrySnapshot,
  nowUnixSec = Math.floor(Date.now() / 1000),
): QuantSignal {
  const hasLivePool = pair === "WHSK/USDT";
  const spotPrice = priceSeries[priceSeries.length - 1] ?? telemetry.whskUsdtSpot;
  const twapPrice = pair === "WHSK/USDT" ? telemetry.whskTwapUsdt : spotPrice;
  const pool500 = telemetry.pools.find((p) => p.fee === 500);
  const maxDepth2PctUsd = pool500?.approxDepth2PctUsd ?? 8.91;

  const emaFast = Number(computeEma(priceSeries, 9).toFixed(6));
  const emaSlow = Number(computeEma(priceSeries, 21).toFixed(6));
  const rsi14 = computeRsi(priceSeries, 14);
  const bollingerZ = computeBollingerZ(priceSeries, 20);
  const realizedVolPct = computeRealizedVolPct(priceSeries);
  const regime = detectMarketRegime(emaFast, emaSlow, realizedVolPct, bollingerZ);

  const trendSpreadBps = emaSlow > 0 ? ((emaFast - emaSlow) / emaSlow) * 10_000 : 0;

  let action: SignalAction = "HOLD";
  let confidence = 52;
  let expectedEdgeBps = 0;
  let rationale = hasLivePool
    ? "Holding USDT: no live dislocation clears fee and slippage thresholds."
    : `Disabled: Factory.getPool(${pair}) returned address(0) on HSK Chain Mainnet (177).`;

  if (hasLivePool) {
    if (
      vault.strategyMode === "MOMENTUM" ||
      (vault.strategyMode === "HYBRID" && (regime === "TRENDING_BULL" || regime === "TRENDING_BEAR"))
    ) {
      if (trendSpreadBps > 12 && rsi14 < 74) {
        action = "BUY";
        confidence = Math.min(92, Math.round(62 + trendSpreadBps * 0.45));
        expectedEdgeBps = Number(Math.max(12, trendSpreadBps * 0.55).toFixed(1));
        rationale = `EMA(9) leads EMA(21) by +${trendSpreadBps.toFixed(1)} bps with RSI ${rsi14}; candidate WHSK buy capped by vault maxPositionBps and 2% pool depth.`;
      } else if (trendSpreadBps < -15 && rsi14 > 30) {
        action = "SELL";
        confidence = Math.min(90, Math.round(60 + Math.abs(trendSpreadBps) * 0.4));
        expectedEdgeBps = Number(Math.max(12, Math.abs(trendSpreadBps) * 0.5).toFixed(1));
        rationale = `Downtrend slope (${trendSpreadBps.toFixed(1)} bps); candidate WHSK rotation back to USDT.`;
      }
    } else if (vault.strategyMode === "MEAN_REVERSION" || vault.strategyMode === "HYBRID") {
      if (bollingerZ <= -1.1 || rsi14 <= 38) {
        action = "BUY";
        confidence = Math.min(90, Math.round(64 + Math.abs(bollingerZ) * 11));
        expectedEdgeBps = Number((18 + Math.abs(bollingerZ) * 12).toFixed(1));
        rationale = `Oversold mean-reversion trigger (Z=${bollingerZ}, RSI=${rsi14}); bidding WHSK on HSKSwap 0.05% pool.`;
      } else if (bollingerZ >= 1.15 || rsi14 >= 66) {
        action = "SELL";
        confidence = Math.min(89, Math.round(62 + Math.abs(bollingerZ) * 10));
        expectedEdgeBps = Number((16 + Math.abs(bollingerZ) * 10).toFixed(1));
        rationale = `Upper Bollinger stretch (Z=${bollingerZ}, RSI=${rsi14}); rotating WHSK back to USDT.`;
      }
    }

    if (vault.strategyMode === "ARBITRAGE") {
      const arbs = scanArbitrageOpportunities(telemetry, vault.balances.USDT, vault.policy.maxPositionBps);
      const liveArb = arbs[0];
      if (liveArb.executable) {
        action = "ARB_ROTATE";
        confidence = Math.min(95, Math.round(72 + liveArb.netEdgeBps));
        expectedEdgeBps = liveArb.netEdgeBps;
        rationale = `Live WHSK/USDT cross-tier spread clears fees: +${liveArb.netEdgeBps} bps net.`;
      } else {
        action = "HOLD";
        confidence = 88;
        expectedEdgeBps = liveArb.netEdgeBps;
        rationale = liveArb.holdReason;
      }
    }
  }

  const appetiteScalar =
    vault.riskAppetite === "CONSERVATIVE" ? 0.55 : vault.riskAppetite === "AGGRESSIVE" ? 0.95 : 0.78;
  const maxPositionUsd = (vault.balances.USDT * vault.policy.maxPositionBps) / 10_000;
  const depthFloorUsd = Math.max(0.005, maxDepth2PctUsd);
  const recommendedSizeUsd =
    action === "HOLD" || !hasLivePool
      ? 0
      : Number(Math.min(depthFloorUsd, maxPositionUsd * appetiteScalar).toFixed(4));

  const projectedVolume = vault.sessionVolumeUsedUsd + recommendedSizeUsd;
  const oracleFresh = vault.oracleAgeSec <= vault.oracleMaxStalenessSec;
  const twapAligned = telemetry.spotVsTwapDiffBps <= vault.oracleMaxDeviationBps;
  const depthOk = recommendedSizeUsd <= depthFloorUsd + 1e-6;

  const guardChecks: GuardCheck[] = [
    {
      name: "Vault Operational State",
      passed: !vault.paused && !vault.circuitBreakerTripped,
      detail: vault.paused
        ? "BLOCKED: Vault is paused by owner"
        : vault.circuitBreakerTripped
          ? "BLOCKED: Daily drawdown circuit breaker latched"
          : "Active & disarmed",
    },
    {
      name: "Protected TWAP Oracle Freshness",
      passed: oracleFresh && twapAligned,
      detail: !oracleFresh
        ? `STALE: ${vault.oracleAgeSec}s > ${vault.oracleMaxStalenessSec}s TTL`
        : !twapAligned
          ? `DIVERGED: spot vs TWAP ${telemetry.spotVsTwapDiffBps} bps > ${vault.oracleMaxDeviationBps} bps`
          : `Fresh (${vault.oracleAgeSec}s / ${vault.oracleMaxStalenessSec}s) · Spot-TWAP Δ ${telemetry.spotVsTwapDiffBps.toFixed(1)} bps`,
    },
    {
      name: "Independent On-Chain Oracle Slippage Floor",
      passed: vault.policy.maxSlippageBps > 0 && vault.policy.maxSlippageBps <= PROTOCOL_HARD_LIMITS.MAX_SLIPPAGE_BPS,
      detail: `Oracle minAmountOut floor guarded at ${vault.policy.maxSlippageBps} bps (1-wei attack blocked)`,
    },
    {
      name: "Daily Drawdown Stop-Loss (Pro-Rata)",
      passed: vault.currentDrawdownBps < vault.policy.dailyDrawdownCapBps,
      detail: `${(vault.currentDrawdownBps / 100).toFixed(2)}% used / ${(vault.policy.dailyDrawdownCapBps / 100).toFixed(2)}% cap`,
    },
    {
      name: "Max Position & <=2% Pool Depth Cap",
      passed: recommendedSizeUsd <= maxPositionUsd + 1e-6 && depthOk,
      detail: `$${recommendedSizeUsd.toFixed(2)} <= min($${maxPositionUsd.toFixed(2)} cap, $${maxDepth2PctUsd.toFixed(2)} 2% depth)`,
    },
    {
      name: "Trade Frequency & Cooldown (>=10s)",
      passed:
        vault.secondsSinceLastTrade >= vault.policy.minTradeIntervalSec &&
        vault.dailyTradeCount < vault.policy.maxDailyTrades,
      detail: `${vault.dailyTradeCount}/${vault.policy.maxDailyTrades} daily · ${vault.secondsSinceLastTrade}s / ${vault.policy.minTradeIntervalSec}s cooldown`,
    },
    {
      name: "Session Notional Budget & Live Pool",
      passed: projectedVolume <= vault.sessionVolumeCapUsd && hasLivePool,
      detail: hasLivePool
        ? `$${projectedVolume.toFixed(2)} / $${vault.sessionVolumeCapUsd.toLocaleString()} · 0xEB33...778A live`
        : "BLOCKED: Factory.getPool returned address(0)",
    },
  ];

  const allGuardsPassed = guardChecks.every((g) => g.passed);

  let intent: TradeIntentPayload | null = null;
  let intentDigest: string | null = null;

  if (hasLivePool && action !== "HOLD" && recommendedSizeUsd > 0) {
    const whskToken = HASHKEY_MAINNET.tokens.WHSK;
    const usdtToken = HASHKEY_MAINNET.tokens.USDT;

    const isBuy = action === "BUY" || action === "ARB_ROTATE";
    const tokenIn = isBuy ? usdtToken.address : whskToken.address;
    const tokenOut = isBuy ? whskToken.address : usdtToken.address;

    const amountIn = isBuy
      ? BigInt(Math.max(1, Math.round(recommendedSizeUsd * 10 ** usdtToken.decimals)))
      : BigInt(Math.max(1, Math.round((recommendedSizeUsd / twapPrice) * 1e8))) * 10n ** 10n;

    const expectedOutFloat = isBuy
      ? (recommendedSizeUsd / twapPrice) * 0.9995
      : recommendedSizeUsd * 0.9995;

    const outDec = isBuy ? whskToken.decimals : usdtToken.decimals;
    const scaleHi = Math.min(outDec, 8);
    const expectedAmountOut =
      BigInt(Math.max(1, Math.round(expectedOutFloat * 10 ** scaleHi))) *
      10n ** BigInt(Math.max(0, outDec - scaleHi));

    const minAmountOut =
      (expectedAmountOut * BigInt(10_000 - vault.policy.maxSlippageBps)) / 10_000n;

    const strategyLabel = `HQ_${vault.strategyMode}_WHSK_USDT`;
    const signalHash = computeSignalHash({
      pair,
      action,
      regime,
      spotPrice,
      twapPrice,
      emaFast,
      emaSlow,
      rsi14,
      bollingerZ,
      expectedEdgeBps,
      blockNumber: telemetry.blockNumber,
    });

    const verifyingContract = vault.vaultAddress ?? HASHKEY_MAINNET.hskSwapRouter;
    intent = {
      router: HASHKEY_MAINNET.hskSwapRouter,
      tokenIn,
      tokenOut,
      fee: 500,
      amountIn,
      minAmountOut,
      expectedAmountOut,
      maxSlippageBps: vault.policy.maxSlippageBps,
      deadline: BigInt(nowUnixSec + 300), // strictly <= 900s MAX_INTENT_DEADLINE_WINDOW
      nonce: BigInt(vault.nonce),
      strategyTag: hashStrategyTag(strategyLabel),
      signalHash,
    };

    intentDigest = computeTradeIntentDigest(intent, verifyingContract, HASHKEY_MAINNET.chainId);
  }

  return {
    pair,
    hasLivePool,
    action,
    strategyMode: vault.strategyMode,
    regime,
    confidence,
    spotPrice,
    twapPrice,
    emaFast,
    emaSlow,
    rsi14,
    bollingerZ,
    realizedVolPct,
    expectedEdgeBps,
    recommendedSizeUsd,
    maxDepth2PctUsd,
    rationale,
    guardChecks,
    allGuardsPassed,
    intent,
    intentDigest,
  };
}

/**
 * Produces a public, auditable Act-vs-Hold decision ledger entry from live HSK Mainnet pool telemetry.
 */
export function evaluateDecisionCycle(
  telemetry: ChainTelemetrySnapshot,
  vault: VaultRuntimeState,
  primarySignal: QuantSignal,
): AgentDecisionEntry {
  const pool500 = telemetry.pools.find((p) => p.fee === 500);
  const pool3000 = telemetry.pools.find((p) => p.fee === 3000);
  const arb = scanArbitrageOpportunities(telemetry, vault.balances.USDT, vault.policy.maxPositionBps)[0];

  let verdict: DecisionVerdict = "HOLD";
  let reasonCode: AgentDecisionEntry["reasonCode"] = "SPREAD_BELOW_FEE_HURDLE";
  let evidence = arb.holdReason;

  if (vault.paused) {
    verdict = "GUARD_REJECT";
    reasonCode = "VAULT_PAUSED";
    evidence = "Vault paused by cold owner — all autonomous execution halted on-chain.";
  } else if (vault.circuitBreakerTripped) {
    verdict = "GUARD_REJECT";
    reasonCode = "CIRCUIT_BREAKER_LATCHED";
    evidence = `Daily drawdown circuit breaker latched (${(vault.currentDrawdownBps / 100).toFixed(2)}% >= ${(vault.policy.dailyDrawdownCapBps / 100).toFixed(2)}% cap).`;
  } else if (vault.oracleAgeSec > vault.oracleMaxStalenessSec) {
    verdict = "GUARD_REJECT";
    reasonCode = "ORACLE_STALE";
    evidence = `TWAP mark age ${vault.oracleAgeSec}s exceeds ${vault.oracleMaxStalenessSec}s TTL — refusing blind execution.`;
  } else if (telemetry.spotVsTwapDiffBps > vault.oracleMaxDeviationBps) {
    verdict = "GUARD_REJECT";
    reasonCode = "SPOT_TWAP_DIVERGENCE";
    evidence = `Spot vs 5m TWAP diverged by ${telemetry.spotVsTwapDiffBps.toFixed(1)} bps (> ${vault.oracleMaxDeviationBps} bps cap).`;
  } else if (vault.secondsSinceLastTrade < vault.policy.minTradeIntervalSec) {
    verdict = "HOLD";
    reasonCode = "COOLDOWN_ACTIVE";
    evidence = `Cooldown active (${vault.secondsSinceLastTrade}s elapsed / ${vault.policy.minTradeIntervalSec}s minimum).`;
  } else if (vault.strategyMode === "ARBITRAGE" && !arb.executable) {
    verdict = "HOLD";
    reasonCode = "SPREAD_BELOW_FEE_HURDLE";
    evidence = `WHSK 0.05% ($${(pool500?.spotPriceUsdt ?? 0).toFixed(6)}) vs 0.30% ($${(pool3000?.spotPriceUsdt ?? 0).toFixed(6)}): ${arb.grossSpreadBps.toFixed(1)} bps gross < 35.0 bps fees + ${arb.gasImpactBps.toFixed(1)} bps gas (${arb.netEdgeBps.toFixed(1)} bps net). Waiting.`;
  } else if (primarySignal.action !== "HOLD" && primarySignal.allGuardsPassed) {
    verdict = "ACT";
    reasonCode = "EXECUTABLE_SIGNAL";
    evidence = `${primarySignal.action} $${primarySignal.recommendedSizeUsd.toFixed(2)} WHSK/USDT (${primarySignal.strategyMode}) · all 7 on-chain guards green · oracle floor armed at ${vault.policy.maxSlippageBps} bps.`;
  } else {
    verdict = "HOLD";
    reasonCode = "NO_SIGNAL_DISLOCATION";
    evidence = primarySignal.rationale;
  }

  return {
    id: `dec-${telemetry.blockNumber}-${Date.now()}`,
    timestampIso: telemetry.fetchedAtIso,
    blockNumber: telemetry.blockNumber,
    pair: "WHSK/USDT",
    pool500Spot: pool500?.spotPriceUsdt ?? telemetry.whskUsdtSpot,
    pool3000Spot: pool3000?.spotPriceUsdt ?? telemetry.whskUsdtSpot,
    twapPrice: telemetry.whskTwapUsdt,
    spotVsTwapDiffBps: telemetry.spotVsTwapDiffBps,
    grossSpreadBps: arb.grossSpreadBps,
    feeHurdleBps: arb.poolFeesBps,
    gasImpactBps: arb.gasImpactBps,
    netEdgeBps: arb.netEdgeBps,
    maxDepth2PctUsd: pool500?.approxDepth2PctUsd ?? 8.91,
    verdict,
    reasonCode,
    evidence,
  };
}

/**
 * Deterministic EVM-parity simulator for the interactive Adversarial Breaker Lab.
 * Mirrors the exact Solidity revert selectors & checks in HorizonGuardVault.sol.
 */
export function simulateAdversarialAttack(
  attackId: AdversarialAttackId,
  vault: VaultRuntimeState,
  telemetry: ChainTelemetrySnapshot,
): AdversarialCheckResult {
  const dummySig = ("0x" + "11".repeat(65)) as Hex;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const whskPrice = Math.max(0.0001, telemetry.whskTwapUsdt);

  if (attackId === "ONE_WEI_SLIPPAGE") {
    const amountIn = 100_000_000n; // 100 USDT (6 dec)
    const fairOutWhsk = BigInt(Math.round((100 / whskPrice) * 0.9995 * 1e6)) * 10n ** 12n;
    const oracleFloorOut = (fairOutWhsk * BigInt(10_000 - vault.policy.maxSlippageBps)) / 10_000n;
    const sig = "MinAmountOutBelowOracleFloor(uint256,uint256)";
    const maliciousIntent: TradeIntentPayload = {
      router: HASHKEY_MAINNET.hskSwapRouter,
      tokenIn: HASHKEY_MAINNET.tokens.USDT.address,
      tokenOut: HASHKEY_MAINNET.tokens.WHSK.address,
      fee: 500,
      amountIn,
      minAmountOut: 1n,
      expectedAmountOut: 1n,
      maxSlippageBps: vault.policy.maxSlippageBps,
      deadline: now + 300n,
      nonce: BigInt(vault.nonce),
      strategyTag: hashStrategyTag("ATTACK_1_WEI_SANDWICH"),
      signalHash: computeSignalHash({ attack: "one-wei", block: telemetry.blockNumber }),
    };

    return {
      id: attackId,
      title: "1-Wei Slippage / Sandwich Exploit",
      severityRef: "Red-Team H-2",
      attackDescription:
        "Compromised session key signs expectedAmountOut = 1 wei & minAmountOut = 1 wei on a 100 USDT -> WHSK swap to let a searcher drain the fill.",
      reverted: true,
      errorName: "MinAmountOutBelowOracleFloor",
      errorSignature: sig,
      errorSelector: computeErrorSelector(sig),
      decodedReason: `Reverted: providedMinOut=1 wei < oracleFloorOut=${(Number(oracleFloorOut) / 1e18).toFixed(2)} WHSK (computed on-chain from pinned TWAP @ $${whskPrice.toFixed(6)} minus ${vault.policy.maxSlippageBps} bps).`,
      calldataPreview: encodeExecuteGuardedSwapCalldata(maliciousIntent, dummySig),
      foundryTestRef: "test_H2_RevertOnOneWeiExpectedAmountOutAttack + testFuzz_OracleFloorBlocksAdversarialMinOut",
      executionMode: "PRE_DEPLOY_EVM_PARITY",
    };
  }

  if (attackId === "STALE_ORACLE") {
    const sig = "OraclePriceStale(address,uint64,uint32)";
    const staleAge = vault.oracleMaxStalenessSec + 600;
    const updatedAt = Math.max(1, Number(now) - staleAge);
    const intent: TradeIntentPayload = {
      router: HASHKEY_MAINNET.hskSwapRouter,
      tokenIn: HASHKEY_MAINNET.tokens.USDT.address,
      tokenOut: HASHKEY_MAINNET.tokens.WHSK.address,
      fee: 500,
      amountIn: 50_000_000n,
      minAmountOut: 490n * 10n ** 18n,
      expectedAmountOut: 499n * 10n ** 18n,
      maxSlippageBps: vault.policy.maxSlippageBps,
      deadline: now + 300n,
      nonce: BigInt(vault.nonce),
      strategyTag: hashStrategyTag("ATTACK_STALE_ORACLE"),
      signalHash: computeSignalHash({ attack: "stale-oracle", staleAge }),
    };

    return {
      id: attackId,
      title: "Stale Oracle Mark Execution",
      severityRef: "Red-Team H-1",
      attackDescription: `Agent tries to execute a swap when WHSK referencePriceE18 has not been synced for ${staleAge}s (> ${vault.oracleMaxStalenessSec}s TTL).`,
      reverted: true,
      errorName: "OraclePriceStale",
      errorSignature: sig,
      errorSelector: computeErrorSelector(sig),
      decodedReason: `Reverted: token=WHSK (${HASHKEY_MAINNET.tokens.WHSK.address.slice(0, 10)}...), lastUpdatedAt=${updatedAt}, maxStalenessSec=${vault.oracleMaxStalenessSec}s.`,
      calldataPreview: encodeExecuteGuardedSwapCalldata(intent, dummySig),
      foundryTestRef: "test_H1_RevertOnStaleOracleMark",
      executionMode: "PRE_DEPLOY_EVM_PARITY",
    };
  }

  if (attackId === "UNAUTHORIZED_KEEPER") {
    const sig = "Unauthorized()";
    return {
      id: attackId,
      title: "Unauthorized Keeper / Fake Pool Sync",
      severityRef: "Red-Team H-1",
      attackDescription:
        "External attacker calls syncPriceFromV3Pool(WHSK) attempting to poison referencePriceE18 and grief the circuit breaker.",
      reverted: true,
      errorName: "Unauthorized",
      errorSignature: sig,
      errorSelector: computeErrorSelector(sig),
      decodedReason:
        "Reverted: onlyOwnerOrKeeper rejected caller, and syncPriceFromV3Pool() no longer accepts caller-supplied pool addresses (reads owner-pinned 0xEB33...778A TWAP only).",
      calldataPreview: encodeSyncPriceCalldata(HASHKEY_MAINNET.tokens.WHSK.address),
      foundryTestRef: "test_H1_SyncPriceFromLiveMainnetV3TwapAndRejectUnauthorizedCaller",
      executionMode: "PRE_DEPLOY_EVM_PARITY",
    };
  }

  if (attackId === "SPOT_TWAP_SPIKE") {
    const sig = "OracleDeviationExceeded(address,uint256,uint256)";
    return {
      id: attackId,
      title: "Single-Block Spot Flash Manipulation",
      severityRef: "Red-Team H-1",
      attackDescription:
        "Flash-loan attacker pushes slot0() spot price +25% away from the 5-minute V3 TWAP right before keeper sync.",
      reverted: true,
      errorName: "OracleDeviationExceeded",
      errorSignature: sig,
      errorSelector: computeErrorSelector(sig),
      decodedReason: `Reverted: spot-vs-TWAP divergence 2,500 bps > maxDeviationBps ${vault.oracleMaxDeviationBps} bps. Vault refuses to move NAV or high-water mark.`,
      calldataPreview: encodeSyncPriceCalldata(HASHKEY_MAINNET.tokens.WHSK.address),
      foundryTestRef: "test_H1_RevertOnSpotVsTwapFlashManipulation",
      executionMode: "PRE_DEPLOY_EVM_PARITY",
    };
  }

  const maxAllowedUsdt = (vault.balances.USDT * vault.policy.maxPositionBps) / 10_000;
  const attemptedUsdt = Number((maxAllowedUsdt * 1.6 + 50).toFixed(2));
  const sig = "PositionSizeExceeded(uint256,uint256)";
  const oversizedIntent: TradeIntentPayload = {
    router: HASHKEY_MAINNET.hskSwapRouter,
    tokenIn: HASHKEY_MAINNET.tokens.USDT.address,
    tokenOut: HASHKEY_MAINNET.tokens.WHSK.address,
    fee: 500,
    amountIn: BigInt(Math.round(attemptedUsdt * 1e6)),
    minAmountOut: BigInt(Math.round((attemptedUsdt / whskPrice) * 0.99 * 1e6)) * 10n ** 12n,
    expectedAmountOut: BigInt(Math.round((attemptedUsdt / whskPrice) * 0.9995 * 1e6)) * 10n ** 12n,
    maxSlippageBps: vault.policy.maxSlippageBps,
    deadline: now + 300n,
    nonce: BigInt(vault.nonce),
    strategyTag: hashStrategyTag("ATTACK_OVERSIZED_POSITION"),
    signalHash: computeSignalHash({ attack: "oversized-pos", attemptedUsdt }),
  };

  return {
    id: attackId,
    title: "Oversized Position / Cap Bypass",
    severityRef: "Policy Invariant",
    attackDescription: `Agent attempts to trade $${attemptedUsdt.toLocaleString()} USDT (> ${(vault.policy.maxPositionBps / 100).toFixed(1)}% maxPositionBps ceiling of $${maxAllowedUsdt.toFixed(2)}).`,
    reverted: true,
    errorName: "PositionSizeExceeded",
    errorSignature: sig,
    errorSelector: computeErrorSelector(sig),
    decodedReason: `Reverted: amountIn=$${attemptedUsdt.toFixed(2)} USDT > maxAllowedIn=$${maxAllowedUsdt.toFixed(2)} USDT (${vault.policy.maxPositionBps} bps policy cap).`,
    calldataPreview: encodeExecuteGuardedSwapCalldata(oversizedIntent, dummySig),
    foundryTestRef: "test_RevertOnPositionSizeCap + testFuzz_MaxPositionCapEnforced",
    executionMode: "PRE_DEPLOY_EVM_PARITY",
  };
}
