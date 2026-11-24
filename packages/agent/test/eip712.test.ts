import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import {
  buildVaultDomain,
  computeSignalHash,
  computeTradeIntentDigest,
  EIP712_TRADE_INTENT_TYPES,
  encodeUpdateRiskPolicyCalldata,
  hashStrategyTag,
  type TradeIntentPayload,
} from "../src/vault/eip712.js";
import { HASHKEY_MAINNET } from "../src/config/networks.js";

describe("EIP-712 TradeIntent Parity & Calldata Encoding", () => {
  it("signs and recovers TradeIntent digest matching HorizonGuardVault EIP-712 schema", async () => {
    const account = privateKeyToAccount(
      "0x0000000000000000000000000000000000000000000000000000000000000b0b",
    );
    const vaultAddress = "0x2a07706473244BC757E10F2a9E86fB532828afe3";

    const intent: TradeIntentPayload = {
      router: HASHKEY_MAINNET.hskSwapRouter,
      tokenIn: HASHKEY_MAINNET.tokens.USDT.address,
      tokenOut: HASHKEY_MAINNET.tokens.WHSK.address,
      fee: 500,
      amountIn: 10_000_000_000n,
      minAmountOut: 99_450_250_000_000_000_000_000n,
      expectedAmountOut: 99_950_000_000_000_000_000_000n,
      maxSlippageBps: 50,
      deadline: 1_764_000_300n,
      nonce: 0n,
      strategyTag: hashStrategyTag("HSK_MOMENTUM_V1"),
      signalHash: computeSignalHash({ pair: "WHSK/USDT", rsi: 54.2, emaSlopeBps: 28 }),
    };

    const digest = computeTradeIntentDigest(intent, vaultAddress, 177);
    expect(digest).toMatch(/^0x[a-f0-9]{64}$/);

    const signature = await account.signTypedData({
      domain: buildVaultDomain(vaultAddress, 177),
      types: EIP712_TRADE_INTENT_TYPES,
      primaryType: "TradeIntent",
      message: intent,
    });

    const recovered = await recoverTypedDataAddress({
      domain: buildVaultDomain(vaultAddress, 177),
      types: EIP712_TRADE_INTENT_TYPES,
      primaryType: "TradeIntent",
      message: intent,
      signature,
    });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("encodes HorizonGuardVault.updateRiskPolicy calldata deterministically", () => {
    const data = encodeUpdateRiskPolicyCalldata({
      maxSlippageBps: 50,
      maxPositionBps: 2500,
      dailyDrawdownCapBps: 300,
      minTradeIntervalSec: 300,
      maxDailyTrades: 24,
    });
    expect(data).toMatch(/^0x[a-f0-9]{328}$/);
  });
});
