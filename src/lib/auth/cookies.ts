import { ACCESS_TTL_SECONDS, REFRESH_TTL_MS } from "./tokens";

export const ACCESS_COOKIE = "wa_access";
export const REFRESH_COOKIE = "wa_refresh";

function serialize(name: string, value: string, maxAgeSeconds: number): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export const accessCookie = (token: string) => serialize(ACCESS_COOKIE, token, ACCESS_TTL_SECONDS);
export const refreshCookie = (token: string) => serialize(REFRESH_COOKIE, token, Math.floor(REFRESH_TTL_MS / 1000));
export const authCookies = (access: string, refresh: string) => [accessCookie(access), refreshCookie(refresh)];
export const clearCookies = () => [serialize(ACCESS_COOKIE, "", 0), serialize(REFRESH_COOKIE, "", 0)];

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}
