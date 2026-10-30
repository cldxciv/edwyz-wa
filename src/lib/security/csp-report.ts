import { log } from "@/lib/log";

export const MAX_REPORT_BYTES = 8 * 1024;
const FLUSH_MS = 60_000;
const DIRECTIVES = new Set([
  "default-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr",
  "img-src", "font-src", "connect-src", "frame-src", "child-src", "object-src", "media-src", "worker-src",
  "base-uri", "form-action", "frame-ancestors", "manifest-src",
]);

const counts = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;

const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

function directiveOf(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  const raw = body["effective-directive"] ?? body.effectiveDirective ?? body["violated-directive"] ?? body.violatedDirective;
  const name = typeof raw === "string" ? raw.trim().split(/\s+/)[0].toLowerCase() : "";
  return DIRECTIVES.has(name) ? name : name ? "other" : null;
}

/** Directive names from either report format (legacy `csp-report` object, or a Reporting API array). URLs and samples are dropped. */
export function extractDirectives(payload: unknown): string[] {
  const out: string[] = [];
  const legacy = asRecord(payload)?.["csp-report"];
  if (legacy) {
    const name = directiveOf(asRecord(legacy));
    if (name) out.push(name);
    return out;
  }
  if (!Array.isArray(payload)) return out;
  for (const item of payload.slice(0, 20)) {
    const entry = asRecord(item);
    if (entry?.type !== "csp-violation") continue;
    const name = directiveOf(asRecord(entry.body));
    if (name) out.push(name);
  }
  return out;
}

export function flushCspCounts(): Record<string, number> {
  const snapshot = Object.fromEntries(counts);
  counts.clear();
  if (timer) clearTimeout(timer);
  timer = undefined;
  const total = Object.values(snapshot).reduce((a, b) => a + b, 0);
  if (total > 0) log.warn("csp.violations", { total, byDirective: snapshot });
  return snapshot;
}

export function recordCspReport(directives: string[]) {
  for (const name of directives) counts.set(name, (counts.get(name) ?? 0) + 1);
  if (directives.length > 0 && !timer) {
    timer = setTimeout(flushCspCounts, FLUSH_MS);
    timer.unref?.();
  }
}
