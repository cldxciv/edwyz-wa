import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { THEME_INIT_SCRIPT } from "@/components/app/theme-core";
import { buildCsp, buildLegacyCsp, cspHeaders, cspMode, generateNonce, THEME_INIT_SCRIPT_HASH } from "@/lib/security/csp";
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

describe("Meta's ad preview iframes (docs/IG-PAGE-ADS-SPEC.md 7.4, D18, PRM-08; host VERIFY V-P5)", () => {
  const policies = { strict: buildCsp("N0NCE"), strictDev: buildCsp("N0NCE", { dev: true }), legacy: buildLegacyCsp(), legacyDev: buildLegacyCsp({ dev: true }) };

  it("frames business.facebook.com and www.facebook.com in every policy", () => {
    for (const [name, policy] of Object.entries(policies)) {
      const frames = directive(policy, "frame-src");
      expect(frames, name).toContain("https://business.facebook.com");
      expect(frames, name).toContain("https://www.facebook.com");
      expect(policy.match(/frame-src/g), name).toHaveLength(1);
    }
  });

  it("allows the host for frames only: no script, connect or wildcard entry", () => {
    for (const [name, policy] of Object.entries(policies)) {
      expect(directive(policy, "script-src"), name).not.toContain("business.facebook.com");
      expect(directive(policy, "connect-src"), name).not.toContain("business.facebook.com");
      expect(directive(policy, "frame-src"), name).not.toMatch(/\*|https:(\s|$)/);
    }
  });

  it("reaches the browser in both CSP modes", () => {
    const reportOnly = cspHeaders("report-only", "N0NCE").response;
    const enforce = cspHeaders("enforce", "N0NCE").response;
    for (const header of [reportOnly["Content-Security-Policy"], reportOnly["Content-Security-Policy-Report-Only"], enforce["Content-Security-Policy"]]) {
      expect(directive(header, "frame-src")).toContain("https://business.facebook.com");
    }
  });
});

describe("legacy baseline", () => {
  it("is the previous inline-friendly policy", () => {
    const legacy = buildLegacyCsp();
    expect(directive(legacy, "script-src")).toContain("'unsafe-inline'");
    expect(legacy).toContain("frame-ancestors 'none'");
  });

  it("never carries a hash or nonce in script-src, which would make browsers ignore 'unsafe-inline'", () => {
    for (const legacy of [buildLegacyCsp(), buildLegacyCsp({ dev: true })]) {
      expect(directive(legacy, "script-src")).not.toMatch(/'sha256-|'nonce-/);
    }
  });
});

describe("the root layout's inline theme script under the strict policy", () => {
  const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

  it("THEME_INIT_SCRIPT_HASH is the sha256 of THEME_INIT_SCRIPT (update the constant in csp.ts when the script changes)", () => {
    expect(THEME_INIT_SCRIPT_HASH, `set THEME_INIT_SCRIPT_HASH to ${sha256(THEME_INIT_SCRIPT)}`).toBe(sha256(THEME_INIT_SCRIPT));
  });

  it("is allowed by its hash next to the nonce, in production and development, so CSP_MODE=enforce does not block it", () => {
    for (const policy of [buildCsp("N0NCE"), buildCsp("N0NCE", { dev: true }), cspHeaders("enforce", "N0NCE").response["Content-Security-Policy"]]) {
      const script = directive(policy, "script-src");
      expect(script).toContain(THEME_INIT_SCRIPT_HASH);
      expect(script).toContain("'nonce-N0NCE'");
      expect(script).not.toContain("'unsafe-inline'");
    }
  });

  it("the layout renders exactly that script as the element's whole content, with nothing that would change the hash", () => {
    const layout = readFileSync(path.join(__dirname, "..", "src/app/layout.tsx"), "utf8");
    expect(layout).toContain("<script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />");
    expect(THEME_INIT_SCRIPT).not.toMatch(/<\/script|\r/);
  });
});

describe("media and image sources the inbox needs", () => {
  it("both policies let video, audio and voice notes load from the app, blob: and https links", () => {
    for (const policy of [buildCsp("N0NCE"), buildLegacyCsp(), buildCsp("N0NCE", { dev: true }), buildLegacyCsp({ dev: true })]) {
      expect(directive(policy, "media-src")).toBe("media-src 'self' blob: https:");
      expect(policy.match(/media-src/g)).toHaveLength(1);
    }
  });

  it("the enforced legacy policy allows the composer's blob: preview of a picked image, like the strict one", () => {
    expect(directive(buildLegacyCsp(), "img-src")).toBe("img-src 'self' data: blob: https:");
    expect(directive(buildCsp("N0NCE"), "img-src")).toBe("img-src 'self' data: blob: https:");
  });

  it("reaches the browser in both CSP modes", () => {
    const reportOnly = cspHeaders("report-only", "N0NCE").response;
    expect(reportOnly["Content-Security-Policy"]).toContain("media-src 'self' blob: https:");
    expect(reportOnly["Content-Security-Policy-Report-Only"]).toContain("media-src 'self' blob: https:");
    expect(cspHeaders("enforce", "N0NCE").response["Content-Security-Policy"]).toContain("media-src 'self' blob: https:");
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
