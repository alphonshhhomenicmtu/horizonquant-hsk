import { RefreshCw, ShieldAlert, ShieldCheck, Wallet, Zap } from "lucide-react";
import type { ChainTelemetrySnapshot, VaultRuntimeState } from "@horizonquant/agent";

interface TopTelemetryBarProps {
  telemetry: ChainTelemetrySnapshot;
  vault: VaultRuntimeState;
  walletAddress: string | null;
  walletChainId: number | null;
  refreshing: boolean;
  onRefresh: () => void;
  onConnectWallet: () => void;
}

export function TopTelemetryBar({
  telemetry,
  vault,
  walletAddress,
  walletChainId,
  refreshing,
  onRefresh,
  onConnectWallet,
}: TopTelemetryBarProps) {
  const isLive = telemetry.source === "LIVE_RPC";
  const statusClass = vault.circuitBreakerTripped
    ? "pill-danger"
    : vault.paused
      ? "pill-warn"
      : "pill-live";
  const statusLabel = vault.circuitBreakerTripped
    ? "BREAKER LATCHED"
    : vault.paused
      ? "VAULT PAUSED"
      : vault.isLiveOnChain
        ? "ON-CHAIN VAULT"
        : "PRE-DEPLOY GUARD";

  return (
    <header className="topbar">
      <div className="brand-group">
        <div className="brand-logo">
          <Zap size={18} />
        </div>
        <div>
          <div className="brand-title">
            HorizonQuant Agent
            <span className="badge badge-cyan">HSK Chain · Track 1</span>
          </div>
          <div className="brand-sub">
            TWAP-Guarded Session-Key Vault &amp; Decision Ledger · Chain ID {telemetry.chainId}
          </div>
        </div>
      </div>

      <div className="telemetry-strip">
        <div className={`pill ${isLive ? "pill-live" : "pill-warn"}`}>
          <span className={`dot ${isLive ? "dot-emerald" : "dot-amber"}`} />
          <span>{isLive ? "LIVE RPC" : "SNAPSHOT"}</span>
          <strong className="mono">#{telemetry.blockNumber.toLocaleString()}</strong>
        </div>

        <div className="pill" title="Live WHSK/USDT 0.05% spot and 5m TWAP">
          <span>WHSK 5m TWAP</span>
          <strong className="mono text-cyan">${telemetry.whskTwapUsdt.toFixed(6)}</strong>
        </div>

        <div className="pill" title="Live 0.05% vs 0.30% gross spread vs 35 bps fee hurdle">
          <span>Spread</span>
          <strong className="mono text-amber">{telemetry.crossTierSpreadBps.toFixed(1)} bps</strong>
        </div>

        <div className="pill">
          <span>Gas</span>
          <strong className="mono">{telemetry.gasPriceGwei.toFixed(0)} gwei</strong>
        </div>

        <div className={`pill ${statusClass}`}>
          {vault.circuitBreakerTripped || vault.paused ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
          <strong>{statusLabel}</strong>
        </div>

        <button
          className={`btn btn-sm ${walletAddress ? "btn-emerald" : "btn-primary"}`}
          onClick={onConnectWallet}
          title="Connect EIP-1193 wallet on HashKey Chain Mainnet (chainId 177)"
        >
          <Wallet size={12} />
          {walletAddress
            ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}${walletChainId === 177 ? " (177)" : ""}`
            : "Connect Wallet"}
        </button>

        <button className="btn btn-sm" onClick={onRefresh} disabled={refreshing} title="Poll live HashKey Chain Mainnet RPC">
          <RefreshCw size={12} />
          {refreshing ? "Sync..." : "Sync"}
        </button>
      </div>
    </header>
  );
}
