import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * docs/EDDY-SPEC.md 6.15, 12.1a decision 10, EDDY-07 acceptance 5: no Meta link anywhere in Eddy's code, copy, the action
 * layer or help.json's display fields, except src/lib/eddy/meta-links.ts, which holds the three no-API screens (payment method
 * after 131042, business verification, display-name review) shown only as a labelled "Opens Meta" link.
 * E-R2 (docs/IG-PAGE-ADS-SPEC.md 6.3, PRM-13): the `meta_screen` UI hint is resolved on the server (meta-links.ts delegates
 * the ads screens to meta-connect/meta-screens.ts), and ActionCard renders it only for an allowlisted key and Meta's own https
 * address, as a labelled button with an external-link icon that opens a new tab.
 */
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import knowledge from "@/lib/eddy/knowledge/help.json";
import { isMetaHref, META_LINK_SCREENS, metaLinkFor, metaScreenForError, metaScreenHint, metaScreenHintFromHref } from "@/lib/eddy/meta-links";
import { explainCode, searchHelp } from "@/lib/actions/defs/help";
import { ActionCard, MetaScreenButton, safeMetaLink, safeMetaScreenHint } from "@/components/eddy/ActionCard";
import { META_SCREEN_HINT_KEYS } from "@/lib/eddy/contract";
import { hasKey, t } from "@/lib/eddy/i18n";
import { metaScreenHref } from "@/lib/meta-connect/meta-screens";
import { META_SCREEN_KEYS } from "@/lib/promote/types";

const ROOT = path.resolve(__dirname, "..");
const META_HOST = /facebook\.com|business\.facebook\.com|meta\.com|fb\.me/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (full: string) => path.relative(ROOT, full).split(path.sep).join("/");
const ALLOWED = new Set(["src/lib/eddy/meta-links.ts", "src/lib/eddy/knowledge/help.json"]);
const SCANNED = [path.join(ROOT, "src/lib/eddy"), path.join(ROOT, "src/components/eddy"), path.join(ROOT, "src/lib/actions")].flatMap((d) => walk(d));

type Entry = { id: string; title: string; keywords: string[]; body: string; source: string; lastReviewed: string };
const ENTRIES = (knowledge as { entries: Entry[] }).entries;

describe("no Meta links outside meta-links.ts (6.15)", () => {
  it("scans src/lib/eddy, src/components/eddy and src/lib/actions", () => {
    expect(SCANNED.length).toBeGreaterThan(30);
    expect(SCANNED.map(rel)).toContain("src/lib/eddy/meta-links.ts");
  });

  it("no file names facebook.com, business.facebook.com, meta.com or fb.me, except meta-links.ts", () => {
    const offenders = SCANNED.filter((f) => !ALLOWED.has(rel(f)) && META_HOST.test(readFileSync(f, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("help.json's display fields (title, keywords, body) hold no Meta host and no link; source is never returned", () => {
    for (const e of ENTRIES) {
      const display = [e.title, e.body, ...e.keywords].join(" ");
      expect(META_HOST.test(display), e.id).toBe(false);
      expect(/https?:\/\//i.test(display), e.id).toBe(false);
    }
    expect(searchHelp("payment method business verification display name 131042", 5)[0].entry.id).toBe("meta_only_steps");
    // search_help returns id, title, body and lastReviewed only; tests/actions-defs.test.ts checks the tool's result.
  });

  it("help.json covers the 4.6 topics, and every entry has a source and a lastReviewed date (EDDY-05 acceptance 10)", () => {
    const ids = ENTRIES.map((e) => e.id);
    for (const topic of ["window_24h", "template_categories", "opt_in", "quality_rating", "messaging_limits", "pricing_basics", "coexistence", "spending_limits"]) expect(ids).toContain(topic);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of ENTRIES) {
      expect(e.source.trim().length, e.id).toBeGreaterThan(5);
      expect(e.lastReviewed, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.title.length > 5 && e.body.length > 40 && e.keywords.length > 2, e.id).toBe(true);
    }
    // The owner's spending defaults (12.1a): new workspaces at INR 2,000 a day and 20,000 a month; worst case 1.75x and 7x.
    const spending = ENTRIES.find((e) => e.id === "spending_limits")!.body;
    for (const fact of ["₹2,000 a day", "₹20,000 a month", "1.75 times", "7 times", "always works", "owner only"]) expect(spending).toContain(fact);
  });

  it("the catalogue names no Meta URL, and its link label is Opens Meta", () => {
    expect(t("en", "link.opens_meta")).toBe("Opens Meta");
    for (const lang of ["en", "hi", "hinglish"] as const) expect(META_HOST.test(t(lang, "meta.screen.note"))).toBe(false);
  });
});

describe("meta-links.ts: exactly the three no-API screens (12.1a decision 10)", () => {
  it("each screen has an https Meta business URL and the Opens Meta label, and the card accepts it", () => {
    expect([...META_LINK_SCREENS]).toEqual(["payment_method", "business_verification", "display_name"]);
    for (const screen of META_LINK_SCREENS) {
      const link = metaLinkFor(screen)!;
      expect(link.labelKey).toBe("link.opens_meta");
      expect(new URL(link.url).protocol).toBe("https:");
      expect(new URL(link.url).hostname).toBe("business.facebook.com");
      expect(safeMetaLink(link)).toEqual({ screen, url: link.url });
    }
  });

  it("anything else gets no link", () => {
    for (const bad of ["connect", "ads", "", null, undefined, 131042, "payment_method "]) expect(metaLinkFor(bad)).toBeNull();
  });

  it("maps 131042 to the payment-method screen and 131037 to display-name review; other codes to none", () => {
    expect(metaScreenForError("131042")).toBe("payment_method");
    expect(metaScreenForError(131037)).toBe("display_name");
    expect(metaScreenForError("131047")).toBeNull();
    expect(metaScreenForError(null)).toBeNull();
  });

  it("explain_error gives the screen id, never the URL, so the model can never write the link itself", async () => {
    const out = await explainCode("131042");
    expect(out).toMatchObject({ code: "131042", fix: "meta_payment_method", metaScreen: "payment_method" });
    expect(META_HOST.test(JSON.stringify(out))).toBe(false);
    expect((await explainCode("131047")).metaScreen).toBeNull();
  });
});

describe("E-R2: the meta_screen UI hint (IG-PAGE-ADS-SPEC 6.3, 6.6, 8.4)", () => {
  const IDS = { pageId: "1234567890", act: "act_987654321" };
  const appeal = { kind: "meta_screen", key: "appeal_ad", href: "https://www.facebook.com/accountquality/", labelKey: "promote.status.appeal" };

  it("its keys are exactly Eddy's three screens plus the ads screens of meta-screens.ts (the only allowlist of their addresses)", () => {
    expect([...META_SCREEN_HINT_KEYS].sort()).toEqual([...new Set<string>([...META_LINK_SCREENS, ...META_SCREEN_KEYS])].sort());
  });

  it("resolves every allowlisted key on the server: Eddy's three from meta-links.ts, the ads screens from meta-screens.ts", async () => {
    for (const key of META_SCREEN_HINT_KEYS) {
      const hint = await metaScreenHint(key, IDS);
      expect(hint, key).not.toBeNull();
      expect(hint!.kind).toBe("meta_screen");
      expect(isMetaHref(hint!.href), key).toBe(true);
      const own = (META_LINK_SCREENS as readonly string[]).includes(key);
      expect(hint!.href, key).toBe(own ? metaLinkFor(key)!.url : metaScreenHref(key, IDS));
      expect(hasKey(hint!.labelKey), `${key}: ${hint!.labelKey}`).toBe(true);
      expect(safeMetaScreenHint(hint), key).toEqual(hint);
    }
    // A screen whose address needs an id that is missing or malformed gives no half-built link.
    expect(await metaScreenHint("leadgen_tos", {})).toBeNull();
    expect(await metaScreenHint("custom_audience_tos", { act: "act_12x" })).toBeNull();
    for (const bad of ["connect", "events_manager_pixel", "", null, 5, "appeal_ad "]) expect(await metaScreenHint(bad, IDS)).toBeNull();
  });

  it("metaScreenHintFromHref takes only the screen's own address, ids digits only", async () => {
    const href = metaScreenHref("leadgen_tos", IDS)!;
    expect(await metaScreenHintFromHref("leadgen_tos", href)).toEqual({ kind: "meta_screen", key: "leadgen_tos", href, labelKey: "promote.readiness.leadgen_tos.fix" });
    expect(await metaScreenHintFromHref("leadgen_tos", href.replace("1234567890", "12x4"))).toBeNull();
    expect(await metaScreenHintFromHref("leadgen_tos", "https://www.facebook.com/ads/leadgen/tos?page_id=1&next=https://evil.example")).toBeNull();
    expect(await metaScreenHintFromHref("appeal_ad", href)).toBeNull();
    expect(await metaScreenHintFromHref("payment_method", metaLinkFor("payment_method")!.url)).toMatchObject({ key: "payment_method", labelKey: "meta.screen.payment_method" });
    expect(await metaScreenHintFromHref("payment_method", "https://business.facebook.com/somewhere/else")).toBeNull();
    for (const bad of ["https://evil.example/ads/leadgen/tos?page_id=1", "javascript:alert(1)", "http://www.facebook.com/ads/leadgen/tos?page_id=1", null]) {
      expect(await metaScreenHintFromHref("leadgen_tos", bad), String(bad)).toBeNull();
    }
    expect(await metaScreenHintFromHref("not_a_screen", href)).toBeNull();
  });

  it("renders only an allowlisted key with an https Meta address: a labelled button with an external-link icon, in a new tab", () => {
    const html = renderToStaticMarkup(createElement(MetaScreenButton, { hint: appeal, lang: "en" }));
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('data-eddy-meta-screen="appeal_ad"');
    expect(html).toMatch(/aria-label="[^"]*Opens Meta[^"]*"/);
    expect(html).toContain("<svg");
    const bad = [
      { ...appeal, key: "events_manager_pixel" },
      { ...appeal, href: "https://evil.example/accountquality/" },
      { ...appeal, href: "javascript:alert(1)" },
      { ...appeal, href: "http://www.facebook.com/accountquality/" },
      { ...appeal, href: "https://user:pw@www.facebook.com/accountquality/" },
      { ...appeal, kind: "navigate" },
      { ...appeal, labelKey: "Not a key!" },
      null,
      "appeal_ad",
    ];
    for (const hint of bad) {
      expect(safeMetaScreenHint(hint), JSON.stringify(hint)).toBeNull();
      expect(renderToStaticMarkup(createElement(MetaScreenButton, { hint, lang: "en" })), JSON.stringify(hint)).toBe("");
    }
  });

  it("ActionCard shows the button for a valid hint and nothing for any other", () => {
    const card = (metaScreen: unknown) => renderToStaticMarkup(createElement(ActionCard, { lang: "en", title: "Fix this", metaScreen }));
    expect(card(appeal)).toContain('data-eddy-meta-screen="appeal_ad"');
    expect(card({ ...appeal, key: "connect" })).not.toContain("data-eddy-meta");
    expect(card(undefined)).not.toContain("data-eddy-meta");
  });
});
