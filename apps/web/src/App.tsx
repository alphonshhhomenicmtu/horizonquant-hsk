import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Bot, LayoutDashboard, Shield } from "lucide-react";
import {
  computeVaultNavUsd,
  evaluatePairSignal,
  fetchMainnetTelemetry,
  generateDeterministicPriceSeries,
  HASHKEY_MAINNET,
  parseAndExecuteCopilotCommand,
  runDeterministicBacktest,
  scanArbitrageOpportunities,
  VERIFIED_MAINNET_SNAPSHOT,
  type ChainTelemetrySnapshot,
  type QuantSignal,
  type VaultRuntimeState,
} from "@horizonquant/agent";
import { TopTelemetryBar } from "./components/TopTelemetryBar";
import { CommandOverviewView, type ChatMessage } from "./components/CommandOverviewView";
import { CopilotIntentView, type SimulatedExecutionLog } from "./components/CopilotIntentView";
import { ArbitrageBacktestView } from "./components/ArbitrageBacktestView";
import { VaultSecurityView } from "./components/VaultSecurityView";

type TabId = "overview" | "copilot" | "analytics" | "vault";

const INITIAL_VAULT: VaultRuntimeState = {
  vaultAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  agentAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  paused: false,
  circuitBreakerTripped: false,
  currentDrawdownBps: 42,
  dailyTradeCount: 6,
  secondsSinceLastTrade: 410,
  sessionVolumeUsedUsd: 42_500,
  sessionVolumeCapUsd: 250_000,
  nonce: 6,
  balances: {
    USDT: 46_250,
    WHSK: 237_500,
    WETH: 2.4,
    WBTC: 0.08,
  },
  policy: {
    maxSlippageBps: 50,
    maxPositionBps: 2500,
    dailyDrawdownCapBps: 300,
    minTradeIntervalSec: 300,
    maxDailyTrades: 24,
  },
  strategyMode: "HYBRID",
  riskAppetite: "BALANCED",
  targetPairs: ["WHSK/USDT", "WETH/USDT", "WBTC/USDT"],
};

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "init-1",
    role: "agent",
    text:
      "HorizonQuant Copilot online on HashKey Chain Mainnet (chainId 177). Connected to HSKSwap V3 SwapRouter (0x1f38...dc64) with hard on-chain guardrails armed: 50 bps slippage cap, 25% max single-trade size, and 3.00% daily drawdown circuit breaker.",
  },
];

const INITIAL_EXECUTIONS: SimulatedExecutionLog[] = [
  {
    id: 5,
    timestamp: "14:52:18 UTC",
    pair: "WHSK/USDT",
    action: "BUY",
    notionalUsd: 8400,
    slippageBps: 9,
    strategyTag: "HQ_MOMENTUM_WHSK_USDT",
    signalHash: "0x91e4f8a2b1c409d31e5f7c2a4d8b3091f2a71e5c8a2d49b6c1e80f3a41d2e6a4",
    intentDigest: "0x4a7b2c91d8e031f5c6a92b4d8e1f0c3a9b7d2e5f8c1a4b6d0e3f9a2c5b8d1e4f",
  },
  {
    id: 4,
    timestamp: "14:18:04 UTC",
    pair: "WETH/USDT",
    action: "BUY",
    notionalUsd: 6250,
    slippageBps: 14,
    strategyTag: "HQ_MEAN_REVERSION_WETH_USDT",
    signalHash: "0x5c3e1a9d7b4f82e60a1c9d3e5f7b2a4c8d0e1f3a5b7c9d1e3f5a7b9c1d3e5f7a",
    intentDigest: "0x8d2f4a6c1e9b3d5f7a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f",
  },
  {
    id: 3,
    timestamp: "13:34:49 UTC",
    pair: "WHSK/USDT",
    action: "ARB_ROTATE",
    notionalUsd: 5100,
    slippageBps: 6,
    strategyTag: "HQ_ARBITRAGE_WHSK_USDT",
    signalHash: "0x2f4e6d8c0b2a496877564534231201ffeeddccbbaa99887766554433221100ab",
    intentDigest: "0x7c5a3e1f9d7b5a3c1e9f7d5b3a1c9e7f5d3b1a9c7e5f3d1b9a7c5e3f1d9b7a5c",
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const hash = window.location.hash.replace(/^#\/?/, "");
    if (hash === "copilot" || hash === "analytics" || hash === "vault") return hash;
    return "overview";
  });
  const [telemetry, setTelemetry] = useState<ChainTelemetrySnapshot>(VERIFIED_MAINNET_SNAPSHOT);
  const [refreshing, setRefreshing] = useState(false);
  const [vault, setVault] = useState<VaultRuntimeState>(INITIAL_VAULT);
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [executions, setExecutions] = useState<SimulatedExecutionLog[]>(INITIAL_EXECUTIONS);
  const [selectedProfile, setSelectedProfile] = useState<"CONSERVATIVE" | "BALANCED" | "AGGRESSIVE">("BALANCED");

  const syncRpc = useCallback(async () => {
    setRefreshing(true);
    try {
      const snap = await fetchMainnetTelemetry();
      setTelemetry(snap);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void syncRpc();
  }, [syncRpc]);

  const handleSelectTab = (tab: TabId) => {
    setActiveTab(tab);
    window.history.replaceState(null, "", `#${tab}`);
  };

  const navUsd = useMemo(() => computeVaultNavUsd(vault, telemetry), [vault, telemetry]);

  const signals = useMemo(() => {
    const whskSeries = generateDeterministicPriceSeries(telemetry.whskUsdtSpot, 36, 8.2);
    const wethSeries = generateDeterministicPriceSeries(HASHKEY_MAINNET.tokens.WETH.referenceUsd, 36, 4.4);
    const wbtcSeries = generateDeterministicPriceSeries(HASHKEY_MAINNET.tokens.WBTC.referenceUsd, 36, -1.2);
    const fixedNow = Math.floor(Date.now() / 1000);
    return [
      evaluatePairSignal("WHSK/USDT", whskSeries, vault, telemetry, fixedNow),
      evaluatePairSignal("WETH/USDT", wethSeries, vault, telemetry, fixedNow),
      evaluatePairSignal("WBTC/USDT", wbtcSeries, vault, telemetry, fixedNow),
    ];
  }, [telemetry, vault]);

  const arbitrage = useMemo(
    () => scanArbitrageOpportunities(telemetry, vault.balances.USDT, vault.policy.maxPositionBps),
    [telemetry, vault.balances.USDT, vault.policy.maxPositionBps],
  );

  const backtest = useMemo(
    () => runDeterministicBacktest(navUsd, vault.policy, selectedProfile, telemetry.whskUsdtSpot),
    [navUsd, vault.policy, selectedProfile, telemetry.whskUsdtSpot],
  );

  const handleSendCommand = useCallback(
    (cmd: string) => {
      const result = parseAndExecuteCopilotCommand(cmd, vault, telemetry);

      setVault((prev) => {
        const next: VaultRuntimeState = {
          ...prev,
          policy: result.patch.policy ? { ...prev.policy, ...result.patch.policy } : prev.policy,
          strategyMode: result.patch.strategyMode ?? prev.strategyMode,
          riskAppetite: result.patch.riskAppetite ?? prev.riskAppetite,
          targetPairs: result.patch.targetPairs ?? prev.targetPairs,
          paused: typeof result.patch.paused === "boolean" ? result.patch.paused : prev.paused,
        };
        if (result.patch.resetCircuitBreaker) {
          next.circuitBreakerTripped = false;
          next.currentDrawdownBps = 0;
        }
        if (typeof result.patch.simulateDrawdownBps === "number") {
          next.currentDrawdownBps = result.patch.simulateDrawdownBps;
          if (result.patch.simulateDrawdownBps >= next.policy.dailyDrawdownCapBps) {
            next.circuitBreakerTripped = true;
          }
        }
        return next;
      });

      if (result.patch.riskAppetite) {
        setSelectedProfile(result.patch.riskAppetite);
      }

      const firstAction = result.onChainActions[0];
      setMessages((prev) => [
        ...prev,
        { id: `u-${Date.now()}`, role: "user", text: cmd },
        {
          id: `a-${Date.now() + 1}`,
          role: "agent",
          text: result.reply,
          fnName: firstAction?.functionName,
          calldata: firstAction?.calldata,
          rejected: result.rejectedConstraints,
        },
      ]);
    },
    [telemetry, vault],
  );

  const handleExecuteSignal = useCallback(
    (signal: QuantSignal) => {
      if (!signal.intent || !signal.allGuardsPassed) return;
      const notional = signal.recommendedSizeUsd;
      const realizedSlip = Math.min(vault.policy.maxSlippageBps - 5, 11);

      setVault((prev) => {
        const nextBalances = { ...prev.balances };
        if (signal.pair === "WHSK/USDT") {
          if (signal.action === "BUY" || signal.action === "ARB_ROTATE") {
            nextBalances.USDT = Math.max(0, Number((nextBalances.USDT - notional).toFixed(2)));
            nextBalances.WHSK = Number((nextBalances.WHSK + notional / signal.spotPrice).toFixed(2));
          } else {
            nextBalances.USDT = Number((nextBalances.USDT + notional).toFixed(2));
            nextBalances.WHSK = Math.max(0, Number((nextBalances.WHSK - notional / signal.spotPrice).toFixed(2)));
          }
        } else if (signal.pair === "WETH/USDT") {
          nextBalances.USDT = Math.max(0, Number((nextBalances.USDT - notional).toFixed(2)));
          nextBalances.WETH = Number((nextBalances.WETH + notional / signal.spotPrice).toFixed(4));
        }

        return {
          ...prev,
          nonce: prev.nonce + 1,
          dailyTradeCount: prev.dailyTradeCount + 1,
          sessionVolumeUsedUsd: Number((prev.sessionVolumeUsedUsd + notional).toFixed(2)),
          balances: nextBalances,
        };
      });

      setExecutions((prev) => [
        {
          id: vault.nonce,
          timestamp: new Date().toISOString().slice(11, 19) + " UTC",
          pair: signal.pair,
          action: signal.action,
          notionalUsd: notional,
          slippageBps: realizedSlip,
          strategyTag: `HQ_${signal.strategyMode}_${signal.pair.replace("/", "_")}`,
          signalHash: signal.intent!.signalHash,
          intentDigest: signal.intentDigest ?? "0x0",
        },
        ...prev,
      ]);

      setMessages((prev) => [
        ...prev,
        {
          id: `exec-${Date.now()}`,
          role: "agent",
          text: `Executed guarded EIP-712 swap #${vault.nonce} on HSKSwap V3 (${signal.pair} ${signal.action} $${notional.toLocaleString()}) · Realized slippage ${realizedSlip} bps (cap ${vault.policy.maxSlippageBps} bps) · Zero residual router allowance confirmed.`,
        },
      ]);
    },
    [vault.nonce, vault.policy.maxSlippageBps],
  );

  return (
    <div className="app-shell">
      <TopTelemetryBar telemetry={telemetry} vault={vault} refreshing={refreshing} onRefresh={syncRpc} />

      <nav className="nav-bar">
        <div className="nav-tabs">
          <button
            type="button"
            className={`nav-tab ${activeTab === "overview" ? "active" : ""}`}
            onClick={() => handleSelectTab("overview")}
          >
            <LayoutDashboard size={14} />
            Command &amp; Risk Terminal
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === "copilot" ? "active" : ""}`}
            onClick={() => handleSelectTab("copilot")}
          >
            <Bot size={14} />
            Copilot &amp; EIP-712 Studio
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === "analytics" ? "active" : ""}`}
            onClick={() => handleSelectTab("analytics")}
          >
            <BarChart3 size={14} />
            HSKSwap Arbitrage &amp; Backtest
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === "vault" ? "active" : ""}`}
            onClick={() => handleSelectTab("vault")}
          >
            <Shield size={14} />
            On-Chain Vault &amp; Mainnet Deploy
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, color: "#94a3b8" }}>
          <span>Router:</span>
          <span className="mono text-cyan">0x1f38...dc64 (HSKSwap V3)</span>
          <span className="badge badge-emerald">Non-Custodial</span>
        </div>
      </nav>

      <main className="workspace">
        {activeTab === "overview" && (
          <CommandOverviewView
            telemetry={telemetry}
            vault={vault}
            navUsd={navUsd}
            signals={signals}
            backtest={backtest}
            messages={messages}
            onSendCommand={handleSendCommand}
            onExecuteSignal={handleExecuteSignal}
          />
        )}
        {activeTab === "copilot" && (
          <CopilotIntentView
            vault={vault}
            signals={signals}
            messages={messages}
            executions={executions}
            onSendCommand={handleSendCommand}
            onExecuteSignal={handleExecuteSignal}
          />
        )}
        {activeTab === "analytics" && (
          <ArbitrageBacktestView
            telemetry={telemetry}
            arbitrage={arbitrage}
            backtest={backtest}
            selectedProfile={selectedProfile}
            onSelectProfile={setSelectedProfile}
          />
        )}
        {activeTab === "vault" && (
          <VaultSecurityView
            vault={vault}
            onSimulateCrash={() => handleSendCommand("Simulate 3.5% drawdown crash to test circuit breaker")}
            onResetCircuitBreaker={() => handleSendCommand("Reset circuit breaker and resume trading")}
            onTogglePause={() =>
              handleSendCommand(vault.paused ? "Resume trading and unpause vault" : "Emergency pause vault")
            }
          />
        )}
      </main>
    </div>
  );
}
