import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { assertPublicUrl, defaultResolver, type Resolver } from "@/lib/integrations/ssrf";
import { HttpError } from "@/lib/tenancy";

export const PAGE_TIMEOUT_MS = 5_000;
/** Bytes read from a page at most. Script-heavy pages are large, so far more is read than is kept. */
export const PAGE_MAX_BYTES = 3 * 1024 * 1024;
/** Characters kept from a page once its scripts, styles and inline drawings are dropped (dropped while reading, so they never fill this). */
export const PAGE_KEEP_CHARS = 512 * 1024;
const MAX_REDIRECTS = 3;

export type PageRequest = { url: URL; address: string; timeoutMs: number; maxBytes: number; keepChars: number };
export type PageResponse = { status: number; contentType: string; location: string | null; body: string };
export type PageTransport = (req: PageRequest) => Promise<PageResponse>;

/** Blocks that hold no readable text. Their content is skipped up to the matching closing tag. */
const SKIPPED = /<(script|style|noscript|svg|template)\b/i;
/** Text held back at the end of each piece, so a tag split across two network chunks is still recognised. */
const TAIL = 16;

/**
 * Removes script, style, noscript, svg and template blocks from HTML as it streams in. push() takes the next piece of text and
 * returns what can already be kept; end() returns the rest. A block that never closes is dropped to the end of the page.
 */
export function createScriptStripper(): { push: (text: string) => string; end: () => string } {
  let pending = "";
  let skipping: string | null = null;
  const drain = (final: boolean): string => {
    let out = "";
    for (;;) {
      if (skipping) {
        const close = pending.toLowerCase().indexOf(`</${skipping}`);
        const gt = close < 0 ? -1 : pending.indexOf(">", close);
        if (gt < 0) {
          // Still inside the block: drop it, keeping only enough to spot a closing tag that arrives in two pieces.
          pending = final ? "" : pending.slice(close < 0 ? -TAIL : close);
          return out;
        }
        pending = pending.slice(gt + 1);
        skipping = null;
        out += " ";
        continue;
      }
      const open = SKIPPED.exec(pending);
      if (!open) {
        const cut = final ? pending.length : Math.max(0, pending.length - TAIL);
        out += pending.slice(0, cut);
        pending = pending.slice(cut);
        return out;
      }
      out += pending.slice(0, open.index);
      skipping = open[1].toLowerCase();
      pending = pending.slice(open.index + open[0].length);
    }
  };
  return {
    push: (text) => {
      pending += text;
      return drain(false);
    },
    end: () => drain(true),
  };
}

/**
 * Connects only to the pre-validated address (defeats DNS rebinding), reads at most maxBytes and keeps at most keepChars. HTML
 * loses its scripts and styles while it streams, so a page whose text sits after a large script bundle is still read.
 */
export const pinnedPageTransport: PageTransport = (req) =>
  new Promise((resolve, reject) => {
    const family = isIP(req.address) === 6 ? 6 : 4;
    const call = httpsRequest(
      {
        method: "GET",
        hostname: req.url.hostname.replace(/^\[|\]$/g, ""),
        port: req.url.port || 443,
        path: `${req.url.pathname}${req.url.search}`,
        headers: { "user-agent": "Edwyz-AiAgent/1.0", accept: "text/html, text/plain;q=0.9" },
        timeout: req.timeoutMs,
        lookup: (_host, options, callback) => {
          if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: req.address, family }]);
          else callback(null, req.address, family);
        },
      },
      (res) => {
        const contentType = String(res.headers["content-type"] ?? "");
        const decoder = new StringDecoder("utf8");
        const strip = contentType.toLowerCase().includes("html") ? createScriptStripper() : null;
        let kept = "";
        let size = 0;
        let finished = false;
        const keep = (text: string) => {
          if (kept.length < req.keepChars) kept += strip ? strip.push(text) : text;
        };
        const done = () => {
          if (finished) return;
          finished = true;
          if (kept.length < req.keepChars) kept += strip ? strip.push(decoder.end()) + strip.end() : decoder.end();
          resolve({
            status: res.statusCode ?? 0,
            contentType,
            location: typeof res.headers.location === "string" ? res.headers.location : null,
            body: kept.slice(0, req.keepChars),
          });
        };
        res.on("data", (chunk: Buffer) => {
          const room = req.maxBytes - size;
          size += chunk.length;
          if (room > 0) keep(decoder.write(chunk.subarray(0, room)));
          if (size > req.maxBytes || kept.length >= req.keepChars) res.destroy();
        });
        res.on("end", done);
        res.on("close", done);
      },
    );
    call.on("timeout", () => call.destroy(new Error("timeout")));
    call.on("error", reject);
    call.end();
  });

export type PageDeps = { resolve?: Resolver; transport?: PageTransport };

/** Fetches a public https page. Every redirect hop is SSRF-checked. Throws HttpError(400) for anything unusable. */
export async function fetchPage(rawUrl: string, deps: PageDeps = {}): Promise<{ body: string; isHtml: boolean }> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = await assertPublicUrl(current, deps.resolve ?? defaultResolver, "Page addresses");
    let res: PageResponse;
    try {
      res = await (deps.transport ?? pinnedPageTransport)({ url: target.url, address: target.addresses[0], timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES, keepChars: PAGE_KEEP_CHARS });
    } catch {
      throw new HttpError(400, "The page could not be fetched.");
    }
    if (res.status >= 300 && res.status < 400 && res.location) {
      try {
        current = new URL(res.location, target.url).href;
      } catch {
        throw new HttpError(400, "The page redirected to an invalid address.");
      }
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new HttpError(400, `The page returned status ${res.status}.`);
    const type = res.contentType.toLowerCase();
    const isHtml = type.includes("html");
    if (!isHtml && !type.startsWith("text/")) throw new HttpError(400, "Only HTML and plain text pages can be added.");
    return { body: res.body, isHtml };
  }
  throw new HttpError(400, "The page redirected too many times.");
}
