import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { siteUrl } from "@/lib/config";
import { type AdminIdentity, requireAdminIdentity } from "./auth";

async function identity(): Promise<AdminIdentity> {
  const cookieHeader = (await cookies()).toString();
  try {
    return await requireAdminIdentity(new Request(siteUrl(), { headers: { cookie: cookieHeader } }));
  } catch {
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
