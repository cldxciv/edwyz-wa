import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  contact: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  broadcast: { findUnique: vi.fn() },
  platformSetting: { create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  job: { findFirst: vi.fn(), updateMany: vi.fn() },
  waba: { findFirst: vi.fn() },
  phoneNumber: { findMany: vi.fn() },
  auditLog: { create: vi.fn(), findMany: vi.fn() },
  user: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
}));
const queue = vi.hoisted(() => ({ enqueue: vi.fn(), runDueJobs: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => queue);
vi.mock("@/lib/billing", () => ({ assertWithinLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inbox/service", () => ({ sendTemplateMessage: vi.fn(), sendText: vi.fn() }));
vi.mock("@/lib/automation/v2/emit", () => ({ emitAttributeChanges: vi.fn(), emitAutomationEvent: vi.fn(), emitTagChanges: vi.fn() }));

import { TIER_PEOPLE } from "@/lib/messaging-limit";
import { acquireRunLease, enqueueBroadcastRun, leaseKey, releaseRunLease } from "@/lib/broadcasts/jobs";
import { uniqueRecipientsInWindow } from "@/lib/broadcasts/portfolio";
import { processBroadcast } from "@/lib/broadcasts/process";
import { TIER_LIMITS, TIER_UP_RULES, nextStep, portfolioLimit, scalingHint, tierLimit } from "@/lib/broadcasts/throttle";
import { matchingContactIds, matchingPhones, MAX_SCAN, previewSegmentFilter } from "@/lib/segments/service";
import { consentHistory, consentRecordedBy, recordChannelConsent } from "@/lib/contacts/consent";
import { upsertContactV1 } from "@/lib/integrations/v1-service";

const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };

beforeEach(() => {
  vi.resetAllMocks();
});

describe("the tier table has one source of truth", () => {
  it("is derived from the messaging-limit module, plus Meta's second spelling of unlimited", () => {
    for (const [name, people] of Object.entries(TIER_PEOPLE)) expect(TIER_LIMITS[name]).toBe(people);
    expect(TIER_LIMITS.UNLIMITED).toBe(Infinity);
    expect(tierLimit("tier_1k")).toBe(1000);
    expect(tierLimit(10_000 as unknown as string)).toBe(10_000);
    expect(tierLimit("TIER_WEIRD")).toBe(250);
    expect(portfolioLimit(["TIER_250", "tier_10k", "TIER_WEIRD", null])).toBe(10_000);
  });
});

describe("how the limit grows", () => {
  it("states Meta's documented thresholds for every level", () => {
    expect(TIER_UP_RULES.map((r) => [r.to, r.uniquePeople, r.days])).toEqual([[10_000, 1_000, 7], [100_000, 5_000, 7], [Infinity, 500_000, 14]]);
    expect(scalingHint("TIER_250")).toMatch(/2,000.*verify your business|verify your business.*2,000/);
    expect(scalingHint("TIER_2K")).toMatch(/10,000 people a day.*at least 1,000 different people within 7 days/);
    expect(scalingHint("TIER_10K")).toMatch(/100,000 people a day.*at least 5,000 different people within 7 days/);
    expect(scalingHint("TIER_100K")).toMatch(/no daily limit.*at least 500,000 different people within 14 days/);
    expect(scalingHint("TIER_UNLIMITED")).toBeNull();
  });
  it("describes the next step as data too", () => {
    expect(nextStep("TIER_10K")).toEqual({ toLimit: 100_000, uniquePeople: 5_000, days: 7, viaVerification: false });
    expect(nextStep("TIER_50")).toMatchObject({ toLimit: 2_000, viaVerification: true });
    expect(nextStep("UNLIMITED")).toBeNull();
  });
});

describe("the portfolio window query", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const columns = (model: string) => {
    const block = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m").exec(schema)?.[1] ?? "";
    return new Set(block.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
  };

  it("only names tables and columns that exist in the schema, and scopes both tables to the workspace", async () => {
    db.$queryRaw.mockResolvedValue([{ n: BigInt(3), oldest: new Date("2026-03-01T00:00:00Z") }]);
    const out = await uniqueRecipientsInWindow("t1", ["p1", "p2"], new Date("2026-03-02T00:00:00Z"));
    expect(out).toEqual({ count: 3, oldest: new Date("2026-03-01T00:00:00Z") });
    const [strings, ...values] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?");
    const message = columns("Message");
    const conversation = columns("Conversation");
    for (const [, alias, col] of sql.matchAll(/\b([mc])\."(\w+)"/g)) expect((alias === "m" ? message : conversation).has(col), `${alias}.${col}`).toBe(true);
    expect(sql).toMatch(/FROM "Message" m/);
    expect(sql).toMatch(/JOIN "Conversation" c ON c\.id = m\."conversationId" AND c\."tenantId" = m\."tenantId"/);
    expect(sql).toMatch(/m\."tenantId" = \?/);
    expect(values[0]).toBe("t1");
    expect(values[2]).toEqual(["p1", "p2"]);
    expect(new Date(values[1] as Date).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    // The values the query compares against exist in the schema's enums and the sender code.
    expect(schema).toMatch(/enum MessageDirection \{[^}]*outbound/);
    expect(schema).toMatch(/enum MessageStatus \{[^}]*failed/);
    expect(readFileSync("src/lib/inbox/service.ts", "utf8")).toContain('type: "template"');
  });

  it("asks nothing when there are no numbers", async () => {
    expect(await uniqueRecipientsInWindow("t1", [], new Date())).toEqual({ count: 0, oldest: null });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("one worker run per broadcast", () => {
  it("takes the lease, and a second run is refused until it is released or has expired", async () => {
    db.platformSetting.create.mockResolvedValueOnce({});
    expect(await acquireRunLease("b1")).toBe(true);
    expect(db.platformSetting.create.mock.calls[0][0].data.key).toBe(leaseKey("b1"));

    db.platformSetting.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    db.platformSetting.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await acquireRunLease("b1")).toBe(false);
    expect(db.platformSetting.updateMany.mock.calls[0][0].where).toMatchObject({ key: leaseKey("b1"), updatedAt: { lt: expect.any(Date) } });

    db.platformSetting.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    db.platformSetting.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await acquireRunLease("b1")).toBe(true);
  });

  it("goes ahead when the database cannot be asked, rather than stopping a broadcast over bookkeeping", async () => {
    db.platformSetting.create.mockRejectedValueOnce(new Error("connection reset"));
    expect(await acquireRunLease("b1")).toBe(true);
    db.platformSetting.deleteMany.mockRejectedValueOnce(new Error("down"));
    await expect(releaseRunLease("b1")).resolves.toBeUndefined();
  });

  it("a run that finds another one working sends nothing and tries again later", async () => {
    db.platformSetting.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    db.platformSetting.updateMany.mockResolvedValueOnce({ count: 0 });
    db.job.findFirst.mockResolvedValue(null);
    await processBroadcast("b1", new Date("2026-03-01T12:00:00Z"));
    expect(db.broadcast.findUnique).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, { runAt: new Date("2026-03-01T12:00:30Z") });
    expect(db.platformSetting.deleteMany).not.toHaveBeenCalled();
  });

  it("releases the lease even when the run throws", async () => {
    db.platformSetting.create.mockResolvedValueOnce({});
    db.broadcast.findUnique.mockRejectedValue(new Error("boom"));
    await expect(processBroadcast("b1")).rejects.toThrow("boom");
    expect(db.platformSetting.deleteMany).toHaveBeenCalledWith({ where: { key: leaseKey("b1") } });
  });

  it("adds a job only when none is waiting, and moves a waiting one earlier when asked for sooner", async () => {
    const later = new Date(Date.now() + 60_000);
    db.job.findFirst.mockResolvedValue({ id: "j1", runAt: later });
    await enqueueBroadcastRun("b1", new Date());
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(db.job.updateMany).toHaveBeenCalledWith({ where: { id: "j1", status: "queued" }, data: { runAt: expect.any(Date) } });

    db.job.updateMany.mockClear();
    db.job.findFirst.mockResolvedValue({ id: "j2", runAt: new Date(Date.now() - 1000) });
    await enqueueBroadcastRun("b1", new Date());
    expect(db.job.updateMany).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();

    db.job.findFirst.mockResolvedValue(null);
    await enqueueBroadcastRun("b1", new Date());
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(db.job.findFirst.mock.calls[0][0].where).toMatchObject({ queue: "broadcast", status: "queued", payload: { path: ["broadcastId"], equals: "b1" } });
  });
});

describe("attribute rules on a very large workspace", () => {
  const filter = [{ all: [{ field: "attr:city", op: "is" as const, value: "Pune" }] }];
  const page = (n: number) => Array.from({ length: 2000 }, (_, i) => ({ id: `c${n}-${i}`, name: null, phone: `+9198${n}${i}`, bsuid: null, tags: [], attributes: { city: i === 0 ? "Pune" : "Delhi" }, optInSource: null, optInAt: null, createdAt: new Date(), leadStage: null, ownerUserId: null, username: null }));

  it("stops instead of freezing a partial audience, but still lets previews and samples say 'partial'", async () => {
    let n = 0;
    db.contact.findMany.mockImplementation(async () => page(n++));
    await expect(matchingContactIds("t1", { tenantId: "t1" }, filter)).rejects.toThrow(new RegExp(`more than ${MAX_SCAN.toLocaleString()} contacts`));
    n = 0;
    await expect(matchingPhones("t1", { tenantId: "t1" }, filter)).rejects.toThrow(/too many/);
    n = 0;
    const partial = await matchingContactIds("t1", { tenantId: "t1" }, filter, new Date(), { allowPartial: true });
    expect(partial.length).toBeGreaterThan(0);
    n = 0;
    db.contact.count.mockResolvedValue(0);
    const preview = await previewSegmentFilter(actor, { filter: filter[0] });
    expect(preview.truncated).toBe(true);
  }, 20_000);

  it("is complete for an ordinary workspace", async () => {
    db.contact.findMany.mockResolvedValueOnce(page(0).slice(0, 5));
    expect(await matchingContactIds("t1", { tenantId: "t1" }, filter)).toEqual(["c0-0"]);
  });
});

describe("consent from the public API, lead forms and chatbots", () => {
  const body = { phone: "+919800000001", optIn: true, optInSource: "pos checkout" };

  it("records who and where for a new opt-in through the API", async () => {
    db.contact.findFirst.mockResolvedValue(null);
    db.contact.create.mockResolvedValue({ id: "c1", phone: "+919800000001", tags: [], attributes: {}, optIn: true, optInAt: new Date(), optedOutAt: null, createdAt: new Date(), name: null });
    await upsertContactV1(actor, body);
    expect(db.contact.create.mock.calls[0][0].data).toMatchObject({ optIn: true, optInSource: "pos checkout" });
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: "t1", userId: "u1", action: "contact.consent_recorded", target: "c1", meta: { source: "pos checkout", via: "api" } }) });
  });

  it("keeps the original source and time when the API repeats optIn for a contact who already agreed", async () => {
    const first = new Date("2026-01-05T09:00:00Z");
    db.contact.findFirst.mockResolvedValue({ id: "c1", phone: "+919800000001", optIn: true, optInAt: first, optInSource: "website form", optedOutAt: null, tags: [], attributes: {} });
    await upsertContactV1(actor, { ...body, name: "Asha" });
    const data = db.contact.updateMany.mock.calls[0][0].data;
    expect(data).toEqual({ name: "Asha" });
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("writes a withdrawal row when the API turns consent off", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c1", phone: "+919800000001", optIn: true, optInAt: new Date(), optInSource: "x", optedOutAt: null, tags: [], attributes: {} });
    await upsertContactV1(actor, { phone: "+919800000001", optIn: false });
    expect(db.contact.updateMany.mock.calls[0][0].data).toMatchObject({ optIn: false });
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "contact.consent_withdrawn", target: "c1" }) });
  });

  it("shows a form or chatbot opt-in as given by the contact, in the history and the export", async () => {
    await recordChannelConsent("t1", "c1", { source: "lead_form", via: "lead_form" });
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: null, action: "contact.consent_recorded", meta: { source: "lead_form", via: "lead_form" } }) });

    db.contact.findFirst.mockResolvedValue({ optIn: true, optInSource: "lead_form", optInAt: new Date(), optedOutAt: null });
    db.auditLog.findMany.mockResolvedValue([{ action: "contact.consent_recorded", userId: null, createdAt: new Date(), meta: { source: "lead_form", via: "lead_form" } }]);
    const history = await consentHistory(actor, "c1");
    expect(history.events[0]).toMatchObject({ kind: "opt_in", source: "lead_form", by: "contact" });

    db.auditLog.findMany.mockResolvedValue([
      { target: "c1", userId: null, meta: { source: "Chatbot", via: "chatbot" } },
      { target: "c2", userId: null, meta: { source: "import" } },
    ]);
    db.user.findMany.mockResolvedValue([]);
    const who = await consentRecordedBy("t1", ["c1", "c2"]);
    expect(who.get("c1")).toMatch(/chatbot/);
    expect(who.has("c2")).toBe(false);
  });
});
