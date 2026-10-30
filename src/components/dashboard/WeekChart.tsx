import { niceMax } from "@/components/reports/helpers";
import type { DayPoint } from "@/lib/setup/dashboard";
import { formatCount, formatReplyTime, shortDay } from "./helpers";

const W = 480;
const H = 180;
const PAD = { l: 34, r: 8, t: 10, b: 24 };

function summary(days: DayPoint[]): string {
  const totals = days.map((d) => d.inbound + d.outbound);
  const all = totals.reduce((a, b) => a + b, 0);
  if (all === 0) return "No messages in the last 7 days.";
  const peak = totals.indexOf(Math.max(...totals));
  return `${all.toLocaleString("en-IN")} messages in the last 7 days. Busiest day was ${shortDay(days[peak].day)} with ${totals[peak].toLocaleString("en-IN")}.`;
}

/** Hand-drawn stacked bars: messages you sent and messages you received, one bar per day. */
export function WeekChart({ days }: { days: DayPoint[] }) {
  const max = niceMax(Math.max(0, ...days.map((d) => d.inbound + d.outbound)));
  const slot = (W - PAD.l - PAD.r) / Math.max(1, days.length);
  const bar = Math.min(34, slot * 0.6);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const text = summary(days);
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="week-chart-title week-chart-desc" className="h-auto w-full">
        <title id="week-chart-title">Messages per day, last 7 days</title>
        <desc id="week-chart-desc">{text}</desc>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="stroke-border" />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize="10" className="fill-muted">
              {formatCount(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = PAD.l + slot * i + (slot - bar) / 2;
          const sentTop = y(d.outbound);
          const receivedTop = y(d.outbound + d.inbound);
          return (
            <g key={d.day}>
              <rect x={x} y={sentTop} width={bar} height={Math.max(0, y(0) - sentTop)} rx="2" className="fill-accent" />
              <rect x={x} y={receivedTop} width={bar} height={Math.max(0, sentTop - receivedTop)} rx="2" className="fill-foreground/25" />
              <text x={x + bar / 2} y={H - 8} textAnchor="middle" fontSize="10" className="fill-muted">
                {shortDay(d.day).split(" ")[0]}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-accent" /> Sent by you
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-foreground/25" /> Received from customers
        </span>
        <span className="sr-only">{text}</span>
      </figcaption>
    </figure>
  );
}

/** The same numbers as the tiles and chart, as a plain table for anyone who prefers it or uses a screen reader. */
export function DataTable({ days }: { days: DayPoint[] }) {
  return (
    <details className="mt-3 rounded-xl border border-border px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">View the numbers as a table</summary>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[28rem] text-left text-sm">
          <caption className="sr-only">Messages, new conversations and time to first reply for each of the last 7 days</caption>
          <thead className="text-xs text-muted">
            <tr>
              <th scope="col" className="py-1.5 pr-3 font-medium">Day</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Received</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Sent</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">New conversations</th>
              <th scope="col" className="py-1.5 font-medium">Time to first reply</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {days.map((d) => (
              <tr key={d.day}>
                <th scope="row" className="py-1.5 pr-3 font-medium">{shortDay(d.day)}</th>
                <td className="py-1.5 pr-3">{d.inbound.toLocaleString("en-IN")}</td>
                <td className="py-1.5 pr-3">{d.outbound.toLocaleString("en-IN")}</td>
                <td className="py-1.5 pr-3">{d.conversations.toLocaleString("en-IN")}</td>
                <td className="py-1.5">{d.responseSeconds === null ? "No replies" : formatReplyTime(d.responseSeconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
