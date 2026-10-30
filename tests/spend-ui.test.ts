import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

/**
 * Settings > Spending limits and the spending banner, rendered (docs/SPEND-CONTROLS-SPEC.md 8.1, 8.2; WP-17). The summaries are
 * real: built by src/lib/spend/summary.ts for each role on the in-memory spend database, then rendered with
 * renderToStaticMarkup. Checks: every card per role, the 8.1 copy word for word, "Not set" instead of invented numbers, no
 * jargon, every row of the 8.1 role table, the banner priority order, and theme tokens only (dark theme follows the tokens).
 */

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb, billing: "active" as string }));
vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/billing", () => ({ getBillingStatus: vi.fn(async () => ({ state: h.billing })), assertTenantCanWrite: vi.fn(async () => undefined) }));
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn(async () => ({ id: "job" })) }));

import { ActivityTable, ActivityTableView, couldAddText, csvHref, resultBadge } from "@/components/spend/ActivityTable";
import { ApprovalReview, ONLY_OWNER_APPROVES, SIGN_IN_TO_APPROVE, decidedText } from "@/components/spend/ApprovalReview";
import { ApprovalsCard } from "@/components/spend/ApprovalsCard";
import { ASSISTANT_ON_LABEL, AssistantsCard, SUGGEST_ONLY_FOR_NOW, enabledPatch, levelSentence } from "@/components/spend/AssistantsCard";
import { KillSwitch, OWNER_ONLY_RESUME, RESUME_ASSISTANTS_DIALOG, RESUME_DIALOG, RESUME_LIST_INTRO, STOP_ALL_DIALOG, dialogFor } from "@/components/spend/KillSwitch";
import { DialogError, META_CONSENT, META_EXPLAINER, MetaConsentText, MetaLimitCard, offboardLabel } from "@/components/spend/MetaLimitCard";
import { DIGEST_LABEL, NOTIFY_BUTTON, NOTIFY_CONSENT, NOTIFY_TITLE, NotifyCard, STOP_ALERTS_BUTTON, canStopAlerts, channelText, pendingText, phoneProblem } from "@/components/spend/NotifyCard";
import { NOT_SET, PotCard, limitLine, potRows, readLimitForm, toMajorInput } from "@/components/spend/PotCard";
import { BANNER_ORDER, SpendBannerBar, isDismissed, pickBanner, rememberDismissal } from "@/components/spend/SpendBanner";
import { SPENDING_SUBTITLE, SPENDING_TITLE, SpendingSettingsView, approvalFocusTarget } from "@/components/spend/SpendingSettings";
import { BANNED_COPY_WORDS } from "@/lib/spend/copy";
import { buildBanners, metaLimitView, spendSummary, staticCopy, bannedCopyIn, type SpendSummaryView } from "@/lib/spend/summary";
import type { AdAccountInfo } from "@/lib/spend/commitments";
import type { ApprovalDTO, LedgerRowDTO, MetaLimitState, SpendCapabilities } from "@/lib/spend/types";

const T = "t1";
const NOW = new Date("2026-10-28T06:30:00Z");
type Role = "owner" | "admin" | "agent";
const ACTORS: Record<Role, { userId: string; tenantId: string; role: Role }> = {
  owner: { userId: "u_owner", tenantId: T, role: "owner" },
  admin: { userId: "u_admin", tenantId: T, role: "admin" },
  agent: { userId: "u_agent", tenantId: T, role: "agent" },
};
const html = (el: ReactElement) => renderToStaticMarkup(el);
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&#39;/g, "'");
/** The visible text of rendered markup, one line per text node. */
const text = (markup: string) =>
  decode(markup.replace(/<[^>]+>/g, "\n"))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
const noop = () => undefined;

type Seed = { adAccount?: boolean; phone?: boolean; demo?: boolean; freeze?: "none" | "assistants" | "all"; approverIsAdmin?: boolean; mandate?: Row; approval?: Row; allowances?: Row[]; meta?: Row; secondAccount?: boolean; chosen?: boolean };

function seed(o: Seed = {}) {
  h.db.reset();
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active", billingExempt: false, createdAt: new Date("2026-10-25T00:00:00Z") }]);
  h.db.seed("user", [
    { id: "u_owner", name: "Priya" },
    { id: "u_admin", name: "Ravi" },
    { id: "u_agent", name: "Asha" },
  ]);
  h.db.seed("membership", Object.values(ACTORS).map((a) => ({ id: `m_${a.userId}`, ...a })));
  h.db.seed("spendCeiling", [
    { id: "sc1", scope: "probation", scopeId: "*", pot: "ads", currency: "INR", dailyMinor: 200_000n, monthlyMinor: 2_000_000n, reason: "seed" },
    { id: "sc2", scope: "probation", scopeId: "*", pot: "messaging", currency: "INR", dailyMinor: 50_000n, monthlyMinor: 500_000n, reason: "seed" },
    { id: "sc3", scope: "probation", scopeId: "*", pot: "ai", currency: "CRD", dailyMinor: null, monthlyMinor: 500n, reason: "seed" },
  ]);
  if (o.adAccount !== false) {
    h.db.seed("metaAsset", [{ id: "acc1", tenantId: T, type: "ad_account", externalId: "act_111", name: "Edwyz Store", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata", ...(o.demo ? { demo: true } : {}) }, sandbox: false, createdAt: new Date("2026-01-01") }]);
  }
  if (o.secondAccount) h.db.seed("metaAsset", [{ id: "acc2", tenantId: T, type: "ad_account", externalId: "act_222", name: "Shop US", status: "active", meta: { currency: "USD", timezone: "America/New_York" }, sandbox: false, createdAt: new Date("2026-02-01") }]);
  if (o.phone) h.db.seed("phoneNumber", [{ id: "pn1", tenantId: T, wabaRefId: "w1", phoneNumberId: "PN1", displayPhone: "+15550001", status: "connected" }]);
  h.db.seed("spendControl", [
    {
      tenantId: T,
      probation: "auto",
      spendingAdAccountAssetId: o.adAccount === false || o.chosen === false ? null : "acc1",
      timezone: "Asia/Kolkata",
      approverUserIds: o.approverIsAdmin === false ? [] : ["u_admin"],
      freeze: o.freeze ?? "none",
      frozenAt: o.freeze && o.freeze !== "none" ? new Date("2026-10-28T08:35:00Z") : null,
      frozenByUserId: o.freeze && o.freeze !== "none" ? "u_owner" : null,
      frozenByKind: o.freeze && o.freeze !== "none" ? "owner" : null,
    },
  ]);
  h.db.seed("spendAllowance", o.allowances ?? [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: 175_000n, monthlyLimitMinor: 2_000_000n, migratedFromCapMinor: 100_000n, version: 2 }]);
  if (o.mandate) h.db.seed("assistantMandate", [{ id: "am1", tenantId: T, assistantKey: "ads_optimizer", ...o.mandate }]);
  if (o.approval) h.db.seed("spendApproval", [o.approval]);
  if (o.meta) h.db.seed("metaSpendLimit", [{ adAccountAssetId: "acc1", tenantId: T, accountExternalId: "act_111", ...o.meta }]);
}

async function summaryFor(role: Role, o: Seed = {}): Promise<SpendSummaryView> {
  seed(o);
  return spendSummary(ACTORS[role], { now: NOW, env: {} });
}

const page = (s: SpendSummaryView) => html(createElement(SpendingSettingsView, { summary: s, onSaved: noop }));

const APPROVAL: Row = {
  id: "sp1",
  tenantId: T,
  assistantKey: "ads_optimizer",
  pot: "ads",
  actionKind: "raise_budget",
  direction: "raise",
  intent: {},
  fingerprint: "fp",
  summary: "Raise the daily budget of 'Diwali leads - Delhi' from ₹800 to ₹1,000",
  reason: "Cost per lead is ₹62, well below your ₹100 target",
  forecastMonthMinor: 455_000n,
  currency: "INR",
  status: "pending",
  tokenHash: "h".repeat(64),
  createdAt: new Date(NOW.getTime() - 3_600_000),
  expiresAt: new Date(NOW.getTime() + 11 * 3_600_000),
  correlationId: "c1",
};

beforeEach(() => {
  h.billing = "active";
});

// =====================================================================================================================
describe("the page per role (8.1)", () => {
  it("has the header, subtitle and role notes, and the time zone line", async () => {
    for (const role of ["owner", "admin", "agent"] as const) {
      const lines = text(page(await summaryFor(role)));
      expect(lines).toContain(SPENDING_TITLE);
      expect(lines).toContain(SPENDING_SUBTITLE);
      expect(lines).toContain("Days and months follow Asia/Kolkata time, the same as your ad account.");
      const notes = lines.filter((l) => l === "You can lower limits or stop spending. Only the owner can raise a limit." || l === "Only the owner can change spending limits. Ask them if you need more.");
      expect(notes).toEqual(role === "owner" ? [] : role === "admin" ? ["You can lower limits or stop spending. Only the owner can raise a limit."] : ["Only the owner can change spending limits. Ask them if you need more."]);
    }
    expect(SPENDING_SUBTITLE).toBe(
      "Choose the most Edwyz can spend for you each month and each day. Every ad change, automatic WhatsApp message and AI reply is checked against these limits first. Meta and WhatsApp bill you directly; Edwyz never holds your ad money.",
    );
  }, 30_000);

  it("shows the new-workspace note with the ₹1,142 explanation", async () => {
    const lines = text(page(await summaryFor("agent")));
    expect(lines.join(" ")).toContain(
      "Your workspace is new, so ads can spend up to ₹2,000 a day and ₹20,000 a month for now. This goes up after your first two payments, or ask support. A ₹2,000 daily limit allows ads with up to ₹1,142 a day in total budget.",
    );
  });

  it("uses no jargon anywhere on the page, for any role or state", async () => {
    for (const role of ["owner", "admin", "agent"] as const) {
      for (const [name, o] of Object.entries({ plain: {}, noMeta: { adAccount: false }, demo: { demo: true }, stopped: { freeze: "all" as const }, request: { approval: APPROVAL } })) {
        const markup = text(page(await summaryFor(role, o))).join(" ").toLowerCase();
        for (const w of BANNED_COPY_WORDS) expect(markup, `${role} ${name}`).not.toContain(w);
        expect(markup).not.toMatch(/\bminor\b|payload|webhook|token/);
      }
    }
    expect(bannedCopyIn(staticCopy())).toEqual([]);
  }, 60_000);

  it("uses theme tokens only (no dark: variants, hex or palette colours), so the dark theme follows", async () => {
    const markup = page(await summaryFor("owner", { approval: APPROVAL, mandate: { level: 1, enabled: true, version: 1 } }));
    expect(markup).not.toMatch(/\bdark:/);
    expect(markup).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(markup).not.toMatch(/\b(?:bg|text|border)-(?:red|green|blue|amber|emerald|gray|slate|zinc)-\d{2,3}\b/);
    expect(markup).not.toMatch(/z-\[\d+\]/);
    // Nothing forces a width wider than a 360 px phone.
    expect(markup).not.toMatch(/\b(?:min-)?w-\[(?:[4-9]\d{2}|\d{4})px\]/);
  });
});

// =====================================================================================================================
describe("the status strip (KillSwitch)", () => {
  const caps = async (role: Role) => (await summaryFor(role)).capabilities;

  it("on: owner and admin get [Stop assistants] [Stop all spending]; a team member gets none", async () => {
    for (const role of ["owner", "admin", "agent"] as const) {
      const s = await summaryFor(role);
      const lines = text(html(createElement(KillSwitch, { freeze: s.freeze, capabilities: s.capabilities, pausedByStop: [], onChanged: noop })));
      expect(lines).toContain("Spending is on");
      const buttons = lines.filter((l) => ["Stop assistants", "Stop all spending", "Turn spending back on"].includes(l));
      expect(buttons).toEqual(role === "agent" ? [] : ["Stop assistants", "Stop all spending"]);
    }
  });

  it("stopped: the 8.1 line with who and when; only the owner can turn it back on", async () => {
    const owner = await summaryFor("owner", { freeze: "all" });
    expect(owner.freeze.text).toBe("All spending is stopped since 28 Oct, 14:05 (stopped by Priya). Ads are paused and automatic messages are on hold.");
    const ownerLines = text(html(createElement(KillSwitch, { freeze: owner.freeze, capabilities: owner.capabilities, pausedByStop: [], onChanged: noop })));
    expect(ownerLines).toContain("Turn spending back on");
    const admin = await summaryFor("admin", { freeze: "all" });
    const adminLines = text(html(createElement(KillSwitch, { freeze: admin.freeze, capabilities: admin.capabilities, pausedByStop: [], onChanged: noop })));
    expect(adminLines).not.toContain("Turn spending back on");
    expect(adminLines).toContain(OWNER_ONLY_RESUME);
  });

  it("platform freeze: the 12.1a copy (no email promised)", async () => {
    seed();
    h.db.seed("platformSetting", [{ key: "spend:platform", value: { freeze: "all", reason: "check", at: NOW.toISOString(), version: 1 } }]);
    const { resetSpendStateCache } = await import("@/lib/spend/kill");
    resetSpendStateCache();
    const s = await spendSummary(ACTORS.owner, { now: NOW, env: {} });
    resetSpendStateCache();
    expect(s.freeze.text).toBe("Edwyz has paused spending for all workspaces while we check something. Your ads are paused. We'll tell you here and on WhatsApp when it's back.");
    expect(s.freeze.text).not.toMatch(/email/i);
  });

  it("has the exact stop dialog copy, and the guarded Resume list after a stop", async () => {
    expect(STOP_ALL_DIALOG).toEqual({
      title: "Stop all spending?",
      body: "We'll pause every ad Edwyz started and hold automatic WhatsApp messages and AI replies. Messages your team types still go out. Only the owner can turn spending back on.",
      confirmLabel: "Stop all spending",
    });
    const c = await caps("owner");
    const rows = [
      { campaignId: "c1", name: "Diwali leads", adAccountName: "Edwyz Store", pausedAt: NOW.toISOString(), canResume: true, dailyBudget: { minor: "100000", currency: "INR", formatted: "₹1,000" }, confirmTotalMinor: 100_000 },
      { campaignId: "c2", name: "Winter sale", adAccountName: null, pausedAt: NOW.toISOString(), canResume: true, dailyBudget: null, confirmTotalMinor: 0 },
    ];
    const lines = text(html(createElement(KillSwitch, { freeze: { workspace: "none", platform: "none", effective: "none", since: null, byKind: null, byName: null, reason: null, text: "Spending is on" }, capabilities: c, pausedByStop: rows, onChanged: noop })));
    expect(lines).toContain("Paused by the stop");
    expect(lines).toContain(RESUME_LIST_INTRO);
    expect(lines.filter((l) => l === "Resume")).toHaveLength(2);
    expect(lines).toContain("Resume all");
  });
});

// =====================================================================================================================
describe("the status strip: one announcement and the right question", () => {
  it("turning assistants back on asks about assistants; the status line is not a second live region", async () => {
    expect(dialogFor("none", "assistants")).toBe(RESUME_ASSISTANTS_DIALOG);
    expect(RESUME_ASSISTANTS_DIALOG).toMatchObject({ title: "Turn assistants back on?", confirmLabel: "Turn assistants back on" });
    expect(dialogFor("none", "all")).toBe(RESUME_DIALOG);
    expect(dialogFor("all", "none")).toBe(STOP_ALL_DIALOG);
    const s = await summaryFor("owner");
    const markup = html(createElement(KillSwitch, { freeze: s.freeze, capabilities: s.capabilities, pausedByStop: [], onChanged: noop }));
    expect((markup.match(/aria-live="polite"/g) ?? []).length).toBe(1);
    expect(markup).toMatch(/<p tabindex="-1"[^>]*data-testid="spend-status"/i);
  });

  it("'Sign in to approve' focuses the request's own heading, which can take focus when highlighted", () => {
    expect(approvalFocusTarget("sp1")).toBe("approval-sp1");
  });
});

describe("pot cards (PotCard)", () => {
  it("shows the 8.1 rows and 'Not set', never a number nobody set", async () => {
    const s = await summaryFor("owner", { phone: true });
    expect(potRows(s.pots.ads).map((r) => r.label)).toEqual(["Spent this month", "Set aside for running ads", "Left to use", "Today"]);
    expect(potRows(s.pots.ads)[3].value).toBe("₹0 spent, up to ₹0 set aside");
    expect(potRows(s.pots.messaging)).toEqual([
      { label: "Spent this month (estimate)", value: "₹0" },
      { label: "Set aside for broadcasts in progress", value: "₹0" },
      { label: "Left", value: "₹5,000" },
    ]);
    expect(potRows(s.pots.ai)).toEqual([
      { label: "Used this month", value: "0 of 500 credits" },
      { label: "Today", value: "0" },
    ]);
    const messaging = text(html(createElement(PotCard, { pot: s.pots.messaging, capabilities: s.capabilities, onSaved: noop })));
    expect(messaging).toContain("WhatsApp messages");
    expect(messaging).toContain(`${NOT_SET} (₹5,000 applies for now)`);
    expect(messaging).toContain("Estimated cost of messages Meta charges you for. Broadcasts and automatic messages that would go over are held before they start. Messages your team types always go out.");
    const ai = text(html(createElement(PotCard, { pot: s.pots.ai, capabilities: s.capabilities, onSaved: noop })));
    expect(ai).toContain("AI credits used by the AI agent, reply suggestions, Creative Studio and Eddy. When they run out, AI replies hand the chat to your team.");
    expect(ai.some((l) => /^Your plan allows up to [\d,]+ credits a month\.$/.test(l))).toBe(true);
    expect(limitLine(null, null)).toBe(NOT_SET);
  });

  it("ads card: help text with the 1.75x rule, the migrated cap and the spending ad account", async () => {
    const s = await summaryFor("owner");
    const lines = text(html(createElement(PotCard, { pot: s.pots.ads, capabilities: s.capabilities, spendingAccount: s.spendingAccount, controlVersion: 1, onSaved: noop })));
    expect(lines).toContain("Ads on Facebook and Instagram");
    expect(lines).toContain(
      "Set aside is the most your running ads could still spend. Meta can spend up to 75% more than a daily budget on a busy day, and up to 7 days of budget in a week, so we plan for that. A ₹1,750 daily limit allows ads with up to ₹1,000 a day in total budget.",
    );
    expect(lines).toContain("Your old daily cap of ₹1,000 is now a daily limit of ₹1,750, the most Meta can spend on ₹1,000 of daily budget.");
    expect(lines.join(" ")).toContain("Spending ad account: Edwyz Store (INR)");
    expect(lines).toContain("Change");
  });

  it("owner and admin edit the same text fields (an admin's most is checked on save); a team member sees text only", async () => {
    const owner = await summaryFor("owner");
    const o = html(createElement(PotCard, { pot: owner.pots.ads, capabilities: owner.capabilities, onSaved: noop }));
    expect(text(o)).toEqual(expect.arrayContaining(["Monthly limit", "Daily limit", "Save limits"]));
    expect(o).not.toMatch(/max="/);
    const admin = await summaryFor("admin");
    const a = html(createElement(PotCard, { pot: admin.pots.ads, capabilities: admin.capabilities, onSaved: noop }));
    // Text inputs carry no max: readLimitForm refuses more than today's value with the server's sentence (see below).
    expect(a).not.toMatch(/max="/);
    expect(readLimitForm({ monthly: "20,001", daily: "1750", currency: "INR" }, admin.pots.ads, "admin")).toMatchObject({ ok: false, error: { field: "monthly", message: "Only the owner can raise a limit. You can lower it. Enter ₹20,000 or less." } });
    expect(text(a)).toContain("Lower limits");
    expect(text(a)).toContain("You can lower this. Only the owner can raise it.");
    const agent = await summaryFor("agent");
    const m = html(createElement(PotCard, { pot: agent.pots.ads, capabilities: agent.capabilities, onSaved: noop }));
    expect(m).not.toContain("<input");
    expect(m).not.toContain("<button");
    // An admin cannot turn Not set into a number: the WhatsApp card has no inputs for them.
    expect(html(createElement(PotCard, { pot: admin.pots.messaging, capabilities: admin.capabilities, onSaved: noop }))).not.toContain("<input");
  });

  it("with no ad account: a currency select for the owner, and the 8.4 line", async () => {
    const s = await summaryFor("owner", { adAccount: false, allowances: [] });
    const markup = html(createElement(PotCard, { pot: s.pots.ads, capabilities: s.capabilities, onSaved: noop }));
    expect(text(markup)).toContain("No ad account connected yet. You can set your ads limits now; they apply as soon as you connect one.");
    expect(text(markup)).toContain("Not set. Ads can't start until you set a daily limit.");
    expect(text(markup)).toContain("Currency");
    for (const c of ["INR", "USD", "EUR", "GBP", "AED"]) expect(markup).toContain(`<option value="${c}"`);
  });

  it("several ad accounts and none chosen: the owner chooses, the others ask the owner", async () => {
    const owner = await summaryFor("owner", { secondAccount: true, chosen: false });
    expect(owner.pots.ads.notes).toContain("Choose which ad account Edwyz can spend from. Until you do, new ads can't start.");
    expect(text(html(createElement(PotCard, { pot: owner.pots.ads, capabilities: owner.capabilities, spendingAccount: owner.spendingAccount, onSaved: noop })))).toContain("Choose");
    const admin = await summaryFor("admin", { secondAccount: true, chosen: false });
    expect(admin.pots.ads.notes).toContain("Ask the owner to choose a spending ad account.");
    expect(text(html(createElement(PotCard, { pot: admin.pots.ads, capabilities: admin.capabilities, spendingAccount: admin.spendingAccount, onSaved: noop })))).not.toContain("Choose");
  });

  it("WhatsApp without a number: 'Connect WhatsApp to use this. You can set a limit now.'", async () => {
    const s = await summaryFor("owner", { phone: false });
    expect(text(html(createElement(PotCard, { pot: s.pots.messaging, capabilities: s.capabilities, onSaved: noop })))).toContain("Connect WhatsApp to use this. You can set a limit now.");
  });

  it("checks typed limits like the server: an admin may only lower, the daily limit fits the monthly", async () => {
    const admin = await summaryFor("admin");
    const pot = admin.pots.ads;
    expect(readLimitForm({ monthly: "20000", daily: "1500", currency: "INR" }, pot, "admin")).toMatchObject({ ok: true, body: { monthlyLimitMinor: "2000000", dailyLimitMinor: "150000", version: 2 } });
    expect(readLimitForm({ monthly: "20000", daily: "1800", currency: "INR" }, pot, "admin")).toMatchObject({ ok: false, error: { field: "daily", message: "Only the owner can raise a limit. You can lower it. Enter ₹1,750 or less." } });
    expect(readLimitForm({ monthly: "", daily: "1500", currency: "INR" }, pot, "admin")).toMatchObject({ ok: false, error: { message: "Only the owner can clear a limit." } });
    expect(readLimitForm({ monthly: "1000", daily: "1500", currency: "INR" }, pot, "owner")).toMatchObject({ ok: false, error: { message: "The daily limit can't be more than the monthly limit." } });
    expect(readLimitForm({ monthly: "", daily: "", currency: "INR" }, pot, "owner")).toMatchObject({ ok: true, body: { monthlyLimitMinor: null, dailyLimitMinor: null } });
    expect(readLimitForm({ monthly: "12.345", daily: "", currency: "INR" }, pot, "owner")).toMatchObject({ ok: false, error: { message: "Use at most 2 decimal places." } });
    expect(toMajorInput({ minor: "150050", currency: "INR", formatted: "" })).toBe("1500.5");
    expect(toMajorInput({ minor: "200000", currency: "INR", formatted: "" })).toBe("2000");
  });

  it("money fields are text inputs with a decimal keypad, so '20,000' is read as 20,000 in every browser, never as Not set", async () => {
    const owner = await summaryFor("owner");
    const markup = html(createElement(PotCard, { pot: owner.pots.ads, capabilities: owner.capabilities, onSaved: noop }));
    expect(markup).not.toContain('type="number"');
    expect((markup.match(/<input[^>]*inputMode="decimal"/gi) ?? []).length + (markup.match(/<input[^>]*inputmode="decimal"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(readLimitForm({ monthly: "20,000", daily: "₹1,500", currency: "INR" }, owner.pots.ads, "owner")).toMatchObject({ ok: true, body: { monthlyLimitMinor: "2000000", dailyLimitMinor: "150000" } });
    const assistants = html(createElement(AssistantsCard, { assistants: owner.assistants, assistantSpendEnabled: true, capabilities: owner.capabilities, currency: "INR", onChanged: noop }));
    expect(assistants).not.toContain('type="number"');
  });
});

// =====================================================================================================================
describe("Spending limit on Meta (MetaLimitCard)", () => {
  const account: AdAccountInfo = { assetId: "acc1", externalId: "act_111", name: "Edwyz Store", currency: "INR", timezone: "Asia/Kolkata", sandbox: false, active: true, demo: false };
  const enforce = { SPEND_CAP_MODE: "enforce" };
  const verified = { mode: "managed", unitMode: "major_write", managedCapMinor: 2_000_000n, lastReadCapMinor: 2_500_000n, lastReadAmountSpentMinor: 1_820_000n, lastWriteAt: new Date(NOW.getTime() - 3_600_000), lastReadAt: new Date(NOW.getTime() - 60_000), lastError: null };
  const view = (row: Row | null, o: Partial<{ role: "owner" | "admin" | "agent"; account: AdAccountInfo; env: Record<string, string>; monthly: bigint | null; state: "active" | "locked" }> = {}) =>
    metaLimitView({ account: o.account ?? account, row, role: o.role ?? "owner", workspaceState: o.state ?? "active", monthlyLimitMinor: o.monthly === undefined ? 2_000_000n : o.monthly, now: NOW, env: o.env ?? enforce });

  it("has every 8.1 state line", () => {
    const cases: [MetaLimitState, string, ReturnType<typeof view>][] = [
      ["managed", "Managed by Edwyz. Meta will stop this account after ₹6,800 more this month.", view(verified)],
      ["off", "Off. Turn on Meta's limit for extra safety.", view(null)],
      ["pending_owner", "Waiting for the owner to turn this on.", view({ mode: "pending_owner" })],
      ["unavailable_prepaid", "Not available: this ad account uses prepaid funds. Your Edwyz limits still apply.", view({ mode: "unavailable_prepaid" })],
      ["no_permission", "You need to be an admin of this ad account in Meta to turn this on.", view({ mode: "no_permission" })],
      ["other_workspace", "Another Edwyz workspace already manages Meta's spending limit on this ad account. Your Edwyz limits still apply here.", view({ mode: "other_workspace" })],
      ["ready", "Ready. Meta's limit will be switched on after our final check.", view(verified, { env: { SPEND_CAP_MODE: "observe" } })],
      ["demo", "Demo account: Meta's limit isn't used.", view(null, { account: { ...account, demo: true } })],
      ["deferred", "Meta's limit will update later today. Your Edwyz limits still apply now.", view({ ...verified, deferredUntil: new Date(NOW.getTime() + 3_600_000), pendingTargetMinor: 1_000n })],
      ["loose", "Meta's limit is a little above your limit because some charges are still pending.", view({ ...verified, loosenessMinor: 5_000n })],
      ["sandbox", "Test account: Meta's limit isn't used.", view(null, { account: { ...account, sandbox: true } })],
      ["needs_monthly_limit", "Set a monthly ads limit first.", view(verified, { monthly: null })],
      ["kept_while_paused", "Meta's limit is kept at last month's level while your workspace is paused.", view(verified, { state: "locked" })],
    ];
    for (const [state, line, v] of cases) {
      expect(v.state, line).toBe(state);
      expect(v.text).toBe(line);
    }
    expect(view({ mode: "no_permission" }).action).toEqual({ kind: "connect_again", label: "Connect again with an admin account" });
  });

  it("the owner turns it on through the consent dialog and off with three choices; admins see the state only", () => {
    const off = view(null);
    const owner = text(html(createElement(MetaLimitCard, { meta: off, capabilities: { canManageMetaLimit: true } as SpendCapabilities, onChanged: noop })));
    expect(owner).toContain("Spending limit on Meta");
    expect(owner).toContain(META_EXPLAINER);
    expect(owner).toContain("Turn on Meta's limit");
    const admin = text(html(createElement(MetaLimitCard, { meta: view(null, { role: "admin" }), capabilities: { canManageMetaLimit: false } as SpendCapabilities, onChanged: noop })));
    expect(admin).not.toContain("Turn on Meta's limit");
    expect(text(html(createElement(MetaConsentText)))).toEqual([
      "Meta will stop every ad on this account, including ads you make yourself in Meta Ads Manager, once it has spent your monthly ads limit.",
      "Edwyz updates this limit for you, at most a few times a day. A change can take a few hours to reach Meta.",
      "If you press Stop all spending and an ad can't be paused, we set the limit so the account stops.",
      "You can turn this off here at any time, or remove the limit in Meta Ads Manager > Billing > Payment settings.",
    ]);
    expect(META_CONSENT.title).toBe("Let Edwyz manage the spending limit on this ad account");
    expect(META_CONSENT.checkbox).toBe("I'm the owner of this workspace and I agree.");
    const managed = view({ ...verified, customerCapAtConsentMinor: 5_000_000n });
    expect(managed.offboardChoices).toEqual(["keep", "restore", "remove"]);
    expect(managed.offboardChoices.map((c) => offboardLabel(c, managed))).toEqual(["Keep the current limit on Meta", "Put back my old limit (₹50,000)", "Remove the limit"]);
    expect(text(html(createElement(MetaLimitCard, { meta: managed, capabilities: { canManageMetaLimit: true } as SpendCapabilities, onChanged: noop })))).toContain("Turn off");
  });
});

// =====================================================================================================================
describe("Meta's limit: a refusal is shown inside the open dialog", () => {
  it("renders as an alert, so it is seen and read out over the modal; nothing when there is no error", () => {
    const markup = html(createElement(DialogError, { message: "Your subscription is inactive." }));
    expect(markup).toContain('role="alert"');
    expect(text(markup)).toContain("Your subscription is inactive.");
    expect(html(createElement(DialogError, { message: null }))).toBe("");
  });
});

describe("assistants (AssistantsCard)", () => {
  it("has the three 8.1 level texts and says assistants only suggest while the flag is off", async () => {
    const s = await summaryFor("owner", { mandate: { level: 1, enabled: true, version: 1, shadowUntil: new Date("2026-11-11T06:00:00Z"), currency: "INR" } });
    const a = s.assistants.find((x) => x.assistantKey === "ads_optimizer")!;
    expect([0, 1, 2].map((l) => levelSentence(a, l))).toEqual([
      "Suggest only: it suggests changes. Nothing happens until someone approves.",
      "Small changes: it can pause ads, lower budgets and stop broadcasts at any time, and raise a budget by up to 20% a day within your limits.",
      "Autopilot: it can start campaigns within your limits. Anything over a quarter of your monthly limit needs your approval.",
    ]);
    expect(a.shadow.text).toBe("Learning: suggests only until 11 Nov. So far it would have made no changes.");
    expect(a.mandate?.effectiveLevel).toBe(0);
    const markup = html(createElement(AssistantsCard, { assistants: s.assistants, assistantSpendEnabled: s.assistantSpendEnabled, capabilities: s.capabilities, currency: "INR", onChanged: noop }));
    const lines = text(markup);
    expect(lines).toContain(SUGGEST_ONLY_FOR_NOW);
    expect(lines).toContain("Learning");
    expect(lines).toEqual(expect.arrayContaining(["Target cost per lead", "Most it can spend per day", "Most it can spend per month"]));
    expect((markup.match(/<option/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("the owner switches an assistant on or off with its own switch; saving other settings never switches it on", async () => {
    const s = await summaryFor("owner", { mandate: { level: 0, enabled: false, version: 1 } });
    const markup = html(createElement(AssistantsCard, { assistants: s.assistants.filter((a) => a.assistantKey === "ads_optimizer"), assistantSpendEnabled: true, capabilities: s.capabilities, currency: "INR", onChanged: noop }));
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="false"');
    expect(text(markup)).toContain(ASSISTANT_ON_LABEL);
    // A save sends `enabled` only when the switch changed it.
    expect(enabledPatch(false, false)).toEqual({});
    expect(enabledPatch(true, true)).toEqual({});
    expect(enabledPatch(false, true)).toEqual({ enabled: true });
    expect(enabledPatch(true, false)).toEqual({ enabled: false });
  });

  it("an admin can only lower the level; a team member reads", async () => {
    const admin = await summaryFor("admin", { mandate: { level: 1, enabled: true, version: 1 } });
    const markup = html(createElement(AssistantsCard, { assistants: admin.assistants.filter((a) => a.assistantKey === "ads_optimizer"), assistantSpendEnabled: true, capabilities: admin.capabilities, currency: "INR", onChanged: noop }));
    expect(markup).toContain('<option value="0"');
    expect(markup).toContain('<option value="1"');
    expect(markup).not.toContain('<option value="2"');
    const agent = await summaryFor("agent", { mandate: { level: 1, enabled: true, version: 1 } });
    const m = html(createElement(AssistantsCard, { assistants: agent.assistants, assistantSpendEnabled: true, capabilities: agent.capabilities, currency: "INR", onChanged: noop }));
    expect(m).not.toContain("<select");
    expect(text(m)).toContain("Small changes: it can pause ads, lower budgets and stop broadcasts at any time, and raise a budget by up to 20% a day within your limits.");
  });
});

// =====================================================================================================================
describe("approvals (ApprovalsCard, ApprovalReview)", () => {
  it("shows the request in the 8.1 words with one-tap buttons for an approver", async () => {
    const s = await summaryFor("admin", { approval: APPROVAL });
    expect(s.role).toBe("admin");
    const approvals = s.role === "admin" ? s.approvals : [];
    const lines = text(html(createElement(ApprovalsCard, { approvals, capabilities: s.capabilities, controlSettings: s.role === "admin" ? s.controlSettings : undefined, admins: [], onChanged: noop })));
    expect(lines).toContain("Waiting for you");
    expect(lines).toEqual(
      expect.arrayContaining([
        "Raise the daily budget of 'Diwali leads - Delhi' from ₹800 to ₹1,000",
        "Could add up to ₹4,550 this month (worst case)",
        "Why: cost per lead is ₹62, well below your ₹100 target",
        "Declined automatically in 11 hours",
        "Approve",
        "Decline",
      ]),
    );
    expect(s.approvalsWaiting).toBe(1);
  });

  it("a non-approver admin sees 'Only the owner can approve spending'; the owner gets the approver and expiry settings", async () => {
    const admin = await summaryFor("admin", { approval: APPROVAL, approverIsAdmin: false });
    const list = admin.role === "admin" ? admin.approvals : [];
    const lines = text(html(createElement(ApprovalsCard, { approvals: list, capabilities: admin.capabilities, admins: [], onChanged: noop })));
    expect(lines).toContain(ONLY_OWNER_APPROVES);
    expect(lines).not.toContain("Approve");
    expect(lines).toContain("Decline");
    const owner = await summaryFor("owner", { approval: APPROVAL });
    const o = owner.role === "owner" ? owner : null;
    const ownerLines = text(html(createElement(ApprovalsCard, { approvals: o!.approvals, capabilities: owner.capabilities, controlSettings: o!.controlSettings, admins: o!.admins, onChanged: noop })));
    expect(ownerLines).toEqual(expect.arrayContaining(["Who can approve spending", "Requests expire after", "Ravi", "Save approval settings"]));
  });

  it("the one-tap link: declining works logged out, approving goes through sign-in; an expired request says so", () => {
    const pending: ApprovalDTO = {
      id: "sp1",
      assistantKey: "ads_optimizer",
      assistantLabel: "Ad assistant",
      pot: "ads",
      actionKind: "raise_budget",
      direction: "raise",
      summary: "Raise the daily budget of 'Diwali leads - Delhi' from ₹800 to ₹1,000",
      reason: "Why: cost per lead is ₹62, well below your ₹100 target",
      forecastToday: null,
      forecastMonth: { minor: "455000", currency: "INR", formatted: "₹4,550" },
      forecastText: "Could add up to ₹4,550 this month (worst case)",
      status: "pending",
      createdAt: NOW.toISOString(),
      expiresAt: NOW.toISOString(),
      expiryText: "Declined automatically in 11 hours",
      decidedAt: null,
      decidedByName: null,
      decidedVia: null,
      failureReason: null,
      canApprove: false,
      canDecline: true,
    };
    const logged = html(createElement(ApprovalReview, { approval: pending, mode: "link", token: "t".repeat(43), signedIn: false, loginHref: "/login?next=%2Fapp%2Fsettings%2Fspending%3Fapproval%3Dsp1" }));
    expect(text(logged)).toEqual(expect.arrayContaining([SIGN_IN_TO_APPROVE, "Decline", "Could add up to ₹4,550 this month (worst case)"]));
    expect(logged).toContain('href="/login?next=%2Fapp%2Fsettings%2Fspending%3Fapproval%3Dsp1"');
    expect(text(logged)).not.toContain(ONLY_OWNER_APPROVES);
    const signedApprover = text(html(createElement(ApprovalReview, { approval: { ...pending, canApprove: true }, mode: "link", token: "t".repeat(43), signedIn: true })));
    expect(signedApprover).toEqual(expect.arrayContaining(["Approve", "Decline"]));
    const expired = { ...pending, status: "expired" as const, expiryText: "Declined automatically (no answer in 12 hours).", canDecline: false };
    const lines = text(html(createElement(ApprovalReview, { approval: expired, mode: "link", signedIn: false })));
    expect(lines).toContain("Declined automatically (no answer in 12 hours).");
    expect(lines).not.toContain("Decline");
    expect(decidedText({ ...pending, status: "declined", decidedByName: "Priya" })).toBe("Declined by Priya. Nothing was changed.");
  });
});

// =====================================================================================================================
describe("WhatsApp alerts (NotifyCard)", () => {
  it("has the 8.1 copy, the consent checkbox and the pending text; email alerts are off and it says so", async () => {
    const s = await summaryFor("owner");
    const notify = s.role === "owner" ? s.notify : null;
    const markup = html(createElement(NotifyCard, { notify: notify!, capabilities: s.capabilities, controlVersion: 1, onChanged: noop }));
    const lines = text(markup);
    expect(lines).toEqual(expect.arrayContaining([NOTIFY_TITLE, "Your WhatsApp number", NOTIFY_CONSENT, NOTIFY_BUTTON, DIGEST_LABEL]));
    expect(NOTIFY_TITLE).toBe("Get approvals, safety alerts and a daily summary on WhatsApp");
    expect(lines).toContain("Email alerts are off for now, so alerts come here in the app and on WhatsApp.");
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(pendingText("+1 711-268-5789")).toBe("We sent a message from Edwyz (+1 711-268-5789). Tap 'Yes, send me alerts' to finish.");
    expect(channelText({ ...notify!, own: { id: "ch", userId: "u_owner", phone: "+919876543210", status: "pending", optInAt: null, verifiedAt: null, optOutAt: null, lastSentAt: null, senderDisplay: "+1 711-268-5789" } })).toBe(pendingText("+1 711-268-5789"));
    expect(phoneProblem("98765")).toBe("Enter a number with country code, like +91 98765 43210.");
    expect(phoneProblem("+91 98765 43210")).toBeNull();
  });

  it("a pending or verified number can be stopped here, without going to WhatsApp", async () => {
    const s = await summaryFor("owner");
    const notify = s.role === "owner" ? s.notify : null;
    const own = { id: "ch", userId: "u_owner", phone: "+919876543210", status: "verified" as const, optInAt: null, verifiedAt: null, optOutAt: null, lastSentAt: null, senderDisplay: "+1 711-268-5789" };
    expect(text(html(createElement(NotifyCard, { notify: { ...notify!, own }, capabilities: s.capabilities, controlVersion: 1, onChanged: noop })))).toContain(STOP_ALERTS_BUTTON);
    expect(text(html(createElement(NotifyCard, { notify: { ...notify!, own: { ...own, status: "opted_out" } }, capabilities: s.capabilities, controlVersion: 1, onChanged: noop })))).not.toContain(STOP_ALERTS_BUTTON);
    expect(text(html(createElement(NotifyCard, { notify: { ...notify!, own: null }, capabilities: s.capabilities, controlVersion: 1, onChanged: noop })))).not.toContain(STOP_ALERTS_BUTTON);
    expect([canStopAlerts("verified"), canStopAlerts("pending"), canStopAlerts("opted_out"), canStopAlerts(null)]).toEqual([true, true, false, false]);
  });

  it("a non-approver admin has no number field and no summary switch; the owner has both", async () => {
    const admin = await summaryFor("admin", { approverIsAdmin: false });
    const markup = html(createElement(NotifyCard, { notify: admin.role === "admin" ? admin.notify : (null as never), capabilities: admin.capabilities, controlVersion: 1, onChanged: noop }));
    expect(markup).not.toContain('type="tel"');
    expect(markup).not.toContain('role="switch"');
    expect(text(markup)).toContain("The owner and the people they name as approvers get these alerts.");
  });
});

// =====================================================================================================================
describe("activity (ActivityTable)", () => {
  const row = (o: Partial<LedgerRowDTO> = {}): LedgerRowDTO => ({
    id: "l1",
    seq: "10",
    createdAt: NOW.toISOString(),
    pot: "ads",
    action: "ads.adset.budget_raise",
    phase: "applied",
    actor: { type: "user", id: "u_owner", label: "Priya", viaEddy: false },
    assistantKey: null,
    autonomyLevel: null,
    targetType: "adset",
    targetId: "s1",
    metaObjectId: "m1",
    summary: "Raised daily budget ₹800 -> ₹1,000",
    amount: null,
    forecastToday: { minor: "35000", currency: "INR", formatted: "₹350" },
    forecastMonth: { minor: "455000", currency: "INR", formatted: "₹4,550" },
    reason: "Cost per lead is low",
    reasonCodes: [],
    approvalId: null,
    correlationId: "c1",
    observe: false,
    sandbox: false,
    undo: { available: true, isRaise: false, until: NOW.toISOString() },
    ...o,
  });

  it("has the columns, filters, CSV export, the Yesterday strip and Undo per row", () => {
    const markup = html(
      createElement(ActivityTableView, {
        rows: [row(), row({ id: "l2", undo: { available: false, isRaise: true, until: null }, observe: true, phase: "refused", summary: "Turned on 'Winter sale'" })],
        timezone: "Asia/Kolkata",
        filter: "all",
        onFilter: noop,
        yesterday: "Ads spent ₹850. 3 new leads.",
        onUndo: noop,
        canExport: true,
      }),
    );
    const lines = text(markup);
    expect(lines).toEqual(expect.arrayContaining(["When", "Who", "What", "Could add (worst case)", "Why", "Undo", "All", "Ads", "WhatsApp", "AI", "Assistants", "Safety stops", "Export CSV", "Yesterday", "Ads spent ₹850. 3 new leads."]));
    expect(lines).toContain("28 Oct, 12:00");
    expect(lines).toContain("₹4,550 this month");
    expect(lines).toContain("Would have been refused");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('href="/api/spend/ledger?format=csv"');
    expect((markup.match(/aria-label="Undo: /g) ?? []).length).toBe(1);
    expect(csvHref("whatsapp")).toBe("/api/spend/ledger?format=csv&filter=whatsapp");
    expect(couldAddText(row({ forecastMonth: null }))).toBe("₹350 today");
    expect(resultBadge(row({ phase: "failed" }))).toEqual({ label: "Failed", tone: "bad" });
  });

  it("is not shown to a team member", async () => {
    const s = await summaryFor("agent");
    expect(html(createElement(ActivityTable, { capabilities: s.capabilities, yesterday: null }))).toBe("");
    expect(text(page(s))).not.toContain("Activity");
  });
});

// =====================================================================================================================
describe("the 8.1 role table, row by row", () => {
  it("holds for the owner, an admin (approver or not) and a team member", async () => {
    const rowsOf = async (role: Role, o: Seed = {}) => {
      const s = await summaryFor(role, { approval: APPROVAL, mandate: { level: 1, enabled: true, version: 1 }, meta: { mode: "off" }, freeze: "all", ...o });
      const markup = page(s);
      return { s, markup, lines: text(markup) };
    };
    const owner = await rowsOf("owner");
    const admin = await rowsOf("admin");
    const nonApprover = await rowsOf("admin", { approverIsAdmin: false });
    const agent = await rowsOf("agent");
    // See the page: status, three pots, limits, Meta limit state, assistants and levels, new-workspace note.
    for (const r of [owner, admin, agent]) {
      expect(r.lines).toEqual(expect.arrayContaining(["Spending status", "Ads on Facebook and Instagram", "WhatsApp messages", "AI usage", "Spending limit on Meta", "Assistants", "New-workspace limits"]));
    }
    // Activity table and CSV export: owner and admin.
    expect(owner.lines).toContain("Activity");
    expect(admin.lines).toContain("Activity");
    expect(agent.lines).not.toContain("Activity");
    // Lower a limit: owner and admin; raise or set: owner only (no max on the owner's inputs).
    expect(owner.lines).toContain("Save limits");
    expect(admin.lines).toContain("Lower limits");
    expect(agent.markup).not.toContain('placeholder="Not set"');
    // Stop spending: owner and admin. Turn back on: owner.
    expect(owner.s.capabilities.canStopSpending && admin.s.capabilities.canStopSpending && !agent.s.capabilities.canStopSpending).toBe(true);
    expect(owner.lines).toContain("Turn spending back on");
    expect(admin.lines).not.toContain("Turn spending back on");
    // Choose the spending ad account and Meta's limit consent: owner.
    expect(owner.lines).toContain("Change");
    expect(owner.lines).toContain("Turn on Meta's limit");
    expect(admin.lines).not.toContain("Turn on Meta's limit");
    // Assistant levels: owner raises (all levels), admin lowers (levels up to the current one), team member reads.
    expect(owner.markup).toContain('<option value="2"');
    expect(admin.markup).not.toContain('<option value="2"');
    expect(agent.markup).not.toContain("Lower assistant");
    // Approve raises: owner, or an admin named as an approver. Decline: owner and admin.
    expect(owner.lines).toContain("Approve");
    expect(admin.lines).toContain("Approve");
    expect(nonApprover.lines).not.toContain("Approve");
    expect(nonApprover.lines).toContain(ONLY_OWNER_APPROVES);
    expect(agent.lines).not.toContain("Decline");
    // Approvers, expiry, time zone, target cost per lead, safety-stop toggle: owner.
    expect(owner.lines).toEqual(expect.arrayContaining(["Who can approve spending", "More settings", "Let safety stops pause campaigns my team made"]));
    expect(admin.lines).not.toContain("Who can approve spending");
    expect(admin.lines).not.toContain("More settings");
    // Own WhatsApp alerts number: owner and approver admins.
    expect(owner.markup).toContain('type="tel"');
    expect(admin.markup).toContain('type="tel"');
    expect(nonApprover.markup).not.toContain('type="tel"');
    expect(agent.markup).not.toContain('type="tel"');
    // Undo: undoing a raise for owner and admin, undoing a lowering for the owner.
    expect([owner.s.capabilities.canUndoRaises, admin.s.capabilities.canUndoRaises, agent.s.capabilities.canUndoRaises]).toEqual([true, true, false]);
    expect([owner.s.capabilities.canUndoLowerings, admin.s.capabilities.canUndoLowerings, agent.s.capabilities.canUndoLowerings]).toEqual([true, false, false]);
  }, 60_000);
});

// =====================================================================================================================
describe("the spending banner (8.2)", () => {
  const b = (kind: (typeof BANNER_ORDER)[number], extra: Partial<{ dismissible: boolean; dismissKey: string }> = {}) => ({ kind, text: kind, link: "/app/settings/spending", dismissible: false, tone: "info" as const, ...extra });

  it("shows the highest priority banner, in the 8.2 order including items 7 and 8", () => {
    expect(BANNER_ORDER).toEqual(["platform_frozen", "workspace_stopped", "limit_reached", "approvals_waiting", "meta_limit_attention", "new_workspace", "choose_spending_account", "meta_limit_waiting_owner"]);
    const shuffled = [b("meta_limit_waiting_owner"), b("choose_spending_account"), b("approvals_waiting"), b("workspace_stopped")];
    expect(pickBanner(shuffled, () => false)?.kind).toBe("workspace_stopped");
    expect(pickBanner([b("meta_limit_waiting_owner"), b("choose_spending_account")], () => false)?.kind).toBe("choose_spending_account");
    const built = buildBanners({ tenantId: T, role: "owner", freeze: { workspace: "none", platform: "none" }, limitReached: { adsMonth: false, adsToday: true, messaging: true, ai: false }, approvals: { waiting: 1, canDecide: true }, metaState: "no_permission", newWorkspace: true, needsAccountChoice: false });
    expect(built.map((x) => x.text)).toEqual([
      "Ads are paused: today's ads limit is used up.",
      "Automatic WhatsApp messages are on hold: this month's WhatsApp limit is used up.",
      "1 spending request is waiting",
      "Meta's spending limit needs attention: You need to be an admin of this ad account in Meta to turn this on.",
      "Your workspace is new, so lower spending limits apply for now. They go up after your first two payments.",
    ]);
  });

  it("remembers a dismissed new-workspace banner in localStorage, inside try/catch", () => {
    const nw = b("new_workspace", { dismissible: true, dismissKey: "wa-spend-new-workspace:t1" });
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(pickBanner([nw, b("choose_spending_account")], (k) => isDismissed(k, storage))?.kind).toBe("new_workspace");
    rememberDismissal(nw.dismissKey, storage);
    expect(pickBanner([nw, b("choose_spending_account")], (k) => isDismissed(k, storage))?.kind).toBe("choose_spending_account");
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => rememberDismissal("k", broken)).not.toThrow();
    expect(isDismissed("k", broken)).toBe(false);
    // A banner that is not dismissible can never be hidden.
    expect(pickBanner([b("workspace_stopped", { dismissKey: "x" })], () => true)?.kind).toBe("workspace_stopped");
  });

  it("renders as an alert when spending is stopped, with a link to the page and Dismiss only when allowed", () => {
    const stopped = html(createElement(SpendBannerBar, { banner: { ...b("workspace_stopped"), tone: "danger", text: "All spending is stopped." } }));
    expect(stopped).toContain('role="alert"');
    expect(stopped).toContain('href="/app/settings/spending"');
    expect(text(stopped)).not.toContain("Dismiss");
    const nw = html(createElement(SpendBannerBar, { banner: b("new_workspace", { dismissible: true, dismissKey: "k" }), onDismiss: noop }));
    expect(nw).toContain('role="status"');
    expect(text(nw)).toContain("Dismiss");
    expect(nw).not.toMatch(/\bdark:|#[0-9a-f]{6}/i);
  });
});

describe("wiring", () => {
  it("mounts the spending banner in the AppShell banner slot for every member, and the page at Settings > Spending limits", () => {
    const layout = readFileSync("src/app/(app)/app/layout.tsx", "utf8");
    expect(layout).toContain('import { SpendBanner } from "@/components/spend/SpendBanner"');
    const slot = layout.slice(layout.indexOf("banner={"));
    expect(slot).toContain("<SpendBanner />");
    expect(slot.indexOf("<SpendBanner />")).toBeLessThan(slot.indexOf('actor.role !== "agent"'));
    const pageSource = readFileSync("src/app/(app)/app/settings/spending/page.tsx", "utf8");
    expect(pageSource).toContain("<SpendingSettings />");
    expect(readFileSync("src/components/spend/SpendBanner.tsx", "utf8")).toContain('fetch("/api/spend/summary?view=banner"');
    const link = readFileSync("src/app/s/[token]/page.tsx", "utf8");
    expect(link).toContain("loadApprovalByToken(token, actor)");
    expect(link).toContain('mode="link"');
    expect(link).toContain("robots: { index: false, follow: false, nocache: true }");
    // A busy shared network gets its own sentence, never "This link doesn't work".
    expect(link).toContain("if (!viewLimiter.consume(ip)) return <TooManyTries />;");
    expect(link).toContain("Too many tries from this network");
    expect(link).toContain("Wait a few minutes and open it again, or open Settings &gt; Spending limits in Edwyz");
  });
});
