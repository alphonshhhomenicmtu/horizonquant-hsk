import { useState } from "react";
import { Activity, Bot, CheckCircle2, Eye, Play, RefreshCw, Send, Shield, ShieldAlert, TrendingUp } from "lucide-react";
import type {
  AgentDecisionEntry,
  ArbitrageOpportunity,
  ChainTelemetrySnapshot,
  MarketAvailabilityRow,
  QuantSignal,
  VaultRuntimeState,
} from "@horizonquant/agent";

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  calldata?: string;
  fnName?: string;
  rejected?: string[];
  txHash?: string;
}

interface CommandOverviewViewProps {
  telemetry: ChainTelemetrySnapshot;
  vault: VaultRuntimeState;
  navUsd: number;
  primarySignal: QuantSignal;
  markets: MarketAvailabilityRow[];
  liveArb: ArbitrageOpportunity;
  decisions: AgentDecisionEntry[];
  messages: ChatMessage[];
  walletAddress: string | null;
  busyTx: boolean;
  onSendCommand: (cmd: string) => void;
  onExecuteSignal: (signal: QuantSignal) => void;
  onBroadcastPolicy: () => void;
  onScanNow: () => void;
  onJumpToBreakerLab: () => void;
}

const QUICK_PROMPTS = [
  "Cap daily loss at 2.5%, allocate 20% into WHSK/USDT momentum with 40bps max slippage",
  "Scan HSKSwap spread arbitrage opportunities",
  "Set max slippage to 800bps and cooldown 3 seconds",
  "Show live positions, NAV, and drawdown buffer",
];

export function CommandOverviewView({
  telemetry,
  vault,
  navUsd,
  primarySignal,
  markets,
  liveArb,
  decisions,
  messages,
  walletAddress,
  busyTx,
  onSendCommand,
  onExecuteSignal,
  onBroadcastPolicy,
  onScanNow,
  onJumpToBreakerLab,
}: CommandOverviewViewProps) {
  const [input, setInput] = useState("");
  const drawdownRatio = Math.min(100, (vault.currentDrawdownBps / Math.max(1, vault.policy.dailyDrawdownCapBps)) * 100);
  const drawdownColor =
    drawdownRatio >= 85 ? "var(--accent-rose)" : drawdownRatio >= 55 ? "var(--accent-amber)" : "var(--accent-emerald)";

  const canSendRealTx = Boolean(walletAddress && vault.vaultAddress && vault.isLiveOnChain);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSendCommand(input.trim());
    setInput("");
  };

  return (
    <>
      {/* KPI Row — 100% live RPC + honest guard posture (zero synthetic Sharpe claims) */}
      <section className="kpi-grid">
        <div className="card">
          <div className="kpi-label">
            <span>{vault.isLiveOnChain ? "Live On-Chain Vault NAV" : "Pre-Deploy Sandbox NAV"}</span>
            <TrendingUp size={14} className="text-emerald" />
          </div>
          <div className="kpi-value mono">${navUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div className="kpi-meta">
            <span className="mono">{vault.balances.USDT.toLocaleString()} USDT</span>
            <span className="mono text-cyan">{vault.balances.WHSK.toLocaleString()} WHSK</span>
          </div>
        </div>

        <div className="card">
          <div className="kpi-label">
            <span>Live WHSK Cross-Tier Spread</span>
            <Activity size={14} className={liveArb.executable ? "text-emerald" : "text-amber"} />
          </div>
          <div className={`kpi-value mono ${liveArb.executable ? "text-emerald" : "text-amber"}`}>
            {liveArb.grossSpreadBps.toFixed(1)} bps{" "}
            <span style={{ fontSize: 12.5, color: "var(--text-muted)", fontWeight: 500 }}>
              vs 35 bps fee
            </span>
          </div>
          <div className="kpi-meta">
            <span>Net <strong className="mono">{liveArb.netEdgeBps.toFixed(1)} bps</strong></span>
            <span className={`badge ${liveArb.executable ? "badge-emerald" : "badge-amber"}`}>
              {liveArb.executable ? "ACT" : "HOLD (< FEE)"}
            </span>
          </div>
        </div>

        <div className="card">
          <div className="kpi-label">
            <span>Daily Stop-Loss (Pro-Rata)</span>
            <Shield size={14} className={vault.circuitBreakerTripped ? "text-rose" : "text-emerald"} />
          </div>
          <div className="kpi-value mono">
            {(vault.currentDrawdownBps / 100).toFixed(2)}%{" "}
            <span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 500 }}>
              / {(vault.policy.dailyDrawdownCapBps / 100).toFixed(2)}% cap
            </span>
          </div>
          <div style={{ marginTop: 8 }}>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${drawdownRatio}%`, background: drawdownColor }} />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="kpi-label">
            <span>TWAP &amp; Slippage Floor Audit</span>
            <ShieldAlert size={14} className="text-cyan" />
          </div>
          <div className="kpi-value mono text-emerald" style={{ fontSize: 18 }}>
            28/28 Forge · 5 Invariants
          </div>
          <div className="kpi-meta">
            <span>1-wei &amp; stale oracle blocked</span>
            <button
              type="button"
              className="btn btn-sm"
              style={{ padding: "2px 7px", fontSize: 10.5 }}
              onClick={onJumpToBreakerLab}
            >
              Breaker Lab
            </button>
          </div>
        </div>
      </section>

      {/* Main Split */}
      <section className="main-split">
        <div className="stack">
          {/* Public Agent Decision Ledger (Act vs Hold) */}
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">
                  <Eye size={15} className="text-cyan" />
                  Public Agent Decision Ledger (Act vs Hold — Live Mainnet Evidence)
                </div>
                <div className="card-subtitle">
                  Logs every HSK Mainnet (177) pool scan with exact 0.05% vs 0.30% prices, 5m TWAP Δ, 2% depth cap &amp; WHY the agent acted or waited
                </div>
              </div>
              <button type="button" className="btn btn-sm" onClick={onScanNow}>
                <RefreshCw size={11} />
                Record Live Scan
              </button>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>Block</th>
                  <th>0.05% / 0.30% Spot</th>
                  <th>5m TWAP (Δ)</th>
                  <th>Spread / Net</th>
                  <th>2% Depth</th>
                  <th>Verdict</th>
                  <th>Exact Decision Evidence</th>
                </tr>
              </thead>
              <tbody>
                {decisions.slice(0, 6).map((d) => (
                  <tr key={d.id}>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      #{d.blockNumber.toLocaleString()}
                      <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                        {d.timestampIso.slice(11, 19)} UTC
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      ${d.pool500Spot.toFixed(6)}
                      <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                        ${d.pool3000Spot.toFixed(6)}
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      ${d.twapPrice.toFixed(6)}
                      <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                        Δ {d.spotVsTwapDiffBps.toFixed(1)} bps
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {d.grossSpreadBps.toFixed(1)} bps
                      <div className={d.netEdgeBps > 0 ? "text-emerald" : "text-amber"} style={{ fontSize: 10.5 }}>
                        {d.netEdgeBps > 0 ? "+" : ""}
                        {d.netEdgeBps.toFixed(1)} net
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>${d.maxDepth2PctUsd.toFixed(2)}</td>
                    <td>
                      <span
                        className={`badge ${
                          d.verdict === "ACT"
                            ? "badge-emerald"
                            : d.verdict === "GUARD_REJECT"
                              ? "badge-rose"
                              : "badge-amber"
                        }`}
                      >
                        {d.verdict}
                      </span>
                    </td>
                    <td style={{ fontSize: 11.5, color: "var(--text-secondary)", maxWidth: 260 }}>
                      <span className="mono" style={{ fontSize: 10, color: "#94a3b8", display: "block" }}>
                        {d.reasonCode}
                      </span>
                      {d.evidence}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Verified Live Market Matrix */}
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">
                  <Activity size={15} className="text-emerald" />
                  Live HSKSwap V3 Market Availability &amp; Execution Gate
                </div>
                <div className="card-subtitle">
                  Probed live via Factory.getPool() on 0xD136...65D4 · Mode: <strong>{vault.strategyMode}</strong> · Nonce #{vault.nonce}
                </div>
              </div>
              <span className={`badge ${canSendRealTx ? "badge-emerald" : "badge-amber"}`}>
                {canSendRealTx ? "Live Wallet Ready" : "Pre-Deploy Paper Mode"}
              </span>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Factory Status</th>
                  <th>5m TWAP / Spot</th>
                  <th>Signal</th>
                  <th>Depth-Capped Size</th>
                  <th>Guards</th>
                  <th>Execution</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>WHSK/USDT</strong>
                    <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>0.05% &amp; 0.30% pools</div>
                  </td>
                  <td>
                    <span className="badge badge-emerald">LIVE (2 POOLS)</span>
                  </td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    ${primarySignal.twapPrice.toFixed(6)}
                    <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                      Spot ${primarySignal.spotPrice.toFixed(6)}
                    </div>
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        primarySignal.action === "BUY" || primarySignal.action === "ARB_ROTATE"
                          ? "badge-emerald"
                          : primarySignal.action === "SELL"
                            ? "badge-amber"
                            : "badge-slate"
                      }`}
                    >
                      {primarySignal.action}
                    </span>
                  </td>
                  <td className="mono">
                    ${primarySignal.recommendedSizeUsd.toFixed(2)}
                    <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                      ≤ ${primarySignal.maxDepth2PctUsd.toFixed(2)} (2% L)
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${primarySignal.allGuardsPassed ? "badge-emerald" : "badge-rose"}`}>
                      {primarySignal.allGuardsPassed ? "7/7 PASS" : "BLOCKED"}
                    </span>
                  </td>
                  <td>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={busyTx || !primarySignal.intent || !primarySignal.allGuardsPassed}
                      onClick={() => onExecuteSignal(primarySignal)}
                    >
                      <Play size={11} />
                      {canSendRealTx ? "Sign & Send Tx" : "Paper Fill"}
                    </button>
                  </td>
                </tr>
                {markets
                  .filter((m) => m.status === "NO_LIVE_POOL")
                  .map((m) => (
                    <tr key={m.pair} style={{ opacity: 0.72 }}>
                      <td>
                        <strong>{m.pair}</strong>
                      </td>
                      <td>
                        <span className="badge badge-slate">NO LIVE POOL (0x0)</span>
                      </td>
                      <td className="mono text-muted" colSpan={4} style={{ fontSize: 11.5 }}>
                        {m.factoryNote}
                      </td>
                      <td>
                        <button className="btn btn-sm" disabled>
                          Excluded
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column: Deterministic Policy Compiler */}
        <div className="stack">
          <div className="card copilot-box">
            <div className="card-header" style={{ marginBottom: 4 }}>
              <div>
                <div className="card-title">
                  <Bot size={15} className="text-cyan" />
                  Deterministic Risk &amp; Policy Compiler
                </div>
                <div className="card-subtitle">
                  Plain-English rules -&gt; ABI calldata (no LLM in signing path)
                </div>
              </div>
              <span className="badge badge-cyan">{vault.riskAppetite}</span>
            </div>

            <div className="kv-grid">
              <div className="kv-item">
                <div className="kv-label">Oracle Slippage Floor</div>
                <div className="kv-val mono text-cyan">
                  {vault.policy.maxSlippageBps} bps ({(vault.policy.maxSlippageBps / 100).toFixed(2)}%)
                </div>
              </div>
              <div className="kv-item">
                <div className="kv-label">Max Position</div>
                <div className="kv-val mono">{(vault.policy.maxPositionBps / 100).toFixed(1)}% / swap</div>
              </div>
              <div className="kv-item">
                <div className="kv-label">Daily Stop-Loss</div>
                <div className="kv-val mono text-amber">{(vault.policy.dailyDrawdownCapBps / 100).toFixed(2)}% NAV</div>
              </div>
              <div className="kv-item">
                <div className="kv-label">Cooldown (Floor 10s)</div>
                <div className="kv-val mono">
                  {vault.policy.minTradeIntervalSec}s ({vault.policy.maxDailyTrades}/day)
                </div>
              </div>
            </div>

            <div className="chat-feed">
              {messages.map((m) => (
                <div key={m.id} className={`chat-msg ${m.role === "user" ? "chat-msg-user" : "chat-msg-agent"}`}>
                  <div>{m.text}</div>
                  {m.fnName && m.calldata && (
                    <div className="code-block" style={{ marginTop: 6, fontSize: 10.5 }}>
                      {m.fnName} =&gt; {m.calldata.slice(0, 62)}...
                    </div>
                  )}
                  {m.txHash && (
                    <div style={{ marginTop: 5, fontSize: 11 }}>
                      <CheckCircle2 size={12} style={{ verticalAlign: "middle", marginRight: 4 }} className="text-emerald" />
                      <a
                        className="link-subtle mono"
                        href={`https://hsk.blockscout.com/tx/${m.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Tx: {m.txHash.slice(0, 14)}...{m.txHash.slice(-6)}
                      </a>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="prompt-chips">
              {QUICK_PROMPTS.map((prompt) => (
                <button key={prompt} type="button" className="prompt-chip" onClick={() => onSendCommand(prompt)}>
                  {prompt}
                </button>
              ))}
            </div>

            <form className="chat-input-row" onSubmit={handleSubmit}>
              <input
                className="chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder='e.g. "Cap daily loss at 2.5%, allocate 20% WHSK/USDT momentum, 40bps slippage"'
              />
              <button className="btn btn-primary" type="submit">
                <Send size={13} />
                Compile
              </button>
            </form>

            {canSendRealTx && (
              <button
                type="button"
                className="btn btn-emerald"
                disabled={busyTx}
                onClick={onBroadcastPolicy}
              >
                Broadcast Active Policy to Vault ({vault.vaultAddress?.slice(0, 8)}...)
              </button>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
