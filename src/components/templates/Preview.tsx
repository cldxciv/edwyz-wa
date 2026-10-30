import { type TemplateDraft, detectVariables, fillExamples } from "./helpers";

/** Chat-bubble preview of a template with the sample values filled in. Uses theme tokens so it reads in light and dark. */
export function Preview({ draft }: { draft: TemplateDraft }) {
  const header = draft.headerKind === "TEXT" && draft.header ? fillExamples(draft.header, [draft.headerExample]) : "";
  return (
    <div className="rounded-card border border-border bg-surface-2 p-4" aria-label="Preview of your message" role="group">
      <div className="max-w-xs rounded-lg rounded-tl-none border border-border bg-raised p-3 text-sm text-foreground shadow-raised">
        {draft.headerKind !== "TEXT" && (
          <div className="mb-2 flex h-24 items-center justify-center rounded-lg bg-surface-2 px-2 text-center text-xs text-muted">
            {draft.headerMedia ? `${draft.headerKind.charAt(0)}${draft.headerKind.slice(1).toLowerCase()} header: ${draft.headerMedia.filename ?? "sample file"}` : "Header file not added yet"}
          </div>
        )}
        {header && <p className="mb-1 break-words font-semibold">{header}</p>}
        <p className="whitespace-pre-wrap break-words">{draft.body ? fillExamples(draft.body, draft.bodyExamples) : <span className="text-muted">Your message appears here as you type.</span>}</p>
        {draft.footer && <p className="mt-2 break-words text-xs text-muted">{draft.footer}</p>}
      </div>
      {draft.buttons
        .filter((b) => b.text)
        .map((b, i) => (
          <div key={i} className="mt-1 max-w-xs break-words rounded-lg border border-border bg-raised px-3 py-2 text-center text-sm font-medium text-accent-ink shadow-raised">
            {b.text}
            {b.type === "URL" && <span className="sr-only"> (opens a website)</span>}
            {b.type === "PHONE_NUMBER" && <span className="sr-only"> (calls a phone number)</span>}
          </div>
        ))}
    </div>
  );
}
