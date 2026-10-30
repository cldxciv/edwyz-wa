"use client";

import Link from "next/link";
import { useState } from "react";
import { textLink } from "./auth-title";

/**
 * Shown above the sign-in, sign-up and forgot-password forms when a session already exists, so signing in again (which
 * starts a second session) is a deliberate choice rather than a surprise.
 */
export function SignedInNotice({ email, hint, next = "/app" }: { email: string; hint: string; next?: string }) {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin" });
    } catch {
      // The cookies are cleared by the server; if the call failed the reload shows the notice again.
    }
    window.location.reload();
  }

  return (
    <div data-signed-in-notice className="mt-6 rounded-xl border border-border bg-surface p-4 text-sm leading-relaxed">
      <p>
        You are already signed in as <strong className="font-semibold">{email}</strong>. {hint}
      </p>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        <Link href={next} className={textLink}>
          Go to your workspace
        </Link>
        <button type="button" onClick={signOut} disabled={busy} className={`${textLink} disabled:opacity-60`}>
          {busy ? "Signing out..." : "Sign out"}
        </button>
      </p>
    </div>
  );
}
