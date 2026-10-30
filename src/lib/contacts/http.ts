import { readJsonLimited } from "@/lib/http/body";
import { HttpError } from "@/lib/tenancy";

export function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  return readJsonLimited(request);
}

export function optionalString(value: unknown, field: string, max = 200): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) throw new HttpError(400, `${field} must be a string up to ${max} characters.`);
  return value.trim();
}

export function stringArray(value: unknown, field: string, maxItems = 50): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maxItems || value.some((v) => typeof v !== "string" || !v.trim() || v.length > 60)) {
    throw new HttpError(400, `${field} must be an array of up to ${maxItems} short strings.`);
  }
  return [...new Set((value as string[]).map((v) => v.trim()))];
}

export function plainObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 10_000) {
    throw new HttpError(400, `${field} must be a JSON object under 10 KB.`);
  }
  return value as Record<string, unknown>;
}
