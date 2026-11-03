export type CspMode = "report-only" | "enforce";
export type CspHeaders = { request: Record<string, string>; response: Record<string, string> };

export const CSP_REPORT_PATH = "/api/csp-report";

const FACEBOOK_SCRIPT = "https://connect.facebook.net";
// business.facebook.com: Meta's ad preview iframes (docs/IG-PAGE-ADS-SPEC.md 7.4, D18; the host is VERIFY V-P5). Frames only:
// src/lib/promote/previews.ts keeps nothing but Meta's preview page src on www and business, and the page renders it sandboxed.
const FACEBOOK_FRAMES = ["https://www.facebook.com", "https://web.facebook.com", "https://staticxx.facebook.com", "https://business.facebook.com"];
const RAZORPAY_SCRIPT = "https://checkout.razorpay.com";
const RAZORPAY_FRAMES = ["https://api.razorpay.com", "https://checkout.razorpay.com"];
// The Facebook SDK also talks to www.facebook.com and web.facebook.com (login status, event logging), not only to graph.facebook.com,
// and fetches its app configuration from connect.facebook.net (app_config/json/<app id>) before Embedded Signup can open.
const CONNECT = [
  "https://graph.facebook.com",
  "https://www.facebook.com",
  "https://web.facebook.com",
  FACEBOOK_SCRIPT,
  "https://api.razorpay.com",
  "https://lumberjack.razorpay.com",
];

// The installable app (docs/PLAY-STORE.md): /sw.js and /manifest.webmanifest, both same-origin. worker-src is spelled out because it
// would otherwise fall back to script-src, where 'strict-dynamic' makes browsers ignore 'self' and the worker could not register.
const APP_SHELL = ["worker-src 'self'", "manifest-src 'self'"];

// Video, audio and voice notes in the inbox: same-origin media links, https links a message or an automation may carry, and blob:
// for a file picked in the composer. Without it media-src falls back to default-src 'self' and the player shows "Could not load".
const MEDIA = "media-src 'self' blob: https:";

/**
 * sha256 of THEME_INIT_SCRIPT (src/components/app/theme-core.ts), the one inline script the root layout renders. It runs before
 * first paint on every page, also on pages Next prerenders, where no nonce exists, so it is allowed by its hash: 'strict-dynamic'
 * ignores 'self' and host lists but still honours hashes. A constant, because hashing in the proxy would need async Web Crypto;
 * tests/ops-csp.test.ts recomputes it and fails, printing the new value, when the script changes and this line does not.
 */
export const THEME_INIT_SCRIPT_HASH = "'sha256-s1afG0tB+/OyXeCSWsW/SSbnzV1blgihhDP6kYQs3W8='";

/** Report-only is the default so a wrong value can never switch enforcement on by accident. */
export function cspMode(env: Record<string, string | undefined> = process.env): CspMode {
  return env.CSP_MODE === "enforce" ? "enforce" : "report-only";
}

/** 128 random bits, base64. Uses Web Crypto, so it works in the proxy and in tests. */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

const join = (directives: string[]) => directives.join("; ");

type Options = { dev?: boolean; reportUrl?: string };

/**
 * Nonce-based policy. 'strict-dynamic' lets the nonced Next.js bundles (and the Facebook SDK that
 * ConnectWhatsApp.tsx adds at runtime) load further scripts; the host list is the fallback for browsers without it.
 * The root layout's theme script has no nonce and is allowed by THEME_INIT_SCRIPT_HASH.
 * Styles keep 'unsafe-inline' because React style attributes cannot carry a nonce.
 */
export function buildCsp(nonce: string, options: Options = {}): string {
  const script = ["'self'", `'nonce-${nonce}'`, THEME_INIT_SCRIPT_HASH, "'strict-dynamic'", FACEBOOK_SCRIPT, RAZORPAY_SCRIPT];
  if (options.dev) script.push("'unsafe-eval'");
  const directives = [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    MEDIA,
    "font-src 'self' data:",
    `connect-src 'self' ${CONNECT.join(" ")}${options.dev ? " ws: http:" : ""}`,
    ...APP_SHELL,
    `frame-src ${[...FACEBOOK_FRAMES, ...RAZORPAY_FRAMES].join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  directives.push(`report-uri ${CSP_REPORT_PATH}`);
  if (options.reportUrl) directives.push("report-to csp-endpoint");
  return join(directives);
}

/**
 * The policy that was in next.config.ts before nonces: kept as the enforced baseline while the strict one is report-only.
 * Its script-src must never carry a hash or nonce: browsers then ignore 'unsafe-inline', and every inline script would be blocked.
 * img-src has blob: for the composer's preview of a picked image (Composer.tsx, URL.createObjectURL).
 */
export function buildLegacyCsp(options: Options = {}): string {
  return join([
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${options.dev ? " 'unsafe-eval'" : ""} ${FACEBOOK_SCRIPT} ${RAZORPAY_SCRIPT}`,
    `frame-src ${[...FACEBOOK_FRAMES, ...RAZORPAY_FRAMES].join(" ")}`,
    `connect-src 'self' ${CONNECT.join(" ")}`,
    "img-src 'self' data: blob: https:",
    MEDIA,
    "style-src 'self' 'unsafe-inline'",
    ...APP_SHELL,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]);
}

/**
 * request: headers handed to Next.js, which reads the nonce from the policy header and stamps its own scripts.
 * response: headers for the browser. In report-only mode the legacy policy is still enforced and the strict one only reports.
 */
export function cspHeaders(mode: CspMode, nonce: string, options: Options = {}): CspHeaders {
  const strict = buildCsp(nonce, options);
  const response: Record<string, string> = {};
  if (options.reportUrl) response["Reporting-Endpoints"] = `csp-endpoint="${options.reportUrl}"`;
  if (mode === "enforce") response["Content-Security-Policy"] = strict;
  else {
    response["Content-Security-Policy"] = buildLegacyCsp(options);
    response["Content-Security-Policy-Report-Only"] = strict;
  }
  return { request: { "content-security-policy": strict, "x-nonce": nonce }, response };
}
