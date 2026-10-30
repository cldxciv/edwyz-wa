import { CATEGORY_NOTICES, COPY_LIMITS, POLICY_DISCLAIMER, type Placement, type SpecialCategory } from "./constants";

export type Severity = "info" | "warn" | "block";
export type Finding = { rule: string; severity: Severity; message: string; match?: string };
export type PolicyResult = { result: "pass" | "warn" | "block"; findings: Finding[]; disclaimer: string; checkedAt: string };

export type PolicyInput = {
  headline?: string | null;
  body?: string | null;
  description?: string | null;
  placement?: Placement;
  aiGenerated?: boolean;
  brand: { bannedWords: string[]; specialAdCategory: string };
};

type Rule = { id: string; severity: Severity; re: RegExp; message: string };

/** Heuristic patterns only. Extend here; every row is covered by tests/creative-policy.test.ts. */
export const TEXT_RULES: Rule[] = [
  { id: "guaranteed_returns", severity: "block", re: /guarantee[sd]?\b[^.!?\n]{0,40}\b(returns?|profits?|income|earnings?|results?|approval)|\brisk[\s-]?free\b|\bget rich\b|\bdouble your money\b|\b\d+x returns?\b/i, message: "Guaranteed returns or results claims are commonly rejected." },
  { id: "cure_claims", severity: "block", re: /\b(cures?|cured|miracle (cure|pill|remedy)|permanent(ly)? (remove|cure|fix)|reverse[sd]? (diabetes|aging|ageing)|lose \d+\s?(kg|lbs?|pounds|kilos) in)\b/i, message: "Cure or guaranteed health-outcome claims are commonly rejected." },
  { id: "personal_attributes_sensitive", severity: "block", re: /\b(are you|do you have|do you suffer from|your)\b[^.!?\n]{0,30}\b(diabet\w*|depress\w*|anxiety|hiv|cancer|debt|bankrupt\w*|disabilit\w*|religion|race|caste|sexual orientation|gay|lesbian|transgender|overweight|obese|single|divorced|unemployed|credit score|criminal record)\b/i, message: "Text that implies you know a person's sensitive personal attribute is commonly rejected." },
  { id: "personal_attributes_generic", severity: "warn", re: /\bare you (a |an |still |tired|struggling|looking|ready|worried|suffering)/i, message: "Question phrasing that addresses 'are you...' can imply personal attributes. Prefer neutral wording." },
  { id: "before_after", severity: "warn", re: /\bbefore\s*(and|&|\/|-|to)\s*after\b|\bbefore\/after\b/i, message: "Before-and-after claims are commonly rejected." },
  { id: "sensational", severity: "warn", re: /\b(shocking|you won'?t believe|they don'?t want you to know|secret trick|one weird trick|doctors hate)\b/i, message: "Sensational language is commonly rejected." },
  { id: "excess_punctuation", severity: "warn", re: /[!?]{2,}|!.*!.*!|\${2,}/, message: "Repeated or excessive punctuation is commonly rejected." },
  { id: "urgency_false", severity: "warn", re: /\b(only \d+ (left|spots|seats)|last chance|hurry)\b/i, message: "Urgency claims must be true. Check before using." },
];

const DISCLOSURE_RULES: { id: string; trigger: RegExp; needs: RegExp; message: string }[] = [
  { id: "missing_disclosure_finance", trigger: /\b(loans?|invest\w*|mutual funds?|trading|interest rate|emi|insurance)\b/i, needs: /terms|t&c|subject to|risk|conditions apply|disclaimer/i, message: "Financial offers usually need a risk or terms disclosure in the ad or on the landing page." },
  { id: "missing_disclosure_health", trigger: /\b(weight loss|supplement|treatment|therapy|detox)\b/i, needs: /consult|results may vary|doctor|physician/i, message: "Health claims usually need a 'consult a professional' or 'results may vary' note." },
  { id: "missing_disclosure_offer", trigger: /\b(free|\d+%\s*off|discount)\b/i, needs: /terms|t&c|conditions|valid|apply/i, message: "Offers should state conditions or validity. Check the landing page covers them." },
];

const SPECIAL_RULES: { re: RegExp; message: string }[] = [
  { re: /\b(ideal|perfect|best|great) for (men|women|singles?|bachelors?|families|couples|young|youngsters|seniors?|students)\b|\b(only for|no) (men|women|children|kids|bachelors?|singles?)\b|\b(hindu|muslim|christian|sikh|jain|brahmin)s?\b[^.!?\n]{0,20}\b(only|preferred|community)\b/i, message: "Housing, employment and credit ads must not discriminate or imply a preferred group." },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function capsFinding(text: string): Finding | null {
  const words = text.match(/[A-Za-z][A-Za-z']*/g) ?? [];
  const caps = words.filter((w) => w.length >= 3 && w === w.toUpperCase());
  const run = /(\b[A-Z]{3,}\b[\s,]+){2,}\b[A-Z]{3,}\b/.test(text);
  if (run || (words.length >= 4 && caps.length / words.length > 0.3)) {
    return { rule: "excess_caps", severity: "warn", message: "Excessive capital letters are commonly rejected.", match: caps.slice(0, 3).join(" ") };
  }
  return null;
}

export function checkPolicy(input: PolicyInput, now = new Date()): PolicyResult {
  const parts = [input.headline, input.body, input.description].filter((p): p is string => !!p?.trim());
  const text = parts.join("\n");
  const findings: Finding[] = [];

  for (const word of input.brand.bannedWords) {
    const w = word.trim();
    if (!w) continue;
    const m = text.match(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}(?=$|[^\\p{L}\\p{N}])`, "iu"));
    if (m) findings.push({ rule: "banned_word", severity: "block", message: `Contains a word your brand kit bans: "${w}".`, match: w });
  }
  for (const rule of TEXT_RULES) {
    const m = text.match(rule.re);
    if (m) findings.push({ rule: rule.id, severity: rule.severity, message: rule.message, match: m[0].slice(0, 80) });
  }
  const caps = capsFinding(text);
  if (caps) findings.push(caps);
  for (const rule of DISCLOSURE_RULES) {
    if (rule.trigger.test(text) && !rule.needs.test(text)) findings.push({ rule: rule.id, severity: "warn", message: rule.message });
  }

  const category = input.brand.specialAdCategory as SpecialCategory;
  if (category !== "none" && category in CATEGORY_NOTICES) {
    findings.push({ rule: "special_category", severity: "info", message: CATEGORY_NOTICES[category as Exclude<SpecialCategory, "none">] });
    for (const r of SPECIAL_RULES) {
      const m = text.match(r.re);
      if (m) findings.push({ rule: "special_category_wording", severity: "warn", message: r.message, match: m[0].slice(0, 80) });
    }
  }

  if (input.placement) {
    const limits = COPY_LIMITS[input.placement];
    const over = (value: string | null | undefined, max: number, label: string) => {
      if (value && value.length > max) findings.push({ rule: "length", severity: "warn", message: `${label} is ${value.length} characters; the recommended maximum for ${input.placement} is ${max} (VERIFY).` });
    };
    over(input.headline, limits.headline, "Headline");
    over(input.body, limits.primaryText, "Primary text");
    over(input.description, limits.description, "Description");
  }

  if (input.aiGenerated !== false) {
    findings.push({ rule: "ai_label", severity: "info", message: "AI-generated content: Meta may require an 'AI info' label on realistic AI media (VERIFY). Do not present generated people as real customers." });
  }

  const result = findings.some((f) => f.severity === "block") ? "block" : findings.some((f) => f.severity === "warn") ? "warn" : "pass";
  return { result, findings, disclaimer: POLICY_DISCLAIMER, checkedAt: now.toISOString() };
}
