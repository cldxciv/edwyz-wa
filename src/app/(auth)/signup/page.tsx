import Link from "next/link";
import { AuthForm } from "@/components/site/auth-ui";
import { AuthTitle, textLink } from "@/components/site/auth-title";
import { pageMetadata } from "@/components/site/seo";
import { SignedInNotice } from "@/components/site/signed-in-notice";
import { signedInUser } from "@/lib/auth/signed-in";

export const metadata = pageMetadata({
  title: "Start your free trial",
  description: "Create an Edwyz WA workspace and try the WhatsApp inbox, broadcasts, chatbots and AI replies free. No card needed.",
  path: "/signup",
});

export default async function SignupPage() {
  const user = await signedInUser();
  const form = (
    <>
      <div className="mt-8">
        <AuthForm
          url="/api/auth/signup"
          submitLabel="Create workspace"
          busyLabel="Creating your workspace..."
          done={{ redirect: "/app" }}
          fields={[
            { name: "name", label: "Your name", autoComplete: "name", validate: "name", maxLength: 100, autoFocus: true },
            { name: "email", label: "Work email", type: "email", autoComplete: "email", validate: "email" },
            { name: "workspaceName", label: "Workspace name", autoComplete: "organization", validate: "workspace", maxLength: 100, hint: "Usually your business name." },
            { name: "password", label: "Password", type: "password", autoComplete: "new-password", validate: "newPassword", strength: true },
          ]}
          below={
            <p className="text-xs leading-relaxed text-muted">
              By creating a workspace you agree to our{" "}
              <Link href="/terms" className={textLink}>
                Terms of Service
              </Link>{" "}
              and acknowledge our{" "}
              <Link href="/privacy" className={textLink}>
                Privacy Policy
              </Link>
              .
            </p>
          }
        />
      </div>
      <p className="mt-6 text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className={textLink}>
          Sign in
        </Link>
      </p>
    </>
  );
  return (
    <>
      <AuthTitle title="Start your free trial" intro="Create a workspace for your business. No card needed. You can invite your team afterwards." />
      {/* Signed in already: only the notice, and the form (with its autofocus) appears after the person asks for it. */}
      {user ? (
        <SignedInNotice
          email={user.email}
          switchLabel="Sign up with a different email"
          switchNote="Creating a workspace below signs this browser in to the new account."
        >
          {form}
        </SignedInNotice>
      ) : (
        form
      )}
    </>
  );
}
