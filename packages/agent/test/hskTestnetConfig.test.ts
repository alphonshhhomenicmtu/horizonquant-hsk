import { describe, expect, it } from "vitest";
import { HASHKEY_MAINNET, HASHKEY_TESTNET } from "../src/config/networks.js";

const TESTNET_USDC = "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6";
const TESTNET_USDT = "0x372325443233fEbaC1F6998aC750276468c83CC6";
const MAINNET_USDT = "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029";
const MAINNET_USDC_E = "0x054ed45810DbBAb8B27668922D110669c9D88D0a";

describe("HashKey Chain 133 config isolation", () => {
  it("keeps testnet tokens off the mainnet 177 map", () => {
    expect(HASHKEY_TESTNET.chainId).toBe(133);
    expect(HASHKEY_MAINNET.chainId).toBe(177);
    expect(HASHKEY_TESTNET.tokens).not.toBe(HASHKEY_MAINNET.tokens);
    expect(HASHKEY_TESTNET.pools).toEqual([]);

    expect(Object.keys(HASHKEY_TESTNET.tokens).sort()).toEqual(["USDC", "USDT"]);
    expect(HASHKEY_TESTNET.tokens.USDC.address).toBe(TESTNET_USDC);
    expect(HASHKEY_TESTNET.tokens.USDC.decimals).toBe(6);
    expect(HASHKEY_TESTNET.tokens.USDC.hasLivePool).toBe(false);
    expect(HASHKEY_TESTNET.tokens.USDT.address).toBe(TESTNET_USDT);
    expect(HASHKEY_TESTNET.tokens.USDT.decimals).toBe(6);
    expect(HASHKEY_TESTNET.tokens.USDT.hasLivePool).toBe(false);

    for (const token of Object.values(HASHKEY_TESTNET.tokens)) {
      expect(token.explorerUrl.startsWith(HASHKEY_TESTNET.explorerUrl)).toBe(true);
      expect(token.explorerUrl).not.toContain("hsk.blockscout.com");
    }

    const mainnetAddresses = new Set(
      Object.values(HASHKEY_MAINNET.tokens).map((token) => token.address.toLowerCase()),
    );
    for (const token of Object.values(HASHKEY_TESTNET.tokens)) {
      expect(mainnetAddresses.has(token.address.toLowerCase())).toBe(false);
    }

    expect(HASHKEY_MAINNET.tokens.USDT.address).toBe(MAINNET_USDT);
    expect(HASHKEY_MAINNET.tokens["USDC.e"].address).toBe(MAINNET_USDC_E);
  });

  it("does not let a testnet token edit rewrite mainnet", () => {
    const mainnetUsdt = HASHKEY_MAINNET.tokens.USDT.address;
    const snapshot = HASHKEY_TESTNET.tokens.USDT.poolStatusNote;
    HASHKEY_TESTNET.tokens.USDT.poolStatusNote = `${snapshot} (isolation probe)`;
    expect(HASHKEY_MAINNET.tokens.USDT.address).toBe(mainnetUsdt);
    expect(HASHKEY_MAINNET.tokens.USDT.poolStatusNote).not.toContain("isolation probe");
    HASHKEY_TESTNET.tokens.USDT.poolStatusNote = snapshot;
  });
});
