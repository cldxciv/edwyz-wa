export type CspMode = "report-only" | "enforce";
export type CspHeaders = { request: Record<string, string>; response: Record<string, string> };

export const CSP_REPORT_PATH = "/api/csp-report";

const FACEBOOK_SCRIPT = "https://connect.facebook.net";
const FACEBOOK_FRAMES = ["https://www.facebook.com", "https://web.facebook.com", "https://staticxx.facebook.com"];
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
 * Styles keep 'unsafe-inline' because React style attributes cannot carry a nonce.
 */
export function buildCsp(nonce: string, options: Options = {}): string {
  const script = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", FACEBOOK_SCRIPT, RAZORPAY_SCRIPT];
  if (options.dev) script.push("'unsafe-eval'");
  const directives = [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
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

/** The policy that was in next.config.ts before nonces: kept as the enforced baseline while the strict one is report-only. */
export function buildLegacyCsp(options: Options = {}): string {
  return join([
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${options.dev ? " 'unsafe-eval'" : ""} ${FACEBOOK_SCRIPT} ${RAZORPAY_SCRIPT}`,
    `frame-src ${[...FACEBOOK_FRAMES, ...RAZORPAY_FRAMES].join(" ")}`,
    `connect-src 'self' ${CONNECT.join(" ")}`,
    "img-src 'self' data: https:",
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
