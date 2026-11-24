import { BarChart3, ExternalLink, Radar, ShieldCheck } from "lucide-react";
import {
  HASHKEY_MAINNET,
  type ArbitrageOpportunity,
  type BacktestReport,
  type ChainTelemetrySnapshot,
} from "@horizonquant/agent";

interface ArbitrageBacktestViewProps {
  telemetry: ChainTelemetrySnapshot;
  arbitrage: ArbitrageOpportunity[];
  backtest: BacktestReport;
  selectedProfile: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
  onSelectProfile: (profile: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE") => void;
}

export function ArbitrageBacktestView({
  telemetry,
  arbitrage,
  backtest,
  selectedProfile,
  onSelectProfile,
}: ArbitrageBacktestViewProps) {
  return (
    <div className="stack">
      {/* Live HSKSwap V3 Pool & Arbitrage Radar */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">
              <Radar size={15} className="text-cyan" />
              Live HSKSwap V3 Spread &amp; Arbitrage Scanner (Chain ID {telemetry.chainId})
            </div>
            <div className="card-subtitle">
              Real-time slot0() &amp; liquidity() reads from verified HashKey Chain Mainnet pools · {telemetry.spreadDirection}
            </div>
          </div>
          <span className="badge badge-cyan">Live Spread: {telemetry.crossTierSpreadBps.toFixed(1)} bps</span>
        </div>

        <div className="equal-split" style={{ marginBottom: 14 }}>
          {telemetry.pools.map((pool) => (
            <div key={pool.id} className="kv-item" style={{ padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <strong>
                  {pool.pair} <span className="badge badge-cyan">{pool.feeLabel} Fee Tier</span>
                </strong>
                <a
                  className="link-subtle mono"
                  style={{ fontSize: 11, display: "inline-flex", alignItems: "center", gap: 4 }}
                  href={`${HASHKEY_MAINNET.explorerUrl}/address/${pool.address}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {pool.address.slice(0, 10)}...{pool.address.slice(-6)}
                  <ExternalLink size={11} />
                </a>
              </div>
              <div className="kv-grid">
                <div>
                  <div className="kv-label">Spot Price (USDT)</div>
                  <div className="kv-val mono text-emerald">${pool.spotPriceUsdt.toFixed(6)}</div>
                </div>
                <div>
                  <div className="kv-label">Active Liquidity (L)</div>
                  <div className="kv-val mono">{Number(pool.liquidity).toLocaleString()}</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Arbitrage / Spread Route</th>
              <th>Gross Spread</th>
              <th>DEX Fees</th>
              <th>Gas Impact</th>
              <th>Net Edge</th>
              <th>Target Size</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {arbitrage.map((opp) => (
              <tr key={opp.id}>
                <td>
                  <strong>{opp.route}</strong>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {opp.buyVenue} -&gt; {opp.sellVenue}
                  </div>
                </td>
                <td className="mono">{opp.grossSpreadBps.toFixed(1)} bps</td>
                <td className="mono text-muted">{opp.poolFeesBps.toFixed(1)} bps</td>
                <td className="mono text-muted">{opp.gasImpactBps.toFixed(2)} bps</td>
                <td className={`mono ${opp.netEdgeBps > 0 ? "text-emerald" : "text-amber"}`}>
                  {opp.netEdgeBps > 0 ? "+" : ""}
                  {opp.netEdgeBps.toFixed(2)} bps
                </td>
                <td className="mono">${opp.recommendedNotionalUsd.toLocaleString()}</td>
                <td>
                  <span className={`badge ${opp.executable ? "badge-emerald" : "badge-slate"}`}>
                    {opp.executable ? "EXECUTABLE" : "MONITORING"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Deterministic Backtest & Per-Strategy PnL Attribution */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">
              <BarChart3 size={15} className="text-emerald" />
              30-Day Deterministic Backtest &amp; Per-Strategy PnL Attribution
            </div>
            <div className="card-subtitle">
              Comparing HorizonGuardVault-enforced execution against an unprotected autonomous trading bot
            </div>
          </div>

          <div className="segmented">
            {(["CONSERVATIVE", "BALANCED", "AGGRESSIVE"] as const).map((prof) => (
              <button
                key={prof}
                type="button"
                className={selectedProfile === prof ? "active" : ""}
                onClick={() => onSelectProfile(prof)}
              >
                {prof}
              </button>
            ))}
          </div>
        </div>

        <div className="kpi-grid" style={{ marginBottom: 14 }}>
          <div className="kv-item">
            <div className="kv-label">Guarded Final NAV</div>
            <div className="kv-val mono text-emerald" style={{ fontSize: 17 }}>
              ${backtest.finalGuardedNavUsd.toLocaleString()} (+{backtest.netReturnPct}%)
            </div>
          </div>
          <div className="kv-item">
            <div className="kv-label">Unguarded Bot NAV</div>
            <div className="kv-val mono text-rose" style={{ fontSize: 17 }}>
              ${backtest.finalUnguardedNavUsd.toLocaleString()}
            </div>
          </div>
          <div className="kv-item">
            <div className="kv-label">Max Drawdown (Guarded vs Raw)</div>
            <div className="kv-val mono" style={{ fontSize: 17 }}>
              <span className="text-emerald">{backtest.maxDrawdownPct}%</span> vs{" "}
              <span className="text-rose">{backtest.unguardedMaxDrawdownPct}%</span>
            </div>
          </div>
          <div className="kv-item">
            <div className="kv-label">Profit Factor / Gas Spent</div>
            <div className="kv-val mono" style={{ fontSize: 17 }}>
              {backtest.profitFactor}x · {backtest.totalGasHsk} HSK
            </div>
          </div>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Strategy Attribution Bucket</th>
              <th>Trades</th>
              <th>Win Rate</th>
              <th>Gross PnL</th>
              <th>Fees &amp; HSK Gas</th>
              <th>Net PnL</th>
              <th style={{ width: "22%" }}>Contribution Share</th>
            </tr>
          </thead>
          <tbody>
            {backtest.attribution.map((row) => (
              <tr key={row.strategy}>
                <td>
                  <strong>{row.strategy}</strong>
                </td>
                <td className="mono">{row.trades}</td>
                <td className="mono">{row.winRatePct}%</td>
                <td className="mono">
                  {row.grossPnlUsd < 0 ? `-$${Math.abs(row.grossPnlUsd).toLocaleString()}` : `$${row.grossPnlUsd.toLocaleString()}`}
                </td>
                <td className="mono text-muted">-${row.feesAndGasUsd.toLocaleString()}</td>
                <td className={`mono ${row.netPnlUsd >= 0 ? "text-emerald" : "text-rose"}`}>
                  {row.netPnlUsd >= 0
                    ? `+$${row.netPnlUsd.toLocaleString()}`
                    : `-$${Math.abs(row.netPnlUsd).toLocaleString()}`}
                </td>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div className="progress-track" style={{ flex: 1 }}>
                      <div
                        className="progress-fill"
                        style={{ width: `${row.contributionPct}%`, background: "var(--accent-cyan)" }}
                      />
                    </div>
                    <span className="mono" style={{ fontSize: 11.5, minWidth: 38, textAlign: "right" }}>
                      {row.contributionPct}%
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div
          style={{
            marginTop: 12,
            padding: "9px 12px",
            borderRadius: 7,
            background: "rgba(16, 185, 129, 0.08)",
            border: "1px solid rgba(16, 185, 129, 0.28)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 12,
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "#6ee7b7" }}>
            <ShieldCheck size={15} />
            HorizonGuardVault blocked adverse MEV slippage spikes and latched circuit breaker on flash-crash shocks.
          </span>
          <span className="mono text-emerald">
            Slippage Saved: ${backtest.slippageSavedUsd.toLocaleString()} · Outperformance: +$
            {(backtest.finalGuardedNavUsd - backtest.finalUnguardedNavUsd).toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}
