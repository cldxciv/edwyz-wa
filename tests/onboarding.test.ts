import { beforeEach, describe, expect, it, vi } from "vitest";

type Log = { tenantId: string; step: string; status: string; detail: { ref?: string }; createdAt: number };
const state = vi.hoisted(() => ({ logs: [] as unknown[], clock: 0 }));
const logs = () => state.logs as Log[];

const db = vi.hoisted(() => ({
  onboardingLog: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      (state.logs as unknown[]).push({ ...data, createdAt: ++state.clock });
    }),
    findMany: vi.fn(async ({ where, take }: { where: Record<string, string>; take: number }) =>
      (state.logs as Log[])
        .filter((l) => Object.entries(where).every(([k, v]) => (l as unknown as Record<string, string>)[k] === v))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, take),
    ),
  },
  tenant: { update: vi.fn(async () => ({})) },
  waba: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({ id: "w1" })) },
  phoneNumber: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
  accessToken: { deleteMany: vi.fn(async () => ({})), findFirst: vi.fn(async (): Promise<unknown> => null) },
  platformSetting: { deleteMany: vi.fn(async () => ({})), create: vi.fn(async () => ({})) },
  $executeRaw: vi.fn(async () => 0),
  $transaction: undefined as unknown as (fn: (tx: unknown) => unknown) => unknown,
}));
db.$transaction = (fn) => fn(db);
vi.mock("@/lib/db", () => ({ prisma: db }));

const graph = vi.hoisted(() => ({ graphFetch: vi.fn(), appGraphFetch: vi.fn() }));
vi.mock("@/lib/graph", async () => ({ ...(await vi.importActual<object>("@/lib/graph")), ...graph }));

const tokens = vi.hoisted(() => ({ storeAccessToken: vi.fn(async () => "a1"), storeRegistrationPin: vi.fn(async () => "p1") }));
vi.mock("@/lib/crypto/tokens", async () => ({ ...(await vi.importActual<object>("@/lib/crypto/tokens")), ...tokens }));

import { GraphError } from "@/lib/graph";
import { generatePin, runOnboarding, summarizeSteps } from "@/lib/onboarding";

const input = { tenantId: "t1", code: "CODE", wabaId: "1111111", phoneNumberId: "2222222" };
const details = { display_phone_number: "+91 98765 43210", verified_name: "Acme", quality_rating: "GREEN", messaging_limit_tier: "TIER_250", name_status: "APPROVED" };

function happyPath() {
  graph.appGraphFetch.mockResolvedValue({ access_token: "EAAB" });
  graph.graphFetch.mockImplementation(async (req: { path: string }) => (req.path === "2222222" ? details : req.path === "1111111/phone_numbers" ? { data: [{ id: "2222222" }] } : { success: true }));
}

beforeEach(() => {
  state.logs = [];
  state.clock = 0;
  vi.clearAllMocks();
});

describe("step machine", () => {
  it("runs all steps and marks the tenant live", async () => {
    happyPath();
    const result = await runOnboarding(input);
    expect(result.ok).toBe(true);
    expect(result.steps.every((s) => s.status === "done")).toBe(true);
    expect(tokens.storeAccessToken).toHaveBeenCalledWith("t1", null, "EAAB", null);
    expect(db.tenant.update).toHaveBeenLastCalledWith({ where: { id: "t1" }, data: { onboardingStatus: "live" } });
    expect(db.phoneNumber.upsert).toHaveBeenCalledOnce();
    const registerCall = graph.graphFetch.mock.calls.find(([r]) => r.path === "2222222/register")![0];
    expect(registerCall.body).toMatchObject({ messaging_product: "whatsapp" });
    expect(registerCall.body.pin).toMatch(/^\d{6}$/);
  });

  // Replaces "a second run does nothing": every run now carries a fresh code, so reconnecting must store a new token.
  it("reconnecting the same WABA and number exchanges the new code, stores a new token and never registers again", async () => {
    happyPath();
    const first = await runOnboarding(input);
    expect(first.reauthorized).toBe(false);
    vi.clearAllMocks();
    happyPath();
    const result = await runOnboarding({ ...input, code: "FRESH" });
    expect(result.ok).toBe(true);
    expect(result.reauthorized).toBe(true);
    expect(graph.appGraphFetch).toHaveBeenCalledWith({ path: "oauth/access_token", query: { code: "FRESH" } });
    expect(tokens.storeAccessToken).toHaveBeenCalledWith("t1", null, "EAAB", null);
    expect(graph.graphFetch.mock.calls.some(([r]) => r.path === "2222222/register")).toBe(false);
    expect(tokens.storeRegistrationPin).not.toHaveBeenCalled();
    expect(graph.graphFetch.mock.calls.some(([r]) => r.path === "1111111/subscribed_apps")).toBe(true);
  });

  it("runs exchange_code and subscribe_app on every run that delivers a code, however many times the number was connected", async () => {
    for (const code of ["ONE", "TWO", "THREE"]) {
      vi.clearAllMocks();
      happyPath();
      const result = await runOnboarding({ ...input, code });
      expect(result.ok).toBe(true);
      expect(graph.appGraphFetch).toHaveBeenCalledTimes(1);
      expect(graph.appGraphFetch).toHaveBeenCalledWith({ path: "oauth/access_token", query: { code } });
      expect(tokens.storeAccessToken).toHaveBeenCalledTimes(1);
      expect(graph.graphFetch.mock.calls.filter(([r]) => r.path === "1111111/subscribed_apps" && r.method === "POST")).toHaveLength(1);
    }
  });

  it("stores the token expiry when Meta returns one", async () => {
    happyPath();
    graph.appGraphFetch.mockResolvedValue({ access_token: "EAAB", expires_in: 5_184_000 });
    await runOnboarding(input);
    const expiresAt = (tokens.storeAccessToken.mock.calls[0] as unknown as [string, null, string, Date])[3];
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 86_400_000);
  });

  it("a failed reconnect leaves a working connection live", async () => {
    happyPath();
    await runOnboarding(input);
    graph.appGraphFetch.mockRejectedValue(new GraphError("This authorization code has been used", 400, 100));
    const result = await runOnboarding({ ...input, code: "OLD" });
    expect(result).toMatchObject({ ok: false, failedStep: "exchange_code", reauthorized: true });
    expect(db.tenant.update).toHaveBeenLastCalledWith({ where: { id: "t1" }, data: { onboardingStatus: "live" } });
  });

  it("a reconnect that fails after the code exchange deletes the new token so the old one stays in charge", async () => {
    happyPath();
    await runOnboarding(input);
    vi.clearAllMocks();
    happyPath();
    db.accessToken.findFirst.mockResolvedValue({ id: "old", createdAt: new Date(), expiresAt: null });
    tokens.storeAccessToken.mockResolvedValueOnce("new1");
    graph.graphFetch.mockImplementation(async (req: { path: string }) => {
      if (req.path === "1111111/phone_numbers") throw new GraphError("Invalid OAuth access token", 400, 190);
      return { success: true };
    });
    const result = await runOnboarding({ ...input, code: "BAD" });
    expect(result).toMatchObject({ ok: false, failedStep: "verify_ids", reauthorized: true });
    expect(db.accessToken.deleteMany).toHaveBeenCalledWith({ where: { id: "new1", tenantId: "t1" } });
    expect(db.tenant.update).toHaveBeenLastCalledWith({ where: { id: "t1" }, data: { onboardingStatus: "live" } });
    // The rejected flag is only cleared once the new token has passed verification; here it never did.
    expect(db.platformSetting.deleteMany).not.toHaveBeenCalledWith({ where: { key: "wa-auth-rejected:t1" } });
  });

  it("clears the rejected flag after the new token passes verify_ids, and keeps the new token on success", async () => {
    happyPath();
    db.accessToken.findFirst.mockResolvedValue({ id: "old", createdAt: new Date(), expiresAt: null });
    tokens.storeAccessToken.mockResolvedValueOnce("new2");
    const result = await runOnboarding(input);
    expect(result.ok).toBe(true);
    expect(db.platformSetting.deleteMany).toHaveBeenCalledWith({ where: { key: "wa-auth-rejected:t1" } });
    expect(db.accessToken.deleteMany).not.toHaveBeenCalledWith({ where: { id: "new2", tenantId: "t1" } });
  });

  it("resumes after a failure without repeating completed steps", async () => {
    happyPath();
    graph.graphFetch.mockImplementation(async (req: { path: string }) => {
      if (req.path === "1111111/subscribed_apps") throw new GraphError("nope", 400, 100);
      return req.path === "2222222" ? details : req.path === "1111111/phone_numbers" ? { data: [{ id: "2222222" }] } : { success: true };
    });
    const first = await runOnboarding(input);
    expect(first).toMatchObject({ ok: false, failedStep: "subscribe_app" });
    expect(db.tenant.update).toHaveBeenLastCalledWith({ where: { id: "t1" }, data: { onboardingStatus: "failed" } });
    expect(logs().find((l) => l.status === "failed")?.detail).toMatchObject({ code: 100 });

    happyPath();
    graph.appGraphFetch.mockClear();
    const second = await runOnboarding(input);
    expect(second.ok).toBe(true);
    expect(graph.appGraphFetch).toHaveBeenCalledTimes(1);
    expect(graph.graphFetch.mock.calls.filter(([r]) => r.path === "2222222/register")).toHaveLength(1);
  });

  it("treats an already registered number as done and drops the unused pin", async () => {
    happyPath();
    graph.graphFetch.mockImplementation(async (req: { path: string; query?: { fields: string } }) => {
      if (req.path === "2222222/register") throw new GraphError("already", 400, 133005);
      if (req.path === "2222222" && req.query?.fields === "status") return { status: "CONNECTED" };
      return req.path === "2222222" ? details : req.path === "1111111/phone_numbers" ? { data: [{ id: "2222222" }] } : { success: true };
    });
    const result = await runOnboarding(input);
    expect(result.ok).toBe(true);
    expect(db.accessToken.deleteMany).toHaveBeenCalledWith({ where: { id: "p1", tenantId: "t1" } });
  });

  it("never logs or persists the pin in plaintext", async () => {
    happyPath();
    const spies = (["log", "error", "warn", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await runOnboarding(input);
    const call = tokens.storeRegistrationPin.mock.calls[0] as unknown as [string, string, string];
    expect(call[2]).toMatch(/^\d{6}$/);
    const dump = JSON.stringify(logs()) + spies.map((s) => JSON.stringify(s.mock.calls)).join("");
    expect(dump).not.toContain(call[2]);
    expect(dump).not.toContain("EAAB");
  });

  it("rejects a waba already owned by another tenant", async () => {
    db.waba.findUnique.mockResolvedValueOnce({ tenantId: "other" } as never);
    await expect(runOnboarding(input)).rejects.toMatchObject({ status: 409 });
    expect(graph.appGraphFetch).not.toHaveBeenCalled();
  });

  it("fails verification when the number is not in the WABA, before subscribing", async () => {
    graph.appGraphFetch.mockResolvedValue({ access_token: "EAAB" });
    graph.graphFetch.mockResolvedValue({ data: [{ id: "999" }] });
    const result = await runOnboarding(input);
    expect(result).toMatchObject({ ok: false, failedStep: "verify_ids" });
    expect(graph.graphFetch.mock.calls.some(([r]) => r.path.endsWith("subscribed_apps"))).toBe(false);
  });

  it("skips register for coexistence", async () => {
    happyPath();
    const result = await runOnboarding({ ...input, skipRegistration: true });
    expect(result.ok).toBe(true);
    expect(graph.graphFetch.mock.calls.some(([r]) => r.path.endsWith("/register"))).toBe(false);
    expect(tokens.storeRegistrationPin).not.toHaveBeenCalled();
  });

  it("creates the number inside one transaction under an advisory lock and re-checks ownership there", async () => {
    happyPath();
    await runOnboarding(input);
    expect(db.$executeRaw).toHaveBeenCalled();
    db.phoneNumber.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ tenantId: "other" } as never);
    const raced = await runOnboarding({ ...input, tenantId: "t2" });
    expect(raced).toMatchObject({ ok: false, failedStep: "fetch_details" });
    expect(db.phoneNumber.upsert).toHaveBeenCalledTimes(1);
  });

  it("allows one run per tenant at a time", async () => {
    happyPath();
    db.platformSetting.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    await expect(runOnboarding(input)).rejects.toMatchObject({ status: 409 });
    expect(graph.appGraphFetch).not.toHaveBeenCalled();
    db.platformSetting.create.mockResolvedValueOnce({});
    await runOnboarding(input);
    expect(db.platformSetting.deleteMany).toHaveBeenCalledWith({ where: { key: "onboarding-lock:t1" } });
  });

  it("stores only sanitised error text in the onboarding log", async () => {
    graph.appGraphFetch.mockRejectedValue(new GraphError("bad request for +919876543210 a@b.co", 400, 100));
    await runOnboarding(input);
    const failed = logs().find((l) => l.status === "failed")!;
    expect(JSON.stringify(failed.detail)).not.toContain("919876543210");
    expect(JSON.stringify(failed.detail)).not.toContain("a@b.co");
  });

  it("rejects malformed ids", async () => {
    await expect(runOnboarding({ ...input, wabaId: "../x" })).rejects.toMatchObject({ status: 400 });
  });

  it("generates 6 digit pins including leading zeros", () => {
    for (let i = 0; i < 200; i++) expect(generatePin()).toMatch(/^\d{6}$/);
  });

  it("summarizes pending steps", () => {
    expect(summarizeSteps([{ step: "exchange_code", status: "done" }]).map((s) => s.status)).toEqual(["done", "pending", "pending", "pending", "pending", "pending"]);
  });
});
