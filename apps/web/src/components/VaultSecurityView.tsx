import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Flame,
  Link2,
  Lock,
  Play,
  RotateCcw,
  Shield,
  ShieldAlert,
  Terminal,
} from "lucide-react";
import {
  HASHKEY_MAINNET,
  HASHKEY_TESTNET,
  type AdversarialAttackId,
  type AdversarialCheckResult,
  type VaultRuntimeState,
} from "@horizonquant/agent";

interface VaultSecurityViewProps {
  vault: VaultRuntimeState;
  walletAddress: string | null;
  adversarialLog: AdversarialCheckResult[];
  busyTx: boolean;
  onRunAdversarialTest: (attackId: AdversarialAttackId) => void;
  onLoadVaultAddress: (addr: string) => void;
  onSimulateCrash: () => void;
  onResetCircuitBreaker: () => void;
  onTogglePause: () => void;
  onSyncTwapOnChain: () => void;
}

const ATTACK_BUTTONS: Array<{ id: AdversarialAttackId; label: string; tag: string }> = [
  { id: "ONE_WEI_SLIPPAGE", label: "Try 1-Wei Slippage Exploit", tag: "H-2" },
  { id: "STALE_ORACLE", label: "Try Stale Oracle (>3600s)", tag: "H-1" },
  { id: "UNAUTHORIZED_KEEPER", label: "Try Unauthorized Keeper / Fake Pool", tag: "H-1" },
  { id: "SPOT_TWAP_SPIKE", label: "Try +25% Spot Flash Spike", tag: "H-1" },
  { id: "OVERSIZED_POSITION", label: "Try Oversized Swap (>Cap)", tag: "Policy" },
];

export function VaultSecurityView({
  vault,
  walletAddress,
  adversarialLog,
  busyTx,
  onRunAdversarialTest,
  onLoadVaultAddress,
  onSimulateCrash,
  onResetCircuitBreaker,
  onTogglePause,
  onSyncTwapOnChain,
}: VaultSecurityViewProps) {
  const [vaultInput, setVaultInput] = useState(vault.vaultAddress ?? "");
  const sessionPct = Math.min(100, (vault.sessionVolumeUsedUsd / Math.max(1, vault.sessionVolumeCapUsd)) * 100);
  const canSendRealTx = Boolean(walletAddress && vault.vaultAddress && vault.isLiveOnChain);

  const invariants = [
    {
      name: "Protected TWAP Oracle + Authorized Keeper (Fixes H-1)",
      rule: "Owner-pinned V3 pool only; owner/keeper restricted; checks pool unlocked, liquidity floor, spot-vs-TWAP divergence, step-change cap, and 3600s freshness TTL.",
      liveValue: `TTL ${vault.oracleMaxStalenessSec}s`,
      testRef: "test_H1_RevertOnSpotVsTwapFlashManipulation + test_H1_RevertOnStaleOracleMark",
    },
    {
      name: "Independent On-Chain Oracle Slippage Floor (Fixes H-2)",
      rule: "Computes oracleMinOut on-chain from pinned TWAP price and sets directional non-zero sqrtPriceLimitX96; agent-signed expectedAmountOut = 1 wei reverts immediately.",
      liveValue: `${vault.policy.maxSlippageBps} bps floor`,
      testRef: "test_H2_RevertOnOneWeiExpectedAmountOutAttack + testFuzz_OracleFloorBlocksAdversarialMinOut",
    },
    {
      name: "Pro-Rata High-Water NAV Scaling (Fixes M-1)",
      rule: "Scales dayStartNavE18 and dayHighWaterNavE18 pro-rata (rounding up for safety) on deposit/withdraw so owner flows preserve drawdown % without masking losses or false trips.",
      liveValue: `${(vault.currentDrawdownBps / 100).toFixed(2)}% / ${(vault.policy.dailyDrawdownCapBps / 100).toFixed(2)}%`,
      testRef: "test_M1_ProRataScalingPreservesDrawdownOnDepositAndWithdrawDuringLoss",
    },
    {
      name: "Cold-Owner vs Hot-Session Key Separation (Fixes M-2)",
      rule: "Agent session key can never equal owner or pendingOwner (AgentCannotBeOwner), cannot withdraw funds, and native HSK forced into the vault is recoverable via rescueNative().",
      liveValue: "ENFORCED",
      testRef: "test_M2_AgentCannotBeOwnerAndNativeHskRescueWorks + invariant_AgentNeverOwnsOrExtractsCustody",
    },
    {
      name: "Bounded Intent Window & Cooldown Floor (Fixes L-1)",
      rule: "Enforces minTradeIntervalSec >= 10s, intent.deadline <= block.timestamp + 15 minutes, low-s EIP-712 signatures, monotonic nonces, and zero-residual router allowances.",
      liveValue: `CD >= 10s · Nonce #${vault.nonce}`,
      testRef: "test_L1_RevertOnZeroCooldownAndExcessiveIntentDeadline + invariant_ZeroResidualRouterAllowance",
    },
  ];

  const registryRows = [
    {
      label: "Deployer / Cold Owner EOA (Funding Target)",
      address: HASHKEY_MAINNET.deployerAddress,
      role: "Ready for 1-command deploy once ~3-5 HSK arrives",
      live: true,
    },
    {
      label: "HSKSwap V3 SwapRouter (v1 ABI w/ deadline)",
      address: HASHKEY_MAINNET.hskSwapRouter,
      role: "Allowlisted DEX Router",
      live: true,
    },
    {
      label: "HSKSwap V3 Factory",
      address: HASHKEY_MAINNET.hskSwapFactory,
      role: "Live Pool Discovery Registry",
      live: true,
    },
    {
      label: "WHSK / USDT 0.05% V3 Pool",
      address: HASHKEY_MAINNET.pools[0].address,
      role: "Primary Market & Pinned 5m TWAP Oracle Pool",
      live: true,
    },
    {
      label: "WHSK / USDT 0.30% V3 Pool",
      address: HASHKEY_MAINNET.pools[1].address,
      role: "Secondary Fee Tier (Cross-Tier Spread Reference)",
      live: true,
    },
    {
      label: "WHSK (Wrapped HSK, 18 dec)",
      address: HASHKEY_MAINNET.tokens.WHSK.address,
      role: "Primary Traded Asset",
      live: true,
    },
    {
      label: "USDT (Tether USD, 6 dec)",
      address: HASHKEY_MAINNET.tokens.USDT.address,
      role: "Vault Quote & NAV Settlement Base",
      live: true,
    },
    {
      label: "WETH / WBTC Token Contracts",
      address: HASHKEY_MAINNET.tokens.WETH.address,
      role: "Excluded from Vault Allowlist — Factory.getPool() returns address(0)",
      live: false,
    },
  ];

  return (
    <div className="stack">
      {/* Interactive Adversarial Breaker Lab */}
      <div className="card" style={{ borderColor: "rgba(244, 63, 94, 0.35)" }}>
        <div className="card-header">
          <div>
            <div className="card-title">
              <Flame size={15} className="text-rose" />
              Interactive Adversarial Breaker Lab — Watch HorizonGuardVault Revert Live
            </div>
            <div className="card-subtitle">
              Fire real exploit payloads (1-wei slippage, stale oracle, unauthorized keeper, flash spike, cap bypass) against HorizonGuardVault.sol{" "}
              {vault.isLiveOnChain ? "(executes live Mainnet eth_call)" : "(exact Solidity ABI & revert-selector parity)"}
            </div>
          </div>
          <span className="badge badge-rose">
            {vault.isLiveOnChain ? "LIVE ETH_CALL MODE" : "PRE-DEPLOY EVM PARITY"}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {ATTACK_BUTTONS.map((btn) => (
            <button
              key={btn.id}
              type="button"
              className="btn btn-danger btn-sm"
              disabled={busyTx}
              onClick={() => onRunAdversarialTest(btn.id)}
            >
              <ShieldAlert size={12} />
              [{btn.tag}] {btn.label}
            </button>
          ))}
        </div>

        {adversarialLog.length === 0 ? (
          <div className="code-block" style={{ color: "#94a3b8" }}>
            Click any attack vector above to construct the exact malicious calldata and verify the Solidity custom error selector &amp; Foundry regression test.
          </div>
        ) : (
          <div className="guard-list">
            {adversarialLog.slice(0, 4).map((res, idx) => (
              <div
                key={`${res.id}-${idx}`}
                className="kv-item"
                style={{
                  borderColor: res.reverted ? "rgba(16, 185, 129, 0.4)" : "rgba(244, 63, 94, 0.55)",
                  padding: "10px 12px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={`badge ${res.reverted ? "badge-emerald" : "badge-rose"}`}>
                      {res.reverted ? "REVERTED (PROTECTED)" : "DID NOT REVERT"}
                    </span>
                    <strong>{res.title}</strong>
                    <span className="badge badge-slate">{res.severityRef}</span>
                  </div>
                  <span className="mono text-rose" style={{ fontSize: 11.5 }}>
                    {res.errorName} ({res.errorSelector})
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 4 }}>
                  <strong>Attack:</strong> {res.attackDescription}
                </div>
                <div style={{ fontSize: 11.5, color: "#6ee7b7", marginBottom: 4 }}>
                  <strong>Vault Response:</strong> {res.decodedReason}
                </div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                  Calldata: {res.calldataPreview.slice(0, 74)}... · Verified by: {res.foundryTestRef}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="main-split">
        {/* Left: Hardened Security Invariants + Audit Toolchain */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">
                <Shield size={15} className="text-emerald" />
                HorizonGuardVault.sol — Red-Team Hardened Security Invariants
              </div>
              <div className="card-subtitle">
                Solidity 0.8.29 (Cancun, via_ir, 20.5 KB runtime) · Foundry Unit + Fuzz + Stateful Invariant + Aderyn + Slither + Gitleaks
              </div>
            </div>
            <span className="badge badge-emerald">40/40 Forge · 8 Invariants · 0 H/M Slither</span>
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

        {/* Right: Deployed Vault Inspector, Breaker Controls & 1-Command Deploy */}
        <div className="stack">
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">
                  <Link2 size={15} className="text-cyan" />
                  Connect Deployed Mainnet Vault (Chain ID 177)
                </div>
                <div className="card-subtitle">
                  Paste any deployed HorizonGuardVault address (or pass ?vault=0x...) to read live on-chain balances, policy, TWAP TTL &amp; ExecutionRecord[]
                </div>
              </div>
              <span className={`badge ${vault.isLiveOnChain ? "badge-emerald" : "badge-amber"}`}>
                {vault.isLiveOnChain ? "LIVE ATTACHED" : "PRE-DEPLOY"}
              </span>
            </div>

            <form
              className="chat-input-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (vaultInput.trim()) onLoadVaultAddress(vaultInput.trim());
              }}
            >
              <input
                className="chat-input mono"
                value={vaultInput}
                onChange={(e) => setVaultInput(e.target.value)}
                placeholder="0x... deployed HorizonGuardVault address on chainId 177"
              />
              <button className="btn btn-primary btn-sm" type="submit" disabled={busyTx}>
                Load Live
              </button>
            </form>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">
                  <AlertTriangle size={15} className="text-amber" />
                  Circuit Breaker &amp; Emergency Controls
                </div>
                <div className="card-subtitle">
                  {canSendRealTx
                    ? "Connected wallet broadcasts real owner transactions on chainId 177"
                    : "Local pre-deploy stress preview (connect owner wallet + vault for on-chain tx)"}
                </div>
              </div>
              <span
                className={`badge ${
                  vault.circuitBreakerTripped ? "badge-rose" : vault.paused ? "badge-amber" : "badge-emerald"
                }`}
              >
                {vault.circuitBreakerTripped ? "TRIPPED" : vault.paused ? "PAUSED" : "ARMED"}
              </span>
            </div>

            <div className="kv-grid" style={{ marginBottom: 10 }}>
              <div className="kv-item">
                <div className="kv-label">Daily Drawdown Used</div>
                <div className={`kv-val mono ${vault.circuitBreakerTripped ? "text-rose" : "text-emerald"}`}>
                  {(vault.currentDrawdownBps / 100).toFixed(2)}% / {(vault.policy.dailyDrawdownCapBps / 100).toFixed(2)}%
                </div>
              </div>
              <div className="kv-item">
                <div className="kv-label">Session Volume Cap</div>
                <div className="kv-val mono">
                  ${vault.sessionVolumeUsedUsd.toFixed(0)} / ${vault.sessionVolumeCapUsd.toLocaleString()}
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
              <button className="btn btn-danger btn-sm" onClick={onSimulateCrash} disabled={busyTx}>
                <AlertTriangle size={12} />
                Simulate -3.5% Drawdown
              </button>
              <button className="btn btn-emerald btn-sm" onClick={onResetCircuitBreaker} disabled={busyTx}>
                <RotateCcw size={12} />
                {canSendRealTx ? "Reset Breaker (Tx)" : "Reset Breaker"}
              </button>
              <button className="btn btn-sm" onClick={onTogglePause} disabled={busyTx}>
                {vault.paused ? <Play size={12} /> : <Lock size={12} />}
                {vault.paused ? "Unpause Vault" : "Emergency Pause"}
              </button>
              {canSendRealTx && (
                <button className="btn btn-sm" onClick={onSyncTwapOnChain} disabled={busyTx}>
                  Sync TWAP (Tx)
                </button>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">
                  <Terminal size={15} className="text-cyan" />
                  One-Command Mainnet (177) Broadcast Script
                </div>
                <div className="card-subtitle">
                  Ready to broadcast once ~3–5 HSK lands on {HASHKEY_MAINNET.deployerAddress.slice(0, 10)}...{HASHKEY_MAINNET.deployerAddress.slice(-6)}
                </div>
              </div>
              <span className="badge badge-amber">Est: ~3–5 HSK</span>
            </div>

            <div className="code-block">
              <div># 1. Dry-run live RPC, bytecode size &amp; deployer balance</div>
              <div>npm run deploy:mainnet -- --dry-run</div>
              <div style={{ marginTop: 6 }}># 2. Broadcast vault + pin TWAP oracle + keeper + $1k session</div>
              <div>DEPLOYER_PRIVATE_KEY=0x... AGENT_ADDRESS=0x... npm run deploy:mainnet</div>
              <div style={{ marginTop: 6 }}># 3. Testnet (chainId {HASHKEY_TESTNET.chainId}) full MockHSKSwap sandbox</div>
              <div>DEPLOYER_PRIVATE_KEY=0x... AGENT_ADDRESS=0x... npm run deploy:testnet</div>
            </div>
          </div>
        </div>
      </div>

      {/* Verified Mainnet Contract Registry */}
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
              <th>Role &amp; Live Factory Status</th>
              <th>Mainnet Address (chainId 177)</th>
              <th>Explorer</th>
            </tr>
          </thead>
          <tbody>
            {registryRows.map((row) => (
              <tr key={`${row.label}-${row.address}`} style={row.live ? undefined : { opacity: 0.72 }}>
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
