import type { BacktestPoint } from "@horizonquant/agent";

interface EquityCurveChartProps {
  points: BacktestPoint[];
}

export function EquityCurveChart({ points }: EquityCurveChartProps) {
  const width = 760;
  const height = 248;
  const padLeft = 64;
  const padRight = 18;
  const padTop = 18;
  const padBottom = 30;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const allValues = points.flatMap((p) => [p.guardedNavUsd, p.unguardedNavUsd, p.benchmarkNavUsd]);
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const span = Math.max(20, rawMax - rawMin);
  const margin = span * 0.15;
  const step = span > 2000 ? 500 : span > 200 ? 50 : 10;
  const minY = Math.floor((rawMin - margin) / step) * step;
  const maxY = Math.ceil((rawMax + margin) / step) * step;

  const xOf = (idx: number) => padLeft + (idx / Math.max(1, points.length - 1)) * plotW;
  const yOf = (val: number) => padTop + (1 - (val - minY) / Math.max(1, maxY - minY)) * plotH;

  const buildPath = (extractor: (p: BacktestPoint) => number) =>
    points.map((p, idx) => `${idx === 0 ? "M" : "L"}${xOf(idx).toFixed(1)},${yOf(extractor(p)).toFixed(1)}`).join(" ");

  const guardedPath = buildPath((p) => p.guardedNavUsd);
  const unguardedPath = buildPath((p) => p.unguardedNavUsd);
  const benchmarkPath = buildPath((p) => p.benchmarkNavUsd);

  const areaPath = `${guardedPath} L${xOf(points.length - 1).toFixed(1)},${(padTop + plotH).toFixed(1)} L${xOf(0).toFixed(1)},${(padTop + plotH).toFixed(1)} Z`;

  const yTicks = Array.from({ length: 5 }, (_, i) => minY + ((maxY - minY) * i) / 4);
  const xTickIndices = [0, 5, 10, 15, 20, 25, points.length - 1];
  const cbPoints = points.filter((p) => p.circuitBreakerTriggered);

  const formatTick = (v: number) => (v >= 10_000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`);

  return (
    <div style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto", display: "block" }}>
        <defs>
          <linearGradient id="guardedFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {yTicks.map((tick, idx) => {
          const y = yOf(tick);
          return (
            <g key={idx}>
              <line x1={padLeft} y1={y} x2={width - padRight} y2={y} stroke="#1e293b" strokeWidth="1" />
              <text
                x={padLeft - 8}
                y={y + 4}
                textAnchor="end"
                fill="#64748b"
                fontSize="10.5"
                fontFamily="JetBrains Mono, monospace"
              >
                {formatTick(tick)}
              </text>
            </g>
          );
        })}

        {xTickIndices.map((idx) => (
          <text
            key={idx}
            x={xOf(idx)}
            y={height - 8}
            textAnchor="middle"
            fill="#64748b"
            fontSize="10.5"
            fontFamily="JetBrains Mono, monospace"
          >
            {points[idx]?.label ?? `D${idx}`}
          </text>
        ))}

        <path d={benchmarkPath} fill="none" stroke="#64748b" strokeWidth="1.4" strokeDasharray="3 4" />
        <path d={unguardedPath} fill="none" stroke="#f43f5e" strokeWidth="1.7" strokeDasharray="5 4" opacity="0.88" />
        <path d={areaPath} fill="url(#guardedFill)" />
        <path d={guardedPath} fill="none" stroke="#10b981" strokeWidth="2.4" />

        {cbPoints.map((pt) => {
          const cx = xOf(pt.day);
          const cy = yOf(pt.guardedNavUsd);
          return (
            <g key={pt.day}>
              <line x1={cx} y1={padTop} x2={cx} y2={padTop + plotH} stroke="#f59e0b" strokeDasharray="2 3" opacity="0.5" />
              <circle cx={cx} cy={cy} r="4.5" fill="#f59e0b" stroke="#070a10" strokeWidth="1.5" />
            </g>
          );
        })}

        {points.length > 0 && (
          <circle
            cx={xOf(points.length - 1)}
            cy={yOf(points[points.length - 1].guardedNavUsd)}
            r="4.5"
            fill="#22d3ee"
            stroke="#070a10"
            strokeWidth="1.5"
          />
        )}
      </svg>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          marginTop: 6,
          fontSize: 11.5,
          color: "#94a3b8",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 12, height: 3, background: "#10b981", display: "inline-block" }} />
            HorizonGuard Vault (Scenario)
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 12, height: 2, borderTop: "2px dashed #f43f5e", display: "inline-block" }} />
            Unguarded Bot (No Caps)
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 12, height: 2, borderTop: "2px dotted #64748b", display: "inline-block" }} />
            50/50 WHSK-USDT Hold
          </span>
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#fbbf24" }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: "#f59e0b", display: "inline-block" }} />
          Circuit Breaker Shock Cap
        </span>
      </div>
    </div>
  );
}
