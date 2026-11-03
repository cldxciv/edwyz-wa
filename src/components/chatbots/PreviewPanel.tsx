"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, FormField, Input, cn } from "@/components/ui";
import { reply, startPreview, triggerMatches, type PreviewState } from "./preview";
import type { FlowDefinition, TriggerType } from "./types";

type Props = { flow: FlowDefinition; triggerType: TriggerType; keywords: string[] };

const touch = "max-sm:min-h-10";

export function PreviewPanel({ flow, triggerType, keywords }: Props) {
  const [state, setState] = useState<PreviewState | null>(null);
  const [text, setText] = useState("");
  const [notStarted, setNotStarted] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLInputElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  // Where the keyboard focus should land after the next render: the control that was just used is often replaced.
  const want = useRef<"next" | "reply" | "start" | null>(null);

  useEffect(() => {
    const w = want.current;
    if (!w) return;
    want.current = null;
    if (w === "start") firstRef.current?.focus();
    else if (w === "reply") (replyRef.current ?? logRef.current)?.focus();
    else (optionsRef.current?.querySelector<HTMLElement>("button") ?? replyRef.current ?? logRef.current)?.focus();
  });

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [state?.messages.length]);

  function begin(e: React.FormEvent) {
    e.preventDefault();
    const msg = text.trim();
    if (triggerType !== "manual" && !triggerMatches(triggerType, keywords, msg, true)) {
      setNotStarted(
        triggerType === "keyword"
          ? "This message has none of your trigger words, so the bot would not start. Try one of your words, or start anyway."
          : "With your current settings the bot would not start for this message. You can start anyway.",
      );
      return;
    }
    setNotStarted(null);
    want.current = "next";
    setState(startPreview(flow, msg || undefined));
    setText("");
  }

  function answer(e: React.FormEvent) {
    e.preventDefault();
    if (!state || !text.trim()) return;
    want.current = "reply";
    setState(reply(flow, state, { text }));
    setText("");
  }

  function restart() {
    want.current = "start";
    setState(null);
    setText("");
    setNotStarted(null);
  }

  const waiting = state?.waiting;
  // Only a menu step waits on its own options; a question or a wait never shows the buttons of an earlier menu.
  const options = waiting && state && (waiting.kind === "buttons" || waiting.kind === "list") ? (state.messages.filter((m) => m.from === "bot" && m.options).at(-1)?.options ?? []) : [];
  const saved = state ? Object.entries(state.variables).filter(([k]) => !k.startsWith("attr.")) : [];
  const hasSteps = flow.nodes.length > 0;

  return (
    <section aria-label="Chat preview" className="space-y-4">
      <p className="text-sm text-muted">Try your chatbot as a customer would. Nothing is sent to anyone and nothing is saved.</p>
      {!hasSteps ? (
        <Alert tone="info">Add a step first, then come back to try it.</Alert>
      ) : !state ? (
        <form onSubmit={begin} className="space-y-3">
          <FormField label="What does the customer write first?" hint={triggerType === "keyword" ? "Use one of your trigger words, as a customer would." : undefined}>
            <Input ref={firstRef} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder={triggerType === "keyword" ? (keywords[0] ?? "Hello") : "Hello"} />
          </FormField>
          {notStarted && (
            <Alert
              tone="warn"
              action={
                <Button type="button" size="sm" variant="secondary" className={touch} onClick={() => { setNotStarted(null); want.current = "next"; setState(startPreview(flow, text.trim() || undefined)); setText(""); }}>
                  Start anyway
                </Button>
              }
            >
              {notStarted}
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className={touch}>
              Start preview
            </Button>
            <Button type="button" variant="secondary" className={touch} onClick={() => { setNotStarted(null); want.current = "next"; setState(startPreview(flow)); }}>
              Skip to the first step
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div ref={logRef} tabIndex={-1} role="log" aria-live="polite" aria-label="Preview conversation" className="max-h-80 min-h-32 space-y-2 overflow-y-auto rounded-card bg-surface p-3">
            {state.messages.map((m, i) =>
              m.from === "note" ? (
                <p key={i} className="text-center text-xs text-muted">
                  <span className="sr-only">Bot action: </span>
                  {m.text}
                </p>
              ) : (
                <div key={i} className={cn("flex", m.from === "customer" ? "justify-end" : "justify-start")}>
                  <p className={cn("max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm", m.from === "customer" ? "bg-accent text-on-accent" : "border border-border bg-raised")}>
                    <span className="sr-only">{m.from === "customer" ? "Customer: " : "Bot: "}</span>
                    {m.text || "(empty message)"}
                  </p>
                </div>
              ),
            )}
            <div ref={end} />
          </div>
          {waiting && options.length > 0 && (
            <div ref={optionsRef} className="flex flex-wrap gap-2" role="group" aria-label={waiting.kind === "list" ? "Menu options" : "Reply buttons"}>
              {options.map((o) => (
                <Button key={o.id} variant="secondary" className={touch} onClick={() => { want.current = "next"; setState(reply(flow, state, { optionId: o.id })); }}>
                  {o.title || "(no title yet)"}
                </Button>
              ))}
            </div>
          )}
          {waiting && (
            <form onSubmit={answer} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <FormField label="Reply as the customer">
                  <Input ref={replyRef} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="Type a sample reply" />
                </FormField>
              </div>
              <Button type="submit" className="mb-px shrink-0" disabled={!text.trim()}>
                Send
              </Button>
            </form>
          )}
          {waiting?.kind === "delay" && (
            <Button type="button" variant="secondary" className={touch} onClick={() => { want.current = "next"; setState(reply(flow, state, { endWait: true })); }}>
              Let the wait end
            </Button>
          )}
          {!waiting && (
            <Alert tone={state.status === "handoff" ? "good" : "info"}>{state.status === "handoff" ? "The bot handed the chat over to your team." : "The chat has ended. Restart to try another path."}</Alert>
          )}
          {saved.length > 0 && (
            <details className="rounded-card border border-border p-3 text-sm">
              <summary className="min-h-10 cursor-pointer font-medium leading-10">Answers saved so far</summary>
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                {saved.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted">{k}</dt>
                    <dd className="break-words">{v || "(empty)"}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          <Button variant="secondary" className={touch} onClick={restart}>
            Restart preview
          </Button>
        </>
      )}
    </section>
  );
}
