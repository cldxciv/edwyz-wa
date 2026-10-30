import { siteUrl } from "@/lib/config";
import { HttpError } from "@/lib/tenancy";

/** Call first in every POST/PATCH/DELETE handler. Cookies are SameSite=Lax; this also pins the Origin. */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  let ok = false;
  if (origin) {
    try {
      ok = new URL(origin).host === new URL(siteUrl()).host;
    } catch {
      ok = false;
    }
  }
  if (!ok) throw new HttpError(403, "This request could not be verified. Reload the page and try again.");
}
