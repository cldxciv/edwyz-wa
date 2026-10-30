import type { StepDraft } from "./types";

export const STATUSES = ["new", "contacted", "qualified", "won", "lost", "invalid"] as const;
export type LeadStatus = (typeof STATUSES)[number];

const STATUS_WORDS: Record<LeadStatus, { label: string; meaning: string }> = {
  new: { label: "New", meaning: "Nobody has followed up yet" },
  contacted: { label: "Contacted", meaning: "You have reached out" },
  qualified: { label: "Qualified", meaning: "A good fit, worth pursuing" },
  won: { label: "Won", meaning: "Became a customer" },
  lost: { label: "Lost", meaning: "Not going ahead" },
  invalid: { label: "Not a real lead", meaning: "Spam or wrong details" },
};

export const isLeadStatus = (s: string): s is LeadStatus => (STATUSES as readonly string[]).includes(s);
export const leadStatusLabel = (s: string) => (isLeadStatus(s) ? STATUS_WORDS[s].label : s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unknown");
export const leadStatusMeaning = (s: string) => (isLeadStatus(s) ? STATUS_WORDS[s].meaning : "");

export function formatResponse(seconds: number | null): string {
  if (seconds === null) return "No reply yet";
  if (seconds < 60) return `${seconds} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Number((seconds / 3600).toFixed(1))} h`;
  return `${Math.round(seconds / 86400)} d`;
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "info";
export type Highlight = { tone: Tone; label: string; hint: string; attention: boolean };

const FAST = 5 * 60;
const SLOW = 60 * 60;
const VERY_SLOW = 24 * 60 * 60;

type Timed = { status: string; createdAt: string; responseSeconds: number | null };

/**
 * One plain-language read on how quickly a lead was answered. Leads still waiting for a first reply are measured against the clock,
 * because the first minutes decide whether a lead replies at all.
 */
export function responseHighlight(lead: Timed, now: number): Highlight {
  const s = lead.responseSeconds;
  if (s !== null) {
    if (s <= FAST) return { tone: "good", label: "Fast reply", hint: `First reply after ${formatResponse(s)}`, attention: false };
    if (s <= SLOW) return { tone: "info", label: "Replied", hint: `First reply after ${formatResponse(s)}`, attention: false };
    if (s <= VERY_SLOW) return { tone: "warn", label: "Slow reply", hint: `First reply after ${formatResponse(s)}. Aim for under an hour.`, attention: false };
    return { tone: "bad", label: "Very slow reply", hint: `First reply after ${formatResponse(s)}. Leads go cold quickly.`, attention: false };
  }
  if (lead.status !== "new") return { tone: "neutral", label: "No reply recorded", hint: "No first reply was logged for this lead.", attention: false };
  const waited = Math.max(0, Math.round((now - new Date(lead.createdAt).getTime()) / 1000));
  if (waited <= 15 * 60) return { tone: "info", label: `Waiting ${formatResponse(waited)}`, hint: "Reply soon. Quick answers win leads.", attention: true };
  if (waited <= SLOW) return { tone: "warn", label: `Waiting ${formatResponse(waited)}`, hint: "This lead is waiting for a first reply.", attention: true };
  return { tone: "bad", label: `Waiting ${formatResponse(waited)}`, hint: "Overdue. Reply now before the lead goes cold.", attention: true };
}

export type Summarizable = { status: string; createdAt: string; responseSeconds: number | null };

export type LeadSummary = { waiting: number; replied: number; medianSeconds: number | null; fastPercent: number | null };

export function summarizeLeads(items: Summarizable[]): LeadSummary {
  const waiting = items.filter((l) => l.status === "new" && l.responseSeconds === null).length;
  const times = items.map((l) => l.responseSeconds).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  const median = times.length === 0 ? null : times.length % 2 ? times[mid] : Math.round((times[mid - 1] + times[mid]) / 2);
  const fast = times.filter((n) => n <= FAST).length;
  return { waiting, replied: times.length, medianSeconds: median, fastPercent: times.length === 0 ? null : Math.round((fast / times.length) * 100) };
}

export function groupByStatus<T extends { status: string }>(items: readonly T[]): Record<LeadStatus, T[]> {
  const out = Object.fromEntries(STATUSES.map((s) => [s, [] as T[]])) as Record<LeadStatus, T[]>;
  for (const item of items) if (isLeadStatus(item.status)) out[item.status].push(item);
  return out;
}

export function leadDisplayName(lead: { name: string | null; contact: { phone: string } | null }): string {
  return lead.name ?? lead.contact?.phone ?? "Unnamed lead";
}

/** "full_name" becomes "Full name". Form answer keys come from the form builder and are not meant to be read raw. */
export function fieldLabel(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Answer";
}

/** Sequence run states as the person would say them. Unknown states fall back to sentence case. */
export function runStateLabel(status: string): string {
  if (status === "active") return "Running";
  if (status === "completed") return "Finished";
  if (status === "stopped") return "Stopped";
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown";
}

/* ---------- Sequences ---------- */

export const MAX_STEPS = 10;
export const MAX_DELAY_MINUTES = 60 * 24 * 30;
export type DelayUnit = "minutes" | "hours" | "days";
const UNIT_MINUTES: Record<DelayUnit, number> = { minutes: 1, hours: 60, days: 1440 };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** 0 is "right away"; 90 is "1 hour 30 minutes"; at most two units are shown. */
export function formatDelay(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "right away";
  const total = Math.round(minutes);
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const parts = [d ? plural(d, "day") : "", h ? plural(h, "hour") : "", m ? plural(m, "minute") : ""].filter(Boolean);
  return parts.slice(0, 2).join(" ");
}

/** Picks the largest unit that divides the delay evenly, so 120 shows as 2 hours rather than 120 minutes. */
export function splitDelay(minutes: number): { value: number; unit: DelayUnit } {
  const m = Math.max(0, Math.round(minutes || 0));
  if (m > 0 && m % 1440 === 0) return { value: m / 1440, unit: "days" };
  if (m > 0 && m % 60 === 0) return { value: m / 60, unit: "hours" };
  return { value: m, unit: "minutes" };
}

export function toMinutes(value: number, unit: DelayUnit): number {
  const v = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return Math.min(v * UNIT_MINUTES[unit], MAX_DELAY_MINUTES);
}

type Named = { id: string; name: string };

/** One sentence per step, in the words a shop owner would use. */
export function describeStep(step: Pick<StepDraft, "templateId" | "chatbotId" | "stopOnReply">, index: number, templates: Named[], chatbots: Named[]): string {
  const template = templates.find((t) => t.id === step.templateId)?.name;
  const chatbot = chatbots.find((c) => c.id === step.chatbotId)?.name;
  const what: string[] = [];
  if (step.templateId) what.push(template ? `Send the message "${template}"` : "Send the chosen message");
  if (step.chatbotId) what.push(chatbot ? `${what.length ? "then start" : "Start"} the chatbot "${chatbot}"` : `${what.length ? "then start" : "Start"} the chosen chatbot`);
  if (what.length === 0) return "Choose what to send in this step.";
  const stop = index === 0 ? "" : step.stopOnReply ? " The sequence stops here if the lead has already replied." : " Sent even if the lead has already replied.";
  return `${what.join(", ")}.${stop}`;
}

export type TimelineEntry = { index: number; at: number; whenLabel: string; waitLabel: string };

/** Cumulative timing: step 3 after 1 hour then 1 day happens "1 day 1 hour after the lead arrives". */
export function buildTimeline(steps: Pick<StepDraft, "delayMinutes">[]): TimelineEntry[] {
  let at = 0;
  return steps.map((s, index) => {
    const wait = index === 0 ? 0 : Math.max(0, s.delayMinutes || 0);
    at += wait;
    return {
      index,
      at,
      whenLabel: at === 0 ? "As soon as the lead arrives" : `${formatDelay(at)} after the lead arrives`,
      waitLabel: index === 0 ? "" : wait === 0 ? "Straight after the previous step" : `Wait ${formatDelay(wait)}`,
    };
  });
}

export type StepProblem = { index: number; message: string };

export function stepProblems(steps: Pick<StepDraft, "templateId" | "chatbotId">[]): StepProblem[] {
  const out: StepProblem[] = [];
  steps.forEach((s, index) => {
    if (!s.templateId && !s.chatbotId) out.push({ index, message: "Choose a message or a chatbot for this step." });
  });
  return out;
}

export function sequenceScope(appliesTo: { leadFormId?: string; campaignMetaId?: string } | null, forms: Named[]): string {
  if (!appliesTo || (!appliesTo.leadFormId && !appliesTo.campaignMetaId)) return "Runs for every new lead";
  const parts: string[] = [];
  if (appliesTo.leadFormId) parts.push(`the form "${forms.find((f) => f.id === appliesTo.leadFormId)?.name ?? "selected form"}"`);
  if (appliesTo.campaignMetaId) parts.push("one campaign");
  return `Runs for leads from ${parts.join(" and ")}`;
}

/** Server messages are already written for people; a failed fetch is not, so it gets a fix instead of a browser string. */
export function friendlyError(e: unknown, fallback = "Something went wrong. Try again."): string {
  const message = e instanceof Error ? e.message.trim() : "";
  if (!message) return fallback;
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) return "We could not reach the server. Check your connection and try again.";
  return message;
}

export function sequenceLength(steps: { delayMinutes?: number }[]): string {
  const timeline = buildTimeline(steps.map((s) => ({ delayMinutes: s.delayMinutes ?? 0 })));
  const last = timeline[timeline.length - 1];
  const count = plural(steps.length, "step");
  return last && last.at > 0 ? `${count} over ${formatDelay(last.at)}` : count;
}
