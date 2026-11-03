"use client";

/**
 * The instant form in a phone frame (docs/IG-PAGE-ADS-SPEC.md 3.5 "Phone-frame preview", 7.3, 7.6). Four screens in order:
 * intro, questions, privacy and thank-you, from form-builder-helpers.previewScreens. The WhatsApp consent box, and any other box
 * an edited copy keeps, is drawn unticked, as people see it (D35). A copy's intro and own thank-you words are drawn too. Screens change with the tabs, the Previous and Next buttons, or the arrow keys (Home and End too).
 *
 * Lazy-loaded by FormStep's builder (next/dynamic), so it stays out of the first bundle. It is our approximate drawing; Meta
 * draws the real form.
 */
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Button, cn } from "@/components/ui";
import { FORM_BUILDER_TEXT as T, nextScreenIndex, type PreviewScreen } from "./form-builder-helpers";

export type LeadFormPreviewProps = { screens: PreviewScreen[]; className?: string };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** A drawn control: it looks like the form's button but does nothing (the preview is not the form). */
function FakeButton({ children }: { children: string }) {
  return (
    <span aria-hidden="true" className="mt-4 flex min-h-11 w-full items-center justify-center rounded-full bg-accent px-4 text-sm font-semibold text-on-accent">
      {children}
    </span>
  );
}

function ScreenBody({ screen }: { screen: PreviewScreen }) {
  switch (screen.key) {
    case "intro":
      return (
        <div className="flex flex-col items-center gap-3 text-center">
          <span aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-lg font-semibold text-on-accent">
            {screen.pageName.trim().charAt(0).toUpperCase() || "?"}
          </span>
          <p className="break-words font-semibold">{screen.pageName}</p>
          {screen.intro ? (
            <div className="w-full space-y-1 text-left" data-testid="form-preview-intro">
              {screen.intro.title && <p className="break-words font-medium">{screen.intro.title}</p>}
              {screen.intro.lines.map((line, i) => (
                <p key={`${line}-${i}`} className="break-words text-xs">
                  {line}
                </p>
              ))}
            </div>
          ) : null}
          <p className="text-xs text-muted">{T.previewIntro}</p>
          <FakeButton>{T.previewContinue}</FakeButton>
        </div>
      );
    case "questions":
      return screen.questions.length === 0 ? (
        <p className="text-muted">{T.previewEmpty}</p>
      ) : (
        <ol className="space-y-3">
          {screen.questions.map((q, i) => (
            <li key={`${q.label}-${i}`} className="space-y-1">
              <p className="break-words text-xs font-medium">{q.label}</p>
              {q.options.length ? (
                <p className="flex flex-wrap gap-1">
                  {q.options.map((o) => (
                    <span key={o} className="rounded-full border border-border px-2 py-0.5 text-xs">
                      {o}
                    </span>
                  ))}
                </p>
              ) : (
                <span aria-hidden="true" className="block h-8 rounded-control border border-border bg-surface" />
              )}
              {q.prefilled && <p className="text-xs text-muted">{T.prefilled}</p>}
            </li>
          ))}
        </ol>
      );
    case "privacy": {
      const section = screen.consent ?? screen.section;
      return (
        <div className="space-y-3">
          {section ? (
            <div className="space-y-2">
              <p className="font-semibold">{section.title}</p>
              <p className="whitespace-pre-line text-xs text-muted">{section.body}</p>
              {screen.consent ? (
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" checked={screen.consent.checked} readOnly disabled className="mt-0.5 h-4 w-4 shrink-0 accent-accent" data-testid="form-preview-consent" />
                  <span>{screen.consent.text}</span>
                </label>
              ) : null}
              {screen.others.map((box, i) => (
                <label key={`${box.text}-${i}`} className="flex items-start gap-2 text-xs" data-testid="form-preview-other-box">
                  <input type="checkbox" checked={box.checked} readOnly disabled className="mt-0.5 h-4 w-4 shrink-0 accent-accent" />
                  <span>
                    {box.text}
                    {box.required ? <span className="text-muted"> ({T.requiredBox})</span> : null}
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          <p className="text-xs">
            <span className="font-medium underline underline-offset-2">{screen.linkText}</span>
            {screen.url ? <span className="block break-all text-muted">{hostOf(screen.url)}</span> : null}
          </p>
          <FakeButton>{T.previewSubmit}</FakeButton>
        </div>
      );
    }
    case "thank_you":
      return (
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="font-semibold">{screen.heading}</p>
          <p className="text-xs text-muted">{screen.body}</p>
          <FakeButton>{screen.button}</FakeButton>
          {screen.target ? <p className="break-all text-xs text-muted">{screen.target}</p> : null}
        </div>
      );
  }
}

export function LeadFormPreview({ screens, className }: LeadFormPreviewProps) {
  const id = useId();
  const [index, setIndex] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const count = screens.length;
  const at = count ? Math.min(Math.max(index, 0), count - 1) : 0;
  const screen = screens[at];
  if (!screen) return null;

  function go(next: number, focus: boolean) {
    setIndex(next);
    if (focus) tabs.current[next]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const next = nextScreenIndex(at, e.key, count);
    if (next === null) return;
    e.preventDefault();
    go(next, true);
  }

  const tabId = (key: string) => `${id}-tab-${key}`;
  const panelId = (key: string) => `${id}-panel-${key}`;

  return (
    <div className={cn("min-w-0", className)} data-testid="form-preview">
      <div role="tablist" aria-label={T.previewLabel} onKeyDown={onKeyDown} className="grid grid-cols-4 gap-1 rounded-full bg-surface-2 p-1">
        {screens.map((s, i) => {
          const active = i === at;
          return (
            <button
              key={s.key}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              id={tabId(s.key)}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId(s.key)}
              tabIndex={active ? 0 : -1}
              onClick={() => go(i, false)}
              data-testid={`form-preview-tab-${s.key}`}
              className={cn(
                "min-h-11 min-w-0 rounded-full border px-1 text-xs font-medium transition-colors duration-(--dur-fast)",
                active ? "border-accent-ink bg-raised text-foreground shadow-raised" : "border-transparent text-muted hover:text-foreground",
              )}
            >
              <span className="block truncate">{s.title}</span>
            </button>
          );
        })}
      </div>

      <div className="mx-auto mt-3 w-full max-w-72 rounded-3xl border-4 border-border-strong bg-surface-2 p-2 shadow-raised">
        <div aria-hidden="true" className="mx-auto mb-2 h-1.5 w-16 rounded-full bg-border-strong" />
        <div
          id={panelId(screen.key)}
          role="tabpanel"
          aria-labelledby={tabId(screen.key)}
          tabIndex={0}
          data-testid={`form-preview-screen-${screen.key}`}
          className="min-h-96 rounded-card bg-raised p-4 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ScreenBody screen={screen} />
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <Button variant="secondary" className="min-h-11 px-4" onClick={() => go(at - 1, false)} disabled={at === 0} aria-label={T.previewPrev} data-testid="form-preview-prev">
          <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true" focusable="false">
            <path d="M10 3.5L5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Button>
        <p aria-live="polite" className="min-w-0 text-center text-xs text-muted" data-testid="form-preview-position">
          {T.previewScreen(at + 1, count, screen.title)}
        </p>
        <Button variant="secondary" className="min-h-11 px-4" onClick={() => go(at + 1, false)} disabled={at === count - 1} aria-label={T.previewNext} data-testid="form-preview-next">
          <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true" focusable="false">
            <path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">{T.previewNote}</p>
    </div>
  );
}

export default LeadFormPreview;
