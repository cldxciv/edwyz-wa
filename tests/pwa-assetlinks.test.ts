import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/.well-known/assetlinks.json/route";
import { assetLinks, assetLinksResponse } from "@/lib/android/asset-links";
import { androidPackage, assetLinkFingerprints, checkEnv } from "@/lib/env-rules.mjs";

/**
 * docs/PLAY-STORE.md: /.well-known/assetlinks.json lets the Android app (com.edwyz.wa) open the site without a browser bar. It is
 * built only from real fingerprints in ANDROID_ASSETLINKS_SHA256; with none, or with only malformed or placeholder ones, it is a 404.
 */

const ROOT = path.resolve(__dirname, "..");
const fingerprint = () => [...randomBytes(32)].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
const GOOGLE_DOCS_SAMPLE = "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5";

afterEach(() => vi.unstubAllEnvs());

describe("GET /.well-known/assetlinks.json", () => {
  it("answers 404 with nothing to cache when no fingerprint is configured", async () => {
    vi.stubEnv("ANDROID_ASSETLINKS_SHA256", "");
    vi.stubEnv("ANDROID_PACKAGE", "");
    const res = GET();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  it("serves the statement for com.edwyz.wa with one fingerprint, as JSON cached for a few minutes", async () => {
    const one = fingerprint();
    vi.stubEnv("ANDROID_ASSETLINKS_SHA256", one);
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.json()).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: "com.edwyz.wa", sha256_cert_fingerprints: [one] },
      },
    ]);
  });

  it("lists both the upload key and Play's app signing key, in order, upper-cased and without duplicates", async () => {
    const upload = fingerprint();
    const play = fingerprint();
    vi.stubEnv("ANDROID_ASSETLINKS_SHA256", ` ${upload.toLowerCase()} ,${play},${upload}, `);
    const body = await GET().json();
    expect(body).toHaveLength(1);
    expect(body[0].target.sha256_cert_fingerprints).toEqual([upload, play]);
  });

  it("ignores malformed and placeholder fingerprints and keeps the valid ones", async () => {
    const good = fingerprint();
    const bad = [
      "AB:CD",
      "not-a-fingerprint",
      good.replace(/:/g, ""), // right bytes, no colons
      `${good}:01`, // 33 bytes
      good.replace(/:/g, "-"),
      good.slice(0, -2) + "ZZ",
      Array(32).fill("00").join(":"),
      Array(32).fill("AA").join(":"),
      GOOGLE_DOCS_SAMPLE,
    ];
    vi.stubEnv("ANDROID_ASSETLINKS_SHA256", [...bad, good].join(","));
    const body = await GET().json();
    expect(body[0].target.sha256_cert_fingerprints).toEqual([good]);
  });

  it("answers 404 when every configured fingerprint is malformed or a placeholder", () => {
    vi.stubEnv("ANDROID_ASSETLINKS_SHA256", `AB:CD,${GOOGLE_DOCS_SAMPLE},${Array(32).fill("FF").join(":")}`);
    expect(GET().status).toBe(404);
  });

  it("uses ANDROID_PACKAGE when it is a package name, and serves nothing when it is not", async () => {
    const one = fingerprint();
    expect(assetLinks({ ANDROID_ASSETLINKS_SHA256: one, ANDROID_PACKAGE: " com.edwyz.wa.beta " })![0].target.package_name).toBe("com.edwyz.wa.beta");
    for (const bad of ["edwyz", "com..edwyz", "1com.edwyz", "com.edwyz.wa/../x", "com.edwyz wa"]) {
      expect(assetLinks({ ANDROID_ASSETLINKS_SHA256: one, ANDROID_PACKAGE: bad }), bad).toBeNull();
      expect(assetLinksResponse({ ANDROID_ASSETLINKS_SHA256: one, ANDROID_PACKAGE: bad }).status).toBe(404);
    }
  });
});

describe("the shared rules in env-rules.mjs", () => {
  it("parse fingerprints into valid ones and a count of ignored ones", () => {
    const a = fingerprint();
    expect(assetLinkFingerprints(undefined)).toEqual({ valid: [], invalid: 0 });
    expect(assetLinkFingerprints(" , ,")).toEqual({ valid: [], invalid: 0 });
    expect(assetLinkFingerprints(`${a},junk,${a}`)).toEqual({ valid: [a], invalid: 1 });
  });

  it("default the package to com.edwyz.wa", () => {
    expect(androidPackage({})).toBe("com.edwyz.wa");
    expect(androidPackage({ ANDROID_PACKAGE: "  " })).toBe("com.edwyz.wa");
    expect(androidPackage({ ANDROID_PACKAGE: "bad name" })).toBeNull();
  });
});

describe("startup check (env-rules)", () => {
  const base = () => ({
    DATABASE_URL: "postgresql://edwyz_wa_app:pw@127.0.0.1:5432/edwyz_wa",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    WORKER_SECRET: randomBytes(24).toString("hex"),
    STATE_SECRET: randomBytes(24).toString("hex"),
    SITE_URL: "https://wa.edwyz.com",
    META_APP_SECRET: "app-secret-value",
    META_APP_ID: "1799953191201553",
    META_VERIFY_TOKEN: randomBytes(12).toString("hex"),
    META_ES_CONFIG_ID: "123",
    PLATFORM_ADMIN_EMAILS: "owner@example.com",
  });
  const android = (env: Record<string, string>) => checkEnv({ ...base(), ...env }).warnings.filter((w) => w.startsWith("ANDROID_"));

  it("treats both variables as optional: nothing to say when they are unset or valid", () => {
    expect(android({})).toEqual([]);
    expect(android({ ANDROID_PACKAGE: "com.edwyz.wa", ANDROID_ASSETLINKS_SHA256: `${fingerprint()},${fingerprint()}` })).toEqual([]);
    expect(checkEnv({ ...base(), ANDROID_ASSETLINKS_SHA256: fingerprint() }).errors).toEqual([]);
  });

  it("warns about malformed fingerprints by count, never echoing a value", () => {
    const good = fingerprint();
    const [warning] = android({ ANDROID_ASSETLINKS_SHA256: `${good},12:34:56,${GOOGLE_DOCS_SAMPLE}` });
    expect(warning).toMatch(/^ANDROID_ASSETLINKS_SHA256 has 2 malformed or placeholder fingerprint\(s\)/);
    for (const value of ["12:34:56", good, GOOGLE_DOCS_SAMPLE]) expect(warning).not.toContain(value);
    expect(warning).not.toContain("404");
    expect(android({ ANDROID_ASSETLINKS_SHA256: "AB:CD" })[0]).toContain("answers 404");
  });

  it("warns about a package name that is not one", () => {
    expect(android({ ANDROID_PACKAGE: "edwyz wa" })).toEqual([
      "ANDROID_PACKAGE is not an Android package name such as com.edwyz.wa; /.well-known/assetlinks.json answers 404 until it is",
    ]);
  });
});

describe("nginx (deploy/nginx-wa.edwyz.com.conf)", () => {
  const config = readFileSync(path.join(ROOT, "deploy/nginx-wa.edwyz.com.conf"), "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  const servers = config.split(/^server\s*\{/m).slice(1);
  const https = servers.find((s) => /listen 443 ssl/.test(s))!;
  const http = servers.find((s) => /listen 80;/.test(s))!;

  it("passes /.well-known/assetlinks.json to the app over https: no location there intercepts /.well-known", () => {
    expect(https).toBeDefined();
    expect(https).not.toContain(".well-known");
    expect(https).toMatch(/location \/ \{[^}]*proxy_pass http:\/\/127\.0\.0\.1:3500;/);
  });

  it("keeps certbot's challenge path on port 80", () => {
    expect(http).toMatch(/location \/\.well-known\/acme-challenge\/ \{\s*root \/var\/www\/certbot-webroot;\s*\}/);
  });
});
