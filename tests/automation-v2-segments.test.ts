import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ segments: [] as { id: string; tenantId: string; name: string; filter: unknown }[] }));
const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), count: vi.fn(), deleteMany: vi.fn() });
  return { segment: model(), contact: model(), conversation: model(), chatbotSession: model(), message: model(), ruleExecution: model(), platformSetting: model(), automationRun: model(), plan: model() };
});
const svc = vi.hoisted(() => ({ sendText: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/inbox/service", () => svc);
vi.mock("@/lib/routing", () => ({ assignConversation: vi.fn() }));
vi.mock("@/lib/chatbots", () => ({ startChatbot: vi.fn() }));
vi.mock("@/lib/ai-agent", () => ({ handleInboundForAiAgent: vi.fn(), STOP_TAG: "ai:stopped" }));
vi.mock("@/lib/email", () => ({ queueEmail: vi.fn() }));
vi.mock("@/lib/leads/runner", () => ({ processRun: vi.fn() }));
vi.mock("@/lib/billing/status", () => ({ getBillingStatus: vi.fn().mockResolvedValue({ state: "exempt", planId: null }) }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: vi.fn().mockResolvedValue(true) }));

import { fireRules, type RuleRow } from "@/lib/automation/v2/run";
import { segmentMembership } from "@/lib/automation/v2/segments";
import { createSegment } from "@/lib/segments/service";
import type { Actor } from "@/lib/tenancy";

const NOW = new Date("2026-10-27T10:00:00Z");
const actor = { tenantId: "t1", userId: "u1", role: "admin" } as unknown as Actor;
let contactRow: Record<string, unknown>;

const snapshot = () => ({
  id: "c1",
  name: "Asha Rao",
  phone: "+919876543210",
  bsuid: null,
  tags: ["vip"],
  attributes: { city: "Shimla" },
  optInSource: null,
  optInAt: null,
  createdAt: new Date("2026-01-01"),
  leadStage: null,
  ownerUserId: null,
  optIn: true,
  optedOutAt: null,
  conversations: [{ lastInboundAt: new Date("2026-10-26") }],
  ...contactRow,
});

const ruleIn = (segmentId: string, member: boolean): RuleRow => ({
  id: `rule-${member}`,
  name: "Segment rule",
  phoneNumberId: null,
  priority: 10,
  cooldownMinutes: 5,
  stopAfterMatch: false,
  createdAt: new Date(1),
  version: 2,
  enabled: true,
  trigger: { type: "message_received" },
  filters: { root: { type: "group", op: "and", items: [{ type: "segment", segmentId, member }] }, options: { allowWhenHumanActive: false } },
  actions: [{ type: "add_tag", tag: "seen", scope: "contact" }],
});

beforeEach(() => {
  vi.clearAllMocks();
  store.segments = [];
  contactRow = {};
  db.segment.count.mockResolvedValue(0);
  db.segment.findFirst.mockResolvedValue(null);
  db.segment.create.mockImplementation(async ({ data }) => {
    const row = { id: `seg${store.segments.length + 1}`, ...data };
    store.segments.push(row);
    return row;
  });
  db.segment.findMany.mockImplementation(async ({ where }) => store.segments.filter((s) => s.tenantId === where.tenantId && where.id.in.includes(s.id)));
  db.contact.findFirst.mockImplementation(async () => snapshot());
  db.conversation.findFirst.mockResolvedValue({ id: "cv1", phoneNumberId: "ph1", assignedToId: null, tags: [], teamId: null, lastInboundAt: NOW, status: "open" });
  db.chatbotSession.findFirst.mockResolvedValue(null);
  db.message.findFirst.mockResolvedValue(null);
  db.ruleExecution.findFirst.mockResolvedValue(null);
  db.ruleExecution.count.mockResolvedValue(0);
  db.ruleExecution.create.mockResolvedValue({});
  db.platformSetting.findUnique.mockResolvedValue(null);
  db.platformSetting.create.mockResolvedValue({});
  db.platformSetting.deleteMany.mockResolvedValue({ count: 1 });
  db.automationRun.findFirst.mockResolvedValue(null);
  db.contact.updateMany.mockResolvedValue({ count: 1 });
});

const event = { type: "message_received" as const, tenantId: "t1", contactId: "c1", conversationId: "cv1", at: NOW, message: { text: "hi", messageType: "text", newChat: false, silentMinutes: 5, phoneNumberId: "ph1", answeredBy: null } };

describe("segments saved by the real segments service", () => {
  it("a tag segment matches the contact who has the tag and not the one who lacks it", async () => {
    const seg = await createSegment(actor, { name: "VIPs", filter: { all: [{ field: "tag", op: "has", value: "vip" }] } });
    expect([...(await segmentMembership("t1", "c1", [seg.id], NOW))]).toEqual([seg.id]);
    contactRow = { tags: [] };
    expect((await segmentMembership("t1", "c1", [seg.id], NOW)).size).toBe(0);
  });

  it("understands detail (attr:) conditions, countries and last-message conditions", async () => {
    const city = await createSegment(actor, { name: "Shimla", filter: { all: [{ field: "attr:city", op: "is", value: "shimla" }] } });
    const india = await createSegment(actor, { name: "India", filter: { any: [{ field: "country", op: "is", value: "IN" }] } });
    const recent = await createSegment(actor, { name: "Recent", filter: { all: [{ field: "lastInbound", op: "within_days", value: "7" }] } });
    const quiet = await createSegment(actor, { name: "Quiet", filter: { all: [{ field: "lastInbound", op: "older_than_days", value: "7" }] } });
    const got = await segmentMembership("t1", "c1", [city.id, india.id, recent.id, quiet.id], NOW);
    expect([...got].sort()).toEqual([city.id, india.id, recent.id].sort());
  });

  it("only looks at segments of this workspace", async () => {
    const seg = await createSegment(actor, { name: "VIPs", filter: { all: [{ field: "tag", op: "has", value: "vip" }] } });
    expect((await segmentMembership("t2", "c1", [seg.id], NOW)).size).toBe(0);
    expect(db.contact.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t2" });
  });

  it("an 'in segment' rule fires for members only and a 'not in segment' rule for everyone else", async () => {
    const seg = await createSegment(actor, { name: "VIPs", filter: { all: [{ field: "tag", op: "has", value: "vip" }] } });
    expect((await fireRules(event, [ruleIn(seg.id, true)])).fired).toBe(1);
    expect((await fireRules(event, [ruleIn(seg.id, false)])).fired).toBe(0);
    contactRow = { tags: [] };
    expect((await fireRules(event, [ruleIn(seg.id, true)])).fired).toBe(0);
    expect((await fireRules(event, [ruleIn(seg.id, false)])).fired).toBe(1);
  });

  it("a segment whose filter can no longer be read matches nobody", async () => {
    store.segments.push({ id: "old", tenantId: "t1", name: "Old", filter: { all: [{ field: "spend", op: "gt", value: 5 }] } });
    expect((await segmentMembership("t1", "c1", ["old"], NOW)).size).toBe(0);
  });
});
