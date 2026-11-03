import { tierLimit } from "@/lib/broadcasts/throttle";
import { statusTone, type Tone } from "@/components/ui/status";

export type Counts = Record<string, number>;

const IN_FLIGHT = new Set(["pending", "queued"]);
export const MAX_SCHEDULE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_LEAD_MS = 60 * 1000;

export const totalOf = (counts: Counts) => Object.values(counts).reduce((a, b) => a + b, 0);

/** Recipients that have been handled (sent, failed or skipped). */
export function handledCount(counts: Counts): number {
  return Object.entries(counts).reduce((sum, [status, n]) => (IN_FLIGHT.has(status) ? sum : sum + n), 0);
}

/** Share of recipients that have been handled (sent, failed or skipped), 0 to 100. */
export function progressPercent(counts: Counts): number {
  const total = totalOf(counts);
  if (total === 0) return 0;
  return Math.round((handledCount(counts) / total) * 100);
}

export function progressText(counts: Counts): string {
  const total = totalOf(counts);
  return total === 0 ? "Not started" : `${handledCount(counts).toLocaleString()} of ${total.toLocaleString()} handled`;
}

export type StatusView = { label: string; tone: Tone };

const BROADCAST_LABELS: Record<string, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  sending: "Sending",
  completed: "Completed",
  paused: "Paused",
  canceled: "Canceled",
};

export function broadcastStatusView(status: string): StatusView {
  const known = status in BROADCAST_LABELS;
  return { label: known ? BROADCAST_LABELS[status] : "Failed", tone: known ? statusTone(status) : "bad" };
}

const RECIPIENT_LABELS: Record<string, string> = {
  read: "Read",
  delivered: "Delivered",
  sent: "Sent",
  failed: "Failed",
  skipped: "Not sent",
  queued: "Sending",
  pending: "Waiting",
};

export function recipientStatusView(status: string): StatusView {
  const label = RECIPIENT_LABELS[status] ?? "Waiting";
  if (status === "pending" || !(status in RECIPIENT_LABELS)) return { label, tone: "neutral" };
  return { label, tone: statusTone(status) };
}

export const isLive = (status: string) => status === "sending" || status === "scheduled";

export function tierSummary(tier: string | null | undefined): string {
  const limit = tierLimit(tier);
  return limit === Infinity
    ? "Your number has no daily limit on how many different people it can message."
    : `Your number can message up to ${limit.toLocaleString()} different people in any 24 hours.${tier ? "" : " Meta has not told us your limit yet, so we assume the lowest tier."}`;
}

export function qualityWarning(rating: string | null | undefined): string | null {
  const r = (rating ?? "").toUpperCase();
  if (r === "RED" || r === "LOW") return "This number's quality rating is low. Broadcasts from it are paused automatically until it recovers.";
  if (r === "YELLOW" || r === "MEDIUM") return "This number's quality rating is medium. Messages people do not want can lower it further.";
  return null;
}

type CostLike = { configured: boolean; totalPaise?: number; totalMinor?: number; perMessagePaise?: number; currency?: string; unpricedCount?: number };

/** Minor units (paise, cents) as money in the currency, using the currency's own number of decimals. */
export function formatMinor(minor: number, currency = "INR"): string {
  const locale = currency === "INR" ? "en-IN" : undefined;
  try {
    const digits = new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return (minor / 10 ** digits).toLocaleString(locale, { style: "currency", currency });
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

/** Cost text exactly as the API reports it. Never fabricates a number. */
export function costText(cost: CostLike | undefined): string {
  const minor = cost?.totalMinor ?? cost?.totalPaise;
  if (!cost || !cost.configured || typeof minor !== "number") return "rate card not configured";
  return formatMinor(minor, cost.currency ?? "INR");
}

export type CostSummary = { configured: boolean; headline: string; note: string };

/** Review-step wording for the cost estimate. Shows "Not available yet" instead of a made-up number. */
export function costSummary(cost: CostLike | undefined): CostSummary {
  const configured = !!cost && cost.configured && typeof (cost.totalMinor ?? cost.totalPaise) === "number";
  if (!configured) {
    return { configured, headline: "Not available yet", note: "No price list is set up, so we cannot estimate the cost. Meta bills each delivered template message by category and country. Check your Meta billing for actual charges." };
  }
  const unpriced = cost?.unpricedCount ?? 0;
  const partial = unpriced > 0 ? ` ${unpriced.toLocaleString()} ${unpriced === 1 ? "person is" : "people are"} in a country with no price in our price list, so the real cost will be higher.` : "";
  return { configured, headline: `About ${costText(cost)}`, note: `This is an estimate. Meta bills each delivered message, so your actual charge can differ. Check your Meta billing for the final amount.${partial}` };
}

export { errorCodeText } from "@/lib/broadcasts/errors";

const TECHNICAL = /\b[a-z]+[A-Z][a-zA-Z]*\b|_|\bundefined\b|stack trace|unexpected token/;
const TECHNICAL_ANY_CASE = /prisma|\w+Error\b|ECONN|fetch failed/i;

/** Server messages are mostly readable already. Anything that looks technical is replaced by the fallback. */
export function friendlyError(message: string | null | undefined, fallback = "Something went wrong. Please try again."): string {
  const text = (message ?? "").trim();
  if (!text) return fallback;
  if (/in the future/i.test(text)) return "Pick a time in the future.";
  if (/at most \d+ days ahead/i.test(text)) return `Pick a time within the next ${MAX_SCHEDULE_DAYS} days.`;
  if (TECHNICAL.test(text) || TECHNICAL_ANY_CASE.test(text)) return fallback;
  return text;
}

export function filterBroadcasts<T extends { name: string; status: string }>(items: readonly T[], query: string, status: string): T[] {
  const q = query.trim().toLowerCase();
  return items.filter((b) => (status === "all" || b.status === status) && (!q || b.name.toLowerCase().includes(q)));
}

export const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All broadcasts" },
  { value: "draft", label: "Drafts" },
  { value: "scheduled", label: "Scheduled" },
  { value: "sending", label: "Sending" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "canceled", label: "Canceled" },
  { value: "failed", label: "Failed" },
];

type Meter = { known: false } | { known: true; limit: number; used: number; unlimited: boolean };

/** One sentence about how much of the daily limit is used. */
export function limitSummary(meter: Meter): string {
  if (!meter.known) return "Meta has not told us this number's daily limit yet.";
  const used = meter.used.toLocaleString();
  if (meter.unlimited) return `${used} people messaged in the last 24 hours. There is no limit.`;
  const left = Math.max(0, meter.limit - meter.used);
  return `${used} of ${meter.limit.toLocaleString()} people messaged in the last 24 hours. Room for ${left.toLocaleString()} more.`;
}

export const humanizeName = (name: string): string => {
  const spaced = name.replace(/[_-]+/g, " ").trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : name;
};

export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code.replace("_", "-"));
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

export const categoryLabel = (category: string): string => {
  const c = category.toLowerCase();
  return c ? c[0].toUpperCase() + c.slice(1) : "";
};

export function defaultBroadcastName(templateName: string | undefined, now = new Date()): string {
  const day = now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return templateName ? `${humanizeName(templateName)}, ${day}` : `Broadcast, ${day}`;
}

type Component = Record<string, unknown>;
const list = (components: unknown): Component[] => (Array.isArray(components) ? (components as Component[]).filter((c) => c && typeof c === "object") : []);
const textOf = (c: Component | undefined) => (c && typeof c.text === "string" ? c.text : "");
const hasVariable = (text: string) => /\{\{\s*\d+\s*\}\}/.test(text);

export type TemplatePreview = { header: string | null; body: string; footer: string | null; buttons: string[] };

export function templatePreview(components: unknown): TemplatePreview {
  const all = list(components);
  const header = all.find((c) => c.type === "HEADER" && c.format === "TEXT");
  const buttons = (all.find((c) => c.type === "BUTTONS")?.buttons as { text?: unknown }[] | undefined) ?? [];
  return {
    header: textOf(header) || null,
    body: textOf(all.find((c) => c.type === "BODY")),
    footer: textOf(all.find((c) => c.type === "FOOTER")) || null,
    buttons: buttons.map((b) => (typeof b.text === "string" ? b.text : "")).filter(Boolean),
  };
}

/** Why a template cannot be used in a broadcast at all, in plain words, or null when it can. Media headers and placeholders in headers or links are handled by the value mapping. */
export function unsupportedTemplateReason(components: unknown): string | null {
  const header = list(components).find((c) => c.type === "HEADER");
  const format = typeof header?.format === "string" ? header.format.toUpperCase() : "TEXT";
  if (header && !["TEXT", "IMAGE", "VIDEO", "DOCUMENT"].includes(format)) return "This template has a header type that broadcasts cannot send yet.";
  if (list(components).some((c) => c.type === "CAROUSEL" || c.type === "LIMITED_TIME_OFFER")) return "Carousel and limited-time-offer templates cannot be broadcast yet.";
  return null;
}

/** Explains how {{1}} style placeholders in the body are filled, or null when the body has none. */
export function placeholderNote(components: unknown): string | null {
  const body = textOf(list(components).find((c) => c.type === "BODY"));
  if (!hasVariable(body)) return null;
  return "Placeholders like {{1}} are filled in for each person. {{1}} uses the contact's name. Contacts with a missing value are not sent the message.";
}

export function audienceLabel(tags: readonly string[], extra?: string | null): string {
  if (extra) return extra;
  return tags.length ? `Contacts tagged ${tags.join(", ")}` : "Everyone who opted in";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Value for a datetime-local input in the viewer's time zone. */
export const localInputValue = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function validateSchedule(value: string, now = new Date()): string | null {
  if (!value) return "Pick a date and time.";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "Enter a valid date and time.";
  if (at.getTime() < now.getTime() + MIN_LEAD_MS) return "Pick a time in the future.";
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * DAY_MS) return `Pick a time within the next ${MAX_SCHEDULE_DAYS} days.`;
  return null;
}

/**
 * The time a day picked on the calendar starts with: 9:00, or for today the next full hour at least 30 minutes away, and on
 * the last day of the window the latest allowed time. Null when nothing on that day can be scheduled any more.
 */
export function presetSchedule(day: string, now = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [y, m, d] = day.split("-").map(Number);
  const earliest = now.getTime() + MIN_LEAD_MS;
  const latest = now.getTime() + MAX_SCHEDULE_DAYS * DAY_MS;
  const fits = (at: Date) => localInputValue(at).startsWith(day) && at.getTime() >= earliest && at.getTime() <= latest;
  const nine = new Date(y, m - 1, d, 9, 0, 0, 0);
  const soon = new Date(now.getTime() + 30 * 60_000);
  const nextHour = new Date(soon.getFullYear(), soon.getMonth(), soon.getDate(), soon.getHours() + (soon.getMinutes() || soon.getSeconds() ? 1 : 0), 0, 0, 0);
  const last = new Date(latest);
  last.setMinutes(last.getMinutes() - (last.getMinutes() % 15), 0, 0);
  const at = [nine, nextHour, last].find(fits);
  return at ? localInputValue(at) : null;
}

export const scheduleBounds = (now = new Date()) => ({ min: localInputValue(now), max: localInputValue(new Date(now.getTime() + MAX_SCHEDULE_DAYS * DAY_MS)) });

export function formatWhen(value: string | Date): string {
  return new Date(value).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function scheduleSummary(scheduledAt: string): string {
  return scheduledAt ? formatWhen(scheduledAt) : "Right after you press Send";
}

export function retrySummary(days: number): string {
  return days > 0 ? `Held-back messages are retried daily for up to ${days} day${days === 1 ? "" : "s"}` : "Held-back messages are not retried";
}

export type AudienceLine = { kind: "choose-number" | "add-tag" | "pending-text" | "counting" | "none" | "count"; text: string };

/** The one sentence under the audience choices. Never announces a count that does not belong to the chosen tags. */
export type AudienceMode = "all" | "tags" | "segment" | "filters";

export function audienceLine(input: { phoneChosen: boolean; mode: AudienceMode; tagCount: number; pendingText: string; counting: boolean; eligible: number; segmentChosen?: boolean; rulesReady?: boolean }): AudienceLine {
  const { mode, tagCount, eligible } = input;
  if (mode === "segment" && input.segmentChosen === false) return { kind: "add-tag", text: "Choose a segment to see how many people match." };
  if (mode === "filters" && input.rulesReady === false) return { kind: "add-tag", text: "Finish the rules to see how many people match." };
  if (mode === "tags" && tagCount === 0) {
    const pending = input.pendingText.trim();
    return pending ? { kind: "pending-text", text: `Press Add to keep "${pending}", or clear the box, to continue.` } : { kind: "add-tag", text: "Add a tag to see how many people match." };
  }
  if (input.counting) return { kind: "counting", text: "Counting people..." };
  if (eligible <= 0) return { kind: "none", text: "No one matches yet." };
  const people = eligible === 1 ? "person" : "people";
  return { kind: "count", text: `${eligible.toLocaleString()} ${people} will get this message. Contacts who opted out are always left out.` };
}

/** Why the main button of a wizard step cannot be pressed, or an empty string when it can. */
export function wizardHint(input: {
  step: number;
  phoneChosen: boolean;
  mode: AudienceMode;
  tagCount: number;
  pendingText: string;
  counting: boolean;
  eligible: number;
  hasTemplate: boolean;
  templateUnsupported: boolean;
  confirmed: boolean;
  segmentChosen?: boolean;
  rulesReady?: boolean;
  mappingProblem?: string | null;
}): string {
  if (input.step === 1) {
    if (!input.phoneChosen) return "Choose a number to send from to continue.";
    if (input.mode === "segment" && input.segmentChosen === false) return "Choose a segment to continue.";
    if (input.mode === "filters" && input.rulesReady === false) return "Finish the rules to continue.";
    if (input.mode === "tags" && input.pendingText.trim()) return `Press Add to keep "${input.pendingText.trim()}", or clear the box, to continue.`;
    if (input.mode === "tags" && input.tagCount === 0) return "Add at least one tag to continue.";
    if (input.counting) return "Counting people. One moment.";
    if (input.eligible <= 0) return "You need at least one opted-in contact to continue.";
    return "";
  }
  if (input.step === 2) {
    if (!input.hasTemplate) return "Choose a template to continue.";
    if (input.templateUnsupported) return "Choose a different template to continue.";
    return input.mappingProblem ?? "";
  }
  if (input.step === 4 && !input.confirmed) return "Tick the box above to send.";
  return "";
}

export type ResumeCopy = { title: string; body: string; confirmLabel: string; done: string };

/** Wording for the start, schedule and resume confirmation. A paused broadcast that never sent anything starts right away, and the text says so. */
export function startCopy(input: { name: string; status: string; scheduledAt: string | null; total: number; handled: number; now?: number }): ResumeCopy {
  const now = input.now ?? Date.now();
  const resuming = input.status === "paused";
  const later = !resuming && !!input.scheduledAt && new Date(input.scheduledAt).getTime() > now;
  const people = input.total > 0 ? `${input.total.toLocaleString()} people` : "everyone in the audience";
  if (resuming) {
    const neverSent = input.handled === 0;
    return {
      title: `Resume "${input.name}"?`,
      body: neverSent
        ? `Nothing has been sent yet, so resuming starts sending to ${people} right now, not at the time it was scheduled for. Messages that are sent cannot be taken back.`
        : "Sending continues with the people who have not been messaged yet.",
      confirmLabel: neverSent ? "Send now" : "Resume sending",
      done: neverSent ? "Broadcast started" : "Sending resumed",
    };
  }
  if (later) {
    return { title: `Schedule "${input.name}"?`, body: `Your message will go to ${people} on ${formatWhen(input.scheduledAt!)}. You can cancel before then.`, confirmLabel: "Schedule broadcast", done: "Broadcast scheduled" };
  }
  return { title: `Send "${input.name}" now?`, body: `Your message will go to ${people} who opted in. Messages already sent cannot be taken back, but you can pause at any time.`, confirmLabel: "Send broadcast", done: "Broadcast started" };
}
