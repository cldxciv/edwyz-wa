"use client";

import { useId, useRef, useState } from "react";
import { Badge, Button, Input } from "@/components/ui";
import { DEFAULT_STOP_WORDS, MAX_WORKSPACE_STOP_WORDS } from "@/lib/webhooks/payload";
import { addStopWord, STOP_WORDS_EXCEPTIONS } from "./helpers";

/**
 * The STOP words of a workspace (owner default 1): the fixed defaults and the workspace's own words, shown together as the full list
 * that opts a customer out of marketing. Owners and admins edit it in Inbox settings; `readOnly` shows the list without controls.
 */
export function StopWordsEditor({ words, onChange, readOnly = false }: { words: string[]; onChange: (next: string[]) => void; readOnly?: boolean }) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const input = useRef<HTMLInputElement>(null);

  function add() {
    const result = addStopWord(words, draft);
    if (!result.ok) {
      setError(result.reason);
      input.current?.focus();
      return;
    }
    onChange(result.words);
    setDraft("");
    setError(null);
    setStatus(`Added "${result.word}". Save settings to use it.`);
  }

  function remove(word: string) {
    onChange(words.filter((w) => w !== word));
    setStatus(`Removed "${word}". Save settings to stop using it.`);
    input.current?.focus();
  }

  return (
    <section aria-labelledby={`${inputId}-title`} className="space-y-3">
      <div>
        <h3 id={`${inputId}-title`} className="text-sm font-medium">
          STOP words
        </h3>
        <p className="text-xs text-muted">
          When a customer&apos;s whole message is one of these words, or they tap Stop promotions on a marketing template, they get no marketing messages from
          you. Order updates and replies to their own messages can still arrive. They can send START to get offers again.
        </p>
        <p className="mt-1 text-xs text-muted">{STOP_WORDS_EXCEPTIONS}</p>
      </div>

      <div className="space-y-1.5">
        <p id={`${inputId}-defaults`} className="text-xs font-medium text-muted">
          Always on
        </p>
        <ul aria-labelledby={`${inputId}-defaults`} className="flex flex-wrap gap-2">
          {DEFAULT_STOP_WORDS.map((w) => (
            <li key={w}>
              <Badge>{w}</Badge>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-1.5">
        <p id={`${inputId}-own`} className="text-xs font-medium text-muted">
          Added by your workspace
        </p>
        {words.length === 0 ? (
          <p className="text-xs text-muted">None yet.</p>
        ) : (
          <ul aria-labelledby={`${inputId}-own`} className="flex flex-wrap gap-2">
            {words.map((w) => (
              <li key={w}>
                <span className="inline-flex items-center gap-1 rounded-full border border-info-line bg-info-soft py-0.5 pl-2.5 pr-1 text-xs font-medium text-info-fg">
                  {w}
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => remove(w)}
                      aria-label={`Remove STOP word ${w}`}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-1"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!readOnly && (
        <div className="space-y-1.5">
          <label htmlFor={inputId} className="text-sm font-medium">
            Add a word
          </label>
          <div className="flex gap-2">
            <Input
              ref={input}
              id={inputId}
              value={draft}
              maxLength={60}
              autoComplete="off"
              placeholder="For example: band karo"
              aria-describedby={error ? `${hintId} ${errorId}` : hintId}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              className="min-w-0 flex-1"
            />
            <Button type="button" variant="secondary" onClick={add} disabled={!draft.trim()}>
              Add
            </Button>
          </div>
          <p id={hintId} className="text-xs text-muted">
            Only a message that is exactly this word counts, so pick words people use to say stop. Up to {MAX_WORKSPACE_STOP_WORDS} words.
          </p>
          {error && (
            <p id={errorId} role="alert" className="text-xs font-medium text-bad-fg">
              {error}
            </p>
          )}
        </div>
      )}
      <p aria-live="polite" className="sr-only">
        {status}
      </p>
    </section>
  );
}
