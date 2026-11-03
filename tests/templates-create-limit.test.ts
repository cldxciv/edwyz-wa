import { describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({ createTemplate: vi.fn(async () => ({ id: "tpl1" })), listTemplates: vi.fn(async () => []) }));
const who = vi.hoisted(() => ({ tenantId: "t1" }));
vi.mock("@/lib/templates/service", () => svc);
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: who.tenantId, role: "admin" }) }));
vi.mock("@/lib/auth/csrf", () => ({ assertSameOrigin: () => undefined }));
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { POST } from "@/app/api/templates/route";

const create = () => POST(new Request("https://wa.edwyz.com/api/templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "a" }) }));

describe("template creation limit", () => {
  it("lets a workspace create 20 templates an hour, then answers 429 with the reason; other workspaces are not affected", async () => {
    for (let i = 0; i < 20; i++) expect((await create()).status).toBe(201);
    const refused = await create();
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toMatch(/20 templates in the last hour/);
    expect(svc.createTemplate).toHaveBeenCalledTimes(20);
    who.tenantId = "t2";
    expect((await create()).status).toBe(201);
  });
});
