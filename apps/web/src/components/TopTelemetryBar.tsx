import { RefreshCw, ShieldAlert, ShieldCheck, Zap } from "lucide-react";
import type { ChainTelemetrySnapshot, VaultRuntimeState } from "@horizonquant/agent";

interface TopTelemetryBarProps {
  telemetry: ChainTelemetrySnapshot;
  vault: VaultRuntimeState;
  refreshing: boolean;
  onRefresh: () => void;
}

export function TopTelemetryBar({ telemetry, vault, refreshing, onRefresh }: TopTelemetryBarProps) {
  const isLive = telemetry.source === "LIVE_RPC";
  const statusClass = vault.circuitBreakerTripped
    ? "pill-danger"
    : vault.paused
      ? "pill-warn"
      : "pill-live";
  const statusLabel = vault.circuitBreakerTripped
    ? "CIRCUIT BREAKER LATCHED"
    : vault.paused
      ? "VAULT PAUSED"
      : "GUARD VAULT ARMED";

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
            Session-Key AI Trading &amp; Risk Vault · Chain ID {telemetry.chainId}
          </div>
        </div>
      </div>

      <div className="telemetry-strip">
        <div className={`pill ${isLive ? "pill-live" : "pill-warn"}`}>
          <span className={`dot ${isLive ? "dot-emerald" : "dot-amber"}`} />
          <span>{isLive ? "LIVE RPC" : "SNAPSHOT"}</span>
          <strong className="mono">#{telemetry.blockNumber.toLocaleString()}</strong>
        </div>

        <div className="pill">
          <span>WHSK/USDT</span>
          <strong className="mono text-cyan">${telemetry.whskUsdtSpot.toFixed(6)}</strong>
        </div>

        <div className="pill">
          <span>Spread</span>
          <strong className="mono text-emerald">{telemetry.crossTierSpreadBps.toFixed(1)} bps</strong>
        </div>

        <div className="pill">
          <span>Gas</span>
          <strong className="mono">{telemetry.gasPriceGwei.toFixed(0)} gwei</strong>
        </div>

        <div className={`pill ${statusClass}`}>
          {vault.circuitBreakerTripped || vault.paused ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
          <strong>{statusLabel}</strong>
        </div>

        <button className="btn btn-sm" onClick={onRefresh} disabled={refreshing} title="Poll live HashKey Chain Mainnet RPC">
          <RefreshCw size={12} />
          {refreshing ? "Sync..." : "Sync"}
        </button>
      </div>
    </header>
  );
}
