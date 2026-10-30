import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn(), count: vi.fn(), groupBy: vi.fn(), upsert: vi.fn() });
  return { team: model(), teamMember: model(), conversation: model(), message: model(), contact: model(), membership: model(), platformSetting: model(), lead: model(), auditLog: { create: vi.fn() } };
});
const auth = vi.hoisted(() => ({ role: "agent" as "agent" | "admin" | "owner", userId: "me" }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: auth.userId, tenantId: "t1", role: auth.role }) }));
vi.mock("@/lib/segments/service", () => ({ contactWhereForSegment: vi.fn(async () => ({ tags: { has: "seg" } })) }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: vi.fn() }));
vi.mock("@/lib/automation/v2/emit", () => ({ emitAutomationEvent: vi.fn(), emitAttributeChanges: vi.fn(), emitTagChanges: vi.fn() }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: vi.fn() }));

import { PATCH as contactFieldsRoute } from "@/app/api/teams/contacts/[id]/route";
import { GET as contextRoute } from "@/app/api/inbox/conversations/[id]/context/route";
import { GET as contactsRoute } from "@/app/api/contacts/route";
import { PATCH as contactPatchRoute } from "@/app/api/contacts/[id]/route";
import { identitySearchFilter } from "@/lib/contacts/identity";
import { countUnreadConversations, createInboxStream } from "@/lib/inbox/stream";
import { unverifiedMayWrite } from "@/lib/auth/verification";
import { DEFAULT_EXTRA, type RoutingExtra } from "@/lib/routing/extra";
import { peopleForTeam, type TeamRow } from "@/components/teams/helpers";
import { assertInTeamPool } from "@/lib/teams/pool";
import { assertContactVisible, contactScopeWhere, maskLeadFields, maskedSearchWhere, viewerRules, visibleIdsFilter } from "@/lib/teams/visibility";

const ORIGIN = "https://wa.edwyz.com";
const actor = { tenantId: "t1", userId: "me", role: "agent" as const };
const patch = (body: unknown) => new Request(`${ORIGIN}/x`, { method: "PATCH", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) });
const ctx = { params: Promise.resolve({ id: "k1" }) };
const settings = (extra: Partial<RoutingExtra>) => db.platformSetting.findUnique.mockResolvedValue({ value: { ...DEFAULT_EXTRA, ...extra } });

beforeEach(() => {
  vi.resetAllMocks();
  auth.role = "agent";
  auth.userId = "me";
  db.platformSetting.findUnique.mockResolvedValue(undefined);
});

describe("masked phone search", () => {
  it("treats a query with dots like any other number query, so it cannot slide along the number", () => {
    expect(maskedSearchWhere("12.34")).toEqual({ contact: { phone: { endsWith: "1234" } } });
    expect(maskedSearchWhere("1-2 3(4)")).toEqual({ contact: { phone: { endsWith: "1234" } } });
    expect(maskedSearchWhere("Asha")).toBeNull();
  });

  it("limits contact searches to the end of the number and keeps digits in text away from the phone column", () => {
    const keys = (f: Array<Record<string, unknown>>) => f.map((x) => Object.keys(x)[0]);
    expect(identitySearchFilter("3210", { maskedPhone: true })).toContainEqual({ phone: { endsWith: "3210" } });
    expect(identitySearchFilter("x5678", { maskedPhone: true })).toContainEqual({ name: { contains: "x5678", mode: "insensitive" } });
    expect(keys(identitySearchFilter("x5678", { maskedPhone: true }))).not.toContain("phone");
    expect(identitySearchFilter("12.34", { maskedPhone: true })).toContainEqual({ phone: { endsWith: "1234" } });
    expect(identitySearchFilter("x5678")).toContainEqual({ phone: { contains: "5678" } });
  });

  it("applies the masked search and the viewer's scope to the contacts list", async () => {
    settings({ maskPhone: { allAgents: true, userIds: [] }, viewOnlyAssigned: { allAgents: true, userIds: [] } });
    db.contact.findMany.mockResolvedValue([]);
    const res = await contactsRoute(new Request(`${ORIGIN}/api/contacts?q=x5678&segmentId=s1`));
    expect(res.status).toBe(200);
    const where = db.contact.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t1");
    expect(where.OR.map((x: object) => Object.keys(x)[0])).not.toContain("phone");
    expect(where.AND).toContainEqual({ OR: [{ ownerUserId: "me" }, { conversations: { some: { assignedToId: "me" } } }] });
    expect(where.AND).toContainEqual({ tags: { has: "seg" } });
  });

  it("does not scope the contacts list for an admin", async () => {
    auth.role = "admin";
    db.contact.findMany.mockResolvedValue([]);
    await contactsRoute(new Request(`${ORIGIN}/api/contacts`));
    expect(db.contact.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
  });
});

describe("contact scope", () => {
  it("lets a view-only agent see only contacts they own or are assigned a chat with", async () => {
    settings({ viewOnlyAssigned: { allAgents: true, userIds: [] } });
    const rules = await viewerRules(actor);
    expect(contactScopeWhere(actor, rules)).toEqual({ OR: [{ ownerUserId: "me" }, { conversations: { some: { assignedToId: "me" } } }] });
    db.contact.findFirst.mockResolvedValue(null);
    await expect(assertContactVisible(actor, "k9")).rejects.toMatchObject({ status: 404 });
    expect(db.contact.findFirst.mock.calls[0][0].where).toMatchObject({ id: "k9", tenantId: "t1" });
    db.contact.findFirst.mockResolvedValue({ id: "k1" });
    await expect(assertContactVisible(actor, "k1")).resolves.toBeUndefined();
  });

  it("applies the same check before an agent edits a contact", async () => {
    settings({ viewOnlyAssigned: { allAgents: true, userIds: [] } });
    db.contact.findFirst.mockResolvedValue(null);
    expect((await contactPatchRoute(patch({ name: "x" }), ctx)).status).toBe(404);
    expect(db.contact.updateMany).not.toHaveBeenCalled();
  });
});

describe("contact owner and stage", () => {
  beforeEach(() => {
    db.membership.findFirst.mockResolvedValue({ id: "m1" });
    db.contact.updateMany.mockResolvedValue({ count: 1 });
    db.contact.findFirst.mockResolvedValue({ id: "k1", ownerUserId: null, leadStage: null });
  });

  it("lets an agent set the stage on a contact they can see and take an unowned contact", async () => {
    expect((await contactFieldsRoute(patch({ leadStage: "Contacted" }), ctx)).status).toBe(200);
    expect((await contactFieldsRoute(patch({ ownerUserId: "me" }), ctx)).status).toBe(200);
  });

  it("stops an agent moving a contact to someone else or taking one that has an owner", async () => {
    expect((await contactFieldsRoute(patch({ ownerUserId: "other" }), ctx)).status).toBe(403);
    db.contact.findFirst.mockResolvedValue({ id: "k1", ownerUserId: "boss", leadStage: null });
    expect((await contactFieldsRoute(patch({ ownerUserId: "me" }), ctx)).status).toBe(403);
    expect((await contactFieldsRoute(patch({ ownerUserId: null }), ctx)).status).toBe(403);
    expect(db.contact.updateMany).not.toHaveBeenCalled();
  });

  it("stops a view-only agent changing a contact they cannot see", async () => {
    settings({ viewOnlyAssigned: { allAgents: true, userIds: [] }, leadStages: ["Contacted"] });
    db.contact.findFirst.mockResolvedValueOnce(null);
    expect((await contactFieldsRoute(patch({ leadStage: "Contacted" }), ctx)).status).toBe(404);
    expect(db.contact.updateMany).not.toHaveBeenCalled();
  });

  it("lets an admin set any owner", async () => {
    auth.role = "admin";
    expect((await contactFieldsRoute(patch({ ownerUserId: "other" }), ctx)).status).toBe(200);
  });
});

describe("conversation context for restricted agents", () => {
  it("masks phone-like lead answers and limits other chats to the viewer's scope", async () => {
    settings({ maskPhone: { allAgents: true, userIds: [] }, viewOnlyAssigned: { allAgents: true, userIds: [] } });
    db.conversation.findFirst.mockResolvedValue({ id: "c1", contactId: "k1", contact: { createdAt: new Date() } });
    db.lead.findFirst.mockResolvedValue({ id: "l1", status: "new", createdAt: new Date(), fields: { phone_number: "+919876543210", city: "Pune", hotel: "Taj" }, adMetaId: null, campaignMetaId: null, consentAt: null, assignedToId: null, leadForm: null });
    db.message.count.mockResolvedValue(1);
    db.conversation.findMany.mockResolvedValue([]);
    const res = await contextRoute(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ id: "c1" }) });
    const body = await res.json();
    expect(body.lead.fields).toEqual([
      { label: "phone number", value: "+919*****3210" },
      { label: "city", value: "Pune" },
      { label: "hotel", value: "Taj" },
    ]);
    expect(db.conversation.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", contactId: "k1", assignedToId: "me" });
  });

  it("only masks fields that look like phone numbers", () => {
    const out = maskLeadFields([{ label: "mobile", value: "9876543210" }, { label: "note", value: "call 9876543210 now" }, { label: "city", value: "Pune" }], true);
    expect(out.map((f) => f.value)).toEqual(["987***3210", "call 9876543210 now", "Pune"]);
    expect(maskLeadFields([{ label: "mobile", value: "9876543210" }], false)[0].value).toBe("9876543210");
  });
});

describe("live stream and unread count for restricted agents", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends only the chats the listener may see, and nothing when none qualify", async () => {
    const T0 = new Date("2026-10-27T12:00:00Z");
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ changes: [{ conversationId: "hidden", at: new Date(T0.getTime() + 1) }] })
      .mockResolvedValueOnce({ changes: [{ conversationId: "hidden", at: new Date(T0.getTime() + 2) }, { conversationId: "mine", at: new Date(T0.getTime() + 3) }] })
      .mockResolvedValue({ changes: [] });
    const filter = vi.fn(async (ids: string[]) => ids.filter((id) => id === "mine"));
    const stream = createInboxStream({ tenantId: "t1", signal: new AbortController().signal, release: vi.fn(), poll, filter, now: () => T0, maxLifetimeMs: 60_000 });
    const reader = stream.getReader();
    let text = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += new TextDecoder().decode(value);
      }
    })();
    await vi.advanceTimersByTimeAsync(2100);
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("event: update");
    await vi.advanceTimersByTimeAsync(2000);
    expect(text).toContain('data: {"conversationIds":["mine"]}');
    expect(text).not.toContain("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    await pump;
  });

  it("builds a filter from the viewer's rules, and none for an admin", async () => {
    vi.useRealTimers();
    settings({ viewOnlyAssigned: { allAgents: true, userIds: [] } });
    db.conversation.findMany.mockResolvedValue([{ id: "mine" }]);
    const filter = await visibleIdsFilter(actor);
    expect(await filter!(["mine", "hidden"])).toEqual(["mine"]);
    expect(db.conversation.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", id: { in: ["mine", "hidden"] }, assignedToId: "me" });
    expect(await visibleIdsFilter({ ...actor, role: "admin" })).toBeNull();
  });

  it("counts unread chats inside the viewer's scope", async () => {
    vi.useRealTimers();
    db.conversation.count.mockResolvedValue(2);
    await countUnreadConversations("t1", { assignedToId: "me" });
    expect(db.conversation.count).toHaveBeenCalledWith({ where: { tenantId: "t1", unreadCount: { gt: 0 }, assignedToId: "me" } });
    await countUnreadConversations("t1");
    expect(db.conversation.count).toHaveBeenLastCalledWith({ where: { tenantId: "t1", unreadCount: { gt: 0 } } });
  });
});

describe("team pool for manual assignment", () => {
  it("accepts anyone for chats with no team or an empty team, and only members otherwise", async () => {
    await expect(assertInTeamPool("t1", null, "z")).resolves.toBeUndefined();
    db.team.findFirst.mockResolvedValue({ id: "tm1" });
    db.teamMember.findMany.mockResolvedValue([]);
    await expect(assertInTeamPool("t1", "tm1", "z")).resolves.toBeUndefined();
    db.teamMember.findMany.mockResolvedValue([{ userId: "b" }]);
    await expect(assertInTeamPool("t1", "tm1", "z")).rejects.toMatchObject({ status: 400 });
    await expect(assertInTeamPool("t1", "tm1", "b")).resolves.toBeUndefined();
  });
});

describe("unverified email allow-list for teams", () => {
  it("allows team settings but not putting chats in teams or changing contact owners", () => {
    expect(unverifiedMayWrite("/api/teams")).toBe(true);
    expect(unverifiedMayWrite("/api/teams/t1")).toBe(true);
    expect(unverifiedMayWrite("/api/teams/t1/members")).toBe(true);
    expect(unverifiedMayWrite("/api/teams/assign")).toBe(false);
    expect(unverifiedMayWrite("/api/teams/contacts/k1")).toBe(false);
  });
});

describe("people picker inside a team", () => {
  const team = (id: string, memberIds: string[], isDefault = false): TeamRow => ({ id, name: id, isDefault, memberIds, createdAt: "" });
  const people = [{ userId: "a" }, { userId: "b" }, { userId: "c" }];

  it("lists only the team's people, keeps the current person, and falls back to everyone for an empty team", () => {
    const teams = [team("def", [], true), team("sales", ["a", "b"])];
    expect(peopleForTeam(teams, "sales", people).map((p) => p.userId)).toEqual(["a", "b"]);
    expect(peopleForTeam(teams, "sales", people, "c").map((p) => p.userId)).toEqual(["a", "b", "c"]);
    expect(peopleForTeam(teams, null, people)).toEqual(people);
    expect(peopleForTeam([], "sales", people)).toEqual(people);
  });
});
