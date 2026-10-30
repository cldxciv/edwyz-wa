import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  accessToken: { findFirst: vi.fn() },
  platformSetting: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
const actor = vi.hoisted(() => ({ current: { userId: "u1", tenantId: "t1", role: "owner" } as { userId: string; tenantId: string; role: string }, fail: false }));
vi.mock("@/lib/auth", () => ({
  getActor: vi.fn(async () => {
    if (actor.fail) {
      const { HttpError } = await import("@/lib/tenancy");
      throw new HttpError(401, "Sign in required.");
    }
    return actor.current;
  }),
}));

import { GET } from "@/app/api/onboarding/token-health/route";

const day = 86_400_000;
const req = () => new Request("https://wa.edwyz.com/api/onboarding/token-health");

beforeEach(() => {
  vi.clearAllMocks();
  actor.current = { userId: "u1", tenantId: "t1", role: "owner" };
  actor.fail = false;
  db.platformSetting.findUnique.mockResolvedValue(null);
  db.accessToken.findFirst.mockResolvedValue({ id: "a1", createdAt: new Date(Date.now() - 50 * day), expiresAt: new Date(Date.now() + 5 * day) });
});

describe("GET /api/onboarding/token-health", () => {
  it("answers from the session workspace only", async () => {
    actor.current.tenantId = "session-tenant";
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(db.accessToken.findFirst.mock.calls[0][0].where.tenantId).toBe("session-tenant");
    expect(db.platformSetting.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "wa-auth-rejected:session-tenant" } }));
  });

  it("lets owners and admins reconnect, but not agents", async () => {
    for (const [role, can] of [["owner", true], ["admin", true], ["agent", false]] as const) {
      actor.current.role = role;
      const body = await (await GET(req())).json();
      expect(body.state).toBe("expiring");
      expect(body.canReconnect).toBe(can);
    }
  });

  it("returns no token material", async () => {
    db.accessToken.findFirst.mockResolvedValue({ id: "a1", tokenCiphertext: "SECRET", createdAt: new Date(), expiresAt: null });
    const text = JSON.stringify(await (await GET(req())).json());
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("a1");
  });

  it("requires a signed-in user", async () => {
    actor.fail = true;
    expect((await GET(req())).status).toBe(401);
  });
});

describe("banner wiring", () => {
  it("the app layout mounts the connection banner for every member", () => {
    const layout = readFileSync("src/app/(app)/app/layout.tsx", "utf8");
    expect(layout).toContain('import { WhatsAppConnectionBanner } from "@/components/connect/WhatsAppConnectionBanner"');
    expect(layout).toContain("<WhatsAppConnectionBanner />");
    // It sits in the shared banner slot, not behind a role check.
    const slot = layout.slice(layout.indexOf("banner={"));
    expect(slot.indexOf("<WhatsAppConnectionBanner />")).toBeLessThan(slot.indexOf('actor.role !== "agent"'));
  });

  it("the banner reads the token-health route and links to the connect page", () => {
    const banner = readFileSync("src/components/connect/WhatsAppConnectionBanner.tsx", "utf8");
    expect(banner).toContain("/api/onboarding/token-health");
    expect(readFileSync("src/components/connect/token-banner.ts", "utf8")).toContain('RECONNECT_PATH = "/app/settings/connect"');
  });
});
