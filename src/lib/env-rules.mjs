// Plain JavaScript on purpose: scripts/check-env.mjs runs it with bare Node, and src/lib/env.ts re-exports it with types.
// Messages name variables only. They never contain a value.

const PLACEHOLDER = /^(change.?me|replace.?me|example|your[-_ ]|todo|xxx+|<.*>)/i;
const LOG_LEVELS = ["debug", "info", "warn", "error"];

const isSet = (env, name) => typeof env[name] === "string" && env[name].trim() !== "";

function checkSecret(env, name, minLength, errors) {
  if (!isSet(env, name)) return errors.push(`${name} is not set`);
  if (env[name].length < minLength) return errors.push(`${name} must be at least ${minLength} characters`);
  if (PLACEHOLDER.test(env[name].trim())) errors.push(`${name} looks like a placeholder`);
}

/** Bytes in a secret written as hex or base64 (standard or URL-safe); 0 when it is neither. */
export function decodedSecretBytes(value) {
  const raw = value.trim();
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) return raw.length / 2;
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").length;
  return 0;
}

// The signed media links fall back to STATE_SECRET when these are unset, which would tie two unrelated keys together.
function checkMediaSecrets(env, errors) {
  if (env.NODE_ENV !== "production") return;
  for (const name of ["CREATIVE_MEDIA_SECRET", "CONTENT_MEDIA_SECRET"]) {
    if (!isSet(env, name)) errors.push(`${name} is not set; set 32 or more random bytes as hex or base64 (it must not fall back to STATE_SECRET)`);
    else if (PLACEHOLDER.test(env[name].trim()) || decodedSecretBytes(env[name]) < 32) errors.push(`${name} must be at least 32 random bytes, hex or base64 encoded`);
  }
}

function checkInstanceCount(env, warnings) {
  const raw = env.WEB_INSTANCES ?? env.WEB_CONCURRENCY;
  if (raw !== undefined && Number(raw) > 1) {
    warnings.push("More than one web instance is configured; rate limits and replay guards are kept in process memory, so run exactly one pm2 instance of the web app (see docs/ops.md)");
  }
}

function checkDatabaseUrl(env, errors) {
  if (!isSet(env, "DATABASE_URL")) return errors.push("DATABASE_URL is not set");
  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    return errors.push("DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") errors.push("DATABASE_URL must start with postgres:// or postgresql://");
  else if (!url.hostname) errors.push("DATABASE_URL has no host");
  else if (url.pathname.length < 2) errors.push("DATABASE_URL has no database name");
}

function checkEncryptionKey(env, errors) {
  if (!isSet(env, "ENCRYPTION_KEY")) return errors.push("ENCRYPTION_KEY is not set");
  const raw = env.ENCRYPTION_KEY.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || Buffer.from(raw, "base64").length !== 32) {
    errors.push("ENCRYPTION_KEY must be 32 random bytes, base64 encoded");
  }
}

function checkSiteUrl(env, warnings) {
  if (!isSet(env, "SITE_URL")) return warnings.push("SITE_URL is not set; links and the Origin check fall back to https://wa.edwyz.com");
  try {
    const url = new URL(env.SITE_URL);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !local) warnings.push("SITE_URL should use https");
    // Every canonical, sitemap entry, email link and the API base URL in the docs is built from it.
    if (local && env.NODE_ENV === "production") warnings.push("SITE_URL points at localhost; in production every public link, canonical and sitemap entry would carry it, so set the public https URL");
  } catch {
    warnings.push("SITE_URL is not a valid URL");
  }
}

// The nonce policy only reports until CSP_MODE=enforce; until then the enforced header still allows inline scripts.
function checkCspMode(env, errors, warnings) {
  const csp = env.CSP_MODE;
  if (isSet(env, "CSP_MODE") && csp !== "report-only" && csp !== "enforce") return errors.push("CSP_MODE must be report-only or enforce");
  if (env.NODE_ENV === "production" && csp !== "enforce") {
    warnings.push("CSP_MODE is not enforce; the enforced policy still allows inline scripts. Set CSP_MODE=enforce once the report-only log shows no violations (docs/ops.md)");
  }
}

function checkDistinct(env, names, warnings) {
  const seen = new Map();
  for (const name of names) {
    if (!isSet(env, name)) continue;
    const other = seen.get(env[name]);
    if (other) warnings.push(`${name} and ${other} share a value; use a different random secret for each`);
    else seen.set(env[name], name);
  }
}

function featureFlags(env, warnings) {
  const off = [];
  // Eddy joins the AI features a missing key turns off (Eddy 7.10); the optimizer makes no AI drafts, so it is not named.
  if (!isSet(env, "ANTHROPIC_API_KEY")) off.push("AI assistant, Eddy and creative copy (ANTHROPIC_API_KEY)");
  const razorpay = isSet(env, "RAZORPAY_KEY_ID") && isSet(env, "RAZORPAY_KEY_SECRET");
  if (!razorpay) off.push("Razorpay billing (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET)");
  else if (!isSet(env, "RAZORPAY_WEBHOOK_SECRET")) warnings.push("RAZORPAY_WEBHOOK_SECRET is not set; Razorpay webhooks cannot be verified");
  if (!isSet(env, "SMTP_HOST") || !isSet(env, "SMTP_USER")) off.push("Outgoing email (SMTP_HOST, SMTP_USER)");
  if (!isSet(env, "META_LOGIN_CONFIG_ID")) off.push("Meta Connect for Pages, Instagram and ads (META_LOGIN_CONFIG_ID)");
  return off;
}

// MAX_DAILY_BUDGET_MINOR is deprecated (Spend 4.4, 4.14): when set it is read as an INR platform daily ads ceiling of
// ceil(1.75 x value). It is no longer a feature that is "off" when unset; setting it earns a deprecation warning.
function checkLegacyBudgetCeiling(env, warnings) {
  if (!isSet(env, "MAX_DAILY_BUDGET_MINOR")) return;
  if (!/^[1-9]\d{0,17}$/.test(env.MAX_DAILY_BUDGET_MINOR.trim())) warnings.push("MAX_DAILY_BUDGET_MINOR must be a positive integer in minor units; it is ignored until it is one");
  else warnings.push("MAX_DAILY_BUDGET_MINOR is deprecated; it is read as an INR platform daily ads ceiling of 1.75 x its value. Set platform ceilings in /admin/spending/settings, then remove it");
}

// WhatsApp quick-reply payloads (spdec:, spopt:) are signed with SPEND_NOTIFY_SECRET (Spend 7.4, 4.14). Optional until the
// owner notifications (WP-15) ship; when it is set it must be a real 32-byte secret.
function checkNotifySecret(env, errors) {
  if (!isSet(env, "SPEND_NOTIFY_SECRET")) return;
  const value = env.SPEND_NOTIFY_SECRET.trim();
  if (PLACEHOLDER.test(value)) errors.push("SPEND_NOTIFY_SECRET looks like a placeholder");
  else if (decodedSecretBytes(value) < 32) errors.push("SPEND_NOTIFY_SECRET must be at least 32 random bytes, hex or base64 encoded (openssl rand -hex 32)");
}

// Spend controls rollout flags (docs/SPEND-CONTROLS-SPEC.md 4.14). src/lib/spend/flags.ts falls back to the safe default on
// an unknown value, so without this check a typo such as SPEND_ENFORCE=enforced would quietly leave enforcement off while the
// operator believes it is on. Values are compared trimmed and lower-cased, as flags.ts reads them.
const SPEND_FLAG_VALUES = {
  SPEND_ENFORCE: ["observe", "enforce"],
  SPEND_TRIPWIRE: ["report", "enforce"],
  SPEND_CAP_MODE: ["off", "observe", "enforce"],
  ASSISTANT_SPEND_ENABLED: ["false", "true"],
  SPEND_DRY_RUN: ["0", "1", "false", "true", "no", "yes", "off", "on"],
  SPEND_SIM: ["0", "1", "false", "true", "no", "yes", "off", "on"],
};
const ON_VALUES = ["1", "true", "yes", "on"];

function checkSpendFlags(env, errors, warnings) {
  for (const [name, allowed] of Object.entries(SPEND_FLAG_VALUES)) {
    if (!isSet(env, name)) continue;
    if (!allowed.includes(env[name].trim().toLowerCase())) errors.push(`${name} must be one of ${allowed.join(", ")}`);
  }
  if (env.NODE_ENV !== "production") return;
  if (isSet(env, "SPEND_DRY_RUN") && ON_VALUES.includes(env.SPEND_DRY_RUN.trim().toLowerCase())) errors.push("SPEND_DRY_RUN must not be on in production (no Meta writes would happen)");
  if (isSet(env, "SPEND_SIM") && ON_VALUES.includes(env.SPEND_SIM.trim().toLowerCase())) warnings.push("SPEND_SIM is on in production; synthetic insights apply to sandbox ad accounts only");
}

/** The models Eddy's request shape works on; keep equal to EDDY_SUPPORTED_MODELS in src/lib/eddy/contract.ts (a test checks). */
export const EDDY_SUPPORTED_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5"];

/** The fields every EDDY_PRICES model needs, in USD per million tokens (src/lib/spend/exec/ai-pricing.ts). */
export const EDDY_PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];
const MAX_PRICE = 1000;

/**
 * Why an EDDY_PRICES override would be ignored, or null when it parses. The same rules as parsePriceOverride in
 * src/lib/spend/exec/ai-pricing.ts, but the message names the variable only, never a model id or a price from the value.
 */
export function eddyPricesProblem(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "EDDY_PRICES is not valid JSON";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "EDDY_PRICES must be a JSON object of models";
  for (const [model, value] of Object.entries(parsed)) {
    if (!/^claude-[a-z0-9.-]{3,60}$/.test(model)) return "EDDY_PRICES has a key that is not a Claude model id";
    if (!value || typeof value !== "object" || Array.isArray(value)) return "EDDY_PRICES must give each model an object of prices";
    for (const field of EDDY_PRICE_FIELDS) {
      const n = value[field];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_PRICE) {
        return `EDDY_PRICES needs ${EDDY_PRICE_FIELDS.join(", ")} for every model, each a price from 0 to ${MAX_PRICE} (USD per million tokens)`;
      }
    }
  }
  return null;
}

// Eddy's switches and tuning values. src/lib/eddy/contract.ts falls back to the default on a bad value, so a typo such as
// EDDY_ENABLED=True would quietly leave Eddy off; the startup check names it instead.
const EDDY_FLAG_VALUES = {
  EDDY_ENABLED: ["false", "true"],
  EDDY_PHASE: ["1", "2"],
  EDDY_EFFORT: ["low", "medium", "high", "xhigh", "max"],
  EDDY_FALLBACKS: ["on", "off"],
  EDDY_INJECTION_SCREEN: ["off", "on"],
  EDDY_ANTHROPIC_KEY_DEDICATED: ["false", "true"],
};
const EDDY_NUMBERS = {
  EDDY_MAX_TOKENS: [2000, 128000],
  EDDY_MAX_CREDITS_PER_USER_DAY: [1, 1000000000],
  EDDY_MAX_CREDITS_PER_TURN: [1, 1000000000],
  EDDY_MAX_CONCURRENT_TURNS: [1, 10000],
  EDDY_MICROUSD_PER_CREDIT: [1, 1000000000],
};

// Eddy (docs/EDDY-SPEC.md 7.10, 12.1a decision 14).
function checkEddy(env, errors, warnings) {
  if (isSet(env, "EDDY_MODEL")) {
    const model = env.EDDY_MODEL.trim();
    const allowed = (env.AI_ALLOWED_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    if (!/^claude-[a-z0-9.-]{3,60}$/.test(model)) errors.push("EDDY_MODEL must be a Claude model id such as claude-sonnet-5-5");
    else if (!EDDY_SUPPORTED_MODELS.includes(model)) errors.push(`EDDY_MODEL must be one of ${EDDY_SUPPORTED_MODELS.join(", ")}, the models Eddy's requests work on`);
    else if (allowed.length > 0 && !allowed.includes(model)) errors.push("EDDY_MODEL must also be listed in AI_ALLOWED_MODELS");
  }
  if (isSet(env, "EDDY_TAIL_CACHE_TTL") && !["5m", "1h"].includes(env.EDDY_TAIL_CACHE_TTL.trim())) errors.push("EDDY_TAIL_CACHE_TTL must be 5m or 1h");
  for (const [name, allowed] of Object.entries(EDDY_FLAG_VALUES)) {
    if (isSet(env, name) && !allowed.includes(env[name].trim().toLowerCase())) errors.push(`${name} must be one of ${allowed.join(", ")}`);
  }
  for (const [name, [min, max]] of Object.entries(EDDY_NUMBERS)) {
    if (!isSet(env, name)) continue;
    const raw = env[name].trim();
    if (!/^\d{1,10}$/.test(raw) || Number(raw) < min || Number(raw) > max) errors.push(`${name} must be a whole number from ${min} to ${max}`);
  }
  const prices = eddyPricesProblem(env.EDDY_PRICES);
  if (prices) errors.push(prices);
  const enabled = isSet(env, "EDDY_ENABLED") && env.EDDY_ENABLED.trim().toLowerCase() === "true";
  if (enabled && !isSet(env, "ANTHROPIC_API_KEY")) warnings.push("EDDY_ENABLED is true but ANTHROPIC_API_KEY is not set, so Eddy stays off for every workspace");
  if (env.NODE_ENV !== "production") return;
  if (isSet(env, "EDDY_FAKE_MODEL")) errors.push("EDDY_FAKE_MODEL must not be set in production (it replaces the real model with scripted replies)");
  // 12.1a decision 14: a recommendation to the owner, not a build or start blocker. The gateway hard stop, the new-workspace
  // AI limits and Eddy being off by default protect spend until wa has its own key with a console spend limit.
  const dedicated = isSet(env, "EDDY_ANTHROPIC_KEY_DEDICATED") && env.EDDY_ANTHROPIC_KEY_DEDICATED.trim().toLowerCase() === "true";
  if (enabled && !dedicated) {
    warnings.push("EDDY_ENABLED is true but EDDY_ANTHROPIC_KEY_DEDICATED is not; give wa its own Anthropic key with a monthly spend limit set in the Anthropic console, then set EDDY_ANTHROPIC_KEY_DEDICATED=true (docs/ops.md)");
  }
}

// Android app (docs/PLAY-STORE.md): /.well-known/assetlinks.json ties the Trusted Web Activity to this site. Both variables are
// optional; src/lib/android/asset-links.ts serves the file only from the valid values below and answers 404 otherwise.
export const DEFAULT_ANDROID_PACKAGE = "com.edwyz.wa";
const ANDROID_PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SHA256_FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;
// Placeholders that look like fingerprints: one byte repeated 32 times, and the sample printed in Google's Digital Asset Links docs.
const SAMPLE_FINGERPRINTS = ["14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5"];
const isPlaceholderFingerprint = (value) => /^([0-9A-F]{2})(:\1){31}$/.test(value) || SAMPLE_FINGERPRINTS.includes(value);

/** ANDROID_PACKAGE trimmed, com.edwyz.wa when unset, or null when the value set is not an Android package name. */
export function androidPackage(env = process.env) {
  if (!isSet(env, "ANDROID_PACKAGE")) return DEFAULT_ANDROID_PACKAGE;
  const name = env.ANDROID_PACKAGE.trim();
  return name.length <= 255 && ANDROID_PACKAGE_NAME.test(name) ? name : null;
}

/**
 * Splits a comma-separated ANDROID_ASSETLINKS_SHA256 into the fingerprints that may be served (32 colon-separated hex bytes,
 * upper-cased, de-duplicated, placeholders refused) and the number of entries that are ignored.
 */
export function assetLinkFingerprints(raw) {
  const valid = [];
  let invalid = 0;
  for (const part of String(raw ?? "").split(",")) {
    const value = part.trim().toUpperCase();
    if (!value) continue;
    if (!SHA256_FINGERPRINT.test(value) || isPlaceholderFingerprint(value)) invalid += 1;
    else if (!valid.includes(value)) valid.push(value);
  }
  return { valid, invalid };
}

function checkAndroid(env, warnings) {
  if (androidPackage(env) === null) warnings.push("ANDROID_PACKAGE is not an Android package name such as com.edwyz.wa; /.well-known/assetlinks.json answers 404 until it is");
  if (!isSet(env, "ANDROID_ASSETLINKS_SHA256")) return;
  const { valid, invalid } = assetLinkFingerprints(env.ANDROID_ASSETLINKS_SHA256);
  if (invalid > 0) {
    const none = valid.length === 0 ? "; no valid one is left, so /.well-known/assetlinks.json answers 404" : "";
    warnings.push(`ANDROID_ASSETLINKS_SHA256 has ${invalid} malformed or placeholder fingerprint(s), which are ignored; each must be 32 colon-separated hex bytes (AB:CD:...) as keytool and Play Console print them${none}`);
  }
}

/** @returns {{ errors: string[], warnings: string[], disabled: string[] }} */
export function checkEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  checkDatabaseUrl(env, errors);
  checkSecret(env, "SESSION_SECRET", 32, errors);
  checkEncryptionKey(env, errors);
  checkSecret(env, "WORKER_SECRET", 16, errors);
  // Meta connect state is keyed from STATE_SECRET and refuses anything under 32 characters in production (meta-connect/state.ts), so the deploy check must too.
  checkSecret(env, "STATE_SECRET", env.NODE_ENV === "production" ? 32 : 16, errors);
  checkSiteUrl(env, warnings);
  checkMediaSecrets(env, errors);
  checkInstanceCount(env, warnings);
  checkDistinct(env, ["SESSION_SECRET", "STATE_SECRET", "WORKER_SECRET", "META_VERIFY_TOKEN", "CONTENT_MEDIA_SECRET", "CREATIVE_MEDIA_SECRET", "SPEND_NOTIFY_SECRET"], warnings);

  if (!isSet(env, "META_APP_SECRET")) warnings.push("META_APP_SECRET is empty; webhook signatures cannot be verified and WhatsApp events are rejected");
  for (const name of ["META_APP_ID", "META_VERIFY_TOKEN", "META_ES_CONFIG_ID"]) {
    if (!isSet(env, name)) warnings.push(`${name} is empty; WhatsApp signup or webhooks will not work until it is set`);
  }
  if (!isSet(env, "PLATFORM_ADMIN_EMAILS")) warnings.push("PLATFORM_ADMIN_EMAILS is empty; nobody can open /admin");

  checkCspMode(env, errors, warnings);
  if (isSet(env, "LOG_LEVEL") && !LOG_LEVELS.includes(env.LOG_LEVEL.toLowerCase())) warnings.push("LOG_LEVEL must be one of debug, info, warn, error");
  checkSpendFlags(env, errors, warnings);
  checkLegacyBudgetCeiling(env, warnings);
  checkNotifySecret(env, errors);
  checkEddy(env, errors, warnings);
  checkAndroid(env, warnings);

  return { errors, warnings, disabled: featureFlags(env, warnings) };
}
