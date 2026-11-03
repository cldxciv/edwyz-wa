"use client";

/**
 * WelcomeMessageEditor (docs/IG-PAGE-ADS-SPEC.md 3.3 step 2, 3.6 step 2, 7.3): "First message people send you" and up to 3
 * quick questions, for the chat goals (WhatsApp, Instagram DMs, Messenger).
 *
 * The first message is pre-filled (the saved welcome, else "Hi! I saw your ad and want to know more"). Quick questions come
 * from preset chips ("Price?", "Do you deliver to my area?", "Timings?") or are typed; each has a question of up to 80
 * characters and a reply of up to 300. Errors are tied to their fields with aria-describedby. Controlled: the step saves.
 */
import { useId } from "react";
import { Button, cn, Input, Textarea } from "@/components/ui";
import type { PromoteLang } from "@/lib/promote/types";
import {
  addQuickQuestion,
  PROMOTE_TEST_IDS,
  QUICK_QUESTION_REPLY_MAX,
  QUICK_QUESTION_TITLE_MAX,
  QUICK_QUESTIONS_MAX,
  quickQuestionPresets,
  WELCOME_MESSAGE_MAX,
  welcomeProblems,
  type WelcomeValue,
} from "./flow-helpers";
import { usePromoteCopy } from "./usePromoteCopy";

export type WelcomeMessageEditorProps = {
  value: WelcomeValue;
  onChange: (value: WelcomeValue) => void;
  /** Show the problems (after the member tried to go on). */
  showErrors?: boolean;
  lang?: PromoteLang;
  className?: string;
};

function FieldError({ id, text }: { id: string; text: string | null }) {
  if (!text) return null;
  return (
    <p id={id} role="alert" className="text-xs font-medium text-bad-fg">
      {text}
    </p>
  );
}

export function WelcomeMessageEditor({ value, onChange, showErrors = false, lang = "en", className }: WelcomeMessageEditorProps) {
  const t = usePromoteCopy(lang);
  const uid = useId();
  const problems = welcomeProblems(value, lang);
  const presets = quickQuestionPresets(lang).filter((p) => !value.iceBreakers.some((q) => q.title.trim().toLowerCase() === p.toLowerCase()));
  const full = value.iceBreakers.length >= QUICK_QUESTIONS_MAX;
  const msgId = `${uid}-message`;
  const msgErr = `${msgId}-error`;
  const msgHint = `${msgId}-hint`;

  const setQuestion = (i: number, patch: Partial<WelcomeValue["iceBreakers"][number]>) =>
    onChange({ ...value, iceBreakers: value.iceBreakers.map((q, j) => (j === i ? { ...q, ...patch } : q)) });

  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)} data-testid={PROMOTE_TEST_IDS.welcome}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={msgId} className="text-sm font-medium">
          {t("chat.first_message")}
        </label>
        <Textarea
          id={msgId}
          value={value.message}
          maxLength={WELCOME_MESSAGE_MAX}
          rows={2}
          aria-invalid={showErrors && problems.message ? true : undefined}
          aria-describedby={showErrors && problems.message ? `${msgHint} ${msgErr}` : msgHint}
          onChange={(e) => onChange({ ...value, message: e.target.value })}
        />
        <p id={msgHint} className="text-xs text-muted">
          {t("chat.leads_note")}
        </p>
        <FieldError id={msgErr} text={showErrors ? problems.message : null} />
      </div>

      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="text-sm font-medium">{t("chat.quick_questions")}</legend>
        <p className="text-xs text-muted">{t("chat.qq_limits")}</p>
        {value.iceBreakers.map((q, i) => {
          const n = String(i + 1);
          const qId = `${uid}-q${i}`;
          const rId = `${uid}-r${i}`;
          const p = problems.questions[i];
          return (
            <div key={i} className="flex min-w-0 flex-col gap-2 rounded-card border border-border p-3">
              <label htmlFor={qId} className="text-sm font-medium">
                {t("welcome.question", { n })}
              </label>
              <Input
                id={qId}
                value={q.title}
                maxLength={QUICK_QUESTION_TITLE_MAX}
                aria-invalid={showErrors && p?.title ? true : undefined}
                aria-describedby={showErrors && p?.title ? `${qId}-error` : undefined}
                onChange={(e) => setQuestion(i, { title: e.target.value })}
              />
              <FieldError id={`${qId}-error`} text={showErrors ? (p?.title ?? null) : null} />
              <label htmlFor={rId} className="text-sm font-medium">
                {t("welcome.reply", { n })}
              </label>
              <Textarea
                id={rId}
                value={q.response}
                rows={2}
                maxLength={QUICK_QUESTION_REPLY_MAX}
                aria-invalid={showErrors && p?.response ? true : undefined}
                aria-describedby={showErrors && p?.response ? `${rId}-error` : undefined}
                onChange={(e) => setQuestion(i, { response: e.target.value })}
              />
              <FieldError id={`${rId}-error`} text={showErrors ? (p?.response ?? null) : null} />
              <Button type="button" variant="ghost" className="self-start pointer-coarse:min-h-11" onClick={() => onChange({ ...value, iceBreakers: value.iceBreakers.filter((_, j) => j !== i) })}>
                {t("welcome.remove", { n })}
              </Button>
            </div>
          );
        })}
        {!full && (
          <div className="flex flex-col gap-2">
            {presets.length > 0 && (
              <div role="group" aria-label={t("welcome.presets")} className="flex flex-wrap gap-2">
                {presets.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="min-h-11 rounded-full border border-border bg-raised px-4 text-sm font-medium transition-colors duration-(--dur-fast) hover:bg-surface-2"
                    onClick={() => onChange({ ...value, iceBreakers: addQuickQuestion(value.iceBreakers, p, lang) })}
                  >
                    + {p}
                  </button>
                ))}
              </div>
            )}
            <Button
              type="button"
              variant="secondary"
              className="self-start pointer-coarse:min-h-11"
              onClick={() => onChange({ ...value, iceBreakers: [...value.iceBreakers, { title: "", response: t("welcome.reply_default") }] })}
            >
              {t("welcome.add")}
            </Button>
          </div>
        )}
      </fieldset>
    </div>
  );
}

export default WelcomeMessageEditor;
