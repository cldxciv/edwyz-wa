import { currencyExponent } from "@/lib/ads/insights-money";

export const KIND_LABEL: Record<string, string> = {
  pause_ad: "Pause an ad",
  shift_budget: "Move some budget",
  rotate_creative: "Refresh an ad",
  new_angle: "Try a new angle",
};

export const isAdvisory = (kind: string) => kind === "rotate_creative" || kind === "new_angle";

export function proposalStatusLabel(status: string): string {
  switch (status) {
    case "proposed":
      return "Waiting for you";
    case "approved":
      return "Approved, not applied yet";
    case "applied":
      return "Applied";
    case "reverted":
      return "Undone";
    case "rejected":
      return "Rejected";
    case "expired":
      return "Expired";
    case "failed":
      return "Could not apply";
    default:
      return "Unknown";
  }
}

export type Money = (minor: number) => string;
type Payload = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** Ad set names live only in the server's sentence: Ad set "A" costs ... for "B" ... */
export function shiftNames(rationale: string): { from: string; to: string } | null {
  const m = /Ad set "(.+?)" costs .* for "(.+?)" over/.exec(rationale);
  return m ? { from: m[1], to: m[2] } : null;
}

/** A readable title and reason, built from the numbers. Null when the numbers are missing, so the caller can fall back to the server's sentence. */
export function describeProposal(kind: string, payload: Payload, rationale: string, money: Money): { title: string; why: string } | null {
  const days = num(payload.windowDays);
  const period = days ? `in the last ${days} days` : "recently";
  const name = text(payload.adName);
  if (kind === "pause_ad") {
    const spend = num(payload.spendMinor);
    if (spend === null) return null;
    const title = name ? `Pause "${name}"` : "Pause this ad";
    if (payload.reason === "zero_results") return { title, why: `It spent ${money(spend)} ${period} and got no results.` };
    const cpr = num(payload.cprMinor);
    const avg = num(payload.campaignCprMinor);
    if (cpr === null || avg === null) return null;
    const multiple = num(payload.multiple);
    return { title, why: `Each result costs ${money(cpr)}${multiple ? `, about ${multiple} times` : ""} the campaign average of ${money(avg)} (${period}).` };
  }
  if (kind === "shift_budget") {
    const amount = num(payload.amountMinor);
    const fromCpr = num(payload.fromCprMinor);
    const toCpr = num(payload.toCprMinor);
    if (amount === null || fromCpr === null || toCpr === null) return null;
    const names = shiftNames(rationale);
    const from = names ? `"${names.from}"` : "One ad set";
    const to = names ? `"${names.to}"` : "another";
    return { title: names ? `Move ${money(amount)} a day to "${names.to}"` : `Move ${money(amount)} a day to your better ad set`, why: `${from} costs ${money(fromCpr)} per result, while ${to} costs ${money(toCpr)} (${period}). Moving budget gets you more results for the same spend.` };
  }
  if (kind === "rotate_creative") {
    const freq = num(payload.frequency);
    const drop = num(payload.ctrDropPct);
    if (freq === null || drop === null) return null;
    return { title: name ? `Refresh "${name}"` : "Refresh this ad", why: `People have seen it about ${Math.round(freq * 10) / 10} times, and clicks have dropped by ${drop}%. A new picture or wording usually brings attention back.` };
  }
  if (kind === "new_angle") {
    const win = num(payload.winnerCprMinor);
    const avg = num(payload.campaignCprMinor);
    if (win === null || avg === null) return null;
    return { title: "Try a new angle", why: `Your best ads cost ${money(win)} per result, against ${money(avg)} for the campaign on average. They share a pattern you can copy.` };
  }
  return null;
}

/** What approving does, in one sentence. */
export function effectText(kind: string, payload: Payload, money: Money, revertDays: number): string {
  if (kind === "pause_ad") return `The ad stops showing on Meta right away. You can turn it back on for ${revertDays} days.`;
  if (kind === "shift_budget") {
    const amount = num(payload.amountMinor);
    return `${amount === null ? "Some budget" : `${money(amount)} a day`} moves between the two ad sets. Your total daily spending stays the same. You can undo it for ${revertDays} days.`;
  }
  return "Nothing changes on Meta. This is advice for you to act on, and you can mark it as done.";
}

export type ConfirmCopy = { title: string; body: string; confirmLabel: string; tone: "default" | "danger" };

export function approveCopy(kind: string, name: string, effect: string): ConfirmCopy {
  if (kind === "pause_ad") return { title: name ? `Pause "${name}"?` : "Pause this ad?", body: effect, confirmLabel: "Pause ad", tone: "default" };
  if (kind === "shift_budget") return { title: "Move this budget?", body: effect, confirmLabel: "Move budget", tone: "default" };
  return { title: "Mark this advice as done?", body: effect, confirmLabel: "Mark as done", tone: "default" };
}

export const rejectCopy: ConfirmCopy = { title: "Reject this suggestion?", body: "Nothing changes on Meta. The suggestion is removed from your list.", confirmLabel: "Reject suggestion", tone: "default" };

export const revertCopy: ConfirmCopy = { title: "Undo this change?", body: "We will put the ad or budget back the way it was on Meta.", confirmLabel: "Undo change", tone: "danger" };

export const canRevert = (p: { status: string; appliedAt: string | null; revertPayload: unknown }, revertDays: number, now = Date.now()) =>
  p.status === "applied" && p.revertPayload != null && p.appliedAt !== null && now - new Date(p.appliedAt).getTime() <= revertDays * 86_400_000;

/** Last moment an applied change can be undone, or null when it cannot. */
export function revertDeadline(appliedAt: string | null, revertDays: number): Date | null {
  if (!appliedAt) return null;
  const at = new Date(appliedAt).getTime();
  return Number.isNaN(at) ? null : new Date(at + revertDays * 86_400_000);
}

/** Supporting numbers shown as a small list under the reason. Money values are formatted in the account currency. */
export function numbersFor(kind: string, payload: Payload, money: Money = String): [string, string][] {
  const m = (v: unknown) => (num(v) === null ? "" : money(num(v) as number));
  const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  const rows: [string, string][] =
    kind === "pause_ad"
      ? [["Spent", m(payload.spendMinor)], ["Results", s(payload.results)], ["Cost per result", m(payload.cprMinor)], ["Campaign average", m(payload.campaignCprMinor)]]
      : kind === "shift_budget"
        ? [
            ["Budget taken from", num(payload.fromBudgetBefore) === null ? "" : `${m(payload.fromBudgetBefore)} to ${m(payload.fromBudgetAfter)}`],
            ["Budget given to", num(payload.toBudgetBefore) === null ? "" : `${m(payload.toBudgetBefore)} to ${m(payload.toBudgetAfter)}`],
            ["Daily limit", m(payload.capMinor)],
          ]
        : kind === "rotate_creative"
          ? [["Times seen per person", s(payload.frequency)], ["Drop in clicks", payload.ctrDropPct === undefined ? "" : `${s(payload.ctrDropPct)}%`]]
          : [["Best ads, cost per result", m(payload.winnerCprMinor)], ["Campaign average", m(payload.campaignCprMinor)]];
  return rows.filter(([, v]) => v !== "");
}

export type SettingSpec = { key: string; label: string; hint: string; kind: "money" | "number"; min: number; max: number; int?: boolean };

/** Bounds mirror the server (src/lib/optimizer/config.ts); the server stays the authority and rejects anything outside them. */
export const SETTING_SPECS: SettingSpec[] = [
  { key: "minSpendMinor", label: "Wait until an ad has spent", hint: "Ads that have spent less than this are never judged.", kind: "money", min: 0, max: 100_000_000, int: true },
  { key: "zeroResultSpendMinor", label: "Pause an ad with no results after it spends", hint: "The amount an ad can spend with nothing to show for it.", kind: "money", min: 0, max: 100_000_000, int: true },
  { key: "cprMultiple", label: "Pause when a result costs this many times the average", hint: "For example 2 means twice as much as the campaign average.", kind: "number", min: 1.1, max: 20 },
  { key: "maxShiftPct", label: "Most budget to move at once (percent)", hint: "Never more than 20.", kind: "number", min: 1, max: 20 },
  { key: "frequencyThreshold", label: "Suggest a refresh when people have seen an ad this many times", hint: "Used together with a drop in clicks.", kind: "number", min: 1, max: 20 },
  // Suggestions expire in hours, on the same clock as a spending request (docs/SPEND-CONTROLS-SPEC.md 7.3: "expiry moves from
  // days to hours"). The server still accepts the old expireDays key, but it no longer changes anything.
  { key: "expireHours", label: "Remove suggestions you have not answered after (hours)", hint: "From 1 to 48. Old advice stops being useful.", kind: "number", min: 1, max: 48, int: true },
];

/** The field label with its unit. A money setting names its currency, or says which one it is when that is not known. */
export function settingLabel(spec: SettingSpec, currency: string | null): string {
  if (spec.kind !== "money") return spec.label;
  return `${spec.label} (${currency ?? "in your ad account's currency"})`;
}

/** The currency every connected ad account uses, or null when there is none or they differ. */
export function sharedCurrency(accounts: { currency: string | null }[] | null | undefined): string | null {
  const codes = new Set((accounts ?? []).map((a) => a.currency));
  const [only] = codes;
  return codes.size === 1 && only ? only : null;
}

export function settingToText(spec: SettingSpec, stored: number | boolean | undefined, currency: string | null): string {
  if (typeof stored !== "number") return "";
  if (spec.kind === "number") return String(stored);
  const exp = currencyExponent(currency);
  const value = stored / 10 ** exp;
  return Number.isInteger(value) ? String(value) : value.toFixed(exp).replace(/0+$/, "").replace(/\.$/, "");
}

export function validateSettings(values: Record<string, string>, currency: string | null): { body: Record<string, number>; errors: Record<string, string> } {
  const exp = currencyExponent(currency);
  const body: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const spec of SETTING_SPECS) {
    const raw = (values[spec.key] ?? "").replace(/,/g, "").trim();
    const entered = Number(raw);
    if (raw === "" || !Number.isFinite(entered)) {
      errors[spec.key] = "Enter a number.";
      continue;
    }
    const value = spec.kind === "money" ? Math.round(entered * 10 ** exp) : entered;
    const lo = spec.kind === "money" ? spec.min / 10 ** exp : spec.min;
    const hi = spec.kind === "money" ? spec.max / 10 ** exp : spec.max;
    if (spec.int && !Number.isInteger(value)) errors[spec.key] = "Enter a whole number.";
    else if (value < spec.min || value > spec.max) errors[spec.key] = `Enter a number from ${lo.toLocaleString()} to ${hi.toLocaleString()}.`;
    else body[spec.key] = value;
  }
  return { body, errors };
}

export function friendlyOptimizerError(message: string | null | undefined): string {
  const t = (message ?? "").trim();
  if (!t) return "Something went wrong. Please try again.";
  if (/This proposal is (applied|rejected|expired|reverted|failed)/i.test(t)) return "This suggestion was already handled. The list has been refreshed.";
  if (/No daily budget cap is set/i.test(t)) return "No daily spending limit is set yet. An owner needs to set one on the Ad campaigns page.";
  if (/leaves no room/i.test(t)) return "Your daily spending limit leaves no room for this change. An owner can raise the limit on the Ad campaigns page.";
  return t;
}
