# HorizonQuant Agent — DoraHacks Track 1 Submission Ready (Dec 1)

> Ready for submission on **Dec 1, 2026** (when the 7-day DoraHacks BUIDL cap lifts) before **Dec 3, 2026 12:00 UTC+8**.

---

## DoraHacks Portal Fields (Track 1: AI Agent Trading)

- **BUIDL Name**: `HorizonQuant Agent`
- **Track**: `Track 1: AI Agent Trading` ($6k / $12k pool)
- **Tagline**: `Non-custodial TWAP-guarded EIP-712 session-key trading vault & public decision ledger on HashKey Chain (Chain ID 177).`
- **Live Demo / Web Terminal**: `https://alphonshhhomenicmtu.github.io/horizonquant-hsk/`
- **Architecture & Security Audit Deck (PDF)**: `https://alphonshhhomenicmtu.github.io/horizonquant-hsk/horizonquant-deck.pdf` (`docs/horizonquant-deck.pdf`)
- **Demo Video (YouTube)**: `https://youtu.be/LRU8ifuRyeM`
- **GitHub Repository**: `https://github.com/alphonshhhomenicmtu/horizonquant-hsk` *(verify exact remote)*
- **Target Chain**: `HashKey Chain Mainnet (Chain ID 177, RPC: https://mainnet.hsk.xyz)`
- **Verified Mainnet Contracts Used**:
  - `HSKSwap V3 SwapRouter`: `0x1f3858C46F8F6fE76260b8208995D228C5cddc64`
  - `HSKSwap V3 Factory`: `0xD136e36610f35E0Cc3cAd40de858c151f2AA65D4`
  - `WHSK/USDT 0.05% Pool (TWAP Oracle)`: `0xEB33d6666dd2359cB1BF6Ea6D72286Cc1b4a778A`
  - `WHSK/USDT 0.30% Pool`: `0x0767F7b1af495D245EA00219cFB8B2Ed6EafAe62`
- **Deployer EOA (Requires ~3–5 HSK Gas for Live Broadcast)**: `0x57A46E4E5F538452E4D672EF9D48e3e90E10A81C`
  - Live RPC Gas Check (2026-11-27): `500.001 gwei`, `DeployHorizonGuard.s.sol` Chain 177 fork dry-run = `5,876,290` gas (`2.938 HSK` full 12-tx including one-time pool cardinality expansion, or `2.734 HSK` excluding cardinality; `init=21,717 B`, `runtime=20,454 B`, `~3–5 HSK` recommended).
  - Turnkey Command (after funding): `DEPLOYER_PRIVATE_KEY=0x... AGENT_ADDRESS=0x<DISTINCT_SESSION_KEY> npm run deploy:mainnet`

## Description (Portal Copy)
HorizonQuant Agent separates off-chain market monitoring and deterministic policy compilation from hard EVM risk enforcement inside `HorizonGuardVault.sol` (Solidity 0.8.29) on HashKey Chain Mainnet (`chainId 177`):
1. **Non-Custodial Scoped Session Keys**: Cold owner keeps custody; trading agent holds only an EIP-712 session key (`agent != owner`) with monotonic nonces, 15-minute max intent deadlines, read-only reentrancy guards on NAV/drawdown views, and zero-residual router approvals.
2. **Pinned 5-Minute V3 TWAP Oracle & Slippage Floor**: Rejects 1-wei `minAmountOut` attacks, stale/zero/uninitialized oracle marks, and spot-vs-TWAP flash-crash manipulation using `observe([300, 0])` and directional `sqrtPriceLimitX96`.
3. **Pro-Rata High-Water Drawdown Breaker**: Scales `dayStartNavE18` and `dayHighWaterNavE18` pro-rata on deposits/withdrawals and persistently latches `circuitBreakerTripped` on drawdown breaches.
4. **Live Public Decision Ledger & Adversarial Breaker Lab**: Polls `https://mainnet.hsk.xyz` WHSK/USDT 0.05% & 0.30% pools live, logs Act-vs-Hold decisions, and lets judges trigger one-click ABI exploit simulations.
5. **Verified Test & Audit Suite**: `forge test` **40/40 PASS** (including `8` stateful invariants across `256` runs / `8,192` multi-actor calls with `0` reverts), Slither **0 High / 0 Medium**, Vitest **40/40 PASS** (including `21` adversarial quant/risk-engine tests), Vite build **PASS**, Gitleaks **0 secrets**, and GitHub Pages **0 console errors**.
