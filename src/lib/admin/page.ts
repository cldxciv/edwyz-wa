import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/auth/cookies";
import { safeNext } from "@/lib/auth/next";
import { verifyAccessToken } from "@/lib/auth/tokens";
import { siteUrl } from "@/lib/config";
import { type AdminIdentity, requireAdminIdentity } from "./auth";

/**
 * True when the 15-minute sign-in is missing or expired but a refresh cookie could renew it. Only the access token itself is
 * checked: a valid token that is not an admin's must answer 404 at once, or /api/auth/continue would send it straight back here.
 */
export function needsRenewal(access: string | undefined, refresh: string | undefined, nowMs = Date.now()): boolean {
  return !!refresh && (!access || verifyAccessToken(access, nowMs) === null);
}

async function identity(): Promise<AdminIdentity> {
  const jar = await cookies();
  const cookieHeader = jar.toString();
  try {
    return await requireAdminIdentity(new Request(siteUrl(), { headers: { cookie: cookieHeader } }));
  } catch {
    // An admin page opened (or reloaded) more than 15 minutes after the last renewal: renew the way the app does and come back.
    // /api/auth/continue answers 404 for /admin when it cannot renew, so a stranger still learns nothing.
    if (needsRenewal(jar.get(ACCESS_COOKIE)?.value, jar.get(REFRESH_COOKIE)?.value)) {
      const path = safeNext((await headers()).get("x-pathname"));
      redirect(`/api/auth/continue?next=${encodeURIComponent(path.startsWith("/admin") ? path : "/admin")}`);
    }
    notFound();
  }
}

/** Gate for every admin page: strangers get the 404 page; eligible admins are sent to enrolment or step-up first. */
export async function requireAdminPage(): Promise<AdminIdentity> {
  const id = await identity();
  if (id.access === "enroll") redirect("/admin/security");
  if (id.access === "verify") redirect("/admin/verify");
  return id;
}

/** For /admin/security and /admin/verify: eligible admin in any step-up state. */
export async function requireAdminIdentityPage(): Promise<AdminIdentity> {
  return identity();
}
