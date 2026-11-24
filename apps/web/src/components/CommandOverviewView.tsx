import { useState } from "react";
import { Activity, Bot, Play, Send, Shield, TrendingUp } from "lucide-react";
import type {
  BacktestReport,
  ChainTelemetrySnapshot,
  QuantSignal,
  VaultRuntimeState,
} from "@horizonquant/agent";
import { EquityCurveChart } from "./EquityCurveChart";

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  calldata?: string;
  fnName?: string;
  rejected?: string[];
}

interface CommandOverviewViewProps {
  telemetry: ChainTelemetrySnapshot;
  vault: VaultRuntimeState;
  navUsd: number;
  signals: QuantSignal[];
  backtest: BacktestReport;
  messages: ChatMessage[];
  onSendCommand: (cmd: string) => void;
  onExecuteSignal: (signal: QuantSignal) => void;
}

const QUICK_PROMPTS = [
  "Cap daily loss at 2.5%, allocate 20% into HSK/USDT momentum with 40bps max slippage",
  "Show live positions, NAV, and drawdown buffer",
  "Scan HSKSwap spread arbitrage opportunities",
  "Switch to conservative mean-reversion on WHSK/USDT and WETH/USDT",
];

export function CommandOverviewView({
  telemetry,
  vault,
  navUsd,
  signals,
  backtest,
  messages,
  onSendCommand,
  onExecuteSignal,
}: CommandOverviewViewProps) {
  const [input, setInput] = useState("");
  const drawdownRatio = Math.min(100, (vault.currentDrawdownBps / Math.max(1, vault.policy.dailyDrawdownCapBps)) * 100);
  const drawdownColor =
    drawdownRatio >= 85 ? "var(--accent-rose)" : drawdownRatio >= 55 ? "var(--accent-amber)" : "var(--accent-emerald)";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSendCommand(input.trim());
    setInput("");
  };

  return (
    <>
      {/* KPI Row */}
      <section className="kpi-grid">
        <div className="card">
          <div className="kpi-label">
            <span>Total Vault NAV (USDT Eq.)</span>
            <TrendingUp size={14} className="text-emerald" />
          </div>
          <div className="kpi-value mono">${navUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div className="kpi-meta">
            <span className="text-emerald mono">+{backtest.netReturnPct.toFixed(2)}% (30d replay)</span>
            <span className="mono">+${backtest.netPnlUsd.toLocaleString()}</span>
          </div>
        </div>

        <div className="card">
          <div className="kpi-label">
            <span>Risk-Adjusted Return</span>
            <Activity size={14} className="text-cyan" />
          </div>
          <div className="kpi-value mono">{backtest.sharpeRatio.toFixed(2)} Sharpe</div>
          <div className="kpi-meta">
            <span>Sortino <strong className="mono">{backtest.sortinoRatio.toFixed(2)}</strong></span>
            <span>Win Rate <strong className="mono text-emerald">{backtest.winRatePct}%</strong></span>
          </div>
        </div>

        <div className="card">
          <div className="kpi-label">
            <span>Daily Stop-Loss Circuit Breaker</span>
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
            <span>On-Chain Guard Savings</span>
            <Shield size={14} className="text-amber" />
          </div>
          <div className="kpi-value mono text-cyan">+${backtest.slippageSavedUsd.toLocaleString()}</div>
          <div className="kpi-meta">
            <span>Drawdown Saved <strong className="mono text-emerald">-{backtest.drawdownSavedPct.toFixed(2)}%</strong></span>
            <span>{backtest.circuitBreakerActivations} CB stops</span>
          </div>
        </div>
      </section>

      {/* Main Split */}
      <section className="main-split">
        <div className="stack">
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">
                  <TrendingUp size={15} className="text-emerald" />
                  30-Day Equity Curve — Guarded HorizonQuant Vault vs Unguarded Bot
                </div>
                <div className="card-subtitle">
                  Anchored to live HSKSwap V3 WHSK/USDT (${telemetry.whskUsdtSpot.toFixed(6)}) · Max Slippage {vault.policy.maxSlippageBps} bps · Max Pos {(vault.policy.maxPositionBps / 100).toFixed(1)}%
                </div>
              </div>
              <span className="badge badge-emerald">Foundry Verified</span>
            </div>
            <EquityCurveChart points={backtest.equityCurve} />
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">
                  <Activity size={15} className="text-cyan" />
                  Autonomous Strategy Signal &amp; HSKSwap Execution Matrix
                </div>
                <div className="card-subtitle">
                  Active Mode: <strong>{vault.strategyMode}</strong> ({vault.riskAppetite}) · Nonce #{vault.nonce} · {vault.dailyTradeCount}/{vault.policy.maxDailyTrades} daily trades
                </div>
              </div>
              <span className="badge badge-cyan">EIP-712 Guarded</span>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Spot</th>
                  <th>Regime</th>
                  <th>RSI / Z</th>
                  <th>Signal</th>
                  <th>Size</th>
                  <th>Guardrail</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((sig) => (
                  <tr key={sig.pair}>
                    <td>
                      <strong>{sig.pair}</strong>
                    </td>
                    <td className="mono">
                      ${sig.spotPrice < 1 ? sig.spotPrice.toFixed(6) : sig.spotPrice.toLocaleString()}
                    </td>
                    <td>
                      <span className="badge badge-slate">{sig.regime.replace("_", " ")}</span>
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {sig.rsi14.toFixed(1)} / {sig.bollingerZ >= 0 ? "+" : ""}
                      {sig.bollingerZ.toFixed(2)}
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          sig.action === "BUY" || sig.action === "ARB_ROTATE"
                            ? "badge-emerald"
                            : sig.action === "SELL"
                              ? "badge-amber"
                              : "badge-slate"
                        }`}
                      >
                        {sig.action} ({sig.confidence}%)
                      </span>
                    </td>
                    <td className="mono">${sig.recommendedSizeUsd.toLocaleString()}</td>
                    <td>
                      <span className={`badge ${sig.allGuardsPassed ? "badge-emerald" : "badge-rose"}`}>
                        {sig.allGuardsPassed ? "7/7 PASS" : "BLOCKED"}
                      </span>
                    </td>
                    <td>
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={!sig.intent || !sig.allGuardsPassed}
                        onClick={() => onExecuteSignal(sig)}
                      >
                        <Play size={11} />
                        Execute
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column: Conversational Risk & Strategy Copilot */}
        <div className="stack">
          <div className="card copilot-box">
            <div className="card-header" style={{ marginBottom: 4 }}>
              <div>
                <div className="card-title">
                  <Bot size={15} className="text-cyan" />
                  Conversational Trading &amp; Risk Copilot
                </div>
                <div className="card-subtitle">
                  Natural-language policy parser -&gt; HorizonGuardVault calldata
                </div>
              </div>
              <span className="badge badge-cyan">{vault.riskAppetite}</span>
            </div>

            <div className="kv-grid">
              <div className="kv-item">
                <div className="kv-label">Max Slippage</div>
                <div className="kv-val mono text-cyan">{vault.policy.maxSlippageBps} bps ({(vault.policy.maxSlippageBps / 100).toFixed(2)}%)</div>
              </div>
              <div className="kv-item">
                <div className="kv-label">Max Position</div>
                <div className="kv-val mono">{(vault.policy.maxPositionBps / 100).toFixed(1)}% / trade</div>
              </div>
              <div className="kv-item">
                <div className="kv-label">Daily Stop-Loss</div>
                <div className="kv-val mono text-amber">{(vault.policy.dailyDrawdownCapBps / 100).toFixed(2)}% NAV</div>
              </div>
              <div className="kv-item">
                <div className="kv-label">Trade Cooldown</div>
                <div className="kv-val mono">{vault.policy.minTradeIntervalSec}s ({vault.policy.maxDailyTrades}/day)</div>
              </div>
            </div>

            <div className="chat-feed">
              {messages.map((m) => (
                <div key={m.id} className={`chat-msg ${m.role === "user" ? "chat-msg-user" : "chat-msg-agent"}`}>
                  <div>{m.text}</div>
                  {m.fnName && m.calldata && (
                    <div className="code-block" style={{ marginTop: 6, fontSize: 10.5 }}>
                      {m.fnName} =&gt; {m.calldata.slice(0, 66)}...
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
                placeholder='e.g. "Cap daily loss at 3%, allocate 25% into HSK/USDT momentum, 50bps slippage"'
              />
              <button className="btn btn-primary" type="submit">
                <Send size={13} />
                Apply
              </button>
            </form>
          </div>
        </div>
      </section>
    </>
  );
}
