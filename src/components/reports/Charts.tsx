"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Card, DataTable, cn, type Column } from "@/components/ui";
import { describeSeries, formatDay, indexAtX, labelIndexes, moveCursor, niceMax, readout, sum } from "./helpers";

export type ChartTone = "accent" | "info" | "warn" | "bad" | "muted";
export type Series = { name: string; values: number[]; tone?: ChartTone };

const TONE_VAR: Record<ChartTone, string> = {
  accent: "var(--accent-ink)",
  info: "var(--info)",
  warn: "var(--warn)",
  bad: "var(--bad)",
  muted: "var(--muted)",
};
const DEFAULT_TONES: ChartTone[] = ["info", "accent", "warn", "muted", "bad"];
const DASHES = ["", "6 3", "2 3", "8 3 2 3", "1 4"];
const MARKERS = ["circle", "square", "diamond", "triangle", "circle"] as const;
const H = 220;
const PAD = { l: 46, r: 12, t: 12, b: 28 };
const DEFAULT_WIDTH = 640;

const colorOf = (s: Series, i: number) => TONE_VAR[s.tone ?? DEFAULT_TONES[i % DEFAULT_TONES.length]];

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(240, Math.round(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function Marker({ shape, x, y, r, color }: { shape: (typeof MARKERS)[number]; x: number; y: number; r: number; color: string }) {
  const style = { fill: color };
  if (shape === "square") return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} style={style} />;
  if (shape === "diamond") return <polygon points={`${x},${y - r - 1} ${x + r + 1},${y} ${x},${y + r + 1} ${x - r - 1},${y}`} style={style} />;
  if (shape === "triangle") return <polygon points={`${x},${y - r - 1} ${x + r + 1},${y + r} ${x - r - 1},${y + r}`} style={style} />;
  return <circle cx={x} cy={y} r={r} style={style} />;
}

type ChartProps = { kind: "line" | "bar"; title: string; description?: string; days: string[]; series: Series[] };

function Chart({ kind, title, description, days, series }: ChartProps) {
  const uid = useId();
  const [frame, width] = useWidth();
  const [cursor, setCursor] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const [tableOpen, setTableOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);

  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const plotL = PAD.l;
  const plotR = Math.max(plotL + 40, width - PAD.r);
  const band = (plotR - plotL) / Math.max(1, days.length);
  const x = (i: number) => (kind === "bar" ? plotL + band * i + band / 2 : plotL + (days.length <= 1 ? (plotR - plotL) / 2 : (i / (days.length - 1)) * (plotR - plotL)));
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const ticks = [...new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f)))];
  const labels = new Set(labelIndexes(days.length, width < 420 ? 4 : 6));
  const summary = series.map((s) => describeSeries(s.name, days, s.values)).join(" ");
  const showMarkers = kind === "line" && days.length <= 31;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const next = moveCursor(cursor, e.key, days.length);
    if (next === null) {
      if (e.key === "Escape") setCursor(null);
      return;
    }
    e.preventDefault();
    setCursor(next);
    setAnnounce(readout(days[next], series, next));
  }

  // Touch pointers fire pointerleave right after the finger lifts. Keep the readout until the next tap elsewhere.
  const reading = cursor !== null;
  useEffect(() => {
    if (!reading) return;
    const away = (e: globalThis.PointerEvent) => {
      if (e.target instanceof Node && !groupRef.current?.contains(e.target)) setCursor(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [reading]);

  function onPointer(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = rect.width > 0 ? width / rect.width : 1;
    setCursor(indexAtX((e.clientX - rect.left) * scale, plotL, plotR, days.length, kind === "bar" ? "bands" : "points"));
  }

  const cols: Column<number>[] = [
    { key: "day", header: "Day", primary: true, cell: (i) => formatDay(days[i], true) },
    ...series.map<Column<number>>((s) => ({ key: s.name, header: s.name, align: "right", cell: (i) => (s.values[i] ?? 0).toLocaleString() })),
  ];

  return (
    <Card title={title} description={description}>
      <div ref={frame}>
        <div
          ref={groupRef}
          role="application"
          aria-roledescription="chart"
          tabIndex={0}
          aria-labelledby={`${uid}-title`}
          aria-describedby={`${uid}-help`}
          onKeyDown={onKeyDown}
          onBlur={() => setCursor(null)}
          className="rounded-control"
        >
          <span id={`${uid}-title`} className="sr-only">
            {title}
          </span>
          <span id={`${uid}-help`} className="sr-only">
            {summary}{" "}Press the left and right arrow keys to read each day, or Home and End to jump to the first and last day. The same numbers are in the table below the chart.
          </span>
          <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} aria-hidden className="block touch-pan-y" onPointerDown={onPointer} onPointerMove={onPointer} onPointerLeave={(e) => e.pointerType !== "touch" && setCursor(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={plotL} x2={plotR} y1={y(t)} y2={y(t)} style={{ stroke: "var(--border)" }} />
                <text x={plotL - 6} y={y(t) + 4} textAnchor="end" fontSize="11" style={{ fill: "var(--muted)" }}>
                  {t.toLocaleString()}
                </text>
              </g>
            ))}
            {days.map((d, i) =>
              labels.has(i) ? (
                <text key={d} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" style={{ fill: "var(--muted)" }}>
                  {formatDay(d)}
                </text>
              ) : null,
            )}
            {cursor !== null && kind === "bar" && <rect x={plotL + band * cursor} y={PAD.t} width={band} height={H - PAD.t - PAD.b} style={{ fill: "var(--surface-2)" }} />}
            {cursor !== null && kind === "line" && <line x1={x(cursor)} x2={x(cursor)} y1={PAD.t} y2={H - PAD.b} style={{ stroke: "var(--border-strong)" }} strokeDasharray="3 3" />}
            {kind === "line"
              ? series.map((s, si) => (
                  <g key={s.name}>
                    <polyline fill="none" strokeWidth={2} strokeLinejoin="round" strokeDasharray={DASHES[si % DASHES.length]} points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} style={{ stroke: colorOf(s, si) }} />
                    {showMarkers && s.values.map((v, i) => <Marker key={i} shape={MARKERS[si % MARKERS.length]} x={x(i)} y={y(v)} r={2.5} color={colorOf(s, si)} />)}
                    {cursor !== null && <Marker shape={MARKERS[si % MARKERS.length]} x={x(cursor)} y={y(s.values[cursor] ?? 0)} r={4.5} color={colorOf(s, si)} />}
                  </g>
                ))
              : series[0]?.values.map((v, i) => {
                  const h = Math.max(v > 0 ? 1 : 0, (v / max) * (H - PAD.t - PAD.b));
                  return <rect key={days[i]} x={plotL + i * band + band * 0.12} y={H - PAD.b - h} width={Math.max(1, band * 0.76)} height={h} rx={band > 6 ? 2 : 0} style={{ fill: colorOf(series[0], 1) }} />;
                })}
            <line x1={plotL} x2={plotR} y1={H - PAD.b} y2={H - PAD.b} style={{ stroke: "var(--border-strong)" }} />
          </svg>
        </div>
      </div>

      <p className="mt-2 min-h-5 text-sm" aria-hidden>
        {cursor !== null ? readout(days[cursor], series, cursor) : <span className="text-muted">Hover, tap or use the left and right arrow keys to read a day.</span>}
      </p>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>

      {series.length > 1 || kind === "line" ? (
        <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-xs" aria-label="Legend">
          {series.map((s, si) => (
            <li key={s.name} className="flex items-center gap-1.5">
              <svg width="26" height="10" aria-hidden>
                <line x1="0" x2="26" y1="5" y2="5" strokeWidth="2" strokeDasharray={DASHES[si % DASHES.length]} style={{ stroke: colorOf(s, si) }} />
                <Marker shape={MARKERS[si % MARKERS.length]} x={13} y={5} r={2.5} color={colorOf(s, si)} />
              </svg>
              <span>{s.name}</span>
              <span className="tabular-nums text-muted">{sum(s.values).toLocaleString()} total</span>
            </li>
          ))}
        </ul>
      ) : null}

      <details className="mt-3" onToggle={(e) => setTableOpen(e.currentTarget.open)}>
        <summary className={cn("inline-flex min-h-10 cursor-pointer items-center rounded-control text-sm font-medium text-accent-ink underline underline-offset-2")}>View the numbers as a table</summary>
        {tableOpen && (
          <div className="mt-2">
            <DataTable<number> caption={`${title}, one row per day`} columns={cols} rows={days.map((_, i) => i)} rowKey={(i) => days[i]} responsive={false} stickyHeader maxHeight="16rem" />
          </div>
        )}
      </details>
    </Card>
  );
}

/** Accessible multi-series line chart: keyboard and pointer readout, text summary, legend with totals and a table of the same numbers. */
export function LineChart({ title, description, days, series }: { title: string; description?: string; days: string[]; series: Series[] }) {
  return <Chart kind="line" title={title} description={description} days={days} series={series} />;
}

/** Single-series bar chart with the same accessibility treatment. */
export function BarChart({ title, description, days, values, name, tone = "accent" }: { title: string; description?: string; days: string[]; values: number[]; name: string; tone?: ChartTone }) {
  return <Chart kind="bar" title={title} description={description} days={days} series={[{ name, values, tone }]} />;
}
