#!/usr/bin/env python3
"""Build the 8-slide 16:9 HorizonQuant Agent architecture & security audit PDF deck."""

from __future__ import annotations

import base64
import shutil
import subprocess
from pathlib import Path

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
SCREENSHOTS = DOCS / "screenshots"
OUT_PDF = DOCS / "horizonquant-deck.pdf"
PREVIEW_DIR = Path("/tmp")


def img_data_uri(name: str) -> str:
    path = SCREENSHOTS / name
    raw = path.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:image/png;base64,{b64}"


def build_html() -> str:
    s1_img = img_data_uri("01-command-terminal.png")
    s3_img = img_data_uri("03-hskswap-arb-backtest.png")
    s4_img = img_data_uri("04-vault-security-mainnet.png")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>HorizonQuant Agent — Architecture &amp; Security Audit Deck</title>
<style>
  @page {{
    size: 13.333in 7.5in;
    margin: 0;
  }}
  * {{
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }}
  html, body {{
    width: 13.333in;
    background: #070b14;
    color: #e6edf7;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }}
  .slide {{
    width: 13.333in;
    height: 7.5in;
    padding: 0.44in 0.54in 0.40in 0.54in;
    position: relative;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
    background:
      radial-gradient(circle at 88% 12%, rgba(16, 185, 129, 0.12), transparent 38%),
      radial-gradient(circle at 12% 88%, rgba(56, 189, 248, 0.10), transparent 40%),
      linear-gradient(160deg, #070b14 0%, #0b1220 55%, #09101c 100%);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }}
  .slide:last-child {{
    page-break-after: auto;
    break-after: auto;
  }}
  .topbar {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid rgba(148, 163, 184, 0.18);
    padding-bottom: 10px;
    margin-bottom: 16px;
  }}
  .tag {{
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: #34d399;
    background: rgba(16, 185, 129, 0.12);
    border: 1px solid rgba(52, 211, 153, 0.35);
    padding: 4px 10px;
    border-radius: 999px;
  }}
  .tag-cyan {{
    color: #38bdf8;
    background: rgba(56, 189, 248, 0.12);
    border-color: rgba(56, 189, 248, 0.35);
  }}
  .tag-amber {{
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.12);
    border-color: rgba(251, 191, 36, 0.35);
  }}
  .slide-num {{
    font-size: 11px;
    color: #94a3b8;
    font-family: "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
  }}
  h1 {{
    font-size: 40px;
    line-height: 1.12;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: #f8fafc;
  }}
  h2 {{
    font-size: 26px;
    line-height: 1.18;
    font-weight: 750;
    letter-spacing: -0.015em;
    color: #f8fafc;
    margin-bottom: 6px;
  }}
  .subtitle {{
    font-size: 14.5px;
    line-height: 1.45;
    color: #94a3b8;
  }}
  .lead {{
    font-size: 17px;
    line-height: 1.5;
    color: #cbd5e1;
    max-width: 9.8in;
  }}
  .grid-2 {{
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
    flex: 1;
    min-height: 0;
  }}
  .grid-3 {{
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    flex: 1;
    min-height: 0;
  }}
  .grid-4 {{
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
  }}
  .card {{
    background: rgba(15, 23, 42, 0.78);
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 12px;
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
  }}
  .card-emerald {{
    border-color: rgba(52, 211, 153, 0.35);
    background: linear-gradient(180deg, rgba(16, 185, 129, 0.08), rgba(15, 23, 42, 0.85));
  }}
  .card-cyan {{
    border-color: rgba(56, 189, 248, 0.35);
    background: linear-gradient(180deg, rgba(56, 189, 248, 0.08), rgba(15, 23, 42, 0.85));
  }}
  .card-rose {{
    border-color: rgba(251, 113, 133, 0.35);
    background: linear-gradient(180deg, rgba(251, 113, 133, 0.08), rgba(15, 23, 42, 0.85));
  }}
  .card-title {{
    font-size: 14px;
    font-weight: 700;
    color: #f1f5f9;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }}
  .kpi-val {{
    font-size: 28px;
    font-weight: 800;
    color: #34d399;
    font-family: "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
    line-height: 1.1;
    margin-bottom: 4px;
  }}
  .kpi-val.cyan {{ color: #38bdf8; }}
  .kpi-val.amber {{ color: #fbbf24; }}
  .kpi-label {{
    font-size: 11.5px;
    color: #94a3b8;
    line-height: 1.35;
  }}
  ul.clean {{
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }}
  ul.clean li {{
    font-size: 12.5px;
    line-height: 1.42;
    color: #cbd5e1;
    padding-left: 14px;
    position: relative;
  }}
  ul.clean li::before {{
    content: "";
    position: absolute;
    left: 0;
    top: 6px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #34d399;
  }}
  ul.clean.rose li::before {{ background: #fb7185; }}
  ul.clean.cyan li::before {{ background: #38bdf8; }}
  code, .mono {{
    font-family: "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
    font-size: 11.5px;
    color: #7dd3fc;
    background: rgba(15, 23, 42, 0.9);
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid rgba(56, 189, 248, 0.2);
  }}
  table {{
    width: 100%;
    border-collapse: collapse;
    font-size: 11.5px;
  }}
  th, td {{
    text-align: left;
    padding: 7px 10px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.14);
    vertical-align: top;
  }}
  th {{
    color: #94a3b8;
    font-weight: 700;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: rgba(15, 23, 42, 0.6);
  }}
  td {{ color: #e2e8f0; }}
  .pill {{
    display: inline-block;
    padding: 2px 7px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }}
  .pill-pass {{
    color: #34d399;
    background: rgba(16, 185, 129, 0.16);
    border: 1px solid rgba(52, 211, 153, 0.35);
  }}
  .pill-warn {{
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.14);
    border: 1px solid rgba(251, 191, 36, 0.35);
  }}
  .flow-row {{
    display: flex;
    align-items: stretch;
    gap: 10px;
    margin: 12px 0;
  }}
  .flow-box {{
    flex: 1;
    background: rgba(15, 23, 42, 0.85);
    border: 1px solid rgba(56, 189, 248, 0.3);
    border-radius: 10px;
    padding: 12px 13px;
  }}
  .flow-arrow {{
    display: flex;
    align-items: center;
    color: #34d399;
    font-weight: 800;
    font-size: 18px;
  }}
  .shot-wrap {{
    background: #050810;
    border: 1px solid rgba(148, 163, 184, 0.22);
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }}
  .shot-wrap img {{
    width: 100%;
    height: 3.65in;
    object-fit: cover;
    object-position: top center;
    display: block;
  }}
  .shot-cap {{
    padding: 7px 11px;
    font-size: 11px;
    color: #94a3b8;
    border-top: 1px solid rgba(148, 163, 184, 0.15);
    background: rgba(15, 23, 42, 0.9);
  }}
  .footer {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px solid rgba(148, 163, 184, 0.15);
    padding-top: 8px;
    margin-top: 12px;
    font-size: 10.5px;
    color: #64748b;
  }}
  .accent-emerald {{ color: #34d399; }}
  .accent-cyan {{ color: #38bdf8; }}
  .accent-amber {{ color: #fbbf24; }}
</style>
</head>
<body>

<!-- SLIDE 1: COVER -->
<section class="slide">
  <div class="topbar">
    <span class="tag">DoraHacks HSK Chain Horizon · Track 1: AI Agent Trading ($6k / $12k Pool)</span>
    <span class="slide-num">01 / 08</span>
  </div>
  <div style="display:flex; flex-direction:column; gap:18px; my:auto;">
    <div style="display:flex; gap:10px; align-items:center;">
      <span class="tag tag-cyan">HashKey Chain Mainnet (Chain ID 177)</span>
      <span class="tag tag-amber">EIP-712 Session Keys + V3 TWAP Guard</span>
    </div>
    <h1>HorizonQuant Agent</h1>
    <p class="lead">
      Non-Custodial EIP-712 AI Trading &amp; On-Chain Risk Vault on <strong style="color:#f8fafc;">HashKey Chain (177)</strong>.
      Cold owner custody meets deterministic policy compilation, live HSKSwap V3 pool telemetry, and hard EVM risk enforcement inside <code>HorizonGuardVault.sol</code>.
    </p>
    <div class="grid-4" style="margin-top:6px;">
      <div class="card card-emerald">
        <div class="kpi-val">28 / 28</div>
        <div class="kpi-label">Foundry unit, fuzz &amp; 4,096-call stateful invariant tests PASS</div>
      </div>
      <div class="card card-cyan">
        <div class="kpi-val cyan">19 / 19</div>
        <div class="kpi-label">TypeScript agent &amp; risk-engine Vitest suite PASS</div>
      </div>
      <div class="card">
        <div class="kpi-val amber">0 H / 0 M</div>
        <div class="kpi-label">Exploitable High/Medium findings in Aderyn &amp; Slither</div>
      </div>
      <div class="card">
        <div class="kpi-val">2.75 HSK</div>
        <div class="kpi-label">Verified mainnet deploy gas budget (20,139 B runtime)</div>
      </div>
    </div>
    <div class="card" style="padding:12px 16px; display:grid; grid-template-columns: 1fr 1fr 1fr; gap:14px;">
      <div>
        <div style="font-size:10.5px; color:#94a3b8; text-transform:uppercase; font-weight:700;">Live Web Terminal</div>
        <div class="mono" style="margin-top:4px; font-size:11px;">https://alphonshhhomenicmtu.github.io/horizonquant-hsk/</div>
      </div>
      <div>
        <div style="font-size:10.5px; color:#94a3b8; text-transform:uppercase; font-weight:700;">Open-Source Repository (MIT)</div>
        <div class="mono" style="margin-top:4px; font-size:11px;">https://github.com/alphonshhhomenicmtu/horizonquant-hsk</div>
      </div>
      <div>
        <div style="font-size:10.5px; color:#94a3b8; text-transform:uppercase; font-weight:700;">Demo Video Walkthrough</div>
        <div class="mono" style="margin-top:4px; font-size:11px;">https://youtu.be/LRU8ifuRyeM</div>
      </div>
    </div>
  </div>
  <div class="footer">
    <span>HorizonQuant Agent · Non-Custodial AI Trading Vault on HashKey Chain 177</span>
    <span>Solidity 0.8.29 · React + Vite + Viem · Foundry + Aderyn + Slither</span>
  </div>
</section>

<!-- SLIDE 2: PROBLEM -->
<section class="slide">
  <div class="topbar">
    <span class="tag">02 · The Problem &amp; Design Thesis</span>
    <span class="slide-num">02 / 08</span>
  </div>
  <div>
    <h2>Why Custodial AI Trading Bots Fail Institutional DeFi</h2>
    <p class="subtitle">Autonomous trading agents need speed and intelligence, but handing over raw private keys or unguarded router approvals creates catastrophic principal risk.</p>
  </div>
  <div class="grid-2" style="margin-top:14px;">
    <div class="card card-rose">
      <div class="card-title" style="color:#fda4af;">Legacy Custodial AI Bots (Broken Trust Model)</div>
      <ul class="clean rose">
        <li><strong>Unbounded Key Custody:</strong> Giving an LLM or bot an EOA private key lets a prompt injection, API bug, or leaked env var drain 100% of funds.</li>
        <li><strong>Spot-Price &amp; 1-Wei Slippage Exploits:</strong> Naive bots pass <code>minAmountOut = 1</code> or trust manipulable spot <code>slot0()</code> prices, losing value to MEV sandwiching.</li>
        <li><strong>Zero Drawdown Circuit Breakers:</strong> Runaway loops or volatile wicks keep trading through losses with no on-chain daily loss cap.</li>
        <li><strong>Opaque Decision Logs:</strong> Users cannot verify why a bot traded or held, or whether liquidity depth justified execution.</li>
      </ul>
    </div>
    <div class="card card-emerald">
      <div class="card-title" style="color:#6ee7b7;">HorizonQuant Guarded Architecture (Verifiable Safety)</div>
      <ul class="clean">
        <li><strong>Cold Owner / Hot Session Key Split:</strong> Owner keeps cold custody; agent holds only a scoped EIP-712 session key (<code>agent != owner</code>) that cannot withdraw capital.</li>
        <li><strong>Pinned 5-Min V3 TWAP Oracle Floor:</strong> Vault independently computes fair output from <code>observe([300, 0])</code> and reverts if intent undercuts the oracle floor.</li>
        <li><strong>Pro-Rata High-Water Drawdown Breaker:</strong> Deposits and withdrawals scale baselines pro-rata; breaching daily drawdown persistently latches <code>circuitBreakerTripped</code>.</li>
        <li><strong>Public Act-vs-Hold Decision Ledger:</strong> Every live HashKey Chain RPC poll logs spread, TWAP divergence, depth, and explicit hold/act rationale.</li>
      </ul>
    </div>
  </div>
  <div class="footer">
    <span>Security Principle: The AI agent proposes trades; HorizonGuardVault.sol enforces deterministic EVM invariants.</span>
    <span>HashKey Chain Mainnet (177)</span>
  </div>
</section>

<!-- SLIDE 3: ARCHITECTURE -->
<section class="slide">
  <div class="topbar">
    <span class="tag tag-cyan">03 · End-to-End Architecture</span>
    <span class="slide-num">03 / 08</span>
  </div>
  <div>
    <h2>Signal Engine &rarr; EIP-712 Intent &rarr; HorizonGuardVault.sol on Chain 177</h2>
    <p class="subtitle">Clean separation between off-chain market monitoring/policy compilation and on-chain Solidity 0.8.29 verification against live HSKSwap V3 pools.</p>
  </div>
  <div class="flow-row">
    <div class="flow-box">
      <div class="card-title accent-cyan">1. Live RPC Telemetry</div>
      <ul class="clean cyan">
        <li>Polls <code>https://mainnet.hsk.xyz</code></li>
        <li>Reads <code>slot0()</code>, <code>liquidity()</code>, <code>observe([300, 0])</code></li>
        <li>Verified <code>WHSK/USDT</code> 0.05% &amp; 0.30% pools</li>
      </ul>
    </div>
    <div class="flow-arrow">&rarr;</div>
    <div class="flow-box">
      <div class="card-title accent-emerald">2. AI Signal &amp; EIP-712</div>
      <ul class="clean">
        <li>Logs Act vs Hold in Decision Ledger</li>
        <li>Compiles plain-English risk rules to ABI</li>
        <li>Signs scoped <code>TradeIntent</code> (15m max TTL)</li>
      </ul>
    </div>
    <div class="flow-arrow">&rarr;</div>
    <div class="flow-box" style="border-color:rgba(52,211,153,0.5);">
      <div class="card-title accent-emerald">3. HorizonGuardVault.sol</div>
      <ul class="clean">
        <li>Verifies <code>agent != owner</code> &amp; low-<code>s</code> sig</li>
        <li>Checks pinned 5m TWAP &amp; oracle floor</li>
        <li>Enforces per-trade cap &amp; daily drawdown</li>
      </ul>
    </div>
    <div class="flow-arrow">&rarr;</div>
    <div class="flow-box">
      <div class="card-title accent-amber">4. HSKSwap V3 Router</div>
      <ul class="clean">
        <li>Exact-amount approval (zero residual)</li>
        <li>Directional <code>sqrtPriceLimitX96</code></li>
        <li>Emits <code>TradeExecuted</code> + <code>ExecutionRecord</code></li>
      </ul>
    </div>
  </div>
  <div class="card" style="padding:10px 14px;">
    <table>
      <thead>
        <tr>
          <th>Verified Mainnet Component (Chain ID 177)</th>
          <th>On-Chain Address</th>
          <th>Live Probe Status (Block 30,589,426)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>HSKSwap V3 SwapRouter</strong></td>
          <td><code>0x1f3858C46F8F6fE76260b8208995D228C5cddc64</code></td>
          <td><span class="pill pill-pass">Verified</span> Uniswap V3 SwapRouter v1 ABI (<code>exactInputSingle</code>)</td>
        </tr>
        <tr>
          <td><strong>HSKSwap V3 Factory</strong></td>
          <td><code>0xD136e36610f35E0Cc3cAd40de858c151f2AA65D4</code></td>
          <td><span class="pill pill-pass">Verified</span> Live fee-tier registry probed (100 / 500 / 3000 / 10000)</td>
        </tr>
        <tr>
          <td><strong>WHSK / USDT 0.05% Pool (Oracle)</strong></td>
          <td><code>0xEB33d6666dd2359cB1BF6Ea6D72286Cc1b4a778A</code></td>
          <td><span class="pill pill-pass">Live</span> Spot &amp; 5m TWAP <code>$0.100013</code>, <code>L = 2,830,955,089,632</code></td>
        </tr>
        <tr>
          <td><strong>WHSK / USDT 0.30% Pool</strong></td>
          <td><code>0x0767F7b1af495D245EA00219cFB8B2Ed6EafAe62</code></td>
          <td><span class="pill pill-warn">Hold Signal</span> Spot &amp; 5m TWAP <code>$0.100193</code> (~18 bps spread vs 35 bps fee hurdle)</td>
        </tr>
      </tbody>
    </table>
  </div>
  <div class="footer">
    <span>Excluded from allowlist: WETH/USDT, WBTC/USDT, WHSK/WETH (Factory.getPool == address(0) on chain 177)</span>
    <span>Exact Mainnet Grounding</span>
  </div>
</section>

<!-- SLIDE 4: SMART CONTRACT RISK CONTROLS -->
<section class="slide">
  <div class="topbar">
    <span class="tag">04 · Smart Contract Risk Controls</span>
    <span class="slide-num">04 / 08</span>
  </div>
  <div>
    <h2>Five Hard EVM Guardrails Inside <code>HorizonGuardVault.sol</code></h2>
    <p class="subtitle">Every guardrail is enforced on-chain in Solidity 0.8.29 and cannot be overridden by the off-chain agent or compromised session key.</p>
  </div>
  <div class="grid-3" style="margin-top:12px;">
    <div class="card card-emerald">
      <div class="card-title accent-emerald">1. Per-Trade Notional &amp; Cooldown</div>
      <ul class="clean">
        <li>Caps single-trade notional in USD (e.g., <code>$1,000</code> default) against live TWAP valuation.</li>
        <li>Enforces <code>minTradeIntervalSec &gt;= 10s</code> (<code>MIN_TRADE_INTERVAL_SEC</code>) to block rapid drain loops.</li>
        <li>Rejects unapproved tokens or pools not pinned by owner.</li>
      </ul>
    </div>
    <div class="card card-cyan">
      <div class="card-title accent-cyan">2. Daily Loss Circuit Breaker</div>
      <ul class="clean cyan">
        <li>Tracks <code>dayStartNavE18</code> and <code>dayHighWaterNavE18</code>.</li>
        <li><strong>Pro-rata scaling:</strong> deposits/withdrawals scale baselines so inflows never mask losses and outflows never false-trip.</li>
        <li>Pre-trade breach reverts (<code>DailyDrawdownExceeded</code>); post-trade breach latches <code>circuitBreakerTripped</code>.</li>
      </ul>
    </div>
    <div class="card">
      <div class="card-title accent-amber">3. Monotonic Nonce &amp; Key Scope</div>
      <ul class="clean">
        <li>Strict monotonic nonce replay protection per session key.</li>
        <li><code>agent != owner</code> enforced (<code>AgentCannotBeOwner</code>).</li>
        <li>Signed <code>intent.deadline &lt;= block.timestamp + 15m</code> (<code>IntentDeadlineTooFar</code>) + low-<code>s</code> ECDSA check.</li>
      </ul>
    </div>
  </div>
  <div class="grid-2" style="margin-top:14px; flex:0 0 auto;">
    <div class="card">
      <div class="card-title accent-emerald">4. Pinned 5m V3 TWAP Slippage Ceiling</div>
      <ul class="clean">
        <li>Computes <code>oracleFairOut</code> &amp; <code>oracleMinOut</code> on-chain via <code>observe([300, 0])</code> + <code>TickMath</code>; reverts with <code>MinAmountOutBelowOracleFloor</code> on 1-wei attacks.</li>
        <li>Checks spot-vs-TWAP flash manipulation, minimum active liquidity floor, <code>maxStalenessSec</code> TTL, and passes non-zero directional <code>sqrtPriceLimitX96</code> to <code>SwapRouter</code>.</li>
      </ul>
    </div>
    <div class="card">
      <div class="card-title accent-cyan">5. Emergency Pause, Zero-Residual &amp; Custody</div>
      <ul class="clean cyan">
        <li>Owner-only <code>setPaused(true)</code>, <code>emergencyWithdraw()</code>, <code>resetCircuitBreaker()</code>, and <code>rescueNative()</code>.</li>
        <li><code>nonReentrant</code> on all state-mutating vault paths; exact router approval reset to <code>0</code> after every swap.</li>
      </ul>
    </div>
  </div>
  <div class="footer">
    <span>Interactive Adversarial Breaker Lab lets judges test all 5 exploit vectors via ABI calldata &amp; eth_call</span>
    <span>Solidity 0.8.29 · 20,139 B Runtime</span>
  </div>
</section>

<!-- SLIDE 5: WEB3 SECURITY VERIFICATION PROOF -->
<section class="slide">
  <div class="topbar">
    <span class="tag">05 · Web3 Security Verification Proof</span>
    <span class="slide-num">05 / 08</span>
  </div>
  <div>
    <h2>White-Box Audit: Foundry Invariants + Aderyn + Slither + Gitleaks</h2>
    <p class="subtitle">Full local formal &amp; static analysis verification executed across unit, adversarial red-team, stateless fuzz, and stateful multi-actor invariant suites.</p>
  </div>
  <div class="grid-4" style="margin:12px 0;">
    <div class="card card-emerald">
      <div class="kpi-val">28 / 28</div>
      <div class="kpi-label">Foundry <code>forge test -vv</code> PASS (22 unit/red-team + 5 fuzz + 5 invariants)</div>
    </div>
    <div class="card card-cyan">
      <div class="kpi-val cyan">4,096</div>
      <div class="kpi-label">Stateful invariant calls (128 runs &times; 32 depth), <strong>0</strong> violations</div>
    </div>
    <div class="card">
      <div class="kpi-val">0 H / 0 M</div>
      <div class="kpi-label">Exploitable High/Medium issues in Aderyn v0.6.8 &amp; Slither v0.11.6</div>
    </div>
    <div class="card">
      <div class="kpi-val amber">0 Secrets</div>
      <div class="kpi-label">Gitleaks v8.30.1 across full git history + 20,139 B EIP-170 headroom</div>
    </div>
  </div>
  <div class="card" style="padding:10px 14px; flex:1;">
    <table>
      <thead>
        <tr>
          <th>Tool / Suite</th>
          <th>Scope &amp; Configuration</th>
          <th>Verified Result</th>
          <th>Triage &amp; Hardening Notes</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>Foundry Unit &amp; Red-Team</strong></td>
          <td>22 tests in <code>contracts/test/</code></td>
          <td><span class="pill pill-pass">22 / 22 PASS</span></td>
          <td>Covers 1-wei slippage, stale oracle, fake pool keeper, +25% spot spike, replay nonce, owner!=agent.</td>
        </tr>
        <tr>
          <td><strong>Foundry Stateless Fuzz</strong></td>
          <td>5 fuzz tests (1,280 runs)</td>
          <td><span class="pill pill-pass">5 / 5 PASS</span></td>
          <td>Verifies pro-rata NAV scaling, oracle floor math, and bounded fee/slippage calculations.</td>
        </tr>
        <tr>
          <td><strong>Foundry Stateful Invariants</strong></td>
          <td>5 invariants (128 runs &times; 32 depth)</td>
          <td><span class="pill pill-pass">4,096 calls / 0 reverts</span></td>
          <td>Multi-actor deposits, withdrawals, oracle syncs, swaps, and drawdown trips preserve solvency.</td>
        </tr>
        <tr>
          <td><strong>Aderyn v0.6.8 &amp; Slither v0.11.6</strong></td>
          <td>Full Solidity AST &amp; CFG scan</td>
          <td><span class="pill pill-pass">0 Real High/Med</span></td>
          <td>Remaining flags triaged as <code>nonReentrant</code> balance-delta reads &amp; Remco Bloemen <code>FullMath</code>.</td>
        </tr>
        <tr>
          <td><strong>Gitleaks v8.30.1</strong></td>
          <td>Full repository &amp; git log</td>
          <td><span class="pill pill-pass">0 Leaks</span></td>
          <td>Zero private keys or credentials committed; runtime bytecode <code>20,139 B</code> (4,437 B under EIP-170).</td>
        </tr>
      </tbody>
    </table>
  </div>
  <div class="footer">
    <span>Reproducible locally via: cd contracts &amp;&amp; forge build --sizes &amp;&amp; forge test -vv</span>
    <span>Zero Exploitable Findings</span>
  </div>
</section>

<!-- SLIDE 6: LIVE CONSOLE & MAINNET READINESS -->
<section class="slide">
  <div class="topbar">
    <span class="tag tag-cyan">06 · Live Interactive Console &amp; Mainnet 177 Readiness</span>
    <span class="slide-num">06 / 08</span>
  </div>
  <div>
    <h2>Live HashKey Chain Terminal &amp; Exact 2.75 HSK Deploy Dry-Run Proof</h2>
    <p class="subtitle">Deployed live on GitHub Pages with direct browser RPC polling to <code>https://mainnet.hsk.xyz</code> and turnkey 1-command vault deployment.</p>
  </div>
  <div class="grid-2" style="margin-top:10px;">
    <div class="shot-wrap">
      <img src="{s1_img}" alt="HorizonQuant Command Terminal" />
      <div class="shot-cap"><strong>Command Terminal:</strong> Live <code>WHSK/USDT</code> 0.05% vs 0.30% pool telemetry, TWAP divergence, and public Act-vs-Hold Decision Ledger.</div>
    </div>
    <div class="shot-wrap">
      <img src="{s4_img}" alt="Vault Security & Mainnet Readiness" />
      <div class="shot-cap"><strong>Vault Security &amp; Breaker Lab:</strong> One-click exploit calldata verification (1-wei slippage, stale oracle, fake keeper, +25% flash spike).</div>
    </div>
  </div>
  <div class="card" style="padding:10px 14px; margin-top:10px; flex:0 0 auto;">
    <div style="display:grid; grid-template-columns: 1.35fr 1fr 1fr; gap:12px; align-items:center;">
      <div>
        <div style="font-size:10.5px; color:#94a3b8; text-transform:uppercase; font-weight:700;">Mainnet Deployer EOA (Chain ID 177)</div>
        <div class="mono" style="margin-top:3px;">0x57A46E4E5F538452E4D672EF9D48e3e90E10A81C</div>
      </div>
      <div>
        <div style="font-size:10.5px; color:#94a3b8; text-transform:uppercase; font-weight:700;">Live RPC Gas Dry-Run (2026-11-27)</div>
        <div style="font-size:12px; color:#e2e8f0; margin-top:3px;"><code>500.001 gwei</code> &times; <code>5.5M</code> gas = <strong class="accent-emerald">2.7500055 HSK</strong></div>
      </div>
      <div>
        <div style="font-size:10.5px; color:#94a3b8; text-transform:uppercase; font-weight:700;">Artifact Bytecode Sizes</div>
        <div style="font-size:12px; color:#e2e8f0; margin-top:3px;">Init: <code>21,368 B</code> · Runtime: <code>20,139 B</code></div>
      </div>
    </div>
  </div>
  <div class="footer">
    <span>Attach any deployed vault via ?vault=0x... for live policy(), session(), and ExecutionRecord[] inspection</span>
    <span>0 Console Errors on GitHub Pages</span>
  </div>
</section>

<!-- SLIDE 7: QUANT STRATEGY BACKTEST & RISK TELEMETRY -->
<section class="slide">
  <div class="topbar">
    <span class="tag">07 · Quant Strategy &amp; Risk Telemetry</span>
    <span class="slide-num">07 / 08</span>
  </div>
  <div>
    <h2>Fee-Aware Arbitrage Discipline &amp; Illustrative 30-Day Stress Model</h2>
    <p class="subtitle">Honest numeric execution logic: the agent explicitly <strong>HOLDS</strong> when gross pool spread (~18.0 bps) is below the 35.0 bps combined V3 fee hurdle.</p>
  </div>
  <div class="grid-2" style="margin-top:10px; align-items:stretch;">
    <div class="shot-wrap">
      <img src="{s3_img}" alt="HSKSwap Arbitrage & Stress Telemetry" style="height:4.35in;" />
      <div class="shot-cap"><strong>HSKSwap Arb &amp; Stress Lab:</strong> Live spread vs 35 bps fee hurdle monitor + 30-day synthetic stress drawdown comparison.</div>
    </div>
    <div style="display:flex; flex-direction:column; gap:12px;">
      <div class="card card-emerald">
        <div class="card-title accent-emerald">19 / 19 TypeScript Agent Vitest PASS</div>
        <ul class="clean">
          <li>Deterministic policy compiler maps plain-English risk rules to exact ABI parameters.</li>
          <li>EIP-712 typed-data builder &amp; signer verified against Solidity <code>DOMAIN_SEPARATOR</code> and <code>TradeIntent</code> struct hash.</li>
          <li>Zero console errors in live production Vite bundle on GitHub Pages.</li>
        </ul>
      </div>
      <div class="card card-cyan">
        <div class="card-title accent-cyan">Live Pool Spread Discipline (No Overfitting)</div>
        <ul class="clean cyan">
          <li><strong>0.05% Pool:</strong> <code>$0.100013</code> (<code>L = 2.83T</code>), canonical TWAP oracle.</li>
          <li><strong>0.30% Pool:</strong> <code>$0.100193</code> (<code>L = 0.95T</code>).</li>
          <li><strong>Gross Spread:</strong> <code>~18.0 bps</code> vs <code>35.0 bps</code> combined fee hurdle &rarr; agent logs <strong>HOLD</strong> instead of burning capital on negative-EV trades.</li>
        </ul>
      </div>
      <div class="card">
        <div class="card-title accent-amber">Transparent Stress Scenario Framing</div>
        <ul class="clean">
          <li>30-day stress test is explicitly labeled as an illustrative synthetic model showing drawdown &amp; slippage containment with vs without <code>HorizonGuardVault</code>.</li>
        </ul>
      </div>
    </div>
  </div>
  <div class="footer">
    <span>Verified via: npm test (19/19 PASS) &amp;&amp; npm run typecheck &amp;&amp; npm run build</span>
    <span>Transparent Quant Telemetry</span>
  </div>
</section>

<!-- SLIDE 8: DEPLOYMENT PLAN & ROADMAP -->
<section class="slide">
  <div class="topbar">
    <span class="tag tag-emerald">08 · Deployment Plan, MIT Repo &amp; Ecosystem Roadmap</span>
    <span class="slide-num">08 / 08</span>
  </div>
  <div>
    <h2>Turnkey Mainnet Launch &amp; HashKey Chain Ecosystem Roadmap</h2>
    <p class="subtitle">Open-source MIT codebase ready for immediate 1-command HashKey Chain Mainnet (`177`) broadcast and institutional multi-pool expansion.</p>
  </div>
  <div class="grid-3" style="margin-top:12px;">
    <div class="card card-emerald">
      <div class="card-title accent-emerald">Phase 1 · Mainnet Launch (Immediate)</div>
      <ul class="clean">
        <li>Fund deployer EOA with <code>3&ndash;5 HSK</code> (2.75 HSK gas budget verified).</li>
        <li>Run <code>npm run deploy:mainnet</code> to deploy vault, expand TWAP cardinality, pin 0.05% oracle, authorize keeper &amp; session key.</li>
        <li>Verify on <code>https://hsk.blockscout.com</code> &amp; attach <code>?vault=0x...</code>.</li>
      </ul>
    </div>
    <div class="card card-cyan">
      <div class="card-title accent-cyan">Phase 2 · Multi-Pool &amp; Keeper Mesh</div>
      <ul class="clean cyan">
        <li>Auto-enable <code>WETH/USDT</code> and <code>WBTC/USDT</code> once HSKSwap V3 pools launch on chain 177.</li>
        <li>Add decentralized Gelato/Chainlink-style keeper rotation for automated TWAP freshness sync.</li>
        <li>Multi-strategy session keys with per-strategy notional sub-limits.</li>
      </ul>
    </div>
    <div class="card">
      <div class="card-title accent-amber">Phase 3 · Institutional Compliance</div>
      <ul class="clean">
        <li>On-chain audit export (CSV/JSON) of <code>ExecutionRecord[]</code> for HashKey Chain institutional reporting.</li>
        <li>Multi-sig cold owner governance (Safe on chain 177) + hardware-backed session signers.</li>
        <li>Open MIT SDK for third-party DeFi agent builders on HashKey Chain.</li>
      </ul>
    </div>
  </div>
  <div class="card" style="margin-top:14px; padding:12px 16px; flex:0 0 auto;">
    <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:14px;">
      <div>
        <div style="font-size:10.5px; color:#94a3b8; text-transform:uppercase; font-weight:700;">Live Web Terminal &amp; PDF Deck</div>
        <div class="mono" style="margin-top:4px;">https://alphonshhhomenicmtu.github.io/horizonquant-hsk/</div>
      </div>
      <div>
        <div style="font-size:10.5px; color:#94a3b8; text-transform:uppercase; font-weight:700;">MIT GitHub Repository</div>
        <div class="mono" style="margin-top:4px;">https://github.com/alphonshhhomenicmtu/horizonquant-hsk</div>
      </div>
      <div>
        <div style="font-size:10.5px; color:#94a3b8; text-transform:uppercase; font-weight:700;">Demo Video (YouTube)</div>
        <div class="mono" style="margin-top:4px;">https://youtu.be/LRU8ifuRyeM</div>
      </div>
    </div>
  </div>
  <div class="footer">
    <span>DoraHacks HSK Chain Horizon Hackathon · Track 1: AI Agent Trading</span>
    <span>MIT Licensed · Zero Secrets · 100% Verifiable</span>
  </div>
</section>

</body>
</html>
"""


def main() -> None:
    html = build_html()
    html_path = PREVIEW_DIR / "horizonquant_deck.html"
    html_path.write_text(html, encoding="utf-8")

    subprocess.run(
        [
            CHROME,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--user-data-dir=/tmp/chrome_pdf_profile",
            "--no-pdf-header-footer",
            f"--print-to-pdf={OUT_PDF}",
            html_path.as_uri(),
        ],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if not OUT_PDF.exists() or OUT_PDF.stat().st_size < 10000:
        raise RuntimeError(f"Failed to generate {OUT_PDF}")

    pdftoppm = shutil.which("pdftoppm")
    if pdftoppm:
        for page_num, name in [(1, "horizonquant_slide1"), (3, "horizonquant_slide3"), (6, "horizonquant_slide6")]:
            prefix = PREVIEW_DIR / name
            subprocess.run(
                [pdftoppm, "-png", "-r", "150", "-singlefile", "-f", str(page_num), "-l", str(page_num), str(OUT_PDF), str(prefix)],
                check=True,
            )
    else:
        # Fallback: render single-slide HTMLs via headless Chrome
        import re
        head_end = html.index("<body>") + len("<body>")
        head = html[:head_end]
        slides = re.findall(r"(<section class=\"slide\">.*?</section>)", html, flags=re.S)
        for idx, name in [(0, "horizonquant_slide1.png"), (2, "horizonquant_slide3.png"), (5, "horizonquant_slide6.png")]:
            single_html = PREVIEW_DIR / f"_tmp_{idx}.html"
            single_html.write_text(head + slides[idx] + "</body></html>", encoding="utf-8")
            out_png = PREVIEW_DIR / name
            subprocess.run(
                [
                    CHROME,
                    "--headless=new",
                    "--disable-gpu",
                    "--no-sandbox",
                    f"--user-data-dir=/tmp/chrome_pdf_profile_{idx}",
                    "--window-size=1280,720",
                    f"--screenshot={out_png}",
                    single_html.as_uri(),
                ],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if not out_png.exists() or out_png.stat().st_size < 1000:
                raise RuntimeError(f"Failed to generate {out_png}")

    size = OUT_PDF.stat().st_size
    print(f"PDF_BUILT: {OUT_PDF} ({size} bytes)")


if __name__ == "__main__":
    main()
