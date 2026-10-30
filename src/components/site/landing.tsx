import type { ReactNode } from "react";
import { EDDY_EXAMPLES, SPEND_PREVIEW, STATUS_LABEL, type EddyExample, type EddyTurn, type Feature, type Status } from "./content";
import { Icon } from "./icons";

/* Server-only building blocks of the landing page. No client JavaScript. */

export const wrap = "mx-auto max-w-6xl px-4 sm:px-6";
export const primaryCta =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-accent px-6 py-3 text-base font-semibold text-white hover:bg-accent-strong";
export const secondaryCta =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-border bg-background px-6 py-3 text-base font-semibold hover:bg-surface";
export const textLink = "pub-ink font-semibold underline underline-offset-2";

const BADGE: Record<Status, string> = {
  new: "border-accent-ink/40 bg-accent-soft text-accent-ink",
  soon: "border-warn-line bg-warn-soft text-warn-fg",
};

/** "New" or "Coming soon", as text so it is read out and never relies on colour alone. */
export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${BADGE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function SectionHead({ id, eyebrow, title, intro, status }: { id: string; eyebrow: string; title: string; intro?: ReactNode; status?: Status }) {
  return (
    <div className="max-w-2xl">
      <p className="flex flex-wrap items-center gap-3">
        <span className="pub-ink text-sm font-semibold uppercase tracking-widest">{eyebrow}</span>
        {status && <StatusBadge status={status} />}
      </p>
      <h2 id={id} className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
        {title}
      </h2>
      {intro && <p className="mt-4 text-lg leading-relaxed text-muted">{intro}</p>}
    </div>
  );
}

/** A grid of icon cards. `tone` picks the card background so it contrasts with the section behind it. */
export function FeatureCards({ items, tone = "background", columns = "sm:grid-cols-2 lg:grid-cols-4", status }: { items: readonly Feature[]; tone?: "background" | "surface"; columns?: string; status?: Status }) {
  const card = tone === "background" ? "bg-background" : "bg-surface";
  return (
    <ul className={`mt-6 grid gap-4 ${columns}`}>
      {items.map((f) => (
        <li key={f.title} className={`rounded-2xl border border-border p-5 ${card}`}>
          <div className="flex items-start justify-between gap-3">
            <span className="pub-ink inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface">
              <Icon name={f.icon} />
            </span>
            {status && <StatusBadge status={status} />}
          </div>
          <h3 className="mt-4 font-semibold">{f.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
        </li>
      ))}
    </ul>
  );
}

/** A compact list of points with an icon each, for text-heavy sections. */
export function PointList({ items, columns = "sm:grid-cols-2" }: { items: readonly Feature[]; columns?: string }) {
  return (
    <ul className={`mt-8 grid gap-5 ${columns}`}>
      {items.map((p) => (
        <li key={p.title} className="flex gap-3">
          <span className="pub-ink mt-0.5 shrink-0">
            <Icon name={p.icon} className="h-6 w-6" />
          </span>
          <div>
            <h3 className="font-semibold">{p.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-muted">{p.body}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The speaker labels are English; only the message text carries the example's language. */
function Turn({ turn, lang }: { turn: EddyTurn; lang: EddyExample["lang"] }) {
  if (turn.from === "you") {
    return (
      <li className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm leading-relaxed break-words text-white">
          <span className="sr-only">You: </span>
          <span lang={lang}>{turn.text}</span>
        </p>
      </li>
    );
  }
  return (
    <li className="flex gap-2">
      <span aria-hidden="true" className="mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-white">
        E
      </span>
      <div className="max-w-[85%] min-w-0">
        <p className="rounded-2xl rounded-bl-md border border-border bg-background px-4 py-2.5 text-sm leading-relaxed break-words">
          <span className="sr-only">Eddy: </span>
          <span lang={lang}>{turn.text}</span>
        </p>
        {turn.undo && (
          <span className="mt-2 inline-flex items-center rounded-full border border-border bg-background px-3 py-1 text-xs font-semibold">Undo</span>
        )}
        {turn.card && (
          <div className="mt-2 rounded-xl border border-border bg-background p-4 text-sm">
            <p className="font-semibold">{turn.card.title}</p>
            <blockquote className="mt-2 border-l-2 border-accent pl-3 leading-relaxed break-words text-muted">{turn.card.quote}</blockquote>
            <p className="mt-3 flex flex-wrap gap-2">
              <span className="sr-only">Buttons on the card: </span>
              {turn.card.actions.map((a, i) => (
                <span
                  key={a}
                  className={
                    i === 0
                      ? "inline-flex items-center rounded-full bg-accent px-3 py-1 text-xs font-semibold text-white"
                      : "inline-flex items-center rounded-full border border-border px-3 py-1 text-xs font-semibold"
                  }
                >
                  {a}
                </span>
              ))}
            </p>
            <p className="mt-3 text-xs text-muted">{turn.card.note}</p>
          </div>
        )}
      </div>
    </li>
  );
}

function Exchange({ example }: { example: EddyExample }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-widest text-muted">{example.label}</p>
      <ol className="mt-3 space-y-3" aria-label={`Example in ${example.label}`}>
        {example.turns.map((t, i) => (
          <Turn key={i} turn={t} lang={example.lang} />
        ))}
      </ol>
    </div>
  );
}

/** A styled, clearly labelled sample of talking to Eddy. It is an illustration, not a recording. */
export function EddySample() {
  return (
    <figure className="space-y-4" aria-labelledby="eddy-sample-caption">
      <figcaption id="eddy-sample-caption" className="text-sm text-muted">
        <span className="font-semibold text-foreground">Example conversations.</span> Illustrations only: names and numbers are made up.
      </figcaption>
      {EDDY_EXAMPLES.map((e) => (
        <Exchange key={e.label} example={e} />
      ))}
    </figure>
  );
}

const METER: Record<(typeof SPEND_PREVIEW)[number]["tone"], string> = { good: "bg-accent", warn: "bg-warn" };

/** A simplified picture of Settings > Spending limits. Status words only, no amounts. */
export function SpendPreview() {
  return (
    <figure className="rounded-2xl border border-border bg-background p-5" aria-labelledby="spend-preview-caption">
      <figcaption id="spend-preview-caption" className="text-sm text-muted">
        <span className="font-semibold text-foreground">Spending limits</span>, simplified. An illustration of the page in Settings.
      </figcaption>
      <ul className="mt-4 space-y-4">
        {SPEND_PREVIEW.map((p) => (
          <li key={p.label}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
              <span className="font-semibold">{p.label}</span>
              <span className={p.tone === "warn" ? "font-medium text-warn-fg" : "font-medium text-muted"}>{p.status}</span>
            </div>
            <span aria-hidden="true" className="mt-2 block h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
              <span className={`block h-full rounded-full ${METER[p.tone]}`} style={{ width: `${p.percent}%` }} />
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-4 text-sm">
        <span className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 font-semibold">
          <Icon name="stop" className="h-4 w-4" />
          Stop all spending
        </span>
        <span className="text-muted">Lowering and stopping are never blocked.</span>
      </p>
    </figure>
  );
}
