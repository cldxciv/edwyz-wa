import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { assertPublicUrl, defaultResolver, type Resolver } from "@/lib/integrations/ssrf";
import { HttpError } from "@/lib/tenancy";

export const PAGE_TIMEOUT_MS = 5_000;
export const PAGE_MAX_BYTES = 200 * 1024;
const MAX_REDIRECTS = 3;

export type PageRequest = { url: URL; address: string; timeoutMs: number; maxBytes: number };
export type PageResponse = { status: number; contentType: string; location: string | null; body: string };
export type PageTransport = (req: PageRequest) => Promise<PageResponse>;

/** Connects only to the pre-validated address (defeats DNS rebinding) and caps the body size. */
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
        const chunks: Buffer[] = [];
        let size = 0;
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            location: typeof res.headers.location === "string" ? res.headers.location : null,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        };
        res.on("data", (chunk: Buffer) => {
          const room = req.maxBytes - size;
          size += chunk.length;
          if (room > 0) chunks.push(chunk.subarray(0, room));
          if (size > req.maxBytes) res.destroy();
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

/** Fetches a public https page once. Every redirect hop is SSRF-checked. Throws HttpError(400) for anything unusable. */
export async function fetchPage(rawUrl: string, deps: PageDeps = {}): Promise<{ body: string; isHtml: boolean }> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = await assertPublicUrl(current, deps.resolve ?? defaultResolver, "Page addresses");
    let res: PageResponse;
    try {
      res = await (deps.transport ?? pinnedPageTransport)({ url: target.url, address: target.addresses[0], timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES });
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
