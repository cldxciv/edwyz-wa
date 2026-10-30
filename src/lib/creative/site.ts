import { assertPublicUrl, defaultResolver, type Resolver } from "@/lib/integrations/ssrf";
import { pinnedTransport, type PinnedTransport } from "./pinned";

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_BYTES = 300 * 1024;
export const MAX_EXTRA_PAGES = 3;
export const SITE_BUDGET_MS = 30_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "EdwyzBot/1.0 (+https://wa.edwyz.com)";

export type SiteText = { pages: { url: string; text: string }[]; skipped: string[] };

type Rule = { allow: boolean; path: string };

/** Minimal robots.txt reader: our agent group wins over "*"; longest matching rule wins; Allow wins ties. */
export function parseRobots(text: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(m[2].toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      if (m[2]) current.rules.push({ allow: key === "allow", path: m[2] });
    } else lastWasAgent = false;
  }
  const own = groups.filter((g) => g.agents.some((a) => a !== "*" && "edwyzbot".includes(a)));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

function ruleMatches(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("^" + body.join(".*") + (anchored ? "$" : "")).test(path);
}

export function robotsAllows(rules: Rule[], path: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!ruleMatches(path, r.path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

/** Every hop is re-validated against the SSRF rules and the connection is pinned to the validated address. Redirects are followed manually. Each hop has a hard deadline and the whole read shares one budget. Returns null for any failure. */
async function safeGet(rawUrl: string, resolve: Resolver, accept: RegExp | null, transport: PinnedTransport, deadline: number): Promise<{ url: URL; body: string } | null> {
  let target = rawUrl;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const safe = await assertPublicUrl(target, resolve);
      const res = await transport({ url: safe.url, address: safe.addresses[0], timeoutMs: Math.min(FETCH_TIMEOUT_MS, remaining), maxBytes: MAX_BYTES, userAgent: USER_AGENT });
      if (res.status >= 300 && res.status < 400) {
        if (!res.location) return null;
        target = new URL(res.location, safe.url).href;
        continue;
      }
      if (res.status < 200 || res.status >= 300) return null;
      if (accept && !accept.test(res.contentType)) return null;
      return { url: safe.url, body: res.body };
    }
  } catch {
    return null;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(Math.min(Number(e.slice(1)), 0x10ffff)) : ENTITIES[e.toLowerCase()] ?? m))
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const PREFERRED = /about|service|product|solution|pricing|plan|offer|feature|why|how|project|amenit|gallery|contact/i;

export function sameHostLinks(html: string, base: URL, limit = MAX_EXTRA_PAGES): string[] {
  const seen = new Set<string>([base.origin + base.pathname]);
  const scored: { href: string; score: number }[] = [];
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
    let u: URL;
    try {
      u = new URL(m[1].replace(/&amp;/g, "&"), base);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" || u.hostname !== base.hostname || /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|css|js)$/i.test(u.pathname)) continue;
    u.hash = "";
    u.search = "";
    const key = u.origin + u.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push({ href: u.href, score: PREFERRED.test(u.pathname) ? 1 : 0 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.href);
}

/** Single page plus up to three same-host links. Static HTML only, no JavaScript is run. */
export async function fetchSiteText(websiteUrl: string, resolve: Resolver = defaultResolver, transport: PinnedTransport = pinnedTransport): Promise<SiteText> {
  const skipped: string[] = [];
  const deadline = Date.now() + SITE_BUDGET_MS;
  const first = new URL(websiteUrl);
  const robotsRes = await safeGet(`${first.origin}/robots.txt`, resolve, /text\/plain|text\/html|^$/i, transport, deadline);
  const rules = robotsRes ? parseRobots(robotsRes.body) : [];
  if (!robotsAllows(rules, first.pathname || "/")) return { pages: [], skipped: [websiteUrl] };

  const home = await safeGet(first.href, resolve, /text\/html|application\/xhtml/i, transport, deadline);
  if (!home) return { pages: [], skipped: [websiteUrl] };
  const pages = [{ url: home.url.href, text: htmlToText(home.body) }];
  for (const link of sameHostLinks(home.body, home.url)) {
    if (!robotsAllows(rules, new URL(link).pathname)) {
      skipped.push(link);
      continue;
    }
    const page = await safeGet(link, resolve, /text\/html|application\/xhtml/i, transport, deadline);
    if (page && page.url.hostname === home.url.hostname) pages.push({ url: page.url.href, text: htmlToText(page.body) });
    else skipped.push(link);
  }
  return { pages, skipped };
}
