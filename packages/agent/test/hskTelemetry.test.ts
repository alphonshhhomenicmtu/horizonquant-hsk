import { describe, expect, it } from "vitest";
import {
  computeCrossTierSpread,
  decodeSqrtPriceX96ToSpot,
  VERIFIED_MAINNET_SNAPSHOT,
} from "../src/rpc/hskTelemetry.js";

describe("HashKey Chain Telemetry & HSKSwap V3 Math", () => {
  it("computes cross-fee-tier spread bps accurately between 0.05% and 0.30% WHSK/USDT pools", () => {
    const res = computeCrossTierSpread(VERIFIED_MAINNET_SNAPSHOT.pools);
    expect(res.crossTierSpreadBps).toBeCloseTo(17.98, 1);
    expect(res.spreadDirection).toContain("0.05% pool -> Sell WHSK on 0.30% pool");
  });

  it("handles reversed fee-tier spread direction cleanly", () => {
    const reversed = [
      { ...VERIFIED_MAINNET_SNAPSHOT.pools[0], spotPriceUsdt: 0.1005 },
      { ...VERIFIED_MAINNET_SNAPSHOT.pools[1], spotPriceUsdt: 0.1000 },
    ];
    const res = computeCrossTierSpread(reversed);
    expect(res.crossTierSpreadBps).toBeCloseTo(49.88, 1);
    expect(res.spreadDirection).toContain("0.30% pool -> Sell WHSK on 0.05% pool");
  });

  it("decodes Uniswap V3 sqrtPriceX96 across decimal pairs without precision loss", () => {
    const whskSpot = decodeSqrtPriceX96ToSpot(25055738251564958613595n, 18, 6);
    expect(whskSpot).toBeCloseTo(0.100013, 5);
  });
});
