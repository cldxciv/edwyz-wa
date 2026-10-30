import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkEnv, logStartupReport } from "@/lib/env";
import { setLogSink } from "@/lib/log";

const valid = () => ({
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

afterEach(() => setLogSink(null));

describe("env validator", () => {
  it("accepts a complete environment", () => {
    const report = checkEnv(valid());
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("reports every missing required variable by name", () => {
    const report = checkEnv({});
    for (const name of ["DATABASE_URL", "SESSION_SECRET", "ENCRYPTION_KEY", "WORKER_SECRET", "STATE_SECRET"]) {
      expect(report.errors.some((e) => e.startsWith(name))).toBe(true);
    }
  });

  it("rejects a short SESSION_SECRET", () => {
    const report = checkEnv({ ...valid(), SESSION_SECRET: "short" });
    expect(report.errors).toContain("SESSION_SECRET must be at least 32 characters");
  });

  it("requires ENCRYPTION_KEY to be 32 bytes of base64", () => {
    for (const bad of [randomBytes(16).toString("base64"), randomBytes(48).toString("base64"), "not base64 !!", randomBytes(32).toString("hex") + "zz"]) {
      expect(checkEnv({ ...valid(), ENCRYPTION_KEY: bad }).errors.some((e) => e.startsWith("ENCRYPTION_KEY"))).toBe(true);
    }
    expect(checkEnv({ ...valid(), ENCRYPTION_KEY: randomBytes(32).toString("base64") }).errors).toEqual([]);
  });

  it("rejects malformed database URLs", () => {
    expect(checkEnv({ ...valid(), DATABASE_URL: "mysql://u:p@h/db" }).errors).toContain("DATABASE_URL must start with postgres:// or postgresql://");
    expect(checkEnv({ ...valid(), DATABASE_URL: "not a url" }).errors).toContain("DATABASE_URL is not a valid URL");
    expect(checkEnv({ ...valid(), DATABASE_URL: "postgresql://u:p@host" }).errors).toContain("DATABASE_URL has no database name");
  });

  it("warns, but does not fail, when META_APP_SECRET is empty", () => {
    const report = checkEnv({ ...valid(), META_APP_SECRET: "" });
    expect(report.errors).toEqual([]);
    expect(report.warnings.some((w) => w.startsWith("META_APP_SECRET"))).toBe(true);
  });

  it("flags placeholders, shared secrets and a bad CSP_MODE", () => {
    const base = valid();
    expect(checkEnv({ ...base, STATE_SECRET: "changeme-changeme-changeme" }).errors).toContain("STATE_SECRET looks like a placeholder");
    expect(checkEnv({ ...base, STATE_SECRET: base.SESSION_SECRET }).warnings.some((w) => w.includes("share a value"))).toBe(true);
    expect(checkEnv({ ...base, CSP_MODE: "block" }).errors).toContain("CSP_MODE must be report-only or enforce");
    expect(checkEnv({ ...base, CSP_MODE: "enforce" }).errors).toEqual([]);
  });

  it("in production, warns while the nonce CSP only reports and when SITE_URL points at localhost", () => {
    const prod = { ...valid(), NODE_ENV: "production", CREATIVE_MEDIA_SECRET: randomBytes(32).toString("hex"), CONTENT_MEDIA_SECRET: randomBytes(32).toString("hex") };
    const reportOnly = checkEnv(prod);
    expect(reportOnly.errors).toEqual([]);
    expect(reportOnly.warnings.filter((w) => w.startsWith("CSP_MODE"))).toHaveLength(1);
    expect(checkEnv({ ...prod, CSP_MODE: "report-only" }).warnings.some((w) => w.startsWith("CSP_MODE"))).toBe(true);
    expect(checkEnv({ ...prod, CSP_MODE: "enforce" }).warnings).toEqual([]);
    expect(checkEnv({ ...valid(), CSP_MODE: "report-only" }).warnings).toEqual([]); // not production: no nagging

    const local = checkEnv({ ...prod, CSP_MODE: "enforce", SITE_URL: "http://localhost:3500" });
    expect(local.errors).toEqual([]);
    expect(local.warnings.some((w) => w.startsWith("SITE_URL points at localhost"))).toBe(true);
    expect(checkEnv({ ...valid(), SITE_URL: "http://localhost:3500" }).warnings).toEqual([]);
  });

  it("lists optional features that are off, and notes partial Razorpay setup", () => {
    const off = checkEnv(valid()).disabled.join("|");
    for (const name of ["ANTHROPIC_API_KEY", "RAZORPAY_KEY_ID", "SMTP_HOST", "META_LOGIN_CONFIG_ID"]) expect(off).toContain(name);

    const on = checkEnv({
      ...valid(), ANTHROPIC_API_KEY: "k", RAZORPAY_KEY_ID: "id", RAZORPAY_KEY_SECRET: "s", SMTP_HOST: "h", SMTP_USER: "u",
      META_LOGIN_CONFIG_ID: "1",
    });
    expect(on.disabled).toEqual([]);
    expect(on.warnings.some((w) => w.startsWith("RAZORPAY_WEBHOOK_SECRET"))).toBe(true);
  });

  it("names Eddy among the AI features a missing key turns off, and drops the stale optimizer label (Eddy 7.10)", () => {
    const ai = checkEnv(valid()).disabled.find((d) => d.includes("ANTHROPIC_API_KEY"));
    expect(ai).toBe("AI assistant, Eddy and creative copy (ANTHROPIC_API_KEY)");
    expect(ai).not.toContain("optimizer drafts");
  });

  it("never echoes a value in any message", () => {
    const env = { ...valid(), SESSION_SECRET: "tiny-secret-9f3", DATABASE_URL: "mysql://user:hunter2@h/db", ENCRYPTION_KEY: "bad-key-value-77", CSP_MODE: "xx-value" };
    const text = JSON.stringify(checkEnv(env));
    for (const leaked of ["tiny-secret-9f3", "hunter2", "bad-key-value-77", "xx-value"]) expect(text).not.toContain(leaked);
  });
});

describe("spend controls flags (docs/SPEND-CONTROLS-SPEC.md 4.14)", () => {
  const prod = () => ({ ...valid(), NODE_ENV: "production", CSP_MODE: "enforce", CREATIVE_MEDIA_SECRET: randomBytes(32).toString("hex"), CONTENT_MEDIA_SECRET: randomBytes(32).toString("hex") });

  it("MAX_DAILY_BUDGET_MINOR is deprecated: no longer a feature that is off, a warning when set", () => {
    expect(checkEnv(valid()).disabled.join("|")).not.toContain("MAX_DAILY_BUDGET_MINOR");
    const set = checkEnv({ ...valid(), MAX_DAILY_BUDGET_MINOR: "500000" });
    expect(set.errors).toEqual([]);
    expect(set.warnings).toEqual(["MAX_DAILY_BUDGET_MINOR is deprecated; it is read as an INR platform daily ads ceiling of 1.75 x its value. Set platform ceilings in /admin/spending/settings, then remove it"]);
    expect(checkEnv({ ...valid(), MAX_DAILY_BUDGET_MINOR: "abc" }).warnings).toEqual(["MAX_DAILY_BUDGET_MINOR must be a positive integer in minor units; it is ignored until it is one"]);
  });

  it("refuses SPEND_DRY_RUN and EDDY_FAKE_MODEL in production, and allows them elsewhere", () => {
    expect(checkEnv(prod()).errors).toEqual([]);
    const bad = checkEnv({ ...prod(), SPEND_DRY_RUN: "1", EDDY_FAKE_MODEL: "scripted" });
    expect(bad.errors).toEqual(["SPEND_DRY_RUN must not be on in production (no Meta writes would happen)", "EDDY_FAKE_MODEL must not be set in production (it replaces the real model with scripted replies)"]);
    expect(checkEnv({ ...valid(), SPEND_DRY_RUN: "1", EDDY_FAKE_MODEL: "scripted" }).errors).toEqual([]);
  });

  it("validates SPEND_NOTIFY_SECRET only when it is set: 32 random bytes, not a placeholder, not shared", () => {
    expect(checkEnv(prod()).errors).toEqual([]);
    expect(checkEnv({ ...valid(), SPEND_NOTIFY_SECRET: randomBytes(16).toString("hex") }).errors).toEqual(["SPEND_NOTIFY_SECRET must be at least 32 random bytes, hex or base64 encoded (openssl rand -hex 32)"]);
    expect(checkEnv({ ...valid(), SPEND_NOTIFY_SECRET: "changeme-" + "x".repeat(60) }).errors).toEqual(["SPEND_NOTIFY_SECRET looks like a placeholder"]);
    expect(checkEnv({ ...valid(), SPEND_NOTIFY_SECRET: randomBytes(32).toString("base64") }).errors).toEqual([]);
    const base = valid();
    const shared = { ...base, SESSION_SECRET: randomBytes(32).toString("hex") };
    expect(checkEnv({ ...shared, SPEND_NOTIFY_SECRET: shared.SESSION_SECRET }).warnings.some((w) => w.includes("SPEND_NOTIFY_SECRET") && w.includes("share a value"))).toBe(true);
  });
});

describe("Eddy rules (docs/EDDY-SPEC.md 7.10, 12.1a decision 14)", () => {
  const prod = () => ({ ...valid(), NODE_ENV: "production", CSP_MODE: "enforce", ANTHROPIC_API_KEY: "sk-test", CREATIVE_MEDIA_SECRET: randomBytes(32).toString("hex"), CONTENT_MEDIA_SECRET: randomBytes(32).toString("hex") });
  const eddyErrors = (env: Record<string, string>) => checkEnv({ ...valid(), ...env }).errors.filter((e) => e.startsWith("EDDY_"));

  it("EDDY_MODEL must be a supported Claude id and on AI_ALLOWED_MODELS when that list is set", () => {
    expect(eddyErrors({ EDDY_MODEL: "claude-sonnet-5-5" })).toEqual([]);
    expect(eddyErrors({ EDDY_MODEL: "Claude Sonnet" })).toEqual(["EDDY_MODEL must be a Claude model id such as claude-sonnet-5-5"]);
    expect(eddyErrors({ EDDY_MODEL: "claude-haiku-4-5" })[0]).toContain("must be one of claude-sonnet-5-5, claude-opus-5-5");
    expect(eddyErrors({ EDDY_MODEL: "claude-opus-5-5", AI_ALLOWED_MODELS: "claude-sonnet-5-5" })).toEqual(["EDDY_MODEL must also be listed in AI_ALLOWED_MODELS"]);
  });

  it("EDDY_PRICES must parse, with the same rules as the price table, and the value is never echoed", async () => {
    const { parsePriceOverride } = await import("@/lib/spend/exec/ai-pricing");
    const full = { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 };
    const cases = [
      JSON.stringify({ "claude-sonnet-5-5": full }),
      JSON.stringify({}),
      "{not json",
      "[]",
      JSON.stringify({ "gpt-4": full }),
      JSON.stringify({ "claude-sonnet-5-5": { ...full, output: -1 } }),
      JSON.stringify({ "claude-sonnet-5-5": { input: 2 } }),
      JSON.stringify({ "claude-sonnet-5-5": { ...full, input: 5000 } }),
      JSON.stringify({ "claude-sonnet-5-5": "cheap" }),
    ];
    for (const raw of cases) {
      const errors = eddyErrors({ EDDY_PRICES: raw });
      expect(errors.length === 0, raw).toBe(parsePriceOverride(raw).problem === null);
      expect(JSON.stringify(errors)).not.toContain("gpt-4");
      expect(JSON.stringify(errors)).not.toContain("cheap");
    }
    expect(eddyErrors({ EDDY_PRICES: "{not json" })).toEqual(["EDDY_PRICES is not valid JSON"]);
  });

  it("refuses a typo in Eddy's switches and tuning numbers instead of quietly falling back", () => {
    expect(eddyErrors({ EDDY_ENABLED: "True", EDDY_PHASE: "1" })).toEqual([]);
    expect(eddyErrors({ EDDY_ENABLED: "yes" })).toEqual(["EDDY_ENABLED must be one of false, true"]);
    expect(eddyErrors({ EDDY_PHASE: "3" })).toEqual(["EDDY_PHASE must be one of 1, 2"]);
    expect(eddyErrors({ EDDY_EFFORT: "lowest" })).toEqual(["EDDY_EFFORT must be one of low, medium, high, xhigh, max"]);
    expect(eddyErrors({ EDDY_FALLBACKS: "maybe", EDDY_INJECTION_SCREEN: "haiku" })).toEqual(["EDDY_FALLBACKS must be one of on, off", "EDDY_INJECTION_SCREEN must be one of off, on"]);
    expect(eddyErrors({ EDDY_MAX_TOKENS: "500" })).toEqual(["EDDY_MAX_TOKENS must be a whole number from 2000 to 128000"]);
    expect(eddyErrors({ EDDY_MAX_CONCURRENT_TURNS: "40", EDDY_MAX_CREDITS_PER_TURN: "30", EDDY_MAX_CREDITS_PER_USER_DAY: "40", EDDY_MICROUSD_PER_CREDIT: "10000", EDDY_MAX_TOKENS: "8000" })).toEqual([]);
    expect(eddyErrors({ EDDY_MAX_CREDITS_PER_TURN: "0" })).toEqual(["EDDY_MAX_CREDITS_PER_TURN must be a whole number from 1 to 1000000000"]);
  });

  it("EDDY_ENABLED=true in production without EDDY_ANTHROPIC_KEY_DEDICATED is a warning, not a refusal (decision 14)", () => {
    const missing = checkEnv({ ...prod(), EDDY_ENABLED: "true" });
    expect(missing.errors).toEqual([]);
    expect(missing.warnings).toEqual([
      "EDDY_ENABLED is true but EDDY_ANTHROPIC_KEY_DEDICATED is not; give wa its own Anthropic key with a monthly spend limit set in the Anthropic console, then set EDDY_ANTHROPIC_KEY_DEDICATED=true (docs/ops.md)",
    ]);
    expect(checkEnv({ ...prod(), EDDY_ENABLED: "true", EDDY_ANTHROPIC_KEY_DEDICATED: "true" }).warnings).toEqual([]);
    expect(checkEnv({ ...prod(), EDDY_ENABLED: "false" }).warnings).toEqual([]);
    expect(checkEnv({ ...valid(), ANTHROPIC_API_KEY: "k", EDDY_ENABLED: "true" }).warnings).toEqual([]);
  });

  it("warns when Eddy is switched on without an Anthropic key", () => {
    expect(checkEnv({ ...valid(), EDDY_ENABLED: "true" }).warnings).toEqual(["EDDY_ENABLED is true but ANTHROPIC_API_KEY is not set, so Eddy stays off for every workspace"]);
  });

  it("never echoes an Eddy or spend value", () => {
    const text = JSON.stringify(checkEnv({ ...prod(), EDDY_ENABLED: "zz-val-1", EDDY_MAX_TOKENS: "zz-val-2", EDDY_PRICES: '{"zz-val-3": 1}', SPEND_NOTIFY_SECRET: "zz-val-4", MAX_DAILY_BUDGET_MINOR: "zz-val-5" }));
    for (const leaked of ["zz-val-1", "zz-val-2", "zz-val-3", "zz-val-4", "zz-val-5"]) expect(text).not.toContain(leaked);
  });
});

describe("docs/ops.md lists every new environment variable (builders never touch .env)", () => {
  it("names each spend and Eddy variable the env rules check", () => {
    const ops = readFileSync(path.join(__dirname, "..", "docs/ops.md"), "utf8");
    const section = ops.slice(ops.indexOf("## 15. Spend controls and Eddy"));
    const rules = readFileSync(path.join(__dirname, "..", "src/lib/env-rules.mjs"), "utf8");
    const checked = new Set([...rules.matchAll(/\b((?:SPEND|EDDY|ASSISTANT)_[A-Z_]+[A-Z])\b/g)].map((m) => m[1]));
    for (const name of ["SPEND_ENFORCE", "SPEND_TRIPWIRE", "SPEND_CAP_MODE", "ASSISTANT_SPEND_ENABLED", "SPEND_DRY_RUN", "SPEND_SIM", "SPEND_NOTIFY_SECRET", "EDDY_ENABLED", "EDDY_MODEL", "EDDY_PRICES", "EDDY_FAKE_MODEL", "EDDY_ANTHROPIC_KEY_DEDICATED"]) {
      expect(checked.has(name), name).toBe(true);
    }
    for (const name of [...checked].filter((n) => !["EDDY_SUPPORTED_MODELS", "EDDY_PRICE_FIELDS", "EDDY_FLAG_VALUES", "EDDY_NUMBERS", "SPEND_FLAG_VALUES"].includes(n))) {
      expect(section, name).toContain("`" + name + "`");
    }
    for (const name of ["MAX_DAILY_BUDGET_MINOR", "AI_ALLOWED_MODELS"]) expect(section).toContain("`" + name + "`");
  });
});

describe("startup report", () => {
  it("logs counts and feature names, never values", () => {
    const lines: string[] = [];
    setLogSink((_level, line) => lines.push(line));
    const env = { ...valid(), RAZORPAY_KEY_SECRET: "rzp-secret-value-123" };
    logStartupReport(env);
    const startup = JSON.parse(lines[lines.length - 1]);
    expect(startup).toMatchObject({ msg: "startup", envErrors: 0, cspMode: "report-only" });
    expect(startup.disabledFeatures.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("rzp-secret-value-123");
    expect(lines.join("\n")).not.toContain(env.SESSION_SECRET);
  });
});
