import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildProviderBody, createHttpImageProvider, sniffImage, MAX_IMAGE_BYTES, type HttpImageRequest, type HttpImageResponse } from "@/lib/creative/http-image";
import { getImageProvider, placeholderProvider } from "@/lib/creative/providers";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(20)]);
const env = { CREATIVE_IMAGE_URL: "https://images.example.com/v1/generate", CREATIVE_IMAGE_KEY: "sekret-key" } as unknown as NodeJS.ProcessEnv;
const publicDns = async () => ["93.184.216.34"];
const req = { brandName: "Acme", colors: ["#112233", "nope"], headline: "Free check-up", placement: "feed" as const, prompt: "smiling family" };

const json = (body: unknown, status = 200): HttpImageResponse => ({ status, contentType: "application/json", body: Buffer.from(JSON.stringify(body)), truncated: false });
const provider = (transport: (r: HttpImageRequest) => Promise<HttpImageResponse>, e: NodeJS.ProcessEnv = env) =>
  createHttpImageProvider({ transport, resolve: publicDns, env: e, fallback: placeholderProvider });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("http image provider", () => {
  it("posts the documented JSON with a bearer key and returns the decoded image", async () => {
    const transport = vi.fn(async (_r: HttpImageRequest) => json({ image_base64: PNG.toString("base64") }));
    const file = await provider(transport).generate(req);
    expect(file).toMatchObject({ contentType: "image/png", ext: "png" });
    expect(file.fallback).toBeUndefined();
    expect(file.data.equals(PNG)).toBe(true);
    const call = transport.mock.calls[0]![0];
    expect(call.method).toBe("POST");
    expect(call.url.href).toBe(env.CREATIVE_IMAGE_URL);
    expect(call.address).toBe("93.184.216.34");
    expect(call.headers.authorization).toBe("Bearer sekret-key");
    expect(call.maxBytes).toBeGreaterThan(MAX_IMAGE_BYTES);
    expect(JSON.parse(call.body!)).toEqual({
      prompt: 'Advertising image for "Acme". smiling family',
      headline: "Free check-up",
      brand: { name: "Acme", colors: ["#112233"] },
      placement: "feed",
      width: 1080,
      height: 1350,
    });
  });

  it("sends nothing about tenants or people", () => {
    const body = JSON.stringify(buildProviderBody(req));
    expect(body).not.toMatch(/tenant|user|email|phone/i);
  });

  it("fetches an image_url with the same safety rules", async () => {
    const calls: HttpImageRequest[] = [];
    const transport = async (r: HttpImageRequest) => {
      calls.push(r);
      return r.method === "POST" ? json({ image_url: "https://cdn.example.com/out/a.png" }) : { status: 200, contentType: "image/png", body: JPG, truncated: false };
    };
    const file = await provider(transport).generate(req);
    expect(file).toMatchObject({ contentType: "image/jpeg", ext: "jpg" });
    expect(calls[1]).toMatchObject({ method: "GET", maxBytes: MAX_IMAGE_BYTES });
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  it("reads the real type from the bytes, not from the service", () => {
    expect(sniffImage(PNG)?.ext).toBe("png");
    expect(sniffImage(JPG)?.ext).toBe("jpg");
    expect(sniffImage(WEBP)?.ext).toBe("webp");
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"))).toBeNull();
    expect(sniffImage(Buffer.from("<html></html>"))).toBeNull();
  });

  it.each([
    ["an error status", () => json({ error: "no" }, 500)],
    ["a truncated (oversize) answer", () => ({ ...json({ image_base64: PNG.toString("base64") }), truncated: true })],
    ["something that is not an image", () => json({ image_base64: Buffer.from("<svg onload=alert(1)>").toString("base64") })],
    ["malformed base64", () => json({ image_base64: "!!!not base64!!!" })],
    ["an empty answer", () => json({})],
    ["a non-JSON body", () => ({ status: 200, contentType: "text/html", body: Buffer.from("<html>"), truncated: false })],
  ])("falls back to the placeholder on %s and marks the file as free", async (_name, answer) => {
    const file = await provider(async () => answer()).generate(req);
    expect(file.fallback).toBe(true);
    expect(file.contentType).toBe("image/svg+xml");
  });

  it("falls back when the service cannot be reached", async () => {
    const file = await provider(async () => {
      throw new Error("ECONNRESET");
    }).generate(req);
    expect(file.fallback).toBe(true);
  });

  it("falls back when the link in the answer is oversize or points at a private address", async () => {
    const big = await provider(async (r) => (r.method === "POST" ? json({ image_url: "https://cdn.example.com/a.png" }) : { status: 200, contentType: "image/png", body: PNG, truncated: true })).generate(req);
    expect(big.fallback).toBe(true);
    const transport = vi.fn(async (r: HttpImageRequest) => (r.method === "POST" ? json({ image_url: "https://169.254.169.254/latest/meta-data" }) : json({})));
    const internal = await provider(transport).generate(req);
    expect(internal.fallback).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("refuses to call a configured URL that resolves to a private address", async () => {
    const transport = vi.fn(async () => json({ image_base64: PNG.toString("base64") }));
    const p = createHttpImageProvider({ transport, resolve: async () => ["10.0.0.5"], env, fallback: placeholderProvider });
    expect((await p.generate(req)).fallback).toBe(true);
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses non-https and internal-name URLs", async () => {
    for (const url of ["http://images.example.com/x", "https://localhost/x", "https://user:pw@images.example.com/x", "https://images.example.com:8080/x"]) {
      const transport = vi.fn(async () => json({ image_base64: PNG.toString("base64") }));
      const file = await provider(transport, { ...env, CREATIVE_IMAGE_URL: url } as NodeJS.ProcessEnv).generate(req);
      expect(file.fallback).toBe(true);
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it("falls back, without calling out, when it is not configured", async () => {
    const transport = vi.fn();
    expect((await provider(transport, {} as unknown as NodeJS.ProcessEnv).generate(req)).fallback).toBe(true);
    expect((await provider(transport, { CREATIVE_IMAGE_URL: env.CREATIVE_IMAGE_URL } as unknown as NodeJS.ProcessEnv).generate(req)).fallback).toBe(true);
    expect(transport).not.toHaveBeenCalled();
  });

  it("never logs the key", async () => {
    const spy = vi.spyOn(console, "error");
    await provider(async () => json({}, 401)).generate(req);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("sekret-key");
  });

  it("is selectable as http and is metered", () => {
    const p = getImageProvider("http");
    expect(p).toMatchObject({ name: "http", metered: true });
  });
});
