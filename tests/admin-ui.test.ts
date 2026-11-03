import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
// Only the audit-label and confirmation checks import server modules, for their constants; nothing reaches a database.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { AdminShell, Pager } from "@/components/admin/AdminShell";
import { CeilingsForm } from "@/components/admin/CeilingsForm";
import { ceilingFieldErrors, PlanCeilingFields } from "@/components/admin/PlanForm";
import { PlatformSpendSwitch, SWITCH_COPY, switchActions } from "@/components/admin/PlatformSpendSwitch";
import { asOfLabel, SpendingTable } from "@/components/admin/SpendingTable";
import { ActionFields } from "@/components/admin/ActionForm";
import { AuditTable } from "@/components/admin/AdminTables";
import { bindingText, ceilingFields, lowerAssistantFields, lowerLimitFields, TenantSpendCard } from "@/components/admin/TenantSpendCard";
import {
  actionMode,
  attentionItems,
  auditActionLabel,
  cellText,
  confirmationMatches,
  emptySpending,
  emptyTenants,
  emptyUsers,
  hasAuditLabel,
  humanize,
  inrText,
  metaLimitTone,
  moneyText,
  newWorkspaceLimitsInfo,
  onboardingInfo,
  paymentEventLabel,
  planCodeFrom,
  paymentEventStatus,
  QUEUED_WARN_AFTER_MS,
  qualityInfo,
  SPENDING_FILTER_LABELS,
  spendingFilterLabel,
  spendStateInfo,
  START_SPENDING_PHRASE,
  STOP_SPENDING_PHRASE,
  tenantFilterLabel,
  testFailureBody,
  testMessageOutcome,
  tierLabel,
  validateFeatures,
  validateLimit,
  validateMoneyText,
  validatePlanCode,
  validatePrice,
  when,
} from "@/components/admin/helpers";
import { ADMIN_SPEND_AUDIT_ACTIONS, SPENDING_FILTERS, type SpendSettingsView, type TenantSpendingView } from "@/lib/admin/spending";
import { PLATFORM_RESUME_CONFIRM, PLATFORM_STOP_CONFIRM } from "@/lib/spend/kill";
import type { AdminSpendRowDTO } from "@/lib/spend/types";

describe("typed confirmation", () => {
  it("passes only on the exact text, ignoring outer spaces", () => {
    expect(confirmationMatches("", "Acme Shop")).toBe(false);
    expect(confirmationMatches("acme shop", "Acme Shop")).toBe(false);
    expect(confirmationMatches("  Acme Shop ", "Acme Shop")).toBe(true);
    expect(confirmationMatches("", undefined)).toBe(true);
  });
  it("asks a simple question when an action needs no input, and a form otherwise", () => {
    expect(actionMode({ fieldCount: 0, needsReason: false })).toBe("confirm");
    expect(actionMode({ fieldCount: 0, needsReason: false, confirmText: "x" })).toBe("form");
    expect(actionMode({ fieldCount: 1, needsReason: false })).toBe("form");
    expect(actionMode({ fieldCount: 0, needsReason: true })).toBe("form");
  });
});

describe("plain wording for operators", () => {
  it("never shows raw enum values", () => {
    expect(onboardingInfo("in_progress")).toEqual({ label: "Setting up", tone: "info" });
    expect(onboardingInfo("live").label).toBe("Connected");
    expect(onboardingInfo("failed").tone).toBe("bad");
    expect(onboardingInfo("mystery_state").label).toBe("Mystery state");
    expect(qualityInfo("GREEN")).toEqual({ label: "High quality", tone: "good" });
    expect(qualityInfo("RED").tone).toBe("bad");
    expect(qualityInfo(null).label).toBe("Not rated yet");
    expect(tierLabel("TIER_1K")).toBe("1,000 customers a day");
    expect(tierLabel(null)).toBe("Not set yet");
    expect(tierLabel("TIER_UNLIMITED")).toBe("No daily limit");
  });
  it("labels audit actions and payment events", () => {
    expect(auditActionLabel("admin.tenant.suspend")).toBe("Suspended a workspace");
    expect(auditActionLabel("ads.campaign.launch_started")).toBe("Ads campaign launch started");
    expect(paymentEventLabel("subscription.charged")).toBe("Subscription payment taken");
    expect(paymentEventLabel("refund.processed")).toBe("Refund processed");
    expect(paymentEventStatus("error")).toEqual({ label: "Needs attention", tone: "bad" });
    expect(paymentEventStatus("processed").tone).toBe("good");
    expect(paymentEventStatus("pending").tone).toBe("warn");
    expect(humanize("")).toBe("Unknown");
  });
  it("formats time and money the same way everywhere", () => {
    expect(when("2026-10-27T04:30:59Z")).toBe("2026-10-27 04:30 UTC");
    expect(when(null)).toBe("-");
    expect(inrText(99900)).toBe("INR 999");
    expect(inrText(99950)).toBe("INR 999.50");
  });
});

describe("test message outcome wording", () => {
  it("says what WhatsApp confirmed, and only treats delivered, read and failed as final", () => {
    expect(testMessageOutcome("sent", null)).toMatchObject({ tone: "info", title: "WhatsApp accepted the message", body: "Delivery is confirmed by a status update, usually within seconds.", final: false });
    expect(testMessageOutcome("delivered", null)).toMatchObject({ tone: "good", title: "Delivered to the phone", final: true });
    expect(testMessageOutcome("read", null)).toMatchObject({ tone: "good", title: "Delivered and read", final: true });
    const failed = testMessageOutcome("failed", "131047");
    expect(failed).toMatchObject({ tone: "bad", title: "Not delivered", final: true });
    expect(failed.body).toMatch(/24-hour window/);
  });

  it("stays calm about a queued send for the first seconds and only then points at the worker", () => {
    expect(testMessageOutcome("queued", null)).toMatchObject({ tone: "info", title: "Queued for sending", final: false });
    expect(testMessageOutcome("queued", null, { elapsedMs: 2000 }).tone).toBe("info");
    expect(testMessageOutcome("queued", null, { elapsedMs: QUEUED_WARN_AFTER_MS - 1 }).body).not.toMatch(/background jobs/);
    const late = testMessageOutcome("queued", null, { elapsedMs: QUEUED_WARN_AFTER_MS });
    expect(late).toMatchObject({ tone: "warn", title: "Still waiting for the worker to send it", final: false });
    expect(late.body).toMatch(/background jobs counters/);
  });

  it("never blames WhatsApp for a refusal made on this side, and names an unknown code instead of a dead end", () => {
    const optedOut = testMessageOutcome("failed", "opted_out");
    expect(optedOut.title).toBe("Not delivered");
    expect(optedOut.body).toMatch(/STOP/);
    expect(testMessageOutcome("failed", "tenant_blocked").body).toMatch(/suspended or read-only/);
    expect(testFailureBody("999999")).toBe("WhatsApp returned error code 999999, which we do not have an explanation for yet. Copy the details below and share them with support.");
    expect(testFailureBody(null)).toMatch(/gave no error code/);
    expect(testFailureBody("131047")).toMatch(/24-hour window/);
    expect(testMessageOutcome("failed", "999999").body).toBe(testFailureBody("999999"));
    // The server's sentence wins when it is sent, so the panel and the copied details never disagree.
    expect(testMessageOutcome("failed", "131047", { hint: "Server says so." }).body).toBe("Server says so.");
    expect(testMessageOutcome("failed", "131047", { hint: null }).body).toMatch(/24-hour window/);
  });
});

describe("workspace search wording", () => {
  it("says what was searched or filtered", () => {
    expect(tenantFilterLabel("trial")).toBe("On a free trial");
    expect(tenantFilterLabel("unknown")).toBe("All active workspaces");
    expect(emptyTenants("", "all").title).toBe("No workspaces yet");
    expect(emptyTenants("priya", "all").title).toBe('No workspaces match "priya"');
    expect(emptyTenants("", "suspended").title).toBe("No workspaces are suspended");
    expect(emptyTenants("priya", "trial").body).toContain("On a free trial");
    expect(emptyUsers("a@b.com").title).toContain("a@b.com");
    expect(emptyUsers("").title).toBe("No users yet");
  });
});

describe("overview attention list", () => {
  const healthy = { tenantsByState: { active: 4 }, quality: [{ rating: "GREEN", count: 3 }], jobs: { queued: 2 }, failedEvents: [] };
  it("is empty when everything is healthy", () => {
    expect(attentionItems(healthy)).toEqual([]);
  });
  it("lists problems, most urgent first, with counts in words", () => {
    const items = attentionItems({
      tenantsByState: { past_due_grace: 1, locked: 2 },
      quality: [{ rating: "RED", count: 1 }],
      jobs: { failed: 3 },
      failedEvents: [{ id: "a" }],
    });
    expect(items.map((i) => i.id)).toEqual(["jobs", "quality", "events", "pastdue", "locked"]);
    expect(items[0]).toMatchObject({ tone: "bad", title: "3 background jobs have failed" });
    expect(items[1].title).toBe("1 phone number has low quality");
    expect(items[2].title).toBe("1 recent webhook event failed");
    expect(items[3].href).toBe("/admin/payments");
    expect(items[4].title).toBe("2 workspaces are read-only");
  });
});

describe("plan form checks", () => {
  it("matches the server rules", () => {
    expect(validatePrice("999")).toBeNull();
    expect(validatePrice("999.50")).toBeNull();
    expect(validatePrice("999.555")).toMatch(/rupees/);
    expect(validatePrice("")).toMatch(/rupees/);
    expect(validatePlanCode("starter")).toBeNull();
    expect(validatePlanCode("Starter")).toBeNull();
    expect(validatePlanCode("a")).toMatch(/lowercase/);
    expect(validatePlanCode("has space")).toMatch(/lowercase/);
    expect(validateFeatures("")).toBeNull();
    expect(validateFeatures('{"api": true}')).toBeNull();
    expect(validateFeatures("[1]")).toMatch(/object/);
    expect(validateFeatures("{oops")).toMatch(/not valid JSON/);
    expect(validateLimit("")).toBeNull();
    expect(validateLimit("25")).toBeNull();
    expect(validateLimit("0")).toMatch(/1 or more/);
    expect(validateLimit("1.5")).toMatch(/whole number/);
  });
});

describe("admin shell", () => {
  it("has a skip link, labelled navigation, the current page marked and a main landmark", () => {
    const html = renderToStaticMarkup(createElement(AdminShell, { email: "a@edwyz.com", current: "/admin/plans", children: createElement("p", null, "body") }));
    expect(html).toContain('href="#admin-main"');
    expect(html).toContain('<main id="admin-main"');
    expect(html).toContain('aria-label="Admin sections"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*>Plans</);
    expect(html).toContain("Security");
    expect(html).not.toMatch(/text-white|bg-white/);
  });
  it("paginates with labelled links and a summary", () => {
    const html = renderToStaticMarkup(createElement(Pager, { base: "/admin/users?q=a", page: 2, total: 120, size: 25 }));
    expect(html).toContain("Showing 26 to 50 of 120 (page 2 of 5)");
    expect(html).toContain("Previous page");
    expect(html).toContain("Next page");
    expect(html).toContain("/admin/users?q=a&amp;page=3");
    const empty = renderToStaticMarkup(createElement(Pager, { base: "/admin/users", page: 1, total: 0, size: 25 }));
    expect(empty).toContain("Nothing to show");
    expect(empty).not.toContain("Next page");
  });
});

// =====================================================================================================================
// Spending (docs/SPEND-CONTROLS-SPEC.md 8.3)
// =====================================================================================================================

const m = (minor: number, currency = "INR", formatted = currency === "CRD" ? `${minor} credits` : `₹${(minor / 100).toLocaleString("en-IN")}`) => ({ minor: String(minor), currency, formatted });
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
const BANNED = /minor units|spend_cap|allowance pot|commitment|probation/i;

function row(o: Partial<AdminSpendRowDTO> = {}): AdminSpendRowDTO {
  return {
    tenantId: "t1",
    name: "Acme",
    slug: "acme",
    plan: "Pro",
    demo: false,
    newWorkspaceLimits: "on",
    adsToday: { spent: m(10_000), setAside: m(20_000), limit: m(200_000) },
    adsMonth: { spent: m(100_000), setAside: m(50_000), limit: null },
    whatsappMonth: { spent: m(1_000), setAside: m(0), limit: m(500_000) },
    aiMonth: { used: m(20, "CRD"), limit: m(500, "CRD") },
    metaLimit: { state: "pending_owner", label: "Waiting for owner" },
    breakersOpen: 1,
    requestsWaiting: 2,
    state: "assistants_stopped",
    riskPct: 85,
    asOf: "2026-10-28T06:25:00.000Z",
    noAdAccount: false,
    noWhatsApp: false,
    ...o,
  };
}

describe("admin spending wording", () => {
  it("labels every audit action the spending pages write", () => {
    const missing = ADMIN_SPEND_AUDIT_ACTIONS.filter((a) => !hasAuditLabel(a));
    expect(missing).toEqual([]);
    for (const a of ADMIN_SPEND_AUDIT_ACTIONS) expect(auditActionLabel(a), a).not.toMatch(BANNED);
    expect(auditActionLabel("admin.spend.stop_all")).toBe("Stopped all spending for every workspace");
    expect(auditActionLabel("admin.tenant.set_spend_ceiling")).toBe("Set a spending override for a workspace");
  });
  it("uses the kill switch's own typed confirmations", () => {
    expect(STOP_SPENDING_PHRASE).toBe(PLATFORM_STOP_CONFIRM);
    expect(START_SPENDING_PHRASE).toBe(PLATFORM_RESUME_CONFIRM);
  });
  it("has a label for every filter, in plain words", () => {
    expect(Object.keys(SPENDING_FILTER_LABELS).sort()).toEqual([...SPENDING_FILTERS].sort());
    expect(spendingFilterLabel("near_limit")).toBe("Near a limit (80% or more)");
    expect(spendingFilterLabel("nope")).toBe("All workspaces");
    expect(emptySpending("", "stopped").title).toBe("No workspaces: stopped");
    expect(emptySpending("acme", "all").title).toBe('No workspaces match "acme"');
  });
  it("never shows a missing limit as zero", () => {
    expect(moneyText(null)).toBe("Not set");
    expect(cellText({ spent: m(100), setAside: m(0), limit: null })).toBe("₹1 / ₹0 / Not set");
    expect(cellText(null)).toBe("No spending ad account");
  });
  it("names states and tones", () => {
    expect(spendStateInfo("stopped")).toEqual({ label: "Stopped", tone: "bad" });
    expect(spendStateInfo("assistants_stopped").label).toBe("Assistants stopped");
    expect(spendStateInfo("on").label).toBe("On");
    expect(newWorkspaceLimitsInfo("forced").label).toBe("Forced");
    expect(newWorkspaceLimitsInfo("lifted").label).toBe("Lifted");
    expect(metaLimitTone("error")).toBe("bad");
    expect(metaLimitTone("managed")).toBe("good");
    expect(metaLimitTone("pending_owner")).toBe("warn");
    expect(bindingText("probation")).toBe("Set by the new-workspace limits");
    expect(asOfLabel(null, "2026-10-28T07:00:00Z")).toBe("Not checked yet");
    expect(asOfLabel("2026-10-28T06:25:00Z", "2026-10-28T07:00:00Z")).toBe("as of 06:25 UTC");
    expect(asOfLabel("2026-10-27T06:25:00Z", "2026-10-28T07:00:00Z")).toBe("as of 2026-10-27 06:25 UTC");
  });
  it("checks typed amounts like the server", () => {
    expect(validateMoneyText("2,000")).toBeNull();
    expect(validateMoneyText("2000.50")).toBeNull();
    expect(validateMoneyText("")).toBeNull();
    expect(validateMoneyText("two")).toMatch(/numbers only/);
    expect(validateMoneyText("1.5", { wholeOnly: true })).toMatch(/whole number/);
  });
});

describe("admin spending components", () => {
  it("AdminShell lists Spending right after Rate card", () => {
    const out = html(createElement(AdminShell, { email: "a@edwyz.com", current: "/admin/spending", children: createElement("p", null, "x") }));
    const labels = [...out.matchAll(/<a[^>]*href="\/admin[^"]*"[^>]*>([^<]+)<\/a>/g)].map((x) => x[1]);
    expect(labels.indexOf("Spending")).toBe(labels.indexOf("Rate card") + 1);
    expect(out).toMatch(/aria-current="page"[^>]*>Spending</);
  });

  it("the table has every 8.3 column and says what each cell is, with Demo, Not set and Not checked yet", () => {
    const out = html(createElement(SpendingTable, { rows: [row(), row({ tenantId: "t3", name: "Demo shop", demo: true, riskPct: null, asOf: null, adsToday: null, adsMonth: null })], q: "", filter: "all", nowIso: "2026-10-28T07:00:00Z" }));
    for (const header of ["Workspace", "Plan", "New-workspace limits", "Ads today (spent / set aside / limit)", "Ads this month (spent / set aside / limit)", "WhatsApp this month (spent / set aside / limit)", "AI credits this month", "Meta limit", "Safety stops open", "Requests waiting", "State"]) {
      expect(out, header).toContain(`>${header}<`);
    }
    expect(out).toContain('href="/admin/tenants/t1"');
    expect(out).toContain(">Demo<");
    expect(out).toContain("Not checked yet");
    expect(out).toContain("as of 06:25 UTC");
    expect(out).toContain("₹1,000 / ₹500 / Not set");
    expect(out).toContain("No spending ad account");
    expect(out).toContain("Waiting for owner");
    expect(out).toContain("Assistants stopped");
    expect(out).toContain("Highest use 85%");
    expect(out).not.toMatch(BANNED);
    const empty = html(createElement(SpendingTable, { rows: [], q: "", filter: "safety_stop", nowIso: "2026-10-28T07:00:00Z" }));
    expect(empty).toContain("No workspaces: safety stop open");
  });

  it("the platform switch offers the right buttons for each state and announces changes", () => {
    expect(switchActions("none")).toEqual(["stop_assistants", "stop_all"]);
    expect(switchActions("assistants")).toEqual(["stop_all", "resume"]);
    expect(switchActions("all")).toEqual(["resume"]);
    expect(SWITCH_COPY.stop_all.body).toBe("Pauses every ad Edwyz runs on every workspace and holds automatic messages. Lowering is always allowed; nothing can be raised until you turn this off.");
    expect(SWITCH_COPY.resume.phrase).toBe("START SPENDING");
    const on = html(createElement(PlatformSpendSwitch, { freeze: "none", text: "Spending is on for all workspaces", progressText: null, stepUpFresh: false }));
    expect(on).toContain("Spending is on for all workspaces");
    expect(on).toContain(">Stop assistants everywhere<");
    expect(on).toContain(">Stop all spending everywhere<");
    expect(on).toContain('aria-live="polite"');
    const off = html(createElement(PlatformSpendSwitch, { freeze: "all", text: "Stopped since 2026-10-28 06:30 UTC by boss@edwyz.com: Meta outage", progressText: "Still pausing ads in 3 workspaces. The background stop works through them every minute.", stepUpFresh: true }));
    expect(off).toContain("Stopped since 2026-10-28 06:30 UTC by boss@edwyz.com: Meta outage");
    expect(off).toContain(">Turn spending back on<");
    expect(off).not.toContain(">Stop all spending everywhere<");
    expect(off).toContain("Still pausing ads in 3 workspaces.");
  });

  const view = (o: Partial<TenantSpendingView> = {}): TenantSpendingView => ({
    tenantId: "t1",
    name: "Acme",
    status: "active",
    deleted: false,
    demo: false,
    generatedAt: "2026-10-28T06:30:00.000Z",
    pots: [
      {
        pot: "ads",
        title: "Ads on Facebook and Instagram",
        currency: "INR",
        status: "ok",
        today: { spent: m(0), setAside: m(0), limit: m(200_000) },
        month: { spent: m(0), setAside: m(0), limit: m(2_000_000) },
        ownerDaily: null,
        ownerMonthly: null,
        ceilingDaily: m(200_000),
        ceilingMonthly: m(2_000_000),
        ceilingSource: "probation",
        ceilingUnknown: false,
        binding: "probation",
        planCapMonthly: null,
        notes: ["Not set. Ads can't start until you set a daily limit."],
      },
    ],
    liveError: null,
    freeze: { workspace: "none", platform: "none", effective: "none", since: null, byKind: null, byName: null, reason: null, text: "Spending is on." },
    probation: { on: true, setting: "auto", why: "Your workspace is new, so lower limits apply for now.", paidInvoices: 0, verifiedAt: null, ceilings: [], note: null },
    probationSetting: "auto",
    verifiedAt: null,
    timezones: null,
    metaLimit: null,
    breakers: [
      { id: "sb1", kind: "pacing", label: "Safety stop: spending too fast", scopeType: "campaign", scopeId: "c1", scopeName: "Diwali leads", state: "tripped", effect: "pause_scope", reason: "Spent half the day's budget by 9:00", trippedAt: "2026-10-28T03:30:00.000Z", clearedAt: null, autoClearAt: null, canClear: false, clearIsRaise: true },
    ],
    assistants: [
      {
        assistantKey: "ads_optimizer",
        label: "Ad assistant",
        pots: ["ads"],
        phase: "live",
        mandate: null,
        shadow: { learning: false, until: null, text: null, wouldHaveMade: 0, cuts: 0, raises: 0, raisesWorthUpTo: null, wouldExceedAllowance: 0, agreedPct: null },
        levelOptions: [],
        canRaise: false,
        canLower: false,
      },
    ],
    assistantSpendEnabled: false,
    approvalsWaiting: 0,
    adAccounts: [{ assetId: "acc1", name: "Acme ads", externalId: "act_111", currency: "INR", sandbox: false, demo: false, spending: true }],
    overrides: [{ id: "c1", scope: "tenant", pot: "ai", currency: "CRD", daily: null, monthly: m(2000, "CRD"), expiresAt: null, reason: "Top-up", updatedAt: null }],
    offboard: [],
    ledger: [
      {
        id: "l1",
        seq: "5",
        createdAt: "2026-10-28T06:00:00.000Z",
        pot: "ads",
        action: "ceiling.change",
        phase: "applied",
        actor: { type: "platform_admin", id: null, label: "Edwyz support", viaEddy: false },
        assistantKey: null,
        autonomyLevel: null,
        targetType: "ceiling",
        targetId: "tenant:t1",
        metaObjectId: null,
        summary: "Changed the AI ceiling",
        amount: null,
        forecastToday: null,
        forecastMonth: null,
        reason: "Top-up",
        reasonCodes: [],
        approvalId: null,
        correlationId: "c",
        observe: false,
        sandbox: false,
        undo: { available: false, isRaise: false, until: null },
      },
    ],
    ...o,
  });

  it("the tenant Spending card shows live figures and every action, each with a reason form", () => {
    const out = html(createElement(TenantSpendCard, { view: view(), endpoint: "/api/admin/spending/t1" }));
    expect(out).toContain('id="spending-heading"');
    expect(out).toContain("Ads on Facebook and Instagram");
    expect(out).toContain("Not set a day, Not set a month");
    expect(out).toContain("Set by the new-workspace limits");
    expect(out).toContain("no ceiling a day, 2000 credits a month");
    for (const label of ["Override ceiling", "Lower the owner&#x27;s limits", "Stop spending", "Lift new-workspace limits", "Set new-workspace limits", "Mark workspace verified", "Clear safety stop", "Lower an assistant", "Mark as test ad account", "Remove override"]) {
      expect(out, label).toContain(`>${label}<`);
    }
    expect(out).toContain("to make the cut stick, also set an override ceiling.");
    expect(out).toContain("Safety stop: spending too fast");
    expect(out).toContain("Changed the AI ceiling");
    expect(out).toContain("by Edwyz support");
    expect(out).toContain("Assistants only make suggestions for now");
    expect(out).not.toContain("End learning early");
    expect(out).not.toMatch(BANNED);
  });

  it("fields whose hint says 'leave empty' really can be sent empty; the rest stay required", () => {
    /** name -> whether the rendered control carries `required`. */
    const required = (fields: Parameters<typeof ActionFields>[0]["fields"]) => {
      const out = html(createElement(ActionFields, { fields }));
      return Object.fromEntries([...out.matchAll(/<(input|select)\b[^>]*>/g)].map((m) => [/name="([^"]+)"/.exec(m[0])![1], /\srequired=""/.test(m[0])]));
    };
    expect(required(ceilingFields())).toEqual({ pot: true, currency: true, daily: false, monthly: false, endDate: false });
    expect(required(lowerLimitFields())).toEqual({ pot: true, daily: false, monthly: false });
    expect(required(lowerAssistantFields([{ assistantKey: "ads_optimizer", label: "Ad assistant" }]))).toEqual({ assistantKey: true, level: false, maxDaily: false, maxMonthly: false });
    // Optional fields are marked once, by the field itself, not in the label text.
    const out = html(createElement(ActionFields, { fields: ceilingFields() }));
    expect(out).toContain("(optional)");
    expect(out).not.toContain("Ends after (optional)");
    for (const f of [...ceilingFields(), ...lowerLimitFields(), ...lowerAssistantFields([])]) {
      if (/leave empty/i.test(f.hint ?? "")) expect(f.optional, f.name).toBe(true);
    }
  });

  it("the card says when live figures could not be read, offers Turn back on while stopped, and End learning only when it can work", () => {
    const base = view();
    const stopped = view({
      pots: null,
      liveError: "Live figures could not be read right now. The list on the Spending page shows the last saved figures.",
      freeze: { workspace: "all", platform: "none", effective: "all", since: null, byKind: "platform_admin", byName: "Edwyz support", reason: "Fraud", text: "Stopped by Edwyz support: Fraud" },
      assistantSpendEnabled: true,
      assistants: [
        {
          ...base.assistants[0],
          mandate: { assistantKey: "ads_optimizer", enabled: true, level: 1, effectiveLevel: 0, allowedOps: [], maxDaily: null, maxMonthly: null, currency: "INR", targetCostPerLead: null, raiseStepPct: 20, approvalSharePct: 25, shadowStartedAt: "2026-10-27T00:00:00.000Z", shadowUntil: "2026-11-10T00:00:00.000Z", sandboxOnly: false, version: 1, updatedAt: null },
        },
      ],
    });
    const out = html(createElement(TenantSpendCard, { view: stopped, endpoint: "/api/admin/spending/t1" }));
    expect(out).toContain("Live figures could not be read right now.");
    expect(out).toContain(">Turn spending back on<");
    expect(out).not.toContain(">Stop spending<");
    expect(out).toContain(">End learning early<");
    expect(out).toContain("works at 0 for now");
  });

  const settings = (o: Partial<SpendSettingsView> = {}): SpendSettingsView => ({
    newWorkspace: [
      { pot: "ads", currency: "INR", daily: m(200_000), monthly: m(2_000_000), dailyText: "₹2,000", monthlyText: "₹20,000", set: true, note: null, updatedAt: null, reason: "seed" },
      { pot: "ads", currency: "USD", daily: null, monthly: null, dailyText: "Not set", monthlyText: "Not set", set: false, note: "No USD row and no fresh exchange rate: workspaces in USD can't raise spending.", updatedAt: null, reason: null },
    ],
    platform: [],
    fx: { maxAgeDays: 35, rates: [{ currency: "USD", rate: "84.10", updatedAt: "2026-09-01T00:00:00.000Z", fresh: false, status: "Out of date" }] },
    notifier: { settings: null, workspaceName: null, candidates: [] },
    defaults: { approvalTtlHours: 12, metaCapRoutinePerDay: 6, metaCapEmergencyReserve: 4, metaCapRaisesPerDay: 2, shadowDays: 14, updatedAt: null, byUserId: null },
    ...o,
  });

  it("the settings page shows new-workspace limits with Not set rows, rates marked Out of date, the sender and the defaults", () => {
    const out = html(createElement(CeilingsForm, { view: settings() }));
    for (const title of ["Limits for new workspaces", "Platform ceilings", "Exchange rates for limits", "Notification sender", "Requests and Meta&#x27;s limit"]) expect(out, title).toContain(title);
    expect(out).toContain("₹2,000 a day, ₹20,000 a month");
    expect(out).toContain("Not set a day, Not set a month");
    expect(out).toContain("Out of date");
    expect(out).toContain("1 USD = 84.10 INR");
    expect(out).toContain("No sender is set up, so owners get spending alerts in the app only.");
    expect(out).toContain("12 hours. A request nobody answers is declined automatically.");
    expect(out).toContain("6 routine, 4 kept for emergencies, at most 2 raises.");
    expect(out).not.toMatch(BANNED);
  });

  it("the plan form's ceiling fields: INR first, another currency, WhatsApp per month and AI credits per day", () => {
    const out = html(createElement(PlanCeilingFields, { ceilings: { ads: [{ currency: "INR", daily: "2000", monthly: "20000" }, { currency: "USD", daily: "25", monthly: "" }], whatsappMonthly: "5000", aiDaily: "" }, errors: {} }));
    expect(out).toContain("Spending ceilings for this plan");
    expect(out.indexOf("Ads ceiling per day (INR)")).toBeLessThan(out.indexOf("Ads ceiling per day (USD)"));
    expect(out).toContain('name="adsCeiling_INR_daily"');
    expect(out).toContain('value="2000"');
    expect(out).toContain('name="whatsappCeiling_INR_monthly"');
    expect(out).toContain('name="aiCeiling_daily"');
    expect(out).toContain('<option value="EUR">EUR</option>');
    expect(out).not.toContain('<option value="USD">USD</option>');
    expect(ceilingFieldErrors({ adsCeiling_INR_daily: "abc", aiCeiling_daily: "1.5", adsCeilingNew_daily: "10" })).toMatchObject({
      adsCeiling_INR_daily: expect.stringMatching(/numbers only/),
      aiCeiling_daily: expect.stringMatching(/whole number/),
      adsCeilingNew_currency: "Choose the currency of this row.",
    });
    expect(ceilingFieldErrors({ adsCeiling_INR_daily: "2,000", whatsappCeiling_INR_monthly: "" })).toEqual({});
  });

  it("uses theme tokens only, and no fixed widths wider than a phone, in every new spending component", () => {
    const dir = path.resolve(__dirname, "../src/components/admin");
    for (const file of ["SpendingTable.tsx", "TenantSpendCard.tsx", "PlatformSpendSwitch.tsx", "CeilingsForm.tsx", "PlanForm.tsx"]) {
      const src = readFileSync(path.join(dir, file), "utf8");
      expect(src, file).not.toMatch(/\bdark:/);
      expect(src, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, file).not.toMatch(/\b(text|bg|border)-(white|black|gray|slate|red|green|blue|amber|yellow)\b/);
      expect(src, file).not.toMatch(/\bmin-w-\[\d{3,}/);
      expect(src, file).not.toMatch(/\bw-\[\d{3,}px\]/);
    }
  });
});

describe("planCodeFrom (QA 2026-10-30: the required plan code was hidden under Advanced options)", () => {
  it("makes a valid code from the plan name", () => {
    expect(planCodeFrom("Growth Plus")).toBe("growth-plus");
    expect(planCodeFrom("  Starter (monthly) ")).toBe("starter-monthly");
    expect(planCodeFrom("Pro 2026")).toBe("pro-2026");
    expect(validatePlanCode(planCodeFrom("Growth Plus"))).toBeNull();
    expect(planCodeFrom("A".repeat(60)).length).toBe(40);
  });

  it("gives nothing when the name has too few usable characters", () => {
    expect(planCodeFrom("")).toBe("");
    expect(planCodeFrom("x")).toBe("");
    expect(planCodeFrom("₹₹₹")).toBe("");
  });
});

describe("audit log readability (QA 2026-10-30: only ids and machine names)", () => {
  it("labels the workspace actions an admin sees most in plain words", () => {
    expect(auditActionLabel("auth.login")).toBe("Signed in");
    expect(auditActionLabel("export.contact")).toBe("Downloaded contacts");
    expect(auditActionLabel("ai_agent.create")).toBe("Created an AI agent");
    expect(auditActionLabel("meta_connect.connected")).toBe("Connected Facebook");
  });

  it("shows the workspace name and the person's email, keeping the ids as titles and links", () => {
    const out = html(
      createElement(AuditTable, {
        rows: [
          { id: "a1", at: "2026-10-30T05:40:00Z", action: "auth.login", tenantId: "t1", tenantName: "edwyz-test", userId: "u1", userEmail: "boss@x.com", target: null, meta: "" },
          { id: "a2", at: "2026-10-30T05:41:00Z", action: "admin.view", tenantId: null, userId: "u9", userEmail: null, target: null, meta: "" },
        ],
      }),
    );
    expect(out).toContain('href="/admin/tenants/t1"');
    expect(out).toContain(">edwyz-test<");
    expect(out).toContain('title="t1"');
    expect(out).toContain('href="/admin/audit?userId=u1"');
    expect(out).toContain(">boss@x.com<");
    // A deleted user has no email: the id still shows and still filters.
    expect(out).toContain('href="/admin/audit?userId=u9"');
    expect(out).toContain(">u9<");
    expect(out).toContain(">Signed in<");
  });
});
