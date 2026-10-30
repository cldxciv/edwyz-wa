import Link from "next/link";
import { AuthForm } from "@/components/site/auth-ui";
import { AuthTitle, textLink } from "@/components/site/auth-title";
import { pageMetadata } from "@/components/site/seo";
import { SignedInNotice } from "@/components/site/signed-in-notice";
import { safeNext } from "@/lib/auth/next";
import { signedInUser } from "@/lib/auth/signed-in";

export const metadata = pageMetadata({ title: "Sign in", description: "Sign in to your Edwyz WA workspace.", path: "/login" });

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const [{ next }, user] = await Promise.all([searchParams, signedInUser()]);
  return (
    <>
      <AuthTitle title="Welcome back" intro="Sign in to your Edwyz WA workspace." />
      {user && <SignedInNotice email={user.email} next={safeNext(next)} hint="To use a different account, sign out first." />}
      <div className="mt-8">
        <AuthForm
          url="/api/auth/login"
          submitLabel="Sign in"
          busyLabel="Signing in..."
          done={{ redirect: safeNext(next) }}
          fields={[
            { name: "email", label: "Email", type: "email", autoComplete: "username", validate: "email", autoFocus: true },
            {
              name: "password",
              label: "Password",
              type: "password",
              autoComplete: "current-password",
              validate: "currentPassword",
              labelAction: (
                <Link href="/forgot-password" className="text-sm font-medium underline underline-offset-2">
                  Forgot password?
                </Link>
              ),
            },
          ]}
        />
      </div>
      <p className="mt-6 text-sm text-muted">
        New to Edwyz WA?{" "}
        <Link href="/signup" className={textLink}>
          Start your free trial
        </Link>
      </p>
    </>
  );
}
