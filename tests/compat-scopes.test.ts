import { beforeEach, describe, expect, it, vi } from "vitest";

const keyAuth = vi.hoisted(() => ({ scopes: [] as string[], hash: "" }));
const db = vi.hoisted(() => ({
  apiKey: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  membership: { findUnique: vi.fn() },
}));
const billing = vi.hoisted(() => ({ assertTenantCanWrite: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => billing);

import { resetCompatLimits, run } from "@/lib/compat/runtime";
import { ENDPOINTS, endpointScopes, isWrite } from "@/lib/compat/spec";
import { generateApiKey, requireApiKey } from "@/lib/integrations/apikeys";
import { acceptedScopes, API_SCOPES, assertScope, holdsScope, missingScopeMessage } from "@/lib/integrations/scopes";
import { SCOPE_INFO, SCOPES } from "@/components/integrations/helpers";
import { HttpError } from "@/lib/tenancy";

const KEY = generateApiKey();
const request = (method = "GET") => new Request("https://wa.test/api/ext/v3/x", { method, headers: { authorization: `Bearer ${KEY.key}` } });
const stub = async () => ({ json: {} });

beforeEach(() => {
  resetCompatLimits();
  billing.assertTenantCanWrite.mockReset();
  billing.assertTenantCanWrite.mockResolvedValue(undefined);
  keyAuth.scopes = [];
  db.apiKey.findUnique.mockImplementation(async ({ where }) =>
    where.keyHash === KEY.hash ? { id: "k1", tenantId: "t1", keyHash: KEY.hash, scopes: keyAuth.scopes, revokedAt: null, lastUsedAt: new Date(), createdByUserId: "u1" } : null,
  );
  db.apiKey.update.mockResolvedValue({});
  db.apiKey.updateMany.mockResolvedValue({ count: 1 });
  db.membership.findUnique.mockResolvedValue({ user: { disabledAt: null }, tenant: { deletedAt: null, status: "active" } });
});

describe("any-of scopes", () => {
  it("a write scope also opens the matching reads, and messages:write opens template listing", () => {
    expect(acceptedScopes("contacts:read").sort()).toEqual(["contacts:read", "contacts:write"]);
    expect(acceptedScopes("conversations:read").sort()).toEqual(["conversations:read", "conversations:write"]);
    expect(acceptedScopes("templates:read").sort()).toEqual(["messages:write", "templates:read"]);
    expect(acceptedScopes("webhooks:manage")).toEqual(["webhooks:manage"]);
  });

  it("accepts a list of required scopes as alternatives", () => {
    expect(holdsScope(["conversations:write"], ["messages:write", "conversations:write"])).toBe(true);
    expect(holdsScope(["contacts:read"], ["messages:write", "conversations:write"])).toBe(false);
    expect(holdsScope([], "contacts:read")).toBe(false);
  });

  it("does not let a read scope open a write", () => {
    expect(holdsScope(["contacts:read"], "contacts:write")).toBe(false);
    expect(holdsScope(["conversations:read"], "conversations:write")).toBe(false);
    expect(holdsScope(["templates:read"], "messages:write")).toBe(false);
  });

  it("uses one 403 sentence everywhere", () => {
    expect(missingScopeMessage("webhooks:manage")).toBe("This API key needs the webhooks:manage scope.");
    expect(missingScopeMessage("contacts:read")).toBe("This API key needs one of these scopes: contacts:read, contacts:write.");
    expect(() => assertScope([], "webhooks:manage")).toThrowError(new HttpError(403, "This API key needs the webhooks:manage scope."));
  });
});

describe("every compat endpoint against every scope", () => {
  for (const e of ENDPOINTS) {
    it(`${e.method} ${e.path} is open to exactly ${acceptedScopes(endpointScopes(e)).join(", ")}`, async () => {
      const allowed = new Set(acceptedScopes(endpointScopes(e)));
      for (const scope of API_SCOPES) {
        keyAuth.scopes = [scope];
        const res = await run(e.id as never, stub, request(e.method), {});
        if (allowed.has(scope)) expect(res.status, `${scope} should open ${e.id}`).toBe(200);
        else {
          expect(res.status, `${scope} should not open ${e.id}`).toBe(403);
          expect((await res.json()).error.message).toBe(missingScopeMessage(endpointScopes(e)));
        }
      }
    });
  }

  it("a key with no scopes opens nothing, and the answer is the same 403 shape", async () => {
    keyAuth.scopes = [];
    const res = await run("contacts.list", stub, request(), {});
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});

describe("v1 API uses the same scope check and message", () => {
  it("answers with the shared sentence", async () => {
    keyAuth.scopes = ["contacts:read"];
    await expect(requireApiKey(request("POST"), "messages:write")).rejects.toMatchObject({ status: 403, message: missingScopeMessage("messages:write") });
    await expect(requireApiKey(request(), ["messages:write", "conversations:write"])).rejects.toMatchObject({ status: 403, message: missingScopeMessage(["messages:write", "conversations:write"]) });
    keyAuth.scopes = ["conversations:write"];
    await expect(requireApiKey(request(), ["messages:write", "conversations:write"])).resolves.toMatchObject({ keyId: "k1" });
  });
});

describe("expired trial or subscription over the API", () => {
  it("keeps reads working and refuses writes with the billing error", async () => {
    billing.assertTenantCanWrite.mockRejectedValue(new HttpError(402, "Your free trial has ended. Subscribe to continue. Your data is read-only until you subscribe at /app/billing."));
    keyAuth.scopes = ["contacts:write"];
    expect((await run("contacts.list", stub, request(), {})).status).toBe(200);
    const write = await run("contacts.create", stub, request("POST"), {});
    expect(write.status).toBe(402);
    expect((await write.json()).error).toMatchObject({ code: "payment_required" });
    expect(isWrite(ENDPOINTS.find((e) => e.id === "contacts.create")!)).toBe(true);
  });

  it("a suspended workspace is refused with 403 on writes", async () => {
    billing.assertTenantCanWrite.mockRejectedValue(new HttpError(403, "This workspace has been suspended."));
    keyAuth.scopes = ["messages:write"];
    expect((await run("conversations.sendText", stub, request("POST"), {})).status).toBe(403);
  });
});

describe("the key screen offers every scope the server accepts", () => {
  it("lists the same scopes in the same set, each with plain-language text", () => {
    expect([...SCOPES].sort()).toEqual([...API_SCOPES].sort());
    for (const scope of SCOPES) {
      expect(SCOPE_INFO[scope].label.length).toBeGreaterThan(3);
      expect(SCOPE_INFO[scope].description.length).toBeGreaterThan(10);
    }
  });
});
