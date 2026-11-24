import { useState } from "react";
import { Bot, CheckCircle2, ExternalLink, FileCode2, Play, Send, ShieldCheck, XCircle } from "lucide-react";
import {
  HASHKEY_MAINNET,
  serializeIntentForDisplay,
  type QuantSignal,
  type VaultRuntimeState,
} from "@horizonquant/agent";
import type { ChatMessage } from "./CommandOverviewView";

export interface ExecutionLogItem {
  id: number;
  timestamp: string;
  pair: string;
  action: string;
  notionalUsd: number;
  slippageBps: number;
  strategyTag: string;
  signalHash: string;
  intentDigest: string;
  mode: "ON_CHAIN_TX" | "PAPER_FILL";
  txHash?: string;
}

interface CopilotIntentViewProps {
  vault: VaultRuntimeState;
  primarySignal: QuantSignal;
  messages: ChatMessage[];
  executions: ExecutionLogItem[];
  walletAddress: string | null;
  busyTx: boolean;
  onSendCommand: (cmd: string) => void;
  onExecuteSignal: (signal: QuantSignal) => void;
}

const STUDIO_PROMPTS = [
  "Cap daily loss at 3%, allocate 25% into WHSK/USDT momentum with 50bps max slippage",
  "Set max slippage to 800bps and cooldown 3 seconds",
  "Switch to arbitrage mode on WHSK/USDT",
  "Try targeting WETH/USDT and WBTC/USDT",
  "Simulate 3.5% drawdown crash to test circuit breaker",
];

export function CopilotIntentView({
  vault,
  primarySignal,
  messages,
  executions,
  walletAddress,
  busyTx,
  onSendCommand,
  onExecuteSignal,
}: CopilotIntentViewProps) {
  const [input, setInput] = useState("");
  const serializedIntent = primarySignal.intent ? serializeIntentForDisplay(primarySignal.intent) : null;
  const canSendRealTx = Boolean(walletAddress && vault.vaultAddress && vault.isLiveOnChain);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSendCommand(input.trim());
    setInput("");
  };

  return (
    <div className="equal-split">
      {/* Left: Deterministic Policy Compiler */}
      <div className="card copilot-box">
        <div className="card-header" style={{ marginBottom: 4 }}>
          <div>
            <div className="card-title">
              <Bot size={15} className="text-cyan" />
              Deterministic Policy Compiler &amp; Calldata Studio
            </div>
            <div className="card-subtitle">
              Compiles plain-English risk rules against Solidity HARD_MAX_SLIPPAGE_BPS (500), MIN_TRADE_INTERVAL_SEC (10s) &amp; live pool checks
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
                  Solidity Invariant Rejection: {m.rejected.join(" | ")}
                </div>
              )}
              {m.fnName && m.calldata && (
                <div className="code-block" style={{ marginTop: 6 }}>
                  <div style={{ color: "#94a3b8", marginBottom: 2 }}>
                    ABI Calldata ({m.fnName}) — {canSendRealTx ? "ready to broadcast via wallet" : "connect wallet + deployed vault to broadcast"}:
                  </div>
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
            placeholder="Type any risk cap, slippage limit, cooldown, or emergency command..."
          />
          <button className="btn btn-primary" type="submit">
            <Send size={13} />
            Compile
          </button>
        </form>
      </div>

      {/* Right: Live EIP-712 Intent Inspector & Honest Execution Log */}
      <div className="stack">
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">
                <FileCode2 size={15} className="text-emerald" />
                EIP-712 TradeIntent Inspector ({primarySignal.pair})
              </div>
              <div className="card-subtitle">
                Session Key {vault.agentAddress.slice(0, 10)}...{vault.agentAddress.slice(-6)} · Deadline ≤ 15m · Chain ID 177
              </div>
            </div>
            <button
              className="btn btn-sm btn-primary"
              disabled={busyTx || !primarySignal.intent || !primarySignal.allGuardsPassed}
              onClick={() => onExecuteSignal(primarySignal)}
            >
              <Play size={11} />
              {canSendRealTx ? "Sign & Broadcast Swap" : "Simulate Paper Fill"}
            </button>
          </div>

          <div className="guard-list" style={{ marginBottom: 12 }}>
            {primarySignal.guardChecks.map((check) => (
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
                EIP-712 Digest ({vault.isLiveOnChain ? "Deployed Vault Domain" : "Pre-Deploy Preview"}):{" "}
                <span style={{ color: "#34d399" }}>{primarySignal.intentDigest}</span>
              </div>
              {JSON.stringify(serializedIntent, null, 2)}
            </div>
          ) : (
            <div className="code-block" style={{ color: "#94a3b8" }}>
              Signal is HOLD — {primarySignal.rationale}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <ShieldCheck size={15} className="text-cyan" />
              {vault.isLiveOnChain ? "On-Chain ExecutionRecord[] Log" : "Local Paper-Fill Session Log"}
            </div>
            <span className={`badge ${vault.isLiveOnChain ? "badge-emerald" : "badge-amber"}`}>
              {vault.isLiveOnChain ? `${executions.length} On-Chain` : `${executions.length} Paper Fills`}
            </span>
          </div>

          {executions.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "10px 4px" }}>
              No swaps recorded yet. Connect a deployed mainnet vault (or run a clearly labeled paper fill) to populate rows — zero fabricated transaction hashes are ever pre-seeded.
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Pair</th>
                  <th>Notional</th>
                  <th>Mode</th>
                  <th>Proof</th>
                </tr>
              </thead>
              <tbody>
                {executions.slice(0, 6).map((ex) => (
                  <tr key={`${ex.mode}-${ex.id}-${ex.timestamp}`}>
                    <td className="mono">#{ex.id}</td>
                    <td>
                      <strong>{ex.pair}</strong>{" "}
                      <span className="badge badge-emerald">{ex.action}</span>
                    </td>
                    <td className="mono">${ex.notionalUsd.toFixed(2)}</td>
                    <td>
                      <span className={`badge ${ex.mode === "ON_CHAIN_TX" ? "badge-emerald" : "badge-amber"}`}>
                        {ex.mode === "ON_CHAIN_TX" ? "ON-CHAIN" : "PAPER FILL"}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {ex.txHash ? (
                        <a
                          className="link-subtle"
                          href={`${HASHKEY_MAINNET.explorerUrl}/tx/${ex.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {ex.txHash.slice(0, 12)}... <ExternalLink size={10} />
                        </a>
                      ) : (
                        <span className="text-muted">{ex.signalHash.slice(0, 14)}... (local)</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
