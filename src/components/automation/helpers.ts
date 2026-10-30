export type RuleType = "welcome" | "away" | "keyword";

export type Schedule = { timezone: string; days: number[]; start: string; end: string };

export type Rule = {
  id: string;
  type: RuleType;
  name: string;
  enabled: boolean;
  keywords: string[];
  matchMode: "contains" | "exact";
  replyText: string;
  schedule: Schedule | null;
  cooldownMinutes: number;
};

export type RuleDraft = Omit<Rule, "id">;

export const MAX_REPLY = 1024;
export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const TYPE_LABEL: Record<RuleType, string> = { welcome: "Welcome message", away: "After-hours reply", keyword: "Keyword reply" };
export const TYPE_SUMMARY: Record<RuleType, string> = {
  welcome: "Greets people the first time they write to you.",
  away: "Tells people when you will be back if they write outside your open hours.",
  keyword: "Answers common questions when a message contains certain words.",
};
export const TYPE_HELP: Record<RuleType, string> = {
  welcome: "Sent when a customer writes to you for the first time, and again after they have been quiet for a while.",
  away: "Sent when a message arrives outside your open hours.",
  keyword: "Sent when a message contains one of your keywords.",
};

export function timezoneOptions(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const list = intl.supportedValuesOf?.("timeZone");
    if (list?.length) return list.includes("UTC") ? list : ["UTC", ...list];
  } catch {
    // fall through to the short list
  }
  return ["UTC", "Asia/Kolkata", "Asia/Dubai", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Australia/Sydney"];
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function emptyDraft(type: RuleType, timezone = "UTC"): RuleDraft {
  return {
    type,
    name: "",
    enabled: true,
    keywords: [],
    matchMode: "contains",
    replyText: "",
    schedule: type === "away" ? { timezone, days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" } : null,
    cooldownMinutes: type === "keyword" ? 5 : 720,
  };
}

/** Adds keywords from free text (comma or newline separated), de-duplicating case-insensitively. Returns the new list. */
export function addKeywords(existing: string[], input: string, max = 30): string[] {
  const seen = new Set(existing.map((k) => k.toLowerCase()));
  const out = [...existing];
  for (const part of input.split(/[,\n]/)) {
    const k = part.trim().slice(0, 60);
    if (k && !seen.has(k.toLowerCase()) && out.length < max) {
      seen.add(k.toLowerCase());
      out.push(k);
    }
  }
  return out;
}

export const counter = (text: string) => `${text.length}/${MAX_REPLY}`;

export function describeRule(rule: Pick<Rule, "type" | "keywords" | "schedule" | "cooldownMinutes">): string {
  if (rule.type === "keyword") return `Keywords: ${rule.keywords.slice(0, 4).join(", ")}${rule.keywords.length > 4 ? ` +${rule.keywords.length - 4}` : ""}`;
  if (rule.type === "away" && rule.schedule) {
    const days = rule.schedule.days.map((d) => DAY_LABELS[d]).join(", ");
    return `Replies outside ${days} ${rule.schedule.start} to ${rule.schedule.end} (${rule.schedule.timezone})`;
  }
  return `First messages. Sends again after ${formatCooldown(rule.cooldownMinutes)} of silence`;
}

export function formatCooldown(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} min`;
}

export type DraftField = "name" | "replyText" | "keywords" | "days" | "cooldown";

/** Problems keyed by the field they belong to, so the form can show each message under its own input. */
export function validateDraftFields(d: RuleDraft): Partial<Record<DraftField, string>> {
  const out: Partial<Record<DraftField, string>> = {};
  if (!d.name.trim()) out.name = "Give the rule a name, for example \"Welcome message\".";
  if (!d.replyText.trim()) out.replyText = "Write the reply customers will receive.";
  else if (d.replyText.length > MAX_REPLY) out.replyText = `The reply can be at most ${MAX_REPLY} characters.`;
  if (d.type === "keyword" && d.keywords.length === 0) out.keywords = "Add at least one keyword, for example \"price\".";
  if (d.type === "away" && (!d.schedule || d.schedule.days.length === 0)) out.days = "Choose at least one open day.";
  if (!Number.isInteger(d.cooldownMinutes) || d.cooldownMinutes < 1) out.cooldown = "Wait at least 1 minute before repeating.";
  return out;
}

const FIELD_ORDER: DraftField[] = ["name", "keywords", "days", "replyText", "cooldown"];

/** The first problem in reading order, or null when the draft is ready to save. */
export function validateDraft(d: RuleDraft): string | null {
  const fields = validateDraftFields(d);
  const first = FIELD_ORDER.find((f) => fields[f]);
  return first ? (fields[first] as string) : null;
}

const GENERIC = /(prisma|\bstack\b|\bundefined\b|\bnull\b|\bat [\w.]+ \(|[0-9a-f]{8}-[0-9a-f]{4}|ECONN|ETIMEDOUT|SQLSTATE|\bP\d{4}\b)/i;

/**
 * Turns whatever a request threw into one calm sentence. Server messages that read like prose are kept as the reason;
 * anything that looks technical (ids, stack traces, database codes) is dropped.
 */
export function humanError(error: unknown, whatFailed: string): string {
  const raw = error instanceof Error ? error.message.trim() : "";
  const lead = `We could not ${whatFailed}.`;
  if (!raw || raw.length > 200 || GENERIC.test(raw) || raw === "Something went wrong.") return `${lead} Check your connection and try again.`;
  const reason = /[.!?]$/.test(raw) ? raw : `${raw}.`;
  return `${lead} ${reason}`;
}

/**
 * The words for a failed publish. A draft the server rejects as invalid, or an archived bot, gets a next step instead of the
 * server's wording; anything else falls back to humanError.
 */
export function publishFailure(error: unknown, name: string): { message: string; kind: "invalid" | "archived" | "other" } {
  const raw = error instanceof Error ? error.message : "";
  if (/archived/i.test(raw)) return { kind: "archived", message: `"${name}" is archived, so it cannot be published. Make a copy to keep working on it.` };
  if (/problems|must be fixed|invalid/i.test(raw)) return { kind: "invalid", message: `We could not publish "${name}". Open it and check the Checks tab to see what needs fixing.` };
  return { kind: "other", message: humanError(error, `publish "${name}"`) };
}
