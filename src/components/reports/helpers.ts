import { addDays, dayKey } from "@/lib/reports/range";

export const PRESETS = [7, 30, 90] as const;

/** Inclusive local-day range ending today in tz. */
export function presetRange(days: number, tz: string, now = new Date()) {
  const to = dayKey(now, tz);
  return { from: addDays(to, -(days - 1)), to };
}

/** Round up to a 1, 2, 5 style axis maximum so gridlines land on tidy numbers. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const f = max / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function describeSeries(name: string, days: string[], values: number[]): string {
  if (values.length === 0) return `${name}: no data.`;
  const total = sum(values);
  const peakIndex = values.indexOf(Math.max(...values));
  return total === 0 ? `${name}: none in this period.` : `${name}: ${total.toLocaleString()} in total, busiest on ${formatDay(days[peakIndex], true)} with ${values[peakIndex].toLocaleString()}.`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "No data" : `${value}%`;
}

export function usagePercent(used: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

export const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

export function presetLabel(days: number): string {
  return `Last ${days} days`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/** Plain-language problem with a chosen date range, or null when the range can be loaded. */
export function rangeProblem(from: string, to: string, maxDays = MAX_RANGE_DAYS): string | null {
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return "Choose both a start and an end date.";
  if (from > to) return "The start date must be on or before the end date.";
  if (daysBetween(from, to) > maxDays) return `Choose a range of at most ${maxDays} days.`;
  return null;
}

/** "27 Oct" for a YYYY-MM-DD day key. Day keys are calendar days, so they are formatted in UTC. */
export function formatDay(day: string, withYear = false): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

export function rangeText(from: string, to: string): string {
  return from === to ? formatDay(from, true) : `${formatDay(from)} to ${formatDay(to, true)}`;
}

/** Indexes that get an axis label so labels never crowd each other: about `target` evenly spaced labels, always including the first. */
export function labelIndexes(count: number, target = 6): number[] {
  if (count <= 0) return [];
  const step = Math.max(1, Math.ceil(count / target));
  const out: number[] = [];
  for (let i = 0; i < count; i += step) out.push(i);
  return out;
}

/** Keyboard cursor for a chart: Left and Right step one day, Home and End jump to the ends. Up and Down are left alone so the page can still scroll. Returns null for keys it does not handle. */
export function moveCursor(current: number | null, key: string, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  switch (key) {
    case "ArrowRight":
      return current === null ? 0 : Math.min(last, current + 1);
    case "ArrowLeft":
      return current === null ? last : Math.max(0, current - 1);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/** Which day a horizontal pointer position falls on, for a plot that spans left..right. */
export function indexAtX(x: number, left: number, right: number, count: number, mode: "points" | "bands"): number {
  if (count <= 1) return 0;
  const span = Math.max(1, right - left);
  const t = Math.min(1, Math.max(0, (x - left) / span));
  return mode === "points" ? Math.round(t * (count - 1)) : Math.min(count - 1, Math.floor(t * count));
}

export function readout(day: string, series: { name: string; values: number[] }[], index: number): string {
  const parts = series.map((s) => `${s.name} ${(s.values[index] ?? 0).toLocaleString()}`);
  return `${formatDay(day, true)}: ${parts.join(", ")}`;
}

export function totalOf(values: number[]): number {
  return sum(values);
}

/** Share of `part` in `whole` as a whole-number-ish percentage text, or a dash when there is nothing to compare. */
export function shareText(part: number, whole: number): string {
  if (whole <= 0) return "-";
  const pct = (part / whole) * 100;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

export function usageSummary(used: number, limit: number | null): string {
  return limit === null ? `${used.toLocaleString()} used, no limit` : `${used.toLocaleString()} of ${limit.toLocaleString()} used`;
}

/** Short words that go next to a usage bar so the state is never colour only. */
export function usageNote(pct: number | null): string | null {
  if (pct === null) return null;
  if (pct >= 100) return "Limit reached";
  if (pct >= 90) return "Almost full";
  if (pct >= 70) return "Getting full";
  return null;
}

/** Visible failure label. Without a known hint the WhatsApp code is included so different reasons stay distinguishable. */
export function failureTitle(hint: string | null, code?: string | null): string {
  if (hint) return hint;
  return code ? `Message could not be delivered (code ${code})` : "Message could not be delivered";
}
