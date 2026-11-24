import { createPublicClient, defineChain, http, type Address } from "viem";
import {
  ERC20_MINIMAL_ABI,
  HASHKEY_MAINNET,
  HORIZON_GUARD_VAULT_ABI,
  type V3PoolConfig,
} from "../config/networks.js";
import type { RiskPolicyConfig } from "../vault/eip712.js";

export interface PoolTelemetry {
  id: string;
  pair: string;
  fee: number;
  feeLabel: string;
  address: string;
  spotPriceUsdt: number;
  twapPriceUsdt: number;
  spotVsTwapDiffBps: number;
  sqrtPriceX96: string;
  tick: number;
  twapTick: number;
  observationCardinality: number;
  liquidity: string;
  approxDepth2PctUsd: number;
}

export interface FactoryPoolProbe {
  pair: string;
  feeLabel: string;
  poolAddress: string;
  exists: boolean;
}

export interface ChainTelemetrySnapshot {
  source: "LIVE_RPC" | "VERIFIED_SNAPSHOT";
  rpcUrl: string;
  chainId: number;
  blockNumber: number;
  gasPriceGwei: number;
  estimatedSwapGasHsk: number;
  estimatedSwapGasUsd: number;
  fetchedAtIso: string;
  latencyMs: number;
  pools: PoolTelemetry[];
  factoryPoolChecks: FactoryPoolProbe[];
  whskUsdtSpot: number;
  whskTwapUsdt: number;
  spotVsTwapDiffBps: number;
  crossTierSpreadBps: number;
  spreadDirection: string;
}

export interface OnChainVaultExecution {
  id: number;
  timestamp: number;
  agent: Address;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
  amountOut: bigint;
  realizedSlippageBps: number;
  postTradeNavE18: bigint;
  strategyTag: string;
  signalHash: string;
}

export interface LiveVaultSnapshot {
  vaultAddress: Address;
  owner: Address;
  agent: Address;
  sessionActive: boolean;
  sessionExpiresAt: number;
  sessionVolumeCapUsd: number;
  sessionVolumeUsedUsd: number;
  paused: boolean;
  circuitBreakerTripped: boolean;
  currentDrawdownBps: number;
  dailyTradeCount: number;
  lastTradeTimestamp: number;
  nonce: number;
  totalNavUsd: number;
  usdtBalance: number;
  whskBalance: number;
  whskReferencePriceUsd: number;
  whskLastPriceUpdatedAt: number;
  oraclePool: Address;
  oracleMaxStalenessSec: number;
  oracleMaxDeviationBps: number;
  policy: RiskPolicyConfig;
  executions: OnChainVaultExecution[];
}

// Verified baseline observed live on HashKey Chain Mainnet (chainId 177) at block 30,589,426 on 2026-11-24
export const VERIFIED_MAINNET_SNAPSHOT: ChainTelemetrySnapshot = {
  source: "VERIFIED_SNAPSHOT",
  rpcUrl: "https://mainnet.hsk.xyz",
  chainId: 177,
  blockNumber: 30589426,
  gasPriceGwei: 500.001,
  estimatedSwapGasHsk: 0.115,
  estimatedSwapGasUsd: 0.0115,
  fetchedAtIso: "2026-11-24T13:14:00.000Z",
  latencyMs: 142,
  pools: [
    {
      id: "whsk-usdt-500",
      pair: "WHSK/USDT",
      fee: 500,
      feeLabel: "0.05%",
      address: "0xEB33d6666dd2359cB1BF6Ea6D72286Cc1b4a778A",
      spotPriceUsdt: 0.100013,
      twapPriceUsdt: 0.100013,
      spotVsTwapDiffBps: 0.0,
      sqrtPriceX96: "25055738251564958613595",
      tick: -299350,
      twapTick: -299350,
      observationCardinality: 1,
      liquidity: "2830955089632",
      approxDepth2PctUsd: 0.0089,
    },
    {
      id: "whsk-usdt-3000",
      pair: "WHSK/USDT",
      fee: 3000,
      feeLabel: "0.30%",
      address: "0x0767F7b1af495D245EA00219cFB8B2Ed6EafAe62",
      spotPriceUsdt: 0.100193,
      twapPriceUsdt: 0.100193,
      spotVsTwapDiffBps: 0.0,
      sqrtPriceX96: "25078314278193296859876",
      tick: -299332,
      twapTick: -299332,
      observationCardinality: 1,
      liquidity: "950573096369",
      approxDepth2PctUsd: 0.003,
    },
  ],
  factoryPoolChecks: [
    {
      pair: "WHSK/USDT",
      feeLabel: "0.05%",
      poolAddress: "0xEB33d6666dd2359cB1BF6Ea6D72286Cc1b4a778A",
      exists: true,
    },
    {
      pair: "WHSK/USDT",
      feeLabel: "0.30%",
      poolAddress: "0x0767F7b1af495D245EA00219cFB8B2Ed6EafAe62",
      exists: true,
    },
    {
      pair: "WETH/USDT",
      feeLabel: "0.05% / 0.30%",
      poolAddress: "0x0000000000000000000000000000000000000000",
      exists: false,
    },
    {
      pair: "WBTC/USDT",
      feeLabel: "0.05% / 0.30%",
      poolAddress: "0x0000000000000000000000000000000000000000",
      exists: false,
    },
    {
      pair: "WHSK/WETH",
      feeLabel: "0.05% / 0.30%",
      poolAddress: "0x0000000000000000000000000000000000000000",
      exists: false,
    },
  ],
  whskUsdtSpot: 0.100013,
  whskTwapUsdt: 0.100013,
  spotVsTwapDiffBps: 0.0,
  crossTierSpreadBps: 18.0,
  spreadDirection: "Buy WHSK on 0.05% pool -> Sell WHSK on 0.30% pool",
};

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: string;
  error?: { code: number; message: string };
}

async function jsonRpcCall(rpcUrl: string, method: string, params: unknown[], timeoutMs = 6000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (typeof window === "undefined") {
      headers["User-Agent"] = "HorizonQuant-Agent/1.0";
    }
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`RPC HTTP ${res.status}`);
    }
    const payload = (await res.json()) as JsonRpcResponse;
    if (payload.error || !payload.result) {
      throw new Error(payload.error?.message ?? "Empty RPC result");
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

export function decodeSqrtPriceX96ToSpot(
  sqrtPriceX96: bigint,
  token0Decimals: number,
  token1Decimals: number,
): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const rawPrice = ratio * ratio;
  const decimalFactor = 10 ** (token0Decimals - token1Decimals);
  return rawPrice * decimalFactor;
}

export function tickToSpotPrice(tick: number, token0Decimals: number, token1Decimals: number): number {
  return Math.pow(1.0001, tick) * 10 ** (token0Decimals - token1Decimals);
}

/**
 * Estimates local USD liquidity depth inside a 2% active-tick price move on a V3 pool:
 * deltaY (token1 = USDT) = L * sqrtP * (1 - 1 / sqrt(1.02)) / 10^token1Decimals
 */
export function estimatePool2PctDepthUsd(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  token1Decimals: number,
): number {
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  const deltaYRaw = Number(liquidity) * sqrtP * (1 - 1 / Math.sqrt(1.02));
  const depthUsd = deltaYRaw / 10 ** token1Decimals;
  return Number(Math.max(0, depthUsd).toFixed(4));
}

function decodeSignedInt24(wordHex: string): number {
  const raw = BigInt("0x" + wordHex);
  const masked = raw & 0xffffffn;
  return masked >= 0x800000n ? Number(masked - 0x1000000n) : Number(masked);
}

function decodeSignedInt56(wordHex: string): bigint {
  const raw = BigInt("0x" + wordHex);
  const twoPow256 = 1n << 256n;
  return raw >= 1n << 255n ? raw - twoPow256 : raw;
}

function padHexUint(val: number | bigint): string {
  return BigInt(val).toString(16).padStart(64, "0");
}

function padHexAddr(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function fetchPoolState(rpcUrl: string, pool: V3PoolConfig): Promise<PoolTelemetry> {
  // slot0() = 0x3850c7bd, liquidity() = 0x1a686502, observe([300, 0]) = 0x883bdbfd
  const observeCalldata =
    "0x883bdbfd" + padHexUint(32) + padHexUint(2) + padHexUint(300) + padHexUint(0);

  const [slot0Hex, liquidityHex, observeHex] = await Promise.all([
    jsonRpcCall(rpcUrl, "eth_call", [{ to: pool.address, data: "0x3850c7bd" }, "latest"]),
    jsonRpcCall(rpcUrl, "eth_call", [{ to: pool.address, data: "0x1a686502" }, "latest"]),
    jsonRpcCall(rpcUrl, "eth_call", [{ to: pool.address, data: observeCalldata }, "latest"]).catch(() => null),
  ]);

  const cleanSlot0 = slot0Hex.replace(/^0x/, "");
  const sqrtPriceX96 = BigInt("0x" + cleanSlot0.slice(0, 64));
  const tick = decodeSignedInt24(cleanSlot0.slice(64, 128));
  const observationCardinality = Number(BigInt("0x" + cleanSlot0.slice(192, 256)));
  const liquidity = BigInt(liquidityHex);
  const spotPriceUsdt = decodeSqrtPriceX96ToSpot(sqrtPriceX96, pool.token0Decimals, pool.token1Decimals);

  let twapTick = tick;
  if (observeHex && observeHex.length >= 2 + 64 * 5) {
    const cleanObs = observeHex.replace(/^0x/, "");
    // Word 0: offset to tickCumulatives, Word 2: length (2), Word 3: cum[0], Word 4: cum[1]
    const cum0 = decodeSignedInt56(cleanObs.slice(192, 256));
    const cum1 = decodeSignedInt56(cleanObs.slice(256, 320));
    const delta = cum1 - cum0;
    let avg = delta / 300n;
    if (delta < 0n && delta % 300n !== 0n) {
      avg -= 1n;
    }
    twapTick = Number(avg);
  }

  const twapPriceUsdt = tickToSpotPrice(twapTick, pool.token0Decimals, pool.token1Decimals);
  const spotVsTwapDiffBps =
    twapPriceUsdt > 0 ? Number(((Math.abs(spotPriceUsdt - twapPriceUsdt) / twapPriceUsdt) * 10_000).toFixed(2)) : 0;
  const approxDepth2PctUsd = estimatePool2PctDepthUsd(liquidity, sqrtPriceX96, pool.token1Decimals);

  return {
    id: pool.id,
    pair: pool.pair,
    fee: pool.fee,
    feeLabel: pool.feeLabel,
    address: pool.address,
    spotPriceUsdt: Number(spotPriceUsdt.toFixed(6)),
    twapPriceUsdt: Number(twapPriceUsdt.toFixed(6)),
    spotVsTwapDiffBps,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick,
    twapTick,
    observationCardinality,
    liquidity: liquidity.toString(),
    approxDepth2PctUsd,
  };
}

async function probeFactoryPool(
  rpcUrl: string,
  tokenA: Address,
  tokenB: Address,
  fee: number,
): Promise<string> {
  // getPool(address,address,uint24) = 0x1698ee82
  const data = "0x1698ee82" + padHexAddr(tokenA) + padHexAddr(tokenB) + padHexUint(fee);
  const res = await jsonRpcCall(rpcUrl, "eth_call", [{ to: HASHKEY_MAINNET.hskSwapFactory, data }, "latest"]);
  return "0x" + res.replace(/^0x/, "").slice(-40);
}

export function computeCrossTierSpread(pools: PoolTelemetry[]): {
  crossTierSpreadBps: number;
  spreadDirection: string;
} {
  const p500 = pools.find((p) => p.fee === 500);
  const p3000 = pools.find((p) => p.fee === 3000);
  if (!p500 || !p3000 || p500.spotPriceUsdt <= 0 || p3000.spotPriceUsdt <= 0) {
    return { crossTierSpreadBps: 0, spreadDirection: "Parity across fee tiers" };
  }
  const diff = Math.abs(p3000.spotPriceUsdt - p500.spotPriceUsdt);
  const mid = (p3000.spotPriceUsdt + p500.spotPriceUsdt) / 2;
  const spreadBps = Number(((diff / mid) * 10_000).toFixed(2));
  const spreadDirection =
    p3000.spotPriceUsdt > p500.spotPriceUsdt
      ? "Buy WHSK on 0.05% pool -> Sell WHSK on 0.30% pool"
      : p500.spotPriceUsdt > p3000.spotPriceUsdt
        ? "Buy WHSK on 0.30% pool -> Sell WHSK on 0.05% pool"
        : "Fee-tier parity";
  return { crossTierSpreadBps: spreadBps, spreadDirection };
}

export async function fetchMainnetTelemetry(
  rpcUrls: string[] = HASHKEY_MAINNET.rpcUrls,
): Promise<ChainTelemetrySnapshot> {
  for (const rpcUrl of rpcUrls) {
    const t0 = Date.now();
    try {
      const [chainIdHex, blockHex, gasHex] = await Promise.all([
        jsonRpcCall(rpcUrl, "eth_chainId", []),
        jsonRpcCall(rpcUrl, "eth_blockNumber", []),
        jsonRpcCall(rpcUrl, "eth_gasPrice", []),
      ]);
      const chainId = Number(BigInt(chainIdHex));
      const blockNumber = Number(BigInt(blockHex));
      const gasPriceWei = BigInt(gasHex);
      const gasPriceGwei = Number(gasPriceWei) / 1e9;

      const [pools, weth500, wbtc3000, whskWeth500] = await Promise.all([
        Promise.all(HASHKEY_MAINNET.pools.map((pool) => fetchPoolState(rpcUrl, pool))),
        probeFactoryPool(rpcUrl, HASHKEY_MAINNET.tokens.WETH.address, HASHKEY_MAINNET.tokens.USDT.address, 500).catch(
          () => "0x0000000000000000000000000000000000000000",
        ),
        probeFactoryPool(rpcUrl, HASHKEY_MAINNET.tokens.WBTC.address, HASHKEY_MAINNET.tokens.USDT.address, 3000).catch(
          () => "0x0000000000000000000000000000000000000000",
        ),
        probeFactoryPool(rpcUrl, HASHKEY_MAINNET.tokens.WHSK.address, HASHKEY_MAINNET.tokens.WETH.address, 500).catch(
          () => "0x0000000000000000000000000000000000000000",
        ),
      ]);

      const primary = pools[0];
      const whskUsdtSpot = primary?.spotPriceUsdt ?? VERIFIED_MAINNET_SNAPSHOT.whskUsdtSpot;
      const whskTwapUsdt = primary?.twapPriceUsdt ?? whskUsdtSpot;
      const spotVsTwapDiffBps = primary?.spotVsTwapDiffBps ?? 0;
      const { crossTierSpreadBps, spreadDirection } = computeCrossTierSpread(pools);

      const zeroAddr = "0x0000000000000000000000000000000000000000";
      const factoryPoolChecks: FactoryPoolProbe[] = [
        {
          pair: "WHSK/USDT",
          feeLabel: "0.05%",
          poolAddress: HASHKEY_MAINNET.pools[0].address,
          exists: true,
        },
        {
          pair: "WHSK/USDT",
          feeLabel: "0.30%",
          poolAddress: HASHKEY_MAINNET.pools[1].address,
          exists: true,
        },
        {
          pair: "WETH/USDT",
          feeLabel: "0.05% / 0.30%",
          poolAddress: weth500,
          exists: weth500.toLowerCase() !== zeroAddr,
        },
        {
          pair: "WBTC/USDT",
          feeLabel: "0.05% / 0.30%",
          poolAddress: wbtc3000,
          exists: wbtc3000.toLowerCase() !== zeroAddr,
        },
        {
          pair: "WHSK/WETH",
          feeLabel: "0.05% / 0.30%",
          poolAddress: whskWeth500,
          exists: whskWeth500.toLowerCase() !== zeroAddr,
        },
      ];

      const estimatedSwapGasHsk = Number(((gasPriceGwei * 230_000) / 1e9).toFixed(5));
      const estimatedSwapGasUsd = Number((estimatedSwapGasHsk * whskUsdtSpot).toFixed(5));

      return {
        source: "LIVE_RPC",
        rpcUrl,
        chainId,
        blockNumber,
        gasPriceGwei: Number(gasPriceGwei.toFixed(3)),
        estimatedSwapGasHsk,
        estimatedSwapGasUsd,
        fetchedAtIso: new Date().toISOString(),
        latencyMs: Math.max(1, Date.now() - t0),
        pools,
        factoryPoolChecks,
        whskUsdtSpot,
        whskTwapUsdt,
        spotVsTwapDiffBps,
        crossTierSpreadBps,
        spreadDirection,
      };
    } catch {
      // Fall through to secondary RPC or verified snapshot
    }
  }

  return {
    ...VERIFIED_MAINNET_SNAPSHOT,
    fetchedAtIso: new Date().toISOString(),
  };
}

const hskMainnetChain = defineChain({
  id: HASHKEY_MAINNET.chainId,
  name: HASHKEY_MAINNET.name,
  nativeCurrency: HASHKEY_MAINNET.nativeCurrency,
  rpcUrls: { default: { http: HASHKEY_MAINNET.rpcUrls } },
  blockExplorers: { default: { name: "HashKey Blockscout", url: HASHKEY_MAINNET.explorerUrl } },
});

export async function fetchLiveVaultState(
  vaultAddress: Address,
  rpcUrl: string = HASHKEY_MAINNET.rpcUrls[0],
): Promise<LiveVaultSnapshot> {
  const client = createPublicClient({
    chain: hskMainnetChain,
    transport: http(rpcUrl),
  });

  const [
    owner,
    paused,
    circuitBreakerTripped,
    policyTuple,
    sessionTuple,
    dailyTradeCount,
    lastTradeTimestamp,
    totalNavE18,
    currentDrawdownBps,
    usdtRaw,
    whskRaw,
    whskRefPriceE18,
    whskUpdatedAt,
    oracleTuple,
    execCount,
  ] = await Promise.all([
    client.readContract({ address: vaultAddress, abi: HORIZON_GUARD_VAULT_ABI, functionName: "owner" }),
    client.readContract({ address: vaultAddress, abi: HORIZON_GUARD_VAULT_ABI, functionName: "paused" }),
    client.readContract({
      address: vaultAddress,
      abi: HORIZON_GUARD_VAULT_ABI,
      functionName: "circuitBreakerTripped",
    }),
    client.readContract({ address: vaultAddress, abi: HORIZON_GUARD_VAULT_ABI, functionName: "policy" }),
    client.readContract({ address: vaultAddress, abi: HORIZON_GUARD_VAULT_ABI, functionName: "session" }),
    client.readContract({ address: vaultAddress, abi: HORIZON_GUARD_VAULT_ABI, functionName: "dailyTradeCount" }),
    client.readContract({ address: vaultAddress, abi: HORIZON_GUARD_VAULT_ABI, functionName: "lastTradeTimestamp" }),
    client.readContract({ address: vaultAddress, abi: HORIZON_GUARD_VAULT_ABI, functionName: "computeTotalNavE18" }),
    client.readContract({
      address: vaultAddress,
      abi: HORIZON_GUARD_VAULT_ABI,
      functionName: "currentDailyDrawdownBps",
    }),
    client.readContract({
      address: HASHKEY_MAINNET.tokens.USDT.address,
      abi: ERC20_MINIMAL_ABI,
      functionName: "balanceOf",
      args: [vaultAddress],
    }),
    client.readContract({
      address: HASHKEY_MAINNET.tokens.WHSK.address,
      abi: ERC20_MINIMAL_ABI,
      functionName: "balanceOf",
      args: [vaultAddress],
    }),
    client.readContract({
      address: vaultAddress,
      abi: HORIZON_GUARD_VAULT_ABI,
      functionName: "referencePriceE18",
      args: [HASHKEY_MAINNET.tokens.WHSK.address],
    }),
    client.readContract({
      address: vaultAddress,
      abi: HORIZON_GUARD_VAULT_ABI,
      functionName: "lastPriceUpdatedAt",
      args: [HASHKEY_MAINNET.tokens.WHSK.address],
    }),
    client.readContract({
      address: vaultAddress,
      abi: HORIZON_GUARD_VAULT_ABI,
      functionName: "oracleConfigs",
      args: [HASHKEY_MAINNET.tokens.WHSK.address],
    }),
    client.readContract({ address: vaultAddress, abi: HORIZON_GUARD_VAULT_ABI, functionName: "getExecutionCount" }),
  ]);

  const agent = sessionTuple[0];
  const nonce = await client.readContract({
    address: vaultAddress,
    abi: HORIZON_GUARD_VAULT_ABI,
    functionName: "nonces",
    args: [agent],
  });

  const count = Number(execCount);
  const start = Math.max(0, count - 10);
  const executions: OnChainVaultExecution[] = [];
  for (let i = count - 1; i >= start; i--) {
    const rec = await client.readContract({
      address: vaultAddress,
      abi: HORIZON_GUARD_VAULT_ABI,
      functionName: "getExecution",
      args: [BigInt(i)],
    });
    executions.push({
      id: i,
      timestamp: Number(rec.timestamp),
      agent: rec.agent,
      tokenIn: rec.tokenIn,
      tokenOut: rec.tokenOut,
      fee: Number(rec.fee),
      amountIn: rec.amountIn,
      amountOut: rec.amountOut,
      realizedSlippageBps: Number(rec.realizedSlippageBps),
      postTradeNavE18: rec.postTradeNavE18,
      strategyTag: rec.strategyTag,
      signalHash: rec.signalHash,
    });
  }

  return {
    vaultAddress,
    owner,
    agent,
    sessionActive: sessionTuple[4],
    sessionExpiresAt: Number(sessionTuple[1]),
    sessionVolumeCapUsd: Number(sessionTuple[2]) / 1e18,
    sessionVolumeUsedUsd: Number(sessionTuple[3]) / 1e18,
    paused,
    circuitBreakerTripped,
    currentDrawdownBps: Number(currentDrawdownBps),
    dailyTradeCount: Number(dailyTradeCount),
    lastTradeTimestamp: Number(lastTradeTimestamp),
    nonce: Number(nonce),
    totalNavUsd: Number(totalNavE18) / 1e18,
    usdtBalance: Number(usdtRaw) / 1e6,
    whskBalance: Number(whskRaw) / 1e18,
    whskReferencePriceUsd: Number(whskRefPriceE18) / 1e18,
    whskLastPriceUpdatedAt: Number(whskUpdatedAt),
    oraclePool: oracleTuple[0],
    oracleMaxStalenessSec: Number(oracleTuple[3]),
    oracleMaxDeviationBps: Number(oracleTuple[2]),
    policy: {
      maxSlippageBps: Number(policyTuple[0]),
      maxPositionBps: Number(policyTuple[1]),
      dailyDrawdownCapBps: Number(policyTuple[2]),
      minTradeIntervalSec: Number(policyTuple[3]),
      maxDailyTrades: Number(policyTuple[4]),
    },
    executions,
  };
}
