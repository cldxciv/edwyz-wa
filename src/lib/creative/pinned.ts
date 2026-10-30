import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export type PinnedRequest = { url: URL; address: string; timeoutMs: number; maxBytes: number; userAgent: string; headers?: Record<string, string> };
export type PinnedResponse = { status: number; contentType: string; location: string | null; body: string };
export type PinnedTransport = (req: PinnedRequest) => Promise<PinnedResponse>;

/**
 * Same approach as ai-agent/fetch-page.ts: the socket connects only to the address that assertPublicUrl already validated, so a second DNS
 * lookup cannot point the request somewhere else (DNS rebinding). TLS still verifies the certificate against the original hostname.
 * Kept separate because the site reader identifies itself as EdwyzBot (the name robots.txt rules are matched against).
 * timeoutMs is both the idle limit and a hard deadline for the whole exchange, so a server that drips bytes cannot hold a hop open.
 */
export const pinnedTransport: PinnedTransport = (req) =>
  new Promise((resolve, reject) => {
    const family = isIP(req.address) === 6 ? 6 : 4;
    const call = httpsRequest(
      {
        method: "GET",
        hostname: req.url.hostname.replace(/^\[|\]$/g, ""),
        port: req.url.port || 443,
        path: `${req.url.pathname}${req.url.search}`,
        headers: { "user-agent": req.userAgent, accept: "text/html,text/plain;q=0.9", ...req.headers },
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
    const deadline = setTimeout(() => call.destroy(new Error("deadline")), req.timeoutMs);
    deadline.unref?.();
    call.on("timeout", () => call.destroy(new Error("timeout")));
    call.on("close", () => clearTimeout(deadline));
    call.on("error", reject);
    call.end();
  });
