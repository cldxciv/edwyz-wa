/**
 * The proxy (nginx) overwrites X-Real-IP and X-Forwarded-For with the connecting address, so X-Real-IP is
 * authoritative. If only X-Forwarded-For is present, take the LAST entry: that is the one our trusted proxy
 * appended; earlier entries are client-supplied and must never be used.
 */
export function clientIp(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const parts = request.headers.get("x-forwarded-for")?.split(",").map((p) => p.trim()).filter(Boolean);
  const last = parts?.[parts.length - 1];
  return last ? last.slice(0, 64) : "unknown";
}
