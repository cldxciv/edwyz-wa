import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  mcpConnection: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  platformSetting: { findUnique: vi.fn(), upsert: vi.fn() },
}));
const audit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth/audit", () => ({ audit }));
vi.mock("@/lib/crypto/secrets", () => ({
  sealSecret: (t: string, v: string) => `sealed:${t}:${v}`,
  openSecret: (t: string, v: string) => v.replace(`sealed:${t}:`, ""),
}));

import { callTool, listAllowedTools, resetByoMcpState } from "@/lib/byo-mcp";
import { parseRpcBody, type McpDeps } from "@/lib/byo-mcp/client";
import { createConnection, deleteConnection, listConnections, testConnection, toView, updateConnection } from "@/lib/byo-mcp/connections";
import { customerToolsKey, filterCustomerTools, getCustomerExposure, listCustomerTools, setConnectionExposure } from "@/lib/byo-mcp/exposure";
import { validateToolArgs } from "@/lib/byo-mcp/validate";
import { isCustomerSafeTool, isRiskyTool } from "@/lib/byo-mcp/risk";
import type { McpHttpRequest } from "@/lib/byo-mcp/transport";
import { HttpError } from "@/lib/tenancy";

const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };
const publicResolve = async () => ["93.184.216.34"];
const json = (body: unknown, headers: Record<string, string> = {}) => ({ status: 200, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

function server(tools: unknown[], callResult: unknown = { content: [{ type: "text", text: "ok" }] }) {
  const seen: McpHttpRequest[] = [];
  const transport = vi.fn(async (req: McpHttpRequest) => {
    seen.push(req);
    const msg = JSON.parse(req.body);
    if (msg.method === "initialize") return json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "Acme" } } }, { "mcp-session-id": "s1" });
    if (msg.method === "notifications/initialized") return { status: 202, headers: {}, body: "" };
    if (msg.method === "tools/list") return json({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    if (msg.method === "tools/call") return json({ jsonrpc: "2.0", id: msg.id, result: callResult });
    return { status: 500, headers: {}, body: "" };
  });
  const deps: McpDeps = { resolve: publicResolve, transport };
  return { seen, transport, deps };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: "c1", tenantId: "t1", name: "Acme", url: "https://tools.example.com/mcp", authEnc: "sealed:t1:secret-token", allowedTools: ["lookup"], enabled: true, createdAt: new Date(), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetByoMcpState();
  audit.mockResolvedValue(undefined);
});

describe("protocol", () => {
  it("initializes, notifies, lists tools and carries session, version and bearer headers", async () => {
    const s = server([{ name: "lookup", description: "Find a customer", inputSchema: { type: "object" } }]);
    db.mcpConnection.findFirst.mockResolvedValue(row());
    const out = await testConnection(actor, "c1", s.deps);
    expect(out).toMatchObject({ ok: true, serverName: "Acme", tools: [{ name: "lookup", allowed: true, risky: false }] });
    expect(s.seen.map((r) => JSON.parse(r.body).method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(s.seen[2].headers["mcp-session-id"]).toBe("s1");
    expect(s.seen[2].headers.authorization).toBe("Bearer secret-token");
    expect(s.seen[0].address).toBe("93.184.216.34");
    expect(JSON.stringify(out)).not.toContain("secret-token");
  });

  it("parses text/event-stream answers and ignores unrelated events", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\n';
    expect(parseRpcBody("text/event-stream; charset=utf-8", body, 3)).toMatchObject({ result: { ok: true } });
    expect(() => parseRpcBody("text/event-stream", body, 9)).toThrow();
  });

  it("reports connection failures as ok:false without throwing", async () => {
    const transport = vi.fn(async () => {
      throw new Error("too_large");
    });
    db.mcpConnection.findFirst.mockResolvedValue(row());
    const out = await testConnection(actor, "c1", { resolve: publicResolve, transport });
    expect(out).toMatchObject({ ok: false, error: "The server response was too large." });
  });

  it("does not follow redirects", async () => {
    const transport = vi.fn(async () => ({ status: 302, headers: { location: "https://evil.example/" }, body: "" }));
    db.mcpConnection.findFirst.mockResolvedValue(row());
    const out = await testConnection(actor, "c1", { resolve: publicResolve, transport });
    expect(out.ok).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("flags risky tools", () => {
    expect(isRiskyTool("delete_customer", "")).toBe(true);
    expect(isRiskyTool("lookup", "Sends an email to the customer")).toBe(true);
    expect(isRiskyTool("deleteAll", "")).toBe(true);
    expect(isRiskyTool("lookup_order", "Find an order by id")).toBe(false);
  });
});

describe("connection CRUD", () => {
  it("seals the token, defaults to no allowed tools and never returns the token", async () => {
    db.mcpConnection.count.mockResolvedValue(0);
    db.mcpConnection.create.mockImplementation(async ({ data }) => row({ ...data, id: "c9" }));
    const view = await createConnection(actor, { name: "Acme", url: "https://tools.example.com/mcp", authToken: "tok123" }, { resolve: publicResolve });
    expect(db.mcpConnection.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", authEnc: "sealed:t1:tok123", allowedTools: [] });
    expect(view.hasAuth).toBe(true);
    expect(JSON.stringify(view)).not.toContain("tok123");
    expect(JSON.stringify(toView(row()))).not.toContain("authEnc");
  });

  it.each([
    ["http://tools.example.com/mcp", /https/],
    ["https://localhost/mcp", /not allowed/],
    ["https://127.0.0.1/mcp", /not allowed/],
    ["https://169.254.169.254/latest", /not allowed/],
    ["https://tools.example.com:8080/mcp", /port/],
    ["https://user:pw@tools.example.com/mcp", /credentials/],
  ])("refuses %s", async (url, message) => {
    db.mcpConnection.count.mockResolvedValue(0);
    await expect(createConnection(actor, { name: "x", url }, { resolve: publicResolve })).rejects.toThrow(message);
    expect(db.mcpConnection.create).not.toHaveBeenCalled();
  });

  it("refuses a host that resolves to a private address", async () => {
    await expect(createConnection(actor, { name: "x", url: "https://rebind.example.com/mcp" }, { resolve: async () => ["93.184.216.34", "10.0.0.5"] })).rejects.toThrow(/private/);
  });

  it("update is tenant scoped and validates the URL", async () => {
    db.mcpConnection.findFirst.mockResolvedValue(row());
    await expect(updateConnection(actor, "c1", { url: "https://10.0.0.1/mcp" }, { resolve: publicResolve })).rejects.toBeInstanceOf(HttpError);
    await updateConnection(actor, "c1", { allowedTools: ["lookup", "lookup"] }, { resolve: publicResolve });
    expect(db.mcpConnection.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, data: { allowedTools: ["lookup"] } });
    db.mcpConnection.findFirst.mockResolvedValue(null);
    await expect(updateConnection(actor, "other", { enabled: false })).rejects.toMatchObject({ status: 404 });
  });
});

describe("callTool", () => {
  it("refuses tools that are not on the allowlist without any network call", async () => {
    const s = server([]);
    db.mcpConnection.findFirst.mockResolvedValue(row({ allowedTools: ["lookup"] }));
    await expect(callTool("t1", "c1", "delete_everything", {}, s.deps)).rejects.toMatchObject({ status: 403 });
    expect(s.transport).not.toHaveBeenCalled();
  });

  it("refuses disabled or foreign connections", async () => {
    const s = server([]);
    db.mcpConnection.findFirst.mockResolvedValue(null);
    await expect(callTool("t1", "c1", "lookup", {}, s.deps)).rejects.toMatchObject({ status: 403 });
    expect(db.mcpConnection.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1", enabled: true });
  });

  it("calls an allowed tool, returns plain text only and audits the tool name only", async () => {
    const s = server([], { content: [{ type: "text", text: "Order shipped" }, { type: "image", data: "AAAA" }], isError: false });
    db.mcpConnection.findFirst.mockResolvedValue(row());
    const out = await callTool("t1", "c1", "lookup", { orderId: "SECRET-ARG" }, s.deps);
    expect(out).toEqual({ text: "Order shipped\n[non-text content omitted]", isError: false });
    const call = JSON.parse(s.seen.at(-1)!.body);
    expect(call).toMatchObject({ method: "tools/call", params: { name: "lookup", arguments: { orderId: "SECRET-ARG" } } });
    expect(audit).toHaveBeenCalledTimes(1);
    const entry = audit.mock.calls[0][0];
    expect(entry).toMatchObject({ tenantId: "t1", action: "mcp.tool_call", target: "c1", meta: { tool: "lookup", isError: false } });
    expect(JSON.stringify(entry)).not.toMatch(/SECRET-ARG|Order shipped/);
  });

  it("caps the result text at 8 KB and strips control characters", async () => {
    const s = server([], { content: [{ type: "text", text: "a\u0000b".repeat(20000) }] });
    db.mcpConnection.findFirst.mockResolvedValue(row());
    const out = await callTool("t1", "c1", "lookup", {}, s.deps);
    expect(out.text.length).toBe(8192);
    expect(out.text).not.toContain("\u0000");
  });

  it("rejects arguments over 16 KB", async () => {
    const s = server([]);
    db.mcpConnection.findFirst.mockResolvedValue(row());
    await expect(callTool("t1", "c1", "lookup", { big: "x".repeat(17 * 1024) }, s.deps)).rejects.toMatchObject({ status: 400 });
    expect(s.transport).not.toHaveBeenCalled();
  });

  it("limits each tenant to 30 calls per minute", async () => {
    const s = server([]);
    db.mcpConnection.findFirst.mockResolvedValue(row());
    let t = 1_000_000;
    const deps = { ...s.deps, now: () => t };
    for (let i = 0; i < 30; i++) await callTool("t1", "c1", "lookup", {}, deps);
    await expect(callTool("t1", "c1", "lookup", {}, deps)).rejects.toMatchObject({ status: 429 });
    await callTool("t2", "c1", "lookup", {}, deps);
    t += 61_000;
    await expect(callTool("t1", "c1", "lookup", {}, deps)).resolves.toMatchObject({ isError: false });
  });

  it("returns an error result, not a throw, when the server is private at call time", async () => {
    const s = server([]);
    db.mcpConnection.findFirst.mockResolvedValue(row());
    const out = await callTool("t1", "c1", "lookup", {}, { ...s.deps, resolve: async () => ["127.0.0.1"] });
    expect(out.isError).toBe(true);
    expect(s.transport).not.toHaveBeenCalled();
    expect(audit.mock.calls[0][0].meta).toEqual({ tool: "lookup", isError: true });
  });
});

describe("listAllowedTools", () => {
  it("returns only ticked tools and skips connections with none", async () => {
    const s = server([
      { name: "lookup", description: "Find", inputSchema: { type: "object", properties: {} } },
      { name: "delete_all", description: "Danger" },
    ]);
    db.mcpConnection.findMany.mockResolvedValue([row(), row({ id: "c2", allowedTools: [] })]);
    const tools = await listAllowedTools("t1", s.deps);
    expect(tools).toEqual([{ connectionId: "c1", name: "lookup", description: "Find", inputSchema: { type: "object", properties: {} } }]);
    expect(db.mcpConnection.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", enabled: true });
  });
});

describe("customer exposure of risky tools (P3-03)", () => {
  let store: Record<string, unknown>;
  beforeEach(() => {
    store = {};
    db.platformSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (where.key in store ? { key: where.key, value: store[where.key] } : null));
    db.platformSetting.upsert.mockImplementation(async ({ where, update }: { where: { key: string }; update: { value: unknown } }) => {
      store[where.key] = update.value;
    });
    db.mcpConnection.updateMany.mockResolvedValue({ count: 1 });
  });

  const tools = [
    { connectionId: "c1", name: "lookup_order", description: "Find an order", inputSchema: {} },
    { connectionId: "c1", name: "refund_order", description: "Refund an order", inputSchema: {} },
    { connectionId: "c2", name: "refund_order", description: "Refund an order", inputSchema: {} },
  ];

  it("hides risky tools from customers unless the admin exposed that exact connection and tool", () => {
    expect(filterCustomerTools(tools, new Set()).map((t) => `${t.connectionId}:${t.name}`)).toEqual(["c1:lookup_order"]);
    expect(filterCustomerTools(tools, new Set(["c1:refund_order"])).map((t) => `${t.connectionId}:${t.name}`)).toEqual(["c1:lookup_order", "c1:refund_order"]);
  });

  it("reads the flag from PlatformSetting byo-mcp:customer-tools:<tenantId> and fails closed", async () => {
    expect(customerToolsKey("t1")).toBe("byo-mcp:customer-tools:t1");
    store["byo-mcp:customer-tools:t1"] = ["c1:refund_order", 7, null];
    expect(await listCustomerTools("t1", tools)).toHaveLength(2);
    expect(db.platformSetting.findUnique).toHaveBeenCalledWith({ where: { key: "byo-mcp:customer-tools:t1" } });
    expect((await listCustomerTools("t2", tools)).map((t) => t.name)).toEqual(["lookup_order"]);
    db.platformSetting.findUnique.mockRejectedValue(new Error("db down"));
    expect((await getCustomerExposure("t1")).size).toBe(0);
    expect((await listCustomerTools("t1", tools)).map((t) => t.name)).toEqual(["lookup_order"]);
  });

  it("saving customerTools keeps only tools that are allowed on that connection and leaves other connections alone", async () => {
    store["byo-mcp:customer-tools:t1"] = ["c2:refund_order"];
    db.mcpConnection.findFirst.mockResolvedValue(row({ allowedTools: ["lookup", "refund_order"] }));
    const view = await updateConnection(actor, "c1", { customerTools: ["refund_order", "not_allowed"] }, { resolve: publicResolve });
    expect(store["byo-mcp:customer-tools:t1"]).toEqual(["c2:refund_order", "c1:refund_order"]);
    expect(view.customerTools).toEqual(["refund_order"]);
    expect(db.mcpConnection.updateMany.mock.calls[0][0].data).toEqual({});
  });

  it("un-allowing a tool or changing the server url removes its exposure", async () => {
    store["byo-mcp:customer-tools:t1"] = ["c1:refund_order", "c1:lookup"];
    db.mcpConnection.findFirst.mockResolvedValue(row({ allowedTools: ["lookup", "refund_order"] }));
    await updateConnection(actor, "c1", { allowedTools: ["lookup"] }, { resolve: publicResolve });
    expect(store["byo-mcp:customer-tools:t1"]).toEqual(["c1:lookup"]);
    await updateConnection(actor, "c1", { url: "https://other.example.com/mcp" }, { resolve: publicResolve });
    expect(store["byo-mcp:customer-tools:t1"]).toEqual([]);
  });

  it("deleting a connection clears its exposure and the list/test views report it", async () => {
    store["byo-mcp:customer-tools:t1"] = ["c1:refund_order", "c2:x"];
    db.mcpConnection.findMany.mockResolvedValue([row({ allowedTools: ["refund_order"] })]);
    expect((await listConnections("t1"))[0].customerTools).toEqual(["refund_order"]);
    const s = server([{ name: "refund_order", description: "Refund an order", inputSchema: { type: "object" } }]);
    db.mcpConnection.findFirst.mockResolvedValue(row({ allowedTools: ["refund_order"] }));
    const out = await testConnection(actor, "c1", s.deps);
    expect(out).toMatchObject({ ok: true, tools: [{ name: "refund_order", risky: true, customerExposed: true }] });
    db.mcpConnection.deleteMany.mockResolvedValue({ count: 1 });
    await deleteConnection(actor, "c1");
    expect(store["byo-mcp:customer-tools:t1"]).toEqual(["c2:x"]);
  });
});

describe("tool argument validation (P3-03)", () => {
  const schema = {
    type: "object",
    required: ["orderId"],
    additionalProperties: false,
    properties: {
      orderId: { type: "string", minLength: 3, maxLength: 10, pattern: "^[A-Z0-9]+$" },
      amount: { type: "integer", minimum: 1, maximum: 100 },
      kind: { type: "string", enum: ["a", "b"] },
      tags: { type: "array", maxItems: 2, items: { type: "string" } },
      note: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  };

  it("accepts valid arguments", () => {
    expect(validateToolArgs(schema, { orderId: "A1001", amount: 5, kind: "a", tags: ["x"], note: null })).toBeNull();
    expect(validateToolArgs({}, { anything: 1 })).toBeNull();
    expect(validateToolArgs(undefined, {})).toBeNull();
  });

  it.each([
    [{}, /orderId is required/],
    [{ orderId: 5 }, /must be of type string/],
    [{ orderId: "a" }, /too short/],
    [{ orderId: "lower" }, /required format/],
    [{ orderId: "A1001", amount: 5000 }, /above the maximum/],
    [{ orderId: "A1001", amount: 1.5 }, /integer/],
    [{ orderId: "A1001", kind: "c" }, /allowed values/],
    [{ orderId: "A1001", tags: ["a", "b", "c"] }, /too many items/],
    [{ orderId: "A1001", tags: [1] }, /string/],
    [{ orderId: "A1001", note: 5 }, /any allowed form/],
    [{ orderId: "A1001", extra: true }, /not an accepted argument/],
  ])("rejects %j", (args, message) => {
    expect(validateToolArgs(schema, args)).toMatch(message);
  });

  it("rejects non-object arguments and never echoes values", () => {
    expect(validateToolArgs(schema, "text")).toMatch(/object/);
    expect(validateToolArgs(schema, [1])).toMatch(/object/);
    expect(validateToolArgs(schema, { orderId: "secret-value-lower" })).not.toContain("secret-value");
  });
});

describe("read-only by default (P3-03)", () => {
  const unlisted = [
    "approve_request", "add_item", "set_price", "submit_order", "book_appointment", "apply_discount", "grant_access", "assign_agent", "issue_credit", "change_plan",
    "mark_paid", "close_ticket", "notify_customer", "schedule_visit", "register_user", "ship_order", "purchase_item", "redeem_code",
  ];

  it.each(unlisted)("%s is not safe for customers without the admin flag", (name) => {
    expect(isCustomerSafeTool(name, "Does the thing")).toBe(false);
  });

  it("recognises plainly read-only tools", () => {
    for (const name of ["get_order", "lookup_order", "list_products", "search_faq", "order_status", "checkStock", "find-store"]) expect(isCustomerSafeTool(name, "Find something")).toBe(true);
    expect(isCustomerSafeTool("get_order_and_cancel", "")).toBe(false);
    expect(isCustomerSafeTool("get_order", "Looks up an order and updates its status")).toBe(false);
  });

  it("an unrecognised name needs the server's readOnlyHint, which a destructive hint overrides", () => {
    expect(isCustomerSafeTool("order_history", "Past orders")).toBe(false);
    expect(isCustomerSafeTool("order_history", "Past orders", { readOnlyHint: true })).toBe(true);
    expect(isCustomerSafeTool("get_order", "", { readOnlyHint: false })).toBe(false);
    expect(isCustomerSafeTool("get_order", "", { destructiveHint: true })).toBe(false);
    expect(isCustomerSafeTool("delete_order", "", { readOnlyHint: true })).toBe(false);
  });

  it("filterCustomerTools hides unlisted verbs but offers them once exposed", () => {
    const tools = unlisted.map((name) => ({ connectionId: "c1", name, description: "Does the thing" }));
    expect(filterCustomerTools(tools, new Set())).toEqual([]);
    expect(filterCustomerTools(tools, new Set(["c1:add_item"])).map((t) => t.name)).toEqual(["add_item"]);
    const hinted = { connectionId: "c1", name: "order_history", description: "Past orders", readOnlyHint: true };
    expect(filterCustomerTools([hinted], new Set())).toHaveLength(1);
  });

  it("reads annotations from the server and reports unlisted verbs as needing the flag", async () => {
    const s = server([
      { name: "order_history", description: "Past orders", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "approve_request", description: "Does the thing", inputSchema: { type: "object" }, annotations: { readOnlyHint: "yes" } },
    ]);
    db.platformSetting.findUnique.mockResolvedValue(null);
    db.mcpConnection.findFirst.mockResolvedValue(row({ allowedTools: ["order_history", "approve_request"] }));
    const out = await testConnection(actor, "c1", s.deps);
    expect(out).toMatchObject({ ok: true, tools: [{ name: "order_history", risky: false }, { name: "approve_request", risky: true }] });
    db.mcpConnection.findMany.mockResolvedValue([row({ allowedTools: ["order_history"] })]);
    const listed = await listAllowedTools("t1", s.deps);
    expect(listed[0]).toMatchObject({ name: "order_history", readOnlyHint: true });
  });
});

describe("pattern keyword safety (P3-03)", () => {
  it("skips a pattern that is only valid without the u flag instead of blocking every call", () => {
    expect(validateToolArgs({ properties: { id: { type: "string", pattern: "^a\\_b$" } } }, { id: "a_b" })).toBeNull();
    expect(validateToolArgs({ properties: { id: { type: "string", pattern: "^a\\_b$" } } }, { id: "xyz" })).toMatch(/required format/);
  });

  it("skips a pattern that is not a valid regular expression at all", () => {
    expect(validateToolArgs({ properties: { id: { type: "string", pattern: "([unclosed" } } }, { id: "anything" })).toBeNull();
  });

  it("does not run catastrophic patterns on model input", () => {
    const started = Date.now();
    for (const pattern of ["(a+)+$", "(a|aa)+$", "(.*a){12}x", "^(\\w+\\s?)*$", "(x+x+)+y", "(a*)*b"]) {
      expect(validateToolArgs({ properties: { id: { type: "string", pattern } } }, { id: `${"a".repeat(40)}!` })).toBeNull();
    }
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("bounds the input a pattern is run against", () => {
    const schema = { properties: { id: { type: "string", pattern: "^[a-z]+$" } } };
    expect(validateToolArgs(schema, { id: "a".repeat(500) })).toBeNull();
    expect(validateToolArgs(schema, { id: "a".repeat(501) })).toMatch(/too long/);
  });

  it("keeps ordinary patterns working", () => {
    const schema = { properties: { email: { type: "string", pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" }, phone: { type: "string", pattern: "^\\+?[0-9]{10,13}$" } } };
    expect(validateToolArgs(schema, { email: "a@b.co", phone: "+919999999999" })).toBeNull();
    expect(validateToolArgs(schema, { email: "nope" })).toMatch(/required format/);
  });
});

describe("exposure write ordering and locking (P3-03)", () => {
  let store: Record<string, unknown>;
  beforeEach(() => {
    store = {};
    db.platformSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
      const value = store[where.key];
      await new Promise((r) => setTimeout(r, 5));
      return value === undefined ? null : { key: where.key, value };
    });
    db.platformSetting.upsert.mockImplementation(async ({ where, update }: { where: { key: string }; update: { value: unknown } }) => {
      await new Promise((r) => setTimeout(r, 5));
      store[where.key] = update.value;
    });
    db.mcpConnection.updateMany.mockResolvedValue({ count: 1 });
  });

  it("clears the exposure before the new server url is committed", async () => {
    store["byo-mcp:customer-tools:t1"] = ["c1:refund_order"];
    db.mcpConnection.findFirst.mockResolvedValue(row({ allowedTools: ["refund_order"] }));
    const order: string[] = [];
    db.platformSetting.upsert.mockImplementationOnce(async ({ where, update }: { where: { key: string }; update: { value: unknown } }) => {
      store[where.key] = update.value;
      order.push("exposure");
    });
    db.mcpConnection.updateMany.mockImplementation(async () => {
      order.push("connection");
      return { count: 1 };
    });
    await updateConnection(actor, "c1", { url: "https://other.example.com/mcp" }, { resolve: publicResolve });
    expect(order).toEqual(["exposure", "connection"]);
    expect(store["byo-mcp:customer-tools:t1"]).toEqual([]);
  });

  it("does not change the url when the exposure could not be cleared", async () => {
    store["byo-mcp:customer-tools:t1"] = ["c1:refund_order"];
    db.mcpConnection.findFirst.mockResolvedValue(row({ allowedTools: ["refund_order"] }));
    db.platformSetting.upsert.mockRejectedValue(new Error("db down"));
    await expect(updateConnection(actor, "c1", { url: "https://other.example.com/mcp" }, { resolve: publicResolve })).rejects.toThrow("db down");
    expect(db.mcpConnection.updateMany).not.toHaveBeenCalled();
  });

  it("two concurrent saves on different connections both survive", async () => {
    await Promise.all([setConnectionExposure("t1", "c1", ["refund_order"]), setConnectionExposure("t1", "c2", ["cancel_order"]), setConnectionExposure("t1", "c3", ["delete_order"])]);
    expect([...(store["byo-mcp:customer-tools:t1"] as string[])].sort()).toEqual(["c1:refund_order", "c2:cancel_order", "c3:delete_order"]);
  });

  it("a failed read never wipes the other connections' entries", async () => {
    store["byo-mcp:customer-tools:t1"] = ["c2:refund_order"];
    db.platformSetting.findUnique.mockRejectedValueOnce(new Error("db down"));
    await expect(setConnectionExposure("t1", "c1", ["x"])).rejects.toThrow("db down");
    expect(store["byo-mcp:customer-tools:t1"]).toEqual(["c2:refund_order"]);
    await setConnectionExposure("t1", "c1", ["x"]);
    expect(store["byo-mcp:customer-tools:t1"]).toEqual(["c2:refund_order", "c1:x"]);
  });
});
