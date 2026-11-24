import type { Address } from "viem";

export interface TokenConfig {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  referenceUsd: number;
  explorerUrl: string;
}

export interface V3PoolConfig {
  id: string;
  pair: string;
  token0Symbol: string;
  token1Symbol: string;
  token0: Address;
  token1: Address;
  token0Decimals: number;
  token1Decimals: number;
  fee: number;
  feeLabel: string;
  address: Address;
}

export interface NetworkConfig {
  name: string;
  shortName: string;
  chainId: number;
  rpcUrls: string[];
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  hskSwapRouter: Address;
  hskSwapFactory: Address;
  estimatedDeployGasHsk: string;
  tokens: Record<string, TokenConfig>;
  pools: V3PoolConfig[];
}

export const HASHKEY_MAINNET: NetworkConfig = {
  name: "HashKey Chain Mainnet",
  shortName: "HSK Mainnet",
  chainId: 177,
  rpcUrls: ["https://mainnet.hsk.xyz", "https://hashkey.drpc.org"],
  explorerUrl: "https://hsk.blockscout.com",
  nativeCurrency: { name: "HashKey Platform Token", symbol: "HSK", decimals: 18 },
  // Verified live Uniswap V3 SwapRouter (v1 ABI with deadline) on HashKey Chain Mainnet
  hskSwapRouter: "0x1f3858C46F8F6fE76260b8208995D228C5cddc64",
  hskSwapFactory: "0xD136e36610f35E0Cc3cAd40de858c151f2AA65D4",
  estimatedDeployGasHsk: "3.0 - 5.0 HSK",
  tokens: {
    WHSK: {
      symbol: "WHSK",
      name: "Wrapped HSK",
      address: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
      decimals: 18,
      referenceUsd: 0.100013,
      explorerUrl: "https://hsk.blockscout.com/address/0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
    },
    USDT: {
      symbol: "USDT",
      name: "Tether USD",
      address: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029",
      decimals: 6,
      referenceUsd: 1.0,
      explorerUrl: "https://hsk.blockscout.com/address/0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029",
    },
    WETH: {
      symbol: "WETH",
      name: "Wrapped Ether",
      address: "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0",
      decimals: 18,
      referenceUsd: 3240.0,
      explorerUrl: "https://hsk.blockscout.com/address/0xefd4bC9afD210517803f293ABABd701CaeeCdfd0",
    },
    WBTC: {
      symbol: "WBTC",
      name: "Wrapped Bitcoin",
      address: "0x6119ca49a79f5825c8b345f8d7ac36b272565b14",
      decimals: 8,
      referenceUsd: 96400.0,
      explorerUrl: "https://hsk.blockscout.com/address/0x6119ca49a79f5825c8b345f8d7ac36b272565b14",
    },
    "USDC.e": {
      symbol: "USDC.e",
      name: "Bridged USDC",
      address: "0x054ed45810DbBAb8B27668922D110669c9D88D0a",
      decimals: 6,
      referenceUsd: 1.0,
      explorerUrl: "https://hsk.blockscout.com/address/0x054ed45810DbBAb8B27668922D110669c9D88D0a",
    },
  },
  pools: [
    {
      id: "whsk-usdt-500",
      pair: "WHSK/USDT",
      token0Symbol: "WHSK",
      token1Symbol: "USDT",
      token0: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
      token1: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029",
      token0Decimals: 18,
      token1Decimals: 6,
      fee: 500,
      feeLabel: "0.05%",
      address: "0xEB33d6666dd2359cB1BF6Ea6D72286Cc1b4a778A",
    },
    {
      id: "whsk-usdt-3000",
      pair: "WHSK/USDT",
      token0Symbol: "WHSK",
      token1Symbol: "USDT",
      token0: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
      token1: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029",
      token0Decimals: 18,
      token1Decimals: 6,
      fee: 3000,
      feeLabel: "0.30%",
      address: "0x0767F7b1af495D245EA00219cFB8B2Ed6EafAe62",
    },
  ],
};

export const HASHKEY_TESTNET: NetworkConfig = {
  name: "HashKey Chain Testnet",
  shortName: "HSK Testnet",
  chainId: 133,
  rpcUrls: ["https://testnet.hsk.xyz", "https://hashkey-testnet.drpc.org"],
  explorerUrl: "https://testnet-explorer.hskchain.net",
  nativeCurrency: { name: "HashKey Testnet HSK", symbol: "HSK", decimals: 18 },
  hskSwapRouter: "0x1f3858C46F8F6fE76260b8208995D228C5cddc64",
  hskSwapFactory: "0xD136e36610f35E0Cc3cAd40de858c151f2AA65D4",
  estimatedDeployGasHsk: "0.05 - 0.15 HSK",
  tokens: HASHKEY_MAINNET.tokens,
  pools: [],
};

export const PROTOCOL_HARD_LIMITS = {
  MAX_SLIPPAGE_BPS: 500,
  MAX_DRAWDOWN_BPS: 2500,
  MAX_POSITION_BPS: 10000,
  MIN_COOLDOWN_SEC: 10,
  MAX_DAILY_TRADES: 200,
} as const;

export const HORIZON_GUARD_VAULT_ABI = [
  {
    type: "function",
    name: "updateRiskPolicy",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "newPolicy",
        type: "tuple",
        components: [
          { name: "maxSlippageBps", type: "uint16" },
          { name: "maxPositionBps", type: "uint16" },
          { name: "dailyDrawdownCapBps", type: "uint16" },
          { name: "minTradeIntervalSec", type: "uint32" },
          { name: "maxDailyTrades", type: "uint32" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setPaused",
    stateMutability: "nonpayable",
    inputs: [{ name: "shouldPause", type: "bool" }],
    outputs: [],
  },
  {
    type: "function",
    name: "resetCircuitBreaker",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "setAllowedPair",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeGuardedSwap",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "router", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "amountIn", type: "uint256" },
          { name: "minAmountOut", type: "uint256" },
          { name: "expectedAmountOut", type: "uint256" },
          { name: "maxSlippageBps", type: "uint16" },
          { name: "deadline", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "strategyTag", type: "bytes32" },
          { name: "signalHash", type: "bytes32" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "syncPriceFromV3Pool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "pool", type: "address" },
    ],
    outputs: [{ name: "priceE18", type: "uint256" }],
  },
] as const;
