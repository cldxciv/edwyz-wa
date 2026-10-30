/** Accepts only same-site paths inside the signed-in areas, so a crafted ?next= can never redirect elsewhere. */
export function safeNext(raw: string | null | undefined, fallback = "/app"): string {
  if (!raw || raw.length > 300) return fallback;
  if (!/^\/(app|admin)(\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*)?(\?[A-Za-z0-9\-._~%!$&'()*+,;=:@/?]*)?$/.test(raw)) return fallback;
  if (raw.includes("//") || raw.includes("..")) return fallback;
  return raw;
}
