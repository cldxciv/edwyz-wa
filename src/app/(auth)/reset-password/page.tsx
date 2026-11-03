import Link from "next/link";
import { AuthForm } from "@/components/site/auth-ui";
import { AuthNotice, AuthTitle, textLink } from "@/components/site/auth-title";
import { pageMetadata } from "@/components/site/seo";
import { COMPANY } from "@/lib/config";
import { emailConfigured } from "@/lib/email/availability";

export const metadata = pageMetadata({
  title: "Choose a new password",
  description: "Choose a new Edwyz WA password.",
  path: "/reset-password",
  noindex: true,
});

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  if (!token) {
    return (
      <>
        <AuthTitle title="Choose a new password" />
        {/* Same advice as /forgot-password: while email is switched off there is no new link to request, so point to the mailbox instead. */}
        <AuthNotice tone="alert">
          This reset link is incomplete. Open the full link from the email
          {emailConfigured() ? (
            <>
              , or{" "}
              <Link href="/forgot-password" className={textLink}>
                request a new one
              </Link>
              .
            </>
          ) : (
            <>
              . If you no longer have it, write to{" "}
              <a href={`mailto:${COMPANY.email}?subject=Password%20reset`} className={textLink}>
                {COMPANY.email}
              </a>{" "}
              from the email address on your account and we will help you sign in again.
            </>
          )}
        </AuthNotice>
        <p className="mt-6 text-sm">
          <Link href="/login" className={textLink}>
            Back to sign in
          </Link>
        </p>
      </>
    );
  }
  return (
    <>
      <AuthTitle title="Choose a new password" intro="You will be signed out on all devices once it is changed." />
      <div className="mt-8">
        <AuthForm
          url="/api/auth/reset-password"
          extra={{ token }}
          submitLabel="Change password"
          busyLabel="Saving..."
          fields={[{ name: "password", label: "New password", type: "password", autoComplete: "new-password", validate: "newPassword", strength: true, autoFocus: true }]}
          done={{
            message: (
              <>
                <strong className="font-semibold">Your password was changed.</strong>{" "}
                <Link href="/login" className={textLink}>
                  Sign in
                </Link>
              </>
            ),
          }}
        />
      </div>
      <p className="mt-6 text-sm">
        <Link href="/login" className={textLink}>
          Back to sign in
        </Link>
      </p>
    </>
  );
}
