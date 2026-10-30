import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: { apiKey: { updateMany: vi.fn(), deleteMany: vi.fn() } },
  actor: { userId: "owner1", tenantId: "t1", role: "owner" },
}));
vi.mock("@/lib/db", () => ({ prisma: h.db }));
vi.mock("@/lib/auth", () => ({ getActor: vi.fn(async () => h.actor) }));
vi.mock("@/lib/auth/csrf", () => ({ assertSameOrigin: vi.fn() }));

import { DELETE } from "@/app/api/integrations/api-keys/[id]/route";
import { revokeOrRemoveApiKey } from "@/lib/integrations/apikeys";

const del = (id: string) => DELETE(new Request(`https://wa.edwyz.com/api/integrations/api-keys/${id}`, { method: "DELETE", headers: { origin: "https://wa.edwyz.com" } }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.actor = { userId: "owner1", tenantId: "t1", role: "owner" };
  h.db.apiKey.updateMany.mockResolvedValue({ count: 0 });
  h.db.apiKey.deleteMany.mockResolvedValue({ count: 0 });
});

describe("turning off and removing API keys", () => {
  it("turns an active key off and leaves the row in the list", async () => {
    h.db.apiKey.updateMany.mockResolvedValue({ count: 1 });
    expect(await revokeOrRemoveApiKey("t1", "k1")).toBe("revoked");
    expect(h.db.apiKey.updateMany).toHaveBeenCalledWith({ where: { id: "k1", tenantId: "t1", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(h.db.apiKey.deleteMany).not.toHaveBeenCalled();
  });

  it("removes a key that is already turned off, within the workspace only", async () => {
    h.db.apiKey.deleteMany.mockResolvedValue({ count: 1 });
    expect(await revokeOrRemoveApiKey("t1", "k1")).toBe("removed");
    expect(h.db.apiKey.deleteMany).toHaveBeenCalledWith({ where: { id: "k1", tenantId: "t1", revokedAt: { not: null } } });
  });

  it("answers 404 for a key that does not exist here, without a confusing 'already revoked'", async () => {
    await expect(revokeOrRemoveApiKey("t1", "nope")).rejects.toMatchObject({ status: 404, message: "Key not found." });
  });

  it("the DELETE route reports which of the two happened", async () => {
    h.db.apiKey.updateMany.mockResolvedValue({ count: 1 });
    expect(await (await del("k1")).json()).toEqual({ ok: true, result: "revoked" });
    h.db.apiKey.updateMany.mockResolvedValue({ count: 0 });
    h.db.apiKey.deleteMany.mockResolvedValue({ count: 1 });
    expect(await (await del("k1")).json()).toEqual({ ok: true, result: "removed" });
    h.db.apiKey.deleteMany.mockResolvedValue({ count: 0 });
    expect((await del("k1")).status).toBe(404);
  });

  it("only admins and owners may do either", async () => {
    h.actor = { userId: "u2", tenantId: "t1", role: "agent" };
    expect((await del("k1")).status).toBe(403);
    expect(h.db.apiKey.updateMany).not.toHaveBeenCalled();
    expect(h.db.apiKey.deleteMany).not.toHaveBeenCalled();
  });

  it("the keys table offers Remove on turned-off rows and explains that nothing else changes", () => {
    const src = readFileSync(path.join(__dirname, "..", "src/components/integrations/KeysSection.tsx"), "utf8");
    const start = src.indexOf('key: "actions"');
    const cell = src.slice(start, src.indexOf("],", start));
    expect(cell).toMatch(/k\.revokedAt \? \(\s*<BusyButton[^>]*onClick=\{\(\) => void remove\(k\)\}/);
    expect(cell).toContain("Remove<span");
    expect(src).toContain("This key is already turned off, so nothing that used it changes.");
  });
});
