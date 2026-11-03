import type { NextConfig } from "next";

// Page CSP (nonce based, CSP_MODE report-only|enforce) is set per request in src/proxy.ts. This policy covers the paths the
// proxy skips: JSON, webhooks and generated files, none of which should ever load or run anything.
const lockedDown = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  trailingSlash: false,
  outputFileTracingRoot: process.cwd(),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
      // Every /api path except the Facebook Login callback. Its popup page sends its own policy, as strict, plus a hash for its
      // one inline script (src/app/api/meta-connect/callback/route.ts). Next keeps a header set here and drops the route's own,
      // so a policy here would stop that script. tests/meta-connect-popup.test.ts checks the effective policy of each path.
      { source: "/api/:path((?!meta-connect/callback/?$).*)", headers: [{ key: "Content-Security-Policy", value: lockedDown }] },
      { source: "/api", headers: [{ key: "Content-Security-Policy", value: lockedDown }] },
      { source: "/webhooks/:path*", headers: [{ key: "Content-Security-Policy", value: lockedDown }] },
      { source: "/health/:path*", headers: [{ key: "Content-Security-Policy", value: lockedDown }] },
      { source: "/health", headers: [{ key: "Content-Security-Policy", value: lockedDown }] },
    ];
  },
};

export default nextConfig;
