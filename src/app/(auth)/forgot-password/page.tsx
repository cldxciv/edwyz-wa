import Link from "next/link";
import { AuthForm } from "@/components/site/auth-ui";
import { AuthNotice, AuthTitle, textLink } from "@/components/site/auth-title";
import { pageMetadata } from "@/components/site/seo";
import { SignedInNotice } from "@/components/site/signed-in-notice";
import { signedInUser } from "@/lib/auth/signed-in";
import { COMPANY } from "@/lib/config";
import { emailConfigured } from "@/lib/email/availability";

export const metadata = pageMetadata({
  title: "Reset your password",
  description: "Get a link to choose a new Edwyz WA password.",
  path: "/forgot-password",
  noindex: true,
});

export default async function ForgotPasswordPage() {
  const user = await signedInUser();
  const canSend = emailConfigured();
  return (
    <>
      <AuthTitle title="Reset your password" intro={canSend ? "Enter your email and we will send you a link to choose a new password." : undefined} />
      {user && <SignedInNotice email={user.email} hint="To reset the password of a different account, sign out first." />}
      {canSend ? (
        <div className="mt-8">
          <AuthForm
            url="/api/auth/forgot-password"
            submitLabel="Send reset link"
            busyLabel="Sending..."
            fields={[{ name: "email", label: "Email", type: "email", autoComplete: "email", validate: "email", autoFocus: true }]}
            done={{
              message: (
                <>
                  <strong className="font-semibold">Check your email.</strong> If an account exists for that address, we have sent a link. It expires in 1 hour. Look in your spam folder
                  if it does not arrive.
                </>
              ),
            }}
          />
        </div>
      ) : (
        // Email delivery is switched off on this server (no SMTP_USER), so no link could reach anyone. Say so instead of pretending.
        <AuthNotice tone="alert">
          <strong className="font-semibold">Password reset by email is not available yet.</strong> Write to{" "}
          <a href={`mailto:${COMPANY.email}?subject=Password%20reset`} className={textLink}>
            {COMPANY.email}
          </a>{" "}
          from the email address on your account and we will help you sign in again.
        </AuthNotice>
      )}
      <p className="mt-6 text-sm">
        <Link href="/login" className={textLink}>
          Back to sign in
        </Link>
      </p>
    </>
  );
}
