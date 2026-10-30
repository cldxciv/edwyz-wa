import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/tokens", () => ({ getAccessToken: vi.fn(async () => "SECRET-TOKEN-123") }));

import { GRAPH_API_VERSION } from "@/lib/config";
import { GraphError, graphUpload } from "@/lib/graph";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const request = () => ({
  tenantId: "t1",
  path: "meta_phone_1/media",
  fields: { messaging_product: "whatsapp", type: "application/pdf" },
  file: { bytes: new TextEncoder().encode("%PDF-1.7 hello"), filename: "a.pdf", mime: "application/pdf" },
});

describe("graphUpload", () => {
  it("posts multipart form data with the token in the header only", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: "555" }));
    await expect(graphUpload(request())).resolves.toEqual({ id: "555" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/meta_phone_1/media`);
    expect(url).not.toContain("SECRET");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer SECRET-TOKEN-123");
    expect(init.headers["Content-Type"]).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const form = init.body as FormData;
    expect(form.get("messaging_product")).toBe("whatsapp");
    expect(form.get("type")).toBe("application/pdf");
    const file = form.get("file") as File;
    expect(file.name).toBe("a.pdf");
    expect(file.type).toBe("application/pdf");
    expect(await file.text()).toBe("%PDF-1.7 hello");
  });

  it("turns a Meta rejection into a GraphError and never retries the upload", async () => {
    fetchMock.mockResolvedValue(json(400, { error: { message: "(#100) Param file must be a file", code: 100, error_subcode: 2 } }));
    const err = await graphUpload(request()).catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err).toMatchObject({ status: 400, code: 100, subcode: 2, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a lost connection as ambiguous and does not retry, so a file cannot be stored twice", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const err = await graphUpload(request()).catch((e) => e);
    expect(err).toMatchObject({ status: 0, retryable: false, ambiguous: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not put the token or file contents in any log line", async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: { message: "oops" } }));
    await graphUpload(request()).catch(() => undefined);
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(" ");
    expect(logged).not.toContain("SECRET-TOKEN-123");
    expect(logged).not.toContain("%PDF");
  });
});
