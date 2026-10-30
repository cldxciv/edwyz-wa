import { readJsonLimited } from "@/lib/http/body";
import { HttpError } from "@/lib/tenancy";

export function readJson(request: Request): Promise<Record<string, unknown>> {
  return readJsonLimited(request);
}

export function str(body: Record<string, unknown>, key: string, label: string, max = 200, required = true): string {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${label} is required.`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `${label} is not valid.`);
  const t = v.trim();
  if (required && !t) throw new HttpError(400, `${label} is required.`);
  if (t.length > max) throw new HttpError(400, `${label} is too long.`);
  return t;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function email(body: Record<string, unknown>, key = "email"): string {
  const e = str(body, key, "Email", 254).toLowerCase();
  if (!EMAIL.test(e)) throw new HttpError(400, "Enter a valid email address.");
  return e;
}

export function password(body: Record<string, unknown>, key = "password", required = true): string {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, "Password is required.");
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, "Password is not valid.");
  return v;
}

export function jsonWithCookies(data: unknown, cookies: string[] = [], status = 200): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(data), { status, headers });
}

export function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
