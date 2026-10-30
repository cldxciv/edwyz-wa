import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dropdown } from "@/components/app/Dropdown";
import { notConfiguredNotice } from "@/components/meta-connect/ConnectionsPanel";
import { ReportsView } from "@/components/reports/ReportsView";
import { browserTimeZone, useBrowserTimeZone } from "@/components/reports/useBrowserTimeZone";
import { META_CONNECT_SCOPES } from "@/lib/meta-connect/scopes";

// Fixes for what the QA round found on the workspace screens. Components that need live data are checked by their source
// (the same way the docs tests do), the rest by rendering.

const root = path.join(__dirname, "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("inbox markup", () => {
  it("keeps a name on the Shortcuts button when its text is hidden on phones", () => {
    const line = source("src/components/inbox/InboxApp.tsx").split("\n").find((l) => l.includes(">Shortcuts</span>"));
    expect(line).toBeDefined();
    expect(line).toContain('aria-label="Keyboard shortcuts"');
    expect(line).toContain('className="hidden sm:inline"');
  });

  it("lists contact attributes as a valid dl: a div straight under the dl holding only dt and dd", () => {
    const src = source("src/components/inbox/SidePanel.tsx");
    const start = src.indexOf("<dl", src.indexOf('<Section title="Attributes">'));
    const block = src.slice(start, src.indexOf("</dl>", start)).replace(/\s+/g, " ");
    // The row div holds a dt then a dd and nothing else; the remove button sits inside the dd.
    expect(block).toMatch(/<div key=\{a\.key\}[^>]*>\s*<dt[^>]*>\{a\.key\}<\/dt>\s*<dd[^>]*>/);
    expect(block).not.toMatch(/<div[^>]*>\s*<div[^>]*>\s*<dt/);
    const dd = block.slice(block.indexOf("<dd"), block.indexOf("</dd>"));
    expect(dd).toContain("<button");
  });

  it("makes each quick-reply, emoji and mention option a single control instead of a button inside role=option", () => {
    const src = source("src/components/inbox/Composer.tsx");
    const options: string[] = [];
    for (let at = src.indexOf('role="option"'); at >= 0; at = src.indexOf('role="option"', at + 1)) {
      options.push(src.slice(src.lastIndexOf("<li", at), src.indexOf("</li>", at)));
    }
    expect(options.length).toBe(3);
    for (const li of options) {
      expect(li).not.toContain("<button");
      expect(li).toMatch(/onClick=\{\(\) => pick(Slash|Emoji|Mention)\(i\)\}/);
    }
  });
});

describe("accessible names contain the visible text", () => {
  it("'See contacts' links on Segments", () => {
    const src = source("src/components/segments/SegmentsView.tsx");
    const labels = src.match(/aria-label=\{`See[^`]*`\}/g) ?? [];
    expect(labels.length).toBe(2);
    for (const l of labels) expect(l).toContain("`See contacts in ${");
  });

  it("'Download data' on Reports", () => {
    const src = source("src/components/reports/ReportsView.tsx");
    const start = src.indexOf("<Dropdown");
    const dropdown = src.slice(start, src.indexOf("items={exportItems}", start));
    expect(dropdown).toContain('label="Download data"');
    expect(dropdown).toContain("trigger={<>Download data</>}");
  });
});

describe("MCP connection page", () => {
  it("makes the horizontally scrolling code blocks keyboard focusable, with a name", () => {
    const pre = source("src/components/mcp/McpSettings.tsx").split("\n").find((l) => l.includes("<pre"));
    expect(pre).toBeDefined();
    expect(pre).toContain("overflow-x-auto");
    expect(pre).toContain("tabIndex={0}");
    expect(pre).toContain('role="region"');
    expect(pre).toContain("aria-label={title}");
  });
});

describe("account menu trigger colours", () => {
  const render = (triggerClassName?: string) =>
    renderToStaticMarkup(createElement(Dropdown, { label: "Account", trigger: createElement("span", null, "DO"), items: [], triggerClassName }));

  it("does not put the light hover surface under a trigger that brings its own background", () => {
    const button = /<button[^>]*>/.exec(render("h-9 w-9 bg-accent text-white hover:bg-accent-strong"))?.[0] ?? "";
    expect(button).toContain("hover:bg-accent-strong");
    expect(button).not.toContain("hover:bg-surface");
  });

  it("keeps the default hover surface for plain triggers", () => {
    expect(/<button[^>]*>/.exec(render())?.[0]).toContain("hover:bg-surface");
  });

  it("the account menu itself only ever darkens on hover", () => {
    const line = source("src/components/app/UserMenu.tsx").split("\n").find((l) => l.includes("triggerClassName="));
    expect(line).toContain("bg-accent");
    expect(line).toContain("hover:bg-accent-strong");
    expect(line).not.toContain("hover:bg-surface");
  });
});

describe("Meta connections page copy", () => {
  it("never says Meta is not configured right above a Connected card", () => {
    expect(notConfiguredNotice(true, 0)).toBeNull();
    expect(notConfiguredNotice(true, 2)).toBeNull();
    expect(notConfiguredNotice(false, 0)).toBeNull(); // the empty state explains it
    const withCards = notConfiguredNotice(false, 1);
    expect(withCards).toMatch(/not switched on/);
    expect(withCards).not.toMatch(/not configured/);
    expect(withCards).toMatch(/still work/);
  });

  it("shows the raw Meta user id as a muted detail, not as the card title", () => {
    const src = source("src/components/meta-connect/ConnectionsPanel.tsx");
    expect(src).toContain('<p className="font-semibold">Facebook account</p>');
    expect(src).not.toContain(">Meta user {c.metaUserId}<");
  });
});

describe("browser time zone", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is read after mount, never during server rendering, so the HTML hydrates cleanly", () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions");
    const Probe = () => createElement("span", null, useBrowserTimeZone() ?? "unknown");
    expect(renderToStaticMarkup(createElement(Probe))).toContain("unknown");
    const html = renderToStaticMarkup(createElement(ReportsView));
    expect(spy).not.toHaveBeenCalled();
    expect(html).toContain("Loading reports");
    expect(html).toContain("(UTC)");
  });

  it("falls back to UTC when the browser cannot say", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(() => {
      throw new Error("no zone");
    });
    expect(browserTimeZone()).toBe("UTC");
  });
});

describe("demo workspace sample data", () => {
  const seed = source("scripts/seed-demo.mjs");

  it("gives contacts attributes that look like CRM data, not a demo flag", () => {
    const line = seed.split("\n").find((l) => l.includes("attributes: new J("));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/demo:\s*true/);
    expect(line).toContain("city:");
    expect(line).toMatch(/order/);
  });

  it("uses one of Meta's real rejection codes for the rejected template", () => {
    const reason = /rejectionReason: "([^"]+)"/.exec(seed)?.[1];
    expect(reason).toBeDefined();
    expect(["ABUSIVE_CONTENT", "INVALID_FORMAT", "PROMOTIONAL", "SCAM", "TAG_CONTENT_MISMATCH"]).toContain(reason);
  });

  it("seeds a Meta connection with every permission the app needs, a numeric-looking user id, an expiry and lead alerts on", () => {
    const scopesBlock = /const DEMO_META_SCOPES = \[([^\]]+)\]/.exec(seed)?.[1] ?? "";
    const scopes = [...scopesBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    for (const s of META_CONNECT_SCOPES) expect(scopes, s).toContain(s);
    expect(seed).not.toContain("demo-meta-user-");
    expect(seed).toMatch(/metaUserId: demoMetaUserId/);
    expect(seed).toMatch(/demoMetaUserId = `1000\$\{/);
    const conn = seed.slice(seed.indexOf('await put("MetaConnection"'), seed.indexOf('await put("MetaAsset"'));
    expect(conn).toContain("tokenExpiresAt: ago(-");
    expect(conn).toContain("lastCheckedAt: ago(HOUR)");
    const page = seed.slice(seed.indexOf('type: "page"'), seed.indexOf("// ---------- 12."));
    expect(page).toContain('leadgenSubscription: { status: "subscribed"');
  });
});
