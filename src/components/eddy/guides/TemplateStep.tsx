"use client";

/**
 * Step 2 of the guided setup: the first template (docs/EDDY-SPEC.md 6.8 step 2, EDDY-17 acceptance 3).
 *
 * One question at a time, with chips: the purpose (Offer, Order update, Reminder, Other), then the customers' language
 * (English, Hindi). Then [Draft it with Eddy] sends the member's own message, in the member's language, and Eddy takes it
 * from there with search_help (category guidance: an offer is Marketing), create_template_draft (a local draft with Undo and
 * a WhatsApp-bubble preview) and the submit_template card ("Submit `diwali_offer` to Meta for review?", with "This goes to
 * Meta."). Nothing reaches Meta until the member taps Submit on that card.
 *
 * When Eddy can't chat (the off states), the same card says so and links to /app/templates/new, so it never strands.
 */
import { useId, useState } from "react";
import { Button, cn } from "@/components/ui";
import { categoryNote, customerLangLabel, CUSTOMER_LANGS, purposeLabel, templateQuery, TEMPLATE_PURPOSES, TEMPLATES_NEW_PATH, tg, type CustomerLang, type GuideCard, type TemplatePurpose } from "@/lib/eddy/guides";
import { htmlLang, type EddyLang } from "@/lib/eddy/i18n";
import { ProgressSteps, type ProgressStep } from "../ProgressSteps";
import { GuideLink } from "./SetupGuide";

export type TemplateAnswers = { purpose: TemplatePurpose | null; customers: CustomerLang | null; sent: boolean };

/** The progress line: purpose, customers' language, draft (Eddy), submit to Meta (the card). */
export function templateProgress(lang: EddyLang, a: TemplateAnswers): ProgressStep[] {
  const state = (done: boolean, current: boolean): ProgressStep["state"] => (done ? "done" : current ? "current" : "todo");
  return [
    { id: "purpose", label: tg(lang, "guides.template.progress.purpose"), state: state(!!a.purpose, !a.purpose) },
    { id: "language", label: tg(lang, "guides.template.progress.language"), state: state(!!a.customers, !!a.purpose && !a.customers) },
    { id: "draft", label: tg(lang, "guides.template.progress.draft"), state: state(false, !!a.customers && !a.sent) },
    { id: "submit", label: tg(lang, "guides.template.progress.submit"), state: state(false, a.sent) },
  ];
}

export function ChipGroup<V extends string>({ label, options, value, onPick, lang }: { label: string; options: readonly { value: V; label: string }[]; value: V | null; onPick: (v: V) => void; lang: EddyLang }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-2">
      <p id={id} className={cn("font-semibold text-foreground", lang === "hi" ? "text-base leading-[1.6]" : "text-sm")}>
        {label}
      </p>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Button key={o.value} type="button" size="sm" variant={value === o.value ? "primary" : "secondary"} aria-pressed={value === o.value} className="pointer-coarse:min-h-11" onClick={() => onPick(o.value)} data-guide-chip={o.value}>
            {o.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

export type TemplateStepProps = {
  lang: EddyLang;
  card: GuideCard;
  canChat: boolean;
  onAsk: (query: string) => void;
  onNavigate?: (path: string) => void;
  /** Starting answers (tests, or a card restored after the panel reopened). */
  initial?: Partial<TemplateAnswers>;
};

export function TemplateStep({ lang, card, canChat, onAsk, onNavigate, initial }: TemplateStepProps) {
  const [a, setA] = useState<TemplateAnswers>({ purpose: initial?.purpose ?? null, customers: initial?.customers ?? null, sent: initial?.sent ?? false });
  const body = lang === "hi" ? "text-base leading-[1.6]" : "text-sm";
  // The hand-made way is always on the card; it is the primary button until [Draft it with Eddy] can be tapped.
  const draftReady = canChat && !!a.customers && !a.sent;
  const selfLink = <GuideLink path={TEMPLATES_NEW_PATH} label={canChat ? tg(lang, "guides.template.self") : card.primary?.label ?? tg(lang, "guides.template.self")} primary={!canChat} onNavigate={onNavigate} part={draftReady ? "self" : "primary"} />;

  if (!canChat) {
    return (
      <div className="flex flex-col gap-2" data-guide-template="off" lang={htmlLang(lang)}>
        <p className={cn("text-muted", body)}>{tg(lang, "guides.template.ai_off")}</p>
        <div className="flex flex-wrap gap-2">{selfLink}</div>
      </div>
    );
  }

  const send = () => {
    if (!a.purpose || !a.customers) return;
    onAsk(templateQuery(lang, a.purpose, a.customers));
    setA((x) => ({ ...x, sent: true }));
  };

  return (
    <div className="flex flex-col gap-3" data-guide-template={a.sent ? "sent" : a.customers ? "ready" : a.purpose ? "language" : "purpose"} lang={htmlLang(lang)}>
      <ProgressSteps steps={templateProgress(lang, a)} lang={lang} />
      {!a.sent && (
        <ChipGroup lang={lang} label={tg(lang, "guides.template.q_purpose")} value={a.purpose} options={TEMPLATE_PURPOSES.map((p) => ({ value: p, label: purposeLabel(lang, p) }))} onPick={(purpose) => setA((x) => ({ ...x, purpose }))} />
      )}
      {a.purpose && <p className={cn("text-muted", body)}>{categoryNote(lang, a.purpose)}</p>}
      {a.purpose && !a.sent && (
        <ChipGroup lang={lang} label={tg(lang, "guides.template.q_language")} value={a.customers} options={CUSTOMER_LANGS.map((l) => ({ value: l, label: customerLangLabel(lang, l) }))} onPick={(customers) => setA((x) => ({ ...x, customers }))} />
      )}
      {a.customers && !a.sent && (
        <>
          <p className={cn("text-muted", body)}>{tg(lang, "guides.template.after")}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" className="pointer-coarse:min-h-11" onClick={send} data-guide-part="primary">
              {tg(lang, "guides.template.draft")}
            </Button>
            {selfLink}
          </div>
        </>
      )}
      {!a.customers && <div className="flex flex-wrap gap-2">{selfLink}</div>}
      <p role="status" aria-live="polite" className={a.sent ? cn("text-muted", body) : "sr-only"}>
        {a.sent ? tg(lang, "guides.template.sent") : ""}
      </p>
      {a.sent && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={() => setA({ purpose: null, customers: null, sent: false })}>
            {tg(lang, "guides.template.change")}
          </Button>
          {selfLink}
        </div>
      )}
    </div>
  );
}
