"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Alert, apiFetch, Button, Card, Dialog, FormField, Input, toast } from "@/components/ui";
import { confirmationMatches, START_SPENDING_PHRASE, STOP_SPENDING_PHRASE } from "./helpers";

export type PlatformSwitchProps = {
  freeze: "none" | "assistants" | "all";
  /** The state line from the server ("Spending is on for all workspaces" / "Stopped since ... by ...: reason"). */
  text: string;
  progressText: string | null;
  /** The admin confirmed with the authenticator in the last 5 minutes, so no code is asked for. */
  stepUpFresh: boolean;
};

export type SwitchAction = "stop_assistants" | "stop_all" | "resume";

/** The dialog copy for each action (8.3). */
export const SWITCH_COPY: Record<SwitchAction, { label: string; title: string; body: string; phrase: string; danger: boolean }> = {
  stop_all: {
    label: "Stop all spending everywhere",
    title: "Stop all spending for every workspace?",
    body: "Pauses every ad Edwyz runs on every workspace and holds automatic messages. Lowering is always allowed; nothing can be raised until you turn this off.",
    phrase: STOP_SPENDING_PHRASE,
    danger: true,
  },
  stop_assistants: {
    label: "Stop assistants everywhere",
    title: "Stop assistants for every workspace?",
    body: "Pauses every ad an assistant launched on every workspace and holds assistant messages. People can still spend within their own limits. Nothing an assistant asks for can be raised until you turn this off.",
    phrase: STOP_SPENDING_PHRASE,
    danger: true,
  },
  resume: {
    label: "Turn spending back on",
    title: "Turn spending back on for every workspace?",
    body: "Spending is allowed again within each workspace's limits. Nothing restarts by itself: paused ads and broadcasts stay paused until each owner resumes them.",
    phrase: START_SPENDING_PHRASE,
    danger: false,
  },
};

/** Which buttons the card shows for the switch's state. */
export function switchActions(freeze: PlatformSwitchProps["freeze"]): SwitchAction[] {
  if (freeze === "all") return ["resume"];
  if (freeze === "assistants") return ["stop_all", "resume"];
  return ["stop_assistants", "stop_all"];
}

/** The top card of /admin/spending: the platform-wide stop (4.11). */
export function PlatformSpendSwitch({ freeze, text, progressText, stepUpFresh }: PlatformSwitchProps) {
  const router = useRouter();
  const uid = useId();
  const [action, setAction] = useState<SwitchAction | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const copy = action ? SWITCH_COPY[action] : null;
  const canSubmit = !!copy && confirmationMatches(typed, copy.phrase);

  function open(next: SwitchAction) {
    setAction(next);
    setTyped("");
    setError(null);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!action || !canSubmit) return;
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ text: string }>("/api/admin/spending/platform", {
        method: "POST",
        body: { action, reason: String(form.get("reason") ?? ""), confirm: typed, code: String(form.get("code") ?? "").trim() || undefined },
      });
      setStatus(res.text);
      toast.success(res.text);
      setAction(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const stopped = freeze !== "none";
  return (
    <Card
      title={stopped ? (freeze === "all" ? "Spending is stopped for all workspaces" : "Assistants are stopped for all workspaces") : "Spending is on for all workspaces"}
      description={stopped ? text : "Use this only when something is wrong across the platform. Each workspace's owner can still stop their own spending."}
      className={stopped ? "border-bad-line!" : undefined}
    >
      <div className="flex flex-wrap gap-2">
        {switchActions(freeze).map((a) => (
          <Button key={a} variant={SWITCH_COPY[a].danger ? "danger" : "primary"} onClick={() => open(a)}>
            {SWITCH_COPY[a].label}
          </Button>
        ))}
      </div>
      <p role="status" aria-live="polite" className="mt-3 text-sm text-muted empty:hidden">
        {status ?? progressText ?? ""}
      </p>

      {action && copy && (
        <Dialog
          title={copy.title}
          description={copy.body}
          size="md"
          role={copy.danger ? "alertdialog" : "dialog"}
          dismissible={!busy}
          onClose={() => setAction(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setAction(null)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" form={`${uid}-form`} variant={copy.danger ? "danger" : "primary"} loading={busy} disabled={!canSubmit}>
                {copy.label}
              </Button>
            </>
          }
        >
          <form id={`${uid}-form`} onSubmit={submit} className="space-y-4">
            <FormField label="Reason" hint="Saved in the audit log and shown to every workspace while the stop is on." required>
              <Input name="reason" maxLength={300} required autoComplete="off" data-autofocus />
            </FormField>
            <FormField label={`Type ${copy.phrase} to confirm`} required>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
            </FormField>
            <FormField
              label="6-digit code from your authenticator app"
              hint={stepUpFresh ? "You confirmed it's you in the last 5 minutes, so you can leave this empty." : "This switch needs a fresh check: enter the code your authenticator app shows now."}
              required={!stepUpFresh}
              optional={stepUpFresh}
            >
              <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required={!stepUpFresh} />
            </FormField>
            {error && <Alert tone="bad">{error}</Alert>}
          </form>
        </Dialog>
      )}
    </Card>
  );
}
