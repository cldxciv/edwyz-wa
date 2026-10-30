import { beforeEach, describe, expect, it } from "vitest";
import { buildCsp, buildLegacyCsp, cspHeaders, cspMode, generateNonce } from "@/lib/security/csp";
import { extractDirectives, flushCspCounts, recordCspReport } from "@/lib/security/csp-report";
import { setLogSink } from "@/lib/log";

const directive = (policy: string, name: string) => policy.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";

describe("nonce", () => {
  it("is 128 bits of base64 and differs per call", () => {
    const a = generateNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(generateNonce()).not.toBe(a);
  });
});

describe("strict policy", () => {
  const nonce = "TESTNONCE123456789012==";
  const policy = buildCsp(nonce);

  it("scripts need the nonce and never allow unsafe-inline or unsafe-eval in production", () => {
    const script = directive(policy, "script-src");
    expect(script).toContain(`'nonce-${nonce}'`);
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it("allows the Facebook SDK and Embedded Signup endpoints", () => {
    expect(directive(policy, "script-src")).toContain("https://connect.facebook.net");
    const frames = directive(policy, "frame-src");
    expect(frames).toContain("https://www.facebook.com");
    expect(frames).toContain("https://web.facebook.com");
    expect(directive(policy, "connect-src")).toContain("https://graph.facebook.com");
  });

  it("lets the Facebook SDK reach www.facebook.com and web.facebook.com in both the strict and the legacy policy", () => {
    for (const p of [policy, buildLegacyCsp()]) {
      const connect = directive(p, "connect-src");
      expect(connect).toContain("https://www.facebook.com");
      expect(connect).toContain("https://web.facebook.com");
      expect(directive(p, "frame-src")).toContain("https://web.facebook.com");
    }
    expect(directive(policy, "connect-src")).not.toContain("*");
  });

  it("lets the Facebook SDK fetch its app_config from connect.facebook.net, not only load its script from there", () => {
    for (const p of [policy, buildLegacyCsp()]) {
      expect(directive(p, "connect-src")).toContain("https://connect.facebook.net");
    }
  });

  it("keeps Razorpay checkout working", () => {
    expect(directive(policy, "script-src")).toContain("https://checkout.razorpay.com");
    expect(directive(policy, "frame-src")).toContain("https://api.razorpay.com");
    expect(directive(policy, "connect-src")).toContain("https://lumberjack.razorpay.com");
  });

  it("locks down framing, plugins, base and form targets, and reports to the endpoint", () => {
    for (const expected of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "default-src 'self'", "report-uri /api/csp-report"]) {
      expect(policy).toContain(expected);
    }
  });

  it("adds unsafe-eval and websockets only in development", () => {
    const dev = buildCsp(nonce, { dev: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toContain("ws:");
    expect(directive(policy, "connect-src")).not.toContain("ws:");
  });

  it("adds report-to only when a reporting endpoint is configured", () => {
    expect(policy).not.toContain("report-to");
    expect(buildCsp(nonce, { reportUrl: "https://wa.edwyz.com/api/csp-report" })).toContain("report-to csp-endpoint");
  });
});

describe("legacy baseline", () => {
  it("is the previous inline-friendly policy", () => {
    const legacy = buildLegacyCsp();
    expect(directive(legacy, "script-src")).toContain("'unsafe-inline'");
    expect(legacy).toContain("frame-ancestors 'none'");
  });
});

describe("installable app (docs/PLAY-STORE.md)", () => {
  const policies = { strict: buildCsp("N0NCE"), strictDev: buildCsp("N0NCE", { dev: true }), legacy: buildLegacyCsp(), legacyDev: buildLegacyCsp({ dev: true }) };

  it("lets the same-origin service worker and manifest load in every policy, and nothing broader", () => {
    for (const [name, policy] of Object.entries(policies)) {
      expect(directive(policy, "worker-src"), name).toBe("worker-src 'self'");
      expect(directive(policy, "manifest-src"), name).toBe("manifest-src 'self'");
      expect(policy.match(/worker-src/g), name).toHaveLength(1);
      expect(policy.match(/manifest-src/g), name).toHaveLength(1);
      expect(policy, name).not.toContain("child-src");
    }
  });

  it("leaves the script policy as it was: no blob: or data: workers, no unsafe-inline in the strict policy", () => {
    expect(directive(policies.strict, "script-src")).not.toMatch(/blob:|data:|'unsafe-inline'/);
    expect(directive(policies.legacy, "script-src")).not.toMatch(/blob:|data:/);
  });

  it("reaches the browser in both CSP modes", () => {
    const reportOnly = cspHeaders("report-only", "N0NCE").response;
    const enforce = cspHeaders("enforce", "N0NCE").response;
    for (const header of [reportOnly["Content-Security-Policy"], reportOnly["Content-Security-Policy-Report-Only"], enforce["Content-Security-Policy"]]) {
      expect(header).toContain("worker-src 'self'");
      expect(header).toContain("manifest-src 'self'");
    }
  });
});

describe("mode", () => {
  it("defaults to report-only and only enforces on the exact value", () => {
    expect(cspMode({})).toBe("report-only");
    expect(cspMode({ CSP_MODE: "report-only" })).toBe("report-only");
    expect(cspMode({ CSP_MODE: "ENFORCE" })).toBe("report-only");
    expect(cspMode({ CSP_MODE: "enforce" })).toBe("enforce");
  });

  it("report-only keeps the legacy policy enforced and sends the strict one as report-only", () => {
    const { request, response } = cspHeaders("report-only", "N0NCE", { reportUrl: "https://wa.edwyz.com/api/csp-report" });
    expect(response["Content-Security-Policy"]).toContain("'unsafe-inline'");
    expect(response["Content-Security-Policy-Report-Only"]).toContain("'nonce-N0NCE'");
    expect(response["Reporting-Endpoints"]).toBe('csp-endpoint="https://wa.edwyz.com/api/csp-report"');
    expect(request["content-security-policy"]).toContain("'nonce-N0NCE'");
    expect(request["x-nonce"]).toBe("N0NCE");
  });

  it("enforce sends the strict policy as the only policy", () => {
    const { response } = cspHeaders("enforce", "N0NCE");
    expect(response["Content-Security-Policy"]).toContain("'nonce-N0NCE'");
    expect(response["Content-Security-Policy"]).not.toContain("'unsafe-inline'; frame");
    expect(response["Content-Security-Policy-Report-Only"]).toBeUndefined();
  });
});

describe("violation reports", () => {
  beforeEach(() => flushCspCounts());

  it("extracts only directive names from the legacy and Reporting API formats", () => {
    const legacy = { "csp-report": { "effective-directive": "script-src-elem", "blocked-uri": "https://evil.example/?token=abc", "document-uri": "https://wa.edwyz.com/app?x=1" } };
    expect(extractDirectives(legacy)).toEqual(["script-src-elem"]);
    const modern = [{ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://x" } }, { type: "deprecation", body: {} }];
    expect(extractDirectives(modern)).toEqual(["img-src"]);
    expect(extractDirectives({ "csp-report": { "violated-directive": "made-up-thing 'self'" } })).toEqual(["other"]);
    expect(extractDirectives("junk")).toEqual([]);
  });

  it("logs counts only", () => {
    const lines: string[] = [];
    setLogSink((_level, line) => lines.push(line));
    recordCspReport(["script-src-elem", "script-src-elem", "img-src"]);
    flushCspCounts();
    setLogSink(null);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ msg: "csp.violations", total: 3, byDirective: { "script-src-elem": 2, "img-src": 1 } });
    expect(lines[0]).not.toContain("http");
  });
});
