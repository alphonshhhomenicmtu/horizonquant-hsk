import type { Address } from "viem";

export interface TokenConfig {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  referenceUsd: number;
  hasLivePool: boolean;
  poolStatusNote: string;
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
  deployerAddress: Address;
  deployedVaultAddress: Address | null;
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
  // Funding target EOA ready for one-command broadcast once ~3-5 HSK lands
  deployerAddress: "0x57A46E4E5F538452E4D672EF9D48e3e90E10A81C",
  deployedVaultAddress: null,
  estimatedDeployGasHsk: "3.0 - 5.0 HSK",
  tokens: {
    WHSK: {
      symbol: "WHSK",
      name: "Wrapped HSK",
      address: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
      decimals: 18,
      referenceUsd: 0.100013,
      hasLivePool: true,
      poolStatusNote: "Live on HSKSwap V3 (0.05% & 0.30% pools verified via Factory.getPool)",
      explorerUrl: "https://hsk.blockscout.com/address/0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
    },
    USDT: {
      symbol: "USDT",
      name: "Tether USD",
      address: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029",
      decimals: 6,
      referenceUsd: 1.0,
      hasLivePool: true,
      poolStatusNote: "Quote settlement asset for live WHSK/USDT pools",
      explorerUrl: "https://hsk.blockscout.com/address/0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029",
    },
    WETH: {
      symbol: "WETH",
      name: "Wrapped Ether",
      address: "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0",
      decimals: 18,
      referenceUsd: 0,
      hasLivePool: false,
      poolStatusNote: "No live HSKSwap V3 pool on chainId 177 (Factory.getPool returns address(0))",
      explorerUrl: "https://hsk.blockscout.com/address/0xefd4bC9afD210517803f293ABABd701CaeeCdfd0",
    },
    WBTC: {
      symbol: "WBTC",
      name: "Wrapped Bitcoin",
      address: "0x6119ca49a79f5825c8b345f8d7ac36b272565b14",
      decimals: 8,
      referenceUsd: 0,
      hasLivePool: false,
      poolStatusNote: "No live HSKSwap V3 pool on chainId 177 (Factory.getPool returns address(0))",
      explorerUrl: "https://hsk.blockscout.com/address/0x6119ca49a79f5825c8b345f8d7ac36b272565b14",
    },
    "USDC.e": {
      symbol: "USDC.e",
      name: "Bridged USDC",
      address: "0x054ed45810DbBAb8B27668922D110669c9D88D0a",
      decimals: 6,
      referenceUsd: 1.0,
      hasLivePool: false,
      poolStatusNote: "No live HSKSwap V3 pool on chainId 177 (Factory.getPool returns address(0))",
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
  deployerAddress: "0x57A46E4E5F538452E4D672EF9D48e3e90E10A81C",
  deployedVaultAddress: null,
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
  MAX_INTENT_DEADLINE_SEC: 900,
  DEFAULT_MAX_STALENESS_SEC: 3600,
  MAX_POOL_DEPTH_PCT: 2,
  MAX_ORACLE_DEVIATION_BPS: 1000,
} as const;

export const ERC20_MINIMAL_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const HORIZON_GUARD_VAULT_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "circuitBreakerTripped",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "policy",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "maxSlippageBps", type: "uint16" },
      { name: "maxPositionBps", type: "uint16" },
      { name: "dailyDrawdownCapBps", type: "uint16" },
      { name: "minTradeIntervalSec", type: "uint32" },
      { name: "maxDailyTrades", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "session",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "agent", type: "address" },
      { name: "expiresAt", type: "uint64" },
      { name: "maxCumulativeVolumeQuoteE18", type: "uint128" },
      { name: "cumulativeVolumeQuoteE18", type: "uint128" },
      { name: "active", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "signer", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "dailyTradeCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "lastTradeTimestamp",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "computeTotalNavE18",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "totalNavE18", type: "uint256" }],
  },
  {
    type: "function",
    name: "currentDailyDrawdownBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "referencePriceE18",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "lastPriceUpdatedAt",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "oracleConfigs",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "pool", type: "address" },
      { name: "twapWindowSec", type: "uint32" },
      { name: "maxDeviationBps", type: "uint16" },
      { name: "maxStalenessSec", type: "uint32" },
      { name: "minLiquidity", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "getExecutionCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getExecution",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "timestamp", type: "uint64" },
          { name: "agent", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOut", type: "uint256" },
          { name: "realizedSlippageBps", type: "uint16" },
          { name: "postTradeNavE18", type: "uint256" },
          { name: "strategyTag", type: "bytes32" },
          { name: "signalHash", type: "bytes32" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "quoteOracleMinAmountOut",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "amountIn", type: "uint256" },
      { name: "maxSlippageBps", type: "uint16" },
    ],
    outputs: [
      { name: "oracleFairOut", type: "uint256" },
      { name: "oracleMinOut", type: "uint256" },
    ],
  },
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
    name: "setPriceKeeper",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keeper", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setOraclePool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "pool", type: "address" },
      { name: "twapWindowSec", type: "uint32" },
      { name: "maxDeviationBps", type: "uint16" },
      { name: "maxStalenessSec", type: "uint32" },
      { name: "minLiquidity", type: "uint128" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "syncPriceFromV3Pool",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "twapPriceE18", type: "uint256" }],
  },
  {
    type: "function",
    name: "checkAndTripCircuitBreaker",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "tripped", type: "bool" }],
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
] as const;
