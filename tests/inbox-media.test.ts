import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ message: { findFirst: vi.fn() } }));
const graphFetch = vi.hoisted(() => vi.fn());
const getActor = vi.hoisted(() => vi.fn());
const SECRET = "EAAB-secret-token-value";
const getAccessToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor }));
vi.mock("@/lib/crypto/tokens", () => ({ getAccessToken }));
vi.mock("@/lib/teams/visibility", () => ({ conversationScopeFor: vi.fn(async () => null) }));
vi.mock("@/lib/graph", async (orig) => ({ ...(await orig<typeof import("@/lib/graph")>()), graphFetch }));

import { GraphError } from "@/lib/graph";
import {
  adoptPendingUpload,
  evictOldest,
  inboundMediaDir,
  inboundMediaPath,
  keepPendingUpload,
  MAX_INBOUND_MEDIA_BYTES,
  MAX_TENANT_DOWNLOADS,
  narrowMime,
  parseAllowedMediaUrl,
  parseRange,
  PENDING_UPLOAD_QUOTA_BYTES,
  PENDING_UPLOAD_TTL_MS,
  pendingUploadPath,
  sniffMime,
  sweepPendingUploads,
} from "@/lib/inbox/media";
import { parseMediaRef, toMediaRef } from "@/lib/webhooks/media";
import { GET } from "@/app/api/inbox/media/[messageId]/route";

let dataDir: string;
const realFetch = globalThis.fetch;
const fetchMock = vi.fn();

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-media-"));
  process.env.DATA_DIR = dataDir;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("0123456789abcdef")]);
const CDN = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1";

function messages(rows: Record<string, { tenantId: string; mediaUrl: string | null; mediaMime: string | null }>) {
  db.message.findFirst.mockImplementation(async ({ where }: { where: { id: string; tenantId: string } }) => {
    const row = rows[where.id];
    return row && row.tenantId === where.tenantId ? { mediaUrl: row.mediaUrl, mediaMime: row.mediaMime } : null;
  });
}

const call = (id: string, headers: Record<string, string> = {}) =>
  GET(new Request(`https://wa.edwyz.com/api/inbox/media/${id}`, { headers }), { params: Promise.resolve({ messageId: id }) });

let seq = 0;
const freshTenant = () => `tenant${++seq}`;
const asTenant = (tenantId: string) => getActor.mockResolvedValue({ userId: `u-${tenantId}`, tenantId, role: "agent" });

beforeEach(() => {
  vi.clearAllMocks();
  getAccessToken.mockReset();
  getAccessToken.mockResolvedValue(SECRET);
  graphFetch.mockReset();
  graphFetch.mockResolvedValue({ url: CDN, mime_type: "image/jpeg", file_size: JPEG.length });
  fetchMock.mockImplementation(async () => new Response(JPEG, { status: 200, headers: { "content-length": String(JPEG.length) } }));
});

describe("mime narrowing", () => {
  it("keeps allow-listed types, strips parameters, and serves everything else as an opaque download", () => {
    expect(narrowMime("image/jpeg")).toMatchObject({ mime: "image/jpeg", inline: true });
    expect(narrowMime("audio/ogg; codecs=opus")).toMatchObject({ mime: "audio/ogg", inline: true });
    expect(narrowMime("IMAGE/PNG")).toMatchObject({ mime: "image/png", inline: true });
    expect(narrowMime("application/pdf")).toMatchObject({ mime: "application/pdf", inline: false });
    for (const hostile of ["text/html", "image/svg+xml", "application/javascript", "application/x-msdownload", "", null, undefined]) {
      expect(narrowMime(hostile)).toEqual({ mime: "application/octet-stream", inline: false, ext: "bin" });
    }
  });

  it("recognises formats by their first bytes only as a fallback", () => {
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(Buffer.from("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffMime(Buffer.from("<html><script>"))).toBeNull();
  });
});

describe("host allow-list", () => {
  it("accepts https on Meta media hosts", () => {
    for (const ok of ["https://lookaside.fbsbx.com/x", "https://scontent.xx.fbcdn.net/v/a.jpg", "https://mmg.whatsapp.net/d/x", "https://a.b.fbcdn.net:443/x"]) {
      expect(parseAllowedMediaUrl(ok)).not.toBeNull();
    }
  });

  it("refuses look-alike hosts, plain http, credentials, other ports and junk", () => {
    for (const bad of [
      "http://lookaside.fbsbx.com/x",
      "https://lookaside.fbsbx.com.evil.com/x",
      "https://evil.com/lookaside.fbsbx.com",
      "https://evilfbcdn.net/x",
      "https://fbcdn.net.evil.com/x",
      "https://whatsapp.net/x",
      "https://user:pw@lookaside.fbsbx.com/x",
      "https://lookaside.fbsbx.com:8443/x",
      "https://graph.facebook.com/v21.0/123",
      "https://127.0.0.1/x",
      "ftp://x.fbcdn.net/x",
      "not a url",
    ]) {
      expect(parseAllowedMediaUrl(bad), bad).toBeNull();
    }
  });
});

describe("references and ranges", () => {
  it("round-trips plain media references only", () => {
    expect(parseMediaRef(toMediaRef("123"))).toBe("123");
    expect(parseMediaRef("meta-media:../etc")).toBeNull();
    expect(parseMediaRef("https://x.com/a.png")).toBeNull();
    expect(parseMediaRef(null)).toBeNull();
  });

  it("parses single byte ranges", () => {
    expect(parseRange(null, 100)).toBe("none");
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=0-999", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=0-1,5-6", 100)).toBe("none");
  });

  it("builds cache paths only from plain ids", () => {
    expect(inboundMediaPath("t1", "m1")).toBe(path.resolve(dataDir, "inbound-media", "t1", "m1"));
    expect(inboundMediaPath("t1", "../m1")).toBeNull();
    expect(inboundMediaPath("../t1", "m1")).toBeNull();
    expect(inboundMediaPath("t1", "a/b")).toBeNull();
    expect(inboundMediaDir("")).toBeNull();
  });
});

describe("GET /api/inbox/media/[messageId]", () => {
  it("returns 404 for another workspace's message without calling Meta", async () => {
    const mine = freshTenant();
    const theirs = freshTenant();
    messages({ other1: { tenantId: theirs, mediaUrl: "meta-media:111", mediaMime: "image/jpeg" } });
    asTenant(mine);
    const res = await call("other1");
    expect(res.status).toBe(404);
    expect(db.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "other1", tenantId: mine } }));
    expect(graphFetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(inboundMediaPath(theirs, "other1") as string)).toBe(false);
  });

  it("returns 404 for messages without Meta media, unknown ids and unsafe ids", async () => {
    const t = freshTenant();
    messages({ text1: { tenantId: t, mediaUrl: null, mediaMime: null }, link1: { tenantId: t, mediaUrl: "https://example.com/a.png", mediaMime: "image/png" } });
    asTenant(t);
    expect((await call("text1")).status).toBe(404);
    expect((await call("link1")).status).toBe(404);
    expect((await call("missing")).status).toBe(404);
    expect((await call("..%2F..%2Fetc")).status).toBe(404);
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("requires a signed-in member", async () => {
    getActor.mockRejectedValue(new (await import("@/lib/tenancy")).HttpError(401, "Sign in."));
    expect((await call("m1")).status).toBe(401);
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });

  it("streams an image inline with safe headers, using the tenant token only against Meta", async () => {
    const t = freshTenant();
    messages({ img1: { tenantId: t, mediaUrl: "meta-media:555", mediaMime: "image/jpeg" } });
    asTenant(t);
    const res = await call("img1");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(graphFetch).toHaveBeenCalledWith({ tenantId: t, path: "555" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CDN);
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const everything = JSON.stringify([...res.headers.entries()]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("fbsbx");
  });

  it("narrows the stored mime type: documents download, hostile types become opaque downloads", async () => {
    const t = freshTenant();
    messages({
      pdf1: { tenantId: t, mediaUrl: "meta-media:1", mediaMime: "application/pdf" },
      svg1: { tenantId: t, mediaUrl: "meta-media:2", mediaMime: "image/svg+xml" },
      html1: { tenantId: t, mediaUrl: "meta-media:3", mediaMime: "text/html" },
      ogg1: { tenantId: t, mediaUrl: "meta-media:4", mediaMime: "audio/ogg; codecs=opus" },
    });
    asTenant(t);
    const pdf = await call("pdf1");
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="file-pdf1.pdf"');
    for (const id of ["svg1", "html1"]) {
      const res = await call(id);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const ogg = await call("ogg1");
    expect(ogg.headers.get("content-type")).toBe("audio/ogg");
    expect(ogg.headers.get("content-disposition")).toBe("inline");
  });

  it("falls back to Meta's mime type, then to the first bytes, when the message has none", async () => {
    const t = freshTenant();
    messages({ nomime1: { tenantId: t, mediaUrl: "meta-media:7", mediaMime: null }, nomime2: { tenantId: t, mediaUrl: "meta-media:8", mediaMime: null } });
    asTenant(t);
    expect((await call("nomime1")).headers.get("content-type")).toBe("image/jpeg");
    graphFetch.mockResolvedValue({ url: CDN, file_size: JPEG.length });
    const sniffed = await call("nomime2");
    expect(sniffed.headers.get("content-type")).toBe("image/jpeg");
    expect(sniffed.headers.get("content-disposition")).toBe("inline");
  });

  it("refuses a download link on a host outside Meta's media hosts, without sending the token anywhere", async () => {
    const t = freshTenant();
    messages({ bad1: { tenantId: t, mediaUrl: "meta-media:9", mediaMime: "image/jpeg" } });
    asTenant(t);
    for (const url of ["https://evil.example.com/a.jpg", "http://lookaside.fbsbx.com/a.jpg", "https://lookaside.fbsbx.com.evil.com/a.jpg", "https://graph.facebook.com/x"]) {
      graphFetch.mockResolvedValue({ url, mime_type: "image/jpeg", file_size: 10 });
      const res = await call("bad1");
      expect(res.status).toBe(502);
      const body = JSON.stringify(await res.json());
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain("evil");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows redirects only between allowed hosts", async () => {
    const t = freshTenant();
    messages({ red1: { tenantId: t, mediaUrl: "meta-media:10", mediaMime: "image/jpeg" }, red2: { tenantId: t, mediaUrl: "meta-media:11", mediaMime: "image/jpeg" } });
    asTenant(t);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://scontent.xx.fbcdn.net/real.jpg" } }))
      .mockResolvedValueOnce(new Response(JPEG, { status: 200 }));
    const ok = await call("red1");
    expect(ok.status).toBe(200);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([CDN, "https://scontent.xx.fbcdn.net/real.jpg"]);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } }));
    const res = await call("red2");
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up on endless redirects", async () => {
    const t = freshTenant();
    messages({ loop1: { tenantId: t, mediaUrl: "meta-media:12", mediaMime: "image/jpeg" } });
    asTenant(t);
    fetchMock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: CDN } }));
    expect((await call("loop1")).status).toBe(502);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("enforces the 25 MB cap from file_size, content-length and the streamed bytes", async () => {
    const t = freshTenant();
    messages({ big1: { tenantId: t, mediaUrl: "meta-media:20", mediaMime: "video/mp4" }, big2: { tenantId: t, mediaUrl: "meta-media:21", mediaMime: "video/mp4" }, big3: { tenantId: t, mediaUrl: "meta-media:22", mediaMime: "video/mp4" } });
    asTenant(t);

    graphFetch.mockResolvedValue({ url: CDN, mime_type: "video/mp4", file_size: MAX_INBOUND_MEDIA_BYTES + 1 });
    expect((await call("big1")).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();

    graphFetch.mockResolvedValue({ url: CDN, mime_type: "video/mp4", file_size: 100 });
    fetchMock.mockResolvedValueOnce(new Response("tiny", { status: 200, headers: { "content-length": String(MAX_INBOUND_MEDIA_BYTES + 1) } }));
    expect((await call("big2")).status).toBe(413);

    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(new Uint8Array(1048576));
        if (sent > 40) controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    expect((await call("big3")).status).toBe(413);
    expect(sent).toBeLessThanOrEqual(27);
    expect(fs.existsSync(inboundMediaPath(t, "big3") as string)).toBe(false);
  });

  it("maps Meta failures to plain errors without leaking details", async () => {
    const t = freshTenant();
    messages({ gone1: { tenantId: t, mediaUrl: "meta-media:30", mediaMime: "image/jpeg" } });
    asTenant(t);
    graphFetch.mockRejectedValueOnce(new GraphError(`Bearer ${SECRET} rejected`, 400, 100));
    const gone = await call("gone1");
    expect(gone.status).toBe(404);
    graphFetch.mockRejectedValueOnce(new GraphError(`token ${SECRET} invalid`, 401, 190));
    const denied = await call("gone1");
    expect(denied.status).toBe(502);
    expect(JSON.stringify(await denied.json())).not.toContain(SECRET);
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    expect((await call("gone1")).status).toBe(404);
    fetchMock.mockRejectedValueOnce(new Error(`connect failed with ${SECRET}`));
    const net = await call("gone1");
    expect(net.status).toBe(502);
    expect(JSON.stringify(await net.json())).not.toContain(SECRET);
  });

  it("caches on disk and serves later requests without calling Meta, with range support", async () => {
    const t = freshTenant();
    messages({ cache1: { tenantId: t, mediaUrl: "meta-media:40", mediaMime: "audio/ogg; codecs=opus" } });
    asTenant(t);
    const first = await call("cache1");
    expect(Buffer.from(await first.arrayBuffer())).toEqual(JPEG);
    const file = inboundMediaPath(t, "cache1") as string;
    expect(fs.readFileSync(file)).toEqual(JPEG);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["cache1"]);
    expect(graphFetch).toHaveBeenCalledTimes(1);

    const second = await call("cache1");
    expect(second.status).toBe(200);
    expect(Buffer.from(await second.arrayBuffer())).toEqual(JPEG);
    expect(second.headers.get("accept-ranges")).toBe("bytes");
    expect(graphFetch).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const part = await call("cache1", { range: "bytes=4-7" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 4-7/${JPEG.length}`);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(JPEG.subarray(4, 8));
    const bad = await call("cache1", { range: "bytes=500-" });
    expect(bad.status).toBe(416);
    expect(graphFetch).toHaveBeenCalledTimes(1);
  });

  it("does not serve one workspace's cached file to another", async () => {
    const a = freshTenant();
    const b = freshTenant();
    messages({ shared1: { tenantId: a, mediaUrl: "meta-media:50", mediaMime: "image/jpeg" } });
    asTenant(a);
    expect((await call("shared1")).status).toBe(200);
    asTenant(b);
    expect((await call("shared1")).status).toBe(404);
  });

  it("downloads once when the same file is requested in parallel", async () => {
    const t = freshTenant();
    messages({ par1: { tenantId: t, mediaUrl: "meta-media:60", mediaMime: "image/jpeg" } });
    asTenant(t);
    const results = await Promise.all([call("par1"), call("par1"), call("par1")]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(graphFetch).toHaveBeenCalledTimes(1);
  });
});

describe("robustness", () => {
  it("answers 502 when the workspace token cannot be read, without leaking the reason", async () => {
    const t = freshTenant();
    messages({ tok1: { tenantId: t, mediaUrl: "meta-media:70", mediaMime: "image/jpeg" } });
    asTenant(t);
    getAccessToken.mockRejectedValueOnce(new Error(`No valid WhatsApp access token ${SECRET}`));
    const res = await call("tok1");
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps serving a cached file that is evicted after the response was prepared", async () => {
    const t = freshTenant();
    messages({ evict1: { tenantId: t, mediaUrl: "meta-media:71", mediaMime: "image/jpeg" } });
    asTenant(t);
    expect((await call("evict1")).status).toBe(200);
    const res = await call("evict1");
    expect(res.status).toBe(200);
    // The file goes away between the response being built and its body being read.
    fs.rmSync(inboundMediaPath(t, "evict1") as string, { force: true });
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
  });

  it("closes the cached file when no body is sent (416)", async () => {
    const t = freshTenant();
    messages({ r416: { tenantId: t, mediaUrl: "meta-media:72", mediaMime: "image/jpeg" } });
    asTenant(t);
    await call("r416");
    expect((await call("r416", { range: "bytes=900-" })).status).toBe(416);
    // Nothing else can be asserted on the handle; the file must remain removable and servable.
    fs.rmSync(inboundMediaPath(t, "r416") as string, { force: true });
    expect(fs.existsSync(inboundMediaPath(t, "r416") as string)).toBe(false);
  });

  it("limits distinct downloads per workspace, queues the rest, and lets them run when a slot frees", async () => {
    const t = freshTenant();
    const ids = Array.from({ length: MAX_TENANT_DOWNLOADS + 1 }, (_, i) => `lim${i}`);
    messages(Object.fromEntries(ids.map((id, i) => [id, { tenantId: t, mediaUrl: `meta-media:8${i}`, mediaMime: "image/jpeg" }])));
    asTenant(t);
    const gates: Array<() => void> = [];
    graphFetch.mockImplementation(() => new Promise((resolve) => gates.push(() => resolve({ url: CDN, mime_type: "image/jpeg", file_size: JPEG.length }))));
    const calls = ids.map((id) => call(id));
    await vi.waitFor(() => expect(graphFetch).toHaveBeenCalledTimes(MAX_TENANT_DOWNLOADS));
    await new Promise((r) => setTimeout(r, 30));
    expect(graphFetch).toHaveBeenCalledTimes(MAX_TENANT_DOWNLOADS);
    gates[0]();
    await vi.waitFor(() => expect(graphFetch).toHaveBeenCalledTimes(MAX_TENANT_DOWNLOADS + 1));
    gates.slice(1).forEach((g) => g());
    await vi.waitFor(() => expect(gates).toHaveLength(MAX_TENANT_DOWNLOADS + 1));
    gates[MAX_TENANT_DOWNLOADS]();
    expect((await Promise.all(calls)).map((r) => r.status)).toEqual(ids.map(() => 200));
  });

  it("does not count another workspace against the limit, and releases the slot after a failure", async () => {
    const a = freshTenant();
    const b = freshTenant();
    const ids = Array.from({ length: MAX_TENANT_DOWNLOADS }, (_, i) => `fa${i}`);
    messages({
      ...Object.fromEntries(ids.map((id, i) => [id, { tenantId: a, mediaUrl: `meta-media:9${i}`, mediaMime: "image/jpeg" }])),
      other: { tenantId: b, mediaUrl: "meta-media:99", mediaMime: "image/jpeg" },
    });
    graphFetch.mockImplementation(() => new Promise(() => undefined));
    asTenant(a);
    ids.forEach((id) => void call(id));
    await vi.waitFor(() => expect(graphFetch).toHaveBeenCalledTimes(MAX_TENANT_DOWNLOADS));
    graphFetch.mockResolvedValue({ url: CDN, mime_type: "image/jpeg", file_size: JPEG.length });
    asTenant(b);
    expect((await call("other")).status).toBe(200);
  });
});

describe("disk quota", () => {
  it("evicts oldest files first, keeps the newest, and logs counts only", async () => {
    const t = freshTenant();
    const dir = inboundMediaDir(t) as string;
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now() / 1000;
    for (const [name, age] of [["old", 300], ["mid", 200], ["new", 100], ["fresh", 0]] as const) {
      fs.writeFileSync(path.join(dir, name), Buffer.alloc(1000));
      fs.utimesSync(path.join(dir, name), now - age, now - age);
    }
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const out = await evictOldest(t, "fresh", 2500);
    expect(out).toEqual({ files: 2, bytes: 2000 });
    expect(fs.readdirSync(dir).sort()).toEqual(["fresh", "new"]);
    expect(info).toHaveBeenCalledWith("[inbound-media] evicted", { tenantId: t, files: 2, bytes: 2000 });
    info.mockRestore();
  });

  it("never evicts the file just written, even when it alone exceeds the quota", async () => {
    const t = freshTenant();
    const dir = inboundMediaDir(t) as string;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "only"), Buffer.alloc(5000));
    expect(await evictOldest(t, "only", 100)).toEqual({ files: 0, bytes: 0 });
    expect(fs.existsSync(path.join(dir, "only"))).toBe(true);
  });

  it("removes abandoned partial files after an hour", async () => {
    const t = freshTenant();
    const dir = inboundMediaDir(t) as string;
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, "m1.part-1-2");
    const recent = path.join(dir, "m2.part-1-3");
    fs.writeFileSync(stale, "x");
    fs.writeFileSync(recent, "x");
    const old = Date.now() / 1000 - 2 * 3600;
    fs.utimesSync(stale, old, old);
    await evictOldest(t, "none");
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });
});

describe("copies of files agents send", () => {
  it("keeps a waiting copy per workspace, under a folder no message id can name", async () => {
    const t = freshTenant();
    expect(pendingUploadPath(t, "777")).toBe(path.resolve(dataDir, "inbound-media", t, ".pending", "777"));
    expect(pendingUploadPath(t, "../777")).toBeNull();
    expect(pendingUploadPath("../t", "777")).toBeNull();
    expect(inboundMediaPath(t, ".pending")).toBeNull();
    expect(await keepPendingUpload(t, "777", JPEG)).toBe(true);
    expect(fs.readFileSync(pendingUploadPath(t, "777") as string)).toEqual(JPEG);
    expect(await keepPendingUpload(t, "empty", Buffer.alloc(0))).toBe(false);
    expect(await keepPendingUpload(t, "big", Buffer.alloc(MAX_INBOUND_MEDIA_BYTES + 1))).toBe(false);
    expect(await keepPendingUpload(t, "a/b", JPEG)).toBe(false);
  });

  it("moves the copy to the sent message, so the chat's preview is served from disk without asking Meta", async () => {
    const t = freshTenant();
    await keepPendingUpload(t, "888", JPEG);
    expect(await adoptPendingUpload(t, "888", "sent1")).toBe(true);
    expect(fs.existsSync(pendingUploadPath(t, "888") as string)).toBe(false);
    messages({ sent1: { tenantId: t, mediaUrl: "meta-media:888", mediaMime: "image/jpeg" } });
    asTenant(t);
    const res = await call("sent1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("without a copy the preview still loads from Meta, and adopting never throws", async () => {
    const t = freshTenant();
    expect(await adoptPendingUpload(t, "nothing", "sent2")).toBe(false);
    expect(await adoptPendingUpload(t, "../x", "sent2")).toBe(false);
    messages({ sent2: { tenantId: t, mediaUrl: "meta-media:999", mediaMime: "image/jpeg" } });
    asTenant(t);
    expect((await call("sent2")).status).toBe(200);
    expect(graphFetch).toHaveBeenCalledWith({ tenantId: t, path: "999" });
  });

  it("deletes copies that were never sent after a day, and keeps the waiting folder within its own quota", async () => {
    const t = freshTenant();
    await keepPendingUpload(t, "stale", JPEG);
    await keepPendingUpload(t, "recent", JPEG);
    const dayOld = (Date.now() - PENDING_UPLOAD_TTL_MS - 60_000) / 1000;
    fs.utimesSync(pendingUploadPath(t, "stale") as string, dayOld, dayOld);
    await keepPendingUpload(t, "next", JPEG);
    const folder = path.dirname(pendingUploadPath(t, "next") as string);
    expect(fs.readdirSync(folder).sort()).toEqual(["next", "recent"]);

    // Over the quota the oldest waiting copies go first; the one just written always stays.
    expect(PENDING_UPLOAD_QUOTA_BYTES).toBeGreaterThan(MAX_INBOUND_MEDIA_BYTES);
    const minuteAgo = Date.now() / 1000 - 60;
    fs.utimesSync(pendingUploadPath(t, "recent") as string, minuteAgo - 60, minuteAgo - 60);
    fs.utimesSync(pendingUploadPath(t, "next") as string, minuteAgo, minuteAgo);
    await keepPendingUpload(t, "newest", JPEG, JPEG.length * 2);
    expect(fs.readdirSync(folder).sort()).toEqual(["newest", "next"]);
    await keepPendingUpload(t, "huge", Buffer.alloc(5000, 1), 100);
    expect(fs.readdirSync(folder)).toEqual(["huge"]);
  });

  it("never lets the waiting copies count against, or be evicted by, the chat cache", async () => {
    const t = freshTenant();
    await keepPendingUpload(t, "waiting", Buffer.alloc(5000, 1));
    const dir = inboundMediaDir(t) as string;
    fs.writeFileSync(path.join(dir, "cached"), Buffer.alloc(1000));
    expect(await evictOldest(t, "none", 1500)).toEqual({ files: 0, bytes: 0 });
    expect(fs.existsSync(pendingUploadPath(t, "waiting") as string)).toBe(true);
    expect(fs.existsSync(path.join(dir, "cached"))).toBe(true);
  });

  const ageOverADay = (file: string) => {
    const dayOld = (Date.now() - PENDING_UPLOAD_TTL_MS - 60_000) / 1000;
    fs.utimesSync(file, dayOld, dayOld);
  };

  it("deletes a day-old unsent copy when a media preview is saved, without another upload", async () => {
    const t = freshTenant();
    await keepPendingUpload(t, "forgotten", JPEG);
    await keepPendingUpload(t, "today", JPEG);
    ageOverADay(pendingUploadPath(t, "forgotten") as string);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    messages({ in1: { tenantId: t, mediaUrl: "meta-media:555", mediaMime: "image/jpeg" } });
    asTenant(t);
    expect((await call("in1")).status).toBe(200);
    expect(fs.existsSync(pendingUploadPath(t, "forgotten") as string)).toBe(false);
    expect(fs.existsSync(pendingUploadPath(t, "today") as string)).toBe(true);
    expect(info).toHaveBeenCalledWith("[inbound-media] removed unsent copies", { tenantId: t, files: 1, bytes: JPEG.length });
    info.mockRestore();
  });

  it("deletes a day-old unsent copy when another sent file's copy moves into the cache", async () => {
    const t = freshTenant();
    await keepPendingUpload(t, "forgotten", JPEG);
    await keepPendingUpload(t, "sending", JPEG);
    ageOverADay(pendingUploadPath(t, "forgotten") as string);
    expect(await adoptPendingUpload(t, "sending", "sent3")).toBe(true);
    expect(fs.readdirSync(path.dirname(pendingUploadPath(t, "x") as string))).toEqual([]);
    expect(fs.existsSync(inboundMediaPath(t, "sent3") as string)).toBe(true);
  });

  it("sweeps every workspace's day-old unsent copies, keeping recent ones and ignoring anything that is not a workspace folder", async () => {
    const saved = process.env.DATA_DIR;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pending-sweep-"));
    process.env.DATA_DIR = root;
    try {
      expect(await sweepPendingUploads()).toEqual({ tenants: 0, files: 0, bytes: 0 });
      await keepPendingUpload("ta", "old", JPEG);
      await keepPendingUpload("ta", "new", JPEG);
      await keepPendingUpload("tb", "old", Buffer.alloc(100, 1));
      fs.mkdirSync(inboundMediaDir("tc") as string, { recursive: true });
      fs.writeFileSync(path.join(root, "inbound-media", "stray-file"), "x");
      fs.mkdirSync(path.join(root, "inbound-media", "not.a.tenant", ".pending"), { recursive: true });
      const notTenant = path.join(root, "inbound-media", "not.a.tenant", ".pending", "old");
      fs.writeFileSync(notTenant, "x");
      for (const file of [pendingUploadPath("ta", "old"), pendingUploadPath("tb", "old"), notTenant]) ageOverADay(file as string);

      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      expect(await sweepPendingUploads()).toEqual({ tenants: 3, files: 2, bytes: JPEG.length + 100 });
      info.mockRestore();
      expect(fs.existsSync(pendingUploadPath("ta", "old") as string)).toBe(false);
      expect(fs.existsSync(pendingUploadPath("tb", "old") as string)).toBe(false);
      expect(fs.existsSync(pendingUploadPath("ta", "new") as string)).toBe(true);
      expect(fs.existsSync(notTenant)).toBe(true);
      expect(fs.existsSync(path.join(root, "inbound-media", "stray-file"))).toBe(true);

      // A later run (the daily job passes its clock) catches what has aged since.
      expect((await sweepPendingUploads(Date.now() + PENDING_UPLOAD_TTL_MS + 60_000)).files).toBe(1);
      expect(fs.existsSync(pendingUploadPath("ta", "new") as string)).toBe(false);
    } finally {
      process.env.DATA_DIR = saved;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
