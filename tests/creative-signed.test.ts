import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({ readAssetFile: vi.fn(async () => ({ data: Buffer.from("x"), contentType: "image/png" })) }));
vi.mock("@/lib/creative/service", () => svc);
import { GET as publicRoute } from "@/app/api/creative/public/[tenantId]/[assetId]/route";
import { MAX_TTL_SECONDS, signedAssetUrl, verifySignedAsset } from "@/lib/creative/signed";
import { hasEnoughEntropy } from "@/lib/creative/secret";

const GOOD = "9f3a6c1e8b2d47f05a7e9c3b1d6f4a82c5e0b7391d8a6f2e4c7b0a9d3e5f1862";
const parts = (url: string) => {
  const u = new URL(url);
  const [, , , , tenantId, assetId] = u.pathname.split("/");
  return { tenantId, assetId, exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig") };
};
const saved = { c: process.env.CREATIVE_MEDIA_SECRET, s: process.env.STATE_SECRET };

beforeEach(() => {
  process.env.CREATIVE_MEDIA_SECRET = GOOD;
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (saved.c === undefined) delete process.env.CREATIVE_MEDIA_SECRET;
  else process.env.CREATIVE_MEDIA_SECRET = saved.c;
  if (saved.s === undefined) delete process.env.STATE_SECRET;
  else process.env.STATE_SECRET = saved.s;
});

describe("creative signing secret (P3-25)", () => {
  it("never falls back to STATE_SECRET in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.CREATIVE_MEDIA_SECRET;
    process.env.STATE_SECRET = GOOD;
    expect(() => signedAssetUrl("t1", "a1")).toThrow(/CREATIVE_MEDIA_SECRET is not configured/);
    expect(() => verifySignedAsset("t1", "a1", "9999999999", "0".repeat(64))).toThrow(/CREATIVE_MEDIA_SECRET/);
  });

  it("allows the STATE_SECRET fallback outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.CREATIVE_MEDIA_SECRET;
    process.env.STATE_SECRET = GOOD;
    expect(() => signedAssetUrl("t1", "a1")).not.toThrow();
  });

  it("requires 32 bytes of entropy", () => {
    expect(hasEnoughEntropy(GOOD)).toBe(true);
    expect(hasEnoughEntropy("Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWpr")).toBe(true);
    for (const weak of ["", "test-secret", "a".repeat(64), "ab".repeat(32), "0123456789abcdef".repeat(2), "x".repeat(20)]) expect(hasEnoughEntropy(weak)).toBe(false);
    process.env.CREATIVE_MEDIA_SECRET = "test-secret";
    expect(() => signedAssetUrl("t1", "a1")).toThrow(/too weak/);
  });
});

describe("verifySignedAsset lifetime (P3-25)", () => {
  it("accepts a link at the 7 day cap and rejects a correctly signed link beyond it", () => {
    const now = Date.now();
    const ok = parts(signedAssetUrl("t1", "a1", MAX_TTL_SECONDS * 10, now));
    expect(() => verifySignedAsset(ok.tenantId, ok.assetId, ok.exp, ok.sig, now)).not.toThrow();

    // A link minted by older code (or leaked signing logic) with a far-future exp: validly signed, still refused.
    const exp = Math.floor(now / 1000) + MAX_TTL_SECONDS + 3600;
    const far = parts(signedAssetUrl("t1", "a1", 60, (exp - 60) * 1000));
    expect(Number(far.exp)).toBe(exp);
    expect(() => verifySignedAsset(far.tenantId, far.assetId, far.exp, far.sig, now)).toThrow(/Invalid link/);
  });
});

describe("public creative route and deployment errors (P3-25)", () => {
  const call = (url: string) => publicRoute(new Request(url), { params: Promise.resolve({ tenantId: "t1", assetId: "a1" }) });

  it("answers 404, without naming the missing setting, when the signing secret is not configured in production", async () => {
    const link = signedAssetUrl("t1", "a1", 60);
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.CREATIVE_MEDIA_SECRET;
    process.env.STATE_SECRET = GOOD;
    const res = await call(link);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toMatch(/CREATIVE_MEDIA_SECRET|openssl|configured/i);
    expect(svc.readAssetFile).not.toHaveBeenCalled();
  });

  it("answers 404 for a weak secret too, and serves a valid link when the secret is good", async () => {
    const link = signedAssetUrl("t1", "a1", 60);
    process.env.CREATIVE_MEDIA_SECRET = "test-secret";
    expect((await call(link)).status).toBe(404);
    process.env.CREATIVE_MEDIA_SECRET = GOOD;
    expect((await call(link)).status).toBe(200);
    expect((await call(link.replace(/sig=[0-9a-f]+/, `sig=${"0".repeat(64)}`))).status).toBe(403);
  });
});
