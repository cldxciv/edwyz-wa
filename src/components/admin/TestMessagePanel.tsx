"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, apiFetch, Button, buttonSizes, buttonVariants, Card, cn, CopyButton, EmptyState, FormField, Input, Select, Textarea } from "@/components/ui";
import {
  CHOOSE_TEMPLATE,
  NO_CONFIRMATION_YET,
  NO_TEMPLATES_HELP,
  NO_TEMPLATES_NOTE,
  NONE_SENDABLE_NOTE,
  POLL_FAILED,
  TEMPLATE_HINT,
  testMessageOutcome,
  testTemplateLabel,
  type TestNumberOption,
} from "./helpers";

type Queued = { ok: true; messageId: string; conversationId: string; status: "queued" };
type Status = { id: string; conversationId: string; status: string; statusTimeline: unknown[]; errorCode: string | null; wamid: string | null; hint: string | null; inboxHref: string };

const POLL_MS = 2000;
const POLL_LIMIT = 15;
/** Polls that fail in a row before the panel stops and says so (the step-up cookie lasts 30 minutes; a lapsed one answers 404 every time). */
const POLL_FAILURE_LIMIT = 3;

const linkButton = cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.secondary, buttonSizes.sm);

const firstSendable = (n: TestNumberOption | undefined) => n?.templates.find((t) => t.variables === 0)?.id ?? "";

export function TestMessagePanel({ numbers }: { numbers: TestNumberOption[] }) {
  const [phone, setPhone] = useState(numbers[0]?.id ?? "");
  const [to, setTo] = useState("");
  const [mode, setMode] = useState<"text" | "template">("text");
  const [text, setText] = useState("Hello from Edwyz WA. This is a test message.");
  const [templateId, setTemplateId] = useState(firstSendable(numbers[0]));
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<Queued | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [polls, setPolls] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const selected = numbers.find((n) => n.id === phone);
  const templates = selected?.templates ?? [];
  const sendableTemplates = templates.filter((t) => t.variables === 0);
  const templateMissing = mode === "template" && !sendableTemplates.some((t) => t.id === templateId);
  const templateError = mode === "template" && templates.length > 0 && sendableTemplates.length === 0 ? NONE_SENDABLE_NOTE : undefined;

  function stopPolling() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }

  useEffect(() => {
    if (!queued) return;
    let count = 0;
    let failures = 0;
    let cancelled = false;
    const id = setInterval(() => void tick(), POLL_MS);
    timer.current = id;
    async function tick() {
      count += 1;
      if (!cancelled) setPolls(count);
      try {
        const next = await apiFetch<Status>(`/api/admin/test-message/${encodeURIComponent(queued!.messageId)}`);
        if (cancelled) return;
        failures = 0;
        setStatus(next);
        if (["delivered", "read", "failed"].includes(next.status)) return clearInterval(id);
      } catch {
        // One failed poll is not news; several in a row mean the status cannot be read at all (most often a lapsed admin session).
        failures += 1;
        if (failures >= POLL_FAILURE_LIMIT) {
          clearInterval(id);
          if (!cancelled) setPollFailed(true);
          return;
        }
      }
      if (count >= POLL_LIMIT) {
        clearInterval(id);
        if (!cancelled) setTimedOut(true);
      }
    }
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [queued]);

  function choosePhone(id: string) {
    setPhone(id);
    setTemplateId(firstSendable(numbers.find((n) => n.id === id)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    stopPolling();
    setBusy(true);
    setQueued(null);
    setStatus(null);
    setPolls(0);
    setTimedOut(false);
    setPollFailed(false);
    setFailure(null);
    try {
      const body = mode === "template" ? { phoneNumberRef: phone, to, mode, templateId } : { phoneNumberRef: phone, to, mode, text };
      setQueued(await apiFetch<Queued>("/api/admin/test-message", { method: "POST", body }));
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const outcome = status ? testMessageOutcome(status.status, status.errorCode, { elapsedMs: polls * POLL_MS, hint: status.hint }) : null;
  // "Keep watching in the chat" only makes sense once WhatsApp accepted the message; a send still queued has nothing to watch there.
  const stillWaiting = timedOut && status?.status === "sent";
  const details = status ?? queued;

  return (
    <Card
      title="Send a test message"
      description="Sends one real WhatsApp message from a connected business number, using that workspace's saved connection. This creates a real contact and chat in that workspace's inbox, and the result below comes from WhatsApp's own status updates."
    >
      {numbers.length === 0 ? (
        <EmptyState compact title="No connected numbers yet" body="Connect a WhatsApp number from a workspace first, then come back to test it." />
      ) : (
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" aria-busy={busy}>
          <FormField label="Send from" required>
            <Select value={phone} onChange={(e) => choosePhone(e.target.value)} required>
              {numbers.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Send to" required hint="Include the country code, like +91 98765 43210.">
            <Input type="tel" inputMode="tel" autoComplete="off" value={to} onChange={(e) => setTo(e.target.value)} required />
          </FormField>
          <FormField label="Message type" hint="Plain text only reaches people who messaged this number in the last 24 hours. An approved template works any time.">
            <Select value={mode} onChange={(e) => setMode(e.target.value as "text" | "template")}>
              <option value="text">Plain text</option>
              <option value="template">Approved template</option>
            </Select>
          </FormField>
          {mode === "text" ? (
            <FormField label="Message">
              <Textarea rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
            </FormField>
          ) : (
            <FormField label="Template" required hint={templates.length === 0 ? `${NO_TEMPLATES_NOTE}. ${NO_TEMPLATES_HELP}` : TEMPLATE_HINT} error={templateError}>
              <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} required disabled={templates.length === 0}>
                {templates.length === 0 ? (
                  <option value="">{NO_TEMPLATES_NOTE}</option>
                ) : (
                  <>
                    <option value="" disabled>
                      {CHOOSE_TEMPLATE}
                    </option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id} disabled={t.variables !== 0}>
                        {testTemplateLabel(t)}
                      </option>
                    ))}
                  </>
                )}
              </Select>
            </FormField>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" loading={busy} disabled={busy || !phone || !to || templateMissing}>
              Send test message
            </Button>
          </div>
        </form>
      )}

      <div className="mt-5 space-y-3 empty:hidden" aria-live="polite" aria-atomic="false">
        {failure && <Alert tone="bad" title="The test message was not sent">{failure}</Alert>}
        {queued && !outcome && !pollFailed && (
          <Alert tone="info" title="Queued for sending">
            Within a few seconds WhatsApp should confirm it accepted the message. Delivery to the phone is confirmed separately by a status update from WhatsApp, which usually follows in seconds but can take longer.
          </Alert>
        )}
        {outcome && status && (
          <Alert
            tone={outcome.tone}
            title={outcome.title}
            action={
              stillWaiting ? (
                <a className={linkButton} href={status.inboxHref}>
                  Open the chat
                </a>
              ) : undefined
            }
          >
            {outcome.body}
            {stillWaiting && <p className="mt-1">{NO_CONFIRMATION_YET}</p>}
          </Alert>
        )}
        {pollFailed && (
          <Alert tone="warn" title="Could not check the status">
            {POLL_FAILED}
          </Alert>
        )}
      </div>
      {/* Outside the live region on purpose: the timeline JSON changes on every poll and must not be read aloud each time. */}
      {details && (
        <details className="mt-3">
          <summary className="inline-flex min-h-8 cursor-pointer items-center text-xs font-medium text-accent-ink underline underline-offset-2">Details for developers</summary>
          <p className="mt-1 text-xs">
            Message id: <code className="break-all">{queued?.messageId ?? status?.id}</code>
            {status?.wamid && (
              <>
                {" "}
                WhatsApp id: <code className="break-all">{status.wamid}</code>
              </>
            )}
            {status?.errorCode && <> Code {status.errorCode}</>}
          </p>
          <pre className="mt-2 max-h-64 overflow-auto rounded-control bg-background p-3 text-xs text-foreground">{JSON.stringify(status?.statusTimeline ?? [{ status: "queued" }], null, 2)}</pre>
          <div className="mt-2">
            <CopyButton value={JSON.stringify(status ?? queued, null, 2)} label="Copy details" />
          </div>
        </details>
      )}
    </Card>
  );
}
