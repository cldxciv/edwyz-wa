import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { assertPublicUrl, defaultResolver, type Resolver } from "@/lib/integrations/ssrf";
import { HttpError } from "@/lib/tenancy";
import { PLACEMENT_SIZES } from "./constants";
import type { GeneratedFile, ImageProvider, ImageRequest } from "./providers";

/** Largest image accepted from the provider, whether it arrives inline or by link. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** A base64 image is a third larger than the file, plus the JSON around it. */
export const MAX_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES * 1.4) + 4096;
export const IMAGE_TIMEOUT_MS = 60_000;
const MAX_TEXT = 1000;

export type HttpImageRequest = {
  url: URL;
  address: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
};
export type HttpImageResponse = { status: number; contentType: string; body: Buffer; truncated: boolean };
export type HttpImageTransport = (req: HttpImageRequest) => Promise<HttpImageResponse>;

/** A connection that dropped mid-download ends with 'close' and a shorter body than announced. Such a body must never be used. */
export function isIncompleteBody(r: { complete: boolean; declared: string | string[] | undefined; received: number }): boolean {
  if (!r.complete) return true;
  const declared = typeof r.declared === "string" && /^\d+$/.test(r.declared.trim()) ? Number(r.declared) : null;
  return declared !== null && declared !== r.received;
}

/**
 * Connects only to the address assertPublicUrl validated (a second DNS lookup cannot redirect the request), never follows redirects,
 * stops reading at maxBytes, reports a body that ended early (dropped connection, fewer bytes than Content-Length) as `truncated`, and has a hard deadline for the whole exchange.
 */
export const pinnedImageTransport: HttpImageTransport = (req) =>
  new Promise((resolve, reject) => {
    const family = isIP(req.address) === 6 ? 6 : 4;
    const payload = req.body;
    const call = httpsRequest(
      {
        method: req.method,
        hostname: req.url.hostname.replace(/^\[|\]$/g, ""),
        port: req.url.port || 443,
        path: `${req.url.pathname}${req.url.search}`,
        headers: { "user-agent": "Edwyz-Creative/1.0", ...req.headers, ...(payload !== undefined ? { "content-length": Buffer.byteLength(payload).toString() } : {}) },
        timeout: req.timeoutMs,
        lookup: (_host, options, callback) => {
          if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: req.address, family }]);
          else callback(null, req.address, family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          const incomplete = truncated || isIncompleteBody({ complete: res.complete, declared: res.headers["content-length"], received: size });
          resolve({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks), truncated: incomplete });
        };
        res.on("data", (chunk: Buffer) => {
          const room = req.maxBytes - size;
          size += chunk.length;
          if (room > 0) chunks.push(chunk.subarray(0, room));
          if (size > req.maxBytes) {
            truncated = true;
            res.destroy();
          }
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
    call.end(payload);
  });

type Sniffed = { contentType: string; ext: string };

/** The real format from the first bytes. The provider's content type is not trusted. */
export function sniffImage(data: Buffer): Sniffed | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { contentType: "image/png", ext: "png" };
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { contentType: "image/jpeg", ext: "jpg" };
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return { contentType: "image/webp", ext: "webp" };
  return null;
}

const cleanText = (v: string, max = MAX_TEXT) => v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * JSON sent to CREATIVE_IMAGE_URL. Documented in docs/creative-image-provider.md.
 * No tenant id, user id or contact data is ever included.
 */
export function buildProviderBody(req: ImageRequest) {
  const { width, height } = PLACEMENT_SIZES[req.placement];
  const subject = cleanText(req.prompt ?? "") || cleanText(req.headline, 300);
  return {
    prompt: cleanText(`Advertising image for "${cleanText(req.brandName, 80)}". ${subject}`),
    headline: cleanText(req.headline, 300),
    brand: { name: cleanText(req.brandName, 80), colors: req.colors.filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 8) },
    placement: req.placement,
    width,
    height,
  };
}

type Config = { url: string; key: string };

function readConfig(env: NodeJS.ProcessEnv): Config | null {
  const url = env.CREATIVE_IMAGE_URL?.trim();
  const key = env.CREATIVE_IMAGE_KEY?.trim();
  return url && key ? { url, key } : null;
}

export type HttpProviderDeps = { resolve?: Resolver; transport?: HttpImageTransport; env?: NodeJS.ProcessEnv; fallback: ImageProvider };

type CallInit = { method: "GET" | "POST"; headers: Record<string, string>; body?: string; maxBytes: number };

async function call(deps: HttpProviderDeps, target: string, init: CallInit): Promise<HttpImageResponse> {
  const safe = await assertPublicUrl(target, deps.resolve ?? defaultResolver);
  return (deps.transport ?? pinnedImageTransport)({ ...init, url: safe.url, address: safe.addresses[0], timeoutMs: IMAGE_TIMEOUT_MS });
}

function decodeBase64(raw: string): Buffer | null {
  const text = raw.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (text.length === 0 || text.length > MAX_IMAGE_BYTES * 1.4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const data = Buffer.from(text, "base64");
  return data.length > 0 && data.length <= MAX_IMAGE_BYTES ? data : null;
}

async function fetchImage(deps: HttpProviderDeps, body: unknown): Promise<Buffer | null> {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (typeof record.image_base64 === "string") return decodeBase64(record.image_base64);
  if (typeof record.image_url === "string") {
    const res = await call(deps, record.image_url, { method: "GET", headers: { accept: "image/png,image/jpeg,image/webp" }, maxBytes: MAX_IMAGE_BYTES });
    return res.status === 200 && !res.truncated && res.body.length > 0 ? res.body : null;
  }
  return null;
}

/**
 * Image provider for any service that follows the JSON contract in docs/creative-image-provider.md. Select it with
 * CREATIVE_IMAGE_PROVIDER=http plus CREATIVE_IMAGE_URL (https) and CREATIVE_IMAGE_KEY. The key is sent as a bearer token and never logged.
 * The call is SSRF-checked and size-limited. Any failure (not configured, timeout, error status, malformed or oversize answer, not an
 * image) falls back to the placeholder and is reported with fallback: true, so no AI credits are charged for it.
 */
export function createHttpImageProvider(deps: HttpProviderDeps): ImageProvider {
  return {
    name: "http",
    metered: true,
    async generate(req) {
      const config = readConfig(deps.env ?? process.env);
      if (!config) {
        console.error("[creative] image provider http is selected but CREATIVE_IMAGE_URL or CREATIVE_IMAGE_KEY is not set; using the placeholder");
        return fallbackFile(deps, req);
      }
      try {
        const res = await call(deps, config.url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${config.key}` },
          body: JSON.stringify(buildProviderBody(req)),
          maxBytes: MAX_RESPONSE_BYTES,
        });
        if (res.status !== 200 || res.truncated) throw new HttpError(502, `The image service answered ${res.status}.`);
        const data = await fetchImage(deps, JSON.parse(res.body.toString("utf8")));
        const kind = data ? sniffImage(data) : null;
        if (!data || !kind) throw new HttpError(502, "The image service did not return a usable image.");
        return { data, contentType: kind.contentType, ext: kind.ext };
      } catch (e) {
        console.error(`[creative] image provider http failed (${e instanceof HttpError ? e.message : "request error"}); using the placeholder`);
        return fallbackFile(deps, req);
      }
    },
  };
}

async function fallbackFile(deps: HttpProviderDeps, req: ImageRequest): Promise<GeneratedFile> {
  return { ...(await deps.fallback.generate(req)), fallback: true };
}
