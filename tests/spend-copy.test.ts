import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BANNED_COPY_WORDS, containsBannedWord, formatCopyDate, formatCopyTime, isSpendCopyCode, SPEND_COPY_CODES, spendCopy, type SpendCopyCode, type SpendCopyParams } from "@/lib/spend/copy";
import { NeedsApprovalError, ShadowOnlyError, SPEND_CODE_STATUS, SpendBlockedError, SpendBusyError, SpendGuardBypassError } from "@/lib/spend/errors";

/** The 4.13 table, read from the spec itself so the copy can never drift from it. */
function specTable(): Map<string, string> {
  const spec = readFileSync(path.resolve(__dirname, "../docs/SPEND-CONTROLS-SPEC.md"), "utf8").replace(/\r/g, "");
  const section = spec.slice(spec.indexOf("### 4.13 Errors and copy"), spec.indexOf("### 4.14"));
  const rows = new Map<string, string>();
  for (const m of section.matchAll(/^\| `([a-z_.]+)` \| "(.+)" \|$/gm)) rows.set(m[1], m[2]);
  return rows;
}

const inr = (rupees: number) => ({ minor: BigInt(rupees) * 100n, currency: "INR" });
const IST = "Asia/Kolkata";

/** The figures the 4.13 examples use. */
const EXAMPLES: Partial<Record<SpendCopyCode, SpendCopyParams>> = {
  "spend.daily_limit": { left: inr(850), needs: inr(1400) },
  "spend.monthly_limit": { left: inr(3200), needs: inr(7000) },
  "spend.currency": { accountCurrency: "USD", limitCurrency: "INR" },
  "spend.meta_rate": { retryAt: new Date("2026-10-28T10:10:00Z"), timezone: IST },
  "spend.broadcast": { cost: inr(4300), left: inr(1200) },
  "spend.messaging_limit": { resetsOn: new Date("2026-10-31T18:30:00Z"), timezone: IST },
  ai_quota: { resetsOn: new Date("2026-10-31T18:30:00Z"), timezone: IST },
};

/** Every variant a code can render: no figures, the examples, and the other period. */
function variants(code: SpendCopyCode): string[] {
  const out = [spendCopy(code), spendCopy(code, EXAMPLES[code] ?? {})];
  out.push(spendCopy(code, { ...(EXAMPLES[code] ?? {}), period: "day" }));
  return out;
}

describe("spend copy (4.13)", () => {
  const table = specTable();

  it("reads the whole 4.13 table from the spec", () => {
    expect(table.size).toBe(17);
  });

  it("has copy for every 4.13 code and for spend.demo, and nothing else", () => {
    expect([...SPEND_COPY_CODES].sort()).toEqual([...table.keys(), "spend.demo"].sort());
    for (const code of SPEND_COPY_CODES) for (const text of variants(code)) expect(text.length, code).toBeGreaterThan(20);
  });

  it.each([...specTable()])("renders %s word for word with the spec's example figures", (code, text) => {
    expect(isSpendCopyCode(code)).toBe(true);
    expect(spendCopy(code as SpendCopyCode, EXAMPLES[code as SpendCopyCode] ?? {})).toBe(text);
  });

  it("has the demo copy from 8.4", () => {
    expect(spendCopy("spend.demo")).toBe("This is a demo workspace, so nothing can be spent.");
  });

  it("never uses the banned words, in any variant, in the error messages or in the parameters' absence", () => {
    const texts = [
      ...SPEND_COPY_CODES.flatMap(variants),
      new SpendBusyError().message,
      new NeedsApprovalError("ap_1").message,
      new ShadowOnlyError().message,
      new SpendGuardBypassError().message,
    ];
    for (const text of texts) for (const word of BANNED_COPY_WORDS) expect(text.toLowerCase(), text).not.toContain(word);
    expect(containsBannedWord("New-workspace limits, not Probation")).toBe("probation");
    expect(containsBannedWord("Left today: ₹850.")).toBeNull();
  });

  it("formats amounts with the currency exponent, never as raw minor units", () => {
    expect(spendCopy("spend.daily_limit", { left: { minor: 850n, currency: "JPY" }, needs: { minor: 1400n, currency: "JPY" } })).toContain("Left today: ¥850.");
    expect(spendCopy("spend.broadcast", { cost: { minor: 4300n, currency: "KWD" }, left: { minor: 1250n, currency: "KWD" } }).replace(/\s/g, " ")).toContain("about KWD 4.300, but only KWD 1.250");
    expect(spendCopy("spend.monthly_limit", { left: { minor: "1023400000", currency: "INR" }, needs: { minor: 10n ** 15n, currency: "INR" } })).toContain(
      "Left this month: ₹1,02,34,000. This campaign could use up to ₹1,00,00,00,00,00,000 by its end date.",
    );
    expect(spendCopy("spend.daily_limit", { left: inr(850), needs: inr(1400) })).not.toMatch(/85000|140000/);
  });

  it("drops a sentence rather than inventing a number when figures are missing", () => {
    expect(spendCopy("spend.daily_limit")).toBe("This would go over your ads limit for today. Lower the daily budget or raise your limit.");
    expect(spendCopy("spend.meta_rate")).toBe("Meta allows only 4 budget changes an hour for each ad set. Try again in an hour.");
    expect(spendCopy("spend.messaging_limit", { period: "day" })).toBe("Today's WhatsApp limit is used up. Automatic messages will wait until it resets tomorrow, or raise the limit.");
    expect(spendCopy("ai_quota", { period: "day" })).toBe("Today's AI limit is used up. AI replies and suggestions are off until tomorrow. Your team can still reply.");
    expect(spendCopy("spend.broadcast", { cost: inr(4300), left: inr(1200), period: "day" })).toContain("is left in your WhatsApp limit today.");
    expect(spendCopy("spend.probation", { daily: inr(1000), monthly: inr(9000) })).toBe("New workspaces can spend up to ₹1,000 a day and ₹9,000 a month on ads for now.");
  });

  it("shows dates and times in the workspace time zone", () => {
    expect(formatCopyDate(new Date("2026-10-31T18:30:00Z"), IST)).toBe("1 Nov");
    expect(formatCopyDate(new Date("2026-10-31T18:29:00Z"), IST)).toBe("31 Oct");
    expect(formatCopyTime(new Date("2026-10-28T10:10:00Z"), IST)).toBe("3:40 pm");
    expect(formatCopyTime(new Date("2026-10-28T10:10:00Z"), "America/New_York")).toBe("6:10 am");
    expect(formatCopyDate("not a date", IST)).toBeNull();
  });
});

describe("spend errors carry the copy", () => {
  it("uses 409 by default and the statuses the spec names", () => {
    expect(new SpendBlockedError("spend.daily_limit", EXAMPLES["spend.daily_limit"]).status).toBe(409);
    expect(new SpendBlockedError("spend.only_owner_raise").status).toBe(403);
    expect(new SpendBlockedError("ai_quota").status).toBe(402);
    expect(SPEND_CODE_STATUS["spend.version"]).toBeUndefined();
    const e = new SpendBlockedError("spend.monthly_limit", EXAMPLES["spend.monthly_limit"]);
    expect(e.message).toBe(specTable().get("spend.monthly_limit"));
    expect(e.toJSON()).toEqual({ error: e.message, code: "spend.monthly_limit", params: { left: { minor: "320000", currency: "INR" }, needs: { minor: "700000", currency: "INR" } } });
  });
});
