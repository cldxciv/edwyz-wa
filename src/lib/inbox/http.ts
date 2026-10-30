import { readJsonLimited } from "@/lib/http/body";
import { HttpError } from "@/lib/tenancy";

export { assertSameOrigin } from "@/lib/auth/csrf";

export function readJson(request: Request): Promise<Record<string, unknown>> {
  return readJsonLimited(request);
}

export function reqString(body: Record<string, unknown>, key: string, max = 4096): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} is required.`);
  if (value.length > max) throw new HttpError(400, `${key} is too long.`);
  return value;
}

export function optString(body: Record<string, unknown>, key: string, max = 4096): string | undefined {
  if (body[key] === undefined || body[key] === null) return undefined;
  return reqString(body, key, max);
}

export function intParam(value: string | null, fallback?: number): number | undefined {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "Invalid number parameter.");
  return n;
}
