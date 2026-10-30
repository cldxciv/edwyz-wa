import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

/**
 * Owner notifications (docs/SPEND-CONTROLS-SPEC.md 7.4, 3.5, 4.16; WP-15 acceptance 1-4, 6-8), through the real notifier,
 * owner channels, inbound handler, Phase 0 approvals and ledger on the in-memory spend database. Only the inbox send path is
 * a stand-in (it records the template and writes the Message the real one would), so nothing reaches Meta.
 */

process.env.SESSION_SECRET = "s".repeat(40);
process.env.EMAIL_VERIFICATION_REQUIRED = "false";
process.env.SITE_URL = "https://wa.test";
process.env.SPEND_NOTIFY_SECRET = "n".repeat(40);
process.env.PLATFORM_ADMIN_EMAILS = "ops@edwyz.com";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  ids: 0,
  sends: [] as Row[],
  texts: [] as Row[],
}));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb, FAKE_SPEND_MODELS } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  const spend = new Set(FAKE_SPEND_MODELS);
  // The base fake assigns no ids on create; Postgres does, so this view adds one.
  const prisma = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      const target = (h.db.prisma as Record<string, unknown>)[prop];
      if (typeof prop !== "string" || spend.has(prop) || prop.startsWith("$") || !target || typeof target !== "object") return target;
      const d = target as Record<string, (...a: unknown[]) => Promise<unknown>>;
      return { ...d, create: async (args: { data: Row; select?: Row }) => d.create({ ...args, data: { id: `${prop}_${++h.ids}`, createdAt: new Date(), ...args.data } }) };
    },
  });
  return { prisma };
});

/** The inbox send path, as the notifier uses it: records the call and writes the conversation and Message the real one would. */
vi.mock("@/lib/inbox/service", () => {
  const ensureConversation = (tenantId: string, phoneNumberId: string, contactId: string) => {
    const rows = h.db.rows("conversation");
    let c = rows.find((r) => r.tenantId === tenantId && r.phoneNumberId === phoneNumberId && r.contactId === contactId);
    if (!c) {
      c = { id: `cv_${++h.ids}`, tenantId, phoneNumberId, contactId, createdAt: new Date() };
      rows.push(c);
    }
    return c;
  };
  const message = (tenantId: string, conversationId: string, body: string, source: string | undefined, origin: string, templateName: string | null = null) => {
    const m = { id: `msg_${++h.ids}`, tenantId, conversationId, direction: "outbound", origin, body, templateName, statusTimeline: [{ status: "queued", ...(source ? { source } : {}) }], createdAt: new Date() };
    h.db.rows("message").push(m);
    return m;
  };
  return {
    sendTemplateMessage: vi.fn(async (input: Row) => {
      h.sends.push(input);
      const c = input.conversationId ? { id: input.conversationId as string } : ensureConversation(String(input.tenantId), String(input.phoneNumberId), String(input.contactId));
      return message(String(input.tenantId), String(c.id), `[template] ${String(input.templateName)}`, input.source as string | undefined, String(input.origin), String(input.templateName));
    }),
    sendText: vi.fn(async (input: Row) => {
      h.texts.push(input);
      return message(String(input.tenantId), String(input.conversationId), String(input.body), input.source as string | undefined, String(input.origin));
    }),
  };
});

import { DELETE, GET, POST } from "@/app/api/spend/notify/route";
import { signAccessToken } from "@/lib/auth/tokens";
import { hashApprovalToken } from "@/lib/spend/approval-token";
import { resetSpendStateCache } from "@/lib/spend/kill";
import { alertSlots, createPlatformNotifier, deliverInApp, whatsappPlan } from "@/lib/spend/notify";
import { handleOwnerKeyword, handleOwnerReply } from "@/lib/spend/notify/inbound";
import {
  OPTIN_SUBJECT,
  consentSha256,
  maskPhone,
  optIn,
  pruneChannels,
  resetOptInLimits,
  recipientsFor,
  replyHmac,
  replyPayload,
  verifyReplyPayload,
} from "@/lib/spend/notify/owner-channel";
import {
  DIGEST_CUTOFF,
  OPTIN_TIER_CAP,
  TIER_LIMIT,
  ensureNotifierContact,
  logNotifierProblems,
  notifierHealth,
  notifierSubjectOf,
  parseNotifierConfig,
  resetNotifierState,
  sendNotifierTemplate,
  tierAllows,
} from "@/lib/spend/notify/platform-sender";
import { NOTIFY_TEMPLATES, OWNER_WHATSAPP_CONSENT_TEXT, OWNER_WHATSAPP_CONSENT_VERSION, cleanParam, renderTemplate, templateComponents } from "@/lib/spend/notify/templates";
import type { SpendNotice } from "@/lib/spend/types";

const N = "t_notifier";
const T = "t1";
const T2 = "t2";
const PHONE = "+919876543210";
const WA = "919876543210";
const OWNER = { userId: "u_owner", tenantId: T, role: "owner" as const };
const APPROVER = { userId: "u_admin", tenantId: T, role: "admin" as const };
const ADMIN = { userId: "u_admin2", tenantId: T, role: "admin" as const };
const AGENT = { userId: "u_agent", tenantId: T, role: "agent" as const };
const ORIGIN = "https://wa.test";
const rows = (name: string) => h.db.rows(name);
const channel = (userId: string, tenantId = T) => rows("ownerNotifyChannel").find((r) => r.userId === userId && r.tenantId === tenantId)!;
let clock = Date.now();
const nextHour = () => new Date((clock += 2 * 3_600_000));

function seed() {
  h.db.seed("tenant", [
    { id: N, name: "Edwyz alerts", status: "active", deletedAt: null, billingExempt: true },
    { id: T, name: "Sharma Sweets", status: "active", deletedAt: null, billingExempt: false },
    { id: T2, name: "Second Shop", status: "active", deletedAt: null, billingExempt: false },
  ]);
  h.db.seed("membership", [
    { id: "m1", tenantId: T, userId: OWNER.userId, role: "owner" },
    { id: "m2", tenantId: T, userId: APPROVER.userId, role: "admin" },
    { id: "m3", tenantId: T, userId: ADMIN.userId, role: "admin" },
    { id: "m4", tenantId: T, userId: AGENT.userId, role: "agent" },
    { id: "m5", tenantId: T2, userId: OWNER.userId, role: "owner" },
    { id: "m6", tenantId: N, userId: "u_ops", role: "owner", user: { email: "ops@edwyz.com" } },
  ]);
  h.db.seed("spendControl", [
    { tenantId: T, approverUserIds: [APPROVER.userId], timezone: "Asia/Kolkata", digestEnabled: true },
    { tenantId: T2, approverUserIds: [], timezone: "Asia/Kolkata", digestEnabled: true },
  ]);
  h.db.seed("platformSetting", [{ key: "spend:notify", value: { tenantId: N, phoneNumberId: "pn_n", language: "en", senderDisplay: "+1 711-268-5789" } }]);
  h.db.seed("phoneNumber", [{ id: "pn_n", tenantId: N, wabaRefId: "w_n", phoneNumberId: "meta_pn", displayPhone: "+1 711-268-5789", qualityRating: "GREEN", status: "CONNECTED" }]);
  h.db.seed(
    "template",
    Object.values(NOTIFY_TEMPLATES).map((t) => ({ id: `tp_${t.key}`, tenantId: N, wabaRefId: "w_n", name: t.name, language: "en", category: "UTILITY", status: "approved" })),
  );
}

/** The owner as a notifier contact with a chat, as after a first message from the notifier number. */
function notifierChat(phone = PHONE) {
  const id = `nc_${phone.slice(-4)}`;
  if (!rows("contact").some((c) => c.id === id)) {
    h.db.seed("contact", [{ id, tenantId: N, phone, optIn: true, tags: ["owner_spend_alerts"] }]);
    h.db.seed("conversation", [{ id: `ncv_${phone.slice(-4)}`, tenantId: N, contactId: id, phoneNumberId: "pn_n" }]);
  }
}

/** A verified channel, as after opt-in and "Yes". */
function verifiedChannel(userId: string, tenantId = T, phone = PHONE) {
  h.db.seed("ownerNotifyChannel", [{ id: `ch_${userId}_${tenantId}`, tenantId, userId, phoneE164: phone, optInAt: new Date(), optInTextVersion: OWNER_WHATSAPP_CONSENT_VERSION, verifiedAt: new Date(), optOutAt: null, notifierContactId: null, lastSentAt: null }]);
  return `ch_${userId}_${tenantId}`;
}

function approval(over: Row = {}) {
  const row = {
    id: "ap1",
    tenantId: T,
    assistantKey: "ads_optimizer",
    pot: "ads",
    actionKind: "raise_budget",
    direction: "raise",
    intent: {},
    fingerprint: "f",
    summary: "Raise the daily budget of 'Diwali leads' from ₹800 to ₹1,000",
    reason: "Why: cost per lead is ₹62, well below your ₹100 target",
    forecastTodayMinor: 35_000n,
    forecastMonthMinor: 455_000n,
    currency: "INR",
    status: "pending",
    tokenHash: "old-hash",
    expiresAt: new Date(Date.now() + 12 * 3_600_000),
    correlationId: "sc_ap1",
    proposalId: null,
    createdAt: new Date(),
    ...over,
  };
  h.db.seed("spendApproval", [row]);
  return row;
}

const approvalNotice = (over: Partial<SpendNotice> = {}): SpendNotice => ({
  tenantId: T,
  kind: "approval_waiting",
  severity: "action_needed",
  audience: "approvers",
  dedupeKey: "spend-approval:ap1",
  title: "1 spending request is waiting",
  body: "Raise the daily budget. Approve or decline it in Settings > Spending limits.",
  link: "/app/settings/spending",
  approvalId: "ap1",
  subjectType: "spend_approval",
  subjectId: "ap1",
  ...over,
});

beforeAll(() => {
  const membership = h.db.prisma.membership as unknown as Row;
  membership.findUnique = async ({ where }: Row) => {
    const key = (where as Row).tenantId_userId as Row;
    const m = rows("membership").find((r) => r.tenantId === key.tenantId && r.userId === key.userId);
    return m ? { ...m, user: { disabledAt: null, emailVerifiedAt: new Date("2026-01-01") }, tenant: { deletedAt: null } } : null;
  };
});

beforeEach(async () => {
  h.db.reset();
  h.sends.length = 0;
  h.texts.length = 0;
  resetNotifierState();
  await resetOptInLimits();
  resetSpendStateCache();
  seed();
});

// =====================================================================================================================
describe("the four templates (7.4, 9.3; acceptance 8)", () => {
  it("are UTILITY, in English, with the spec's bodies and buttons word for word", () => {
    expect(NOTIFY_TEMPLATES.approval.body).toBe("{{1}} asks to {{2}} in {{3}}. It could add up to {{4}} this month. Reason: {{5}}. If nobody answers by {{6}}, it is declined.");
    expect(NOTIFY_TEMPLATES.alert.body).toBe("Spending update for {{1}}: {{2}} was paused because {{3}}. Nothing else changed. Review it in Edwyz.");
    expect(NOTIFY_TEMPLATES.digest.body).toBe(
      "Daily update for {{1}} on {{2}}: ads spent {{3}}, {{4}} new leads, {{5}} per lead. WhatsApp messages about {{6}}. Automatic changes: {{7}}. Requests waiting for you: {{8}}. Left this month for ads: {{9}}.",
    );
    expect(NOTIFY_TEMPLATES.optin.body).toBe("You asked to get spending approvals and alerts for {{1}} on WhatsApp. Tap Yes to confirm.");
    expect(NOTIFY_TEMPLATES.approval.buttons).toEqual([
      { type: "URL", text: "Review", url: "https://wa.edwyz.com/s/{{1}}", dynamic: true },
      { type: "QUICK_REPLY", text: "Decline" },
    ]);
    expect(NOTIFY_TEMPLATES.optin.buttons.map((b) => b.text)).toEqual(["Yes, send me alerts", "No"]);
    for (const t of Object.values(NOTIFY_TEMPLATES)) {
      expect(t.category).toBe("UTILITY");
      expect(t.language).toBe("en");
      expect((t.body.match(/\{\{\d+\}\}/g) ?? []).length).toBe(t.params);
      expect(t.example).toHaveLength(t.params);
      expect(t.body).not.toMatch(/!|offer|discount|sale|free/i);
    }
    expect(OWNER_WHATSAPP_CONSENT_TEXT).toBe("I agree to get spending approvals, alerts and a daily summary from Edwyz on WhatsApp at this number. I can stop any time by replying STOP.");
  });

  it("fills body parameters on one line and builds the URL and quick-reply buttons", () => {
    expect(cleanParam("  two\nlines\t  here ")).toBe("two lines here");
    expect(cleanParam("")).toBe("-");
    expect(cleanParam("x".repeat(300), 10)).toHaveLength(10);
    expect(renderTemplate("alert", ["Sharma Sweets", "'Diwali'", "it costs too much per lead"])).toBe(
      "Spending update for Sharma Sweets: 'Diwali' was paused because it costs too much per lead. Nothing else changed. Review it in Edwyz.",
    );
    const c = templateComponents("approval", { params: ["a", "b", "c", "d", "e", "f"], urlSuffix: "TOKEN", payloads: { Decline: "spdec:ap1:0123456789abcdef" } });
    expect(c).toEqual([
      { type: "body", parameters: ["a", "b", "c", "d", "e", "f"].map((text) => ({ type: "text", text })) },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "TOKEN" }] },
      { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "spdec:ap1:0123456789abcdef" }] },
    ]);
    expect(() => templateComponents("approval", { params: ["a"] })).toThrow(/needs 6 values/);
    expect(() => templateComponents("approval", { params: ["a", "b", "c", "d", "e", "f"] })).toThrow(/link/);
  });
});

// =====================================================================================================================
describe("signed quick replies", () => {
  it("bind the HMAC to the kind, the id and the phone; anything else is ignored", () => {
    const yes = replyPayload("spopt", "ch1", WA)!;
    expect(yes).toMatch(/^spopt:ch1:[0-9a-f]{16}$/);
    expect(verifyReplyPayload(yes, WA)).toEqual({ kind: "spopt", id: "ch1" });
    expect(verifyReplyPayload(yes, "919999999999")).toBeNull();
    expect(verifyReplyPayload(yes.replace(/.$/, (c) => (c === "0" ? "1" : "0")), WA)).toBeNull();
    const no = replyPayload("spno", "ch1", WA)!;
    expect(no).toMatch(/^spopt:ch1:[0-9a-f]{16}:no$/);
    expect(verifyReplyPayload(no, WA)).toEqual({ kind: "spno", id: "ch1" });
    // The No payload's MAC is not a Yes MAC.
    expect(verifyReplyPayload(no.replace(/:no$/, ""), WA)).toBeNull();
    const dec = replyPayload("spdec", "ap1", WA)!;
    expect(verifyReplyPayload(dec, WA)).toEqual({ kind: "spdec", id: "ap1" });
    expect(verifyReplyPayload(`${dec}:no`, WA)).toBeNull();
    expect(verifyReplyPayload("spapp:ap1:0123456789abcdef", WA)).toBeNull();
    expect(verifyReplyPayload(dec, WA, { SPEND_NOTIFY_SECRET: "short" })).toBeNull();
    expect(replyHmac("spdec", "ap1", "+91 98765 43210", "k".repeat(40))).toBe(replyHmac("spdec", "ap1", WA, "k".repeat(40)));
    expect(maskPhone(PHONE)).toBe("+91 •••••• 3210");
  });
});

// =====================================================================================================================
describe("opt-in and verification (acceptance 1)", () => {
  it("stores SpendConsent and a pending channel, writes the consent ledger row and sends spend_optin_v1 with signed Yes and No", async () => {
    const dto = await optIn(OWNER, { phone: "+91 98765 43210", consent: true, textVersion: OWNER_WHATSAPP_CONSENT_VERSION }, { now: nextHour() });
    expect(dto).toMatchObject({ userId: OWNER.userId, phone: PHONE, status: "pending", senderDisplay: "+1 711-268-5789", verifiedAt: null });
    const ch = channel(OWNER.userId);
    expect(ch).toMatchObject({ phoneE164: PHONE, optInTextVersion: OWNER_WHATSAPP_CONSENT_VERSION, verifiedAt: null, optOutAt: null });
    expect(rows("spendConsent")).toEqual([
      expect.objectContaining({ tenantId: T, userId: OWNER.userId, kind: "owner_whatsapp", subjectId: ch.id, granted: true, textVersion: OWNER_WHATSAPP_CONSENT_VERSION, textSha256: createHash("sha256").update(OWNER_WHATSAPP_CONSENT_TEXT).digest("hex") }),
    ]);
    expect(consentSha256()).toBe(rows("spendConsent")[0].textSha256);
    const ledger = rows("spendLedger");
    expect(ledger).toEqual([expect.objectContaining({ tenantId: T, action: "consent.owner_whatsapp", phase: "info", actorType: "user", actorId: OWNER.userId, targetId: ch.id })]);
    expect(JSON.stringify(ledger, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("98765");
    // The owner is an opted-in notifier contact, tagged, and got the template from the notifier number.
    const contact = rows("contact").find((c) => c.tenantId === N)!;
    expect(contact).toMatchObject({ phone: PHONE, optIn: true, tags: ["owner_spend_alerts"] });
    expect(ch.notifierContactId).toBe(contact.id);
    expect(h.sends).toHaveLength(1);
    const send = h.sends[0];
    expect(send).toMatchObject({ tenantId: N, phoneNumberId: "pn_n", contactId: contact.id, templateName: "spend_optin_v1", language: "en", origin: "system_notify", source: `spend_notify:${T}` });
    const components = send.components as Row[];
    // Never the workspace's own name: whoever types the number chooses that name, not the person at the number.
    expect((components[0].parameters as Row[])[0]).toEqual({ type: "text", text: OPTIN_SUBJECT });
    expect(OPTIN_SUBJECT).toBe("your Edwyz workspace");
    const yes = ((components[1].parameters as Row[])[0] as Row).payload as string;
    const no = ((components[2].parameters as Row[])[0] as Row).payload as string;
    expect(verifyReplyPayload(yes, WA)).toEqual({ kind: "spopt", id: ch.id });
    expect(verifyReplyPayload(no, WA)).toEqual({ kind: "spno", id: ch.id });
  });

  it("'Yes' from that number verifies the channel and answers in the window; a wrong phone or HMAC changes nothing", async () => {
    await optIn(OWNER, { phone: PHONE, consent: true, textVersion: OWNER_WHATSAPP_CONSENT_VERSION }, { now: nextHour() });
    const ch = channel(OWNER.userId);
    expect(await handleOwnerReply({ tenantId: N, waId: "919999999999", payload: replyPayload("spopt", String(ch.id), "919999999999")! })).toMatchObject({ handled: false });
    expect(await handleOwnerReply({ tenantId: N, waId: WA, payload: `spopt:${ch.id}:0000000000000000` })).toMatchObject({ handled: false, reason: "bad_payload" });
    expect(await handleOwnerReply({ tenantId: T, waId: WA, payload: replyPayload("spopt", String(ch.id), WA)! })).toMatchObject({ handled: false, reason: "not_notifier" });
    expect(channel(OWNER.userId).verifiedAt).toBeNull();
    expect(await handleOwnerReply({ tenantId: N, waId: WA, payload: replyPayload("spopt", String(ch.id), WA)! })).toEqual({ handled: true, action: "opted_in" });
    expect(channel(OWNER.userId).verifiedAt).toBeInstanceOf(Date);
    expect(h.texts.at(-1)).toMatchObject({ tenantId: N, origin: "system_notify", body: "Done. Spending approvals and alerts will come to this number. Reply STOP to stop them." });
    expect(await recipientsFor(T, "owner")).toEqual([expect.objectContaining({ userId: OWNER.userId, waId: WA })]);
  });

  it("'No' turns that one channel off", async () => {
    await optIn(OWNER, { phone: PHONE, consent: true, textVersion: OWNER_WHATSAPP_CONSENT_VERSION }, { now: nextHour() });
    const ch = channel(OWNER.userId);
    expect(await handleOwnerReply({ tenantId: N, waId: WA, payload: replyPayload("spno", String(ch.id), WA)! })).toEqual({ handled: true, action: "opted_out" });
    expect(channel(OWNER.userId).optOutAt).toBeInstanceOf(Date);
  });

  it("refuses team members, admins who are not approvers, a bad number, no consent and an old consent text", async () => {
    const ok = { phone: PHONE, consent: true, textVersion: OWNER_WHATSAPP_CONSENT_VERSION };
    await expect(optIn(AGENT, ok, { now: nextHour() })).rejects.toMatchObject({ status: 403 });
    await expect(optIn(ADMIN, ok, { now: nextHour() })).rejects.toMatchObject({ status: 403, message: "Only the owner and the admins they name as approvers can get spending alerts on WhatsApp." });
    await expect(optIn(OWNER, { ...ok, phone: "98765" }, { now: nextHour() })).rejects.toMatchObject({ status: 400, message: "Enter a number with country code, like +91 98765 43210." });
    await expect(optIn(OWNER, { ...ok, consent: false }, { now: nextHour() })).rejects.toMatchObject({ status: 400 });
    await expect(optIn(OWNER, { ...ok, textVersion: "owner-whatsapp-v0" }, { now: nextHour() })).rejects.toMatchObject({ status: 409 });
    expect(rows("ownerNotifyChannel")).toEqual([]);
    expect(rows("spendConsent")).toEqual([]);
    // An approver may sign up.
    await expect(optIn(APPROVER, { ...ok, phone: "+919811111111" }, { now: nextHour() })).resolves.toMatchObject({ status: "pending" });
  });

  it("stores nothing when the sender cannot send (template paused), so no consent row is kept for a confirmation that never went", async () => {
    rows("template").find((t) => t.name === "spend_optin_v1")!.status = "paused";
    await expect(optIn(OWNER, { phone: PHONE, consent: true, textVersion: OWNER_WHATSAPP_CONSENT_VERSION }, { now: nextHour() })).rejects.toMatchObject({ status: 409 });
    expect(rows("ownerNotifyChannel")).toEqual([]);
    expect(rows("spendConsent")).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it("limits confirmations to any one number to 3 a day, from every workspace together", async () => {
    const at = nextHour();
    const ok = { phone: "+919833333333", consent: true, textVersion: OWNER_WHATSAPP_CONSENT_VERSION };
    await optIn(OWNER, ok, { now: at });
    await optIn(APPROVER, ok, { now: new Date(at.getTime() + 1) });
    await optIn({ ...OWNER, tenantId: T2 }, ok, { now: new Date(at.getTime() + 2) });
    await expect(optIn(OWNER, ok, { now: new Date(at.getTime() + 2 * 3_600_000) })).rejects.toMatchObject({ status: 429 });
    expect(h.sends).toHaveLength(3);
  });

  it("limits confirmations to 3 an hour per person", async () => {
    const at = nextHour();
    const ok = { phone: PHONE, consent: true, textVersion: OWNER_WHATSAPP_CONSENT_VERSION };
    for (let i = 0; i < 3; i++) await optIn(OWNER, ok, { now: new Date(at.getTime() + i) });
    await expect(optIn(OWNER, ok, { now: new Date(at.getTime() + 10) })).rejects.toMatchObject({ status: 429 });
    nextHour();
  });
});

// =====================================================================================================================
describe("delivery order: WhatsApp, then email (off), then in-app always (acceptance 2)", () => {
  const notifier = () => createPlatformNotifier();

  it("an approval request goes on WhatsApp to the owner and the approver with the one-tap link and a signed Decline, and in-app", async () => {
    approval();
    verifiedChannel(OWNER.userId);
    verifiedChannel(APPROVER.userId, T, "+919811111111");
    verifiedChannel(ADMIN.userId, T, "+919822222222");
    const result = await notifier().notify(approvalNotice());
    expect(result).toEqual({ delivered: ["whatsapp", "in_app"], skipped: [{ channel: "email", reason: "email_off" }], deduplicated: false });
    // The owner and the named approver, not the other admin.
    expect(h.sends.map((s) => s.templateName)).toEqual(["spend_approval_v1", "spend_approval_v1"]);
    const [first] = h.sends;
    const components = first.components as Row[];
    expect((components[0].parameters as Row[]).map((p) => p.text)).toEqual([
      "Ad assistant",
      "raise the daily budget of 'Diwali leads' from ₹800 to ₹1,000",
      "Sharma Sweets",
      "₹4,550",
      "cost per lead is ₹62, well below your ₹100 target",
      expect.stringMatching(/^\d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/),
    ]);
    const token = ((components[1].parameters as Row[])[0] as Row).text as string;
    // The link works: the request now stores the hash of the token the buttons carry.
    expect(rows("spendApproval")[0].tokenHash).toBe(hashApprovalToken(token));
    const decline = ((components[2].parameters as Row[])[0] as Row).payload as string;
    expect(verifyReplyPayload(decline, WA)).toEqual({ kind: "spdec", id: "ap1" });
    expect(rows("notice")).toEqual([expect.objectContaining({ tenantId: T, kind: "approval_waiting", source: "spend", audienceMinRole: "admin", payload: expect.objectContaining({ title: "1 spending request is waiting", approvalId: "ap1" }) })]);
    expect(rows("spendLedger").filter((r) => r.action === "notify.approval")).toEqual([expect.objectContaining({ phase: "info", reasonCodes: expect.arrayContaining(["whatsapp"]) })]);
    expect(rows("ownerNotifyChannel").filter((c) => c.lastSentAt).map((c) => c.userId).sort()).toEqual([APPROVER.userId, OWNER.userId].sort());
    // A retried notice is a no-op on every channel.
    expect(await notifier().notify(approvalNotice())).toMatchObject({ delivered: ["in_app"], deduplicated: true });
    expect(h.sends).toHaveLength(2);
  });

  it("falls back to in-app when the template is paused, the channel is not verified, or the notifier number is RED", async () => {
    approval();
    verifiedChannel(OWNER.userId);
    rows("template").find((t) => t.name === "spend_approval_v1")!.status = "paused";
    expect(await notifier().notify(approvalNotice())).toEqual({
      delivered: ["in_app"],
      skipped: [
        { channel: "whatsapp", reason: "template_paused" },
        { channel: "email", reason: "email_off" },
      ],
      deduplicated: false,
    });

    resetNotifierState();
    rows("template").find((t) => t.name === "spend_approval_v1")!.status = "approved";
    channel(OWNER.userId).verifiedAt = null;
    expect((await notifier().notify(approvalNotice({ dedupeKey: "k2" }))).skipped[0]).toEqual({ channel: "whatsapp", reason: "no_verified_channel" });

    resetNotifierState();
    channel(OWNER.userId).verifiedAt = new Date();
    rows("phoneNumber")[0].qualityRating = "RED";
    expect((await notifier().notify(approvalNotice({ dedupeKey: "k3" }))).skipped[0]).toEqual({ channel: "whatsapp", reason: "number_red" });

    resetNotifierState();
    rows("phoneNumber")[0].qualityRating = "GREEN";
    h.db.seed("spendBreaker", [{ id: "sb1", tenantId: N, kind: "wa_restricted", scopeType: "waba", scopeId: "w_n", state: "tripped", effect: "block_marketing", reason: "x" }]);
    expect((await notifier().notify(approvalNotice({ dedupeKey: "k4" }))).skipped[0]).toEqual({ channel: "whatsapp", reason: "number_restricted" });

    resetNotifierState();
    rows("tenant").find((t) => t.id === N)!.billingExempt = false;
    expect((await notifier().notify(approvalNotice({ dedupeKey: "k5" }))).skipped[0]).toEqual({ channel: "whatsapp", reason: "notifier_not_exempt" });

    expect(h.sends).toEqual([]);
    expect(rows("notice")).toHaveLength(5);
  });

  it("alerts about something paused become spend_alert_v1; heads-ups, notes and platform alerts stay off WhatsApp", async () => {
    verifiedChannel(OWNER.userId);
    const alert: SpendNotice = { tenantId: T, kind: "breaker_tripped", severity: "action_needed", audience: "approvers", dedupeKey: "spend-breaker:sb9", title: "'Diwali leads' was paused: it costs too much per lead", body: "x" };
    expect(await notifier().notify(alert)).toMatchObject({ delivered: ["whatsapp", "in_app"] });
    expect(h.sends[0].templateName).toBe("spend_alert_v1");
    expect(((h.sends[0].components as Row[])[0].parameters as Row[]).map((p) => p.text)).toEqual(["Sharma Sweets", "'Diwali leads'", "it costs too much per lead"]);
    expect(await notifier().notify({ ...alert, dedupeKey: "a2", severity: "heads_up" })).toMatchObject({ delivered: ["in_app"], skipped: expect.arrayContaining([{ channel: "whatsapp", reason: "in_app_only" }]) });
    expect(await notifier().notify({ ...alert, dedupeKey: "a3", title: "1 campaign could not be paused" })).toMatchObject({ delivered: ["in_app"] });
    expect(await notifier().notify({ ...alert, dedupeKey: "a4", audience: "platform_admins" })).toMatchObject({ delivered: [] });
    expect(h.sends).toHaveLength(1);
  });

  it("reads what was paused and why from the title or the params (pure)", () => {
    const n = (title: string, params?: SpendNotice["params"]) => alertSlots({ kind: "breaker_tripped", title, params });
    expect(n("Your ad assistant was paused for spending too fast")).toEqual({ what: "Your ad assistant", because: "it was spending too fast" });
    expect(n("'Diwali' was paused: spending jumped")).toEqual({ what: "'Diwali'", because: "spending jumped" });
    expect(n("Today's ads limit is used up")).toEqual({ what: "Spending on ads", because: "today's ads limit is used up" });
    expect(n("This month's AI limit is used up")).toEqual({ what: "AI use", because: "this month's AI limit is used up" });
    expect(n("This month's ads limit is nearly used up")).toBeNull();
    expect(n("Unusual results in 'X'")).toBeNull();
    expect(n("anything", { paused: "Broadcast 'Diwali'", because: "the WhatsApp limit is used up." })).toEqual({ what: "Broadcast 'Diwali'", because: "the WhatsApp limit is used up" });
    expect(whatsappPlan(approvalNotice({ severity: "heads_up" }))).toEqual({ skip: "in_app_only" });
    expect(whatsappPlan(approvalNotice())).toEqual({ key: "approval", purpose: "approval" });
    expect(whatsappPlan({ ...approvalNotice(), kind: "digest", params: {} })).toEqual({ skip: "no_digest_values" });
  });

  it("an in-app notice that resolved or expired comes back as a new occurrence instead of being swallowed", async () => {
    const notice = approvalNotice({ dedupeKey: "spend-x", approvalId: undefined });
    expect(await deliverInApp(notice)).toEqual({ delivered: true, deduplicated: false });
    rows("notice")[0].resolvedAt = new Date();
    expect(await deliverInApp(notice)).toEqual({ delivered: true, deduplicated: false });
    expect(rows("notice")).toHaveLength(1);
    expect(rows("notice")[0].resolvedAt).toBeNull();
    expect(rows("notice")[0].payload).toMatchObject({ title: "1 spending request is waiting" });
  });
});

// =====================================================================================================================
describe("Decline by quick reply (7.4 item 4; acceptance 3)", () => {
  it("a valid HMAC from the approver's verified phone declines via 'whatsapp' and answers 'Declined. Nothing was changed.'", async () => {
    approval();
    verifiedChannel(APPROVER.userId, T, "+919811111111");
    notifierChat("+919811111111");
    const out = await handleOwnerReply({ tenantId: N, waId: "919811111111", payload: replyPayload("spdec", "ap1", "919811111111")! });
    expect(out).toEqual({ handled: true, action: "declined" });
    expect(rows("spendApproval")[0]).toMatchObject({ status: "declined", decidedVia: "whatsapp", decidedByUserId: APPROVER.userId });
    expect(rows("spendLedger").find((r) => r.action === "approval.decline")).toMatchObject({ reasonCodes: expect.arrayContaining(["whatsapp"]) });
    expect(h.texts.at(-1)).toMatchObject({ body: "Declined. Nothing was changed.", origin: "system_notify", source: `spend_notify:${T}` });
  });

  it("a wrong phone, a wrong HMAC, an admin who is not an approver or an unverified channel is ignored, and the request stays pending", async () => {
    approval();
    verifiedChannel(APPROVER.userId, T, "+919811111111");
    verifiedChannel(ADMIN.userId, T, "+919822222222");
    // Another number, even with its own valid HMAC.
    expect(await handleOwnerReply({ tenantId: N, waId: "919833333333", payload: replyPayload("spdec", "ap1", "919833333333")! })).toMatchObject({ handled: false, reason: "not_an_approver_phone" });
    // The approver's payload forwarded from another phone.
    expect(await handleOwnerReply({ tenantId: N, waId: "919822222222", payload: replyPayload("spdec", "ap1", "919811111111")! })).toMatchObject({ handled: false, reason: "bad_payload" });
    // A tampered HMAC.
    expect(await handleOwnerReply({ tenantId: N, waId: "919811111111", payload: "spdec:ap1:0123456789abcdef" })).toMatchObject({ handled: false });
    // An admin who is not an approver.
    expect(await handleOwnerReply({ tenantId: N, waId: "919822222222", payload: replyPayload("spdec", "ap1", "919822222222")! })).toMatchObject({ handled: false, reason: "not_an_approver" });
    channel(APPROVER.userId).verifiedAt = null;
    expect(await handleOwnerReply({ tenantId: N, waId: "919811111111", payload: replyPayload("spdec", "ap1", "919811111111")! })).toMatchObject({ handled: false });
    expect(rows("spendApproval")[0].status).toBe("pending");
    expect(h.texts).toEqual([]);
  });

  it("an already decided request gets Phase 0's sentence back, and approve is never accepted from a reply", async () => {
    approval({ status: "declined" });
    verifiedChannel(OWNER.userId);
    notifierChat();
    expect(await handleOwnerReply({ tenantId: N, waId: WA, payload: replyPayload("spdec", "ap1", WA)! })).toMatchObject({ handled: true, action: "ignored", reason: "closed" });
    expect(h.texts.at(-1)?.body).toBe("This request was already declined.");
    expect(await handleOwnerReply({ tenantId: N, waId: WA, payload: `spapp:ap1:${replyHmac("spdec", "ap1", WA, process.env.SPEND_NOTIFY_SECRET!)}` })).toMatchObject({ handled: false, reason: "bad_payload" });
  });
});

// =====================================================================================================================
describe("STOP and START (7.4 item 5; acceptance 4)", () => {
  it("STOP opts out every channel with that phone; START re-enables only the channel of the workspace it came from", async () => {
    verifiedChannel(OWNER.userId, T);
    verifiedChannel(OWNER.userId, T2);
    verifiedChannel(APPROVER.userId, T, "+919811111111");
    expect(await handleOwnerKeyword({ tenantId: N, waId: WA, keyword: "stop" })).toEqual({ changed: 2 });
    expect(channel(OWNER.userId, T).optOutAt).toBeInstanceOf(Date);
    expect(channel(OWNER.userId, T2).optOutAt).toBeInstanceOf(Date);
    expect(channel(APPROVER.userId).optOutAt).toBeNull();
    expect(await recipientsFor(T, "owner")).toEqual([]);

    // The last notifier message to this person was about T2.
    h.db.seed("contact", [{ id: "nc1", tenantId: N, phone: PHONE }]);
    h.db.seed("conversation", [{ id: "ncv1", tenantId: N, contactId: "nc1", phoneNumberId: "pn_n" }]);
    h.db.seed("message", [
      { id: "nm1", tenantId: N, conversationId: "ncv1", direction: "outbound", statusTimeline: [{ status: "sent", source: `spend_notify:${T}` }], createdAt: new Date(Date.now() - 60_000) },
      { id: "nm2", tenantId: N, conversationId: "ncv1", direction: "outbound", statusTimeline: [{ status: "sent", source: `spend_notify:${T2}` }], createdAt: new Date() },
    ]);
    expect(await handleOwnerKeyword({ tenantId: N, waId: WA, keyword: "start" })).toEqual({ changed: 1 });
    expect(channel(OWNER.userId, T2).optOutAt).toBeNull();
    expect(channel(OWNER.userId, T).optOutAt).toBeInstanceOf(Date);
    // A keyword outside the notifier workspace changes nothing.
    expect(await handleOwnerKeyword({ tenantId: T, waId: WA, keyword: "stop" })).toEqual({ changed: 0 });
  });

  it("a STOP from the phone is never lifted by someone else's opt-in: refused before anything is stored, and the contact stays opted out", async () => {
    // The phone holder replied STOP: the processor marked the notifier contact, and the channels went off.
    h.db.seed("contact", [{ id: "nc_stop", tenantId: N, phone: PHONE, optIn: true, optedOutAt: new Date(clock - 3_600_000), tags: ["owner_spend_alerts"] }]);
    const ok = { phone: PHONE, consent: true, textVersion: OWNER_WHATSAPP_CONSENT_VERSION };
    await expect(optIn(OWNER, ok, { now: nextHour() })).rejects.toMatchObject({
      status: 409,
      message: "This number replied STOP to Edwyz alerts, so we can't message it. To get alerts again, send START to +1 711-268-5789 on WhatsApp from that phone, then try again here.",
    });
    expect(h.sends).toEqual([]);
    expect(rows("ownerNotifyChannel")).toEqual([]);
    expect(rows("spendConsent")).toEqual([]);
    expect(rows("contact").find((c) => c.id === "nc_stop")!.optedOutAt).toBeInstanceOf(Date);
    // Even a direct call with freshConsent leaves the STOP in place, so the template is refused.
    const config = parseNotifierConfig({ tenantId: N, phoneNumberId: "pn_n" })!;
    await ensureNotifierContact(config, PHONE, { freshConsent: true, now: nextHour() });
    expect(rows("contact").find((c) => c.id === "nc_stop")!.optedOutAt).toBeInstanceOf(Date);
    const sent = await sendNotifierTemplate({ key: "optin", purpose: "optin", subjectTenantId: T, phoneE164: PHONE, freshConsent: true, values: { params: [OPTIN_SUBJECT] } }, { now: nextHour() });
    expect(sent).toEqual({ sent: false, reason: "opted_out" });
    expect(h.sends).toEqual([]);
  });

  it("a fresh opt-in re-enables only its own channel", async () => {
    verifiedChannel(OWNER.userId, T);
    verifiedChannel(OWNER.userId, T2);
    await handleOwnerKeyword({ tenantId: N, waId: WA, keyword: "stop" });
    await optIn(OWNER, { phone: PHONE, consent: true, textVersion: OWNER_WHATSAPP_CONSENT_VERSION }, { now: nextHour() });
    expect(channel(OWNER.userId, T)).toMatchObject({ optOutAt: null, verifiedAt: null });
    expect(channel(OWNER.userId, T2).optOutAt).toBeInstanceOf(Date);
  });
});

// =====================================================================================================================
describe("TIER_250 (7.4 item 6; acceptance 6)", () => {
  it("above 200 owners a day digests stay in the app; at 250 nobody new is messaged; someone already messaged always fits", () => {
    expect(DIGEST_CUTOFF).toBe(200);
    expect(TIER_LIMIT).toBe(250);
    expect(tierAllows("digest", false, 199)).toEqual({ ok: true });
    expect(tierAllows("digest", false, 200)).toEqual({ ok: false, reason: "tier_digest_cutoff" });
    expect(tierAllows("alert", false, 200)).toEqual({ ok: true });
    expect(tierAllows("approval", false, 249)).toEqual({ ok: true });
    expect(tierAllows("approval", false, 250)).toEqual({ ok: false, reason: "tier_full" });
    expect(tierAllows("digest", true, 260)).toEqual({ ok: true });
  });

  it("confirmations to unproved numbers may use only 20% of the tier, so approvals still go out", async () => {
    expect(OPTIN_TIER_CAP).toBe(50);
    expect(tierAllows("optin", false, 49, 49)).toEqual({ ok: true });
    expect(tierAllows("optin", false, 50, 50)).toEqual({ ok: false, reason: "tier_optin_cap" });
    expect(tierAllows("approval", false, 50, 50)).toEqual({ ok: true });
    expect(tierAllows("optin", true, 60, 60)).toEqual({ ok: true });
    // 50 numbers got only a confirmation today; a real owner who also got an alert does not count toward the cap.
    for (let i = 0; i < OPTIN_TIER_CAP; i++) {
      h.db.seed("message", [{ id: `oi_${i}`, tenantId: N, conversationId: `oi_conv_${i}`, direction: "outbound", origin: "system_notify", templateName: "spend_optin_v1", body: "[template] spend_optin_v1", statusTimeline: [], createdAt: new Date() }]);
    }
    h.db.seed("message", [
      { id: "real_1", tenantId: N, conversationId: "real_conv", direction: "outbound", origin: "system_notify", templateName: "spend_optin_v1", statusTimeline: [], createdAt: new Date() },
      { id: "real_2", tenantId: N, conversationId: "real_conv", direction: "outbound", origin: "system_notify", templateName: "spend_alert_v1", statusTimeline: [], createdAt: new Date() },
    ]);
    await expect(optIn(OWNER, { phone: PHONE, consent: true, textVersion: OWNER_WHATSAPP_CONSENT_VERSION }, { now: new Date() })).rejects.toMatchObject({
      status: 409,
      message: "WhatsApp alerts can't be set up right now. Alerts still come here in the app; try again later.",
    });
    expect(h.sends).toEqual([]);
    expect(rows("spendConsent")).toEqual([]);
    approval();
    verifiedChannel(APPROVER.userId, T, "+919811111111");
    expect(await createPlatformNotifier().notify(approvalNotice())).toMatchObject({ delivered: ["whatsapp", "in_app"] });
    expect(h.sends.map((s) => s.templateName)).toEqual(["spend_approval_v1"]);
  });

  it("drops the digest before the alert when 200 other owners were notified today", async () => {
    verifiedChannel(OWNER.userId);
    for (let i = 0; i < DIGEST_CUTOFF; i++) {
      h.db.seed("message", [{ id: `busy_${i}`, tenantId: N, conversationId: `other_${i}`, direction: "outbound", origin: "system_notify", statusTimeline: [], createdAt: new Date() }]);
    }
    const slots = Object.fromEntries(["Sharma Sweets", "28 Oct", "₹1,200", "4", "₹300", "₹45", "2", "1", "₹13,800"].map((v, i) => [`s${i + 1}`, v]));
    const digest: SpendNotice = { tenantId: T, kind: "digest", severity: "fyi", audience: "admins", dedupeKey: "spend-digest:t1:2026-10-28", title: "Daily summary for 28 Oct", body: "Ads spent ₹1,200.", params: slots };
    expect((await createPlatformNotifier().notify(digest)).skipped[0]).toEqual({ channel: "whatsapp", reason: "tier_digest_cutoff" });
    const alert: SpendNotice = { tenantId: T, kind: "limit_reached", severity: "action_needed", audience: "owner", dedupeKey: "spend-limit:x", title: "Today's ads limit is used up", body: "x" };
    expect(await createPlatformNotifier().notify(alert)).toMatchObject({ delivered: ["whatsapp", "in_app"] });
    expect(h.sends.map((s) => s.templateName)).toEqual(["spend_alert_v1"]);
    expect(rows("notice").find((n) => n.kind === "digest")).toMatchObject({ payload: expect.objectContaining({ body: "Ads spent ₹1,200." }) });
  });
});

// =====================================================================================================================
describe("the notifier workspace's health and startup check (4.16, 7.4 critic; acceptance 7)", () => {
  it("is healthy when exempt, quiet and staffed by platform admins", async () => {
    expect((await notifierHealth()).problems).toEqual([]);
  });

  it("warns when its AI agent, chatbots or automations are on, it is not exempt, a member is not a platform admin, or a template is not approved", async () => {
    h.db.seed("aiAgent", [{ id: "ag1", tenantId: N, enabled: true }]);
    h.db.seed("chatbot", [{ id: "cb1", tenantId: N, status: "published" }]);
    h.db.seed("automationRule", [{ id: "r1", tenantId: N, enabled: true }]);
    h.db.seed("membership", [{ id: "m9", tenantId: N, userId: "u_x", role: "admin", user: { email: "someone@shop.in" } }]);
    rows("tenant").find((t) => t.id === N)!.billingExempt = false;
    rows("template").find((t) => t.name === "spend_daily_v1")!.status = "rejected";
    const lines: string[] = [];
    const problems = await logNotifierProblems({ log: (l) => lines.push(l) });
    expect(problems.join("\n")).toMatch(/AI agent turned on/);
    expect(problems.join("\n")).toMatch(/chatbot published/);
    expect(problems.join("\n")).toMatch(/automations turned on/);
    expect(problems.join("\n")).toMatch(/not exempt from billing/);
    expect(problems.join("\n")).toMatch(/1 member who is not a platform admin/);
    expect(problems.join("\n")).toMatch(/spend_daily_v1 is rejected/);
    expect(lines).toHaveLength(problems.length);
    for (const l of lines) expect(l.startsWith("[spend] notifier: ")).toBe(true);
    expect(lines.join("\n")).not.toContain("someone@shop.in");
  });

  it("says plainly when the sender is not set up", async () => {
    h.db.reset();
    expect((await notifierHealth()).problems).toEqual(["WhatsApp alerts to owners are off: the notification sender is not set up."]);
  });
});

// =====================================================================================================================
describe("erasure and pruning (3.5)", () => {
  function notifierHistory() {
    h.db.seed("contact", [{ id: "nc1", tenantId: N, phone: PHONE }]);
    h.db.seed("conversation", [{ id: "ncv1", tenantId: N, contactId: "nc1", phoneNumberId: "pn_n" }]);
    h.db.seed("message", [
      { id: "about_t1", tenantId: N, conversationId: "ncv1", direction: "outbound", statusTimeline: [{ status: "sent", source: `spend_notify:${T}` }] },
      { id: "about_t2", tenantId: N, conversationId: "ncv1", direction: "outbound", statusTimeline: [{ status: "sent", source: `spend_notify:${T2}` }] },
      { id: "their_reply", tenantId: N, conversationId: "ncv1", direction: "inbound", statusTimeline: [{ status: "received" }] },
    ]);
  }

  it("a phone only this workspace used loses its notifier contact, chat and messages", async () => {
    verifiedChannel(OWNER.userId, T);
    notifierHistory();
    await createPlatformNotifier().eraseOwnerData(T);
    expect(rows("contact").filter((c) => c.tenantId === N)).toEqual([]);
    expect(rows("conversation").filter((c) => c.tenantId === N)).toEqual([]);
    expect(rows("message").filter((m) => m.tenantId === N)).toEqual([]);
  });

  it("a phone another workspace still uses keeps its contact; only the messages about the erased workspace go", async () => {
    verifiedChannel(OWNER.userId, T);
    verifiedChannel(OWNER.userId, T2);
    notifierHistory();
    await createPlatformNotifier().eraseOwnerData(T);
    expect(rows("contact").filter((c) => c.tenantId === N).map((c) => c.id)).toEqual(["nc1"]);
    expect(rows("message").filter((m) => m.tenantId === N).map((m) => m.id)).toEqual(["about_t2", "their_reply"]);
    expect(notifierSubjectOf([{ source: `spend_notify:${T2}` }])).toBe(T2);
    expect(notifierSubjectOf([{ source: "admin_test" }])).toBeNull();
  });

  it("a channel whose person is no longer a member goes, with its notifier data", async () => {
    verifiedChannel(APPROVER.userId, T, "+919811111111");
    verifiedChannel(OWNER.userId, T);
    rows("membership").splice(rows("membership").findIndex((m) => m.userId === APPROVER.userId), 1);
    h.db.seed("contact", [{ id: "nc2", tenantId: N, phone: "+919811111111" }]);
    expect(await pruneChannels()).toBe(1);
    expect(rows("ownerNotifyChannel").map((c) => c.userId)).toEqual([OWNER.userId]);
    expect(rows("contact").find((c) => c.id === "nc2")).toBeUndefined();
  });
});

// =====================================================================================================================
describe("/api/spend/notify", () => {
  const request = (who: { userId: string; tenantId: string; role: string } | null, method: string, body?: unknown, origin: string | null = ORIGIN) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who) headers.authorization = `Bearer ${signAccessToken({ sub: who.userId, tid: who.tenantId, role: who.role as "owner" })}`;
    if (origin) headers.origin = origin;
    return new Request(`${ORIGIN}/api/spend/notify`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };

  it("GET gives the caller's own settings: email off, the consent text and whether they may sign up", async () => {
    const res = await GET(request(AGENT, "GET"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { notify: Row };
    expect(json.notify).toMatchObject({ own: null, emailFallback: "off", emailFallbackText: "Email alerts are off for now, so alerts come here in the app and on WhatsApp.", canSetNumber: false, consentVersion: OWNER_WHATSAPP_CONSENT_VERSION });
    expect(((await (await GET(request(OWNER, "GET"))).json()) as { notify: Row }).notify.canSetNumber).toBe(true);
  });

  it("POST signs the owner up (201), refuses a team member (403) and a request from another site", async () => {
    const body = { phone: PHONE, consent: true, textVersion: OWNER_WHATSAPP_CONSENT_VERSION };
    expect((await POST(request(OWNER, "POST", body, "https://evil.example"))).status).toBe(403);
    const ok = await POST(request(OWNER, "POST", body));
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { channel: Row }).channel).toMatchObject({ status: "pending", senderDisplay: "+1 711-268-5789" });
    const no = await POST(request(AGENT, "POST", { ...body, phone: "+919800000000" }));
    expect(no.status).toBe(403);
  });

  it("DELETE turns the caller's own alerts off", async () => {
    verifiedChannel(OWNER.userId);
    const res = await DELETE(request(OWNER, "DELETE"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { channel: Row }).channel).toMatchObject({ status: "opted_out" });
  });
});
