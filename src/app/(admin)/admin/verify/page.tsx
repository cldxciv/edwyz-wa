import { redirect } from "next/navigation";
import { requireAdminIdentityPage } from "@/lib/admin/page";
import { AdminShell } from "@/components/admin/AdminShell";
import { adminPageMetadata } from "@/components/admin/helpers";
import { VerifyForm } from "@/components/admin/SecurityForms";
import { PageHeader } from "@/components/app/PageHeader";

export const dynamic = "force-dynamic";
export const metadata = adminPageMetadata("Verify");

export default async function VerifyPage() {
  const admin = await requireAdminIdentityPage();
  if (!admin.totpEnabled) redirect("/admin/security");
  if (admin.access === "ok") redirect("/admin");
  return (
    <AdminShell email={admin.email} current="">
      <PageHeader title="Confirm it is you" description="Platform admin access needs a second step each session." />
      <VerifyForm />
    </AdminShell>
  );
}
