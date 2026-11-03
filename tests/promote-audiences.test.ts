import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Row } from "./helpers/fake-db";

/**
 * docs/IG-PAGE-ADS-SPEC.md 3.7, D17, 4.2 A1 to A6, 4.8, 4.10, 5.1, 5.5, 11.1a decision 3 and PRM-11 acceptance 2, 3, 4, 5 and
 * 6 (promote-audiences):
 * - customer lists count only consented contacts who are not erased or opted out; under 100 people the audience is too_small
 *   and Meta is not called at all; missing Custom Audience terms answer with the custom_audience_tos fix; the request makes the
 *   list on Meta and only queues its people (no A2 in the request, 202), and the upload task sends 25,000 people in 3 batches
 *   of one session with idempotent batch_seq, so a retry never resends a batch Meta acknowledged, at most UPLOAD_RUN_MS of new
 *   batches a run; a refresh uses usersreplace; the 51st customer list is refused;
 * - with customer lists switched off (PROMOTE_AUDIENCES below all, or production without LEGAL_DPDP_AUDIENCES_OK) no open
 *   upload sends another row, and a ready list can't be used at launch (audienceKindOffered);
 * - lookalikes need a seed of at least 100 and are blocked for special categories; engagement and website retention bounds;
 * - delete calls Meta before deletedAt; 2655, 1870090, 471 and 1713232 map to the 4.10 copy, and every other Meta error to
 *   plain words (190 reconnect, permissions, Meta refusing);
 * - the 6-hourly sync stamps failures so they drop behind healthy audiences, and a busy ad account doesn't stop the others;
 * - each PROMOTE_AUDIENCES level allows only its kinds, and production refuses customer lists without LEGAL_DPDP_AUDIENCES_OK=1;
 * - forgetContact queues hashes for every customer-list audience and the job sends A4, retrying for 7 days while the Meta
 *   connection is down; the opt-out sweep picks only withdrawals from the last 26 hours (or since an older cursor), opt-outs and
 *   audited consent withdrawals alike; the job payload never reaches a log and is deleted once done;
 * - the routes: agents get 403 on writes, the rate limits answer 429, and everything is 404 while PROMOTE_ENABLED=off.
 * Meta is a fake; the service tests use in-memory dependencies, the forget and route tests an in-memory Prisma.
 */
const h = vi.hoisted(() => ({
  getActor: vi.fn(),
  db: null as unknown as import("./helpers/fake-db").FakeDb,
  prisma: null as unknown as Record<string, unknown>,
  seq: 0,
  meta: {
    createCustomAudience: vi.fn(),
    addAudienceUsers: vi.fn(),
    replaceAudienceUsers: vi.fn(),
    removeAudienceUsers: vi.fn(),
    getAudience: vi.fn(),
    deleteAudience: vi.fn(),
    getAdAccountHealth: vi.fn(),
    estimateReach: vi.fn(),
  },
  runDueJobs: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ getActor: (...a: unknown[]) => h.getActor(...a) }));
vi.mock("@/lib/promote/meta", () => ({ promoteMeta: h.meta }));
vi.mock("@/lib/queue", () => ({ runDueJobs: (...a: unknown[]) => h.runDueJobs(...a) }));
vi.mock("@/lib/db", async () => {
  // fake-db, with ids and column defaults on create the way Postgres would give them.
  const { createFakeDb } = await import("./helpers/fake-db");
  h.db = createFakeDb();
  const defaults: Record<string, () => Row> = {
    adAudience: () => ({ id: `aud_db${++h.seq}`, createdAt: new Date(), updatedAt: new Date(), deletedAt: null, sizeLower: null, sizeUpper: null, deliveryStatus: null, rowsUploaded: 0, lastSyncedAt: null, lastError: null, metaAudienceId: null, consentBasis: null, spec: {} }),
    adAudienceUpload: () => ({ id: `up_db${++h.seq}`, createdAt: new Date(), finishedAt: null, error: null, startedAt: null }),
    job: () => ({ id: `job_${++h.seq}`, status: "queued", attempts: 0, createdAt: new Date(), runAt: new Date() }),
  };
  const base = h.db.prisma as Record<string, Record<string, unknown>>;
  h.prisma = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      const delegate = base[prop];
      if (!defaults[prop]) return delegate;
      return {
        ...delegate,
        create: async ({ data }: { data: Row }) => {
          const row = { ...defaults[prop](), ...data };
          h.db.rows(prop).push(row);
          return { ...row };
        },
      };
    },
  });
  return { prisma: h.prisma };
});

import { GraphError } from "@/lib/graph";
import { log } from "@/lib/log";
import {
  allowedKinds,
  AUDIENCE_ACTION,
  AUDIENCE_COPY,
  audienceErrorKind,
  AudienceFixError,
  audienceKindOffered,
  audienceView,
  CONSENT_BASIS,
  countView,
  createAudience,
  deleteAudience,
  includable,
  KINDS_BY_LEVEL,
  listAudiences,
  plainAudienceError,
  previewCustomerList,
  refreshAudience,
  resumeUpload,
  retentionCopy,
  sendQueuedUploads,
  statusFromMeta,
  SYNC_BATCH,
  syncAudiences,
  toAudienceError,
  UPLOAD_RUN_MS,
  type AudienceDeps,
  type AudienceRecord,
  type CustomerContact,
  type UploadRecord,
} from "@/lib/promote/audiences";
import { MAX_CUSTOMER_LISTS } from "@/lib/promote/catalog/audience-events";
import {
  FORGET_KEEP_MS,
  FORGET_MAX_ATTEMPTS,
  FORGET_QUEUE,
  forgetContact,
  handleForgetJob,
  OPTOUT_CURSOR_KEY,
  parseForgetPayload,
  queueAdAccountAudienceDeletes,
  queueWorkspaceAudienceDeletes,
  runForgetQueue,
  sweepOptOuts,
} from "@/lib/promote/forget";
import { CUSTOMER_SCHEMA } from "@/lib/promote/hashing";
import { PromoteThrottledError } from "@/lib/promote/throttle";
import { HttpError } from "@/lib/tenancy";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const HOUR = 3_600_000;
const ACCOUNT = { assetId: "acc", externalId: "act_123" };
const actor = { tenantId: "t1", userId: "u1" };
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const person = (i: number, over: Partial<CustomerContact> = {}): CustomerContact => ({
  id: `c${String(i).padStart(6, "0")}`,
  phone: `+9198${String(i).padStart(8, "0")}`,
  email: null,
  name: `Person ${i}`,
  optIn: true,
  optedOutAt: null,
  ...over,
});
const people = (n: number, from = 1) => Array.from({ length: n }, (_, i) => person(from + i));

/** In-memory dependencies: an audience store, contacts, the workspace and a fake Meta. */
function world(over: { contacts?: CustomerContact[]; env?: Record<string, string | undefined>; category?: string; dryRun?: boolean } = {}) {
  const audiences: AudienceRecord[] = [];
  const uploads: (UploadRecord & { requestedByUserId: string | null })[] = [];
  const calls: string[] = [];
  let n = 0;
  let sessions = 1000;
  const contacts = { list: over.contacts ?? [] };
  const clock = { t: NOW };
  // When each audience last changed, like AdAudience.updatedAt: the upload task sends the longest unchanged first.
  const touched = new Map<string, number>();
  let tick = 0;
  const touch = (id: string) => touched.set(id, ++tick);
  const deps: AudienceDeps = {
    store: {
      list: async (t) => audiences.filter((a) => a.tenantId === t && !a.deletedAt).map((a) => ({ ...a })),
      get: async (t, id) => {
        const a = audiences.find((x) => x.tenantId === t && x.id === id);
        return a ? { ...a } : null;
      },
      countCustomerLists: async (t) => audiences.filter((a) => a.tenantId === t && a.kind === "customer_list" && !a.deletedAt).length,
      create: async (d) => {
        const row: AudienceRecord = { id: `aud_${++n}`, sizeLower: null, sizeUpper: null, deliveryStatus: null, rowsUploaded: 0, lastSyncedAt: null, createdAt: new Date(NOW), deletedAt: null, ...d, lastError: d.lastError ?? null };
        audiences.push(row);
        touch(row.id);
        calls.push(`store.create:${row.kind}`);
        return { ...row };
      },
      update: async (t, id, patch) => {
        const a = audiences.find((x) => x.tenantId === t && x.id === id);
        if (a) {
          Object.assign(a, patch);
          touch(a.id);
        }
        calls.push(`store.update:${Object.keys(patch).sort().join(",")}`);
      },
      // Oldest read first, never read first (like the Prisma store's orderBy lastSyncedAt asc, nulls first).
      dueForSync: async (before, limit) =>
        audiences
          .filter((a) => !a.deletedAt && a.kind !== "saved" && a.metaAudienceId && a.adAccountAssetId && (!a.lastSyncedAt || a.lastSyncedAt < before))
          .sort((a, b) => (a.lastSyncedAt?.getTime() ?? -Infinity) - (b.lastSyncedAt?.getTime() ?? -Infinity))
          .slice(0, limit)
          .map((a) => ({ ...a })),
      openUpload: async (t, id) => {
        const u = uploads.filter((x) => x.tenantId === t && x.audienceId === id && (x.status === "queued" || x.status === "running")).at(-1);
        return u ? { ...u } : null;
      },
      openUploads: async (limit) =>
        uploads
          .filter((x) => x.status === "queued" || x.status === "running")
          .sort((a, b) => (touched.get(a.audienceId) ?? 0) - (touched.get(b.audienceId) ?? 0))
          .slice(0, limit)
          .map((u) => ({ ...u })),
      createUpload: async (d) => {
        const u = { id: `up_${++n}`, finishedAt: null, error: null, ...d };
        uploads.push(u);
        return { ...u };
      },
      updateUpload: async (id, patch) => {
        Object.assign(uploads.find((u) => u.id === id)!, patch);
      },
    },
    contacts: { scan: vi.fn(async () => contacts.list.map((c) => ({ ...c }))) },
    workspace: {
      spendingAccount: vi.fn(async () => ACCOUNT),
      source: vi.fn(async (_t: string, type: string, id: string) => (id === "missing" ? null : { metaId: type === "lead_form" ? "5566778899001122" : type === "page" ? "104857600123" : "17841400000000001", name: "Source" })),
      pixel: vi.fn(async () => ({ assetId: "px_asset", metaId: "1122334455667788" })),
      specialCategory: vi.fn(async () => (over.category ?? "none") as "none"),
    },
    meta: {
      createCustomAudience: vi.fn(async () => {
        calls.push("meta.A1");
        return { id: `23840000000${++n}` };
      }),
      addAudienceUsers: vi.fn(async (_c, aud: string, rows: { rows: string[][] }, s: { id: number }) => ({ audienceId: aud, sessionId: s.id, numReceived: rows.rows.length, numInvalid: 0 })),
      replaceAudienceUsers: vi.fn(async (_c, aud: string, rows: { rows: string[][] }, s: { id: number }) => ({ audienceId: aud, sessionId: s.id, numReceived: rows.rows.length, numInvalid: 0 })),
      getAudience: vi.fn(async (_c, id: string) => ({ id, lower: 120_000, upper: 180_000, operationStatus: { code: 200, description: "Normal" }, deliveryStatus: { code: 200, description: "Ready" } })),
      deleteAudience: vi.fn(async () => {
        calls.push("meta.A6");
        return { deleted: true };
      }),
      getAdAccountHealth: vi.fn(async () => ({
        accountStatus: 1,
        disableReason: 0,
        currency: "INR",
        timezone: "Asia/Kolkata",
        businessId: null,
        tosAccepted: { custom_audience_tos: 1 },
        userTosAccepted: { custom_audience_tos: 1 },
        fundingPresent: true,
      })),
      estimateReach: vi.fn(async () => ({ lower: 1000, upper: 2000 })),
    },
    audit: vi.fn(async () => undefined),
    env: over.env ?? { PROMOTE_AUDIENCES: "all" },
    now: () => clock.t,
    sessionId: () => ++sessions,
    dryRun: over.dryRun ?? false,
  };
  const metaCalls = () => Object.values(deps.meta).reduce((sum, fn) => sum + (fn as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  /** Calls that send people to Meta (A2, A3). */
  const sends = () => (deps.meta.addAudienceUsers as ReturnType<typeof vi.fn>).mock.calls.length + (deps.meta.replaceAudienceUsers as ReturnType<typeof vi.fn>).mock.calls.length;
  return { deps, audiences, uploads, calls, contacts, metaCalls, sends, clock };
}

const seedAudience = (w: ReturnType<typeof world>, over: Partial<AudienceRecord>): AudienceRecord => {
  const row: AudienceRecord = {
    id: `seed_${w.audiences.length + 1}`,
    tenantId: "t1",
    adAccountAssetId: "acc",
    kind: "engagement_instagram",
    name: "Instagram engagers",
    metaAudienceId: `2385${w.audiences.length + 1}`,
    spec: {},
    status: "ready",
    sizeLower: 5000,
    sizeUpper: 7000,
    deliveryStatus: "200",
    consentBasis: null,
    rowsUploaded: 0,
    lastSyncedAt: new Date(NOW - 7 * HOUR),
    lastError: null,
    createdByUserId: "u1",
    createdAt: new Date(NOW - 24 * HOUR),
    deletedAt: null,
    ...over,
  };
  w.audiences.push(row);
  return row;
};

const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected a refusal");
};

// =====================================================================================================================
// Flags
// =====================================================================================================================

describe("PROMOTE_AUDIENCES gates the kinds (1.4, D17)", () => {
  it("off: saved only; engagement: plus engagement, website and lookalike; all: plus customer lists", () => {
    expect(allowedKinds({})).toEqual(["saved"]);
    expect(allowedKinds({ PROMOTE_AUDIENCES: "off" })).toEqual(["saved"]);
    expect(allowedKinds({ PROMOTE_AUDIENCES: "engagement" })).toEqual(["saved", "engagement_instagram", "engagement_page", "engagement_lead_form", "website", "lookalike"]);
    expect(allowedKinds({ PROMOTE_AUDIENCES: "all" })).toEqual([...KINDS_BY_LEVEL.all]);
    expect(allowedKinds({ PROMOTE_AUDIENCES: "all" })).toContain("customer_list");
    expect(AUDIENCE_ACTION).toMatchObject({ saved: "save_audience", website: "create_audience", engagement_page: "create_audience", customer_list: "create_customer_audience", lookalike: "create_lookalike" });
  });

  it("production refuses customer lists without LEGAL_DPDP_AUDIENCES_OK=1", () => {
    expect(allowedKinds({ PROMOTE_AUDIENCES: "all", NODE_ENV: "production" })).not.toContain("customer_list");
    expect(allowedKinds({ PROMOTE_AUDIENCES: "all", NODE_ENV: "production" })).toContain("lookalike");
    expect(allowedKinds({ PROMOTE_AUDIENCES: "all", NODE_ENV: "production", LEGAL_DPDP_AUDIENCES_OK: "1" })).toContain("customer_list");
  });

  it("createAudience refuses every kind its level does not offer, before any Meta call", async () => {
    const cases: [Record<string, string>, string, string][] = [
      [{}, "engagement_instagram", AUDIENCE_COPY.savedOnly],
      [{}, "lookalike", AUDIENCE_COPY.savedOnly],
      [{}, "customer_list", AUDIENCE_COPY.savedOnly],
      [{ PROMOTE_AUDIENCES: "engagement" }, "customer_list", AUDIENCE_COPY.customerListsOff],
      [{ PROMOTE_AUDIENCES: "all", NODE_ENV: "production" }, "customer_list", AUDIENCE_COPY.customerListsOff],
    ];
    for (const [env, kind, message] of cases) {
      const w = world({ env, contacts: people(150) });
      const e = await rejects(createAudience(actor, { kind, sourceId: "ig1", seedAudienceId: "x", percent: 1 }, w.deps));
      expect(e, `${kind} with ${JSON.stringify(env)}`).toMatchObject({ status: 403, message });
      expect(w.metaCalls()).toBe(0);
      expect(w.audiences).toHaveLength(0);
    }
    // Saved audiences work at every level.
    const w = world({ env: {} });
    const saved = await createAudience(actor, { kind: "saved", name: "Pune women 25-40", targeting: { geo: { countries: ["IN"] }, ageMin: 25, ageMax: 40, genders: ["female"] } }, w.deps);
    expect(saved).toMatchObject({ action: "save_audience", audience: { kind: "saved", status: "ready", chipText: "Ready", usable: true, available: true } });
    expect(w.metaCalls()).toBe(0);
  });

  it("an unknown kind or a body that is not JSON is refused", async () => {
    const w = world();
    expect(await rejects(createAudience(actor, { kind: "everyone" }, w.deps))).toMatchObject({ status: 400, message: AUDIENCE_COPY.chooseKind });
    expect(await rejects(createAudience(actor, "x", w.deps))).toMatchObject({ status: 400 });
  });
});

// =====================================================================================================================
// Saved audiences
// =====================================================================================================================

describe("saved audiences: local, validated by ads/targeting.ts", () => {
  it("stores the targeting and sends nothing to Meta", async () => {
    const w = world();
    const r = await createAudience(actor, { kind: "saved", name: "  Pune ", targeting: { geo: { countries: ["IN"] }, ageMin: 18, ageMax: 65, interests: [{ id: "6003139266461", name: "Yoga" }] } }, w.deps);
    expect(r.audience.name).toBe("Pune");
    expect(w.audiences[0]).toMatchObject({ kind: "saved", adAccountAssetId: null, metaAudienceId: null, status: "ready", consentBasis: null });
    expect((w.audiences[0].spec.targeting as { interests: unknown[] }).interests).toHaveLength(1);
    expect(w.metaCalls()).toBe(0);
  });

  it("refuses a targeting that can't run, in plain words", async () => {
    const w = world();
    expect(await rejects(createAudience(actor, { kind: "saved", name: "x", targeting: { geo: { countries: [] } } }, w.deps))).toMatchObject({ status: 400, message: "Choose at least one country or city." });
    expect(await rejects(createAudience(actor, { kind: "saved", name: "x", targeting: { geo: { countries: ["IN"] }, ageMin: 10 } }, w.deps))).toMatchObject({ status: 400 });
    // An audience id that is not a ready audience of this workspace is refused.
    expect(await rejects(createAudience(actor, { kind: "saved", name: "x", targeting: { geo: { countries: ["IN"] }, customAudienceIds: ["aud_elsewhere"] } }, w.deps))).toMatchObject({ status: 400 });
    expect(await rejects(createAudience(actor, { kind: "saved", name: "x".repeat(101), targeting: { geo: { countries: ["IN"] } } }, w.deps))).toMatchObject({ status: 400, message: AUDIENCE_COPY.name });
    expect(w.audiences).toHaveLength(0);
  });
});

// =====================================================================================================================
// Customer lists
// =====================================================================================================================

describe("customer lists: who is included (D17, 11.1a decision 3)", () => {
  it("only contacts with a marketing opt-in who have not opted out and can be matched", () => {
    expect(includable(person(1))).toBe(true);
    expect(includable(person(1, { phone: null, email: "a@b.co" }))).toBe(true);
    expect(includable(person(2, { optIn: false }))).toBe(false);
    expect(includable(person(3, { optedOutAt: new Date(NOW) }))).toBe(false);
    // An opt-out wins over a stale opt-in flag: it blocks marketing.
    expect(includable(person(4, { optIn: true, optedOutAt: "2026-10-01T00:00:00Z" }))).toBe(false);
    expect(includable(person(5, { phone: null, email: null }))).toBe(false);
    expect(includable(person(6, { phone: "abc", email: "not-an-email" }))).toBe(false);
  });

  it("the count line reads '1,240 of 1,610 contacts can be included', counting only consented contacts", async () => {
    const contacts = [
      ...people(1240),
      ...people(200, 5000).map((c) => ({ ...c, optIn: false })),
      ...people(100, 6000).map((c) => ({ ...c, optedOutAt: new Date(NOW - HOUR) })),
      ...people(70, 7000).map((c) => ({ ...c, phone: null })),
    ];
    const w = world({ contacts });
    const count = await previewCustomerList(actor, { segmentId: "seg_1" }, w.deps);
    expect(count).toEqual({ total: 1610, included: 1240, line: "1,240 of 1,610 contacts can be included.", tooSmall: false });
    expect(w.deps.contacts.scan).toHaveBeenCalledWith("t1", { segmentId: "seg_1" });
    expect(w.metaCalls()).toBe(0);
    expect(countView(99, 99).tooSmall).toBe(true);
    // An erased contact is gone from the workspace, so it is not in the scan and not counted.
    w.contacts.list = contacts.slice(1);
    expect((await previewCustomerList(actor, {}, w.deps)).included).toBe(1239);
  });

  it("the preview is refused where customer lists are off", async () => {
    const w = world({ env: { PROMOTE_AUDIENCES: "engagement" }, contacts: people(200) });
    expect(await rejects(previewCustomerList(actor, {}, w.deps))).toMatchObject({ status: 403, message: AUDIENCE_COPY.customerListsOff });
  });
});

describe("customer lists: creating", () => {
  it("99 people: too_small, with zero Meta calls (not even the terms read)", async () => {
    const w = world({ contacts: [...people(99), person(500, { optIn: false })] });
    const r = await createAudience(actor, { kind: "customer_list", name: "VIP", tag: "vip" }, w.deps);
    expect(w.metaCalls()).toBe(0);
    expect(r).toMatchObject({ action: "create_customer_audience", notice: "Too small: Meta needs at least 100 people.", count: { included: 99, total: 100, tooSmall: true } });
    expect(r.audience).toMatchObject({ status: "too_small", chipText: "Too small", consentBasis: CONSENT_BASIS, rowsUploaded: 0 });
    expect(w.audiences[0]).toMatchObject({ kind: "customer_list", metaAudienceId: null, consentBasis: "marketing_opt_in", adAccountAssetId: "acc", spec: { selection: { tag: "vip" } } });
    expect(w.uploads).toHaveLength(0);
  });

  it("checks the Custom Audience terms first: not accepted gives the custom_audience_tos fix and creates nothing", async () => {
    const w = world({ contacts: people(150) });
    (w.deps.meta.getAdAccountHealth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ tosAccepted: {}, userTosAccepted: { custom_audience_tos: 1 }, accountStatus: 1 });
    const e = await rejects(createAudience(actor, { kind: "customer_list", name: "VIP" }, w.deps));
    expect(e).toBeInstanceOf(AudienceFixError);
    expect(e).toMatchObject({ status: 409, message: "Accept Meta's audience terms first.", kind: "custom_audience_tos", fix: { kind: "opens_meta", key: "custom_audience_tos" } });
    expect((e as AudienceFixError).fix!.href).toContain("act=123");
    const body = (await (e as AudienceFixError).response().json()) as { error: string; fix: { key: string } };
    expect(body).toMatchObject({ error: "Accept Meta's audience terms first.", fix: { key: "custom_audience_tos" } });
    expect(w.deps.meta.createCustomAudience).not.toHaveBeenCalled();
    expect(w.deps.meta.addAudienceUsers).not.toHaveBeenCalled();
    expect(w.audiences).toHaveLength(0);
  });

  it("the request makes the list on Meta and only queues its people: no A2 in the request, whatever the size", async () => {
    const w = world({ contacts: people(25_000) });
    const r = await createAudience(actor, { kind: "customer_list", name: "All customers" }, w.deps);
    expect(w.deps.meta.createCustomAudience).toHaveBeenCalledTimes(1);
    expect(w.sends()).toBe(0);
    expect(r).toMatchObject({ upload: { state: "queued", mode: "add", sentRows: 0, totalRows: 25_000, batches: 3 }, notice: AUDIENCE_COPY.sending, count: { included: 25_000 } });
    expect(r.audience).toMatchObject({ status: "populating", chipText: "Getting ready", problem: null });
    expect(w.uploads).toHaveLength(1);
    expect(w.uploads[0]).toMatchObject({ status: "queued", batchSeq: 0, sentRows: 0, startedAt: null, requestedByUserId: "u1" });
  });

  it("25,000 people go in 3 batches of one session: batch_seq 1, 2, 3, the last flagged; the upload holds counts only", async () => {
    const w = world({ contacts: people(25_000) });
    const r = await createAudience(actor, { kind: "customer_list", name: "All customers" }, w.deps);
    const add = w.deps.meta.addAudienceUsers as ReturnType<typeof vi.fn>;
    expect(await sendQueuedUploads(w.deps)).toEqual({ uploads: 1, done: 1, waiting: 0, failed: 0 });
    expect(add).toHaveBeenCalledTimes(3);
    const sessions = add.mock.calls.map((c) => c[3] as { id: number; batchSeq: number; last: boolean; estimatedTotal: number });
    expect(sessions.map((s) => s.batchSeq)).toEqual([1, 2, 3]);
    expect(sessions.map((s) => s.last)).toEqual([false, false, true]);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(1);
    expect(sessions[0].estimatedTotal).toBe(25_000);
    expect(add.mock.calls.map((c) => (c[2] as { rows: string[][] }).rows.length)).toEqual([10_000, 10_000, 5_000]);
    const payload = add.mock.calls[0][2] as { schema: string[]; rows: string[][] };
    expect(payload.schema).toEqual([...CUSTOMER_SCHEMA]);
    expect(payload.rows[0][1]).toBe(sha("919800000001"));
    expect(payload.rows.flat().every((v) => v === "" || /^[0-9a-f]{64}$/.test(v))).toBe(true);
    expect(add.mock.calls[0][0]).toEqual({ tenantId: "t1", adAccountAssetId: "acc" });
    // A1 came first, after the terms read.
    expect(w.calls.indexOf("meta.A1")).toBeLessThan(w.calls.indexOf("store.create:customer_list"));
    expect(audienceView(w.audiences[0], w.deps.env)).toMatchObject({ id: r.audience.id, status: "populating", rowsUploaded: 25_000, consentBasis: "marketing_opt_in", chipText: "Getting ready" });
    expect(w.uploads).toHaveLength(1);
    expect(w.uploads[0]).toMatchObject({ mode: "add", totalRows: 25_000, sentRows: 25_000, batchSeq: 3, status: "done" });
    expect(w.uploads[0].startedAt).toEqual(new Date(NOW));
    // Counts only: no hashes and no contact ids in the upload row.
    const stored = JSON.stringify(w.uploads[0]);
    expect(stored).not.toMatch(/[0-9a-f]{64}/);
    expect(stored).not.toMatch(/c0000/);
  });

  it("a retry resumes at the next batch_seq of the same session and never resends an acknowledged batch", async () => {
    const w = world({ contacts: people(25_000) });
    const add = w.deps.meta.addAudienceUsers as ReturnType<typeof vi.fn>;
    add.mockImplementationOnce(async () => ({})).mockImplementationOnce(async () => ({})).mockRejectedValueOnce(new PromoteThrottledError({ reason: "busy", until: new Date(NOW + 60_000), scope: "act:123", now: NOW }));
    const r = await createAudience(actor, { kind: "customer_list", name: "All customers" }, w.deps);
    expect(await sendQueuedUploads(w.deps)).toEqual({ uploads: 1, done: 0, waiting: 1, failed: 0 });
    expect(w.uploads[0]).toMatchObject({ status: "running", batchSeq: 2, sentRows: 20_000 });
    expect(audienceView(w.audiences[0], w.deps.env)).toMatchObject({ status: "populating", problem: AUDIENCE_COPY.busy });

    const out = await resumeUpload("t1", r.audience.id, w.deps);
    expect(out).toMatchObject({ state: "done", sentRows: 25_000 });
    const seqs = add.mock.calls.map((c) => (c[3] as { batchSeq: number }).batchSeq);
    expect(seqs).toEqual([1, 2, 3, 3]);
    const ids = new Set(add.mock.calls.map((c) => (c[3] as { id: number }).id));
    expect(ids.size).toBe(1);
    expect(w.uploads).toHaveLength(1);
    expect(w.uploads[0]).toMatchObject({ status: "done", batchSeq: 3, sentRows: 25_000 });
    // Nothing is left to resume.
    expect(await resumeUpload("t1", r.audience.id, w.deps)).toBeNull();
    expect(add).toHaveBeenCalledTimes(4);
  });

  it("a lost answer (Meta's timeout) also resumes the same batch; a refusal fails the upload with plain words", async () => {
    const w = world({ contacts: people(12_000) });
    const add = w.deps.meta.addAudienceUsers as ReturnType<typeof vi.fn>;
    const lost = Object.assign(new HttpError(504, "Meta didn't confirm this in time."), { name: "PromoteMetaError" });
    add.mockRejectedValueOnce(lost);
    const r = await createAudience(actor, { kind: "customer_list", name: "x" }, w.deps);
    expect((await sendQueuedUploads(w.deps)).waiting).toBe(1);
    expect(w.uploads[0].status).toBe("running");
    await sendQueuedUploads(w.deps);
    expect(add.mock.calls.map((c) => (c[3] as { batchSeq: number }).batchSeq)).toEqual([1, 1, 2]);
    expect(w.uploads[0]).toMatchObject({ status: "done", sentRows: 12_000 });
    expect(await resumeUpload("t1", r.audience.id, w.deps)).toBeNull();

    const w2 = world({ contacts: people(150) });
    (w2.deps.meta.addAudienceUsers as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new GraphError("Permissions error", 400, 200));
    const r2 = await createAudience(actor, { kind: "customer_list", name: "x" }, w2.deps);
    expect(await sendQueuedUploads(w2.deps)).toEqual({ uploads: 1, done: 0, waiting: 0, failed: 1 });
    expect((await listAudiences(actor, w2.deps)).audiences.find((a) => a.id === r2.audience.id)).toMatchObject({ status: "error", chipText: "Problem", problem: AUDIENCE_COPY.uploadFailed });
    expect(w2.uploads[0].status).toBe("failed");
  });

  it("a run starts no new batch after UPLOAD_RUN_MS; the next run sends the rest in the same session", async () => {
    const w = world({ contacts: people(35_000) });
    const add = w.deps.meta.addAudienceUsers as ReturnType<typeof vi.fn>;
    await createAudience(actor, { kind: "customer_list", name: "Big" }, w.deps);
    // Each batch takes 20 seconds: two fit in a run (the second starts at 20 s), the third would start at 40 s.
    add.mockImplementation(async () => {
      w.clock.t += 20_000;
      return {};
    });
    expect(UPLOAD_RUN_MS).toBe(30_000);
    expect(await sendQueuedUploads(w.deps)).toEqual({ uploads: 1, done: 0, waiting: 1, failed: 0 });
    expect(add).toHaveBeenCalledTimes(2);
    expect(w.uploads[0]).toMatchObject({ status: "running", batchSeq: 2, sentRows: 20_000 });
    expect(w.audiences[0]).toMatchObject({ status: "populating", rowsUploaded: 20_000, lastError: null });
    w.clock.t += 2 * 60_000;
    expect(await sendQueuedUploads(w.deps)).toEqual({ uploads: 1, done: 1, waiting: 0, failed: 0 });
    const sessions = add.mock.calls.map((c) => c[3] as { id: number; batchSeq: number; last: boolean });
    expect(sessions.map((s) => s.batchSeq)).toEqual([1, 2, 3, 4]);
    expect(sessions.map((s) => s.last)).toEqual([false, false, false, true]);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(1);
    expect(w.uploads).toHaveLength(1);
    expect(w.uploads[0]).toMatchObject({ status: "done", batchSeq: 4, sentRows: 35_000 });
  });

  it("a busy ad account waits for the next run without holding up the others; a newer refresh replaces an older upload", async () => {
    const w = world({ contacts: people(150) });
    const busyList = seedAudience(w, { kind: "customer_list", adAccountAssetId: "acc_busy", status: "populating" });
    const busyToo = seedAudience(w, { kind: "customer_list", adAccountAssetId: "acc_busy", status: "populating" });
    const other = seedAudience(w, { kind: "customer_list", tenantId: "t2", adAccountAssetId: "acc_t2", status: "populating" });
    const queued = (a: AudienceRecord, sessionId: number) =>
      w.deps.store.createUpload({ tenantId: a.tenantId, audienceId: a.id, sessionId, mode: "add", totalRows: 150, sentRows: 0, batchSeq: 0, status: "queued", startedAt: null, requestedByUserId: null });
    await queued(busyList, 1);
    await queued(busyToo, 2);
    await queued(other, 3);
    const add = w.deps.meta.addAudienceUsers as ReturnType<typeof vi.fn>;
    add.mockRejectedValueOnce(new PromoteThrottledError({ reason: "busy", until: new Date(NOW + 60_000), scope: "act_555", now: NOW }));
    expect(await sendQueuedUploads(w.deps)).toEqual({ uploads: 3, done: 1, waiting: 2, failed: 0 });
    // One try on the busy account, none for its second list, and the other workspace's list went.
    expect(add.mock.calls.map((c) => c[0])).toEqual([
      { tenantId: "t1", adAccountAssetId: "acc_busy" },
      { tenantId: "t2", adAccountAssetId: "acc_t2" },
    ]);
    expect(w.uploads.map((u) => u.status)).toEqual(["running", "queued", "done"]);
    // The paused one changed last, so the next run starts with the one that waited.
    add.mockClear();
    await sendQueuedUploads(w.deps);
    expect(add.mock.calls.map((c) => (c[3] as { id: number }).id)).toEqual([2, 1]);

    // Two refreshes queued for one audience: only the newest is sent.
    const w2 = world({ contacts: people(150) });
    const list = seedAudience(w2, { kind: "customer_list", status: "ready" });
    await w2.deps.store.createUpload({ tenantId: "t1", audienceId: list.id, sessionId: 7, mode: "replace", totalRows: 150, sentRows: 0, batchSeq: 0, status: "queued", startedAt: null, requestedByUserId: null });
    await w2.deps.store.createUpload({ tenantId: "t1", audienceId: list.id, sessionId: 8, mode: "replace", totalRows: 150, sentRows: 0, batchSeq: 0, status: "queued", startedAt: null, requestedByUserId: null });
    expect(await sendQueuedUploads(w2.deps)).toEqual({ uploads: 2, done: 1, waiting: 0, failed: 1 });
    const replace = w2.deps.meta.replaceAudienceUsers as ReturnType<typeof vi.fn>;
    expect(replace).toHaveBeenCalledTimes(1);
    expect((replace.mock.calls[0][3] as { id: number }).id).toBe(8);
    expect(w2.uploads.map((u) => [u.status, u.error])).toEqual([
      ["failed", AUDIENCE_COPY.uploadReplaced],
      ["done", null],
    ]);
  });

  it("an upload whose audience was deleted, or whose contacts can't be read, is closed instead of tried for ever", async () => {
    const w = world({ contacts: people(150) });
    const gone = seedAudience(w, { kind: "customer_list", deletedAt: new Date(NOW) });
    const big = seedAudience(w, { kind: "customer_list" });
    for (const a of [gone, big]) await w.deps.store.createUpload({ tenantId: "t1", audienceId: a.id, sessionId: 1, mode: "add", totalRows: 150, sentRows: 0, batchSeq: 0, status: "queued", startedAt: null, requestedByUserId: null });
    (w.deps.contacts.scan as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new HttpError(422, AUDIENCE_COPY.tooBig));
    expect(await sendQueuedUploads(w.deps)).toEqual({ uploads: 2, done: 0, waiting: 0, failed: 2 });
    expect(w.sends()).toBe(0);
    expect(w.uploads.map((u) => [u.status, u.error])).toEqual([
      ["failed", AUDIENCE_COPY.uploadDeleted],
      ["failed", AUDIENCE_COPY.tooBig],
    ]);
    expect(w.audiences.find((a) => a.id === big.id)).toMatchObject({ status: "error", lastError: AUDIENCE_COPY.tooBig });
    expect(await sendQueuedUploads(w.deps)).toEqual({ uploads: 0, done: 0, waiting: 0, failed: 0 });
  });

  it("a refresh replaces the people with usersreplace, with consented contacts only", async () => {
    const w = world({ contacts: people(300) });
    const r = await createAudience(actor, { kind: "customer_list", name: "All" }, w.deps);
    // A refresh while the list is still being sent starts nothing.
    const early = await refreshAudience(actor, r.audience.id, w.deps);
    expect(early).toMatchObject({ notice: AUDIENCE_COPY.stillSending, upload: { state: "queued", mode: "add", sentRows: 0, totalRows: 300 } });
    expect(w.uploads).toHaveLength(1);
    await sendQueuedUploads(w.deps);
    // Since then two people opted out and one stopped opting in.
    w.contacts.list = w.contacts.list.map((c, i) => (i < 2 ? { ...c, optedOutAt: new Date(NOW) } : i === 2 ? { ...c, optIn: false } : c));
    const out = await refreshAudience(actor, r.audience.id, w.deps);
    const replace = w.deps.meta.replaceAudienceUsers as ReturnType<typeof vi.fn>;
    expect(replace).not.toHaveBeenCalled();
    expect(out).toMatchObject({ notice: AUDIENCE_COPY.sending, count: { included: 297, total: 300 }, upload: { state: "queued", mode: "replace", totalRows: 297 } });
    expect(await sendQueuedUploads(w.deps)).toMatchObject({ done: 1 });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(w.deps.meta.addAudienceUsers).toHaveBeenCalledTimes(1);
    expect((replace.mock.calls[0][2] as { rows: string[][] }).rows).toHaveLength(297);
    const session = replace.mock.calls[0][3] as { id: number; batchSeq: number; last: boolean };
    expect(session).toMatchObject({ batchSeq: 1, last: true });
    expect(session.id).not.toBe((w.deps.meta.addAudienceUsers as ReturnType<typeof vi.fn>).mock.calls[0][3].id);
    expect(w.uploads.map((u) => [u.mode, u.status, u.sentRows])).toEqual([
      ["add", "done", 300],
      ["replace", "done", 297],
    ]);
    // No Meta create on a refresh of a list Meta already has.
    expect(w.deps.meta.createCustomAudience).toHaveBeenCalledTimes(1);
  });

  it("a refresh under 100 sends nothing; a list that was too small is created once it has 100", async () => {
    const w = world({ contacts: people(40) });
    const r = await createAudience(actor, { kind: "customer_list", name: "Small" }, w.deps);
    expect(r.audience.status).toBe("too_small");
    expect((await refreshAudience(actor, r.audience.id, w.deps)).notice).toBe("Too small: Meta needs at least 100 people.");
    expect(w.metaCalls()).toBe(0);
    w.contacts.list = people(120);
    const out = await refreshAudience(actor, r.audience.id, w.deps);
    expect(w.deps.meta.getAdAccountHealth).toHaveBeenCalledTimes(1);
    expect(w.deps.meta.createCustomAudience).toHaveBeenCalledTimes(1);
    expect(out.upload).toMatchObject({ mode: "add", totalRows: 120, state: "queued" });
    expect(w.sends()).toBe(0);
    await sendQueuedUploads(w.deps);
    expect(w.uploads[0]).toMatchObject({ mode: "add", sentRows: 120, status: "done" });
    expect(w.audiences[0].metaAudienceId).toMatch(/^\d+$/);
  });

  it("a refresh that fails on Meta says so in plain words", async () => {
    const w = world({ contacts: people(40) });
    const r = await createAudience(actor, { kind: "customer_list", name: "Small" }, w.deps);
    w.contacts.list = people(120);
    (w.deps.meta.createCustomAudience as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new GraphError("Error validating access token", 400, 190));
    expect(await rejects(refreshAudience(actor, r.audience.id, w.deps))).toMatchObject({ status: 409, message: AUDIENCE_COPY.reconnect });
    expect(w.uploads).toHaveLength(0);
  });

  it("the 51st customer list is refused", async () => {
    const w = world({ contacts: people(150) });
    for (let i = 0; i < MAX_CUSTOMER_LISTS; i++) seedAudience(w, { kind: "customer_list", consentBasis: "marketing_opt_in" });
    expect(MAX_CUSTOMER_LISTS).toBe(50);
    const e = await rejects(createAudience(actor, { kind: "customer_list", name: "One more" }, w.deps));
    expect(e).toMatchObject({ status: 409, message: AUDIENCE_COPY.tooManyLists });
    expect(w.metaCalls()).toBe(0);
    // A deleted one frees its place.
    w.audiences[0].deletedAt = new Date(NOW);
    await expect(createAudience(actor, { kind: "customer_list", name: "One more" }, w.deps)).resolves.toBeTruthy();
  });

  it("needs a spending ad account, and refuses a bad tag or segment", async () => {
    const w = world({ contacts: people(150) });
    (w.deps.workspace.spendingAccount as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    expect(await rejects(createAudience(actor, { kind: "customer_list" }, w.deps))).toMatchObject({ status: 409, message: AUDIENCE_COPY.noAccount });
    expect(await rejects(createAudience(actor, { kind: "customer_list", tag: "x".repeat(101) }, w.deps))).toMatchObject({ status: 400, message: AUDIENCE_COPY.tag });
    expect(await rejects(createAudience(actor, { kind: "customer_list", segmentId: "../x" }, w.deps))).toMatchObject({ status: 400, message: AUDIENCE_COPY.segment });
  });

  it("a dry run reaches Meta's fake create only and stores nothing", async () => {
    const w = world({ contacts: people(150), dryRun: true });
    const r = await createAudience(actor, { kind: "customer_list", name: "Dry" }, w.deps);
    expect(r.dryRun).toBe(true);
    expect(w.audiences).toHaveLength(0);
    expect(w.uploads).toHaveLength(0);
    expect(w.deps.meta.addAudienceUsers).not.toHaveBeenCalled();
  });
});

describe("customer lists switched off: an open upload never sends another row (acceptance 2)", () => {
  const OFF: [string, Record<string, string>][] = [
    ["PROMOTE_AUDIENCES=engagement", { PROMOTE_AUDIENCES: "engagement" }],
    ["PROMOTE_AUDIENCES=off", { PROMOTE_AUDIENCES: "off" }],
    ["all in production without LEGAL_DPDP_AUDIENCES_OK", { PROMOTE_AUDIENCES: "all", NODE_ENV: "production" }],
  ];

  /** A list whose upload paused after its first batch, with the flags then lowered. */
  async function pausedList(env: Record<string, string>) {
    const w = world({ contacts: people(25_000) });
    const add = w.deps.meta.addAudienceUsers as ReturnType<typeof vi.fn>;
    add.mockImplementationOnce(async () => ({})).mockRejectedValueOnce(new PromoteThrottledError({ reason: "busy", until: new Date(NOW + 60_000), scope: "act_123", now: NOW }));
    const r = await createAudience(actor, { kind: "customer_list", name: "All" }, w.deps);
    await sendQueuedUploads(w.deps);
    expect(w.uploads[0]).toMatchObject({ status: "running", batchSeq: 1 });
    add.mockClear();
    (w.deps.contacts.scan as ReturnType<typeof vi.fn>).mockClear();
    w.deps.env = env;
    return { w, id: r.audience.id };
  }

  for (const [label, env] of OFF) {
    it(`${label}: the upload task closes it, sends nothing and reads no contact`, async () => {
      const { w, id } = await pausedList(env);
      expect(await sendQueuedUploads(w.deps)).toEqual({ uploads: 1, done: 0, waiting: 0, failed: 1 });
      expect(w.sends()).toBe(0);
      expect(w.deps.contacts.scan).not.toHaveBeenCalled();
      expect(w.uploads[0]).toMatchObject({ status: "failed", error: AUDIENCE_COPY.listsOff, batchSeq: 1 });
      expect(w.uploads[0].finishedAt).toBeInstanceOf(Date);
      expect(w.audiences.find((a) => a.id === id)!.lastError).toBe(AUDIENCE_COPY.listsOff);
      // Closed for good: turning lists back on doesn't restart it (a refresh does).
      w.deps.env = { PROMOTE_AUDIENCES: "all" };
      expect(await sendQueuedUploads(w.deps)).toEqual({ uploads: 0, done: 0, waiting: 0, failed: 0 });
      expect(w.sends()).toBe(0);
    });

    it(`${label}: resumeUpload and the 6-hourly sync send nothing either`, async () => {
      const { w, id } = await pausedList(env);
      const out = await resumeUpload("t1", id, w.deps);
      expect(out).toMatchObject({ state: "failed", problem: AUDIENCE_COPY.listsOff });
      expect(w.sends()).toBe(0);

      const { w: w2 } = await pausedList(env);
      w2.audiences[0].lastSyncedAt = new Date(NOW - 7 * HOUR);
      await syncAudiences(w2.deps);
      expect(w2.sends()).toBe(0);
      expect(w2.deps.contacts.scan).not.toHaveBeenCalled();
      expect(w2.uploads[0]).toMatchObject({ status: "failed", error: AUDIENCE_COPY.listsOff });
    });
  }

  it("the 6-hourly sync never sends people, even with customer lists on: that is the upload task's", async () => {
    const w = world({ contacts: people(150) });
    await createAudience(actor, { kind: "customer_list", name: "All" }, w.deps);
    w.audiences[0].lastSyncedAt = new Date(NOW - 7 * HOUR);
    (w.deps.meta.getAudience as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "x", lower: 1000, upper: 2000, operationStatus: { code: 200, description: null }, deliveryStatus: { code: 200, description: null } });
    expect(await syncAudiences(w.deps)).toEqual({ audiences: 1, updated: 1, failed: 0 });
    expect(w.sends()).toBe(0);
    // Still uploading: Getting ready, whatever Meta says.
    expect(w.audiences[0]).toMatchObject({ status: "populating", sizeLower: 1000 });
    expect(w.uploads[0].status).toBe("queued");
  });

  it("audienceKindOffered: what a launch may use at each level", () => {
    expect(audienceKindOffered("customer_list", { PROMOTE_AUDIENCES: "all" })).toBe(true);
    expect(audienceKindOffered("customer_list", { PROMOTE_AUDIENCES: "engagement" })).toBe(false);
    expect(audienceKindOffered("customer_list", { PROMOTE_AUDIENCES: "all", NODE_ENV: "production" })).toBe(false);
    expect(audienceKindOffered("customer_list", { PROMOTE_AUDIENCES: "all", NODE_ENV: "production", LEGAL_DPDP_AUDIENCES_OK: "1" })).toBe(true);
    expect(audienceKindOffered("lookalike", { PROMOTE_AUDIENCES: "engagement" })).toBe(true);
    expect(audienceKindOffered("website", {})).toBe(false);
    expect(audienceKindOffered("everyone", { PROMOTE_AUDIENCES: "all" })).toBe(false);
  });
});

// =====================================================================================================================
// Engagement, website and lookalike audiences
// =====================================================================================================================

describe("engagement and website audiences: retention bounds (3.7)", () => {
  it("Instagram and Page: 365 days by default, up to 730", async () => {
    const w = world({ env: { PROMOTE_AUDIENCES: "engagement" } });
    const r = await createAudience(actor, { kind: "engagement_instagram", sourceId: "ig_asset" }, w.deps);
    const create = w.deps.meta.createCustomAudience as ReturnType<typeof vi.fn>;
    expect(create.mock.calls[0][1]).toEqual({ kind: "engagement", name: "People who engaged on Instagram · 365 days", sources: [{ id: "17841400000000001", type: "ig_business" }], event: "ig_business_profile_all", retentionDays: 365 });
    expect(r).toMatchObject({ action: "create_audience", audience: { kind: "engagement_instagram", status: "populating", chipText: "Getting ready" } });
    await createAudience(actor, { kind: "engagement_page", sourceId: "page_asset", retentionDays: 730, event: "page_messaged" }, w.deps);
    expect(create.mock.calls[1][1]).toMatchObject({ sources: [{ id: "104857600123", type: "page" }], event: "page_messaged", retentionDays: 730 });
    for (const days of [0, 731, 1.5, "abc"]) {
      expect(await rejects(createAudience(actor, { kind: "engagement_page", sourceId: "page_asset", retentionDays: days }, w.deps)), String(days)).toMatchObject({ status: 400, message: retentionCopy(730) });
    }
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("lead forms: opened or submitted, up to 90 days", async () => {
    const w = world({ env: { PROMOTE_AUDIENCES: "engagement" } });
    await createAudience(actor, { kind: "engagement_lead_form", sourceId: "form_1", event: "lead_submitted", retentionDays: 90 }, w.deps);
    const create = w.deps.meta.createCustomAudience as ReturnType<typeof vi.fn>;
    expect(create.mock.calls[0][1]).toMatchObject({ sources: [{ id: "5566778899001122", type: "lead" }], event: "lead_generation_submitted", retentionDays: 90 });
    await createAudience(actor, { kind: "engagement_lead_form", sourceId: "form_1" }, w.deps);
    expect(create.mock.calls[1][1]).toMatchObject({ event: "lead_generation_opened", retentionDays: 90 });
    expect(await rejects(createAudience(actor, { kind: "engagement_lead_form", sourceId: "form_1", retentionDays: 91 }, w.deps))).toMatchObject({ status: 400, message: retentionCopy(90) });
    expect(await rejects(createAudience(actor, { kind: "engagement_lead_form", sourceId: "form_1", event: "ig_all" }, w.deps))).toMatchObject({ status: 400, message: AUDIENCE_COPY.chooseEvent });
    expect(await rejects(createAudience(actor, { kind: "engagement_lead_form", sourceId: "missing" }, w.deps))).toMatchObject({ status: 404, message: AUDIENCE_COPY.chooseSource });
    expect(await rejects(createAudience(actor, { kind: "engagement_lead_form" }, w.deps))).toMatchObject({ status: 400, message: AUDIENCE_COPY.chooseSource });
  });

  it("website: from the pixel, 30 days by default, up to 180, optionally a word in the address", async () => {
    const w = world({ env: { PROMOTE_AUDIENCES: "engagement" } });
    await createAudience(actor, { kind: "website" }, w.deps);
    const create = w.deps.meta.createCustomAudience as ReturnType<typeof vi.fn>;
    expect(create.mock.calls[0][1]).toEqual({ kind: "website", name: "Website visitors · 30 days", pixelId: "1122334455667788", retentionDays: 30 });
    await createAudience(actor, { kind: "website", retentionDays: 180, urlContains: "checkout", name: "Checkout" }, w.deps);
    expect(create.mock.calls[1][1]).toMatchObject({ retentionDays: 180, urlContains: ["checkout"], name: "Checkout" });
    expect(w.audiences[1].spec).toMatchObject({ event: "website_url", pixelAssetId: "px_asset", urlContains: "checkout" });
    expect(await rejects(createAudience(actor, { kind: "website", retentionDays: 181 }, w.deps))).toMatchObject({ status: 400, message: retentionCopy(180) });
    (w.deps.workspace.pixel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    expect(await rejects(createAudience(actor, { kind: "website" }, w.deps))).toMatchObject({ status: 409, message: AUDIENCE_COPY.noPixel });
  });

  it("a dry run answers with Meta's fake id and stores nothing", async () => {
    const w = world({ env: { PROMOTE_AUDIENCES: "engagement" }, dryRun: true });
    const r = await createAudience(actor, { kind: "website" }, w.deps);
    expect(r.dryRun).toBe(true);
    expect(w.audiences).toHaveLength(0);
  });
});

describe("lookalikes (3.7, D17)", () => {
  it("India, 1% to 10%, from a seed of at least 100", async () => {
    const w = world({ env: { PROMOTE_AUDIENCES: "engagement" } });
    const seed = seedAudience(w, { name: "Instagram engagers", sizeLower: 5000 });
    const r = await createAudience(actor, { kind: "lookalike", seedAudienceId: seed.id, percent: 5 }, w.deps);
    expect((w.deps.meta.createCustomAudience as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({ kind: "lookalike", name: "5% like Instagram engagers", originAudienceId: seed.metaAudienceId, ratio: 0.05, country: "IN" });
    expect(r).toMatchObject({ action: "create_lookalike", audience: { kind: "lookalike", details: { seedAudienceId: seed.id, percent: 5, country: "IN" } } });
    for (const percent of [0, 11, 2.5, "x"]) expect(await rejects(createAudience(actor, { kind: "lookalike", seedAudienceId: seed.id, percent }, w.deps)), String(percent)).toMatchObject({ status: 400, message: AUDIENCE_COPY.percent });
  });

  it("refuses a seed under 100, asking Meta once for a fresh size first", async () => {
    const w = world({ env: { PROMOTE_AUDIENCES: "engagement" } });
    const seed = seedAudience(w, { sizeLower: 99 });
    (w.deps.meta.getAudience as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: seed.metaAudienceId, lower: 99, upper: 150, operationStatus: null, deliveryStatus: null });
    expect(await rejects(createAudience(actor, { kind: "lookalike", seedAudienceId: seed.id, percent: 1 }, w.deps))).toMatchObject({ status: 409, message: AUDIENCE_COPY.seedTooSmall });
    expect(w.deps.meta.getAudience).toHaveBeenCalledTimes(1);
    expect(w.deps.meta.createCustomAudience).not.toHaveBeenCalled();
    // Grown since: Meta's fresh size lets it through.
    const grown = seedAudience(w, { sizeLower: null });
    (w.deps.meta.getAudience as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: grown.metaAudienceId, lower: 1000, upper: 2000, operationStatus: null, deliveryStatus: null });
    await expect(createAudience(actor, { kind: "lookalike", seedAudienceId: grown.id, percent: 1 }, w.deps)).resolves.toBeTruthy();
  });

  it("is never offered for a special ad category: the brand kit's or the ad's", async () => {
    const w = world({ env: { PROMOTE_AUDIENCES: "engagement" }, category: "credit" });
    const seed = seedAudience(w, {});
    expect(await rejects(createAudience(actor, { kind: "lookalike", seedAudienceId: seed.id, percent: 1 }, w.deps))).toMatchObject({ status: 403, message: AUDIENCE_COPY.special });
    const w2 = world({ env: { PROMOTE_AUDIENCES: "engagement" } });
    const seed2 = seedAudience(w2, {});
    expect(await rejects(createAudience(actor, { kind: "lookalike", seedAudienceId: seed2.id, percent: 1, specialAdCategory: "housing" }, w2.deps))).toMatchObject({ status: 403, message: AUDIENCE_COPY.special });
    expect(w.metaCalls() + w2.metaCalls()).toBe(0);
  });

  it("refuses a seed that is not ready, on another account, saved, or a customer list where those are off", async () => {
    const w = world({ env: { PROMOTE_AUDIENCES: "engagement" } });
    const notReady = seedAudience(w, { metaAudienceId: null });
    const other = seedAudience(w, { adAccountAssetId: "acc_other" });
    const saved = seedAudience(w, { kind: "saved", adAccountAssetId: null, metaAudienceId: null });
    const list = seedAudience(w, { kind: "customer_list", consentBasis: "marketing_opt_in" });
    expect(await rejects(createAudience(actor, { kind: "lookalike", seedAudienceId: notReady.id, percent: 1 }, w.deps))).toMatchObject({ status: 409, message: AUDIENCE_COPY.seedNotReady });
    expect(await rejects(createAudience(actor, { kind: "lookalike", seedAudienceId: other.id, percent: 1 }, w.deps))).toMatchObject({ status: 409, message: AUDIENCE_COPY.otherAccount });
    expect(await rejects(createAudience(actor, { kind: "lookalike", seedAudienceId: saved.id, percent: 1 }, w.deps))).toMatchObject({ status: 400, message: AUDIENCE_COPY.chooseSeed });
    expect(await rejects(createAudience(actor, { kind: "lookalike", seedAudienceId: list.id, percent: 1 }, w.deps))).toMatchObject({ status: 403, message: AUDIENCE_COPY.seedCustomerList });
    expect(await rejects(createAudience(actor, { kind: "lookalike", seedAudienceId: "nope", percent: 1 }, w.deps))).toMatchObject({ status: 400, message: AUDIENCE_COPY.chooseSeed });
  });
});

// =====================================================================================================================
// Meta's errors (4.10)
// =====================================================================================================================

describe("Meta's errors in plain words (4.10)", () => {
  it("2655 and 1870090 are the audience terms; 471 and 1713232 a flagged audience", () => {
    expect(audienceErrorKind(new GraphError("Terms not accepted", 400, 2655))).toBe("custom_audience_tos");
    expect(audienceErrorKind(new GraphError("(#100) Terms", 400, 100, 1870090))).toBe("custom_audience_tos");
    expect(audienceErrorKind(new GraphError("Flagged", 471))).toBe("audience_flagged");
    expect(audienceErrorKind(new GraphError("Flagged", 400, 471))).toBe("audience_flagged");
    expect(audienceErrorKind(new GraphError("Flagged", 400, 2654, 1713232))).toBe("audience_flagged");
    expect(audienceErrorKind(new GraphError("Other", 400, 100))).toBeNull();
    expect(audienceErrorKind(new Error("x"))).toBeNull();
    const terms = toAudienceError(new GraphError("x", 400, 2655), "act_123") as AudienceFixError;
    expect(terms).toMatchObject({ status: 409, message: "Accept Meta's audience terms first.", fix: { key: "custom_audience_tos" } });
    const flagged = toAudienceError(new GraphError("x", 471, undefined, 1713232), "act_123") as AudienceFixError;
    expect(flagged).toMatchObject({ status: 422, message: "Meta doesn't allow this kind of audience for this business.", fix: null });
  });

  it("A1 answering 2655 or 471 is told in that copy, and nothing is stored", async () => {
    const w = world({ env: { PROMOTE_AUDIENCES: "engagement" } });
    const create = w.deps.meta.createCustomAudience as ReturnType<typeof vi.fn>;
    create.mockRejectedValueOnce(new GraphError("Terms", 400, 2655));
    expect(await rejects(createAudience(actor, { kind: "website" }, w.deps))).toMatchObject({ status: 409, kind: "custom_audience_tos", message: "Accept Meta's audience terms first." });
    create.mockRejectedValueOnce(new GraphError("Flagged", 471, 2654, 1713232));
    const seed = seedAudience(w, {});
    expect(await rejects(createAudience(actor, { kind: "lookalike", seedAudienceId: seed.id, percent: 1 }, w.deps))).toMatchObject({ status: 422, kind: "audience_flagged", message: "Meta doesn't allow this kind of audience for this business." });
    expect(w.audiences).toHaveLength(1);
  });

  it("every other Meta error becomes plain words, never a raw Graph error", () => {
    const plain = (e: unknown, step: "create" | "read" | "delete" = "create") => plainAudienceError(e, "act_123", step) as HttpError;
    expect(plain(new GraphError("Error validating access token", 400, 190))).toMatchObject({ status: 409, message: AUDIENCE_COPY.reconnect });
    expect(plain(new GraphError("Permissions", 400, 10))).toMatchObject({ status: 403, message: AUDIENCE_COPY.noPermission });
    expect(plain(new GraphError("Ads permission", 400, 294))).toMatchObject({ status: 403, message: AUDIENCE_COPY.noPermission });
    expect(plain(new GraphError("No answer", 500, undefined, undefined, true, true))).toMatchObject({ status: 504, message: AUDIENCE_COPY.maybeMade });
    expect(plain(new GraphError("No answer", 500, undefined, undefined, true, true), "delete")).toMatchObject({ status: 504, message: AUDIENCE_COPY.noAnswer });
    expect(plain(new GraphError("Server", 500, 1), "read")).toMatchObject({ status: 503, message: AUDIENCE_COPY.metaDown });
    expect(plain(new GraphError("Too many calls", 400, 17))).toMatchObject({ status: 503, message: AUDIENCE_COPY.metaDown });
    expect(plain(new GraphError("Invalid parameter", 400, 100))).toMatchObject({ status: 502, message: AUDIENCE_COPY.refused });
    expect(plain(new GraphError("Audience in use", 400, 2654), "delete")).toMatchObject({ status: 502, message: AUDIENCE_COPY.refusedDelete });
    expect(plain(new GraphError("Odd", 400, 1), "read")).toMatchObject({ status: 502, message: AUDIENCE_COPY.readFailed });
    expect(plain(new GraphError("does not exist", 400, 100, 33), "read")).toMatchObject({ status: 409, message: AUDIENCE_COPY.gone });
    // The 4.10 rows keep their fix; HttpErrors (busy, timeouts, our refusals) pass through as they are.
    expect(plain(new GraphError("Terms", 400, 2655))).toBeInstanceOf(AudienceFixError);
    const busy = new PromoteThrottledError({ reason: "busy", until: new Date(NOW + 60_000), scope: "act_123", now: NOW });
    expect(plainAudienceError(busy, null, "create")).toBe(busy);
    for (const e of [plain(new GraphError("Secret Meta words", 400, 1))]) {
      expect(e).toBeInstanceOf(HttpError);
      expect(e.message).not.toContain("Secret");
    }
  });

  it("A1, A5 and A6 failures answer in plain words", async () => {
    const w = world({ env: { PROMOTE_AUDIENCES: "engagement" } });
    const create = w.deps.meta.createCustomAudience as ReturnType<typeof vi.fn>;
    create.mockRejectedValueOnce(new GraphError("Error validating access token", 400, 190));
    expect(await rejects(createAudience(actor, { kind: "website" }, w.deps))).toMatchObject({ status: 409, message: AUDIENCE_COPY.reconnect });
    create.mockRejectedValueOnce(new GraphError("Pixel is not owned", 400, 100, 1234));
    expect(await rejects(createAudience(actor, { kind: "website" }, w.deps))).toMatchObject({ status: 502, message: AUDIENCE_COPY.refused });
    expect(w.audiences).toHaveLength(0);
    const row = seedAudience(w, {});
    (w.deps.meta.getAudience as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new GraphError("Permissions", 400, 200));
    expect(await rejects(refreshAudience(actor, row.id, w.deps))).toMatchObject({ status: 403, message: AUDIENCE_COPY.noPermission });
    (w.deps.meta.deleteAudience as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new GraphError("in use", 400, 2654));
    expect(await rejects(deleteAudience(actor, row.id, w.deps))).toMatchObject({ status: 502, message: AUDIENCE_COPY.refusedDelete });
    expect(w.audiences.find((a) => a.id === row.id)!.deletedAt).toBeNull();
    // A seed whose fresh size can't be read says why, instead of "too small".
    const seed = seedAudience(w, { sizeLower: null });
    (w.deps.meta.getAudience as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new GraphError("Error validating access token", 400, 190));
    expect(await rejects(createAudience(actor, { kind: "lookalike", seedAudienceId: seed.id, percent: 1 }, w.deps))).toMatchObject({ status: 409, message: AUDIENCE_COPY.reconnect });
  });
});

// =====================================================================================================================
// Delete, list, status
// =====================================================================================================================

describe("delete (A6, then deletedAt)", () => {
  it("calls Meta before setting deletedAt", async () => {
    const w = world();
    const row = seedAudience(w, {});
    await deleteAudience(actor, row.id, w.deps);
    const a6 = w.calls.indexOf("meta.A6");
    const del = w.calls.findIndex((c) => c.startsWith("store.update:") && c.includes("deletedAt"));
    expect(a6).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(a6);
    expect(w.deps.meta.deleteAudience).toHaveBeenCalledWith({ tenantId: "t1", adAccountAssetId: "acc" }, row.metaAudienceId);
    expect(w.audiences[0]).toMatchObject({ status: "deleted" });
    expect(w.audiences[0].deletedAt).toBeInstanceOf(Date);
    expect(await rejects(deleteAudience(actor, row.id, w.deps))).toMatchObject({ status: 404 });
  });

  it("a Meta failure leaves the row; an audience Meta no longer has is deleted here too", async () => {
    const w = world();
    const row = seedAudience(w, {});
    (w.deps.meta.deleteAudience as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new GraphError("Server", 500, 1));
    await expect(deleteAudience(actor, row.id, w.deps)).rejects.toBeTruthy();
    expect(w.audiences[0].deletedAt).toBeNull();
    (w.deps.meta.deleteAudience as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new GraphError("Unsupported get request. Object does not exist", 400, 100, 33));
    await deleteAudience(actor, row.id, w.deps);
    expect(w.audiences[0].deletedAt).not.toBeNull();
  });

  it("a saved audience is local: no Meta call; deleting works at every flag level; another workspace's is 404", async () => {
    const w = world({ env: {} });
    const saved = seedAudience(w, { kind: "saved", adAccountAssetId: null, metaAudienceId: null });
    const list = seedAudience(w, { kind: "customer_list" });
    await deleteAudience(actor, saved.id, w.deps);
    await deleteAudience(actor, list.id, w.deps);
    expect(w.deps.meta.deleteAudience).toHaveBeenCalledTimes(1);
    const other = seedAudience(w, { tenantId: "t2" });
    expect(await rejects(deleteAudience(actor, other.id, w.deps))).toMatchObject({ status: 404 });
    expect(await rejects(deleteAudience(actor, "../../x", w.deps))).toMatchObject({ status: 404 });
  });
});

describe("status from Meta (A5) and the 6-hourly sync", () => {
  it("maps operation and delivery status to populating, ready, too_small or error", () => {
    const s = (op: number | null, delivery: number | null) => statusFromMeta({ operationStatus: op === null ? null : { code: op, description: null }, deliveryStatus: delivery === null ? null : { code: delivery, description: null } });
    expect(s(200, 200)).toEqual({ status: "ready", problem: null });
    expect(s(411, 200).status).toBe("ready");
    expect(s(441, null).status).toBe("populating");
    expect(s(null, null).status).toBe("populating");
    expect(s(0, null).status).toBe("populating");
    expect(s(200, 300).status).toBe("too_small");
    expect(s(471, 200)).toEqual({ status: "error", problem: "Meta doesn't allow this kind of audience for this business." });
    expect(s(432, null)).toEqual({ status: "error", problem: AUDIENCE_COPY.failed });
    expect(s(null, 500).status).toBe("error");
  });

  it("reads each audience due, stores the status and size, and the view shows the size line", async () => {
    const w = world();
    const ready = seedAudience(w, { status: "populating", sizeLower: null, sizeUpper: null });
    const small = seedAudience(w, { status: "populating" });
    const fresh = seedAudience(w, { lastSyncedAt: new Date(NOW - HOUR) });
    seedAudience(w, { kind: "saved", adAccountAssetId: null, metaAudienceId: null, lastSyncedAt: null });
    (w.deps.meta.getAudience as ReturnType<typeof vi.fn>).mockImplementation(async (_c, id: string) =>
      id === small.metaAudienceId ? { id, lower: 20, upper: 80, operationStatus: { code: 200, description: null }, deliveryStatus: { code: 300, description: null } } : { id, lower: 120_000, upper: 180_000, operationStatus: { code: 200, description: null }, deliveryStatus: { code: 200, description: null } },
    );
    expect(await syncAudiences(w.deps)).toEqual({ audiences: 2, updated: 2, failed: 0 });
    const views = (await listAudiences(actor, w.deps)).audiences;
    expect(views.find((v) => v.id === ready.id)).toMatchObject({ status: "ready", chipText: "Ready", sizeLine: "About 1.2–1.8 lakh people", usable: true });
    expect(views.find((v) => v.id === small.id)).toMatchObject({ status: "too_small", chipText: "Too small", problem: "Too small: Meta needs at least 100 people." });
    expect(w.audiences.find((a) => a.id === fresh.id)!.lastSyncedAt!.getTime()).toBe(NOW - HOUR);
  });

  it("a busy ad account skips only its own audiences; another workspace's are still read; a gone audience is marked", async () => {
    const w = world();
    const gone = seedAudience(w, { lastSyncedAt: new Date(NOW - 9 * HOUR) });
    const busyFirst = seedAudience(w, { lastSyncedAt: new Date(NOW - 8 * HOUR) });
    const busySecond = seedAudience(w, { lastSyncedAt: new Date(NOW - 7 * HOUR) });
    const otherTenant = seedAudience(w, { tenantId: "t2", adAccountAssetId: "acc_t2", status: "populating", lastSyncedAt: new Date(NOW - 6 * HOUR) });
    const getAudience = w.deps.meta.getAudience as ReturnType<typeof vi.fn>;
    getAudience.mockRejectedValueOnce(new GraphError("does not exist", 400, 100, 33)).mockRejectedValueOnce(new PromoteThrottledError({ reason: "busy", until: new Date(NOW + 60_000), scope: "act_123", now: NOW }));
    expect(await syncAudiences(w.deps)).toEqual({ audiences: 4, updated: 1, failed: 1 });
    // gone, then the busy account once (its second audience is not asked), then the other workspace.
    expect(getAudience.mock.calls.map((c) => c[1])).toEqual([gone.metaAudienceId, busyFirst.metaAudienceId, otherTenant.metaAudienceId]);
    expect(w.audiences.find((a) => a.id === gone.id)).toMatchObject({ status: "error", lastError: AUDIENCE_COPY.gone });
    expect(w.audiences.find((a) => a.id === otherTenant.id)).toMatchObject({ status: "ready" });
    // The busy account's audiences are not stamped: they are first in line next time.
    expect(w.audiences.find((a) => a.id === busyFirst.id)!.lastSyncedAt!.getTime()).toBe(NOW - 8 * HOUR);
    expect(w.audiences.find((a) => a.id === busySecond.id)!.lastSyncedAt!.getTime()).toBe(NOW - 7 * HOUR);
  });

  it("failures are stamped, so 200 audiences that keep failing can't keep a healthy one from being read", async () => {
    const w = world();
    expect(SYNC_BATCH).toBe(200);
    // 200 audiences whose connection expired (never read, so first in line), and one healthy audience read 7 hours ago.
    const failing = Array.from({ length: SYNC_BATCH }, () => seedAudience(w, { status: "ready", lastSyncedAt: null }));
    const healthy = seedAudience(w, { tenantId: "t2", adAccountAssetId: "acc_t2", status: "populating", lastSyncedAt: new Date(NOW - 7 * HOUR) });
    const failingIds = new Set(failing.map((a) => a.metaAudienceId));
    const expired = new HttpError(409, "The Meta connection for this asset has expired or been disconnected. Reconnect it in Settings.");
    const getAudience = w.deps.meta.getAudience as ReturnType<typeof vi.fn>;
    getAudience.mockImplementation(async (_c, id: string) => {
      if (failingIds.has(id)) throw expired;
      return { id, lower: 5000, upper: 7000, operationStatus: { code: 200, description: null }, deliveryStatus: { code: 200, description: null } };
    });
    // Run 1 at NOW: the batch is the 200 failing ones; each is stamped and says what to do.
    expect(await syncAudiences(w.deps)).toEqual({ audiences: 200, updated: 0, failed: 200 });
    expect(w.audiences.filter((a) => failingIds.has(a.metaAudienceId)).every((a) => a.lastSyncedAt?.getTime() === NOW && a.lastError === expired.message)).toBe(true);
    // Their status stays as it was: the audience didn't change on Meta.
    expect(w.audiences.find((a) => a.id === failing[0].id)!.status).toBe("ready");
    // Run 2, six hours later: the healthy one, read longest ago, comes first.
    w.clock.t = NOW + 6 * HOUR;
    getAudience.mockClear();
    const second = await syncAudiences(w.deps);
    expect(second.updated).toBe(1);
    expect(getAudience.mock.calls[0][1]).toBe(healthy.metaAudienceId);
    expect(w.audiences.find((a) => a.id === healthy.id)).toMatchObject({ status: "ready", lastError: null });
  });

  it("a read failure Meta never explains is stamped quietly; a lost permission is shown", async () => {
    const w = world();
    const odd = seedAudience(w, { lastError: null });
    const denied = seedAudience(w, {});
    const getAudience = w.deps.meta.getAudience as ReturnType<typeof vi.fn>;
    getAudience.mockRejectedValueOnce(new GraphError("Unknown", 400, 1)).mockRejectedValueOnce(new GraphError("Permissions", 400, 200));
    expect(await syncAudiences(w.deps)).toEqual({ audiences: 2, updated: 0, failed: 2 });
    expect(w.audiences.find((a) => a.id === odd.id)).toMatchObject({ status: "ready", lastError: null });
    expect(w.audiences.find((a) => a.id === odd.id)!.lastSyncedAt!.getTime()).toBe(NOW);
    expect(w.audiences.find((a) => a.id === denied.id)).toMatchObject({ status: "ready", lastError: AUDIENCE_COPY.noPermission });
  });

  it("the list carries the kinds on offer and the customer lists used of 50; views carry no Meta id", async () => {
    const w = world({ env: { PROMOTE_AUDIENCES: "engagement" } });
    seedAudience(w, { kind: "customer_list" });
    const list = await listAudiences(actor, w.deps);
    expect(list.kinds).toEqual(allowedKinds({ PROMOTE_AUDIENCES: "engagement" }));
    expect(list.customerLists).toEqual({ used: 1, max: 50 });
    // A customer list made before the flag went down is still listed, so it can be deleted.
    expect(list.audiences[0]).toMatchObject({ kind: "customer_list", available: false });
    expect(JSON.stringify(list)).not.toContain(w.audiences[0].metaAudienceId!);
    expect(audienceView({ ...w.audiences[0], status: "error", lastError: null }).problem).toBe(AUDIENCE_COPY.failed);
  });

  it("refresh of another kind reads Meta again; a saved audience has nothing to refresh", async () => {
    const w = world();
    const row = seedAudience(w, { status: "populating" });
    const out = await refreshAudience(actor, row.id, w.deps);
    expect(out.audience).toMatchObject({ status: "ready" });
    expect(w.deps.meta.getAudience).toHaveBeenCalledTimes(1);
    const saved = seedAudience(w, { kind: "saved", adAccountAssetId: null, metaAudienceId: null });
    expect(await rejects(refreshAudience(actor, saved.id, w.deps))).toMatchObject({ status: 400, message: AUDIENCE_COPY.savedNoRefresh });
    const list = seedAudience(w, { kind: "customer_list" });
    const off = world({ env: { PROMOTE_AUDIENCES: "engagement" } });
    off.audiences.push({ ...list });
    expect(await rejects(refreshAudience(actor, list.id, off.deps))).toMatchObject({ status: 403 });
  });
});

// =====================================================================================================================
// Forget and opt-out (5.5): an in-memory Prisma
// =====================================================================================================================

const EMAIL = "secret.person@example.com";
const PHONE = "+919812345678";
const EMAIL_HASH = sha(EMAIL);
const PHONE_HASH = sha("919812345678");

function seedForget() {
  h.db.seed("adAudience", [
    { id: "list_1", tenantId: "t1", kind: "customer_list", adAccountAssetId: "acc", metaAudienceId: "23851", deletedAt: null, createdAt: new Date(NOW - 30 * 24 * HOUR) },
    { id: "list_2", tenantId: "t1", kind: "customer_list", adAccountAssetId: "acc2", metaAudienceId: "23852", deletedAt: null, createdAt: new Date(NOW - 10 * 24 * HOUR) },
    { id: "list_gone", tenantId: "t1", kind: "customer_list", adAccountAssetId: "acc", metaAudienceId: "23853", deletedAt: new Date(NOW - HOUR), createdAt: new Date(NOW - 40 * 24 * HOUR) },
    { id: "list_small", tenantId: "t1", kind: "customer_list", adAccountAssetId: "acc", metaAudienceId: null, deletedAt: null, createdAt: new Date(NOW - HOUR) },
    { id: "eng_1", tenantId: "t1", kind: "engagement_page", adAccountAssetId: "acc", metaAudienceId: "23854", deletedAt: null, createdAt: new Date(NOW - HOUR) },
    { id: "list_t3", tenantId: "t3", kind: "customer_list", adAccountAssetId: "acc3", metaAudienceId: "23855", deletedAt: null, createdAt: new Date(NOW - HOUR) },
  ]);
  h.db.seed("contact", [{ id: "k1", tenantId: "t1", phone: PHONE, name: "Secret Person", attributes: { email: EMAIL }, optIn: true, optedOutAt: null }]);
}

const jobs = () => h.db.rows("job").filter((j) => j.queue === FORGET_QUEUE);

describe("forgetContact and the promote.audience.forget job (5.5)", () => {
  beforeEach(() => {
    for (const t of ["adAudience", "contact", "job", "platformSetting"]) h.db.rows(t).length = 0;
    Object.values(h.meta).forEach((fn) => fn.mockReset());
    h.meta.removeAudienceUsers.mockResolvedValue({ numReceived: 1 });
    h.meta.deleteAudience.mockResolvedValue({ deleted: true });
    h.runDueJobs.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("queues the hashed email and phone for every customer-list audience of the workspace on Meta", async () => {
    seedForget();
    expect(await forgetContact("t1", "k1")).toEqual({ queued: true, audiences: 2 });
    expect(jobs()).toHaveLength(1);
    const payload = jobs()[0].payload as Record<string, unknown>;
    expect(payload).toEqual({ tenantId: "t1", hashes: { schema: ["EMAIL", "PHONE"], rows: [[EMAIL_HASH, PHONE_HASH]] }, audienceIds: ["list_1", "list_2"] });
    expect(JSON.stringify(payload)).not.toContain(EMAIL);
    expect(JSON.stringify(payload)).not.toContain("9812345678");
    expect(h.meta.removeAudienceUsers).not.toHaveBeenCalled();
  });

  it("is a no-op without customer lists on Meta, for an unknown contact, or one with nothing to match by", async () => {
    expect(await forgetContact("t1", "k1")).toEqual({ queued: false, audiences: 0 });
    seedForget();
    expect(await forgetContact("t1", "nobody")).toEqual({ queued: false, audiences: 2 });
    expect(await forgetContact("t2", "k1")).toEqual({ queued: false, audiences: 0 });
    h.db.seed("contact", [{ id: "k2", tenantId: "t1", phone: null, attributes: {}, optIn: false, optedOutAt: null }]);
    expect(await forgetContact("t1", "k2")).toEqual({ queued: false, audiences: 2 });
    expect(jobs()).toHaveLength(0);
  });

  it("writes the job in the erasure's transaction when given one", async () => {
    seedForget();
    const created: unknown[] = [];
    const tx = { adAudience: h.prisma.adAudience, contact: h.prisma.contact, job: { create: async (a: unknown) => void created.push(a) } };
    await forgetContact("t1", "k1", { db: tx as never });
    expect(created).toHaveLength(1);
    expect(jobs()).toHaveLength(0);
  });

  it("the job sends A4 to every customer-list audience; one Meta no longer has is skipped", async () => {
    seedForget();
    await forgetContact("t1", "k1");
    h.meta.removeAudienceUsers.mockResolvedValueOnce({ numReceived: 1 }).mockRejectedValueOnce(new GraphError("does not exist", 400, 100, 33));
    const out = await handleForgetJob(jobs()[0].payload);
    expect(out).toEqual({ audiences: 2, sent: 1, skipped: 1 });
    expect(h.meta.removeAudienceUsers).toHaveBeenCalledWith({ tenantId: "t1", adAccountAssetId: "acc" }, "23851", { schema: ["EMAIL", "PHONE"], rows: [[EMAIL_HASH, PHONE_HASH]] });
    expect(h.meta.removeAudienceUsers).toHaveBeenCalledWith({ tenantId: "t1", adAccountAssetId: "acc2" }, "23852", { schema: ["EMAIL", "PHONE"], rows: [[EMAIL_HASH, PHONE_HASH]] });
    // An audience made after the job was queued is covered too (it can only hold consented people, so this is harmless).
    h.db.seed("adAudience", [{ id: "list_new", tenantId: "t1", kind: "customer_list", adAccountAssetId: "acc", metaAudienceId: "23856", deletedAt: null, createdAt: new Date(NOW) }]);
    h.meta.removeAudienceUsers.mockClear();
    await handleForgetJob(jobs()[0].payload);
    expect(h.meta.removeAudienceUsers).toHaveBeenCalledTimes(3);
  });

  it("an expired or disconnected Meta connection (409) or a missing permission (403) is retried, not skipped", async () => {
    seedForget();
    await forgetContact("t1", "k1");
    const payload = jobs()[0].payload;
    const expired = new HttpError(409, "The Meta connection for this asset has expired or been disconnected. Reconnect it in Settings.");
    for (const error of [expired, new HttpError(409, "This asset is no longer available on the connected Meta account."), new HttpError(403, "Not allowed."), new GraphError("Error validating access token", 400, 190), new GraphError("Permissions", 400, 200)]) {
      h.meta.removeAudienceUsers.mockReset().mockResolvedValueOnce({ numReceived: 1 }).mockRejectedValueOnce(error);
      const e = await rejects(handleForgetJob(payload));
      expect(e.message, String(error)).toBe("Could not remove people from 1 customer list audience on Meta yet. The job will try again.");
    }
    // Only what can never be reached again is skipped: our own 400 (not an audience of this account) and a 404 ad account.
    h.meta.removeAudienceUsers.mockReset().mockRejectedValueOnce(new HttpError(400, "That isn't an audience on this ad account. Choose one of its audiences.")).mockRejectedValueOnce(new HttpError(404, "Asset not found."));
    expect(await handleForgetJob(payload)).toEqual({ audiences: 2, sent: 0, skipped: 2 });
  });

  it("while the connection is down the job stays queued and is not purged; it is retried for the 7 days a payload may be kept", async () => {
    seedForget();
    await forgetContact("t1", "k1");
    // runDueJobs (src/lib/queue.ts): a handler that throws leaves the job queued with a later runAt.
    h.runDueJobs.mockImplementation(async (queue: string, handler: (p: unknown) => Promise<void>) => {
      const due = h.db.rows("job").filter((j) => j.queue === queue && j.status === "queued");
      for (const j of due) {
        j.attempts = (j.attempts as number) + 1;
        try {
          await handler(j.payload);
          j.status = "done";
        } catch (error) {
          j.lastError = (error as Error).message;
        }
      }
      return due.length;
    });
    h.meta.removeAudienceUsers.mockRejectedValue(new HttpError(409, "The Meta connection for this asset has expired or been disconnected. Reconnect it in Settings."));
    expect(await runForgetQueue()).toEqual({ sent: 1, purged: 0 });
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]).toMatchObject({ status: "queued", attempts: 1, maxAttempts: FORGET_MAX_ATTEMPTS });
    // Reconnected: the next run removes the person and the job goes.
    h.meta.removeAudienceUsers.mockReset().mockResolvedValue({ numReceived: 1 });
    expect(await runForgetQueue()).toEqual({ sent: 1, purged: 1 });
    expect(h.meta.removeAudienceUsers).toHaveBeenCalledTimes(2);
    expect(jobs()).toHaveLength(0);
    // runDueJobs backs off 1, 2, 4, 8, 16 minutes, then 30: the tries cover close to the 7 days, never beyond them.
    const backoff = (attempt: number) => Math.min(60_000 * 2 ** (attempt - 1), 30 * 60_000);
    const span = Array.from({ length: FORGET_MAX_ATTEMPTS - 1 }, (_, i) => backoff(i + 1)).reduce((a, b) => a + b, 0);
    expect(span).toBeLessThanOrEqual(FORGET_KEEP_MS);
    expect(span).toBeGreaterThan(FORGET_KEEP_MS - 6 * HOUR);
  });

  it("a failure throws for a retry with a message that carries no hash, no email and no phone; nothing is logged", async () => {
    seedForget();
    await forgetContact("t1", "k1");
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(log, "info"), vi.spyOn(log, "warn"), vi.spyOn(log, "error"), vi.spyOn(log, "debug")];
    h.meta.removeAudienceUsers.mockRejectedValue(new GraphError(`Server error for ${EMAIL_HASH}`, 500, 2));
    const error = await rejects(handleForgetJob(jobs()[0].payload));
    expect(error.message).toBe("Could not remove people from 2 customer list audiences on Meta yet. The job will try again.");
    for (const secret of [EMAIL_HASH, PHONE_HASH, EMAIL, "9812345678"]) expect(error.message).not.toContain(secret);
    h.meta.removeAudienceUsers.mockResolvedValue({ numReceived: 1 });
    await handleForgetJob(jobs()[0].payload);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of [EMAIL_HASH, PHONE_HASH, EMAIL, "9812345678"]) expect(logged).not.toContain(secret);
  });

  it("refuses a payload that is not hashes", async () => {
    expect(parseForgetPayload({ tenantId: "t1", hashes: { schema: ["EMAIL", "PHONE"], rows: [[EMAIL, ""]] }, audienceIds: [] })).toBeNull();
    expect(parseForgetPayload({ tenantId: "t1", hashes: { schema: ["PHONE", "EMAIL"], rows: [[EMAIL_HASH, ""]] } })).toBeNull();
    expect(parseForgetPayload(null)).toBeNull();
    seedForget();
    expect(await handleForgetJob({ tenantId: "t1", hashes: { schema: ["EMAIL", "PHONE"], rows: [["secret@x.com", "919812345678"]] } })).toEqual({ audiences: 0, sent: 0, skipped: 0 });
    expect(h.meta.removeAudienceUsers).not.toHaveBeenCalled();
  });

  it("each run deletes done jobs with their payloads, and any job older than 7 days", async () => {
    seedForget();
    await forgetContact("t1", "k1");
    h.db.seed("job", [
      { id: "old", queue: FORGET_QUEUE, status: "failed", payload: { tenantId: "t1" }, createdAt: new Date(Date.now() - FORGET_KEEP_MS - 60_000) },
      { id: "recent_failed", queue: FORGET_QUEUE, status: "failed", payload: { tenantId: "t1" }, createdAt: new Date(Date.now() - 24 * HOUR) },
      { id: "other_queue", queue: "send", status: "done", payload: {}, createdAt: new Date(Date.now() - 30 * 24 * HOUR) },
    ]);
    // runDueJobs (src/lib/queue.ts) claims, runs and marks done.
    h.runDueJobs.mockImplementation(async (queue: string, handler: (p: unknown) => Promise<void>) => {
      const due = h.db.rows("job").filter((j) => j.queue === queue && j.status === "queued");
      for (const j of due) {
        await handler(j.payload);
        j.status = "done";
      }
      return due.length;
    });
    const out = await runForgetQueue();
    expect(out).toEqual({ sent: 1, purged: 2 });
    expect(h.meta.removeAudienceUsers).toHaveBeenCalledTimes(2);
    expect(h.db.rows("job").map((j) => j.id).sort()).toEqual(["other_queue", "recent_failed"]);
    expect(JSON.stringify(h.db.rows("job"))).not.toContain(EMAIL_HASH);
  });

  it("runs from the worker whatever PROMOTE_ENABLED says", async () => {
    const saved = process.env.PROMOTE_ENABLED;
    process.env.PROMOTE_ENABLED = "off";
    try {
      h.runDueJobs.mockResolvedValue(0);
      const { worker } = await import("@/lib/promote/worker");
      const task = worker.periodic.find((t) => t.name === "promote.audience.forget")!;
      expect(task.everyMs).toBe(60_000);
      expect(await task.run()).toEqual({ sent: 0, purged: 0 });
      expect(h.runDueJobs).toHaveBeenCalledWith(FORGET_QUEUE, expect.any(Function), 10);
    } finally {
      if (saved === undefined) delete process.env.PROMOTE_ENABLED;
      else process.env.PROMOTE_ENABLED = saved;
    }
  });

  it("workspace and connection erasure delete the customer lists on Meta, best effort", async () => {
    seedForget();
    h.meta.deleteAudience.mockResolvedValueOnce({ deleted: true }).mockRejectedValueOnce(new GraphError("Server", 500, 1));
    expect(await queueWorkspaceAudienceDeletes("t1")).toEqual({ audiences: 2, queued: 1, failed: 1 });
    expect(h.meta.deleteAudience.mock.calls.map((c) => c[1]).sort()).toEqual(["23851", "23852"]);
    h.meta.deleteAudience.mockReset().mockRejectedValueOnce(new GraphError("does not exist", 400, 100, 33));
    expect(await queueAdAccountAudienceDeletes("t1", ["acc2"])).toEqual({ audiences: 1, queued: 1, failed: 0 });
    expect(await queueAdAccountAudienceDeletes("t1", [])).toEqual({ audiences: 0, queued: 0, failed: 0 });
    expect(await queueWorkspaceAudienceDeletes("t9")).toEqual({ audiences: 0, queued: 0, failed: 0 });
  });
});

describe("the nightly opt-out sweep (5.5)", () => {
  const day = 24 * HOUR;
  beforeEach(() => {
    for (const t of ["adAudience", "contact", "job", "platformSetting", "auditLog"]) h.db.rows(t).length = 0;
  });

  it("also picks consents withdrawn without an opt-out (the API's optIn false), from the audit log of the window", async () => {
    seedForget();
    h.db.rows("contact").length = 0;
    h.db.seed("contact", [
      // The public API set optIn false and left optedOutAt empty (integrations/v1-service.ts).
      { id: "api_out", tenantId: "t1", phone: "+919800000011", attributes: {}, optIn: false, optInAt: new Date(NOW - 40 * day), optedOutAt: null },
      // Withdrew, then agreed again: stays in the list.
      { id: "again", tenantId: "t1", phone: "+919800000012", attributes: {}, optIn: true, optedOutAt: null },
      // Withdrew before the window.
      { id: "old", tenantId: "t1", phone: "+919800000013", attributes: {}, optIn: false, optedOutAt: null },
      // A STOP in the window: found by optedOutAt and audited too, but queued once.
      { id: "stop", tenantId: "t1", phone: "+919800000014", attributes: {}, optIn: false, optedOutAt: new Date(NOW - 2 * HOUR) },
      // An audit row naming a contact of another workspace is not taken for this one.
      { id: "elsewhere", tenantId: "t3", phone: "+919800000015", attributes: {}, optIn: false, optedOutAt: null },
    ]);
    h.db.seed("auditLog", [
      { id: "al1", tenantId: "t1", action: "contact.consent_withdrawn", target: "api_out", createdAt: new Date(NOW - 3 * HOUR) },
      { id: "al2", tenantId: "t1", action: "contact.consent_withdrawn", target: "again", createdAt: new Date(NOW - 4 * HOUR) },
      { id: "al3", tenantId: "t1", action: "contact.consent_withdrawn", target: "old", createdAt: new Date(NOW - 30 * HOUR) },
      { id: "al4", tenantId: "t1", action: "contact.opted_out", target: "stop", createdAt: new Date(NOW - 2 * HOUR) },
      { id: "al5", tenantId: "t1", action: "contact.consent_withdrawn", target: "elsewhere", createdAt: new Date(NOW - HOUR) },
      { id: "al6", tenantId: "t1", action: "contact.consent_recorded", target: "again", createdAt: new Date(NOW - HOUR) },
    ]);
    h.db.seed("platformSetting", [{ key: OPTOUT_CURSOR_KEY, value: { at: new Date(NOW - day).toISOString() } }]);
    expect(await sweepOptOuts({ now: () => NOW })).toEqual({ contacts: 2, queued: 2 });
    expect(jobs()).toHaveLength(1);
    const payload = jobs()[0].payload as { tenantId: string; hashes: { rows: string[][] }; audienceIds: string[] };
    expect(payload.tenantId).toBe("t1");
    expect(payload.hashes.rows).toEqual([["", sha("919800000014")], ["", sha("919800000011")]]);
    expect(payload.audienceIds).toEqual(["list_1", "list_2"]);
  });

  const seedOptOuts = () => {
    seedForget();
    h.db.rows("contact").length = 0;
    h.db.seed("contact", [
      { id: "o2h", tenantId: "t1", phone: "+919800000002", attributes: {}, optIn: false, optedOutAt: new Date(NOW - 2 * HOUR) },
      { id: "o25h", tenantId: "t1", phone: null, attributes: { email: "x25@example.com" }, optIn: false, optedOutAt: new Date(NOW - 25 * HOUR) },
      { id: "o30h", tenantId: "t1", phone: "+919800000030", attributes: {}, optIn: false, optedOutAt: new Date(NOW - 30 * HOUR) },
      { id: "never", tenantId: "t1", phone: "+919800000099", attributes: {}, optIn: true, optedOutAt: null },
      { id: "noid", tenantId: "t1", phone: null, attributes: {}, optIn: false, optedOutAt: new Date(NOW - HOUR) },
      { id: "t2", tenantId: "t2", phone: "+919800000077", attributes: {}, optIn: false, optedOutAt: new Date(NOW - HOUR) },
      { id: "t3", tenantId: "t3", phone: "+919800000088", attributes: {}, optIn: false, optedOutAt: new Date(NOW - HOUR) },
    ]);
  };

  it("picks only withdrawals of the last 26 hours, in workspaces with customer lists, one job per workspace", async () => {
    seedOptOuts();
    h.db.seed("platformSetting", [{ key: OPTOUT_CURSOR_KEY, value: { at: new Date(NOW - day).toISOString() } }]);
    const out = await sweepOptOuts({ now: () => NOW });
    expect(out).toEqual({ contacts: 4, queued: 3 });
    const byTenant = Object.fromEntries(jobs().map((j) => [(j.payload as { tenantId: string }).tenantId, j.payload as { hashes: { rows: string[][] }; audienceIds: string[] }]));
    expect(Object.keys(byTenant).sort()).toEqual(["t1", "t3"]);
    expect(byTenant.t1.hashes.rows).toEqual([["", sha("919800000002")], [sha("x25@example.com"), ""]]);
    expect(byTenant.t1.audienceIds).toEqual(["list_1", "list_2"]);
    expect(byTenant.t3.hashes.rows).toEqual([["", sha("919800000088")]]);
    // The cursor moves to the run's start.
    expect(h.db.rows("platformSetting").find((r) => r.key === OPTOUT_CURSOR_KEY)!.value).toEqual({ at: new Date(NOW).toISOString() });
  });

  it("catches up from an older cursor (a skipped or failed run), and the first run starts at the oldest customer list", async () => {
    seedOptOuts();
    h.db.seed("platformSetting", [{ key: OPTOUT_CURSOR_KEY, value: { at: new Date(NOW - 3 * day).toISOString() } }]);
    const caught = await sweepOptOuts({ now: () => NOW });
    expect(caught.contacts).toBe(5);
    expect((jobs().find((j) => (j.payload as { tenantId: string }).tenantId === "t1")!.payload as { hashes: { rows: string[][] } }).hashes.rows).toHaveLength(3);
    h.db.rows("job").length = 0;
    h.db.rows("platformSetting").length = 0;
    expect((await sweepOptOuts({ now: () => NOW })).contacts).toBe(5);
  });

  it("does nothing without customer lists on Meta", async () => {
    h.db.seed("contact", [{ id: "x", tenantId: "t1", phone: "+919800000002", attributes: {}, optIn: false, optedOutAt: new Date(NOW - HOUR) }]);
    expect(await sweepOptOuts({ now: () => NOW })).toEqual({ contacts: 0, queued: 0 });
    expect(jobs()).toHaveLength(0);
    expect(h.db.rows("platformSetting")).toHaveLength(0);
  });
});

// =====================================================================================================================
// The routes (4.8)
// =====================================================================================================================

const ORIGIN = "https://wa.edwyz.com";
let tenant = 0;

const routeActor = (role: "owner" | "admin" | "agent" = "admin") => ({ userId: `ru${tenant}`, tenantId: `rt${tenant}`, role });
const get = (url: string) => new Request(`${ORIGIN}${url}`);
const send = (method: string, url: string, body?: unknown, origin = ORIGIN) => new Request(`${ORIGIN}${url}`, { method, headers: { origin, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const SAVED = { kind: "saved", name: "Pune", targeting: { geo: { countries: ["IN"] }, ageMin: 18, ageMax: 65 } };

describe("the /api/promote/audiences routes", () => {
  beforeEach(() => {
    process.env.SITE_URL = ORIGIN;
    process.env.PROMOTE_ENABLED = "on";
    process.env.PROMOTE_AUDIENCES = "all";
    delete process.env.SPEND_DRY_RUN;
    tenant++;
    for (const t of ["adAudience", "adAudienceUpload", "contact", "job", "spendControl", "metaAsset", "auditLog"]) h.db.rows(t).length = 0;
    h.db.seed("spendControl", [{ tenantId: `rt${tenant}`, spendingAdAccountAssetId: "acc" }]);
    h.db.seed("metaAsset", [{ id: "acc", tenantId: `rt${tenant}`, type: "ad_account", status: "active", externalId: "act_123" }]);
    h.getActor.mockReset().mockResolvedValue(routeActor());
    Object.values(h.meta).forEach((fn) => fn.mockReset());
    h.meta.getAdAccountHealth.mockResolvedValue({ tosAccepted: { custom_audience_tos: 1 }, userTosAccepted: { custom_audience_tos: 1 } });
    h.meta.createCustomAudience.mockResolvedValue({ id: "2384999" });
    h.meta.addAudienceUsers.mockResolvedValue({});
    h.meta.deleteAudience.mockResolvedValue({ deleted: true });
  });
  afterEach(() => {
    delete process.env.PROMOTE_AUDIENCES;
  });

  it("create, list, read and delete a saved audience", async () => {
    const { GET, POST } = await import("@/app/api/promote/audiences/route");
    const one = await import("@/app/api/promote/audiences/[id]/route");
    const created = await POST(send("POST", "/api/promote/audiences", SAVED), undefined);
    expect(created.status).toBe(201);
    const { audience } = (await created.json()) as { audience: { id: string; kind: string } };
    expect(audience.kind).toBe("saved");
    const list = (await (await GET(get("/api/promote/audiences"), undefined)).json()) as { audiences: { id: string }[]; kinds: string[] };
    expect(list.audiences.map((a) => a.id)).toEqual([audience.id]);
    expect(list.kinds).toContain("customer_list");
    expect(((await (await one.GET(get(`/api/promote/audiences/${audience.id}`), params(audience.id))).json()) as { audience: { id: string } }).audience.id).toBe(audience.id);
    expect((await one.DELETE(send("DELETE", `/api/promote/audiences/${audience.id}`), params(audience.id))).status).toBe(200);
    expect((await one.GET(get(`/api/promote/audiences/${audience.id}`), params(audience.id))).status).toBe(404);
    expect(h.meta.deleteAudience).not.toHaveBeenCalled();
  });

  it("customer lists: the preview counts, missing terms answer 409 with the fix", async () => {
    const { GET, POST } = await import("@/app/api/promote/audiences/route");
    h.db.seed("contact", [
      ...Array.from({ length: 120 }, (_, i) => ({ id: `rc${i}`, tenantId: `rt${tenant}`, phone: `+9197${String(i).padStart(8, "0")}`, name: null, attributes: {}, optIn: true, optedOutAt: null, tags: [] })),
      { id: "rc_out", tenantId: `rt${tenant}`, phone: "+919700009999", name: null, attributes: {}, optIn: true, optedOutAt: new Date(), tags: [] },
    ]);
    const preview = (await (await GET(get("/api/promote/audiences?preview=customer_list"), undefined)).json()) as { count: { line: string } };
    expect(preview.count.line).toBe("120 of 121 contacts can be included.");
    h.meta.getAdAccountHealth.mockResolvedValueOnce({ tosAccepted: {}, userTosAccepted: {} });
    const res = await POST(send("POST", "/api/promote/audiences", { kind: "customer_list", name: "All" }), undefined);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "Accept Meta's audience terms first.", kind: "custom_audience_tos", fix: { key: "custom_audience_tos" } });
    expect(h.meta.createCustomAudience).not.toHaveBeenCalled();
    // Accepted: created on Meta and queued (202), the row holds the lawful basis; no A2 inside the request.
    const ok = await POST(send("POST", "/api/promote/audiences", { kind: "customer_list", name: "All" }), undefined);
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ count: { included: 120, total: 121 }, upload: { state: "queued", totalRows: 120 }, notice: AUDIENCE_COPY.sending });
    expect(h.meta.addAudienceUsers).not.toHaveBeenCalled();
    expect(h.db.rows("adAudience")[0]).toMatchObject({ kind: "customer_list", consentBasis: "marketing_opt_in", metaAudienceId: "2384999" });
    expect(h.db.rows("adAudienceUpload")[0]).toMatchObject({ mode: "add", totalRows: 120, sentRows: 0, batchSeq: 0, status: "queued" });
    // The upload task sends it (the Prisma store).
    expect(await sendQueuedUploads()).toEqual({ uploads: 1, done: 1, waiting: 0, failed: 0 });
    expect(h.meta.addAudienceUsers).toHaveBeenCalledTimes(1);
    expect(h.db.rows("adAudienceUpload")[0]).toMatchObject({ mode: "add", totalRows: 120, sentRows: 120, batchSeq: 1, status: "done" });
    // A refresh queues a replace (202) and sends nothing in the request.
    const { POST: refresh } = await import("@/app/api/promote/audiences/[id]/refresh/route");
    const id = h.db.rows("adAudience")[0].id as string;
    const again = await refresh(send("POST", `/api/promote/audiences/${id}/refresh`), params(id));
    expect(again.status).toBe(202);
    expect(h.meta.replaceAudienceUsers).not.toHaveBeenCalled();
    expect(h.db.rows("adAudienceUpload")[1]).toMatchObject({ mode: "replace", status: "queued" });
  });

  it("Meta's other errors answer in plain words, not 'Something went wrong.'", async () => {
    const { POST } = await import("@/app/api/promote/audiences/route");
    const one = await import("@/app/api/promote/audiences/[id]/route");
    h.db.seed("metaAsset", [{ id: "pg1", tenantId: `rt${tenant}`, type: "page", status: "active", externalId: "104857600123", name: "Shop" }]);
    h.meta.createCustomAudience.mockRejectedValueOnce(new GraphError("Error validating access token", 400, 190));
    const revoked = await POST(send("POST", "/api/promote/audiences", { kind: "engagement_page", sourceId: "pg1" }), undefined);
    expect(revoked.status).toBe(409);
    expect(await revoked.json()).toEqual({ error: AUDIENCE_COPY.reconnect });
    h.meta.createCustomAudience.mockRejectedValueOnce(new GraphError("(#2654) Something Meta says", 400, 2654));
    const refused = await POST(send("POST", "/api/promote/audiences", { kind: "engagement_page", sourceId: "pg1" }), undefined);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: AUDIENCE_COPY.refused });
    expect(h.db.rows("adAudience")).toHaveLength(0);
    // A6 refused: the answer says what to do, and the audience stays.
    h.db.seed("adAudience", [{ id: "aud_live", tenantId: `rt${tenant}`, kind: "engagement_page", adAccountAssetId: "acc", metaAudienceId: "23859", status: "ready", deletedAt: null, spec: {}, createdAt: new Date() }]);
    h.meta.deleteAudience.mockRejectedValueOnce(new GraphError("in use", 400, 2654));
    const del = await one.DELETE(send("DELETE", "/api/promote/audiences/aud_live"), params("aud_live"));
    expect(del.status).toBe(502);
    expect(await del.json()).toEqual({ error: AUDIENCE_COPY.refusedDelete });
    expect(h.db.rows("adAudience")[0].deletedAt).toBeNull();
  });

  it("agents get 403 on every write, and on the admin reads", async () => {
    const { GET, POST } = await import("@/app/api/promote/audiences/route");
    const one = await import("@/app/api/promote/audiences/[id]/route");
    const { POST: refresh } = await import("@/app/api/promote/audiences/[id]/refresh/route");
    h.getActor.mockResolvedValue(routeActor("agent"));
    expect((await POST(send("POST", "/api/promote/audiences", SAVED), undefined)).status).toBe(403);
    expect((await one.DELETE(send("DELETE", "/api/promote/audiences/aud_1"), params("aud_1"))).status).toBe(403);
    expect((await refresh(send("POST", "/api/promote/audiences/aud_1/refresh"), params("aud_1"))).status).toBe(403);
    expect((await GET(get("/api/promote/audiences"), undefined)).status).toBe(403);
    expect((await one.GET(get("/api/promote/audiences/aud_1"), params("aud_1"))).status).toBe(403);
    // Another site's page can't write either.
    h.getActor.mockResolvedValue(routeActor());
    expect((await POST(send("POST", "/api/promote/audiences", SAVED, "https://evil.example"), undefined)).status).toBe(403);
    expect(h.db.rows("adAudience")).toHaveLength(0);
  });

  it("10 creates and refreshes an hour per workspace, then 429", async () => {
    const { POST } = await import("@/app/api/promote/audiences/route");
    const { POST: refresh } = await import("@/app/api/promote/audiences/[id]/refresh/route");
    for (let i = 0; i < 9; i++) expect((await POST(send("POST", "/api/promote/audiences", SAVED), undefined)).status).toBe(201);
    const id = h.db.rows("adAudience")[0].id as string;
    // A refresh counts too (a saved audience has nothing to refresh, but the try is counted).
    expect((await refresh(send("POST", `/api/promote/audiences/${id}/refresh`), params(id))).status).toBe(400);
    const limited = await POST(send("POST", "/api/promote/audiences", SAVED), undefined);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe(AUDIENCE_COPY.tooManyWrites);
    expect((await refresh(send("POST", `/api/promote/audiences/${id}/refresh`), params(id))).status).toBe(429);
    // Deleting is never held back.
    const one = await import("@/app/api/promote/audiences/[id]/route");
    expect((await one.DELETE(send("DELETE", `/api/promote/audiences/${id}`), params(id))).status).toBe(200);
  });

  it("everything is 404 while PROMOTE_ENABLED is off", async () => {
    const { GET, POST } = await import("@/app/api/promote/audiences/route");
    const one = await import("@/app/api/promote/audiences/[id]/route");
    const { POST: refresh } = await import("@/app/api/promote/audiences/[id]/refresh/route");
    const { POST: size } = await import("@/app/api/promote/audiences/size/route");
    process.env.PROMOTE_ENABLED = "off";
    expect((await GET(get("/api/promote/audiences"), undefined)).status).toBe(404);
    expect((await POST(send("POST", "/api/promote/audiences", SAVED), undefined)).status).toBe(404);
    expect((await one.GET(get("/api/promote/audiences/x"), params("x"))).status).toBe(404);
    expect((await one.DELETE(send("DELETE", "/api/promote/audiences/x"), params("x"))).status).toBe(404);
    expect((await refresh(send("POST", "/api/promote/audiences/x/refresh"), params("x"))).status).toBe(404);
    expect((await size(send("POST", "/api/promote/audiences/size", { targeting: {} }), undefined)).status).toBe(404);
    expect(h.db.rows("adAudience")).toHaveLength(0);
  });

  it("the kind the flags don't offer is refused with plain words", async () => {
    const { POST } = await import("@/app/api/promote/audiences/route");
    process.env.PROMOTE_AUDIENCES = "off";
    const res = await POST(send("POST", "/api/promote/audiences", { kind: "website" }), undefined);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(AUDIENCE_COPY.savedOnly);
    expect(h.meta.createCustomAudience).not.toHaveBeenCalled();
  });
});
