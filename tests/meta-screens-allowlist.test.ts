import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

/**
 * docs/IG-PAGE-ADS-SPEC.md 8.4, D19 and PRM-07 acceptance 3 and 6: src/lib/meta-connect/meta-screens.ts is the only source of
 * "Opens Meta" addresses for the ads pages. A grep finds no Meta host in src/lib/promote or src/components/promote, apart from
 * two named exemptions; the allowlist holds exactly the 8.4 keys (account_quality in, events_manager_pixel out), the two Eddy
 * screens come from Eddy's own file, and every address is resolved on the server from validated ids. The button only renders
 * the address it is given.
 */
import { OpensMetaButton, OPENS_META_TEST_ID, safeOpensMetaHref } from "@/components/promote/OpensMetaButton";
import { metaLinkFor } from "@/lib/eddy/meta-links";
import { t as eddyText } from "@/lib/eddy/i18n";
import { isMetaScreenKey, META_SCREENS, metaScreenHref, metaScreensTagged, opensMetaLink, templateParams } from "@/lib/meta-connect/meta-screens";
import { isPromoteCopyKey, PROMOTE_COPY, promoteText } from "@/lib/promote/copy";
import { META_SCREEN_KEYS, PROMOTE_LANGS } from "@/lib/promote/types";

const ROOT = path.resolve(__dirname, "..");
const rel = (full: string) => path.relative(ROOT, full).split(path.sep).join("/");

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx|js|mjs|json)$/.test(name) ? [full] : [];
  });
}

const META_HOST = /facebook\.com/gi;

/**
 * The two named exemptions (8.4), each limited to what it is for:
 * - media.ts may name the resumable upload host rupload.facebook.com (P0-9): an upload host for video bytes, not a screen;
 * - previews.ts may hold the pattern Meta's preview iframe `src` must match (7.4): it checks Meta's markup, it links nowhere.
 */
const EXEMPT: Record<string, { reason: string; allowed: (code: string, index: number) => boolean }> = {
  "src/lib/promote/media.ts": { reason: "rupload.facebook.com is the resumable video upload host (P0-9).", allowed: (code, i) => /rupload\.$/i.test(code.slice(Math.max(0, i - 8), i)) },
  "src/lib/promote/previews.ts": { reason: "The preview iframe src pattern (7.4): it validates Meta's markup.", allowed: () => true },
};

describe("no Meta host in the promote trees (8.4 grep)", () => {
  const files = [...walk(path.join(ROOT, "src/lib/promote")), ...walk(path.join(ROOT, "src/components/promote"))];

  it("scans src/lib/promote and src/components/promote, the button included", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.map(rel)).toContain("src/components/promote/OpensMetaButton.tsx");
    expect(files.map(rel)).toContain("src/lib/promote/prereqs.ts");
    expect(files.map(rel)).toContain("src/lib/promote/sources.ts");
  });

  it("finds 'facebook.com' nowhere except the two named exemptions, and there only for what they are for", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const code = readFileSync(f, "utf8");
      const exempt = EXEMPT[rel(f)];
      for (const m of code.matchAll(META_HOST)) {
        if (!exempt || !exempt.allowed(code, m.index ?? 0)) offenders.push(`${rel(f)}:${code.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
    for (const e of Object.values(EXEMPT)) expect(e.reason.length).toBeGreaterThan(20);
  });

  it("the exemption for media.ts allows only the upload host", () => {
    const allowed = EXEMPT["src/lib/promote/media.ts"].allowed;
    const code = "const a = 'rupload.facebook.com'; const b = 'www.facebook.com';";
    const hits = [...code.matchAll(META_HOST)].map((m) => allowed(code, m.index ?? 0));
    expect(hits).toEqual([true, false]);
  });
});

describe("the allowlist (8.4)", () => {
  it("holds exactly the keys the pure core may point at, with account_quality and without events_manager_pixel", () => {
    expect(Object.keys(META_SCREENS).sort()).toEqual([...META_SCREEN_KEYS].sort());
    expect(Object.keys(META_SCREENS)).toContain("account_quality");
    expect(Object.keys(META_SCREENS)).not.toContain("events_manager_pixel");
    expect(isMetaScreenKey("events_manager_pixel")).toBe(false);
    for (const k of ["leadgen_tos", "custom_audience_tos", "link_whatsapp_to_page", "link_instagram_to_page", "page_advertise_task", "lead_access_manager", "appeal_ad", "account_quality"]) {
      expect(META_SCREENS[k as keyof typeof META_SCREENS].tags, k).toEqual(["promote"]);
    }
  });

  it("each entry has a key, a label key in three languages, an https Meta template, a reason and its tags", () => {
    for (const [key, e] of Object.entries(META_SCREENS)) {
      expect(e.key).toBe(key);
      const u = new URL(e.urlTemplate.replace(/\{(pageId|act)\}/g, "1"));
      expect(u.protocol, key).toBe("https:");
      expect(u.hostname.endsWith("facebook.com"), key).toBe(true);
      expect(e.reason.length, key).toBeGreaterThan(20);
      expect(e.tags.length, key).toBeGreaterThan(0);
      for (const tag of e.tags) expect(["promote", "eddy"]).toContain(tag);
      for (const lang of PROMOTE_LANGS) {
        const label = isPromoteCopyKey(e.labelKey) ? PROMOTE_COPY[lang][e.labelKey] : eddyText.has(e.labelKey) ? eddyText(lang, e.labelKey) : null;
        expect(label, `${key} ${lang}`).toBeTruthy();
        expect(label, `${key} ${lang}`).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it("takes payment_method and business_verification from Eddy's meta-links.ts and tags them for both workstreams", () => {
    expect(META_SCREENS.payment_method.urlTemplate).toBe(metaLinkFor("payment_method")!.url);
    expect(META_SCREENS.business_verification.urlTemplate).toBe(metaLinkFor("business_verification")!.url);
    for (const k of ["payment_method", "business_verification"] as const) expect([...META_SCREENS[k].tags].sort()).toEqual(["eddy", "promote"]);
    expect(metaScreensTagged("eddy").sort()).toEqual(["business_verification", "payment_method"]);
    expect(metaScreensTagged("promote")).toHaveLength(10);
    const source = readFileSync(path.join(ROOT, "src/lib/meta-connect/meta-screens.ts"), "utf8");
    expect(source).not.toContain("billing_hub");
    expect(source).toContain('from "@/lib/eddy/meta-links"');
  });
});

describe("metaScreenHref: resolved on the server from validated ids", () => {
  it("fills the Page id and the ad account number, encoded", () => {
    expect(metaScreenHref("leadgen_tos", { pageId: "104857600123" })).toBe("https://www.facebook.com/ads/leadgen/tos?page_id=104857600123");
    expect(metaScreenHref("custom_audience_tos", { act: "act_123456" })).toBe("https://business.facebook.com/ads/manage/customaudiences/tos/?act=123456");
    expect(metaScreenHref("custom_audience_tos", { act: "123456" })).toBe("https://business.facebook.com/ads/manage/customaudiences/tos/?act=123456");
    expect(metaScreenHref("account_quality")).toBe("https://www.facebook.com/accountquality/");
    expect(templateParams(META_SCREENS.page_advertise_task.urlTemplate)).toEqual(["pageId"]);
  });

  it("gives null for a missing or malformed id and for an unknown key, so no half-built link is shown", () => {
    expect(metaScreenHref("leadgen_tos", {})).toBeNull();
    expect(metaScreenHref("leadgen_tos", { pageId: "12&evil=1" })).toBeNull();
    expect(metaScreenHref("leadgen_tos", { pageId: "javascript:alert(1)" })).toBeNull();
    expect(metaScreenHref("custom_audience_tos", { act: "act_12x" })).toBeNull();
    expect(metaScreenHref("events_manager_pixel")).toBeNull();
    expect(metaScreenHref(42)).toBeNull();
    expect(opensMetaLink("appeal_ad")).toEqual({ key: "appeal_ad", labelKey: "status.appeal", href: "https://www.facebook.com/accountquality/" });
    expect(opensMetaLink("leadgen_tos")).toBeNull();
  });
});

describe("OpensMetaButton (D19)", () => {
  const href = metaScreenHref("leadgen_tos", { pageId: "104857600123" })!;

  it("shows the external-link icon, 'Opens Meta' and the sentence, and opens a new tab with noopener noreferrer", () => {
    const html = renderToStaticMarkup(h(OpensMetaButton, { href, screen: "leadgen_tos", label: "Accept Meta's lead ad terms" }));
    expect(html).toContain(`data-testid="${OPENS_META_TEST_ID}"`);
    expect(html).toContain('data-opens-meta="leadgen_tos"');
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("<svg");
    expect(html).toContain(promoteText("opens_meta.label"));
    expect(html).toContain("Opens Meta");
    expect(html).toContain(promoteText("opens_meta.sentence").replace(/'/g, "&#x27;"));
    expect(html).toContain("Accept Meta&#x27;s lead ad terms");
    // The sentence describes the link for screen readers.
    const described = /aria-describedby="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${described}"`);
  });

  it("reads 'Opens Meta' alone without a label, in Hindi too", () => {
    const html = renderToStaticMarkup(h(OpensMetaButton, { href, screen: "leadgen_tos", lang: "hi" }));
    expect(html).toContain(promoteText("opens_meta.label", {}, "hi"));
    expect(html).toContain(promoteText("opens_meta.sentence", {}, "hi"));
  });

  it("renders nothing for an address that is not https, and never writes one itself", () => {
    for (const bad of [null, undefined, "", "javascript:alert(1)", "http://www.facebook.com/x", "https://user:pw@www.facebook.com/x", "/app/settings"]) {
      expect(renderToStaticMarkup(h(OpensMetaButton, { href: bad, screen: "leadgen_tos" })), String(bad)).toBe("");
      expect(safeOpensMetaHref(bad)).toBeNull();
    }
    const source = readFileSync(path.join(ROOT, "src/components/promote/OpensMetaButton.tsx"), "utf8");
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/facebook/i);
  });
});
