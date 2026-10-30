"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Card } from "@/components/ui";
import { formatDay, labelIndexes, niceMax } from "@/components/reports/helpers";
import { nearestIndex } from "./insight-helpers";

const PAD = { l: 52, r: 12, t: 12, b: 28 };

/**
 * Accessible single-series line chart. The SVG has a title and description, a text summary states the total and the peak,
 * arrow keys (or the pointer) read one day at a time into a live region, and "View as table" lists every value.
 * It draws at the real width of its container so axis text stays readable on a phone.
 */
export function DailyChart({
  title,
  days,
  values,
  format,
  axisFormat,
  name,
}: {
  title: string;
  days: string[];
  values: number[];
  format: (n: number) => string;
  /** Short labels for the vertical axis. Defaults to format. */
  axisFormat?: (n: number) => string;
  name: string;
}) {
  const uid = useId();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const node = box.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const W = width;
  const H = W < 480 ? 190 : 230;
  const max = niceMax(Math.max(0, ...values));
  const x = (i: number) => PAD.l + (days.length <= 1 ? 0 : (i / (days.length - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const ticks = [0, 0.5, 1].map((f) => max * f);
  const labels = new Set(labelIndexes(days.length, W < 480 ? 3 : 6));
  const total = values.reduce((a, b) => a + b, 0);
  const peak = values.length ? values.indexOf(Math.max(...values)) : 0;
  const summary = values.length === 0 || total === 0 ? `${name}: none in this period.` : `${name}: ${format(total)} in total, highest on ${formatDay(days[peak], true)} with ${format(values[peak])}.`;
  const tickFormat = axisFormat ?? format;
  const line = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = values.length > 1 ? `${x(0)},${y(0)} ${line} ${x(values.length - 1)},${y(0)}` : "";
  const readout = active === null ? "" : `${formatDay(days[active], true)}: ${format(values[active])}`;

  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    const last = days.length - 1;
    if (last < 0) return;
    const move = (n: number) => {
      e.preventDefault();
      setActive(Math.min(last, Math.max(0, n)));
    };
    if (e.key === "ArrowRight") move((active ?? -1) + 1);
    else if (e.key === "ArrowLeft") move((active ?? last + 1) - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(last);
    else if (e.key === "Escape") setActive(null);
  }

  function onPointer(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    setActive(nearestIndex(e.clientX - rect.left, PAD.l, W - PAD.r, days.length));
  }

  return (
    <Card headingLevel="h3" title={title} description={summary}>
      <div ref={box} className="w-full">
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          tabIndex={0}
          aria-roledescription="line chart"
          aria-labelledby={`${uid}-t ${uid}-d`}
          aria-describedby={`${uid}-help`}
          className="block max-w-full touch-pan-y text-foreground"
          onKeyDown={onKey}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") setActive(null);
          }}
          onBlur={() => setActive(null)}
        >
          <title id={`${uid}-t`}>{title}</title>
          <desc id={`${uid}-d`}>{summary}</desc>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="stroke-border" />
              <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize="12" className="fill-muted">
                {tickFormat(t)}
              </text>
            </g>
          ))}
          {days.map((d, i) =>
            labels.has(i) ? (
              <text key={d} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"} fontSize="12" className="fill-muted">
                {formatDay(d)}
              </text>
            ) : null,
          )}
          {area && <polygon points={area} className="fill-accent-ink/15" />}
          <polyline fill="none" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" points={line} className="stroke-accent-ink" />
          {days.length <= 31 && values.map((v, i) => <circle key={days[i]} cx={x(i)} cy={y(v)} r={3} className="fill-raised stroke-accent-ink" strokeWidth={2} />)}
          {active !== null && (
            <g aria-hidden>
              <line x1={x(active)} x2={x(active)} y1={PAD.t} y2={H - PAD.b} className="stroke-border-strong" strokeDasharray="3 3" />
              <circle cx={x(active)} cy={y(values[active])} r={6} className="fill-accent-ink stroke-raised" strokeWidth={2} />
            </g>
          )}
        </svg>
      </div>
      <p id={`${uid}-help`} className="sr-only">
        Use the left and right arrow keys to read one day at a time.
      </p>
      <p className="mt-2 min-h-5 text-sm font-medium tabular-nums" aria-live="polite">
        {readout || <span className="font-normal text-muted">Tap or point at the chart, or use the arrow keys, to read one day.</span>}
      </p>
      <details className="mt-2">
        <summary className="inline-flex min-h-8 cursor-pointer items-center text-sm font-medium underline-offset-2 hover:underline">View as table</summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-control border border-border">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{title}, by day</caption>
            <thead className="sticky top-0 bg-surface text-xs text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Day</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{name}</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d, i) => (
                <tr key={d} className="border-t border-border">
                  <th scope="row" className="px-3 py-1.5 font-normal">{formatDay(d, true)}</th>
                  <td className="px-3 py-1.5 text-right tabular-nums">{format(values[i])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}
