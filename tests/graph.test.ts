import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/tokens", () => ({ getAccessToken: vi.fn(async () => "SECRET-TOKEN-123") }));

import { GRAPH_API_VERSION } from "@/lib/config";
import { appGraphFetch, appSecretProof, backoffDelay, GraphError, graphFetch, graphFetchAs, graphUpload } from "@/lib/graph";
import { SpendGuardBypassError } from "@/lib/spend/errors";
import { setTripwireAuditSink, type TripwireAuditEvent } from "@/lib/spend/tripwire";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const metaError = (status: number, code: number, message = "boom") => json(status, { error: { message, code, error_subcode: 7 } });

let fetchMock: ReturnType<typeof vi.fn>;
let logs: string[];
let tripwireEvents: TripwireAuditEvent[];

beforeEach(() => {
  // The spend tripwire runs in run(); its audit rows go here instead of the database.
  tripwireEvents = [];
  setTripwireAuditSink((e) => void tripwireEvents.push(e));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("setTimeout", (fn: () => void) => {
    fn();
    return 0;
  });
  logs = [];
  for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.join(" ")));
});
afterEach(() => {
  setTripwireAuditSink(null);
  delete process.env.SPEND_TRIPWIRE;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("spend tripwire in run() (docs/SPEND-CONTROLS-SPEC.md 4.7)", () => {
  it("report mode (the default) keeps today's behaviour: an unpermitted send or ads write still goes out, and is audited by pattern", async () => {
    fetchMock.mockImplementation(async () => json(200, { id: "1" }));
    await graphFetch({ tenantId: "t", path: "123/messages", method: "POST", body: { to: "1" } });
    await graphFetchAs("TOKEN", { path: "act_1/campaigns", method: "POST", body: { name: "x", status: "PAUSED" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tripwireEvents.map((e) => [e.action, e.target, e.meta.blocked])).toEqual([
      ["spend.tripwire.bypass", "{id}/messages", false],
      ["spend.tripwire.bypass", "act_{id}/campaigns", false],
    ]);
    expect(JSON.stringify(tripwireEvents)).not.toContain("TOKEN");
  });

  it("enforce mode refuses before any fetch; reads, uploads and non-spend writes are never touched", async () => {
    process.env.SPEND_TRIPWIRE = "enforce";
    fetchMock.mockImplementation(async () => json(200, { id: "1", success: true }));
    await expect(graphFetchAs("TOKEN", { path: "act_1", method: "POST", body: { spend_cap: "100" } })).rejects.toBeInstanceOf(SpendGuardBypassError);
    await expect(graphFetch({ tenantId: "t", path: "123/messages", method: "POST", body: { to: "1" } })).rejects.toBeInstanceOf(SpendGuardBypassError);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    await graphFetch({ tenantId: "t", path: "1/subscribed_apps", method: "POST" });
    await graphFetchAs("TOKEN", { path: "act_1/insights", query: { fields: "spend" } });
    await appGraphFetch({ path: "oauth/access_token", query: { code: "c" } }).catch(() => undefined);
    await graphUpload({ tenantId: "t", path: "123/media", fields: { messaging_product: "whatsapp" }, file: { bytes: new Uint8Array([1]), filename: "a.png", mime: "image/png" } });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe("graphFetch", () => {
  it("sends the token in the Authorization header only", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: 1 }));
    await expect(graphFetch({ tenantId: "t", path: "123/messages", method: "POST", query: { a: "b" }, body: { x: 1 } })).resolves.toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/123/messages?a=b`);
    expect(url).not.toContain("SECRET");
    expect(init.headers.Authorization).toBe("Bearer SECRET-TOKEN-123");
    expect(init.body).toBe('{"x":1}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([4, 80007, 130429, 131056])("retries Meta code %i and then succeeds", async (code) => {
    fetchMock.mockResolvedValueOnce(metaError(400, code)).mockResolvedValueOnce(json(200, { ok: true }));
    await expect(graphFetch({ tenantId: "t", path: "x" })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([429, 500, 502, 503, 504])("retries HTTP %i", async (status) => {
    fetchMock.mockResolvedValueOnce(json(status, {})).mockResolvedValueOnce(json(200, {}));
    await graphFetch({ tenantId: "t", path: "x" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries network errors", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(json(200, {}));
    await graphFetch({ tenantId: "t", path: "x" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([131047, 131026, 190, 100])("does not retry code %i", async (code) => {
    fetchMock.mockImplementation(async () => metaError(400, code));
    await expect(graphFetch({ tenantId: "t", path: "x" })).rejects.toMatchObject({ code, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry 131047 even on a retryable HTTP status", async () => {
    fetchMock.mockImplementation(async () => metaError(500, 131047));
    await expect(graphFetch({ tenantId: "t", path: "x" })).rejects.toMatchObject({ code: 131047 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after 4 attempts", async () => {
    fetchMock.mockImplementation(async () => json(503, {}));
    await expect(graphFetch({ tenantId: "t", path: "x" })).rejects.toBeInstanceOf(GraphError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("parses Meta error objects", async () => {
    fetchMock.mockResolvedValueOnce(metaError(400, 100, "Invalid parameter"));
    await expect(graphFetch({ tenantId: "t", path: "x" })).rejects.toMatchObject({ message: "Invalid parameter", status: 400, code: 100, subcode: 7 });
  });

  it("never leaks the token in errors or logs", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed for Bearer SECRET-TOKEN-123"));
    const err = (await graphFetch({ tenantId: "t", path: "x" }).catch((e) => e)) as Error;
    expect(err.message).not.toContain("SECRET");
    expect(JSON.stringify(err)).not.toContain("SECRET");
    expect(logs.join("\n")).not.toContain("SECRET");
  });

  it("backs off exponentially with jitter", () => {
    expect(backoffDelay(1, () => 0)).toBe(250);
    expect(backoffDelay(1, () => 1)).toBe(500);
    expect(backoffDelay(3, () => 1)).toBe(2000);
  });
});

describe("appGraphFetch", () => {
  it("uses app credentials and requires them", async () => {
    delete process.env.META_APP_ID;
    await expect(appGraphFetch({ path: "oauth/access_token" })).rejects.toThrow(/META_APP_ID/);
    process.env.META_APP_ID = "111";
    process.env.META_APP_SECRET = "shh";
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "t" }));
    await appGraphFetch({ path: "oauth/access_token", query: { code: "c" } });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("client_id")).toBe("111");
    expect(url.searchParams.get("client_secret")).toBe("shh");
    expect(url.searchParams.get("code")).toBe("c");
  });
});

describe("F6 message sends are never repeated after an ambiguous failure", () => {
  const send = () => graphFetch({ tenantId: "t", path: "123/messages", method: "POST", body: { to: "1" } });
  const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

  it("does not retry a timeout or reset on POST /messages and flags it ambiguous", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    await expect(send()).rejects.toMatchObject({ ambiguous: true, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
    await expect(send()).rejects.toMatchObject({ ambiguous: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry HTTP 5xx on POST /messages", async () => {
    fetchMock.mockImplementation(async () => json(503, {}));
    await expect(send()).rejects.toMatchObject({ status: 503, ambiguous: true, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries when the connection definitely failed before sending (ECONNREFUSED)", async () => {
    fetchMock.mockRejectedValueOnce(refused()).mockResolvedValueOnce(json(200, { messages: [{ id: "w" }] }));
    await expect(send()).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([4, 80007, 130429, 131056])("still retries the Meta rejection %i, even with a 5xx status", async (code) => {
    fetchMock.mockResolvedValueOnce(metaError(500, code)).mockResolvedValueOnce(json(200, { ok: true }));
    await send();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying timeouts on GET requests", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("timeout"), { name: "TimeoutError" })).mockResolvedValueOnce(json(200, {}));
    await graphFetch({ tenantId: "t", path: "123/message_templates" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("graphFetchAs never creates an object twice", () => {
  it("does not retry a POST after a 5xx, which may already have been applied", async () => {
    fetchMock.mockResolvedValue(json(503, { error: { message: "unavailable", code: 2 } }));
    await expect(graphFetchAs("TOKEN", { path: "act_1/campaigns", method: "POST", body: { name: "x" } })).rejects.toBeInstanceOf(GraphError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a POST after a lost connection", async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
    await expect(graphFetchAs("TOKEN", { path: "PAGE/feed", method: "POST", body: { message: "hi" } })).rejects.toBeInstanceOf(GraphError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries a POST that Meta explicitly rate limited", async () => {
    fetchMock.mockResolvedValueOnce(metaError(400, 4)).mockResolvedValueOnce(json(200, { id: "1" }));
    await expect(graphFetchAs("TOKEN", { path: "act_1/ads", method: "POST", body: {} })).resolves.toEqual({ id: "1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying reads on a 503", async () => {
    fetchMock.mockResolvedValueOnce(json(503, {})).mockResolvedValueOnce(json(200, { data: [] }));
    await expect(graphFetchAs("TOKEN", { path: "me/accounts" })).resolves.toEqual({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("appsecret_proof", () => {
  const SECRET = "app-secret-for-proof";
  const proofOf = (token: string, secret = SECRET) => createHmac("sha256", secret).update(token).digest("hex");
  const saved = process.env.META_APP_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = saved;
  });

  it("is the hex HMAC-SHA256 of the token keyed with the app secret", () => {
    expect(appSecretProof("tok", SECRET)).toBe(proofOf("tok"));
    expect(appSecretProof("tok", SECRET)).toMatch(/^[0-9a-f]{64}$/);
    expect(appSecretProof("tok", "other")).not.toBe(appSecretProof("tok", SECRET));
  });

  it("is sent as a query parameter by graphFetch, for GET and POST, next to the caller's own query", async () => {
    process.env.META_APP_SECRET = SECRET;
    fetchMock.mockImplementation(async () => json(200, {}));
    await graphFetch({ tenantId: "t", path: "1/subscribed_apps", method: "POST", query: { a: "b" }, body: { x: 1 } });
    await graphFetch({ tenantId: "t", path: "1" });
    for (const call of fetchMock.mock.calls) expect(new URL(call[0]).searchParams.get("appsecret_proof")).toBe(proofOf("SECRET-TOKEN-123"));
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("a")).toBe("b");
    expect(fetchMock.mock.calls[0][1].body).toBe('{"x":1}');
  });

  it("is sent by graphFetchAs with the token it was given, also on guarded POSTs and on retries", async () => {
    process.env.META_APP_SECRET = SECRET;
    fetchMock.mockResolvedValueOnce(metaError(400, 4)).mockResolvedValueOnce(json(200, {}));
    await graphFetchAs("page-token", { path: "act_1/campaigns", method: "POST", body: {} });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(new URL(call[0]).searchParams.get("appsecret_proof")).toBe(proofOf("page-token"));
      expect(call[1].headers.Authorization).toBe("Bearer page-token");
    }
  });

  it("is sent on media uploads too", async () => {
    process.env.META_APP_SECRET = SECRET;
    fetchMock.mockImplementation(async () => json(200, { id: "m1" }));
    await graphUpload({ tenantId: "t", path: "123/media", fields: { messaging_product: "whatsapp" }, file: { bytes: new Uint8Array([1, 2]), filename: "a.png", mime: "image/png" } });
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("appsecret_proof")).toBe(proofOf("SECRET-TOKEN-123"));
  });

  it("is left out cleanly when META_APP_SECRET is not set", async () => {
    delete process.env.META_APP_SECRET;
    fetchMock.mockImplementation(async () => json(200, {}));
    await graphFetch({ tenantId: "t", path: "1", query: { a: "b" } });
    await graphFetchAs("page-token", { path: "2" });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/1?a=b`);
    expect(fetchMock.mock.calls[1][0]).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/2`);
    expect(appSecretProof("tok", undefined)).toBeNull();
    process.env.META_APP_SECRET = "";
    expect(appSecretProof("tok")).toBeNull();
  });

  it("is not added to an app access token (id|secret) and does not replace the oauth client secret", async () => {
    process.env.META_APP_SECRET = SECRET;
    process.env.META_APP_ID = "111";
    fetchMock.mockImplementation(async () => json(200, {}));
    await graphFetchAs("111|appsecretvalue", { path: "debug_token", query: { input_token: "x" } });
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.has("appsecret_proof")).toBe(false);
    await appGraphFetch({ path: "oauth/access_token", query: { code: "c" } });
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.has("appsecret_proof")).toBe(false);
  });

  it("never puts the proof, the token or the secret in an error or a log line", async () => {
    process.env.META_APP_SECRET = SECRET;
    fetchMock.mockImplementation(async () => metaError(400, 100, "Invalid parameter"));
    const err = (await graphFetch({ tenantId: "t", path: "x" }).catch((e) => e)) as Error;
    const proof = proofOf("SECRET-TOKEN-123");
    for (const text of [err.message, JSON.stringify(err), logs.join("\n")]) {
      expect(text).not.toContain(proof);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("SECRET-TOKEN-123");
    }
  });
});
