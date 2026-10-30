import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { CONTENT_TYPE_BY_EXT, resolveMediaPath } from "./media";

/** Streams a stored media file, with single-range support for video fetchers. Returns 404 for any key that does not resolve. */
export async function serveMedia(request: Request, tenantId: string, key: string, cache: string): Promise<Response> {
  const file = resolveMediaPath(tenantId, key);
  const stat = file ? await fs.stat(file).catch(() => null) : null;
  if (!file || !stat?.isFile()) return new Response("Not found", { status: 404 });
  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPE_BY_EXT[key.split(".")[1]] ?? "application/octet-stream",
    "cache-control": cache,
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
  };
  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(stat.size - Number(range[2]), 0);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${stat.size}` } });
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(body, { status: 206, headers: { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${stat.size}` } });
  }
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { ...headers, "content-length": String(stat.size) } });
}
