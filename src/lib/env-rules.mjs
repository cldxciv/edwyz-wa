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

// Rate limits are shared through Postgres (src/lib/ratelimit), but replay guards, the live inbox connection count and the AI reply
// guard still live in process memory (docs/ops.md section 2, last table).
function checkInstanceCount(env, warnings) {
  const raw = env.WEB_INSTANCES ?? env.WEB_CONCURRENCY;
  if (raw !== undefined && Number(raw) > 1) {
    warnings.push("More than one web instance is configured; replay guards, the live inbox connection count and the AI reply guard are kept in process memory, so run exactly one pm2 instance of the web app (see docs/ops.md)");
  }
}

// src/lib/ratelimit also knows `table`, but the RateLimitBucket table it writes to has no migration yet (docs/schema-requests.md):
// that value would make every limiter fail its database write and count per process only, with a warning a minute.
function checkRateLimitBackend(env, errors, warnings) {
  if (!isSet(env, "RATELIMIT_BACKEND")) return;
  const value = env.RATELIMIT_BACKEND.trim();
  if (value !== "settings" && value !== "memory") {
    return errors.push("RATELIMIT_BACKEND must be settings (the default) or memory; table needs the RateLimitBucket table, which has no migration yet");
  }
  if (value === "memory" && env.NODE_ENV === "production") {
    warnings.push("RATELIMIT_BACKEND is memory; rate limits are kept per process and reset on every restart. Remove the line to share them through the database");
  }
}

// The same rule as emailVerificationRequired() in src/lib/auth/verification.ts (tests/ops-env.test.ts keeps the two in step):
// true or false forces the gate, anything else counts as unset, and unset means on only when SMTP_USER is set.
const TRUE_VALUES = ["true", "1", "yes", "on"];
const FALSE_VALUES = ["false", "0", "no", "off"];
const UNVERIFIED_CAN = "an unconfirmed signup can send messages, run broadcasts, import contacts, create API keys and connect Meta";

function checkEmailVerification(env, warnings) {
  const forced = (env.EMAIL_VERIFICATION_REQUIRED ?? "").trim().toLowerCase();
  if (forced && !TRUE_VALUES.includes(forced) && !FALSE_VALUES.includes(forced)) {
    warnings.push("EMAIL_VERIFICATION_REQUIRED must be true or false; any other value counts as unset");
  }
  if (env.NODE_ENV !== "production") return;
  const mail = Boolean(env.SMTP_USER);
  if (FALSE_VALUES.includes(forced)) warnings.push(`EMAIL_VERIFICATION_REQUIRED is false, so email verification is not enforced: ${UNVERIFIED_CAN}`);
  else if (TRUE_VALUES.includes(forced)) {
    if (!mail) warnings.push("EMAIL_VERIFICATION_REQUIRED is true but SMTP_USER is not set, so no confirmation email can be sent and every new signup stays read-only");
  } else if (!mail) {
    warnings.push(`Email verification is not enforced because SMTP_USER is not set (EMAIL_VERIFICATION_REQUIRED is unset): ${UNVERIFIED_CAN}. Set the SMTP lines and it turns on by itself`);
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
    warnings.push("CSP_MODE is not enforce; the enforced policy still allows inline scripts. Set CSP_MODE=enforce once the report-only log shows only the expected violations (docs/ops.md section 6)");
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
  } else if (!dedicated && isSet(env, "ANTHROPIC_API_KEY")) {
    // With Eddy off the AI reply bot, inbox suggestions and creative copy still spend on this key, so the same advice applies.
    warnings.push("ANTHROPIC_API_KEY is set but EDDY_ANTHROPIC_KEY_DEDICATED is not true; the AI reply bot, inbox suggestions and creative copy may run on a shared key with no spend limit of its own. Give wa its own Anthropic key with a monthly spend limit set in the Anthropic console, then set EDDY_ANTHROPIC_KEY_DEDICATED=true (docs/ops.md)");
  }
}

// Instagram and Facebook Page ads (docs/IG-PAGE-ADS-SPEC.md 1.4, 9.3, 9.7, 11.2 risk 24; PRM-00). src/lib/promote/flags.ts
// falls back to the safe default on an unknown value, so a typo such as PROMOTE_ENABLED=yes would quietly keep the feature
// dark; the startup check names it instead. Values are compared trimmed and lower-cased, as flags.ts reads them.

/** The goal keys PROMOTE_GOALS may list (spec 4.4); keep equal to PROMOTE_GOAL_KEYS in src/lib/promote/flags.ts (a test checks). */
export const PROMOTE_GOAL_KEYS = [
  "whatsapp_chats", "lead_form", "website_visits", "instagram_dms", "messenger_chats", "website_sales", "profile_visits",
  "engagement", "video_views", "awareness", "page_likes", "any_chat",
];
export const PROMOTE_PAGE_LANG_VALUES = ["en", "hi", "hinglish"];
const SWITCH_VALUES = ["0", "1", "false", "true", "no", "yes", "off", "on"];

/** The single-value promote flags and what each accepts. */
export const PROMOTE_FLAG_VALUES = {
  PROMOTE_ENABLED: ["off", "admins", "on"],
  PROMOTE_PREVIEWS: ["meta", "local"],
  PROMOTE_VIDEO: ["off", "file_url", "resumable"],
  PROMOTE_AUDIENCES: ["off", "engagement", "all"],
  LEGAL_DPDP_AUDIENCES_OK: SWITCH_VALUES,
  PROMOTE_EXPERIMENTAL: SWITCH_VALUES,
  META_LOGIN_POPUP: SWITCH_VALUES,
};

/** The comma-list promote flags and the items each may hold. */
export const PROMOTE_LIST_VALUES = { PROMOTE_GOALS: PROMOTE_GOAL_KEYS, PROMOTE_PAGE_LANGS: PROMOTE_PAGE_LANG_VALUES };

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/** True for an http or https address on 127.0.0.1, localhost or [::1], with no user, password, query or fragment. */
export function isLoopbackGraphBaseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password || url.search || url.hash) return false;
  return LOOPBACK_HOSTS.includes(url.hostname);
}

/**
 * The fake Meta server's address for tests (spec 9.3), or null. GRAPH_BASE_URL counts only outside production and only on a
 * loopback address, the same rule the startup check applies, so a misconfigured staging or live server still talks to Meta
 * (risk 24). src/lib/graph/index.ts reads it through here (PRM-03).
 */
export function testGraphBaseUrl(env = process.env) {
  if (!isSet(env, "GRAPH_BASE_URL") || (env.NODE_ENV ?? "").trim() === "production") return null;
  const raw = env.GRAPH_BASE_URL.trim();
  return isLoopbackGraphBaseUrl(raw) ? raw.replace(/\/+$/, "") : null;
}

function checkPromote(env, errors, warnings) {
  for (const [name, allowed] of Object.entries(PROMOTE_FLAG_VALUES)) {
    if (isSet(env, name) && !allowed.includes(env[name].trim().toLowerCase())) errors.push(`${name} must be one of ${allowed.join(", ")}`);
  }
  for (const [name, allowed] of Object.entries(PROMOTE_LIST_VALUES)) {
    if (!isSet(env, name)) continue;
    const items = env[name].split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    if (items.some((item) => !allowed.includes(item))) errors.push(`${name} must be a comma-separated list of ${allowed.join(", ")}`);
  }
  const graph = isSet(env, "GRAPH_BASE_URL");
  if (env.NODE_ENV !== "production") {
    if (graph && !isLoopbackGraphBaseUrl(env.GRAPH_BASE_URL)) {
      errors.push("GRAPH_BASE_URL must be an http or https address on 127.0.0.1, localhost or [::1] (the fake Meta server for tests); remove it to call Meta");
    }
    return;
  }
  // The same rule as SPEND_DRY_RUN: a test-only override never reaches the live deployment.
  if (graph) errors.push("GRAPH_BASE_URL must not be set in production (every Graph call would go to a test server instead of Meta)");
  const value = (name) => (isSet(env, name) ? env[name].trim().toLowerCase() : "");
  if (value("PROMOTE_AUDIENCES") === "all" && !ON_VALUES.includes(value("LEGAL_DPDP_AUDIENCES_OK"))) {
    errors.push("PROMOTE_AUDIENCES=all needs LEGAL_DPDP_AUDIENCES_OK=1 in production (customer lists wait for the lawyer's review); use engagement until then");
  }
  if (value("PROMOTE_ENABLED") === "on" && (value("SPEND_ENFORCE") !== "enforce" || value("SPEND_TRIPWIRE") !== "enforce")) {
    errors.push("PROMOTE_ENABLED=on needs SPEND_ENFORCE=enforce and SPEND_TRIPWIRE=enforce in production (train P3); use admins until both are on");
  }
  if (ON_VALUES.includes(value("PROMOTE_EXPERIMENTAL"))) {
    warnings.push("PROMOTE_EXPERIMENTAL is on in production; ad options Meta has not been verified for show only in workspaces whose ad account is a Meta test account");
  }
}

// Studio images, Canva and Meta's ads MCP (docs/specs/ADS-MCP-CANVA-CREATIVE-SPEC.md 5.8, D25; MCC-00). Every switch is off by
// default, so nothing reaches customers before the owner turns it on. src/lib/studio/flags.ts and src/lib/meta-ads-mcp/flags.ts
// fall back to off (or the default number) on an unknown value; the startup check names the typo instead. Values are compared
// trimmed and lower-cased, as the readers do.

/** The on|off switches of Studio, Canva and the ads MCP. Each is off unless set to on. */
export const STUDIO_FLAG_VALUES = {
  STUDIO_ENABLED: ["off", "on"],
  CANVA_VIDEO: ["off", "on"],
  META_ADS_MCP: ["off", "on"],
  META_ADS_MCP_RULES: ["off", "on"],
};
/** Whole-number settings: [min, max, default]. */
export const STUDIO_NUMBERS = {
  STUDIO_DAILY_RENDERS: [10, 5000, 100],
  META_ADS_MCP_DAILY_CALLS: [50, 10000, 600],
};
/** CREATIVE_IMAGE_PROVIDER values. `brand` (the Studio renderer) needs STUDIO_ENABLED=on. */
export const CREATIVE_IMAGE_PROVIDERS = ["brand", "placeholder", "http"];
/** Addresses of the fake Canva and ads MCP servers for tests: refused in production, loopback only elsewhere (5.8). */
export const STUDIO_TEST_URLS = ["CANVA_API_BASE_URL", "CANVA_AUTH_BASE_URL", "META_ADS_MCP_URL"];

/** A test-only URL when it may be used: outside production and on a loopback address (the GRAPH_BASE_URL rule); else null. */
function testOnlyUrl(env, name) {
  if (!isSet(env, name) || (env.NODE_ENV ?? "").trim() === "production") return null;
  const raw = env[name].trim();
  return isLoopbackGraphBaseUrl(raw) ? raw.replace(/\/+$/, "") : null;
}

/** The fake Canva server's API and sign-in addresses for tests, each null unless usable (outside production, loopback only). */
export function testCanvaBaseUrls(env = process.env) {
  return { api: testOnlyUrl(env, "CANVA_API_BASE_URL"), auth: testOnlyUrl(env, "CANVA_AUTH_BASE_URL") };
}

/** The fake ads MCP server's address for tests, or null (outside production, loopback only). */
export function testMetaAdsMcpUrl(env = process.env) {
  return testOnlyUrl(env, "META_ADS_MCP_URL");
}

function checkStudio(env, errors, warnings) {
  for (const [name, allowed] of Object.entries(STUDIO_FLAG_VALUES)) {
    if (isSet(env, name) && !allowed.includes(env[name].trim().toLowerCase())) errors.push(`${name} must be one of ${allowed.join(", ")}`);
  }
  for (const [name, [min, max]] of Object.entries(STUDIO_NUMBERS)) {
    if (!isSet(env, name)) continue;
    const raw = env[name].trim();
    if (!/^\d{1,10}$/.test(raw) || Number(raw) < min || Number(raw) > max) errors.push(`${name} must be a whole number from ${min} to ${max}`);
  }
  const value = (name) => (isSet(env, name) ? env[name].trim().toLowerCase() : "");
  const studioOn = value("STUDIO_ENABLED") === "on";
  if (isSet(env, "CREATIVE_IMAGE_PROVIDER")) {
    if (!CREATIVE_IMAGE_PROVIDERS.includes(env.CREATIVE_IMAGE_PROVIDER.trim())) errors.push(`CREATIVE_IMAGE_PROVIDER must be one of ${CREATIVE_IMAGE_PROVIDERS.join(", ")}`);
    else if (env.CREATIVE_IMAGE_PROVIDER.trim() === "brand" && !studioOn) warnings.push("CREATIVE_IMAGE_PROVIDER is brand but STUDIO_ENABLED is not on; the brand images need Studio, so set STUDIO_ENABLED=on or use placeholder");
  }
  if (isSet(env, "DISABLE_SYSTEM_FONTS_LOAD") && env.DISABLE_SYSTEM_FONTS_LOAD.trim() !== "1") errors.push("DISABLE_SYSTEM_FONTS_LOAD must be 1 (images are drawn with the bundled fonts only) or unset");
  else if (studioOn && !isSet(env, "DISABLE_SYSTEM_FONTS_LOAD")) warnings.push("STUDIO_ENABLED is on but DISABLE_SYSTEM_FONTS_LOAD is not 1; set it so images are drawn with the bundled fonts only");

  const id = isSet(env, "CANVA_CLIENT_ID");
  const secret = isSet(env, "CANVA_CLIENT_SECRET");
  if (id && !secret) errors.push("CANVA_CLIENT_ID is set but CANVA_CLIENT_SECRET is not; set both from the Canva Developer Portal, or neither");
  if (!id && secret) warnings.push("CANVA_CLIENT_SECRET is set but CANVA_CLIENT_ID is not, so Canva stays off");
  if (secret && PLACEHOLDER.test(env.CANVA_CLIENT_SECRET.trim())) errors.push("CANVA_CLIENT_SECRET looks like a placeholder");
  if (id && secret && !studioOn) warnings.push("CANVA_CLIENT_ID and CANVA_CLIENT_SECRET are set but STUDIO_ENABLED is not on, so Canva stays off; Canva works only with Studio on");

  const production = env.NODE_ENV === "production";
  for (const name of STUDIO_TEST_URLS) {
    if (!isSet(env, name)) continue;
    // The same rule as GRAPH_BASE_URL: a test-only override never reaches the live deployment.
    if (production) errors.push(`${name} must not be set in production (it points the app at a test server instead of the real service)`);
    else if (!isLoopbackGraphBaseUrl(env[name])) errors.push(`${name} must be an http or https address on 127.0.0.1, localhost or [::1] (a fake server for tests); remove it to use the real service`);
  }
}

/** Studio features that are off because their configuration is missing (listed only while STUDIO_ENABLED is on). */
function studioDisabled(env) {
  if (!isSet(env, "STUDIO_ENABLED") || env.STUDIO_ENABLED.trim().toLowerCase() !== "on") return [];
  return isSet(env, "CANVA_CLIENT_ID") && isSet(env, "CANVA_CLIENT_SECRET") ? [] : ["Canva designs in Creative Studio (CANVA_CLIENT_ID, CANVA_CLIENT_SECRET)"];
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
  checkRateLimitBackend(env, errors, warnings);
  checkEmailVerification(env, warnings);
  checkSpendFlags(env, errors, warnings);
  checkLegacyBudgetCeiling(env, warnings);
  checkNotifySecret(env, errors);
  checkEddy(env, errors, warnings);
  checkPromote(env, errors, warnings);
  checkStudio(env, errors, warnings);
  checkAndroid(env, warnings);

  return { errors, warnings, disabled: [...featureFlags(env, warnings), ...studioDisabled(env)] };
}
