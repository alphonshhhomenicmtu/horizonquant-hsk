import { useState } from "react";
import { Bot, CheckCircle2, FileCode2, Play, Send, ShieldCheck, XCircle } from "lucide-react";
import {
  serializeIntentForDisplay,
  type QuantSignal,
  type VaultRuntimeState,
} from "@horizonquant/agent";
import type { ChatMessage } from "./CommandOverviewView";

export interface SimulatedExecutionLog {
  id: number;
  timestamp: string;
  pair: string;
  action: string;
  notionalUsd: number;
  slippageBps: number;
  strategyTag: string;
  signalHash: string;
  intentDigest: string;
}

interface CopilotIntentViewProps {
  vault: VaultRuntimeState;
  signals: QuantSignal[];
  messages: ChatMessage[];
  executions: SimulatedExecutionLog[];
  onSendCommand: (cmd: string) => void;
  onExecuteSignal: (signal: QuantSignal) => void;
}

const STUDIO_PROMPTS = [
  "Cap daily loss at 3%, allocate 25% into HSK/USDT momentum with 50bps max slippage",
  "Set max slippage to 800bps and allocate 30%",
  "Trade every 15 minutes, max 12 trades per day, target WHSK/USDT and WETH/USDT",
  "Simulate 3.5% drawdown crash to test circuit breaker",
  "Reset circuit breaker and resume trading",
];

export function CopilotIntentView({
  vault,
  signals,
  messages,
  executions,
  onSendCommand,
  onExecuteSignal,
}: CopilotIntentViewProps) {
  const [input, setInput] = useState("");
  const activeSignal = signals.find((s) => s.intent !== null) ?? signals[0];
  const serializedIntent = activeSignal?.intent ? serializeIntentForDisplay(activeSignal.intent) : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSendCommand(input.trim());
    setInput("");
  };

  return (
    <div className="equal-split">
      {/* Left: Full Conversational Strategy Terminal */}
      <div className="card copilot-box">
        <div className="card-header" style={{ marginBottom: 4 }}>
          <div>
            <div className="card-title">
              <Bot size={15} className="text-cyan" />
              Natural-Language Strategy &amp; Risk Policy Terminal
            </div>
            <div className="card-subtitle">
              Real-time constraint validation against Solidity HARD_MAX_SLIPPAGE_BPS (500 bps) &amp; daily drawdown caps
            </div>
          </div>
          <span className="badge badge-cyan">{vault.strategyMode}</span>
        </div>

        <div className="chat-feed chat-feed-tall">
          {messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.role === "user" ? "chat-msg-user" : "chat-msg-agent"}`}>
              <div>{m.text}</div>
              {m.rejected && m.rejected.length > 0 && (
                <div style={{ marginTop: 6, color: "#fda4af", fontSize: 11.5 }}>
                  Guard Rejection: {m.rejected.join(" | ")}
                </div>
              )}
              {m.fnName && m.calldata && (
                <div className="code-block" style={{ marginTop: 6 }}>
                  <div style={{ color: "#94a3b8", marginBottom: 2 }}>Encoded HorizonGuardVault Calldata ({m.fnName}):</div>
                  {m.calldata}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="prompt-chips">
          {STUDIO_PROMPTS.map((p) => (
            <button key={p} type="button" className="prompt-chip" onClick={() => onSendCommand(p)}>
              {p}
            </button>
          ))}
        </div>

        <form className="chat-input-row" onSubmit={handleSubmit}>
          <input
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type any risk guardrail, strategy mode, asset, or emergency command..."
          />
          <button className="btn btn-primary" type="submit">
            <Send size={13} />
            Dispatch
          </button>
        </form>
      </div>

      {/* Right: Live EIP-712 Intent Inspector & Execution Ledger */}
      <div className="stack">
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">
                <FileCode2 size={15} className="text-emerald" />
                Live EIP-712 TradeIntent Inspector ({activeSignal.pair})
              </div>
              <div className="card-subtitle">
                Session Key {vault.agentAddress.slice(0, 10)}...{vault.agentAddress.slice(-6)} · Domain chainId=177
              </div>
            </div>
            <button
              className="btn btn-sm btn-primary"
              disabled={!activeSignal.intent || !activeSignal.allGuardsPassed}
              onClick={() => onExecuteSignal(activeSignal)}
            >
              <Play size={11} />
              Sign &amp; Execute Swap
            </button>
          </div>

          <div className="guard-list" style={{ marginBottom: 12 }}>
            {activeSignal.guardChecks.map((check) => (
              <div key={check.name} className="guard-row">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {check.passed ? (
                    <CheckCircle2 size={14} className="text-emerald" />
                  ) : (
                    <XCircle size={14} className="text-rose" />
                  )}
                  <strong>{check.name}</strong>
                </div>
                <span className="mono" style={{ fontSize: 11.5, color: check.passed ? "#cbd5e1" : "#fda4af" }}>
                  {check.detail}
                </span>
              </div>
            ))}
          </div>

          {serializedIntent ? (
            <div className="code-block">
              <div style={{ color: "#94a3b8", marginBottom: 4 }}>
                EIP-712 Digest: <span style={{ color: "#34d399" }}>{activeSignal.intentDigest}</span>
              </div>
              {JSON.stringify(serializedIntent, null, 2)}
            </div>
          ) : (
            <div className="code-block" style={{ color: "#94a3b8" }}>
              Signal is HOLD — awaiting momentum/spread trigger before signing TradeIntent.
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <ShieldCheck size={15} className="text-cyan" />
              On-Chain Execution Audit Trail (ExecutionRecord[])
            </div>
            <span className="badge badge-emerald">{executions.length} Verified</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Pair</th>
                <th>Notional</th>
                <th>Realized Slip</th>
                <th>Signal Hash</th>
              </tr>
            </thead>
            <tbody>
              {executions.slice(0, 5).map((ex) => (
                <tr key={ex.id}>
                  <td className="mono">#{ex.id}</td>
                  <td>
                    <strong>{ex.pair}</strong>{" "}
                    <span className="badge badge-emerald">{ex.action}</span>
                  </td>
                  <td className="mono">${ex.notionalUsd.toLocaleString()}</td>
                  <td className="mono text-emerald">{ex.slippageBps} bps</td>
                  <td className="mono" style={{ fontSize: 11, color: "#94a3b8" }}>
                    {ex.signalHash.slice(0, 14)}...{ex.signalHash.slice(-6)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
