import type { Tone } from "@/components/ui/status";

export type FindingSeverity = "info" | "warn" | "block";
export type RawFinding = { rule: string; severity: FindingSeverity; message: string; match?: string };
export type RawCheck = { result: "pass" | "warn" | "block"; findings: RawFinding[]; disclaimer?: string; description?: string } | null;

export type Explained = {
  rule: string;
  severity: FindingSeverity;
  /** "Must fix", "Please review" or "Good to know". */
  label: string;
  title: string;
  why: string;
  fix: string;
  /** The exact words that triggered the rule, when we have them. */
  found?: string;
  /** The original message, for the Details element. */
  detail: string;
};

type Entry = { title: string; why: string; fix: string };

const COMMON_FIX = "Reword the text and save it again. We re-check it straight away.";

const ENTRIES: Record<string, Entry> = {
  banned_word: {
    title: "Uses a word you asked us to avoid",
    why: "This word is on your brand kit's list of banned words.",
    fix: "Replace the word, or remove it from your brand kit if it is allowed after all.",
  },
  guaranteed_returns: {
    title: "Promises guaranteed results",
    why: "Ads that promise guaranteed money, returns or approval are often rejected by Meta because they cannot be proven.",
    fix: "Say what you offer without promising an outcome. For example, use \"we help you plan\" instead of \"guaranteed returns\".",
  },
  cure_claims: {
    title: "Makes a health or cure claim",
    why: "Claims that something cures a condition or gives a fixed health result are often rejected.",
    fix: "Describe what the product or service is, not what it will cure. Avoid numbers of kilos or days.",
  },
  personal_attributes_sensitive: {
    title: "Talks about a personal or sensitive trait",
    why: "Text that suggests you know something private about the reader, such as health, debt or religion, is often rejected.",
    fix: "Speak about the offer, not about the reader. Change \"Are you in debt?\" to \"Ways to manage your money\".",
  },
  personal_attributes_generic: {
    title: "Asks \"Are you...\" about the reader",
    why: "Questions that describe the reader can look like you know personal details about them.",
    fix: "Use neutral wording, such as \"Looking for a new home? See our latest listings.\"",
  },
  before_after: {
    title: "Uses before and after wording",
    why: "Before-and-after claims are often rejected because they can mislead.",
    fix: "Describe the result in general terms, or show the product instead.",
  },
  sensational: {
    title: "Sounds sensational",
    why: "Shock or secret-style wording is often rejected and can hurt trust.",
    fix: "Use a calm, clear sentence about what you offer.",
  },
  excess_punctuation: {
    title: "Too many exclamation or question marks",
    why: "Repeated punctuation looks like spam and is often rejected.",
    fix: "Use at most one exclamation mark, and no repeated symbols.",
  },
  urgency_false: {
    title: "Pushes urgency",
    why: "Urgency such as \"last chance\" or \"only 3 left\" must be true, or the ad can be rejected.",
    fix: "Keep it only if it is accurate. Otherwise remove it or give a real end date.",
  },
  excess_caps: {
    title: "Too many capital letters",
    why: "Text in all capitals is often rejected and is harder to read.",
    fix: "Use normal sentence case. Keep capitals for names.",
  },
  missing_disclosure_finance: {
    title: "Financial offer without a terms note",
    why: "Offers about loans, investments or insurance usually need a note about risk or terms.",
    fix: "Add a short line such as \"Terms apply\" or \"Subject to approval\", or make sure the page the ad links to says it.",
  },
  missing_disclosure_health: {
    title: "Health wording without a safety note",
    why: "Health-related offers usually need a note that results vary or to ask a professional.",
    fix: "Add \"Results may vary\" or \"Please consult a professional\".",
  },
  missing_disclosure_offer: {
    title: "Offer without its conditions",
    why: "Free or discounted offers should say when they are valid and what conditions apply.",
    fix: "Add the end date or a short \"Terms apply\", and check the page the ad links to.",
  },
  special_category: {
    title: "Special ad category",
    why: "Ads about housing, jobs, credit or social issues have extra rules from Meta, including limits on who you can target.",
    fix: "Pick this category when you set up the campaign. Check Meta's current rules for your country.",
  },
  special_category_wording: {
    title: "Wording could exclude a group of people",
    why: "Housing, job and credit ads must not suggest a preferred group.",
    fix: "Describe the property, job or product, not the kind of person it is for.",
  },
  ai_label: {
    title: "Made with AI",
    why: "Meta may ask you to label realistic AI-made pictures. People in generated pictures are not real customers.",
    fix: "Do not present generated people as real customers. Add Meta's AI label if it asks for one.",
  },
};

export function stripInternalMarkers(text: string): string {
  return text.replace(/\s*\(VERIFY\)/g, "").replace(/\bVERIFY\b[^.]*\.?/g, "").replace(/\s{2,}/g, " ").trim();
}

function lengthEntry(message: string): Entry {
  const m = message.match(/^(Headline|Primary text|Description) is (\d+) characters; the recommended maximum for (\w+) is (\d+)/);
  if (!m) return { title: "Text may be cut off", why: "It is longer than the recommended length, so part of it may be hidden.", fix: "Shorten it." };
  const [, part, have, , max] = m;
  const name = part === "Primary text" ? "Main text" : part;
  return {
    title: `${name} is too long`,
    why: `It has ${have} characters and about ${max} are shown before it is cut off.`,
    fix: `Shorten it to ${max} characters or fewer.`,
  };
}

const SEVERITY_LABEL: Record<FindingSeverity, string> = { block: "Must fix", warn: "Please review", info: "Good to know" };
const SEVERITY_ORDER: Record<FindingSeverity, number> = { block: 0, warn: 1, info: 2 };

export function explainFinding(f: RawFinding): Explained {
  const entry = f.rule === "length" ? lengthEntry(f.message) : ENTRIES[f.rule];
  const base = entry ?? { title: "Check this wording", why: stripInternalMarkers(f.message), fix: COMMON_FIX };
  return {
    rule: f.rule,
    severity: f.severity,
    label: SEVERITY_LABEL[f.severity],
    title: base.title,
    why: base.why,
    fix: base.fix,
    found: f.match?.trim() || undefined,
    detail: stripInternalMarkers(f.message),
  };
}

export function explainFindings(check: RawCheck): Explained[] {
  if (!check) return [];
  return check.findings.map(explainFinding).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export type PolicySummary = { tone: Tone; headline: string; detail: string; blockers: number; warnings: number; notes: number };

/** One sentence a shop owner can act on, for the top of a policy report. */
export function summarizePolicy(check: RawCheck): PolicySummary {
  if (!check) return { tone: "neutral", headline: "Not checked yet", detail: "Save the text to run the check.", blockers: 0, warnings: 0, notes: 0 };
  const blockers = check.findings.filter((f) => f.severity === "block").length;
  const warnings = check.findings.filter((f) => f.severity === "warn").length;
  const notes = check.findings.filter((f) => f.severity === "info").length;
  if (check.result === "block") {
    return { tone: "bad", headline: "Likely to be rejected", detail: `${blockers === 1 ? "1 problem needs" : `${blockers} problems need`} fixing before you can send this for approval.`, blockers, warnings, notes };
  }
  if (check.result === "warn") {
    return { tone: "warn", headline: "Worth a second look", detail: `${warnings === 1 ? "1 thing" : `${warnings} things`} could cause trouble. You can still send it.`, blockers, warnings, notes };
  }
  return { tone: "good", headline: "No problems found", detail: notes > 0 ? "We only have a few things to be aware of." : "We did not find common ad policy problems.", blockers, warnings, notes };
}

export const POLICY_RESULT_LABEL: Record<"pass" | "warn" | "block", string> = {
  pass: "No problems found",
  warn: "Worth a second look",
  block: "Likely to be rejected",
};
