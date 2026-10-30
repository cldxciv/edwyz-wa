import { requireAdminIdentityPage } from "@/lib/admin/page";
import { AdminShell } from "@/components/admin/AdminShell";
import { adminPageMetadata } from "@/components/admin/helpers";
import { EnrollForm } from "@/components/admin/SecurityForms";
import { PageHeader } from "@/components/app/PageHeader";
import { Alert, buttonSizes, buttonVariants, Card, cn } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = adminPageMetadata("Security");

export default async function SecurityPage() {
  const admin = await requireAdminIdentityPage();
  return (
    <AdminShell email={admin.email} current="/admin/security">
      <PageHeader title="Admin security" description="Two-factor sign-in protects the platform admin area, which can change any customer's workspace." />
      {admin.totpEnabled ? (
        <Card className="max-w-lg" title="Two-factor sign-in is on">
          {admin.access === "ok" ? (
            <Alert tone="good">This session is verified. You will be asked for a code again after 30 minutes.</Alert>
          ) : (
            <>
              <Alert tone="warn">Your session needs a fresh code before you can use the admin area.</Alert>
              <a className={cn("mt-4 inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.primary, buttonSizes.md)} href="/admin/verify">
                Enter a code
              </a>
            </>
          )}
        </Card>
      ) : (
        <EnrollForm />
      )}
    </AdminShell>
  );
}
