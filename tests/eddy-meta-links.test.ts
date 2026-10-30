import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * docs/EDDY-SPEC.md 6.15, 12.1a decision 10, EDDY-07 acceptance 5: no Meta link anywhere in Eddy's code, copy, the action
 * layer or help.json's display fields, except src/lib/eddy/meta-links.ts, which holds the three no-API screens (payment method
 * after 131042, business verification, display-name review) shown only as a labelled "Opens Meta" link.
 */
vi.mock("@/lib/db", () => ({ prisma: {} }));

import knowledge from "@/lib/eddy/knowledge/help.json";
import { META_LINK_SCREENS, metaLinkFor, metaScreenForError } from "@/lib/eddy/meta-links";
import { explainCode, searchHelp } from "@/lib/actions/defs/help";
import { safeMetaLink } from "@/components/eddy/ActionCard";
import { t } from "@/lib/eddy/i18n";

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
