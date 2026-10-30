"use client";

import { useEffect, useState } from "react";
import { ConnectWhatsApp } from "@/components/connect/ConnectWhatsApp";
import { apiFetch, Badge, Card, PageHeader, Spinner } from "@/components/ui";
import { PAYMENT_URL } from "./checklist";

type Step = { step: string; status: "pending" | "started" | "done" | "failed" };
type Status = { status: string; steps: Step[]; nextAction: string | null };

const EXPLAIN: Record<string, { title: string; text: string }> = {
  exchange_code: { title: "Authorise with Meta", text: "Meta gives us a one-time code when you finish the signup window. We swap it for a secure access key, which is stored encrypted." },
  verify_ids: { title: "Verify your account", text: "We check with Meta that the number really belongs to the WhatsApp Business Account you just selected." },
  subscribe_app: { title: "Subscribe to messages", text: "We ask Meta to send incoming messages and delivery updates to Edwyz WA, so they appear in your inbox." },
  register_number: { title: "Register your number", text: "We register the number for the Cloud API with a security PIN that we generate and keep encrypted. Skipped if you kept using the WhatsApp Business app." },
  fetch_details: { title: "Read number details", text: "We read your display name, quality rating and messaging limit from Meta." },
  mark_live: { title: "Go live", text: "Your workspace is marked as connected and ready to use." },
};

const tone = (s: Step["status"]) => (s === "done" ? "good" : s === "failed" ? "bad" : s === "started" ? "warn" : "neutral");
const label = (s: Step["status"]) => (s === "done" ? "Done" : s === "failed" ? "Failed" : s === "started" ? "In progress" : "Waiting");

export function ConnectSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([apiFetch<Status>("/api/onboarding/status").catch(() => null), apiFetch<{ role: string }>("/api/auth/me")])
      .then(([s, me]) => {
        if (!live) return;
        setStatus(s);
        setRole(me.role);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load this page."));
    return () => {
      live = false;
    };
  }, []);

  if (error) return <p role="alert" className="text-sm text-red-700">{error}</p>;
  if (!role) return <Spinner label="Loading" />;

  const canConnect = role === "owner" || role === "admin";
  const steps = status?.steps ?? [];
  const live = status?.status === "live";

  return (
    <>
      <PageHeader title="Connect WhatsApp" description="Connect your WhatsApp Business number so you can use the inbox, templates and broadcasts." />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          {canConnect ? (
            <ConnectWhatsApp />
          ) : (
            <Card>
              <p className="text-sm">Only an owner or admin can connect a number. Ask one of them to open this page.</p>
            </Card>
          )}
          <Card>
            <h2 className="font-semibold">Before you connect</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              <li>Have your Facebook login and your business details ready.</li>
              <li>The number must be able to receive a verification code by SMS or call.</li>
              <li>Meta currently lets us onboard 10 new customers in any rolling 7 days. If you see a limit message, wait and try again later.</li>
            </ul>
          </Card>
          {(live || status?.nextAction === "add_payment_method") && (
            <Card>
              <h2 className="font-semibold">One more thing: add a payment method</h2>
              <p className="mt-2 text-sm text-muted">
                Meta requires a payment method on your WhatsApp account before you can message customers. This happens in Meta&apos;s own tool, not in Edwyz WA.
              </p>
              <a href={PAYMENT_URL} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm font-semibold text-accent underline">
                Open WhatsApp Manager
              </a>
            </Card>
          )}
        </div>

        <Card>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Connection progress</h2>
            <Badge tone={live ? "good" : status?.status === "failed" ? "bad" : "neutral"}>{(status?.status ?? "not_started").replace("_", " ")}</Badge>
          </div>
          <ol className="mt-4 space-y-4">
            {(steps.length ? steps : Object.keys(EXPLAIN).map((step) => ({ step, status: "pending" as const }))).map((s) => (
              <li key={s.step}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">{EXPLAIN[s.step]?.title ?? s.step}</p>
                  <Badge tone={tone(s.status)}>{label(s.status)}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted">{EXPLAIN[s.step]?.text}</p>
              </li>
            ))}
          </ol>
          {status?.status === "failed" && <p className="mt-4 text-sm text-muted">A step failed. Nothing is lost: connect again and it continues from the failed step.</p>}
        </Card>
      </div>
    </>
  );
}
