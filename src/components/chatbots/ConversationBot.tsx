"use client";

import { useCallback, useState } from "react";
import { Badge, Button, Dialog, FormField, Select, Skeleton, apiFetch, confirm, toast } from "@/components/ui";
import { usePolling } from "@/components/inbox/usePolling";
import { SESSION_LABEL } from "./SessionsPanel";

type BotState = {
  session: { id: string; chatbotName: string; status: string; endedAt: string | null } | null;
  available: { id: string; name: string }[];
};

const RUNNING = new Set(["active", "waiting"]);
/** After this many failed checks in a row the page stops asking until the person presses "Try again". */
const MAX_FAILURES = 3;

/**
 * Sits in the inbox chat header. Shows whether a chatbot is talking to this customer, lets a teammate stop it, and lets them
 * start any published chatbot on the chat.
 */
export function ConversationBot({ conversationId, onChanged }: { conversationId: string; onChanged?: () => void }) {
  const [state, setState] = useState<BotState | null>(null);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [failures, setFailures] = useState(0);

  const load = useCallback(async () => {
    try {
      setState(await apiFetch<BotState>(`/api/chatbots/live?conversationId=${encodeURIComponent(conversationId)}`));
      setFailures(0);
    } catch {
      setFailures((n) => n + 1);
    }
  }, [conversationId]);
  usePolling(load, 8000, failures < MAX_FAILURES);

  if (!state) {
    if (failures === 0) return <Skeleton className="h-8 w-20" />;
    return (
      <Button variant="secondary" size="sm" onClick={() => void load()} title="We could not check whether a chatbot is running in this chat.">
        <span className="hidden sm:inline">Bot status unavailable. Try again</span>
        <span className="sm:hidden">Retry bot</span>
      </Button>
    );
  }
  const running = state.session && RUNNING.has(state.session.status) ? state.session : null;
  const last = state.session && !running ? state.session : null;
  const label = last ? SESSION_LABEL[last.status] : null;

  async function start() {
    if (!chosen) return;
    setBusy("start");
    try {
      const fresh = await apiFetch<BotState>(`/api/chatbots/live?conversationId=${encodeURIComponent(conversationId)}`).catch(() => null);
      const already = fresh?.session && RUNNING.has(fresh.session.status) ? fresh.session : null;
      if (already) {
        setState(fresh);
        const replace = await confirm({
          title: "Replace the running chatbot?",
          body: `"${already.chatbotName}" is already talking to this customer. Starting another chatbot stops it.`,
          confirmLabel: "Replace it",
        });
        if (!replace) return;
      }
      await apiFetch(`/api/chatbots/${chosen}/start`, { method: "POST", body: { conversationId } });
      toast.success("The chatbot has started in this chat.");
      setOpen(false);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "We could not start the chatbot.");
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    const ok = await confirm({
      title: "Stop the chatbot?",
      body: "The chatbot stops talking to this customer. You can reply yourself, or start a chatbot again later.",
      confirmLabel: "Stop chatbot",
    });
    if (!ok) return;
    setBusy("stop");
    try {
      await apiFetch("/api/chatbots/live/stop", { method: "POST", body: { conversationId } });
      toast.success("The chatbot has stopped.");
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "We could not stop the chatbot.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {running && (
        <Badge tone="info" dot>
          <span className="max-w-32 truncate" title={`Chatbot running: ${running.chatbotName}`}>
            Bot: {running.chatbotName}
          </span>
        </Badge>
      )}
      {label && last && (
        <span className="hidden md:inline-flex">
          <Badge tone={label.tone}>
            <span title={`${last.chatbotName}: ${label.label}`}>Bot: {label.label}</span>
          </Badge>
        </span>
      )}
      {running ? (
        <Button variant="secondary" size="sm" loading={busy === "stop"} onClick={() => void stop()}>
          Stop bot
        </Button>
      ) : (
        state.available.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setChosen(state.available[0].id);
              setOpen(true);
            }}
          >
            <span className="hidden sm:inline">Run a chatbot</span>
            <span className="sm:hidden">Bot</span>
          </Button>
        )
      )}
      {open && (
        <Dialog
          title="Run a chatbot"
          description="The chatbot starts talking to this customer right away."
          onClose={() => busy === null && setOpen(false)}
          dismissible={busy === null}
          footer={
            <>
              <Button variant="secondary" disabled={busy !== null} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button loading={busy === "start"} disabled={!chosen} onClick={() => void start()}>
                Start chatbot
              </Button>
            </>
          }
        >
          <FormField label="Chatbot">
            <Select value={chosen} onChange={(e) => setChosen(e.target.value)} data-autofocus>
              {state.available.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </FormField>
          <p className="mt-3 text-xs text-muted">Customers can only be messaged freely for 24 hours after they last wrote. If that time has passed, send a template first.</p>
        </Dialog>
      )}
    </>
  );
}
