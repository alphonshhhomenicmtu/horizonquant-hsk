import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Bot, LayoutDashboard, Shield } from "lucide-react";
import { isAddress, type Address } from "viem";
import {
  computeVaultNavUsd,
  evaluateDecisionCycle,
  evaluatePairSignal,
  fetchLiveVaultState,
  fetchMainnetTelemetry,
  generateDeterministicPriceSeries,
  getMarketAvailability,
  HASHKEY_MAINNET,
  parseAndExecuteCopilotCommand,
  runGuardrailStressScenario,
  scanArbitrageOpportunities,
  simulateAdversarialAttack,
  VERIFIED_MAINNET_SNAPSHOT,
  type AdversarialAttackId,
  type AdversarialCheckResult,
  type AgentDecisionEntry,
  type ChainTelemetrySnapshot,
  type QuantSignal,
  type VaultRuntimeState,
} from "@horizonquant/agent";
import { TopTelemetryBar } from "./components/TopTelemetryBar";
import { CommandOverviewView, type ChatMessage } from "./components/CommandOverviewView";
import { CopilotIntentView, type ExecutionLogItem } from "./components/CopilotIntentView";
import { ArbitrageBacktestView } from "./components/ArbitrageBacktestView";
import { VaultSecurityView } from "./components/VaultSecurityView";
import {
  broadcastPolicyUpdateOnChain,
  broadcastVaultControlOnChain,
  connectHskWallet,
  signAndBroadcastGuardedSwap,
  verifyAdversarialRevertLive,
} from "./wallet/hskWallet";

type TabId = "overview" | "copilot" | "analytics" | "vault";

const INITIAL_VAULT: VaultRuntimeState = {
  vaultAddress: HASHKEY_MAINNET.deployedVaultAddress,
  ownerAddress: HASHKEY_MAINNET.deployerAddress,
  agentAddress: "0x000000000000000000000000000000000000dEaD",
  isLiveOnChain: false,
  paused: false,
  circuitBreakerTripped: false,
  currentDrawdownBps: 0,
  dailyTradeCount: 0,
  secondsSinceLastTrade: 600,
  oracleAgeSec: 45,
  oracleMaxStalenessSec: 3600,
  oracleMaxDeviationBps: 1000,
  sessionVolumeUsedUsd: 0,
  sessionVolumeCapUsd: 1_000,
  nonce: 0,
  balances: {
    USDT: 500,
    WHSK: 5_000,
  },
  policy: {
    maxSlippageBps: 50,
    maxPositionBps: 2500,
    dailyDrawdownCapBps: 300,
    minTradeIntervalSec: 300,
    maxDailyTrades: 24,
  },
  strategyMode: "ARBITRAGE",
  riskAppetite: "BALANCED",
  targetPairs: ["WHSK/USDT"],
};

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "init-1",
    role: "agent",
    text:
      "Deterministic Policy Compiler online for HashKey Chain Mainnet (chainId 177). Streaming live WHSK/USDT 0.05% and 0.30% V3 pools from https://mainnet.hsk.xyz. Connect an EIP-1193 wallet and attach a deployed HorizonGuardVault address to broadcast real on-chain transactions.",
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
  const [busyTx, setBusyTx] = useState(false);
  const [walletAddress, setWalletAddress] = useState<Address | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [vault, setVault] = useState<VaultRuntimeState>(INITIAL_VAULT);
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [executions, setExecutions] = useState<ExecutionLogItem[]>([]);
  const [decisions, setDecisions] = useState<AgentDecisionEntry[]>([]);
  const [adversarialLog, setAdversarialLog] = useState<AdversarialCheckResult[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<"CONSERVATIVE" | "BALANCED" | "AGGRESSIVE">("BALANCED");

  const navUsd = useMemo(() => computeVaultNavUsd(vault, telemetry), [vault, telemetry]);
  const markets = useMemo(() => getMarketAvailability(telemetry), [telemetry]);

  const primarySignal = useMemo(() => {
    const whskSeries = generateDeterministicPriceSeries(telemetry.whskUsdtSpot, 36, 8.2);
    const fixedNow = Math.floor(Date.now() / 1000);
    return evaluatePairSignal("WHSK/USDT", whskSeries, vault, telemetry, fixedNow);
  }, [telemetry, vault]);

  const arbitrage = useMemo(
    () => scanArbitrageOpportunities(telemetry, vault.balances.USDT, vault.policy.maxPositionBps),
    [telemetry, vault.balances.USDT, vault.policy.maxPositionBps],
  );

  const backtest = useMemo(
    () => runGuardrailStressScenario(Math.max(100, navUsd), vault.policy, selectedProfile, telemetry.whskUsdtSpot),
    [navUsd, vault.policy, selectedProfile, telemetry.whskUsdtSpot],
  );

  const loadDeployedVault = useCallback(async (rawAddress: string) => {
    if (!isAddress(rawAddress)) {
      setMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: "agent", text: `Invalid vault address: ${rawAddress}` },
      ]);
      return;
    }
    setBusyTx(true);
    try {
      const live = await fetchLiveVaultState(rawAddress as Address);
      const nowSec = Math.floor(Date.now() / 1000);
      setVault((prev) => ({
        ...prev,
        vaultAddress: live.vaultAddress,
        ownerAddress: live.owner,
        agentAddress: live.agent,
        isLiveOnChain: true,
        paused: live.paused,
        circuitBreakerTripped: live.circuitBreakerTripped,
        currentDrawdownBps: live.currentDrawdownBps,
        dailyTradeCount: live.dailyTradeCount,
        secondsSinceLastTrade: live.lastTradeTimestamp > 0 ? Math.max(0, nowSec - live.lastTradeTimestamp) : 9999,
        oracleAgeSec: live.whskLastPriceUpdatedAt > 0 ? Math.max(0, nowSec - live.whskLastPriceUpdatedAt) : 9999,
        oracleMaxStalenessSec: live.oracleMaxStalenessSec || 3600,
        oracleMaxDeviationBps: live.oracleMaxDeviationBps || 1000,
        sessionVolumeUsedUsd: Number(live.sessionVolumeUsedUsd.toFixed(2)),
        sessionVolumeCapUsd: Number(live.sessionVolumeCapUsd.toFixed(2)),
        nonce: live.nonce,
        balances: {
          USDT: Number(live.usdtBalance.toFixed(4)),
          WHSK: Number(live.whskBalance.toFixed(4)),
        },
        policy: live.policy,
      }));
      setExecutions(
        live.executions.map((ex) => ({
          id: ex.id,
          timestamp: new Date(ex.timestamp * 1000).toISOString().slice(11, 19) + " UTC",
          pair: "WHSK/USDT",
          action: ex.tokenIn.toLowerCase() === HASHKEY_MAINNET.tokens.USDT.address.toLowerCase() ? "BUY" : "SELL",
          notionalUsd: Number(ex.postTradeNavE18) > 0 ? Number((Number(ex.amountIn) / 1e6).toFixed(4)) : 0,
          slippageBps: ex.realizedSlippageBps,
          strategyTag: ex.strategyTag,
          signalHash: ex.signalHash,
          intentDigest: ex.signalHash,
          mode: "ON_CHAIN_TX",
        })),
      );
      setMessages((prev) => [
        ...prev,
        {
          id: `vault-${Date.now()}`,
          role: "agent",
          text: `Attached live HorizonGuardVault ${live.vaultAddress} on chainId 177. Owner ${live.owner.slice(0, 10)}..., Agent ${live.agent.slice(0, 10)}..., NAV $${live.totalNavUsd.toFixed(2)}, ${live.executions.length} on-chain execution records.`,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `verr-${Date.now()}`,
          role: "agent",
          text: `Failed reading HorizonGuardVault at ${rawAddress}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setBusyTx(false);
    }
  }, []);

  const syncRpc = useCallback(async () => {
    setRefreshing(true);
    try {
      const snap = await fetchMainnetTelemetry();
      setTelemetry(snap);
      const whskSeries = generateDeterministicPriceSeries(snap.whskUsdtSpot, 36, 8.2);
      const sig = evaluatePairSignal("WHSK/USDT", whskSeries, vault, snap, Math.floor(Date.now() / 1000));
      const dec = evaluateDecisionCycle(snap, vault, sig);
      setDecisions((prev) => [dec, ...prev].slice(0, 20));
    } finally {
      setRefreshing(false);
    }
  }, [vault]);

  useEffect(() => {
    void syncRpc();
    const params = new URLSearchParams(window.location.search);
    const paramVault = params.get("vault");
    if (paramVault && isAddress(paramVault)) {
      void loadDeployedVault(paramVault);
    }
    // Initial boot sync only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectTab = (tab: TabId) => {
    setActiveTab(tab);
    window.history.replaceState(null, "", `#${tab}`);
  };

  const handleConnectWallet = useCallback(async () => {
    try {
      const res = await connectHskWallet();
      setWalletAddress(res.address);
      setWalletChainId(res.chainId);
      setMessages((prev) => [
        ...prev,
        {
          id: `wallet-${Date.now()}`,
          role: "agent",
          text: `Wallet connected: ${res.address} on chainId ${res.chainId}${res.switchedToHsk ? " (HashKey Chain Mainnet verified)." : " — switch network to HashKey Chain Mainnet (177) before broadcasting."}`,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `werr-${Date.now()}`,
          role: "agent",
          text: err instanceof Error ? err.message : String(err),
        },
      ]);
    }
  }, []);

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

  const handleBroadcastPolicy = useCallback(async () => {
    if (!walletAddress || !vault.vaultAddress || !vault.isLiveOnChain) return;
    setBusyTx(true);
    try {
      const res = await broadcastPolicyUpdateOnChain(vault.vaultAddress, walletAddress, vault.policy);
      setMessages((prev) => [
        ...prev,
        {
          id: `tx-${Date.now()}`,
          role: "agent",
          text: `Broadcast updateRiskPolicy on HashKey Chain Mainnet (177). Confirmed tx ready on Blockscout.`,
          txHash: res.txHash,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `txerr-${Date.now()}`,
          role: "agent",
          text: `Policy transaction reverted/rejected: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setBusyTx(false);
    }
  }, [vault.isLiveOnChain, vault.policy, vault.vaultAddress, walletAddress]);

  const handleExecuteSignal = useCallback(
    async (signal: QuantSignal) => {
      if (!signal.intent || !signal.allGuardsPassed) return;

      // Path A: Real wallet + live deployed vault -> real EIP-712 signature + mainnet tx
      if (walletAddress && vault.vaultAddress && vault.isLiveOnChain) {
        setBusyTx(true);
        try {
          const res = await signAndBroadcastGuardedSwap(vault.vaultAddress, walletAddress, signal.intent);
          setExecutions((prev) => [
            {
              id: vault.nonce,
              timestamp: new Date().toISOString().slice(11, 19) + " UTC",
              pair: signal.pair,
              action: signal.action,
              notionalUsd: signal.recommendedSizeUsd,
              slippageBps: 0,
              strategyTag: `HQ_${signal.strategyMode}_WHSK_USDT`,
              signalHash: signal.intent!.signalHash,
              intentDigest: signal.intentDigest ?? "0x0",
              mode: "ON_CHAIN_TX",
              txHash: res.txHash,
            },
            ...prev,
          ]);
          setMessages((prev) => [
            ...prev,
            {
              id: `exec-tx-${Date.now()}`,
              role: "agent",
              text: `Signed EIP-712 TradeIntent and broadcast executeGuardedSwap on HSK Chain Mainnet (177).`,
              txHash: res.txHash,
            },
          ]);
          await loadDeployedVault(vault.vaultAddress);
        } catch (err) {
          setMessages((prev) => [
            ...prev,
            {
              id: `exec-err-${Date.now()}`,
              role: "agent",
              text: `On-chain executeGuardedSwap reverted or rejected by wallet: ${err instanceof Error ? err.message : String(err)}`,
            },
          ]);
        } finally {
          setBusyTx(false);
        }
        return;
      }

      // Path B: Honest local paper fill (never pretends an on-chain tx was mined)
      const notional = signal.recommendedSizeUsd;
      const simulatedSlip = Math.min(vault.policy.maxSlippageBps, 8);
      setVault((prev) => {
        const nextBalances = { ...prev.balances };
        if (signal.action === "BUY" || signal.action === "ARB_ROTATE") {
          nextBalances.USDT = Math.max(0, Number((nextBalances.USDT - notional).toFixed(4)));
          nextBalances.WHSK = Number((nextBalances.WHSK + notional / signal.twapPrice).toFixed(4));
        } else {
          nextBalances.USDT = Number((nextBalances.USDT + notional).toFixed(4));
          nextBalances.WHSK = Math.max(0, Number((nextBalances.WHSK - notional / signal.twapPrice).toFixed(4)));
        }
        return {
          ...prev,
          nonce: prev.nonce + 1,
          dailyTradeCount: prev.dailyTradeCount + 1,
          sessionVolumeUsedUsd: Number((prev.sessionVolumeUsedUsd + notional).toFixed(4)),
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
          slippageBps: simulatedSlip,
          strategyTag: `HQ_${signal.strategyMode}_WHSK_USDT`,
          signalHash: signal.intent!.signalHash,
          intentDigest: signal.intentDigest ?? "0x0",
          mode: "PAPER_FILL",
        },
        ...prev,
      ]);

      setMessages((prev) => [
        ...prev,
        {
          id: `paper-${Date.now()}`,
          role: "agent",
          text: `[PAPER FILL — NO ON-CHAIN TX SENT] Simulated ${signal.pair} ${signal.action} $${notional.toFixed(4)} inside 2% pool depth cap. Connect an EIP-1193 wallet + deployed vault address to sign and broadcast live on chainId 177.`,
        },
      ]);
    },
    [loadDeployedVault, vault.isLiveOnChain, vault.nonce, vault.policy.maxSlippageBps, vault.vaultAddress, walletAddress],
  );

  const handleRunAdversarial = useCallback(
    async (attackId: AdversarialAttackId) => {
      const parityResult = simulateAdversarialAttack(attackId, vault, telemetry);
      if (vault.vaultAddress && vault.isLiveOnChain) {
        setBusyTx(true);
        try {
          const liveResult = await verifyAdversarialRevertLive(vault.vaultAddress, parityResult);
          setAdversarialLog((prev) => [liveResult, ...prev].slice(0, 10));
        } finally {
          setBusyTx(false);
        }
      } else {
        setAdversarialLog((prev) => [parityResult, ...prev].slice(0, 10));
      }
    },
    [telemetry, vault],
  );

  const handleVaultControl = useCallback(
    async (action: "PAUSE" | "UNPAUSE" | "RESET_CB" | "SYNC_TWAP") => {
      if (walletAddress && vault.vaultAddress && vault.isLiveOnChain) {
        setBusyTx(true);
        try {
          const res = await broadcastVaultControlOnChain(vault.vaultAddress, walletAddress, action);
          setMessages((prev) => [
            ...prev,
            {
              id: `ctl-${Date.now()}`,
              role: "agent",
              text: `Broadcast ${action} to HorizonGuardVault on HashKey Chain Mainnet (177).`,
              txHash: res.txHash,
            },
          ]);
          await loadDeployedVault(vault.vaultAddress);
        } catch (err) {
          setMessages((prev) => [
            ...prev,
            {
              id: `ctlerr-${Date.now()}`,
              role: "agent",
              text: `Control tx failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ]);
        } finally {
          setBusyTx(false);
        }
        return;
      }

      if (action === "PAUSE") handleSendCommand("Emergency pause vault");
      else if (action === "UNPAUSE") handleSendCommand("Resume trading and unpause vault");
      else if (action === "RESET_CB") handleSendCommand("Reset circuit breaker and resume trading");
    },
    [handleSendCommand, loadDeployedVault, vault.isLiveOnChain, vault.vaultAddress, walletAddress],
  );

  return (
    <div className="app-shell">
      <TopTelemetryBar
        telemetry={telemetry}
        vault={vault}
        walletAddress={walletAddress}
        walletChainId={walletChainId}
        refreshing={refreshing}
        onRefresh={syncRpc}
        onConnectWallet={handleConnectWallet}
      />

      <nav className="nav-bar">
        <div className="nav-tabs">
          <button
            type="button"
            className={`nav-tab ${activeTab === "overview" ? "active" : ""}`}
            onClick={() => handleSelectTab("overview")}
          >
            <LayoutDashboard size={14} />
            Decision Ledger &amp; Terminal
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === "copilot" ? "active" : ""}`}
            onClick={() => handleSelectTab("copilot")}
          >
            <Bot size={14} />
            Policy Compiler &amp; EIP-712
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === "analytics" ? "active" : ""}`}
            onClick={() => handleSelectTab("analytics")}
          >
            <BarChart3 size={14} />
            Live Pools &amp; Stress Scenario
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === "vault" ? "active" : ""}`}
            onClick={() => handleSelectTab("vault")}
          >
            <Shield size={14} />
            Adversarial Breaker Lab &amp; Deploy
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, color: "#94a3b8" }}>
          <span>Router:</span>
          <span className="mono text-cyan">0x1f38...dc64</span>
          <span className="badge badge-emerald">TWAP + Oracle Floor</span>
        </div>
      </nav>

      <main className="workspace">
        {activeTab === "overview" && (
          <CommandOverviewView
            telemetry={telemetry}
            vault={vault}
            navUsd={navUsd}
            primarySignal={primarySignal}
            markets={markets}
            liveArb={arbitrage[0]}
            decisions={decisions}
            messages={messages}
            walletAddress={walletAddress}
            busyTx={busyTx}
            onSendCommand={handleSendCommand}
            onExecuteSignal={handleExecuteSignal}
            onBroadcastPolicy={handleBroadcastPolicy}
            onScanNow={syncRpc}
            onJumpToBreakerLab={() => handleSelectTab("vault")}
          />
        )}
        {activeTab === "copilot" && (
          <CopilotIntentView
            vault={vault}
            primarySignal={primarySignal}
            messages={messages}
            executions={executions}
            walletAddress={walletAddress}
            busyTx={busyTx}
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
            walletAddress={walletAddress}
            adversarialLog={adversarialLog}
            busyTx={busyTx}
            onRunAdversarialTest={handleRunAdversarial}
            onLoadVaultAddress={loadDeployedVault}
            onSimulateCrash={() => handleSendCommand("Simulate 3.5% drawdown crash to test circuit breaker")}
            onResetCircuitBreaker={() => handleVaultControl("RESET_CB")}
            onTogglePause={() => handleVaultControl(vault.paused ? "UNPAUSE" : "PAUSE")}
            onSyncTwapOnChain={() => handleVaultControl("SYNC_TWAP")}
          />
        )}
      </main>
    </div>
  );
}
