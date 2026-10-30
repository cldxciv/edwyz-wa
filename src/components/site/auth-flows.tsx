"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AuthForm, type FieldSpec } from "./auth-ui";
import { AuthNotice, AuthTitle, textLink } from "./auth-title";

type Preview = { email: string; role: string; workspaceName: string; existingUser: boolean };
type InviteState = { kind: "loading" } | { kind: "ready"; preview: Preview } | { kind: "error"; message: string };

const MISSING_INVITE = "This invite link is incomplete. Open the full link you were sent, or ask for a new invite.";

export function AcceptInviteFlow({ token }: { token: string }) {
  const [state, setState] = useState<InviteState>(token ? { kind: "loading" } : { kind: "error", message: MISSING_INVITE });

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(`/api/auth/accept-invite?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as Partial<Preview> & { error?: string };
        if (cancelled) return;
        if (res.ok) setState({ kind: "ready", preview: body as Preview });
        else setState({ kind: "error", message: body.error ?? "This invite link is invalid or has expired. Ask for a new invite." });
      })
      .catch(() => !cancelled && setState({ kind: "error", message: "We could not load this invite. Check your connection and try again." }));
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.kind === "loading") {
    return (
      <>
        <AuthTitle title="Join a workspace" />
        <AuthNotice>Loading your invite...</AuthNotice>
      </>
    );
  }
  if (state.kind === "error") {
    return (
      <>
        <AuthTitle title="Join a workspace" />
        <AuthNotice tone="alert">{state.message}</AuthNotice>
        <p className="mt-6 text-sm text-muted">
          Already have an account?{" "}
          <Link href="/login" className={textLink}>Sign in</Link>
        </p>
      </>
    );
  }

  const { preview } = state;
  const fields: FieldSpec[] = [
    ...(preview.existingUser ? [] : [{ name: "name", label: "Your name", autoComplete: "name", validate: "name" as const, maxLength: 100, autoFocus: true }]),
    preview.existingUser
      ? { name: "password", label: "Your password", type: "password", autoComplete: "current-password", validate: "currentPassword", autoFocus: true, hint: "You already have an account. Enter your password to join." }
      : { name: "password", label: "Choose a password", type: "password", autoComplete: "new-password", validate: "newPassword", strength: true },
  ];
  return (
    <>
      <AuthTitle title={`Join ${preview.workspaceName}`} intro={`You were invited as ${preview.role} using ${preview.email}.`} />
      <div className="mt-8">
        <AuthForm url="/api/auth/accept-invite" fields={fields} extra={{ token }} submitLabel="Join workspace" busyLabel="Joining..." done={{ redirect: "/app" }} />
      </div>
    </>
  );
}

type VerifyState = { kind: "working" } | { kind: "ok" } | { kind: "error"; message: string };

export function VerifyEmailFlow({ token }: { token: string }) {
  const [state, setState] = useState<VerifyState>(
    token ? { kind: "working" } : { kind: "error", message: "This confirmation link is incomplete. Open the full link from the email." },
  );
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    fetch("/api/auth/verify-email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })
      .then(async (res) => {
        if (res.ok) return setState({ kind: "ok" });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setState({ kind: "error", message: body.error ?? "We could not confirm your email. Please try again." });
      })
      .catch(() => setState({ kind: "error", message: "We could not reach the server. Check your connection and try again." }));
  }, [token]);

  return (
    <>
      <AuthTitle title="Confirm your email" />
      {state.kind === "working" && <AuthNotice>Confirming your email...</AuthNotice>}
      {state.kind === "ok" && (
        <AuthNotice>
          Your email address is confirmed.{" "}
          <Link href="/app" className={textLink}>Continue to your workspace</Link>
        </AuthNotice>
      )}
      {state.kind === "error" && (
        <>
          <AuthNotice tone="alert">{state.message}</AuthNotice>
          <p className="mt-6 text-sm text-muted">
            <Link href="/login" className={textLink}>Back to sign in</Link>
          </p>
        </>
      )}
    </>
  );
}
