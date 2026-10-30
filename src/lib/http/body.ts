import { HttpError } from "@/lib/tenancy";

/** Reads the body as text, enforcing a byte limit while streaming (works for chunked requests with no content-length). */
export async function readTextLimited(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new HttpError(413, "The request body is too large.");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "The request body is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const DEFAULT_JSON_LIMIT = 256 * 1024;

export async function readJsonLimited(request: Request, maxBytes = DEFAULT_JSON_LIMIT): Promise<Record<string, unknown>> {
  const text = await readTextLimited(request, maxBytes);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "The request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "The request body must be a JSON object.");
  return body as Record<string, unknown>;
}
