import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  accessToken: { findFirst: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  platformSetting: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
}));
const emailOwners = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 1));
const audit = vi.hoisted(() => vi.fn(async () => undefined));
const state = vi.hoisted(() => ({ active: true }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth/audit", () => ({ audit }));
vi.mock("@/lib/config", () => ({ siteUrl: () => "https://wa.example.test" }));
vi.mock("@/lib/lifecycle/state", () => ({ emailOwners }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => state.active }));

import { GraphError } from "@/lib/graph";
import { tokenBannerContent } from "@/components/connect/token-banner";
import {
  classifyToken,
  clearWhatsAppAuthRejected,
  getWhatsAppTokenHealth,
  isAuthFailure,
  markWhatsAppAuthRejected,
  noteWhatsAppTokenWorks,
  pruneOlderTokens,
  resetTokenWorksThrottle,
} from "@/lib/onboarding/token-health";
import { checkWhatsAppTokens, stageFor, worker } from "@/lib/onboarding/worker";

const NOW = new Date("2026-10-27T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const created = new Date("2026-09-01T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  resetTokenWorksThrottle();
  state.active = true;
  db.platformSetting.findMany.mockResolvedValue([]);
  db.platformSetting.create.mockResolvedValue({});
  db.accessToken.findMany.mockResolvedValue([]);
  db.platformSetting.deleteMany.mockResolvedValue({ count: 1 });
  db.platformSetting.upsert.mockResolvedValue({});
});

describe("classifyToken", () => {
  it("no token at all", () => {
    expect(classifyToken(null, null, NOW)).toEqual({ state: "none", expiresAt: null, daysLeft: null });
  });

  it("a token without an expiry is ok", () => {
    expect(classifyToken({ createdAt: created, expiresAt: null }, null, NOW).state).toBe("ok");
  });

  it("is ok until 14 days before expiry, then expiring, then expired", () => {
    expect(classifyToken({ createdAt: created, expiresAt: days(30) }, null, NOW)).toMatchObject({ state: "ok", daysLeft: 30 });
    expect(classifyToken({ createdAt: created, expiresAt: days(14) }, null, NOW)).toMatchObject({ state: "expiring", daysLeft: 14 });
    expect(classifyToken({ createdAt: created, expiresAt: days(0.5) }, null, NOW)).toMatchObject({ state: "expiring", daysLeft: 1 });
    expect(classifyToken({ createdAt: created, expiresAt: days(-1) }, null, NOW)).toMatchObject({ state: "expired", daysLeft: 0 });
  });

  it("a rejection after the token was stored wins over a far expiry; a newer token clears it", () => {
    const rejected = new Date("2026-10-20T00:00:00Z");
    expect(classifyToken({ createdAt: created, expiresAt: days(40) }, rejected, NOW).state).toBe("rejected");
    expect(classifyToken({ createdAt: new Date("2026-10-21T00:00:00Z"), expiresAt: days(40) }, rejected, NOW).state).toBe("ok");
  });
});

describe("token health lookup", () => {
  it("reads only this workspace's tokens, never the PIN rows", async () => {
    db.accessToken.findFirst.mockResolvedValue({ id: "a1", createdAt: created, expiresAt: days(5) });
    db.platformSetting.findUnique.mockResolvedValue(null);
    const health = await getWhatsAppTokenHealth("t1", NOW);
    expect(health.state).toBe("expiring");
    const where = db.accessToken.findFirst.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t1");
    expect(JSON.stringify(where)).toContain("pin:");
    expect(db.platformSetting.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "wa-auth-rejected:t1" } }));
  });

  it("returns no ciphertext or token fields", async () => {
    db.accessToken.findFirst.mockResolvedValue({ id: "a1", createdAt: created, expiresAt: null });
    db.platformSetting.findUnique.mockResolvedValue(null);
    expect(Object.keys(await getWhatsAppTokenHealth("t1", NOW)).sort()).toEqual(["daysLeft", "expiresAt", "state"]);
  });
});

describe("auth failure marker", () => {
  it("recognises Meta's 190 and a bare OAuth 401, but not other errors", () => {
    expect(isAuthFailure(new GraphError("Invalid OAuth access token", 400, 190))).toBe(true);
    expect(isAuthFailure(new GraphError("Unauthorized", 401))).toBe(true);
    expect(isAuthFailure(new GraphError("Rate limit", 429, 4))).toBe(false);
    expect(isAuthFailure(new GraphError("Template paused", 400, 132015))).toBe(false);
    expect(isAuthFailure(new Error("boom"))).toBe(false);
  });

  it("marks and clears the flag per workspace", async () => {
    await markWhatsAppAuthRejected("t1");
    expect(db.platformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "wa-auth-rejected:t1" } }));
    await clearWhatsAppAuthRejected("t1");
    expect(db.platformSetting.deleteMany).toHaveBeenCalledWith({ where: { key: "wa-auth-rejected:t1" } });
  });

  it("never throws when the flag cannot be written, and does not log the token", async () => {
    db.platformSetting.upsert.mockRejectedValue(new Error("db down EAAB123secret"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(markWhatsAppAuthRejected("t1")).resolves.toBeUndefined();
    expect(JSON.stringify(spy.mock.calls)).not.toContain("EAAB123secret");
    spy.mockRestore();
  });
});

describe("stale rejected flag", () => {
  it("ignores a 190 from a send that started before a newer token was stored (a reconnect finished meanwhile)", async () => {
    db.accessToken.findFirst.mockResolvedValue({ id: "new", createdAt: new Date("2026-10-27T11:59:00Z"), expiresAt: null });
    await markWhatsAppAuthRejected("t1", new Date("2026-10-27T11:58:00Z"));
    expect(db.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it("records a 190 from a send that used the current token", async () => {
    db.accessToken.findFirst.mockResolvedValue({ id: "cur", createdAt: new Date("2026-10-01T00:00:00Z"), expiresAt: null });
    await markWhatsAppAuthRejected("t1", new Date("2026-10-27T11:58:00Z"));
    expect(db.platformSetting.upsert).toHaveBeenCalledOnce();
  });

  it("a successful send clears the flag, at most once a minute per workspace, and only for that workspace", async () => {
    await noteWhatsAppTokenWorks("t1", 1_000);
    await noteWhatsAppTokenWorks("t1", 30_000);
    expect(db.platformSetting.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.platformSetting.deleteMany).toHaveBeenCalledWith({ where: { key: "wa-auth-rejected:t1" } });
    await noteWhatsAppTokenWorks("t2", 30_000);
    await noteWhatsAppTokenWorks("t1", 62_000);
    expect(db.platformSetting.deleteMany).toHaveBeenCalledTimes(3);
  });

  it("never throws when the clear fails", async () => {
    db.platformSetting.deleteMany.mockRejectedValue(new Error("db down"));
    await expect(noteWhatsAppTokenWorks("t1")).resolves.toBeUndefined();
  });
});

describe("pruneOlderTokens", () => {
  it("deletes only older non-PIN tokens of the same workspace", async () => {
    db.accessToken.findFirst.mockResolvedValue({ createdAt: created });
    db.accessToken.deleteMany.mockResolvedValue({ count: 2 });
    expect(await pruneOlderTokens("t1", "new")).toBe(2);
    const where = db.accessToken.deleteMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: "t1", id: { not: "new" }, createdAt: { lt: created } });
    expect(JSON.stringify(where)).toContain("pin:");
  });

  it("does nothing when the new token cannot be found", async () => {
    db.accessToken.findFirst.mockResolvedValue(null);
    expect(await pruneOlderTokens("t1", "gone")).toBe(0);
    expect(db.accessToken.deleteMany).not.toHaveBeenCalled();
  });
});

describe("banner copy", () => {
  it("shows nothing for a healthy or missing connection", () => {
    expect(tokenBannerContent(null)).toBeNull();
    expect(tokenBannerContent({ state: "ok", expiresAt: null, daysLeft: null })).toBeNull();
    expect(tokenBannerContent({ state: "none", expiresAt: null, daysLeft: null })).toBeNull();
  });

  it("warns before expiry with a one-click reconnect for admins", () => {
    const b = tokenBannerContent({ state: "expiring", expiresAt: "x", daysLeft: 3, canReconnect: true });
    expect(b).toMatchObject({ tone: "warn", action: "Reconnect WhatsApp" });
    expect(b?.text).toContain("in 3 days");
  });

  it("is a red alert when expired or rejected, and asks agents to find an admin", () => {
    for (const state of ["expired", "rejected"] as const) {
      expect(tokenBannerContent({ state, expiresAt: null, daysLeft: 0, canReconnect: true })).toMatchObject({ tone: "bad", action: "Reconnect now" });
      const agent = tokenBannerContent({ state, expiresAt: null, daysLeft: 0, canReconnect: false });
      expect(agent?.action).toBeNull();
      expect(agent?.text).toMatch(/owner or admin/);
    }
  });
});

describe("notice stages", () => {
  it("maps days left to the smallest stage reached", () => {
    expect(stageFor(days(20), NOW)).toBeNull();
    expect(stageFor(days(10), NOW)).toBe(14);
    expect(stageFor(days(2), NOW)).toBe(3);
    expect(stageFor(days(-1), NOW)).toBe(0);
  });
});

describe("checkWhatsAppTokens", () => {
  const newest = (id: string, expiresAt: Date | null) => db.accessToken.findFirst.mockResolvedValue({ id, createdAt: created, expiresAt });

  it("emails the owners once per token and stage", async () => {
    db.accessToken.findMany.mockResolvedValue([{ tenantId: "t1" }]);
    newest("a1", days(10));
    expect(await checkWhatsAppTokens(NOW)).toBe(1);
    expect(emailOwners).toHaveBeenCalledTimes(1);
    expect(db.platformSetting.create).toHaveBeenCalledWith({ data: { key: "wa-token-notice:a1:14", value: {} } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", action: "whatsapp.token_expiring" }));

    db.platformSetting.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await checkWhatsAppTokens(NOW)).toBe(0);
    expect(emailOwners).toHaveBeenCalledTimes(1);
  });

  it("gives the claim back when no owner could be mailed, so the warning is retried", async () => {
    db.accessToken.findMany.mockResolvedValue([{ tenantId: "t1" }]);
    newest("a1", days(10));
    emailOwners.mockResolvedValueOnce(0);
    expect(await checkWhatsAppTokens(NOW)).toBe(0);
    expect(db.platformSetting.deleteMany).toHaveBeenCalledWith({ where: { key: "wa-token-notice:a1:14" } });
    expect(audit).not.toHaveBeenCalled();
  });

  it("gives the claim back when the mail queue refuses the message", async () => {
    db.accessToken.findMany.mockResolvedValue([{ tenantId: "t1" }]);
    newest("a1", days(10));
    emailOwners.mockRejectedValueOnce(new Error("queue down"));
    expect(await checkWhatsAppTokens(NOW)).toBe(0);
    expect(db.platformSetting.deleteMany).toHaveBeenCalledWith({ where: { key: "wa-token-notice:a1:14" } });
    expect(await checkWhatsAppTokens(NOW)).toBe(1);
  });

  it("sends the 3 day and expired notices as their own stages", async () => {
    db.accessToken.findMany.mockResolvedValue([{ tenantId: "t1" }]);
    newest("a1", days(2));
    await checkWhatsAppTokens(NOW);
    newest("a1", days(-2));
    await checkWhatsAppTokens(NOW);
    const keys = db.platformSetting.create.mock.calls.map((c) => c[0].data.key);
    expect(keys).toEqual(["wa-token-notice:a1:3", "wa-token-notice:a1:0"]);
  });

  it("stays silent when the newest token (a reconnect) expires later", async () => {
    db.accessToken.findMany.mockResolvedValue([{ tenantId: "t1" }]);
    newest("a2", days(55));
    expect(await checkWhatsAppTokens(NOW)).toBe(0);
    expect(emailOwners).not.toHaveBeenCalled();
  });

  it("skips workspaces that are suspended or locked", async () => {
    state.active = false;
    db.accessToken.findMany.mockResolvedValue([{ tenantId: "t1" }]);
    newest("a1", days(2));
    expect(await checkWhatsAppTokens(NOW)).toBe(0);
    expect(emailOwners).not.toHaveBeenCalled();
  });

  it("emails a workspace whose token Meta rejected, once, and links to the connect page", async () => {
    db.platformSetting.findMany.mockResolvedValue([{ key: "wa-auth-rejected:t9", updatedAt: new Date("2026-10-27T10:00:00Z") }]);
    db.accessToken.findFirst.mockResolvedValue({ id: "a9", createdAt: created, expiresAt: null });
    expect(await checkWhatsAppTokens(NOW)).toBe(1);
    expect(db.platformSetting.create).toHaveBeenCalledWith({ data: { key: "wa-token-notice:a9:0", value: {} } });
    const render = emailOwners.mock.calls[0][1] as () => { subject: string; text: string };
    expect(render().text).toContain("https://wa.example.test/app/settings/connect");
  });

  it("ignores a rejection that predates a newer token", async () => {
    db.platformSetting.findMany.mockResolvedValue([{ key: "wa-auth-rejected:t9", updatedAt: new Date("2026-08-01T00:00:00Z") }]);
    db.accessToken.findFirst.mockResolvedValue({ id: "a9", createdAt: created, expiresAt: null });
    expect(await checkWhatsAppTokens(NOW)).toBe(0);
    expect(emailOwners).not.toHaveBeenCalled();
  });

  it("is registered as a periodic task", () => {
    expect(worker.periodic.map((p) => p.name)).toContain("wa-token-health");
  });
});
