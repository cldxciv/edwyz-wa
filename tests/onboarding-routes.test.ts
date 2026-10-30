import { beforeEach, describe, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());
vi.mock("@/lib/onboarding", async () => ({ ...(await vi.importActual<object>("@/lib/onboarding")), runOnboarding: run }));
// PlatformSetting stand-in: rows keyed by string, create fails on a duplicate key, deleteMany reports how many rows it removed.
const rows = vi.hoisted(() => new Map<string, { value: unknown; updatedAt: Date }>());
vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    platformSetting: {
      create: vi.fn(async ({ data }: { data: { key: string; value: unknown } }) => {
        if (rows.has(data.key)) throw Object.assign(new Error("dup"), { code: "P2002" });
        rows.set(data.key, { value: data.value, updatedAt: new Date() });
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { key: string | { startsWith: string }; updatedAt?: { lt: Date } } }) => {
        let count = 0;
        for (const [key, row] of [...rows]) {
          const hit = typeof where.key === "string" ? key === where.key : key.startsWith(where.key.startsWith) && (!where.updatedAt || row.updatedAt < where.updatedAt.lt);
          if (hit) {
            rows.delete(key);
            count++;
          }
        }
        return { count };
      }),
    },
  },
}));
const actor = vi.hoisted(() => ({ current: { userId: "u1", tenantId: "session-tenant", role: "owner" } as { userId: string; tenantId: string; role: string } }));
vi.mock("@/lib/auth", () => ({ getActor: vi.fn(async () => actor.current) }));

import { createHash } from "node:crypto";
import { createState } from "@/lib/oauth-state";
import { consumeSignupState, consumeState, issueSignupState, issueState } from "@/lib/meta-connect/state";
import { POST } from "@/app/api/onboarding/complete/route";
import { GET as start } from "@/app/api/onboarding/start/route";

const SECRET = "state-secret-state-secret-state-secret";
const post = (body: unknown, origin: string | null = "https://wa.edwyz.com") =>
  new Request("https://wa.edwyz.com/api/onboarding/complete", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
const issue = () => issueSignupState("session-tenant", "u1");
const valid = async () => ({ code: "c", wabaId: "1111111", phoneNumberId: "2222222", state: await issue() });

beforeEach(() => {
  process.env.STATE_SECRET = SECRET;
  process.env.SITE_URL = "https://wa.edwyz.com";
  actor.current = { userId: "u1", tenantId: "session-tenant", role: "owner" };
  rows.clear();
  run.mockReset();
  run.mockResolvedValue({ ok: true, steps: [] });
});

describe("POST /api/onboarding/complete", () => {
  it("rejects a bad state", async () => {
    const res = await POST(post({ ...valid(), state: "bad.state.value" }));
    expect(res.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a wrong origin and a missing origin", async () => {
    expect((await POST(post(await valid(), "https://evil.example"))).status).toBe(403);
    expect((await POST(post(await valid(), null))).status).toBe(403);
  });

  it("uses the session tenant and ignores a tenantId in the body", async () => {
    const res = await POST(post({ ...(await valid()), tenantId: "victim-tenant" }));
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledWith({ tenantId: "session-tenant", code: "c", wabaId: "1111111", phoneNumberId: "2222222", skipRegistration: false });
  });

  it("forbids agents", async () => {
    actor.current.role = "agent";
    expect((await POST(post(await valid()))).status).toBe(403);
  });

  it("validates ids", async () => {
    expect((await POST(post({ ...(await valid()), wabaId: "abc" }))).status).toBe(400);
  });
});

describe("GET /api/onboarding/start", () => {
  it("returns config and a verifiable state", async () => {
    process.env.META_ES_CONFIG_ID = "cfg";
    process.env.META_APP_ID = "app";
    const res = await start(new Request("https://wa.edwyz.com/api/onboarding/start"));
    const body = await res.json();
    expect(body).toMatchObject({ configId: "cfg", appId: "app" });
    await expect(consumeSignupState("session-tenant", "u1", body.state)).resolves.toBeUndefined();
  });

  it("stores the nonce under a hash and keeps it for at most the state lifetime", async () => {
    process.env.META_ES_CONFIG_ID = "cfg";
    process.env.META_APP_ID = "app";
    const body = await (await start(new Request("https://wa.edwyz.com/api/onboarding/start"))).json();
    const nonce = body.state.split(".")[0];
    expect([...rows.keys()]).toEqual([`wa-signup-state:${createHash("sha256").update(nonce).digest("hex")}`]);
    expect([...rows.keys()].join()).not.toContain(nonce);
  });
});

describe("Embedded Signup state is bound and single use", () => {
  it("refuses a replayed state: the second POST with the same state is a 400 and onboarding runs once", async () => {
    const body = await valid();
    expect((await POST(post(body))).status).toBe(200);
    expect((await POST(post(body))).status).toBe(400);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses a state issued for another user or another workspace", async () => {
    const otherUser = { code: "c", wabaId: "1111111", phoneNumberId: "2222222", state: await issueSignupState("session-tenant", "u2") };
    expect((await POST(post(otherUser))).status).toBe(400);
    const otherTenant = { code: "c", wabaId: "1111111", phoneNumberId: "2222222", state: await issueSignupState("victim-tenant", "u1") };
    expect((await POST(post(otherTenant))).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses an expired state and a state that was never stored", async () => {
    const state = await issue();
    const [nonce] = state.split(".");
    const key = [...rows.keys()][0];
    rows.delete(key); // e.g. swept after expiry, or lost: no row means no use
    expect((await POST(post({ code: "c", wabaId: "1111111", phoneNumberId: "2222222", state }))).status).toBe(400);
    expect(nonce).toHaveLength(32);
    vi.useFakeTimers();
    try {
      const old = await issue();
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect((await POST(post({ code: "c", wabaId: "1111111", phoneNumberId: "2222222", state: old }))).status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a missing state, the old unbound state format, and a Meta Connect state", async () => {
    const base = { code: "c", wabaId: "1111111", phoneNumberId: "2222222" };
    expect((await POST(post(base))).status).toBe(400);
    expect((await POST(post({ ...base, state: createState(SECRET) }))).status).toBe(400);
    expect((await POST(post({ ...base, state: await issueState("session-tenant", "u1") }))).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not use up the state when the request is malformed", async () => {
    const state = await issue();
    expect((await POST(post({ code: "c", wabaId: "abc", phoneNumberId: "2222222", state }))).status).toBe(400);
    expect((await POST(post({ code: "c", wabaId: "1111111", phoneNumberId: "2222222", state }))).status).toBe(200);
  });

  it("a signup state does not satisfy Meta Connect", async () => {
    await expect(consumeState("session-tenant", "u1", await issue())).rejects.toMatchObject({ status: 400 });
  });

  it("sweeps expired nonce rows when a new state is issued", async () => {
    await issue();
    for (const row of rows.values()) row.updatedAt = new Date(Date.now() - 11 * 60_000);
    await issue();
    expect(rows.size).toBe(1);
  });
});
