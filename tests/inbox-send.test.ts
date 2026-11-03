import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, RawCall, Row } from "./helpers/fake-spend-db";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  limits: { daily: null as bigint | null, monthly: 100_000n as bigint | null, rules: { assistantRefusal: null as unknown, humanRefusal: null as unknown } },
  network: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
  /** Send through the real src/lib/graph transport (tripwire, then fetch) instead of the network spy. */
  realTransport: false,
}));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  const base = h.db.prisma as Record<string, unknown>;
  const rows = () => h.db.rows("message");
  const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row);
  // processSendJob reads the message with its conversation, contact and number: the plain fake has no relations, so join here.
  const message = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: `m${rows().length + 1}`, createdAt: new Date(), ...data };
      rows().push(row);
      return { ...row };
    },
    findFirst: async ({ where, include, select }: { where: Row; include?: Row; select?: Row }) => {
      const row = rows().find((r) => r.id === where.id && r.tenantId === where.tenantId);
      if (!row) return null;
      if (!include) return pick({ ...row }, select);
      const conversation = h.db.rows("conversation").find((c) => c.id === row.conversationId)!;
      return {
        ...row,
        conversation: {
          ...conversation,
          contact: h.db.rows("contact").find((c) => c.id === conversation.contactId),
          phoneNumber: h.db.rows("phoneNumber").find((p) => p.id === conversation.phoneNumberId),
        },
      };
    },
    updateMany: (base.message as { updateMany: (a: unknown) => Promise<unknown> }).updateMany,
    findMany: (base.message as { findMany: (a: unknown) => Promise<unknown> }).findMany,
  };
  return { prisma: new Proxy(base, { get: (t, p: string) => (p === "message" ? message : t[p]) }) };
});
vi.mock("@/lib/spend/allowances", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spend/allowances")>()),
  effectiveLimits: vi.fn(async () => h.limits),
}));
// The real transport tripwire (4.7), run in enforce mode (SPEND_TRIPWIRE=enforce below): a WhatsApp send needs a minted msg
// permit for this tenant, number and path, with a use left, or it throws before any network I/O. graphFetch runs it first,
// exactly as run() in src/lib/graph/index.ts does, and then calls a network spy so the tests control retries and failures.
// With h.realTransport the real graphFetch runs instead, down to a stubbed global fetch.
vi.mock("@/lib/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/graph")>();
  const { vi: v } = await import("vitest");
  h.network = v.fn();
  const graphFetch = async (req: { tenantId: string; path: string; method?: "GET" | "POST" | "DELETE"; query?: Record<string, string>; body?: unknown }) => {
    if (h.realTransport) return actual.graphFetch(req);
    const { tripwire } = await import("@/lib/spend/tripwire");
    const { currentPermit } = await import("@/lib/spend/permit");
    tripwire({ method: req.method ?? "GET", path: req.path, query: req.query, body: req.body }, { via: "tenant", tenantId: req.tenantId });
    return h.network(req, currentPermit());
  };
  return { ...actual, graphFetch };
});
vi.mock("@/lib/crypto/tokens", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/crypto/tokens")>()), getAccessToken: async () => "EAAtest" }));
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn(async () => undefined) }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/integrations/emitters", () => ({ emitStatusChanged: vi.fn(async () => undefined) }));
vi.mock("@/lib/onboarding/token-health", () => ({ isAuthFailure: () => false, markWhatsAppAuthRejected: vi.fn(), noteWhatsAppTokenWorks: vi.fn() }));
vi.mock("@/lib/routing", () => ({ assignConversation: vi.fn(async () => ({ assignedToId: "u2", reason: "assigned" })), onConversationAssigned: vi.fn() }));
vi.mock("@/lib/chatbots/human-reply", () => ({ stopBotsOnHumanReply: vi.fn(async () => 0) }));
vi.mock("@/lib/automation/v2/emit", () => ({ emitTagChanges: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { RATECARD_KEY } from "@/lib/admin/ratecard";
import { GraphError, graphFetch } from "@/lib/graph";
import { sendInteractive, buildReplyButtons } from "@/lib/inbox/interactive";
import { handoffNotice, processSendJob } from "@/lib/inbox/send";
import { sendTemplateMessage, sendText } from "@/lib/inbox/service";
import { enqueue } from "@/lib/queue";
import { assignConversation } from "@/lib/routing";
import { SpendGuardBypassError } from "@/lib/spend/errors";
import { resetSpendStateCache } from "@/lib/spend/kill";
import { messagingGate, resetGateCaches } from "@/lib/spend/messaging/gate";
import { isMintedPermit } from "@/lib/spend/permit";
import { setTripwireAuditSink, type TripwireAuditEvent } from "@/lib/spend/tripwire";

const T = "t1";
const enqueueMock = vi.mocked(enqueue);
const DAY = 86_400_000;

function emulateCounters(db: FakeSpendDb) {
  db.onRaw((call: RawCall) => {
    const find = (t: unknown, kind: string, key: unknown) => db.rows("spendCounter").find((r) => r.tenantId === t && r.periodKind === kind && r.periodKey === key);
    const big = (r: Row, k: string) => r[k] as bigint;
    if (call.sql.includes("spend.counter.reserve")) {
      const [t, , day, month, c, dl, ml] = call.values as [string, string, string, string, bigint, bigint | null, bigint | null];
      const d = find(t, "day", day);
      const m = find(t, "month", month);
      const fits = (r: Row | undefined, lim: bigint | null) => !!r && (lim === null || big(r, "spentMinor") + big(r, "reservedMinor") + c <= lim);
      const ok = fits(d, dl) && fits(m, ml);
      if (ok) for (const r of [d!, m!]) r.reservedMinor = big(r, "reservedMinor") + c;
      return [{ d: fits(d, dl) ? 1 : 0, m: fits(m, ml) ? 1 : 0, dayTotal: d ? String(big(d, "spentMinor") + big(d, "reservedMinor")) : null, monthTotal: m ? String(big(m, "spentMinor") + big(m, "reservedMinor")) : null }];
    }
    if (call.sql.includes("spend.counter.settle")) {
      const [t, , day, month, rel, delta] = call.values as [string, string, string, string, bigint, bigint];
      for (const r of [find(t, "day", day), find(t, "month", month)]) {
        if (!r) continue;
        r.reservedMinor = big(r, "reservedMinor") - rel < 0n ? 0n : big(r, "reservedMinor") - rel;
        r.spentMinor = big(r, "spentMinor") + delta < 0n ? 0n : big(r, "spentMinor") + delta;
      }
      return 2;
    }
    return undefined;
  });
}

const monthRow = () => h.db.rows("spendCounter").find((r) => r.periodKind === "month");
const reservedNow = () => (monthRow()?.reservedMinor as bigint | undefined) ?? 0n;
const spentNow = () => (monthRow()?.spentMinor as bigint | undefined) ?? 0n;
const stored = (id: string) => h.db.rows("message").find((m) => m.id === id)!;
const lastJob = () => enqueueMock.mock.calls.at(-1)![1] as Record<string, unknown>;
const tripwireEvents: TripwireAuditEvent[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SPEND_ENFORCE", "enforce");
  vi.stubEnv("SPEND_TRIPWIRE", "enforce");
  h.realTransport = false;
  tripwireEvents.length = 0;
  setTripwireAuditSink((e) => void tripwireEvents.push(e));
  h.db.reset();
  emulateCounters(h.db);
  resetGateCaches();
  resetSpendStateCache();
  h.limits = { daily: null, monthly: 100_000n, rules: { assistantRefusal: null, humanRefusal: null } };
  h.db.seed("spendControl", [{ tenantId: T, timezone: "Asia/Kolkata" }]);
  h.db.seed("platformSetting", [{ key: RATECARD_KEY, value: { currency: "INR", rates: { IN: { MARKETING: 100, UTILITY: 20, SERVICE: 10 } } } }]);
  h.db.seed("phoneNumber", [{ id: "ph1", tenantId: T, wabaRefId: "w1", phoneNumberId: "meta_ph1", status: "connected" }]);
  h.db.seed("contact", [{ id: "c1", tenantId: T, phone: "+919876543210", bsuid: null, optIn: true, optedOutAt: null }]);
  h.db.seed("conversation", [{ id: "cv1", tenantId: T, phoneNumberId: "ph1", contactId: "c1", status: "pending", tags: [], lastInboundAt: new Date(Date.now() - 60_000), referral: null, createdAt: new Date(Date.now() - 30 * DAY) }]);
  h.db.seed("template", [{ id: "tp1", tenantId: T, wabaRefId: "w1", name: "promo", language: "en", category: "MARKETING", status: "approved" }]);
  h.network.mockResolvedValue({ messages: [{ id: "wamid.1" }] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setTripwireAuditSink(null);
});

const queueTemplate = async (origin: "automation" | "human" | "lead_sequence" = "automation") => {
  const message = await sendTemplateMessage({ tenantId: T, phoneNumberId: "ph1", contactId: "c1", conversationId: "cv1", templateName: "promo", language: "en", origin });
  return { message, job: lastJob() };
};

describe("processSendJob through the spend gate", () => {
  it("stamps origin, category and WABA on the job and the Message at enqueue", async () => {
    const { message, job } = await queueTemplate("lead_sequence");
    expect(job).toEqual({ messageId: message.id, tenantId: T, template: { name: "promo", language: "en", components: [] }, origin: "lead_sequence", category: "MARKETING", wabaRefId: "w1" });
    expect(stored(message.id)).toMatchObject({ origin: "lead_sequence", pricingCategory: "MARKETING", status: "queued" });
  });

  it("sends inside a msg_send permit (the tripwire passes it) and the Message ends with origin, category, estimate and spendState settled", async () => {
    const { message, job } = await queueTemplate();
    await processSendJob(job);
    expect(h.network).toHaveBeenCalledTimes(1);
    const [req, permit] = h.network.mock.calls[0] as [{ path: string }, { type: string; paths: string[]; messageId: string }];
    expect(req.path).toBe("meta_ph1/messages");
    expect(isMintedPermit(permit)).toBe(true);
    expect(permit).toMatchObject({ type: "msg", paths: ["meta_ph1/messages"], messageId: message.id });
    expect(stored(message.id)).toMatchObject({ status: "sent", wamid: "wamid.1", origin: "automation", pricingCategory: "MARKETING", estCostMinor: 100n, spendState: "settled" });
    expect(stored(message.id).spendDay).toBeInstanceOf(Date);
    expect([reservedNow(), spentNow()]).toEqual([0n, 100n]);
  });

  it("without a permit the tripwire throws before any network I/O, and a permit is good for one send only", async () => {
    await expect(graphFetch({ tenantId: T, path: "meta_ph1/messages", method: "POST", body: {} })).rejects.toBeInstanceOf(SpendGuardBypassError);
    expect(h.network).not.toHaveBeenCalled();
    expect(tripwireEvents).toEqual([expect.objectContaining({ action: "spend.tripwire.bypass", tenantId: T, meta: expect.objectContaining({ class: "msg_send", reason: "no_permit", mode: "enforce", blocked: true }) })]);
    tripwireEvents.length = 0;
    const { message, job } = await queueTemplate();
    const m = (await (await import("@/lib/db")).prisma.message.findFirst({ where: { id: message.id, tenantId: T }, include: { conversation: { include: { contact: true, phoneNumber: true } } } })) as never;
    const decision = await messagingGate(T, job, m);
    if (decision.action !== "send") throw new Error("expected send");
    await decision.run(async () => {
      await expect(graphFetch({ tenantId: T, path: "other_number/messages", method: "POST", body: {} })).rejects.toBeInstanceOf(SpendGuardBypassError);
      await expect(graphFetch({ tenantId: "t2", path: "meta_ph1/messages", method: "POST", body: {} })).rejects.toBeInstanceOf(SpendGuardBypassError);
      await graphFetch({ tenantId: T, path: "meta_ph1/messages", method: "POST", body: {} });
      await expect(graphFetch({ tenantId: T, path: "meta_ph1/messages", method: "POST", body: {} })).rejects.toBeInstanceOf(SpendGuardBypassError);
    });
    expect(h.network).toHaveBeenCalledTimes(1);
    expect(tripwireEvents.map((e) => e.meta.reason)).toEqual(["wrong_path", "wrong_tenant", "used_up"]);
  });

  it("end to end through the real Graph transport: the gate's permit passes the enforcing tripwire and exactly one POST leaves", async () => {
    h.realTransport = true;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.real" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { message, job } = await queueTemplate();
    await processSendJob(job);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toMatch(/\/meta_ph1\/messages$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ messaging_product: "whatsapp", to: "919876543210", type: "template", template: { name: "promo" } });
    expect(tripwireEvents).toEqual([]);
    expect(stored(message.id)).toMatchObject({ status: "sent", wamid: "wamid.real", spendState: "settled", estCostMinor: 100n });
    // The same transport refuses the call outright when nothing minted a permit, before fetch.
    await expect(graphFetch({ tenantId: T, path: "meta_ph1/messages", method: "POST", body: {} })).rejects.toBeInstanceOf(SpendGuardBypassError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a person's text is priced as a service message and counted", async () => {
    const message = await sendText({ tenantId: T, conversationId: "cv1", userId: "u1", body: "Hello", origin: "human" });
    const job = lastJob();
    expect(job).toMatchObject({ origin: "human", category: "SERVICE", wabaRefId: null });
    await processSendJob(job);
    expect(stored(message.id)).toMatchObject({ status: "sent", origin: "human", pricingCategory: "SERVICE", estCostMinor: 10n, spendState: "settled" });
    expect(spentNow()).toBe(10n);
  });

  it("an interactive chatbot message carries its origin through the queue", async () => {
    const message = await sendInteractive({ tenantId: T, conversationId: "cv1", interactive: buildReplyButtons({ body: "Pick", buttons: [{ id: "a", title: "A" }] }), origin: "chatbot" });
    const job = lastJob();
    expect(job).toMatchObject({ origin: "chatbot", category: "SERVICE", wabaRefId: null });
    expect(stored(message.id)).toMatchObject({ origin: "chatbot", pricingCategory: "SERVICE" });
    await processSendJob(job);
    expect(stored(message.id)).toMatchObject({ status: "sent", spendState: "settled", estCostMinor: 10n });
  });

  it("an ambiguous send is recorded as send_unconfirmed but settled at its estimate, never released", async () => {
    const { message, job } = await queueTemplate();
    h.network.mockRejectedValue(new GraphError("timeout", 0, undefined, undefined, false, true));
    await processSendJob(job);
    expect(stored(message.id)).toMatchObject({ status: "failed", errorCode: "send_unconfirmed", spendState: "settled" });
    expect([reservedNow(), spentNow()]).toEqual([0n, 100n]);
  });

  it("a permanent failure releases the reservation", async () => {
    const { message, job } = await queueTemplate();
    h.network.mockRejectedValue(new GraphError("bad", 400, 131026));
    await processSendJob(job);
    expect(stored(message.id)).toMatchObject({ status: "failed", errorCode: "131026", spendState: "released" });
    expect([reservedNow(), spentNow()]).toEqual([0n, 0n]);
  });

  it("a retryable error keeps the reservation for the queue's next attempt, which reuses it", async () => {
    const { message, job } = await queueTemplate();
    h.network.mockRejectedValueOnce(new GraphError("rate", 429, 4, undefined, true));
    await expect(processSendJob(job, { attempt: 1, maxAttempts: 5, isLastAttempt: false })).rejects.toThrow("rate");
    expect(stored(message.id)).toMatchObject({ status: "queued", spendState: "reserved" });
    expect(reservedNow()).toBe(100n);
    await processSendJob(job, { attempt: 2, maxAttempts: 5, isLastAttempt: false });
    expect(stored(message.id)).toMatchObject({ status: "sent", spendState: "settled" });
    expect([reservedNow(), spentNow()]).toEqual([0n, 100n]);
  });

  it("a reservation kept for a retry is given back when the message then ends unsent (STOP arrived in between)", async () => {
    const { message, job } = await queueTemplate();
    h.network.mockRejectedValueOnce(new GraphError("rate", 429, 4, undefined, true));
    await expect(processSendJob(job, { attempt: 1, maxAttempts: 5, isLastAttempt: false })).rejects.toThrow("rate");
    expect(reservedNow()).toBe(100n);
    h.db.rows("contact")[0].optedOutAt = new Date();
    await processSendJob(job, { attempt: 2, maxAttempts: 5, isLastAttempt: false });
    expect(h.network).toHaveBeenCalledTimes(1);
    expect(stored(message.id)).toMatchObject({ status: "failed", errorCode: "opted_out", spendState: "released" });
    expect([reservedNow(), spentNow()]).toEqual([0n, 0n]);
  });

  it("a STOP that arrives while a utility template waits does not stop it: an opt-out blocks marketing only (owner default 1)", async () => {
    h.db.rows("template")[0].category = "UTILITY";
    const { message, job } = await queueTemplate();
    expect(stored(message.id)).toMatchObject({ pricingCategory: "UTILITY" });
    h.db.rows("contact")[0].optedOutAt = new Date();
    await processSendJob(job);
    expect(h.network).toHaveBeenCalledTimes(1);
    expect(stored(message.id)).toMatchObject({ status: "sent" });
  });

  it("a frozen workspace holds an automation's message 15 minutes at a time and fails it after 24 hours (free-form)", async () => {
    h.db.rows("spendControl")[0].freeze = "all";
    const message = await sendText({ tenantId: T, conversationId: "cv1", body: "Auto reply", origin: "automation" });
    const job = lastJob();
    const before = Date.now();
    await processSendJob(job);
    expect(h.network).not.toHaveBeenCalled();
    const [queue, held, opts] = enqueueMock.mock.calls.at(-1) as [string, Record<string, unknown>, { runAt: Date }];
    expect(queue).toBe("send");
    expect(held).toMatchObject({ messageId: message.id, origin: "automation", heldReason: "spending_stopped" });
    expect(opts.runAt.getTime() - before).toBeGreaterThanOrEqual(15 * 60_000 - 100);
    expect(stored(message.id).status).toBe("queued");
    await processSendJob({ ...held, blockedSince: new Date(Date.now() - 2 * DAY).toISOString() });
    expect(stored(message.id)).toMatchObject({ status: "failed", errorCode: "spending_stopped" });
    // A person's message in the same workspace still goes out.
    const own = await sendText({ tenantId: T, conversationId: "cv1", userId: "u1", body: "Hi", origin: "human" });
    await processSendJob(lastJob());
    expect(stored(own.id).status).toBe("sent");
  });

  it("a template paused while the message waited in the queue fails with template_blocked", async () => {
    const { message, job } = await queueTemplate("human");
    h.db.rows("template")[0].status = "paused";
    await processSendJob(job);
    expect(h.network).not.toHaveBeenCalled();
    expect(stored(message.id)).toMatchObject({ status: "failed", errorCode: "template_blocked" });
  });

  it("a chatbot reply that finds the limit used up fails with messaging_limit and hands the chat to the team, once", async () => {
    h.limits = { daily: null, monthly: 5n, rules: { assistantRefusal: null, humanRefusal: null } };
    h.db.seed("chatbotSession", [{ id: "s1", tenantId: T, conversationId: "cv1", status: "waiting" }]);
    const first = await sendText({ tenantId: T, conversationId: "cv1", body: "Bot says hi", origin: "chatbot" });
    await processSendJob(lastJob());
    expect(h.network).not.toHaveBeenCalled();
    expect(stored(first.id)).toMatchObject({ status: "failed", errorCode: "messaging_limit" });
    const conversation = h.db.rows("conversation")[0];
    expect(conversation.status).toBe("open");
    expect(conversation.tags).toContain("ai:stopped");
    expect(h.db.rows("chatbotSession")[0].status).toBe("handed_off");
    expect(h.db.rows("note")).toEqual([expect.objectContaining({ conversationId: "cv1", authorId: "system", body: handoffNotice("month") })]);
    expect(handoffNotice("month")).toBe("Automatic replies are paused because this month's WhatsApp limit is used up.");
    expect(assignConversation).toHaveBeenCalledWith(T, "cv1");

    await sendText({ tenantId: T, conversationId: "cv1", body: "Bot again", origin: "chatbot" });
    await processSendJob(lastJob());
    expect(h.db.rows("note")).toHaveLength(1);
  });

  it("an automation with the limit used up waits instead (held, not failed, no hand-over)", async () => {
    h.limits = { daily: null, monthly: 5n, rules: { assistantRefusal: null, humanRefusal: null } };
    const message = await sendText({ tenantId: T, conversationId: "cv1", body: "Auto", origin: "automation" });
    await processSendJob(lastJob());
    expect(stored(message.id).status).toBe("queued");
    expect(lastJob()).toMatchObject({ heldReason: "messaging_limit" });
    expect(h.db.rows("note")).toHaveLength(0);
  });
});
