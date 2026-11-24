# HorizonQuant Agent — Verified Hackathon Specification & HSK Chain Recon

> **Verified At**: `2026-11-24T15:15:00+08:00` (`2026-11-24T07:15:00Z`)
> **Target Event**: DoraHacks — **HSK Chain Horizon Hackathon · Seoul** (`https://dorahacks.io/hackathon/hskchainseoul/detail`)
> **Target Track**: **Track 1 — AI Agent Trading** (`$6,000 USDT`: 1st `$3,000` / 2nd `$2,000` / 3rd `$1,000`)

---

## 1. Verified Hackathon Rules, Deadlines & Track 1 Brief

| Field | Verified Value |
|---|---|
| Event URL | `https://dorahacks.io/hackathon/hskchainseoul/detail` |
| Total Prize Pool | `12,000 USDT` (`6,000 USDT` per track across 2 tracks) |
| Track 1 Prize Breakdown | 1st Place: `3,000 USDT` · 2nd Place: `2,000 USDT` · 3rd Place: `1,000 USDT` |
| Registration & Submission Deadline | `2026-12-03 04:00 UTC` (`2026-12-03 12:00 UTC+8` / `13:00 KST`) |
| Pitch Selection Announcement | `2026-12-04` |
| Demo Day (Seoul + Online Support) | `2026-12-05` (*"Online presenters must attend at their assigned time to retain their demo slot."*) |
| Winner Announcement | `2026-12-06` (prizes distributed within 14 working days) |
| Eligibility | Open worldwide to individuals and teams; entries must be original and built/rebuilt during the hackathon |
| Mainnet Deployment Requirement | **Mandatory**: *"Teams selected for the demo must deploy their smart contracts to HSK Chain Mainnet."* / *"Winning teams must deploy their projects on HSK Chain mainnet to claim a prize."* |
| Mainnet Gas Estimate | `~3–5 HSK` at live `~500 gwei` base fee (`500001000000 wei` observed live) |

### Verbatim Track 1 Requirements (`AI Agent Trading`)
- Build an AI agent for automated trading on a decentralized exchange such as **HSKSwap** (`https://app.hskswap.com`).
- Monitor markets, analyze on-chain data, identify trading signals, and execute orders autonomously.
- Spot arbitrage and spread opportunities in real time and aim for sustained profitability with **strict risk controls and stop-loss rules**.
- Provide a **conversational interface** letting users inspect live positions and profit & loss (PnL) in real time and adjust **position size, trade frequency, risk appetite, and target assets**.
- Bonus points for using officially recommended HashKey Chain ecosystem contracts, documentation, and tooling.

### Evaluation Dimensions
1. **Completeness & Working Mainnet Readiness**: Non-custodial smart contract suite tested with Foundry and deploy-ready for HSK Chain Mainnet (`chainId 177`), paired with live RPC telemetry and interactive terminal.
2. **Technical Maturity & On-Chain Risk Enforcement**: Hard smart-contract guardrails (slippage caps, daily drawdown circuit breaker, max position sizing, EIP-712 session-key intents, allowlisted HSKSwap router/pairs) that cannot be bypassed by off-chain AI hallucinations.
3. **Trading Intelligence & Real-Time Spread Detection**: Multi-regime signal generation (momentum, mean-reversion, and live HSKSwap cross-fee-tier spread arbitrage) plus deterministic PnL attribution.
4. **Conversational UX & Institutional Clarity**: Clean natural-language policy control, real-time PnL & drawdown telemetry, and transparent execution audit trail.

---

## 2. Live Verified HashKey Chain Infrastructure & Contract Addresses

All endpoints and contract bytecodes below were probed live against HashKey Chain RPC and `hsk.blockscout.com` on `2026-11-24`.

### Network Parameters

| Network | Chain ID | Primary RPC URL | Fallback RPC URL | Block Explorer | Live Probe Snapshot (`2026-11-24`) |
|---|---:|---|---|---|---|
| **HashKey Chain Mainnet** | `177` (`0xb1`) | `https://mainnet.hsk.xyz` | `https://hashkey.drpc.org` | `https://hsk.blockscout.com` | Block `30,578,603` · Gas `500.001 gwei` |
| **HashKey Chain Testnet** | `133` (`0x85`) | `https://testnet.hsk.xyz` | `https://hashkey-testnet.drpc.org` | `https://testnet-explorer.hskchain.net` | Block `36,158,845` · Gas `1.001 gwei` |

> **Engineering Note**: `https://mainnet.hsk.xyz` enforces WAF checks on bare HTTP clients without a `User-Agent` header (`HTTP 403`). All HorizonQuant RPC clients send an explicit `User-Agent: HorizonQuant-Agent/1.0` header. `https://hashkey.blockscout.com` redirects (`301`) to `https://hsk.blockscout.com`.

### Official Mainnet Token Contracts (`chainId 177`)

Verified against `https://docs.hashkeychain.net/docs/Build-on-HashKey-Chain/Token-Contracts` and live `eth_call`:

| Symbol | Name | Decimals | Mainnet Address (`chainId 177`) |
|---|---|---:|---|
| `HSK` | HashKey Platform Token (Native Gas) | `18` | Native Asset |
| `WHSK` | Wrapped HSK | `18` | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` |
| `USDT` | Tether USD (`OptimismMintableERC20`) | `6` | `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` |
| `WETH` | Wrapped Ether (`OptimismMintableERC20`) | `18` | `0xefd4bC9afD210517803f293ABABd701CaeeCdfd0` |
| `WBTC` | Wrapped Bitcoin (`OptimismMintableERC20`) | `8` | `0x6119ca49a79f5825c8b345f8d7ac36b272565b14` |
| `USDC.e` | Bridged USDC | `6` | `0x054ed45810DbBAb8B27668922D110669c9D88D0a` |

### Verified HSKSwap V3 DEX Contracts & Live Pools (`chainId 177`)

Verified via `hsk.blockscout.com` ABI inspection and live `eth_call`:

| Contract | Mainnet Address (`chainId 177`) | Verification Notes |
|---|---|---|
| **HSKSwap V3 `SwapRouter`** | `0x1f3858C46F8F6fE76260b8208995D228C5cddc64` | Verified Uniswap V3 `SwapRouter` (`solc v0.7.6`), `exactInputSingle` **includes `uint256 deadline`**. Constructor: `factory=0xD136...65D4`, `WETH9=0xB210...1Cf1`. |
| **HSKSwap V3 `Factory`** | `0xD136e36610f35E0Cc3cAd40de858c151f2AA65D4` | Deployed bytecode verified (`49,070` hex chars). |
| **`WHSK / USDT` Pool (`0.05%`, fee `500`)** | `0xEB33d6666dd2359cB1BF6Ea6D72286Cc1b4a778A` | Live liquidity `2,830,955,089,632`, live spot `0.100013 USDT / WHSK`. |
| **`WHSK / USDT` Pool (`0.30%`, fee `3000`)** | `0x0767F7b1af495D245EA00219cFB8B2Ed6EafAe62` | Live liquidity `950,573,096,369`, live spot `0.100193 USDT / WHSK` (`~18.0 bps` live cross-tier spread). |

---

## 3. HorizonQuant Agent — System Architecture & Deliverable Plan

1. **On-Chain Non-Custodial Guarded Vault (`contracts/`)**:
   - `HorizonGuardVault.sol` (Solidity `0.8.28`): Non-custodial owner vault with scoped AI Agent session keys, EIP-712 signed `TradeIntent` verification (replay-safe monotonic nonces + low-s signature check), hard per-trade slippage cap, max position share cap, trade frequency cooldown & daily trade limit, rolling UTC 24h high-water daily drawdown circuit breaker (with deposit/withdrawal NAV normalization + live V3 `slot0()` NAV oracle sync), allowlisted routers & directed pairs, exact-allowance zero-residual token approvals, emergency pause & owner exit, and verifiable on-chain `ExecutionRecord` audit log.
   - `MockHSKSwapRouter.sol` & `MockERC20.sol`: Deterministic HSKSwap V3 `SwapRouter` simulator (matching live `ExactInputSingleParams` with `deadline`) with configurable slippage injection for local Foundry and testnet validation.
   - Foundry Unit + Fuzz Test Suite (`contracts/test/HorizonGuardVault.t.sol`) + Forge Deployment Script (`contracts/script/DeployHorizonGuard.s.sol`).
2. **Autonomous Trading Agent & Conversational Copilot Engine (`packages/agent/`)**:
   - Live HashKey Chain Mainnet/Testnet RPC telemetry reader (`WHSK/USDT 0.05%` vs `0.30%` live pool `slot0()` & `liquidity()`).
   - Multi-strategy signal engine: Cross-fee-tier spread/arbitrage detector + Regime-adaptive Momentum (EMA crossover) & Mean-Reversion (RSI/Bollinger Z-score) + Pre-trade vault risk gate + EIP-712 intent builder.
   - Natural-language Strategy & Risk Command Parser producing validated policy diffs, on-chain calldata previews, and live telemetry summaries.
   - Deterministic 30-day Backtest & PnL Attribution Engine quantifying Momentum, Mean-Reversion, Cross-Pool Arbitrage, Gas Costs, and Drawdown Saved by `HorizonGuardVault`.
   - One-command TypeScript deployment scripts: `deploy-hsk-mainnet.ts` (`chainId 177`) and `deploy-hsk-testnet.ts` (`chainId 133`) supporting `--dry-run` gas estimation without private keys.
3. **Institutional Conversational PnL & Risk Terminal (`apps/web/`)**:
   - React + Vite + TypeScript static-deployable dashboard (GitHub Pages compatible + live HashKey Chain RPC browser telemetry).
   - Four primary views: Live Command & Risk Terminal, Conversational Strategy Copilot & EIP-712 Inspector, HSKSwap Arbitrage Radar & Backtest Attribution, and On-Chain Vault Security & Mainnet Deployment Console.
4. **Documentation & Verification Artifacts**:
   - Clean English `README.md` with Mermaid architecture diagram, test & build verification output, mainnet deployment instructions, and a crisp 2-minute Demo Day script.
   - 4 visually verified Retina screenshots (`docs/screenshots/`).
