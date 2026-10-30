import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { assertPublicUrl, defaultResolver, type Resolver } from "@/lib/integrations/ssrf";

export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_MAX_BYTES = 64 * 1024;

export type SafeRequest = { url: URL; address: string; method: "GET" | "POST"; body?: string; timeoutMs: number; maxBytes: number };
export type SafeResponse = { status: number; body: string };
export type Transport = (req: SafeRequest) => Promise<SafeResponse>;

/** Connects to the pre-validated address only (defeats DNS rebinding), never follows redirects, caps the response size. */
export const pinnedTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const family = isIP(req.address) === 6 ? 6 : 4;
    const payload = req.method === "POST" ? (req.body ?? "") : undefined;
    const call = httpsRequest(
      {
        method: req.method,
        hostname: req.url.hostname.replace(/^\[|\]$/g, ""),
        port: req.url.port || 443,
        path: `${req.url.pathname}${req.url.search}`,
        headers: {
          "user-agent": "Edwyz-Chatbot/1.0",
          accept: "application/json, text/plain;q=0.8",
          ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() } : {}),
        },
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
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        };
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= req.maxBytes) chunks.push(chunk);
          else res.destroy();
        });
        res.on("end", done);
        res.on("close", done);
      },
    );
    call.on("timeout", () => call.destroy(new Error("timeout")));
    call.on("error", reject);
    call.end(payload);
  });

export type WebhookDeps = { resolve?: Resolver; transport?: Transport };
export type WebhookResult = { ok: boolean; status: number; data: unknown };

/** Server-side call for webhook nodes. Never throws; failures come back as ok: false. */
export async function callWebhook(input: { url: string; method: "GET" | "POST"; body?: string }, deps: WebhookDeps = {}): Promise<WebhookResult> {
  try {
    const target = await assertPublicUrl(input.url, deps.resolve ?? defaultResolver);
    const res = await (deps.transport ?? pinnedTransport)({
      url: target.url,
      address: target.addresses[0],
      method: input.method,
      body: input.body,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
      maxBytes: WEBHOOK_MAX_BYTES,
    });
    let data: unknown = res.body;
    try {
      data = JSON.parse(res.body);
    } catch {
      data = res.body.slice(0, 1024);
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}
