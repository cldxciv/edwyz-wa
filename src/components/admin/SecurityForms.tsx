"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, apiFetch, Button, Card, CopyButton, FormField, Input } from "@/components/ui";
import { QrCode } from "./QrCode";

export function VerifyForm() {
  const router = useRouter();
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get("value") ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/admin/verify", { method: "POST", body: recovery ? { recoveryCode: value } : { code: value } });
      router.replace("/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <Card className="max-w-md" title="Enter your code" description={recovery ? "Enter one of your recovery codes. Each one works only once." : "Open your authenticator app and enter the 6-digit code it shows."}>
      <form onSubmit={submit} className="space-y-4">
        <FormField label={recovery ? "Recovery code" : "6-digit code"} required>
          <Input key={recovery ? "recovery" : "code"} name="value" inputMode={recovery ? "text" : "numeric"} autoComplete="one-time-code" autoFocus required maxLength={recovery ? 20 : 6} aria-invalid={error ? true : undefined} />
        </FormField>
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={busy}>
            Continue
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setRecovery(!recovery);
              setError(null);
            }}
          >
            {recovery ? "Use my authenticator app instead" : "I lost my phone: use a recovery code"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function EnrollForm() {
  const router = useRouter();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stepRef = useRef<HTMLHeadingElement>(null);
  const codesRef = useRef<HTMLSpanElement>(null);

  // Each step replaces the control that had focus, so move focus to the new content.
  const hasSetup = setup !== null;
  useEffect(() => {
    if (hasSetup) stepRef.current?.focus();
  }, [hasSetup]);
  const hasCodes = codes !== null;
  useEffect(() => {
    if (hasCodes) codesRef.current?.focus();
  }, [hasCodes]);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await apiFetch("/api/admin/security/enroll", { method: "POST", body: {} }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ recoveryCodes: string[] }>("/api/admin/security/confirm", { method: "POST", body: { code } });
      setCodes(res.recoveryCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return (
      <Card className="max-w-lg" title={<span ref={codesRef} tabIndex={-1} className="rounded-control">Two-factor sign-in is on</span>} description="Save these recovery codes somewhere safe, like a password manager. Each works once if you lose your phone, and they are shown only now.">
        <ul className="grid grid-cols-1 gap-2 font-mono text-sm min-[420px]:grid-cols-2" aria-label="Recovery codes">
          {codes.map((c) => (
            <li key={c} className="rounded-control border border-border bg-surface px-3 py-2">
              {c}
            </li>
          ))}
        </ul>
        <div className="mt-3">
          <CopyButton value={codes.join("\n")} label="Copy all codes" size="md" />
        </div>
        <label className="mt-5 flex min-h-10 items-center gap-3 text-sm">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="h-5 w-5 accent-(--accent)" />I have saved these codes
        </label>
        <Button className="mt-3" disabled={!saved} onClick={() => router.replace("/admin")}>
          Continue to the admin area
        </Button>
      </Card>
    );
  }

  return (
    <Card className="max-w-lg" title="Set up two-factor sign-in" description="Platform admin access needs an authenticator app, such as Google Authenticator, Authy or 1Password.">
      {!setup ? (
        <>
          <Button onClick={begin} loading={busy}>
            Start setup
          </Button>
          {error && (
            <Alert tone="bad" className="mt-3">
              {error}
            </Alert>
          )}
        </>
      ) : (
        <form onSubmit={confirm} className="space-y-5">
          <section aria-labelledby="enroll-step-1">
            <h3 id="enroll-step-1" ref={stepRef} tabIndex={-1} className="rounded-control text-sm font-semibold">
              Step 1. Add this account to your app
            </h3>
            <p className="mt-1 text-xs text-muted">Scan this code with your authenticator app, or choose "enter a setup key" and paste the key below it.</p>
            <div className="mt-3 flex justify-center min-[420px]:justify-start">
              <QrCode value={setup.uri} label="QR code for your authenticator app. The setup key below is the same secret as text." />
            </div>
            <div className="mt-3 flex flex-wrap items-start gap-2">
              <code className="min-w-0 flex-1 basis-48 break-all rounded-control bg-surface p-2 text-sm select-all">{setup.secret}</code>
              <CopyButton value={setup.secret} label="Copy key" size="md" />
            </div>
            <details className="mt-2">
              <summary className="inline-flex min-h-10 cursor-pointer items-center text-xs font-medium text-accent-ink underline underline-offset-2">Use a setup link instead</summary>
              <div className="mt-1 flex flex-wrap items-start gap-2">
                <code className="min-w-0 flex-1 basis-48 break-all rounded-control bg-surface p-2 text-xs select-all">{setup.uri}</code>
                <CopyButton value={setup.uri} label="Copy link" size="md" />
              </div>
            </details>
          </section>
          <section aria-labelledby="enroll-step-2">
            <h3 id="enroll-step-2" className="mb-2 text-sm font-semibold">
              Step 2. Enter the code your app shows
            </h3>
            <FormField label="6-digit code" required>
              <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required aria-invalid={error ? true : undefined} />
            </FormField>
          </section>
          {error && <Alert tone="bad">{error}</Alert>}
          <Button type="submit" loading={busy}>
            Turn on two-factor sign-in
          </Button>
        </form>
      )}
    </Card>
  );
}
