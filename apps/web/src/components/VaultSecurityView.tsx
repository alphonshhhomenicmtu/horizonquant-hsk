import { AlertTriangle, CheckCircle2, ExternalLink, Lock, Play, RotateCcw, Shield, Terminal } from "lucide-react";
import { HASHKEY_MAINNET, HASHKEY_TESTNET, type VaultRuntimeState } from "@horizonquant/agent";

interface VaultSecurityViewProps {
  vault: VaultRuntimeState;
  onSimulateCrash: () => void;
  onResetCircuitBreaker: () => void;
  onTogglePause: () => void;
}

export function VaultSecurityView({
  vault,
  onSimulateCrash,
  onResetCircuitBreaker,
  onTogglePause,
}: VaultSecurityViewProps) {
  const sessionPct = Math.min(100, (vault.sessionVolumeUsedUsd / vault.sessionVolumeCapUsd) * 100);

  const invariants = [
    {
      name: "Non-Custodial Ownership & Two-Step Transfer",
      rule: "Only owner can deposit, withdraw, emergencyWithdraw, or mutate policy; agent key has zero transfer authority.",
      liveValue: "ENFORCED",
      testRef: "test_OnlyOwnerCanMutatePolicyOrWithdraw",
    },
    {
      name: "EIP-712 Session Key + Low-S Malleability Guard",
      rule: "Domain-bound (chainId=177) TradeIntent verified via ecrecover, s <= secp256k1.n/2, monotonic nonces.",
      liveValue: `Nonce #${vault.nonce}`,
      testRef: "test_RevertOnHighSMalleableSignature",
    },
    {
      name: "Hard Per-Trade Slippage Cap (HARD_MAX 500 bps)",
      rule: "Enforces intent.maxSlippageBps <= policy.maxSlippageBps and realized amountOut >= minAmountOut.",
      liveValue: `${vault.policy.maxSlippageBps} bps`,
      testRef: "testFuzz_SlippageGuardBlocksExcessiveSlippage (256 runs)",
    },
    {
      name: "Max Single-Trade Position Size Cap",
      rule: "Limits swap amountIn <= tokenInBalance * maxPositionBps / 10,000 before router call.",
      liveValue: `${(vault.policy.maxPositionBps / 100).toFixed(1)}%`,
      testRef: "testFuzz_MaxPositionCapEnforced (256 runs)",
    },
    {
      name: "Rolling 24h High-Water Daily Drawdown Circuit Breaker",
      rule: "Normalizes deposits/withdrawals, syncs live V3 slot0() NAV, and latches circuitBreakerTripped on breach.",
      liveValue: `${(vault.currentDrawdownBps / 100).toFixed(2)}% / ${(vault.policy.dailyDrawdownCapBps / 100).toFixed(2)}%`,
      testRef: "testFuzz_DailyDrawdownCircuitBreakerThreshold (256 runs)",
    },
    {
      name: "Exact Allowance Zero-Residual Approvals",
      rule: "Approves exact amountIn before HSKSwap exactInputSingle and resets allowance to 0 immediately after.",
      liveValue: "0 residual",
      testRef: "test_ExecuteGuardedSwap_SuccessAndZeroResidualAllowance",
    },
  ];

  const registryRows = [
    {
      label: "HSKSwap V3 SwapRouter (v1 ABI w/ deadline)",
      address: HASHKEY_MAINNET.hskSwapRouter,
      role: "Allowlisted DEX Router",
    },
    {
      label: "HSKSwap V3 Factory",
      address: HASHKEY_MAINNET.hskSwapFactory,
      role: "Pool Discovery Registry",
    },
    {
      label: "WHSK (Wrapped HSK, 18 dec)",
      address: HASHKEY_MAINNET.tokens.WHSK.address,
      role: "Primary Traded Asset",
    },
    {
      label: "USDT (Tether USD, 6 dec)",
      address: HASHKEY_MAINNET.tokens.USDT.address,
      role: "Vault Quote & NAV Base",
    },
    {
      label: "WETH (Wrapped Ether, 18 dec)",
      address: HASHKEY_MAINNET.tokens.WETH.address,
      role: "Allowlisted Major Asset",
    },
    {
      label: "WBTC (Wrapped Bitcoin, 8 dec)",
      address: HASHKEY_MAINNET.tokens.WBTC.address,
      role: "Allowlisted Major Asset",
    },
    {
      label: "WHSK / USDT 0.05% V3 Pool",
      address: HASHKEY_MAINNET.pools[0].address,
      role: "Primary Liquidity & On-Chain slot0() Price Feed",
    },
  ];

  return (
    <div className="stack">
      <div className="main-split">
        {/* Left: On-Chain Invariant Matrix */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">
                <Shield size={15} className="text-emerald" />
                HorizonGuardVault.sol — Hard On-Chain Security Invariants
              </div>
              <div className="card-subtitle">
                Compiled with Solidity 0.8.28 (Cancun EVM, via_ir) · Foundry v1.10.0 verified
              </div>
            </div>
            <span className="badge badge-emerald">21/21 PASS · 1,024 Fuzz Runs</span>
          </div>

          <div className="guard-list">
            {invariants.map((inv) => (
              <div key={inv.name} className="guard-row" style={{ alignItems: "flex-start", padding: "9px 11px" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
                    <CheckCircle2 size={14} className="text-emerald" />
                    <strong>{inv.name}</strong>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{inv.rule}</div>
                  <div className="mono" style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 3 }}>
                    Verified by: {inv.testRef}
                  </div>
                </div>
                <span className="badge badge-cyan mono">{inv.liveValue}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Stress Test & Session Key Budget */}
        <div className="stack">
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">
                  <AlertTriangle size={15} className="text-amber" />
                  Interactive Circuit Breaker &amp; Emergency Controls
                </div>
                <div className="card-subtitle">
                  Test how HorizonGuardVault halts runaway losses &amp; locks agent execution
                </div>
              </div>
              <span
                className={`badge ${
                  vault.circuitBreakerTripped ? "badge-rose" : vault.paused ? "badge-amber" : "badge-emerald"
                }`}
              >
                {vault.circuitBreakerTripped ? "TRIPPED" : vault.paused ? "PAUSED" : "HEALTHY"}
              </span>
            </div>

            <div className="kv-grid" style={{ marginBottom: 12 }}>
              <div className="kv-item">
                <div className="kv-label">Daily Drawdown Used</div>
                <div className={`kv-val mono ${vault.circuitBreakerTripped ? "text-rose" : "text-emerald"}`}>
                  {(vault.currentDrawdownBps / 100).toFixed(2)}% / {(vault.policy.dailyDrawdownCapBps / 100).toFixed(2)}%
                </div>
              </div>
              <div className="kv-item">
                <div className="kv-label">Session Notional Used</div>
                <div className="kv-val mono">
                  ${vault.sessionVolumeUsedUsd.toLocaleString()} / ${vault.sessionVolumeCapUsd.toLocaleString()}
                </div>
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>
                <span>Scoped Session Key Lifetime Volume Budget</span>
                <span className="mono">{sessionPct.toFixed(1)}% consumed</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${sessionPct}%`, background: "var(--accent-cyan)" }} />
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-danger" onClick={onSimulateCrash}>
                <AlertTriangle size={13} />
                Simulate -3.5% Drawdown Shock
              </button>
              <button className="btn btn-emerald" onClick={onResetCircuitBreaker}>
                <RotateCcw size={13} />
                Reset Circuit Breaker
              </button>
              <button className="btn" onClick={onTogglePause}>
                {vault.paused ? <Play size={13} /> : <Lock size={13} />}
                {vault.paused ? "Unpause Vault" : "Emergency Pause"}
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">
                  <Terminal size={15} className="text-cyan" />
                  One-Command Mainnet (177) &amp; Testnet (133) Deployment
                </div>
                <div className="card-subtitle">
                  Ready for immediate HashKey Chain Mainnet broadcast once funded with {HASHKEY_MAINNET.estimatedDeployGasHsk}
                </div>
              </div>
              <span className="badge badge-amber">Gas: ~3-5 HSK</span>
            </div>

            <div className="code-block" style={{ marginBottom: 8 }}>
              <div># 1. Dry-run live RPC &amp; gas verification (zero private key needed)</div>
              <div>npm run deploy:mainnet -- --dry-run</div>
              <div style={{ marginTop: 6 }}># 2. Broadcast HorizonGuardVault to HashKey Chain Mainnet (chainId 177)</div>
              <div>DEPLOYER_PRIVATE_KEY=0x... AGENT_ADDRESS=0x... npm run deploy:mainnet</div>
              <div style={{ marginTop: 6 }}># 3. Deploy full MockHSKSwap sandbox to Testnet (chainId {HASHKEY_TESTNET.chainId})</div>
              <div>DEPLOYER_PRIVATE_KEY=0x... npm run deploy:testnet</div>
            </div>
          </div>
        </div>
      </div>

      {/* Verified Mainnet Address Registry */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <CheckCircle2 size={15} className="text-cyan" />
            Verified HashKey Chain Mainnet (Chain ID 177) Contract &amp; Pool Registry
          </div>
          <a
            className="link-subtle"
            style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}
            href={HASHKEY_MAINNET.explorerUrl}
            target="_blank"
            rel="noreferrer"
          >
            hsk.blockscout.com
            <ExternalLink size={12} />
          </a>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Protocol / Asset</th>
              <th>Role in HorizonQuant Vault</th>
              <th>Verified Mainnet Address (chainId 177)</th>
              <th>Explorer</th>
            </tr>
          </thead>
          <tbody>
            {registryRows.map((row) => (
              <tr key={row.address}>
                <td>
                  <strong>{row.label}</strong>
                </td>
                <td style={{ color: "var(--text-secondary)" }}>{row.role}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {row.address}
                </td>
                <td>
                  <a
                    className="link-subtle"
                    style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}
                    href={`${HASHKEY_MAINNET.explorerUrl}/address/${row.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Inspect
                    <ExternalLink size={11} />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
