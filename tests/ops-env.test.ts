import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkEnv, logStartupReport } from "@/lib/env";
import {
  CREATIVE_IMAGE_PROVIDERS,
  isLoopbackGraphBaseUrl,
  PROMOTE_FLAG_VALUES,
  PROMOTE_GOAL_KEYS,
  PROMOTE_LIST_VALUES,
  STUDIO_FLAG_VALUES,
  STUDIO_NUMBERS,
  STUDIO_TEST_URLS,
  testCanvaBaseUrls,
  testGraphBaseUrl,
  testMetaAdsMcpUrl,
} from "@/lib/env-rules.mjs";
import { metaAdsMcpDailyCalls, metaAdsMcpEnabled, metaAdsMcpRules } from "@/lib/meta-ads-mcp/flags";
import { canvaConfigured, canvaEnabled, canvaVideo, defaultImageProvider, studioDailyRenders, studioEnabled } from "@/lib/studio/flags";
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
    const prod = { ...valid(), NODE_ENV: "production", SMTP_USER: "noreply@edwyz.com", CREATIVE_MEDIA_SECRET: randomBytes(32).toString("hex"), CONTENT_MEDIA_SECRET: randomBytes(32).toString("hex") };
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
  const prod = () => ({ ...valid(), NODE_ENV: "production", CSP_MODE: "enforce", SMTP_USER: "noreply@edwyz.com", ANTHROPIC_API_KEY: "sk-test", CREATIVE_MEDIA_SECRET: randomBytes(32).toString("hex"), CONTENT_MEDIA_SECRET: randomBytes(32).toString("hex") });
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
    expect(checkEnv({ ...prod(), EDDY_ENABLED: "false", EDDY_ANTHROPIC_KEY_DEDICATED: "true" }).warnings).toEqual([]);
    expect(checkEnv({ ...valid(), ANTHROPIC_API_KEY: "k", EDDY_ENABLED: "true" }).warnings).toEqual([]);
  });

  it("with Eddy off, a production AI key that is not declared dedicated is still a warning: the reply bot and creative copy spend on it", () => {
    const shared = "ANTHROPIC_API_KEY is set but EDDY_ANTHROPIC_KEY_DEDICATED is not true; the AI reply bot, inbox suggestions and creative copy may run on a shared key with no spend limit of its own. Give wa its own Anthropic key with a monthly spend limit set in the Anthropic console, then set EDDY_ANTHROPIC_KEY_DEDICATED=true (docs/ops.md)";
    expect(checkEnv({ ...prod(), EDDY_ENABLED: "false" }).warnings).toEqual([shared]);
    expect(checkEnv(prod()).warnings).toEqual([shared]);
    expect(checkEnv({ ...prod(), EDDY_ANTHROPIC_KEY_DEDICATED: "false" }).warnings).toEqual([shared]);
    // one warning, never both, when Eddy is on
    expect(checkEnv({ ...prod(), EDDY_ENABLED: "true" }).warnings.filter((w) => w.includes("EDDY_ANTHROPIC_KEY_DEDICATED"))).toHaveLength(1);
    // no key, nothing to warn about; outside production, no nagging
    const { ANTHROPIC_API_KEY: _key, ...keyless } = prod();
    expect(checkEnv(keyless).warnings).toEqual([]);
    expect(checkEnv({ ...valid(), ANTHROPIC_API_KEY: "k" }).warnings).toEqual([]);
    expect(JSON.stringify(checkEnv(prod()))).not.toContain("sk-test");
  });

  it("warns when Eddy is switched on without an Anthropic key", () => {
    expect(checkEnv({ ...valid(), EDDY_ENABLED: "true" }).warnings).toEqual(["EDDY_ENABLED is true but ANTHROPIC_API_KEY is not set, so Eddy stays off for every workspace"]);
  });

  it("never echoes an Eddy or spend value", () => {
    const text = JSON.stringify(checkEnv({ ...prod(), EDDY_ENABLED: "zz-val-1", EDDY_MAX_TOKENS: "zz-val-2", EDDY_PRICES: '{"zz-val-3": 1}', SPEND_NOTIFY_SECRET: "zz-val-4", MAX_DAILY_BUDGET_MINOR: "zz-val-5" }));
    for (const leaked of ["zz-val-1", "zz-val-2", "zz-val-3", "zz-val-4", "zz-val-5"]) expect(text).not.toContain(leaked);
  });
});

describe("email verification gate (src/lib/auth/verification.ts)", () => {
  const prod = () => ({ ...valid(), NODE_ENV: "production", CSP_MODE: "enforce", CREATIVE_MEDIA_SECRET: randomBytes(32).toString("hex"), CONTENT_MEDIA_SECRET: randomBytes(32).toString("hex") });
  const notEnforced = (warnings: string[]) => warnings.filter((w) => /not enforced/.test(w));

  it("warns in production when the gate is off because SMTP_USER is empty, and says how it turns on", () => {
    const [warning] = notEnforced(checkEnv(prod()).warnings);
    expect(warning).toBe(
      "Email verification is not enforced because SMTP_USER is not set (EMAIL_VERIFICATION_REQUIRED is unset): an unconfirmed signup can send messages, run broadcasts, import contacts, create API keys and connect Meta. Set the SMTP lines and it turns on by itself",
    );
    expect(checkEnv({ ...prod(), SMTP_USER: "noreply@edwyz.com" }).warnings).toEqual([]);
    expect(notEnforced(checkEnv(valid()).warnings)).toEqual([]); // not production: no nagging
  });

  it("names a gate forced off, and a gate forced on that no email can ever satisfy", () => {
    expect(notEnforced(checkEnv({ ...prod(), SMTP_USER: "noreply@edwyz.com", EMAIL_VERIFICATION_REQUIRED: "false" }).warnings)[0]).toMatch(/^EMAIL_VERIFICATION_REQUIRED is false, so email verification is not enforced/);
    expect(checkEnv({ ...prod(), EMAIL_VERIFICATION_REQUIRED: "true" }).warnings).toEqual([
      "EMAIL_VERIFICATION_REQUIRED is true but SMTP_USER is not set, so no confirmation email can be sent and every new signup stays read-only",
    ]);
    expect(checkEnv({ ...prod(), SMTP_USER: "noreply@edwyz.com", EMAIL_VERIFICATION_REQUIRED: "true" }).warnings).toEqual([]);
    expect(checkEnv({ ...valid(), EMAIL_VERIFICATION_REQUIRED: "maybe" }).warnings).toEqual(["EMAIL_VERIFICATION_REQUIRED must be true or false; any other value counts as unset"]);
  });

  it("agrees with the gate itself for every combination, so the warning never says off while the gate is on", async () => {
    const { emailVerificationRequired } = await import("@/lib/auth/verification");
    const saved = { required: process.env.EMAIL_VERIFICATION_REQUIRED, smtp: process.env.SMTP_USER };
    try {
      for (const required of [undefined, "", "true", "TRUE", "1", "yes", "on", "false", "0", "no", "off", "maybe"]) {
        for (const smtp of [undefined, "", "noreply@edwyz.com"]) {
          const env: Record<string, string> = { ...prod() };
          if (required !== undefined) env.EMAIL_VERIFICATION_REQUIRED = required;
          if (smtp !== undefined) env.SMTP_USER = smtp;
          if (required === undefined) delete process.env.EMAIL_VERIFICATION_REQUIRED;
          else process.env.EMAIL_VERIFICATION_REQUIRED = required;
          if (smtp === undefined) delete process.env.SMTP_USER;
          else process.env.SMTP_USER = smtp;
          expect(notEnforced(checkEnv(env).warnings).length === 1, `${required}/${smtp}`).toBe(!emailVerificationRequired());
        }
      }
    } finally {
      if (saved.required === undefined) delete process.env.EMAIL_VERIFICATION_REQUIRED;
      else process.env.EMAIL_VERIFICATION_REQUIRED = saved.required;
      if (saved.smtp === undefined) delete process.env.SMTP_USER;
      else process.env.SMTP_USER = saved.smtp;
    }
  });
});

describe("RATELIMIT_BACKEND", () => {
  it("accepts settings and memory, and refuses table (no RateLimitBucket migration) or a typo, without echoing it", () => {
    expect(checkEnv({ ...valid(), RATELIMIT_BACKEND: "settings" }).errors).toEqual([]);
    expect(checkEnv({ ...valid(), RATELIMIT_BACKEND: "memory" }).errors).toEqual([]);
    expect(checkEnv({ ...valid(), RATELIMIT_BACKEND: "" }).errors).toEqual([]);
    for (const bad of ["table", "postgres", "Settings"]) {
      const { errors } = checkEnv({ ...valid(), RATELIMIT_BACKEND: bad });
      expect(errors, bad).toEqual(["RATELIMIT_BACKEND must be settings (the default) or memory; table needs the RateLimitBucket table, which has no migration yet"]);
    }
    expect(JSON.stringify(checkEnv({ ...valid(), RATELIMIT_BACKEND: "zz-backend" }))).not.toContain("zz-backend");
  });

  it("warns in production when limits would reset on every restart", () => {
    const prod = { ...valid(), NODE_ENV: "production", CSP_MODE: "enforce", SMTP_USER: "noreply@edwyz.com", CREATIVE_MEDIA_SECRET: randomBytes(32).toString("hex"), CONTENT_MEDIA_SECRET: randomBytes(32).toString("hex") };
    expect(checkEnv({ ...prod, RATELIMIT_BACKEND: "memory" }).warnings).toEqual([
      "RATELIMIT_BACKEND is memory; rate limits are kept per process and reset on every restart. Remove the line to share them through the database",
    ]);
    expect(checkEnv({ ...valid(), RATELIMIT_BACKEND: "memory" }).warnings).toEqual([]);
  });
});

describe("Instagram and Facebook Page ads flags (docs/IG-PAGE-ADS-SPEC.md 1.4, 9.3, 11.2 risk 24; PRM-00)", () => {
  const prod = () => ({ ...valid(), NODE_ENV: "production", CSP_MODE: "enforce", SMTP_USER: "noreply@edwyz.com", CREATIVE_MEDIA_SECRET: randomBytes(32).toString("hex"), CONTENT_MEDIA_SECRET: randomBytes(32).toString("hex") });
  const enforcing = { SPEND_ENFORCE: "enforce", SPEND_TRIPWIRE: "enforce" };

  it("knows the ten flags and their allowed values", () => {
    expect(PROMOTE_FLAG_VALUES).toEqual({
      PROMOTE_ENABLED: ["off", "admins", "on"],
      PROMOTE_PREVIEWS: ["meta", "local"],
      PROMOTE_VIDEO: ["off", "file_url", "resumable"],
      PROMOTE_AUDIENCES: ["off", "engagement", "all"],
      LEGAL_DPDP_AUDIENCES_OK: ["0", "1", "false", "true", "no", "yes", "off", "on"],
      PROMOTE_EXPERIMENTAL: ["0", "1", "false", "true", "no", "yes", "off", "on"],
      META_LOGIN_POPUP: ["0", "1", "false", "true", "no", "yes", "off", "on"],
    });
    expect(PROMOTE_LIST_VALUES).toEqual({ PROMOTE_GOALS: PROMOTE_GOAL_KEYS, PROMOTE_PAGE_LANGS: ["en", "hi", "hinglish"] });
    expect(PROMOTE_GOAL_KEYS).toHaveLength(12);
  });

  it("leaves an environment without them alone, in production too (the dark defaults)", () => {
    expect(checkEnv(valid())).toMatchObject({ errors: [], warnings: [] });
    expect(checkEnv(prod())).toMatchObject({ errors: [], warnings: [] });
  });

  it("accepts every allowed value of each flag, trimmed and in any case, and refuses a typo without echoing it", () => {
    for (const [name, values] of Object.entries(PROMOTE_FLAG_VALUES)) {
      for (const value of values) expect(checkEnv({ ...valid(), [name]: value }).errors, `${name}=${value}`).toEqual([]);
      expect(checkEnv({ ...valid(), [name]: ` ${values[values.length - 1].toUpperCase()} ` }).errors, name).toEqual([]);
      const bad = checkEnv({ ...valid(), [name]: "typo-value-42" });
      expect(bad.errors).toEqual([`${name} must be one of ${values.join(", ")}`]);
      expect(JSON.stringify(bad)).not.toContain("typo-value-42");
    }
  });

  it("checks each item of PROMOTE_GOALS and PROMOTE_PAGE_LANGS", () => {
    expect(checkEnv({ ...valid(), PROMOTE_GOALS: PROMOTE_GOAL_KEYS.join(",") }).errors).toEqual([]);
    expect(checkEnv({ ...valid(), PROMOTE_GOALS: " whatsapp_chats , lead_form ," }).errors).toEqual([]);
    expect(checkEnv({ ...valid(), PROMOTE_GOALS: "lead_form,boost_everything" }).errors).toEqual([`PROMOTE_GOALS must be a comma-separated list of ${PROMOTE_GOAL_KEYS.join(", ")}`]);
    expect(checkEnv({ ...valid(), PROMOTE_PAGE_LANGS: "en,hi,hinglish" }).errors).toEqual([]);
    expect(checkEnv({ ...valid(), PROMOTE_PAGE_LANGS: "en,fr" }).errors).toEqual(["PROMOTE_PAGE_LANGS must be a comma-separated list of en, hi, hinglish"]);
    expect(JSON.stringify(checkEnv({ ...valid(), PROMOTE_GOALS: "boost_everything" }))).not.toContain("boost_everything");
  });

  it("production refuses PROMOTE_AUDIENCES=all without LEGAL_DPDP_AUDIENCES_OK=1", () => {
    const refusal = "PROMOTE_AUDIENCES=all needs LEGAL_DPDP_AUDIENCES_OK=1 in production (customer lists wait for the lawyer's review); use engagement until then";
    expect(checkEnv({ ...prod(), PROMOTE_AUDIENCES: "all" }).errors).toEqual([refusal]);
    expect(checkEnv({ ...prod(), PROMOTE_AUDIENCES: "all", LEGAL_DPDP_AUDIENCES_OK: "0" }).errors).toEqual([refusal]);
    expect(checkEnv({ ...prod(), PROMOTE_AUDIENCES: "ALL", LEGAL_DPDP_AUDIENCES_OK: "1" }).errors).toEqual([]);
    expect(checkEnv({ ...prod(), PROMOTE_AUDIENCES: "engagement" }).errors).toEqual([]);
    expect(checkEnv({ ...valid(), PROMOTE_AUDIENCES: "all" }).errors).toEqual([]); // not production
  });

  it("production refuses PROMOTE_ENABLED=on with SPEND_ENFORCE=observe or SPEND_TRIPWIRE=report (train P3)", () => {
    const refusal = "PROMOTE_ENABLED=on needs SPEND_ENFORCE=enforce and SPEND_TRIPWIRE=enforce in production (train P3); use admins until both are on";
    expect(checkEnv({ ...prod(), PROMOTE_ENABLED: "on", SPEND_ENFORCE: "observe", SPEND_TRIPWIRE: "enforce" }).errors).toEqual([refusal]);
    expect(checkEnv({ ...prod(), PROMOTE_ENABLED: "on", SPEND_ENFORCE: "enforce", SPEND_TRIPWIRE: "report" }).errors).toEqual([refusal]);
    expect(checkEnv({ ...prod(), PROMOTE_ENABLED: "on" }).errors).toEqual([refusal]);
    expect(checkEnv({ ...prod(), PROMOTE_ENABLED: "on", ...enforcing }).errors).toEqual([]);
    expect(checkEnv({ ...prod(), PROMOTE_ENABLED: "admins" }).errors).toEqual([]);
    expect(checkEnv({ ...valid(), PROMOTE_ENABLED: "on" }).errors).toEqual([]); // not production
  });

  it("production refuses any GRAPH_BASE_URL, loopback included (the SPEND_DRY_RUN rule)", () => {
    for (const url of ["http://127.0.0.1:4010", "https://graph.example.com"]) {
      const report = checkEnv({ ...prod(), GRAPH_BASE_URL: url });
      expect(report.errors).toEqual(["GRAPH_BASE_URL must not be set in production (every Graph call would go to a test server instead of Meta)"]);
      expect(JSON.stringify(report)).not.toContain(url);
    }
  });

  it("every environment refuses a GRAPH_BASE_URL that is not http(s) on 127.0.0.1, localhost or [::1]", () => {
    const refusal = "GRAPH_BASE_URL must be an http or https address on 127.0.0.1, localhost or [::1] (the fake Meta server for tests); remove it to call Meta";
    for (const url of ["https://graph.example.com", "http://10.0.0.5:4010", "http://127.0.0.2:4010", "ftp://127.0.0.1", "http://user:pw@127.0.0.1:4010", "http://127.0.0.1:4010/?x=1", "http://localhost.example.com", "not a url"]) {
      expect(checkEnv({ ...valid(), GRAPH_BASE_URL: url }).errors, url).toEqual([refusal]);
      expect(checkEnv({ ...valid(), NODE_ENV: "test", GRAPH_BASE_URL: url }).errors, url).toEqual([refusal]);
    }
    for (const url of ["http://127.0.0.1:4010", "http://localhost:4010/v26.0", "http://[::1]:4010", "https://LOCALHOST"]) {
      expect(checkEnv({ ...valid(), GRAPH_BASE_URL: url }).errors, url).toEqual([]);
    }
  });

  it("the runtime reader follows the same rule: loopback only, never in production", () => {
    expect(isLoopbackGraphBaseUrl("http://127.0.0.1:4010")).toBe(true);
    expect(isLoopbackGraphBaseUrl("https://graph.example.com")).toBe(false);
    expect(isLoopbackGraphBaseUrl(undefined)).toBe(false);
    expect(testGraphBaseUrl({ GRAPH_BASE_URL: " http://127.0.0.1:4010/ " })).toBe("http://127.0.0.1:4010");
    expect(testGraphBaseUrl({ GRAPH_BASE_URL: "http://127.0.0.1:4010", NODE_ENV: "production" })).toBeNull();
    expect(testGraphBaseUrl({ GRAPH_BASE_URL: "http://10.0.0.5:4010" })).toBeNull();
    expect(testGraphBaseUrl({})).toBeNull();
  });

  it("warns in production when PROMOTE_EXPERIMENTAL is on, and only there", () => {
    expect(checkEnv({ ...prod(), PROMOTE_EXPERIMENTAL: "1" }).warnings).toEqual([
      "PROMOTE_EXPERIMENTAL is on in production; ad options Meta has not been verified for show only in workspaces whose ad account is a Meta test account",
    ]);
    expect(checkEnv({ ...prod(), PROMOTE_EXPERIMENTAL: "0" }).warnings).toEqual([]);
    expect(checkEnv({ ...valid(), PROMOTE_EXPERIMENTAL: "1" }).warnings).toEqual([]);
  });

  it("deploy/README-deploy.md documents every promote flag, the 5.2 order and the train gates", () => {
    const readme = readFileSync(path.join(__dirname, "..", "deploy/README-deploy.md"), "utf8");
    const section = readme.slice(readme.indexOf("## D. Instagram and Facebook Page ads"));
    for (const name of [...Object.keys(PROMOTE_FLAG_VALUES), ...Object.keys(PROMOTE_LIST_VALUES), "GRAPH_BASE_URL"]) expect(section, name).toContain("`" + name + "`");
    expect(section).toContain("**Apply 0012 WITH `-1`**");
    expect(section).toContain("**Apply 0013 WITHOUT `-1`, off-peak**");
    expect(section.indexOf("Apply 0012")).toBeLessThan(section.indexOf("Build and restart web and worker"));
    expect(section.indexOf("Build and restart web and worker")).toBeLessThan(section.indexOf("Apply 0013"));
    for (const train of ["P1 dark", "P2 drafts and reads", "P3 Start", "P4 audiences", "P5 Eddy v2"]) expect(section, train).toContain(train);
  });
});

describe("Studio, Canva and Meta ads MCP flags (docs/specs/ADS-MCP-CANVA-CREATIVE-SPEC.md 5.8, D25; MCC-00)", () => {
  const prod = () => ({ ...valid(), NODE_ENV: "production", CSP_MODE: "enforce", SMTP_USER: "noreply@edwyz.com", CREATIVE_MEDIA_SECRET: randomBytes(32).toString("hex"), CONTENT_MEDIA_SECRET: randomBytes(32).toString("hex") });
  const canva = { CANVA_CLIENT_ID: "OC-AZtest123", CANVA_CLIENT_SECRET: "cnvca" + randomBytes(24).toString("hex") };
  const studioOn = { STUDIO_ENABLED: "on", DISABLE_SYSTEM_FONTS_LOAD: "1" };

  it("knows the four switches, the two numbers, the image providers and the three test-only addresses", () => {
    expect(STUDIO_FLAG_VALUES).toEqual({ STUDIO_ENABLED: ["off", "on"], CANVA_VIDEO: ["off", "on"], META_ADS_MCP: ["off", "on"], META_ADS_MCP_RULES: ["off", "on"] });
    expect(STUDIO_NUMBERS).toEqual({ STUDIO_DAILY_RENDERS: [10, 5000, 100], META_ADS_MCP_DAILY_CALLS: [50, 10000, 600] });
    expect(CREATIVE_IMAGE_PROVIDERS).toEqual(["brand", "placeholder", "http"]);
    expect(STUDIO_TEST_URLS).toEqual(["CANVA_API_BASE_URL", "CANVA_AUTH_BASE_URL", "META_ADS_MCP_URL"]);
  });

  it("leaves an environment without them alone, in production too, and lists nothing as off (the dark defaults)", () => {
    expect(checkEnv(valid())).toMatchObject({ errors: [], warnings: [] });
    expect(checkEnv(prod())).toMatchObject({ errors: [], warnings: [] });
    for (const env of [valid(), prod()]) expect(checkEnv(env).disabled.join("|")).not.toMatch(/Canva|Studio|MCP/);
  });

  it("accepts on and off for each switch, trimmed and in any case, and refuses a typo without echoing it", () => {
    for (const name of Object.keys(STUDIO_FLAG_VALUES)) {
      for (const value of ["on", "off", " ON ", "Off"]) expect(checkEnv({ ...valid(), [name]: value, DISABLE_SYSTEM_FONTS_LOAD: "1" }).errors, `${name}=${value}`).toEqual([]);
      for (const typo of ["true", "1", "yes", "enabled", "typo-value-42"]) {
        const bad = checkEnv({ ...valid(), [name]: typo });
        expect(bad.errors, `${name}=${typo}`).toEqual([`${name} must be one of off, on`]);
      }
      expect(JSON.stringify(checkEnv({ ...valid(), [name]: "typo-value-42" }))).not.toContain("typo-value-42");
    }
  });

  it("STUDIO_DAILY_RENDERS is a whole number from 10 to 5000 and META_ADS_MCP_DAILY_CALLS one from 50 to 10000", () => {
    for (const ok of ["10", "100", "5000"]) expect(checkEnv({ ...valid(), STUDIO_DAILY_RENDERS: ok }).errors, ok).toEqual([]);
    for (const bad of ["9", "5001", "1.5", "-20", "lots"]) expect(checkEnv({ ...valid(), STUDIO_DAILY_RENDERS: bad }).errors, bad).toEqual(["STUDIO_DAILY_RENDERS must be a whole number from 10 to 5000"]);
    for (const ok of ["50", "600", "10000"]) expect(checkEnv({ ...valid(), META_ADS_MCP_DAILY_CALLS: ok }).errors, ok).toEqual([]);
    for (const bad of ["49", "10001", "6e2"]) expect(checkEnv({ ...valid(), META_ADS_MCP_DAILY_CALLS: bad }).errors, bad).toEqual(["META_ADS_MCP_DAILY_CALLS must be a whole number from 50 to 10000"]);
    expect(JSON.stringify(checkEnv({ ...valid(), STUDIO_DAILY_RENDERS: "zz-num-7" }))).not.toContain("zz-num-7");
  });

  it("CREATIVE_IMAGE_PROVIDER takes brand, placeholder or http; brand without Studio is a warning", () => {
    for (const value of ["placeholder", "http"]) expect(checkEnv({ ...valid(), CREATIVE_IMAGE_PROVIDER: value })).toMatchObject({ errors: [], warnings: [] });
    expect(checkEnv({ ...valid(), CREATIVE_IMAGE_PROVIDER: "paid-provider" }).errors).toEqual(["CREATIVE_IMAGE_PROVIDER must be one of brand, placeholder, http"]);
    expect(JSON.stringify(checkEnv({ ...valid(), CREATIVE_IMAGE_PROVIDER: "paid-provider" }))).not.toContain("paid-provider");
    expect(checkEnv({ ...valid(), CREATIVE_IMAGE_PROVIDER: "brand" })).toMatchObject({
      errors: [],
      warnings: ["CREATIVE_IMAGE_PROVIDER is brand but STUDIO_ENABLED is not on; the brand images need Studio, so set STUDIO_ENABLED=on or use placeholder"],
    });
    expect(checkEnv({ ...valid(), ...studioOn, CREATIVE_IMAGE_PROVIDER: "brand" })).toMatchObject({ errors: [], warnings: [] });
  });

  it("DISABLE_SYSTEM_FONTS_LOAD is 1 or unset, and Studio on without it is a warning", () => {
    expect(checkEnv({ ...valid(), DISABLE_SYSTEM_FONTS_LOAD: "1" })).toMatchObject({ errors: [], warnings: [] });
    for (const bad of ["0", "true", "yes"]) expect(checkEnv({ ...valid(), DISABLE_SYSTEM_FONTS_LOAD: bad }).errors, bad).toEqual(["DISABLE_SYSTEM_FONTS_LOAD must be 1 (images are drawn with the bundled fonts only) or unset"]);
    expect(checkEnv({ ...valid(), STUDIO_ENABLED: "on" }).warnings).toEqual(["STUDIO_ENABLED is on but DISABLE_SYSTEM_FONTS_LOAD is not 1; set it so images are drawn with the bundled fonts only"]);
  });

  it("Canva: the id without the secret is an error; configured with Studio off is a warning, since Canva needs both", () => {
    expect(checkEnv({ ...valid(), CANVA_CLIENT_ID: canva.CANVA_CLIENT_ID }).errors).toEqual(["CANVA_CLIENT_ID is set but CANVA_CLIENT_SECRET is not; set both from the Canva Developer Portal, or neither"]);
    expect(checkEnv({ ...valid(), CANVA_CLIENT_SECRET: canva.CANVA_CLIENT_SECRET })).toMatchObject({ errors: [], warnings: ["CANVA_CLIENT_SECRET is set but CANVA_CLIENT_ID is not, so Canva stays off"] });
    expect(checkEnv({ ...valid(), ...canva })).toMatchObject({
      errors: [],
      warnings: ["CANVA_CLIENT_ID and CANVA_CLIENT_SECRET are set but STUDIO_ENABLED is not on, so Canva stays off; Canva works only with Studio on"],
    });
    expect(checkEnv({ ...valid(), ...canva, ...studioOn })).toMatchObject({ errors: [], warnings: [], disabled: expect.not.arrayContaining([expect.stringContaining("Canva")]) });
    expect(checkEnv({ ...valid(), ...canva, CANVA_CLIENT_SECRET: "changeme-canva-secret" }).errors).toContain("CANVA_CLIENT_SECRET looks like a placeholder");
    const text = JSON.stringify(checkEnv({ ...prod(), ...canva, ...studioOn }));
    expect(text).not.toContain(canva.CANVA_CLIENT_SECRET);
    expect(text).not.toContain(canva.CANVA_CLIENT_ID);
  });

  it("with Studio on and Canva not configured, Canva is listed among the features that are off", () => {
    expect(checkEnv({ ...valid(), ...studioOn }).disabled).toContain("Canva designs in Creative Studio (CANVA_CLIENT_ID, CANVA_CLIENT_SECRET)");
    expect(checkEnv({ ...valid(), ...studioOn, ...canva }).disabled.join("|")).not.toContain("Canva");
    expect(checkEnv({ ...valid(), STUDIO_ENABLED: "off" }).disabled.join("|")).not.toContain("Canva");
  });

  it("production refuses each test-only address, loopback included, without echoing it", () => {
    for (const name of STUDIO_TEST_URLS) {
      for (const url of ["http://127.0.0.1:4592/rest/v1", "https://api.example.com"]) {
        const report = checkEnv({ ...prod(), [name]: url });
        expect(report.errors, `${name}=${url}`).toEqual([`${name} must not be set in production (it points the app at a test server instead of the real service)`]);
        expect(JSON.stringify(report)).not.toContain(url);
      }
    }
  });

  it("every other environment refuses a test-only address that is not http(s) on 127.0.0.1, localhost or [::1]", () => {
    for (const name of STUDIO_TEST_URLS) {
      const refusal = `${name} must be an http or https address on 127.0.0.1, localhost or [::1] (a fake server for tests); remove it to use the real service`;
      for (const url of ["https://api.canva.com/rest/v1", "https://mcp.example.com/ads", "http://10.0.0.5:4591", "http://user:pw@127.0.0.1:4592", "http://127.0.0.1:4591/ads?x=1", "not a url"]) {
        expect(checkEnv({ ...valid(), [name]: url }).errors, `${name}=${url}`).toEqual([refusal]);
        expect(checkEnv({ ...valid(), NODE_ENV: "test", [name]: url }).errors, `${name}=${url}`).toEqual([refusal]);
      }
      for (const url of ["http://127.0.0.1:4592/rest/v1", "http://localhost:4592", "http://[::1]:4591/ads"]) expect(checkEnv({ ...valid(), [name]: url }).errors, `${name}=${url}`).toEqual([]);
    }
  });

  it("the runtime readers of the test-only addresses follow the same rule: loopback only, never in production", () => {
    expect(testCanvaBaseUrls({ CANVA_API_BASE_URL: " http://127.0.0.1:4592/rest/v1/ ", CANVA_AUTH_BASE_URL: "http://127.0.0.1:4592" })).toEqual({ api: "http://127.0.0.1:4592/rest/v1", auth: "http://127.0.0.1:4592" });
    expect(testCanvaBaseUrls({ CANVA_API_BASE_URL: "http://127.0.0.1:4592/rest/v1", NODE_ENV: "production" })).toEqual({ api: null, auth: null });
    expect(testCanvaBaseUrls({ CANVA_API_BASE_URL: "https://api.canva.com/rest/v1", CANVA_AUTH_BASE_URL: "https://www.canva.com" })).toEqual({ api: null, auth: null });
    expect(testCanvaBaseUrls({})).toEqual({ api: null, auth: null });
    expect(testMetaAdsMcpUrl({ META_ADS_MCP_URL: "http://127.0.0.1:4591/ads" })).toBe("http://127.0.0.1:4591/ads");
    expect(testMetaAdsMcpUrl({ META_ADS_MCP_URL: "http://127.0.0.1:4591/ads", NODE_ENV: "production" })).toBeNull();
    expect(testMetaAdsMcpUrl({ META_ADS_MCP_URL: "https://mcp.example.com/ads" })).toBeNull();
    expect(testMetaAdsMcpUrl({})).toBeNull();
  });

  it("the switch readers are off by default and on only for on; an unknown value counts as off", () => {
    expect([studioEnabled({}), canvaConfigured({}), canvaEnabled({}), canvaVideo({}), metaAdsMcpEnabled({}), metaAdsMcpRules({})]).toEqual([false, false, false, false, false, false]);
    for (const value of ["off", "true", "1", "yes", "enabled", ""]) {
      expect(studioEnabled({ STUDIO_ENABLED: value }), value).toBe(false);
      expect(metaAdsMcpEnabled({ META_ADS_MCP: value }), value).toBe(false);
      expect(metaAdsMcpRules({ META_ADS_MCP_RULES: value }), value).toBe(false);
    }
    expect(studioEnabled({ STUDIO_ENABLED: " ON " })).toBe(true);
    expect(metaAdsMcpEnabled({ META_ADS_MCP: "on" })).toBe(true);
    expect(metaAdsMcpRules({ META_ADS_MCP_RULES: "On" })).toBe(true);
  });

  it("Canva is on only with Studio on and both credentials set; MP4 imports only with Canva on and CANVA_VIDEO=on", () => {
    expect(canvaConfigured(canva)).toBe(true);
    expect(canvaConfigured({ CANVA_CLIENT_ID: canva.CANVA_CLIENT_ID })).toBe(false);
    expect(canvaEnabled(canva)).toBe(false);
    expect(canvaEnabled({ ...canva, STUDIO_ENABLED: "on" })).toBe(true);
    expect(canvaEnabled({ STUDIO_ENABLED: "on", CANVA_CLIENT_ID: canva.CANVA_CLIENT_ID })).toBe(false);
    expect(canvaVideo({ ...canva, CANVA_VIDEO: "on" })).toBe(false);
    expect(canvaVideo({ ...canva, STUDIO_ENABLED: "on", CANVA_VIDEO: "on" })).toBe(true);
    expect(canvaVideo({ ...canva, STUDIO_ENABLED: "on" })).toBe(false);
  });

  it("the number readers use the default outside the allowed range, and the image provider stays placeholder while Studio is off", () => {
    expect(studioDailyRenders({})).toBe(100);
    expect(studioDailyRenders({ STUDIO_DAILY_RENDERS: "250" })).toBe(250);
    for (const bad of ["9", "5001", "x", "1.5"]) expect(studioDailyRenders({ STUDIO_DAILY_RENDERS: bad }), bad).toBe(100);
    expect(metaAdsMcpDailyCalls({})).toBe(600);
    expect(metaAdsMcpDailyCalls({ META_ADS_MCP_DAILY_CALLS: "50" })).toBe(50);
    for (const bad of ["49", "10001", "lots"]) expect(metaAdsMcpDailyCalls({ META_ADS_MCP_DAILY_CALLS: bad }), bad).toBe(600);
    expect(defaultImageProvider({})).toBe("placeholder");
    expect(defaultImageProvider({ STUDIO_ENABLED: "off" })).toBe("placeholder");
    expect(defaultImageProvider({ STUDIO_ENABLED: "on" })).toBe("brand");
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
