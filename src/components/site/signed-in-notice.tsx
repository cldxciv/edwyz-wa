"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { textLink } from "./auth-title";
import { submitClass } from "./auth-ui";

const secondaryClass =
  "inline-flex w-full items-center justify-center rounded-full border border-border bg-background px-6 py-3 text-base font-semibold hover:bg-surface";

type Props = {
  email: string;
  next?: string;
  /** Without children: the sentence after "You are already signed in as ...", above the page's own form. */
  hint?: string;
  /** With children: the button that reveals them, and the sentence shown with them. */
  switchLabel?: string;
  switchNote?: string;
  children?: ReactNode;
};

/**
 * Shown on the sign-in, sign-up and forgot-password pages when a session already exists, so signing in again (which
 * switches this browser to another account) is a deliberate choice rather than a surprise.
 *
 * With children (the sign-in and sign-up forms) the page shows only this notice, with "Continue to the app" first, and the form
 * is not rendered, so not focused, until the person picks `switchLabel`: an autofilled form and a stray Enter must not sign
 * anyone else in. Without children (forgot password) the notice sits above the page's own form and offers a sign-out.
 */
export function SignedInNotice({ email, hint, next = "/app", switchLabel = "Sign in as someone else", switchNote, children }: Props) {
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin" });
    } catch {
      // The cookies are cleared by the server; if the call failed the reload shows the notice again.
    }
    window.location.reload();
  }

  const who = (
    <>
      You are already signed in as <strong className="font-semibold">{email}</strong>.
    </>
  );

  if (children !== undefined) {
    if (switching) {
      return (
        <>
          <div data-signed-in-notice className="mt-6 rounded-xl border border-border bg-surface p-4 text-sm leading-relaxed">
            <p>
              {who} {switchNote}
            </p>
            <p className="mt-2">
              <Link href={next} className={textLink}>
                Continue to the app instead
              </Link>
            </p>
          </div>
          {children}
        </>
      );
    }
    return (
      <div data-signed-in-notice className="mt-6">
        <p className="rounded-xl border border-border bg-surface p-4 text-sm leading-relaxed">{who}</p>
        <div className="mt-6 space-y-3">
          <Link href={next} className={submitClass}>
            Continue to the app
          </Link>
          <button type="button" onClick={() => setSwitching(true)} className={secondaryClass}>
            {switchLabel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-signed-in-notice className="mt-6 rounded-xl border border-border bg-surface p-4 text-sm leading-relaxed">
      <p>
        {who} {hint}
      </p>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        <Link href={next} className={textLink}>
          Continue to the app
        </Link>
        <button type="button" onClick={signOut} disabled={busy} className={`${textLink} disabled:opacity-60`}>
          {busy ? "Signing out..." : "Sign out"}
        </button>
      </p>
    </div>
  );
}
