import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const store = vi.hoisted(() => ({
  conversations: [] as Record<string, any>[],
  leads: [] as Record<string, any>[],
  contacts: [] as Record<string, any>[],
  events: [] as Record<string, any>[],
  jobs: [] as { queue: string; payload: any }[],
  seq: 0,
}));
const graph = vi.hoisted(() => ({ graphFetchAs: vi.fn() }));
const connect = vi.hoisted(() => ({ listAssets: vi.fn(), getAssetAccess: vi.fn() }));

const dbNull = vi.hoisted(() => ({ marker: Symbol("DbNull") }));
const refOf = (c: Row) => (c.referral === undefined || c.referral === null ? null : c.referral);

const db = vi.hoisted(() => ({}) as Record<string, any>);
Object.assign(db, {
  conversation: {
    updateMany: async ({ where, data }: Row) => {
      const hit = store.conversations.filter((c) => c.id === where.id && c.tenantId === where.tenantId && refOf(c) === null);
      for (const c of hit) c.referral = data.referral;
      return { count: hit.length };
    },
    findFirst: async ({ where }: Row) => {
      const c = store.conversations
        .filter((x) => x.tenantId === where.tenantId && x.contactId === where.contactId && refOf(x) !== null)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      return c ? { referral: c.referral, phoneNumber: c.phoneNumber } : null;
    },
  },
  lead: {
    findFirst: async ({ where }: Row) => {
      const l = store.leads.find((x) => x.id === where.id && x.tenantId === where.tenantId);
      return l ? { ...l } : null;
    },
    updateMany: async ({ where, data }: Row) => {
      const l = store.leads.find((x) => x.id === where.id && x.tenantId === where.tenantId);
      if (l) Object.assign(l, data);
      return { count: l ? 1 : 0 };
    },
  },
  contact: {
    findFirst: async ({ where }: Row) => {
      const c = store.contacts.find((x) => x.id === where.id && x.tenantId === where.tenantId);
      return c ? { ...c } : null;
    },
    findMany: async () => [],
  },
  leadForm: { findMany: async () => [] },
  leadSequenceRun: { findMany: async () => [] },
  conversionEvent: {
    findFirst: async ({ where }: Row) => {
      if ("id" in where) return store.events.find((e) => e.id === where.id && e.tenantId === where.tenantId) ?? null;
      return (
        store.events.find(
          (e) => e.tenantId === where.tenantId && e.eventName === where.eventName && where.status.in.includes(e.status) && ("leadId" in where && where.leadId ? e.leadId === where.leadId : e.contactId === where.contactId && e.leadId === null),
        ) ?? null
      );
    },
    create: async ({ data }: Row) => {
      const row = { id: `ev${++store.seq}`, attempts: 0, response: null, createdAt: new Date(), ...data };
      store.events.push(row);
      return { id: row.id };
    },
    update: async ({ where, data }: Row) => Object.assign(store.events.find((e) => e.id === where.id)!, data),
  },
  platformSetting: { findUnique: async () => null },
});

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/auth/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/queue", () => ({ enqueue: async (queue: string, payload: unknown) => void store.jobs.push({ queue, payload }) }));
vi.mock("@/lib/meta-connect", () => connect);
vi.mock("@/lib/graph", async () => {
  class GraphError extends Error {
    constructor(message: string, public status: number, public code?: number, public subcode?: number, public retryable = false) {
      super(message);
    }
  }
  return { GraphError, graphFetchAs: graph.graphFetchAs };
});

import { Prisma } from "@/generated/prisma/client";
import { captureReferral, parseReferral } from "@/lib/conversions/referral";
import { worker } from "@/lib/conversions/worker";
import { updateLead } from "@/lib/leads/service";
import { sha256 } from "@/lib/conversions/payload";
import type { Actor } from "@/lib/tenancy";

void dbNull;
void Prisma;
const actor = { userId: "u1", tenantId: "t1", role: "admin" } as Actor;
const handler = worker.queues.conversions;
const runJobs = async () => {
  while (store.jobs.length) {
    const job = store.jobs.shift()!;
    await handler(job.payload, { isLastAttempt: false } as never);
  }
};

const inboundAdMessage = {
  from: "919876543210",
  id: "wamid.1",
  type: "text",
  text: { body: "Hi, I saw your ad" },
  referral: { source_url: "https://fb.me/ad", source_id: "ad-77", source_type: "ad", headline: "Free check-up", ctwa_clid: "AR-click-123", junk: "<script>" },
};

beforeEach(() => {
  graph.graphFetchAs.mockReset();
  connect.listAssets.mockReset();
  connect.getAssetAccess.mockReset();
  store.conversations = [{ id: "cv1", tenantId: "t1", contactId: "c1", referral: null, createdAt: new Date("2026-10-20"), phoneNumber: { waba: { wabaId: "waba-555" } } }];
  store.contacts = [{ id: "c1", tenantId: "t1", phone: "+919876543210", attributes: {}, optedOutAt: null }];
  store.leads = [{ id: "l1", tenantId: "t1", contactId: "c1", fields: { email: "Asha@Example.com" }, status: "new", assignedToId: null }];
  store.events = [];
  store.jobs = [];
  store.seq = 0;
  graph.graphFetchAs.mockResolvedValue({ events_received: 1 });
  connect.listAssets.mockResolvedValue([{ id: "ds1", type: "dataset", externalId: "dataset-9", name: "DS", status: "active", meta: {} }]);
  connect.getAssetAccess.mockResolvedValue({ assetId: "ds1", type: "dataset", externalId: "dataset-9", name: "DS", token: "tok" });
  Object.assign(db.lead, { findMany: async () => [] });
});

describe("click-to-WhatsApp conversion, end to end", () => {
  it("referral on the first message -> lead qualified -> job -> event to Meta with the click id and WABA", async () => {
    const referral = parseReferral(inboundAdMessage);
    expect(referral).toMatchObject({ ctwaClid: "AR-click-123", sourceId: "ad-77" });
    expect(JSON.stringify(referral)).not.toContain("script");
    expect(await captureReferral("t1", "cv1", referral)).toBe(true);

    await updateLead(actor, "l1", { status: "qualified" });
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ tenantId: "t1", leadId: "l1", eventName: "QualifiedLead", status: "pending" });
    expect(store.jobs).toEqual([{ queue: "conversions", payload: { tenantId: "t1", conversionEventId: "ev1" } }]);

    await runJobs();
    expect(graph.graphFetchAs).toHaveBeenCalledTimes(1);
    const [token, call] = graph.graphFetchAs.mock.calls[0];
    expect(token).toBe("tok");
    expect(call).toMatchObject({ path: "dataset-9/events", method: "POST" });
    const event = call.body.data[0];
    expect(event).toMatchObject({ event_name: "QualifiedLead", action_source: "business_messaging", messaging_channel: "whatsapp" });
    expect(event.user_data).toMatchObject({ ctwa_clid: "AR-click-123", whatsapp_business_account_id: "waba-555" });
    expect(event.user_data.em).toEqual([sha256("asha@example.com")]);
    expect(event.user_data.ph).toEqual([sha256("919876543210")]);
    expect(JSON.stringify(call.body)).not.toContain("Asha@Example.com");
    expect(JSON.stringify(call.body)).not.toContain("919876543210\"");
    expect(store.events[0]).toMatchObject({ status: "sent", datasetId: "dataset-9" });
  });

  it("winning the lead sends a Purchase for the same click, once", async () => {
    await captureReferral("t1", "cv1", parseReferral(inboundAdMessage));
    await updateLead(actor, "l1", { status: "qualified" });
    await updateLead(actor, "l1", { status: "won" });
    await runJobs();
    const names = graph.graphFetchAs.mock.calls.map((c) => c[1].body.data[0].event_name);
    expect(names).toEqual(["QualifiedLead", "Purchase"]);
    expect(graph.graphFetchAs.mock.calls.every((c) => c[1].body.data[0].user_data.ctwa_clid === "AR-click-123")).toBe(true);
    await updateLead(actor, "l1", { status: "qualified" });
    await updateLead(actor, "l1", { status: "won" });
    expect(store.events).toHaveLength(2);
  });

  it("the first referral wins: a later ad click does not replace the stored click id", async () => {
    await captureReferral("t1", "cv1", parseReferral(inboundAdMessage));
    expect(await captureReferral("t1", "cv1", { ctwa_clid: "AR-other", source_id: "ad-99" })).toBe(false);
    await updateLead(actor, "l1", { status: "qualified" });
    await runJobs();
    expect(graph.graphFetchAs.mock.calls[0][1].body.data[0].user_data.ctwa_clid).toBe("AR-click-123");
  });

  it("a contact who never came from an ad is sent without a click id", async () => {
    await updateLead(actor, "l1", { status: "qualified" });
    await runJobs();
    const event = graph.graphFetchAs.mock.calls[0][1].body.data[0];
    expect(event.action_source).toBe("system_generated");
    expect(event.user_data.ctwa_clid).toBeUndefined();
    expect(event.user_data.whatsapp_business_account_id).toBeUndefined();
  });

  it("never uses another workspace's referral for the same contact id", async () => {
    store.conversations.push({ id: "cvx", tenantId: "t2", contactId: "c1", referral: { ctwaClid: "OTHER-TENANT" }, createdAt: new Date("2026-10-25"), phoneNumber: { waba: { wabaId: "waba-other" } } });
    await updateLead(actor, "l1", { status: "qualified" });
    await runJobs();
    const user = graph.graphFetchAs.mock.calls[0][1].body.data[0].user_data;
    expect(user.ctwa_clid).toBeUndefined();
    expect(JSON.stringify(graph.graphFetchAs.mock.calls)).not.toContain("OTHER-TENANT");
  });

  it("an opted-out contact is skipped and nothing reaches Meta", async () => {
    await captureReferral("t1", "cv1", parseReferral(inboundAdMessage));
    store.contacts[0].optedOutAt = new Date();
    await updateLead(actor, "l1", { status: "qualified" });
    await runJobs();
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(store.events[0]).toMatchObject({ status: "skipped", response: { reason: "opted_out" } });
  });

  it("no connected dataset: the event is skipped with a reason, not lost silently", async () => {
    await captureReferral("t1", "cv1", parseReferral(inboundAdMessage));
    connect.listAssets.mockResolvedValue([]);
    await updateLead(actor, "l1", { status: "qualified" });
    await runJobs();
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(store.events[0]).toMatchObject({ status: "skipped", response: { reason: "no_dataset" } });
  });
});
