"use client";

/**
 * The instant-form step (docs/IG-PAGE-ADS-SPEC.md 3.5 step 2, 7.3, 7.6, D35) and the form builder page body
 * (/app/leads/forms/new, 7.1, 6.5 create_lead_form as a page dialog).
 *
 * FormStep is controlled: preset chips, a question list of at most 15 (reordered with buttons, or by dragging on a desktop),
 * More people or Fewer, more serious people, the business's own https privacy link, the thank-you button (Chat on WhatsApp by
 * default, or Call, or Website), the optional WhatsApp consent box (shown unticked; there is no "required" option), and the
 * Lead Gen terms readiness row with the server-resolved Opens Meta button and [I've accepted].
 *
 * LeadFormBuilder holds the state, shows the lazy-loaded LeadFormPreview, and creates the form after a danger-style confirm
 * dialog with focus on Cancel first. Errors are tied to their fields with aria-describedby and announced through Alert.
 */
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode, type Ref } from "react";
import { Alert, Badge, Button, Dialog, EmptyState, FormField, Input, PageHeader, Select, Skeleton, apiFetch, buttonSizes, buttonVariants, cn, toast } from "@/components/ui";
import { promoteText, type PromoteCopyKey } from "@/lib/promote/copy";
import type { LeadQuestionType } from "@/lib/promote/catalog/lead-questions";
import type { ReadinessStatus } from "@/lib/promote/types";
import { OpensMetaButton } from "./OpensMetaButton";
import {
  BUILDER_PATH,
  FORMS_PATH,
  FORM_BUILDER_TEXT as T,
  FORM_TYPE_VALUES,
  MAX_FORM_QUESTIONS,
  MAX_QUALIFYING_QUESTIONS,
  THANK_YOU_KINDS,
  addQuestion,
  addableQuestionTypes,
  applyPreset,
  buildFormSpec,
  consentWords,
  copyFromSpec,
  copyName,
  copyNotes,
  createConfirmCopy,
  createRequest,
  defaultFormName,
  isPrefilled,
  moveQuestion,
  newBuilderState,
  presetKeys,
  previewScreens,
  problemsByField,
  problemsFromServer,
  questionLabel,
  recheckLeadgenTerms,
  recheckMessage,
  removeQuestion,
  reorderQuestion,
  runOnce,
  sendCreate,
  setQuestionLabel,
  suggestionChips,
  thankYouLabel,
  thankYouTarget,
  pageLabel,
  type BuilderContext,
  type BuilderField,
  type BuilderProblem,
  type BuilderProps,
  type BuilderState,
  type FormSpecBody,
  type ThankYouKind,
} from "./form-builder-helpers";

const LeadFormPreview = dynamic(() => import("./LeadFormPreview"), {
  ssr: false,
  loading: () => (
    <div aria-busy="true" className="space-y-3">
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-96 w-full" />
      <span className="sr-only">Loading the preview</span>
    </div>
  ),
});

const TOUCH = "min-h-11";
const choiceClass = (on: boolean) =>
  cn(
    "flex min-h-11 cursor-pointer items-start gap-3 rounded-control border p-3 text-sm transition-colors duration-(--dur-fast)",
    on ? "border-accent bg-surface" : "border-border-strong bg-raised hover:bg-surface-2",
  );

// =====================================================================================================================
// FormStep
// =====================================================================================================================

export type LeadgenReadiness = {
  status: ReadinessStatus;
  /** Resolved on the server from the Opens Meta allowlist; null hides the button. */
  href: string | null;
  checking: boolean;
  message: string | null;
  onRecheck: () => void;
};

export type FormStepProps = {
  state: BuilderState;
  onChange: (next: BuilderState) => void;
  ctx: BuilderContext;
  errors?: Partial<Record<BuilderField, string>>;
  readiness?: LeadgenReadiness | null;
  /** Move focus to the step heading when it appears (7.6: focus moves to the step's h2). */
  focusOnMount?: boolean;
  /** Fields shown above the name (the builder page puts the Page picker here). */
  children?: ReactNode;
  className?: string;
};

function FieldError({ id, message }: { id: string; message?: string | null }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs font-medium text-bad-fg">
      {message}
    </p>
  );
}

function ArrowIcon({ down }: { down?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("h-4 w-4", down && "rotate-180")} aria-hidden="true" focusable="false">
      <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FormStep({ state, onChange, ctx, errors = {}, readiness, focusOnMount = true, children, className }: FormStepProps) {
  const uid = useId();
  const ids = {
    heading: `${uid}-heading`,
    presets: `${uid}-presets`,
    questionsHint: `${uid}-questions-hint`,
    questionsError: `${uid}-questions-error`,
    addSelect: `${uid}-add`,
    addError: `${uid}-add-error`,
    formType: `${uid}-type`,
    thankYouError: `${uid}-thank-error`,
    consentHint: `${uid}-consent-hint`,
    readiness: `${uid}-readiness`,
  };
  const heading = useRef<HTMLHeadingElement>(null);
  const [live, setLive] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [pick, setPick] = useState<string>("");
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  useEffect(() => {
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount]);

  const customCount = state.questions.filter((q) => q.type === "CUSTOM").length;
  const full = state.questions.length >= MAX_FORM_QUESTIONS;
  const chips = suggestionChips(state);
  const addable = addableQuestionTypes(state);
  const target = thankYouTarget(state.thankYou, ctx);
  const box = consentWords(state, ctx).box;

  function add(question: Parameters<typeof addQuestion>[1]) {
    const r = addQuestion(state, question);
    setAddError(r.error);
    if (r.error) {
      setLive(r.error);
      return;
    }
    onChange(r.state);
    setLive(T.added(questionLabel({ type: question.type, label: question.label ?? "" })));
  }

  function move(index: number, delta: -1 | 1) {
    const next = moveQuestion(state, index, delta);
    if (next === state) return;
    onChange(next);
    const q = state.questions[index];
    setLive(T.moved(questionLabel(q), index + delta + 1));
  }

  function remove(index: number) {
    const q = state.questions[index];
    onChange(removeQuestion(state, q.uid));
    setAddError(null);
    setLive(T.removed(questionLabel(q)));
  }

  function onDrop(e: DragEvent<HTMLLIElement>, to: number) {
    e.preventDefault();
    if (dragFrom === null) return;
    const q = state.questions[dragFrom];
    onChange(reorderQuestion(state, dragFrom, to));
    setDragFrom(null);
    if (q) setLive(T.moved(questionLabel(q), to + 1));
  }

  const questionsDescribedBy = [ids.questionsHint, errors.questions ? ids.questionsError : null].filter(Boolean).join(" ");

  return (
    <section aria-labelledby={ids.heading} data-testid="form-step" className={cn("min-w-0 space-y-6", className)}>
      <h2 id={ids.heading} ref={heading} tabIndex={-1} data-testid="form-step-heading" className="rounded-control text-lg font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {promoteText("form.title")}
      </h2>
      <p aria-live="polite" className="sr-only" data-testid="form-step-status">
        {live}
      </p>

      {children}

      <FormField label={T.name} hint={T.nameHint} error={errors.name}>
        <Input value={state.name} maxLength={120} className={TOUCH} data-testid="form-name" onChange={(e) => onChange({ ...state, name: e.target.value })} />
      </FormField>

      <fieldset aria-describedby={ids.presets} className="min-w-0 space-y-2">
        <legend className="text-sm font-medium">{T.presets}</legend>
        <p id={ids.presets} className="sr-only">
          {T.questionsHint}
        </p>
        <div className="flex flex-wrap gap-2">
          {presetKeys().map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={state.preset === key}
              data-testid={`form-preset-${key}`}
              onClick={() => {
                onChange(applyPreset(state, key));
                setAddError(null);
                setLive(T.presetLabels[key]);
              }}
              className={cn("inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium transition-colors duration-(--dur-fast)", state.preset === key ? "border-accent bg-accent text-on-accent" : "border-border-strong bg-raised text-foreground hover:bg-surface-2")}
            >
              {T.presetLabels[key]}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset aria-describedby={questionsDescribedBy} className="min-w-0 space-y-3" data-testid="form-questions">
        <legend className="text-sm font-medium">{T.questions}</legend>
        <p id={ids.questionsHint} className="text-xs text-muted">
          {T.questionsHint} {T.questionCount(state.questions.length)}
        </p>
        <ol className="space-y-2">
          {state.questions.map((q, i) => {
            const label = questionLabel(q);
            return (
              <li
                key={q.uid}
                draggable
                onDragStart={() => setDragFrom(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => onDrop(e, i)}
                onDragEnd={() => setDragFrom(null)}
                data-testid={`form-question-${i}`}
                className={cn("rounded-control border border-border bg-raised p-3", dragFrom === i && "opacity-60")}
              >
                <div className="flex flex-wrap items-start gap-2">
                  <span className="mt-2.5 w-6 shrink-0 text-xs font-medium tabular-nums text-muted" aria-hidden="true">
                    {i + 1}.
                  </span>
                  <div className="min-w-0 flex-1">
                    {q.type === "CUSTOM" ? (
                      <FormField label={`${T.ownLabel} ${i + 1}`}>
                        <Input value={q.label} maxLength={300} className={TOUCH} data-testid={`form-question-label-${i}`} onChange={(e) => onChange(setQuestionLabel(state, q.uid, e.target.value))} />
                      </FormField>
                    ) : (
                      <p className="pt-2.5 text-sm font-medium">{label}</p>
                    )}
                    {isPrefilled(q.type) && <p className="mt-1 text-xs text-muted">{T.prefilled}</p>}
                    {q.options?.length ? <p className="mt-1 text-xs text-muted">{T.answers(q.options.map((o) => o.value).join(", "))}</p> : null}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" className={cn(TOUCH, "px-3")} aria-label={T.moveUp(label)} disabled={i === 0} onClick={() => move(i, -1)} data-testid={`form-question-up-${i}`}>
                      <ArrowIcon />
                    </Button>
                    <Button variant="ghost" className={cn(TOUCH, "px-3")} aria-label={T.moveDown(label)} disabled={i === state.questions.length - 1} onClick={() => move(i, 1)} data-testid={`form-question-down-${i}`}>
                      <ArrowIcon down />
                    </Button>
                    <Button variant="ghost" className={cn(TOUCH, "px-3")} aria-label={T.remove(label)} onClick={() => remove(i)} data-testid={`form-question-remove-${i}`}>
                      <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true" focusable="false">
                        <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                      </svg>
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        <FieldError id={ids.questionsError} message={errors.questions} />

        <div className="flex flex-wrap gap-2">
          {chips.map((chip) => (
            <Button key={chip.id} variant="secondary" className={TOUCH} disabled={full} onClick={() => add(chip.question)} data-testid={`form-chip-${chip.id}`} aria-describedby={addError ? ids.addError : undefined}>
              {chip.label}
            </Button>
          ))}
          <Button
            variant="secondary"
            className={TOUCH}
            disabled={full || customCount >= MAX_QUALIFYING_QUESTIONS}
            onClick={() => add({ type: "CUSTOM", label: "" })}
            data-testid="form-add-own"
            aria-describedby={addError ? ids.addError : undefined}
          >
            {T.addOwn}
          </Button>
        </div>
        {addable.length > 0 && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <label htmlFor={ids.addSelect} className="text-sm font-medium">
                {T.addQuestion}
              </label>
              <Select id={ids.addSelect} value={pick} className={TOUCH} disabled={full} onChange={(e) => setPick(e.target.value)} data-testid="form-add-select" aria-describedby={addError ? ids.addError : undefined}>
                <option value="">{T.addQuestionPick}</option>
                {addable.map((t) => (
                  <option key={t} value={t}>
                    {promoteText(`form.q.${t}` as PromoteCopyKey)}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="secondary"
              className={TOUCH}
              disabled={full || !pick}
              data-testid="form-add-question"
              onClick={() => {
                if (!pick) return;
                add({ type: pick as LeadQuestionType });
                setPick("");
              }}
            >
              {T.addQuestion}
            </Button>
          </div>
        )}
        <FieldError id={ids.addError} message={addError} />
      </fieldset>

      <fieldset className="min-w-0 space-y-2" data-testid="form-type">
        <legend className="text-sm font-medium">{T.formType}</legend>
        {FORM_TYPE_VALUES.map((value) => (
          <label key={value} className={choiceClass(state.formType === value)} data-testid={`form-type-${value}`}>
            <input type="radio" name={ids.formType} value={value} checked={state.formType === value} onChange={() => onChange({ ...state, formType: value })} className="mt-0.5 h-4 w-4 shrink-0 accent-accent" />
            <span>{promoteText(`form.type.${value}` as PromoteCopyKey)}</span>
          </label>
        ))}
      </fieldset>

      <FormField label={promoteText("form.privacy_label")} hint={promoteText("form.privacy_help")} error={errors.privacyUrl} required>
        <Input
          type="url"
          inputMode="url"
          autoComplete="url"
          placeholder="https://"
          value={state.privacyUrl}
          className={TOUCH}
          data-testid="form-privacy"
          onChange={(e) => onChange({ ...state, privacyUrl: e.target.value })}
        />
      </FormField>

      <fieldset aria-describedby={errors.thankYou ? ids.thankYouError : undefined} className="min-w-0 space-y-2" data-testid="form-thank-you">
        <legend className="text-sm font-medium">{T.thankYou}</legend>
        <p className="text-xs text-muted">{T.thankYouHint}</p>
        {THANK_YOU_KINDS.map((kind: ThankYouKind) => (
          <label key={kind} className={choiceClass(state.thankYou.kind === kind)} data-testid={`form-thank-you-${kind}`}>
            <input
              type="radio"
              name={`${uid}-thank`}
              value={kind}
              checked={state.thankYou.kind === kind}
              onChange={() => onChange({ ...state, thankYou: { ...state.thankYou, kind } })}
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            />
            <span>{thankYouLabel(kind)}</span>
          </label>
        ))}
        {state.thankYou.kind === "whatsapp" && "display" in target && <p className="text-xs text-muted">{T.waTarget(target.display)}</p>}
        {state.thankYou.kind === "call" && (
          <FormField label={T.callNumber} hint={T.callHint}>
            <Input type="tel" inputMode="tel" autoComplete="tel" value={state.thankYou.phone} className={TOUCH} data-testid="form-thank-you-phone" onChange={(e) => onChange({ ...state, thankYou: { ...state.thankYou, phone: e.target.value } })} />
          </FormField>
        )}
        {state.thankYou.kind === "website" && (
          <FormField label={T.website} hint={T.websiteHint}>
            <Input type="url" inputMode="url" placeholder="https://" value={state.thankYou.website} className={TOUCH} data-testid="form-thank-you-website" onChange={(e) => onChange({ ...state, thankYou: { ...state.thankYou, website: e.target.value } })} />
          </FormField>
        )}
        <FieldError id={ids.thankYouError} message={errors.thankYou} />
      </fieldset>

      <fieldset className="min-w-0 space-y-2" data-testid="form-consent" aria-describedby={ids.consentHint}>
        <legend className="text-sm font-medium">{T.consent}</legend>
        <label className={choiceClass(state.askConsent)}>
          <input type="checkbox" checked={state.askConsent} onChange={(e) => onChange({ ...state, askConsent: e.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-accent" data-testid="form-consent-include" />
          <span>{T.consentInclude}</span>
        </label>
        {state.askConsent ? (
          <div className="rounded-control border border-dashed border-border-strong bg-surface p-3" data-testid="form-consent-sample">
            <p className="mb-2 text-xs font-medium text-muted">{T.consentPreview}</p>
            <p className="flex items-start gap-3 text-sm">
              <span aria-hidden="true" className="mt-0.5 inline-block h-4 w-4 shrink-0 rounded-sm border-2 border-border-strong bg-raised" />
              <span data-testid="form-consent-text">{box.text}</span>
            </p>
          </div>
        ) : (
          <Alert tone="warn">{T.consentOff}</Alert>
        )}
        <p id={ids.consentHint} className="text-xs text-muted">
          {promoteText("form.consent_optional")}
        </p>
      </fieldset>

      {readiness && <LeadgenRow readiness={readiness} id={ids.readiness} />}
    </section>
  );
}

function LeadgenRow({ readiness, id }: { readiness: LeadgenReadiness; id: string }) {
  const tone = readiness.status === "ok" ? "good" : readiness.status === "missing" ? "warn" : "neutral";
  return (
    <div role="group" className="space-y-3 rounded-control border border-border bg-surface p-3" data-testid="form-readiness-leadgen" aria-labelledby={id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={id} className="text-sm font-medium">
          {T.readiness}
        </p>
        <Badge tone={tone} dot>
          {T.readinessState[readiness.status]}
        </Badge>
      </div>
      {readiness.status !== "ok" && (
        <div className="flex flex-wrap items-start gap-2">
          <OpensMetaButton href={readiness.href} screen="leadgen_tos" label={promoteText("readiness.leadgen_tos.fix")} data-testid="form-readiness-opens-meta" />
          <Button variant="secondary" className={TOUCH} loading={readiness.checking} onClick={readiness.onRecheck} data-testid="form-readiness-recheck">
            {promoteText("readiness.leadgen_tos.done")}
          </Button>
        </div>
      )}
      <p aria-live="polite" className="text-xs text-muted" data-testid="form-readiness-status">
        {readiness.checking ? T.rechecking : readiness.message}
      </p>
    </div>
  );
}

// =====================================================================================================================
// The builder page body (/app/leads/forms/new)
// =====================================================================================================================

/** A create that may have reached Meta: what the owner was trying to make, and the server's (or our) words. */
export type UnsureCreate = { name: string; pageName: string; message: string };

/**
 * After an unclear answer to Create (504, a dropped connection): the form may already be on Meta, where it can never be changed
 * or deleted. Create stays off, and this tells the owner to look in Lead forms (Import from Meta lists it) before trying again.
 */
export function CreateUnsureNotice({ unsure, focusRef }: { unsure: UnsureCreate; focusRef?: Ref<HTMLDivElement> }) {
  return (
    <div ref={focusRef} tabIndex={-1} className="mb-4 outline-none" data-testid="form-create-unsure">
      <Alert
        tone="warn"
        title={T.unsureTitle}
        action={
          <Link href={FORMS_PATH} className={cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.secondary, buttonSizes.md, TOUCH)} data-testid="form-create-unsure-check">
            {T.unsureLink}
          </Link>
        }
      >
        <p>{unsure.message}</p>
        <p className="mt-1">{T.unsureCheck(unsure.name, unsure.pageName)}</p>
      </Alert>
    </div>
  );
}

/** The sticky Create bar. On a phone it sits just above the bottom menu bar (3.25rem plus the safe area, see MobileTabBar). */
export const CREATE_BAR_CLASS =
  "sticky bottom-[calc(3.25rem+env(safe-area-inset-bottom))] z-(--z-sticky) mt-6 rounded-card border border-border bg-raised p-3 shadow-raised md:bottom-0 md:pb-[max(0.75rem,env(safe-area-inset-bottom))]";

export function LeadFormBuilder({ pages, whatsappNumber, verifiedName, privacyUrl, copyFrom, today }: BuilderProps) {
  const router = useRouter();
  const pageSelectId = useId();
  const summary = useRef<HTMLDivElement>(null);
  const unsureRef = useRef<HTMLDivElement>(null);
  const sending = useRef(false);
  const [pageId, setPageId] = useState(copyFrom?.pageAssetId ?? pages[0]?.id ?? "");
  const page = pages.find((p) => p.id === pageId) ?? null;
  const ctx: BuilderContext = useMemo(() => ({ whatsappNumber, businessName: page?.name?.trim() || verifiedName, pageName: page ? pageLabel(page) : null }), [whatsappNumber, verifiedName, page]);
  // An edited copy starts from the stored spec; anything that couldn't be carried over is named in a notice, never dropped silently.
  const [copyStart] = useState(() => (copyFrom ? copyFromSpec(copyFrom.spec, { name: copyName(copyFrom.name), whatsappNumber, privacyUrl }) : null));
  const [state, setState] = useState<BuilderState>(() => copyStart?.state ?? newBuilderState({ privacyUrl, name: defaultFormName(today), whatsappNumber }));
  const notes = copyStart ? copyNotes(copyStart) : [];
  const [problems, setProblems] = useState<BuilderProblem[]>([]);
  const [leadgen, setLeadgen] = useState<Record<string, ReadinessStatus>>({});
  const [checking, setChecking] = useState(false);
  const [recheckNote, setRecheckNote] = useState<string | null>(null);
  const [pending, setPending] = useState<FormSpecBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [unsure, setUnsure] = useState<UnsureCreate | null>(null);

  const screens = useMemo(() => previewScreens(state, ctx), [state, ctx]);
  const errors = problemsByField(problems);
  const copyPageGone = Boolean(copyFrom && !page);

  useEffect(() => {
    if (problems.length) summary.current?.focus();
  }, [problems]);

  useEffect(() => {
    if (unsure) unsureRef.current?.focus();
  }, [unsure]);

  function change(next: BuilderState) {
    setState(next);
  }

  async function recheck() {
    if (!page) return;
    setChecking(true);
    setRecheckNote(null);
    const status = await recheckLeadgenTerms(page, {
      get: (path) => apiFetch(path),
      post: (path, body) => apiFetch(path, { method: "POST", body }),
    });
    setLeadgen((m) => ({ ...m, [page.id]: status }));
    setRecheckNote(recheckMessage(status));
    setChecking(false);
  }

  function create() {
    if (unsure) return;
    if (!page) {
      setProblems([{ field: "form", message: copyPageGone ? T.pageGone : T.noPages }]);
      return;
    }
    const r = buildFormSpec(state, ctx, { today });
    if (!r.spec) {
      setProblems(r.problems);
      return;
    }
    setProblems([]);
    setPending(r.spec);
  }

  /**
   * Sends the form once. A second tap while it is on its way does nothing. After an unclear answer Create stays off: posting
   * again could make a second form on Meta that can never be changed or deleted, so the owner checks Lead forms first.
   */
  async function confirmCreate() {
    if (busy || unsure || !pending || !page) return;
    const spec = pending;
    const target = page;
    await runOnce(sending, async () => {
      setBusy(true);
      try {
        // Same-origin only (spend-bypass B12): a create always goes to /api/leads/forms/… (createRequest), so the URL is pinned to it.
        const answer = await sendCreate(createRequest(copyFrom?.id, target.id, spec), (path, init) => fetch(`/api/leads/forms/${path.replace(/^\/api\/leads\/forms\//, "")}`, init));
        setPending(null);
        if (answer.ok) {
          toast.success(T.created(spec.name, pageLabel(target)), answer.dryRun ? { description: T.dryRun } : undefined);
          router.push(FORMS_PATH);
          return;
        }
        if (answer.unsure) {
          setProblems([]);
          setUnsure({ name: spec.name, pageName: pageLabel(target), message: answer.message });
          return;
        }
        if (answer.code === "leadgen_tos") setLeadgen((m) => ({ ...m, [target.id]: "missing" }));
        const server = problemsFromServer(answer.problems);
        setProblems(server.length ? server : [{ field: "form", message: answer.message }]);
      } finally {
        setBusy(false);
      }
    });
  }

  const confirmCopy = pending && page ? createConfirmCopy(pending, pageLabel(page)) : null;
  const readiness: LeadgenReadiness | null = page
    ? { status: leadgen[page.id] ?? page.leadgenTos, href: page.leadgenHref, checking, message: recheckNote, onRecheck: () => void recheck() }
    : null;

  const back = (
    <Link href={FORMS_PATH} className={cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.secondary, buttonSizes.md, TOUCH)} data-testid="form-builder-back">
      {T.backToForms}
    </Link>
  );

  return (
    <div data-testid="form-builder" data-builder-path={BUILDER_PATH}>
      <PageHeader title={copyFrom ? T.pageTitleCopy : T.pageTitle} description={T.pageDescription} actions={back} />
      {copyFrom && (
        <Alert className="mb-4" tone="info">
          {T.copyNote}
        </Alert>
      )}
      {notes.length > 0 && (
        <div className="mb-4" data-testid="form-copy-notes">
          <Alert tone="warn" title={T.copyNotesTitle}>
            {notes.map((n) => (
              <p key={n} className="mt-1 first:mt-0">
                {n}
              </p>
            ))}
          </Alert>
        </div>
      )}
      {pages.length === 0 ? (
        <EmptyState
          title={T.noPages}
          action={
            <Link href="/app/settings/connections" className={cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.primary, buttonSizes.md, TOUCH)} data-testid="form-builder-connect">
              {T.connectPage}
            </Link>
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          <div className="min-w-0">
            {unsure && <CreateUnsureNotice unsure={unsure} focusRef={unsureRef} />}
            {problems.length > 0 && (
              <div ref={summary} tabIndex={-1} className="mb-4 outline-none" data-testid="form-errors">
                <Alert tone="bad" title={T.fixProblems}>
                  <ul className="list-disc space-y-1 pl-5">
                    {problems.map((p, i) => (
                      <li key={`${p.field}-${i}`}>{p.message}</li>
                    ))}
                  </ul>
                </Alert>
              </div>
            )}
            <FormStep state={state} onChange={change} ctx={ctx} errors={errors} readiness={readiness}>
              {copyFrom ? (
                <p className="text-sm" data-testid="form-page">
                  <span className="font-medium">{T.page}:</span> {page ? pageLabel(page) : T.pageGone}
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={pageSelectId} className="text-sm font-medium">
                    {T.page}
                  </label>
                  <Select id={pageSelectId} value={pageId} className={TOUCH} onChange={(e) => {
                      setPageId(e.target.value);
                      setRecheckNote(null);
                    }}
                    data-testid="form-page" aria-describedby={`${pageSelectId}-hint`}>
                    {pages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {pageLabel(p)}
                      </option>
                    ))}
                  </Select>
                  <p id={`${pageSelectId}-hint`} className="text-xs text-muted">
                    {T.pageHint}
                  </p>
                </div>
              )}
            </FormStep>
            <div className={CREATE_BAR_CLASS} data-testid="form-create-bar">
              <Button className="min-h-12 w-full" onClick={create} disabled={copyPageGone || unsure !== null} aria-describedby={unsure ? `${pageSelectId}-unsure` : undefined} data-testid="form-create">
                {T.create}
              </Button>
              {unsure && (
                <p id={`${pageSelectId}-unsure`} className="sr-only">
                  {T.unsureTitle}
                </p>
              )}
              <p className="mt-2 text-center text-xs text-muted">{promoteText("form.permanent_note")}</p>
            </div>
          </div>
          <aside className="min-w-0 lg:sticky lg:top-4" aria-labelledby={`${pageSelectId}-preview`} data-testid="form-preview-panel">
            <h2 id={`${pageSelectId}-preview`} className="mb-3 text-lg font-semibold tracking-tight">
              {T.previewTitle}
            </h2>
            <LeadFormPreview screens={screens} />
          </aside>
        </div>
      )}

      {pending && confirmCopy && (
        <Dialog
          title={confirmCopy.title}
          role="alertdialog"
          onClose={() => {
            if (!busy) setPending(null);
          }}
          dismissible={!busy}
          footer={
            <>
              <Button variant="secondary" className={TOUCH} data-autofocus="" disabled={busy} onClick={() => setPending(null)} data-testid="form-create-cancel">
                {promoteText("card.cancel")}
              </Button>
              <Button variant="danger" className={TOUCH} loading={busy} onClick={() => void confirmCreate()} data-testid="form-create-confirm">
                {T.confirmCreate}
              </Button>
            </>
          }
        >
          <div className="space-y-4 text-sm" data-testid="form-create-dialog">
            <dl className="space-y-3">
              <div>
                <dt className="font-medium">{T.confirmQuestions}</dt>
                <dd>
                  <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-muted">
                    {confirmCopy.questions.map((q, i) => (
                      <li key={`${q}-${i}`}>{q}</li>
                    ))}
                  </ol>
                </dd>
              </div>
              <div>
                <dt className="font-medium">{T.confirmPrivacy}</dt>
                <dd className="break-all text-muted">{confirmCopy.privacyUrl}</dd>
              </div>
              <div>
                <dt className="font-medium">{T.confirmThankYou}</dt>
                <dd className="break-all text-muted">{confirmCopy.thankYou}</dd>
              </div>
              <div>
                <dt className="font-medium">{T.confirmConsent}</dt>
                <dd className="text-muted">{confirmCopy.consent}</dd>
              </div>
              {confirmCopy.otherBoxes && (
                <div>
                  <dt className="font-medium">{T.confirmOtherBoxes}</dt>
                  <dd>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
                      {confirmCopy.otherBoxes.map((b, i) => (
                        <li key={`${b}-${i}`}>{b}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
              {confirmCopy.language && (
                <div>
                  <dt className="font-medium">{T.confirmLanguage}</dt>
                  <dd className="text-muted">{confirmCopy.language}</dd>
                </div>
              )}
            </dl>
            <Alert tone="warn">{confirmCopy.warning}</Alert>
          </div>
        </Dialog>
      )}
    </div>
  );
}
