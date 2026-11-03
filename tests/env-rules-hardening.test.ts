import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkEnv, decodedSecretBytes } from "@/lib/env-rules.mjs";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  SESSION_SECRET: "s".repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  WORKER_SECRET: "w".repeat(20),
  STATE_SECRET: "t".repeat(40),
};

describe("media secrets in production", () => {
  it("counts bytes for hex and base64", () => {
    expect(decodedSecretBytes("ab".repeat(32))).toBe(32);
    expect(decodedSecretBytes(Buffer.alloc(32, 1).toString("base64"))).toBe(32);
    expect(decodedSecretBytes("short")).toBeLessThan(32);
    expect(decodedSecretBytes("not valid!")).toBe(0);
  });
  it("is an error when unset or short, naming the variable", () => {
    const errors: string[] = checkEnv({ ...base, NODE_ENV: "production", CONTENT_MEDIA_SECRET: "tooshort" }).errors;
    expect(errors.some((e) => e.startsWith("CREATIVE_MEDIA_SECRET is not set"))).toBe(true);
    expect(errors.some((e) => e.startsWith("CONTENT_MEDIA_SECRET must be"))).toBe(true);
  });
  it("passes with good secrets and is not required outside production", () => {
    const good = { ...base, NODE_ENV: "production", CONTENT_MEDIA_SECRET: "ab".repeat(32), CREATIVE_MEDIA_SECRET: "cd".repeat(32) };
    expect(checkEnv(good).errors).toEqual([]);
    expect(checkEnv({ ...base, NODE_ENV: "development" }).errors).toEqual([]);
  });
});

describe("STATE_SECRET length", () => {
  it("needs 32 characters in production, matching the 503 in meta-connect/state.ts", () => {
    const prod = { ...base, NODE_ENV: "production", CONTENT_MEDIA_SECRET: "ab".repeat(32), CREATIVE_MEDIA_SECRET: "cd".repeat(32) };
    expect(checkEnv({ ...prod, STATE_SECRET: "t".repeat(31) }).errors).toContain("STATE_SECRET must be at least 32 characters");
    expect(checkEnv({ ...prod, STATE_SECRET: "t".repeat(20) }).errors).toContain("STATE_SECRET must be at least 32 characters");
    expect(checkEnv({ ...prod, STATE_SECRET: "t".repeat(32) }).errors).toEqual([]);
  });
  it("still accepts 16 characters outside production", () => {
    expect(checkEnv({ ...base, STATE_SECRET: "t".repeat(16) }).errors).toEqual([]);
    expect(checkEnv({ ...base, STATE_SECRET: "t".repeat(15) }).errors).toContain("STATE_SECRET must be at least 16 characters");
  });
});

describe("instance count warning", () => {
  it("warns above one instance only", () => {
    const warns = (v: string): string[] => checkEnv({ ...base, WEB_INSTANCES: v }).warnings;
    expect(warns("2").some((w) => w.includes("exactly one"))).toBe(true);
    expect(warns("1").some((w) => w.includes("exactly one"))).toBe(false);
  });

  it("names the state that is still per process, not the rate limits, which are shared through Postgres now", () => {
    const [warning] = checkEnv({ ...base, WEB_CONCURRENCY: "3" }).warnings.filter((w: string) => w.includes("exactly one"));
    expect(warning).toContain("replay guards, the live inbox connection count and the AI reply guard");
    expect(warning).not.toMatch(/rate limit/i);
  });

  it("check-env's pm2 instance warning no longer waits for a shared rate limiter that already exists", () => {
    const script = readFileSync(path.join(__dirname, "..", "scripts/check-env.mjs"), "utf8");
    expect(script).not.toContain("until the shared rate limiter exists");
    expect(script).toContain("run the web app as a single instance");
  });
});
