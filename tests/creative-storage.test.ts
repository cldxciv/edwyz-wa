import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { localStorage, resolveSafe } from "@/lib/creative/storage";
import { getImageProvider, getVideoProvider, placeholderProvider, renderPlaceholderSvg } from "@/lib/creative/providers";
import { signedAssetUrl, verifySignedAsset } from "@/lib/creative/signed";

let dir: string;
const prev = process.env.DATA_DIR;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "creative-"));
  process.env.DATA_DIR = dir;
  process.env.CREATIVE_MEDIA_SECRET = "9f3a6c1e8b2d47f05a7e9c3b1d6f4a82c5e0b7391d8a6f2e4c7b0a9d3e5f1862";
});
afterAll(() => {
  process.env.DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("path traversal", () => {
  const root = path.resolve("/data/creative");
  it.each(["../x.svg", "..\\x.svg", "a/b.svg", "/etc/passwd", "x.svg\0", "%2e%2e.svg", "", ".svg", "a b.svg"])("rejects key %j", (key) => {
    expect(() => resolveSafe("t1", key, root)).toThrow();
  });
  it.each(["..", "a/b", "../t2", "", "t 1", "t1/.."])("rejects tenant %j", (tenant) => {
    expect(() => resolveSafe(tenant, "a.svg", root)).toThrow();
  });
  it("accepts a plain key inside the tenant folder", () => {
    expect(resolveSafe("t1", "abc123.svg", root)).toBe(path.join(root, "t1", "abc123.svg"));
  });
});

describe("local storage", () => {
  it("round-trips and isolates tenants", async () => {
    await localStorage.put("t1", "a1.svg", Buffer.from("hello"));
    expect((await localStorage.get("t1", "a1.svg")).toString()).toBe("hello");
    await expect(localStorage.get("t2", "a1.svg")).rejects.toMatchObject({ status: 404 });
    await localStorage.remove("t1", "a1.svg");
    await expect(localStorage.get("t1", "a1.svg")).rejects.toMatchObject({ status: 404 });
  });
  it("refuses traversal on put and get", async () => {
    await expect(localStorage.put("t1", "../evil.svg", Buffer.from("x"))).rejects.toMatchObject({ status: 400 });
    await expect(localStorage.get("t1", "../../etc.svg")).rejects.toMatchObject({ status: 400 });
  });
});

describe("creative storage quota (P3-15)", () => {
  afterEach(() => {
    delete process.env.CREATIVE_MEDIA_QUOTA_MB;
    delete process.env.CREATIVE_MEDIA_MAX_FILES;
  });

  it("refuses a put that would pass the workspace quota, per tenant, and frees room on remove", async () => {
    process.env.CREATIVE_MEDIA_QUOTA_MB = "0.01";
    await localStorage.put("q1", "a1.svg", Buffer.alloc(3000));
    await localStorage.put("q1", "a2.svg", Buffer.alloc(3000));
    await expect(localStorage.put("q1", "a3.svg", Buffer.alloc(3000))).rejects.toMatchObject({ status: 413 });
    await expect(localStorage.put("q2", "a1.svg", Buffer.alloc(3000))).resolves.toBe("a1.svg");
    await localStorage.remove("q1", "a1.svg");
    await expect(localStorage.put("q1", "a3.svg", Buffer.alloc(3000))).resolves.toBe("a3.svg");
  });

  it("lets a file be replaced under its own key and counts tiny files by block", async () => {
    process.env.CREATIVE_MEDIA_QUOTA_MB = "0.02";
    await localStorage.put("q3", "same.svg", Buffer.alloc(9000));
    await expect(localStorage.put("q3", "same.svg", Buffer.alloc(9500))).resolves.toBe("same.svg");
    process.env.CREATIVE_MEDIA_MAX_FILES = "2";
    await localStorage.put("q4", "t1.svg", Buffer.from("x"));
    await localStorage.put("q4", "t2.svg", Buffer.from("x"));
    await expect(localStorage.put("q4", "t3.svg", Buffer.from("x"))).rejects.toMatchObject({ status: 413 });
  });

  it("parallel puts cannot overshoot the quota", async () => {
    process.env.CREATIVE_MEDIA_QUOTA_MB = "0.02";
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => localStorage.put("q5", `p${i}.svg`, Buffer.alloc(4000))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
  });
});

describe("providers", () => {
  const req = { brandName: "Acme <b>", colors: ["#112233", "#ffffff", "javascript:alert(1)"], headline: 'Big "sale" <script>alert(1)</script> & more', placement: "feed" as const };
  it("renders a safe branded SVG", async () => {
    const svg = renderPlaceholderSvg(req);
    expect(svg).toContain('fill="#112233"');
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("javascript:");
    expect(svg).toContain("&lt;b&gt;");
    const file = await placeholderProvider.generate(req);
    expect(file.contentType).toBe("image/svg+xml");
  });
  it("falls back to default colours when none are valid hex", () => {
    expect(renderPlaceholderSvg({ ...req, colors: ["red"] })).toContain("#1f2a44");
  });
  it("selects providers by env and reports unimplemented slots", () => {
    expect(getImageProvider().name).toBe("placeholder");
    expect(() => getImageProvider("midjourney")).toThrow(/not implemented/);
    expect(() => getVideoProvider()).toThrow(/not available/);
  });
});

describe("signed asset urls", () => {
  const parts = (url: string) => {
    const u = new URL(url);
    const [, , , , tenantId, assetId] = u.pathname.split("/");
    return { tenantId, assetId, exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig") };
  };
  it("produces an https url that verifies", () => {
    const url = signedAssetUrl("t1", "a1", 60);
    expect(url.startsWith("https://")).toBe(true);
    const p = parts(url);
    expect(() => verifySignedAsset(p.tenantId, p.assetId, p.exp, p.sig)).not.toThrow();
  });
  it("rejects tampering with tenant, asset, expiry or signature", () => {
    const p = parts(signedAssetUrl("t1", "a1", 60));
    expect(() => verifySignedAsset("t2", p.assetId, p.exp, p.sig)).toThrow();
    expect(() => verifySignedAsset(p.tenantId, "a2", p.exp, p.sig)).toThrow();
    expect(() => verifySignedAsset(p.tenantId, p.assetId, String(Number(p.exp) + 1000), p.sig)).toThrow();
    expect(() => verifySignedAsset(p.tenantId, p.assetId, p.exp, "0".repeat(64))).toThrow();
    expect(() => verifySignedAsset(p.tenantId, p.assetId, p.exp, null)).toThrow();
  });
  it("rejects expired links and traversal ids", () => {
    const p = parts(signedAssetUrl("t1", "a1", 60, Date.now() - 3_600_000));
    expect(() => verifySignedAsset(p.tenantId, p.assetId, p.exp, p.sig)).toThrow(/expired/);
    expect(() => signedAssetUrl("../t1", "a1")).toThrow();
  });
});
