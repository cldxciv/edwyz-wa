import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export type McpHttpRequest = {
  url: URL;
  address: string;
  method: "POST" | "DELETE";
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  maxBytes: number;
};
export type McpHttpResponse = { status: number; headers: Record<string, string>; body: string };
export type McpTransport = (req: McpHttpRequest) => Promise<McpHttpResponse>;

/** Sends to the already-validated address, never follows redirects, aborts once the body exceeds maxBytes. */
export const pinnedMcpTransport: McpTransport = (req) =>
  new Promise((resolve, reject) => {
    const family = isIP(req.address) === 6 ? 6 : 4;
    const call = httpsRequest(
      {
        method: req.method,
        hostname: req.url.hostname.replace(/^\[|\]$/g, ""),
        port: req.url.port || 443,
        path: `${req.url.pathname}${req.url.search}`,
        headers: { ...req.headers, "content-length": Buffer.byteLength(req.body).toString() },
        timeout: req.timeoutMs,
        lookup: (_host, options, callback) => {
          if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: req.address, family }]);
          else callback(null, req.address, family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > req.maxBytes) {
            call.destroy(new Error("too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers[k] = v;
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    call.on("timeout", () => call.destroy(new Error("timeout")));
    call.on("error", reject);
    call.end(req.body);
  });
