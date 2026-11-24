import { AlertCircle, BarChart3, ExternalLink, Radar, ShieldCheck } from "lucide-react";
import {
  HASHKEY_MAINNET,
  type ArbitrageOpportunity,
  type BacktestReport,
  type ChainTelemetrySnapshot,
} from "@horizonquant/agent";
import { EquityCurveChart } from "./EquityCurveChart";

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
      {/* Live HSKSwap V3 Pool & Spread Radar (Verified Pools Only) */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">
              <Radar size={15} className="text-cyan" />
              Live HSKSwap V3 Spread &amp; TWAP Monitor (Chain ID {telemetry.chainId})
            </div>
            <div className="card-subtitle">
              Real-time slot0(), liquidity(), observe([300, 0]) &amp; Factory.getPool() reads from HashKey Chain Mainnet · {telemetry.spreadDirection}
            </div>
          </div>
          <span className="badge badge-amber">Live Spread: {telemetry.crossTierSpreadBps.toFixed(1)} bps</span>
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
                  <div className="kv-label">Spot / 5m TWAP</div>
                  <div className="kv-val mono text-emerald">
                    ${pool.spotPriceUsdt.toFixed(6)} / ${pool.twapPriceUsdt.toFixed(6)}
                  </div>
                </div>
                <div>
                  <div className="kv-label">Active Liquidity (L)</div>
                  <div className="kv-val mono">{Number(pool.liquidity).toLocaleString()}</div>
                </div>
                <div>
                  <div className="kv-label">Spot vs TWAP Δ</div>
                  <div className="kv-val mono text-cyan">{pool.spotVsTwapDiffBps.toFixed(2)} bps</div>
                </div>
                <div>
                  <div className="kv-label">Obs Cardinality / Tick</div>
                  <div className="kv-val mono">
                    {pool.observationCardinality} · {pool.tick}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <table className="data-table" style={{ marginBottom: 14 }}>
          <thead>
            <tr>
              <th>Verified Live Spread Route</th>
              <th>Gross Spread</th>
              <th>DEX Fees</th>
              <th>Gas Impact</th>
              <th>Net Edge</th>
              <th>Agent Verdict</th>
            </tr>
          </thead>
          <tbody>
            {arbitrage.map((opp) => (
              <tr key={opp.id}>
                <td>
                  <strong>{opp.route}</strong>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{opp.holdReason}</div>
                </td>
                <td className="mono">{opp.grossSpreadBps.toFixed(1)} bps</td>
                <td className="mono text-muted">{opp.poolFeesBps.toFixed(1)} bps</td>
                <td className="mono text-muted">{opp.gasImpactBps.toFixed(2)} bps</td>
                <td className={`mono ${opp.netEdgeBps > 0 ? "text-emerald" : "text-amber"}`}>
                  {opp.netEdgeBps > 0 ? "+" : ""}
                  {opp.netEdgeBps.toFixed(2)} bps
                </td>
                <td>
                  <span className={`badge ${opp.executable ? "badge-emerald" : "badge-amber"}`}>
                    {opp.executable ? "EXECUTABLE" : "HOLD (< FEE HURDLE)"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Live Factory.getPool() Verification Table */}
        <div className="kv-item" style={{ padding: "10px 12px" }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 8, color: "var(--text-primary)" }}>
            Live HSKSwap V3 Factory.getPool() Audit ({HASHKEY_MAINNET.hskSwapFactory})
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {telemetry.factoryPoolChecks.map((chk) => (
              <span
                key={`${chk.pair}-${chk.feeLabel}`}
                className={`badge ${chk.exists ? "badge-emerald" : "badge-slate"} mono`}
              >
                {chk.pair} ({chk.feeLabel}): {chk.exists ? `${chk.poolAddress.slice(0, 8)}...` : "address(0) — NO POOL"}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Honest Guardrail Stress Scenario Model */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">
              <BarChart3 size={15} className="text-emerald" />
              30-Day Tail-Risk Stress Scenario — Guarded Vault vs Unguarded Bot
              <span className="badge badge-amber">Illustrative Scenario · Not a Historical Backtest</span>
            </div>
            <div className="card-subtitle">{backtest.disclaimer}</div>
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

        <div style={{ marginBottom: 14 }}>
          <EquityCurveChart points={backtest.equityCurve} />
        </div>

        <div className="kpi-grid" style={{ marginBottom: 14 }}>
          <div className="kv-item">
            <div className="kv-label">Guarded Scenario Ending NAV</div>
            <div className="kv-val mono text-emerald" style={{ fontSize: 17 }}>
              ${backtest.finalGuardedNavUsd.toLocaleString()} ({backtest.netReturnPct >= 0 ? "+" : ""}
              {backtest.netReturnPct}%)
            </div>
          </div>
          <div className="kv-item">
            <div className="kv-label">Unguarded Bot Ending NAV</div>
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
            <div className="kv-label">Blocked Shocks / Est. Gas</div>
            <div className="kv-val mono" style={{ fontSize: 17 }}>
              {backtest.blockedAdverseSwaps} MEV · {backtest.totalGasHsk} HSK
            </div>
          </div>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Scenario Sleeve</th>
              <th>Simulated Trades</th>
              <th>Guard Blocks / Holds</th>
              <th>Gross PnL</th>
              <th>Fees &amp; HSK Gas</th>
              <th>Net PnL</th>
              <th>Guard Behavior</th>
            </tr>
          </thead>
          <tbody>
            {backtest.attribution.map((row) => (
              <tr key={row.strategy}>
                <td>
                  <strong>{row.strategy}</strong>
                </td>
                <td className="mono">{row.trades}</td>
                <td className="mono text-cyan">{row.blockedEvents}</td>
                <td className="mono">
                  {row.grossPnlUsd < 0
                    ? `-$${Math.abs(row.grossPnlUsd).toLocaleString()}`
                    : `$${row.grossPnlUsd.toLocaleString()}`}
                </td>
                <td className="mono text-muted">-${row.feesAndGasUsd.toLocaleString()}</td>
                <td className={`mono ${row.netPnlUsd >= 0 ? "text-emerald" : "text-rose"}`}>
                  {row.netPnlUsd >= 0
                    ? `+$${row.netPnlUsd.toLocaleString()}`
                    : `-$${Math.abs(row.netPnlUsd).toLocaleString()}`}
                </td>
                <td style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{row.guardImpactNote}</td>
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
            gap: 10,
            fontSize: 12,
            flexWrap: "wrap",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "#6ee7b7" }}>
            <ShieldCheck size={15} />
            Illustrative model only: shows how oracle slippage floor, fee-hurdle HOLDs, and daily drawdown cap limit tail losses.
          </span>
          <span className="mono text-emerald" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <AlertCircle size={13} />
            Drawdown Saved: -{backtest.drawdownSavedPct.toFixed(2)}% · Slippage Saved: ${backtest.slippageSavedUsd.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}
