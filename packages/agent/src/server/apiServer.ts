import http from "node:http";
import { HASHKEY_MAINNET } from "../config/networks.js";
import { fetchMainnetTelemetry, type ChainTelemetrySnapshot } from "../rpc/hskTelemetry.js";
import {
  evaluateDecisionCycle,
  evaluatePairSignal,
  generateDeterministicPriceSeries,
  getMarketAvailability,
  scanArbitrageOpportunities,
  simulateAdversarialAttack,
  type AdversarialAttackId,
  type VaultRuntimeState,
} from "../strategy/signalEngine.js";
import { computeVaultNavUsd, parseAndExecuteCopilotCommand } from "../copilot/commandParser.js";
import { runGuardrailStressScenario } from "../backtest/attributionEngine.js";
import { serializeIntentForDisplay } from "../vault/eip712.js";

const PORT = Number(process.env.HORIZON_API_PORT ?? 8787);

const runtimeVault: VaultRuntimeState = {
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

let cachedTelemetry: ChainTelemetrySnapshot | null = null;
let cachedAt = 0;

async function getTelemetry(): Promise<ChainTelemetrySnapshot> {
  if (!cachedTelemetry || Date.now() - cachedAt > 12_000) {
    cachedTelemetry = await fetchMainnetTelemetry();
    cachedAt = Date.now();
  }
  return cachedTelemetry;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > 65_536) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    if (url.pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, {
        status: "ok",
        service: "horizonquant-agent-api",
        chainId: HASHKEY_MAINNET.chainId,
        router: HASHKEY_MAINNET.hskSwapRouter,
      });
      return;
    }

    if (url.pathname === "/api/telemetry" && req.method === "GET") {
      const telemetry = await getTelemetry();
      sendJson(res, 200, telemetry);
      return;
    }

    if (url.pathname === "/api/state" && req.method === "GET") {
      const telemetry = await getTelemetry();
      const whskSeries = generateDeterministicPriceSeries(telemetry.whskUsdtSpot, 36, 7.2);
      const primarySignal = evaluatePairSignal("WHSK/USDT", whskSeries, runtimeVault, telemetry);
      const decision = evaluateDecisionCycle(telemetry, runtimeVault, primarySignal);
      const arbitrage = scanArbitrageOpportunities(
        telemetry,
        runtimeVault.balances.USDT,
        runtimeVault.policy.maxPositionBps,
      );

      sendJson(res, 200, {
        telemetry,
        vault: runtimeVault,
        navUsd: computeVaultNavUsd(runtimeVault, telemetry),
        markets: getMarketAvailability(telemetry),
        signals: [
          {
            ...primarySignal,
            intentDisplay: primarySignal.intent ? serializeIntentForDisplay(primarySignal.intent) : null,
          },
        ],
        decision,
        arbitrage,
      });
      return;
    }

    if (url.pathname === "/api/adversarial" && req.method === "GET") {
      const attack = (url.searchParams.get("attack") ?? "ONE_WEI_SLIPPAGE") as AdversarialAttackId;
      const telemetry = await getTelemetry();
      sendJson(res, 200, simulateAdversarialAttack(attack, runtimeVault, telemetry));
      return;
    }

    if (url.pathname === "/api/backtest" && req.method === "GET") {
      const profileParam = (url.searchParams.get("profile") ?? runtimeVault.riskAppetite).toUpperCase();
      const profile =
        profileParam === "CONSERVATIVE" || profileParam === "AGGRESSIVE" ? profileParam : "BALANCED";
      const telemetry = await getTelemetry();
      const navUsd = computeVaultNavUsd(runtimeVault, telemetry);
      const report = runGuardrailStressScenario(navUsd, runtimeVault.policy, profile, telemetry.whskUsdtSpot);
      sendJson(res, 200, report);
      return;
    }

    if (url.pathname === "/api/copilot" && req.method === "POST") {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw || "{}") as { command?: string };
      if (!parsed.command || typeof parsed.command !== "string") {
        sendJson(res, 400, { error: "Missing 'command' string" });
        return;
      }
      const telemetry = await getTelemetry();
      const result = parseAndExecuteCopilotCommand(parsed.command, runtimeVault, telemetry);

      if (result.patch.policy) {
        runtimeVault.policy = { ...runtimeVault.policy, ...result.patch.policy };
      }
      if (result.patch.strategyMode) runtimeVault.strategyMode = result.patch.strategyMode;
      if (result.patch.riskAppetite) runtimeVault.riskAppetite = result.patch.riskAppetite;
      if (result.patch.targetPairs) runtimeVault.targetPairs = result.patch.targetPairs;
      if (typeof result.patch.paused === "boolean") runtimeVault.paused = result.patch.paused;
      if (result.patch.resetCircuitBreaker) {
        runtimeVault.circuitBreakerTripped = false;
        runtimeVault.currentDrawdownBps = 0;
      }
      if (typeof result.patch.simulateDrawdownBps === "number") {
        runtimeVault.currentDrawdownBps = result.patch.simulateDrawdownBps;
        if (result.patch.simulateDrawdownBps >= runtimeVault.policy.dailyDrawdownCapBps) {
          runtimeVault.circuitBreakerTripped = true;
        }
      }

      sendJson(res, 200, {
        ...result,
        vault: runtimeVault,
        navUsd: computeVaultNavUsd(runtimeVault, telemetry),
      });
      return;
    }

    sendJson(res, 404, { error: "Route not found" });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`[HorizonQuant API] Listening on http://127.0.0.1:${PORT} (HashKey Chain 177)`);
});
