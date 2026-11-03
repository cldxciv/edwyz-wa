"use client";

/**
 * PromoteShell (docs/IG-PAGE-ADS-SPEC.md 3.1, 3.3 to 3.7, 3.12, 7.2, 7.3, 7.5, 7.6, D2, D4, D5, D15, D23, D28; PRM-14): the Boost
 * and New ad flows around one server draft.
 *
 * - Top bar: Back, the step dots with "Step 2 of 4" (announced politely), and "Save and exit". Leaving (Save and exit, or
 *   Back on the first screen) saves first and goes only once the draft is saved; otherwise it asks "Leave without saving?".
 * - One column with a 16 px gutter. On a desktop a second column pins the live preview (PlacementPreview, lazy-loaded and only
 *   mounted there, so a phone never asks Meta for previews it doesn't show; phones open it from the review card).
 * - A sticky bottom bar above the phone's tab bar: a full-width primary at least 48 px tall, the text secondary under it, the
 *   safe-area inset, and the save state ("Saved" or "Not saved yet", with [Save now]).
 * - Each step is an h2 that takes focus when the step changes. Boost: post, what people do, who and how much, review. New ad:
 *   goal, (form,) ad, who and how much, review.
 * - The draft is made on the server when the first screen is done (a lead form ad after its form: a form's spec can only be given
 *   when a draft is made), then saved after every step and on blur through PATCH with expectedUpdatedAt (usePromoteDraft). The
 *   address keeps the draft and the step, so a reload or a notification tap resumes it (D28).
 * - The review step renders review_promotion (ReviewCard) with "Start boost · up to ₹2,625" (aria-disabled for 600 ms, the typed
 *   figure only above the threshold) and "Save without starting". Start shows only while promoteAccess.canStart (train P3).
 * - The special-category question (3.1) is asked where a save or a create needs it, and the answer is sent with it.
 * Every string comes from promote/copy; pages render English until PROMOTE_PAGE_LANGS allows more (D23).
 */
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { Alert, Button, buttonVariants, cn, confirm, Dialog, Select, Skeleton } from "@/components/ui";
import { promoteText } from "@/lib/promote/copy";
import type { AdMediaView } from "@/lib/promote/media";
import type { GoalKey, SourceKind } from "@/lib/promote/types";
import { adStepInUse, ctaOptions, mediaFileUrl, type AdStepValue } from "./creative-helpers";
import type { BuilderField, BuilderState } from "./form-builder-helpers";
import {
  ADS_PATH,
  adStepFromDraft,
  adStepSet,
  blockingChips,
  boostCreateBody,
  boostGoalChips,
  boostPlan,
  boostSwitchBody,
  categoryChoices,
  clampStep,
  createDraftBody,
  draftMediaIds,
  draftSetOf,
  draftStep,
  exitAction,
  flowHref,
  flowSteps,
  formKept,
  formsForPage,
  goalSet,
  guardTap,
  initialCreateGoal,
  isCategoryQuestion,
  linkSet,
  needsLink,
  needsWelcome,
  planDays,
  planFactsOf,
  postSourceOf,
  previewKey,
  previewPositions,
  primaryLabel,
  PROMOTE_TEST_IDS,
  resumeStep,
  reviewView,
  savedEnough,
  START_GUARD_MS,
  startArmed,
  startReady,
  stepCountLabel,
  stepProblem,
  STEP_TITLE_KEYS,
  welcomeSet,
  type FlowContext,
  type FlowKind,
  type StepId,
  type WelcomeValue,
} from "./flow-helpers";
import { AudienceBudgetStep } from "./AudienceBudgetStep";
import { GoalStep } from "./GoalStep";
import type { PostPick } from "./PostPicker";
import { ReviewCard, useReview } from "./ReviewCard";
import { usePromoteCopy } from "./usePromoteCopy";
import { jsonRequest, usePromoteDraft, type CreateResult } from "./usePromoteDraft";

type FormKit = typeof import("./form-builder-helpers");

function StepLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <p role="status" className="sr-only">
        {promoteText("flow.loading")}
      </p>
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

// The big pieces load only when a flow needs them (7.6: route bundles stay lean).
const PostPicker = dynamic(() => import("./PostPicker"), { ssr: false, loading: StepLoading });
const AdStep = dynamic(() => import("./AdStep"), { ssr: false, loading: StepLoading });
const FormStep = dynamic(() => import("./FormStep").then((m) => m.FormStep), { ssr: false, loading: StepLoading });
const PlacementPreview = dynamic(() => import("./PlacementPreview"), { ssr: false, loading: StepLoading });

const DESKTOP = "(min-width: 1024px)";
const subscribeDesktop = (cb: () => void) => {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener?.("change", cb);
  return () => mq.removeEventListener?.("change", cb);
};
/** True on a desktop-wide screen (the two-column layout). */
function useDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => (typeof window !== "undefined" && !!window.matchMedia ? window.matchMedia(DESKTOP).matches : false),
    () => false,
  );
}

/** The sticky bottom bar (7.2): above the phone's tab bar, at the bottom from md up, with the safe-area inset. */
export const PROMOTE_BAR_CLASS =
  "sticky bottom-[calc(3.25rem+env(safe-area-inset-bottom))] z-(--z-sticky) -mx-4 mt-6 border-t border-border bg-background/95 px-4 pt-3 pb-3 backdrop-blur md:bottom-0 md:pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:mx-0 lg:rounded-card lg:border";
/** The bar's full-width button: at least 48 px tall, and long labels wrap at 320 px ("Create form and start ads · up to ₹3,675"). */
const barBase =
  "inline-flex w-full min-h-12 items-center justify-center gap-2 rounded-full px-6 py-2 text-center text-base font-semibold select-none transition-colors duration-(--dur-fast) disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-60";
const textButton = "inline-flex min-h-11 w-full items-center justify-center rounded-full px-4 text-sm font-semibold text-accent-ink underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50";
const linkPrimary = cn(barBase, buttonVariants.primary);

function BarButton({ variant = "primary", loading, className, children, ...props }: ComponentProps<"button"> & { variant?: "primary" | "secondary"; loading?: boolean }) {
  return (
    <button type="button" className={cn(barBase, buttonVariants[variant], className)} aria-busy={loading || undefined} {...props}>
      {loading && <span className="ui-spinner h-3.5 w-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

function SaveLine({ text, message, canRetry, onRetry, retryLabel }: { text: string | null; message: string | null; canRetry: boolean; onRetry: () => void; retryLabel: string }) {
  return (
    <div className="flex min-h-6 flex-wrap items-center justify-center gap-x-2 text-xs text-muted">
      <p role="status" aria-live="polite" data-testid={PROMOTE_TEST_IDS.saveState} className="break-words">
        {[text, message].filter(Boolean).join(" · ")}
      </p>
      {canRetry && (
        <button type="button" className="min-h-11 px-2 font-semibold text-accent-ink underline underline-offset-2 pointer-fine:min-h-0" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

function StickyBar({ children, status }: { children: ReactNode; status?: ReactNode }) {
  return (
    <div className={PROMOTE_BAR_CLASS} data-testid="promote-bar">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-1">
        {children}
        {status}
      </div>
    </div>
  );
}

/** The special-category question (3.1), with the answers the text suggests. */
function CategoryQuestion({ text, categories, onAnswer, lang }: { text: string; categories: string[]; onAnswer: (answer: string) => void; lang: FlowContext["lang"] }) {
  const t = usePromoteCopy(lang);
  const uid = useId();
  const choices = categoryChoices(categories, lang);
  const [answer, setAnswer] = useState<string>("none");
  return (
    <Alert tone="warn">
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-1 font-semibold break-words">{text}</legend>
        {choices.map((c) => (
          <label key={c.value} className="flex min-h-11 cursor-pointer items-center gap-3">
            <input type="radio" name={`${uid}-category`} value={c.value} checked={answer === c.value} onChange={() => setAnswer(c.value)} className="h-4 w-4 shrink-0 accent-accent" />
            <span className="min-w-0 break-words">{c.label}</span>
          </label>
        ))}
        <Button type="button" variant="secondary" className="self-start pointer-coarse:min-h-11" onClick={() => onAnswer(answer)}>
          {t("flow.category.save")}
        </Button>
      </fieldset>
    </Alert>
  );
}

// =====================================================================================================================
// Review step: the card, Start and Save without starting
// =====================================================================================================================

function ReviewStep({
  ctx,
  draftId,
  saveDraft,
  onSeePreviews,
  saveLine,
  pageAssetId,
}: {
  ctx: FlowContext;
  draftId: string;
  saveDraft: (set: Record<string, unknown>) => Promise<unknown>;
  onSeePreviews?: () => void;
  saveLine: ReactNode;
  pageAssetId: string | null;
}) {
  const lang = ctx.lang;
  const t = usePromoteCopy(lang);
  const review = useReview({ draftId, saveDraft, lang });
  const view = reviewView({ card: review.card, outcome: review.outcome, canStart: ctx.canStart, canWrite: ctx.canWrite, isOwner: ctx.isOwner, lang });
  const [armed, setArmed] = useState(false);
  const [announced, setAnnounced] = useState(false);
  const [guardMessage, setGuardMessage] = useState<string | null>(null);

  // Start stays aria-disabled for 600 ms after each card appears (D5, Eddy 6.5).
  useEffect(() => {
    setArmed(false);
    setAnnounced(false);
    setGuardMessage(null);
    const timer = setTimeout(() => setArmed(true), START_GUARD_MS);
    return () => clearTimeout(timer);
  }, [review.shownAt]);

  const card = review.card;
  const ready = startReady(view, card, review.typed);
  const busy = review.busy !== null;
  const campaignId = card?.campaignId ?? (review.outcome && "campaignId" in review.outcome ? review.outcome.campaignId : draftId);

  const onStart = () => {
    const g = guardTap(startArmed(review.shownAt, Date.now()), announced);
    if (!g.run) {
      if (g.announce) {
        setAnnounced(true);
        setGuardMessage(t("review.check_first"));
      }
      return;
    }
    if (!ready || busy) return;
    setGuardMessage(null);
    void review.start();
  };

  let bar: ReactNode;
  if (view.start.visible) {
    bar = (
      <>
        <BarButton aria-disabled={!armed || !ready || busy || undefined} loading={review.busy === "start"} onClick={onStart} data-testid={PROMOTE_TEST_IDS.primary}>
          {card ? primaryLabel(card, lang) : t("review.loading")}
        </BarButton>
        {view.save.visible && (
          <button type="button" className={textButton} disabled={busy || !card} onClick={() => void review.savePaused()} data-testid={PROMOTE_TEST_IDS.secondary}>
            {card?.secondary || t("card.save_paused")}
          </button>
        )}
      </>
    );
  } else if (view.save.visible) {
    // Start isn't open here (P3, no approver, spending stopped…): saving without starting is the one thing to do.
    bar = (
      <BarButton variant="secondary" disabled={busy || !card} loading={review.busy === "save"} onClick={() => void review.savePaused()} data-testid={PROMOTE_TEST_IDS.secondary}>
        {card?.secondary || t("card.save_paused")}
      </BarButton>
    );
  } else if (view.state === "demo") {
    bar = (
      <Link href={ADS_PATH} className={linkPrimary} data-testid={PROMOTE_TEST_IDS.primary}>
        {t("flow.back_to_ads")}
      </Link>
    );
  } else {
    bar = (
      <Link href={`${ADS_PATH}/${encodeURIComponent(campaignId)}`} className={linkPrimary} data-testid={PROMOTE_TEST_IDS.primary}>
        {t("flow.see_campaign")}
      </Link>
    );
  }

  return (
    <>
      <ReviewCard
        card={card}
        view={view}
        loading={review.loading}
        error={review.error}
        guardMessage={guardMessage}
        typed={review.typed}
        onTypedChange={review.setTyped}
        onFix={(action) => void review.applyFix(action)}
        onCheckAgain={() => void review.review()}
        onPause={() => void review.pause()}
        onSeePreviews={onSeePreviews}
        busy={busy}
        isOwner={ctx.isOwner}
        owner={ctx.ownerName}
        tz={ctx.tz}
        pageName={ctx.pageName}
        pageAssetId={pageAssetId}
        onFacebookOnly={() => void review.applyFix({ kind: "set", set: { "placements.mode": "facebook", "placements.positions": [] } })}
        lang={lang}
      />
      <StickyBar status={saveLine}>{bar}</StickyBar>
    </>
  );
}

// =====================================================================================================================
// The shell
// =====================================================================================================================

export type PromoteShellProps = { ctx: FlowContext };

export function PromoteShell({ ctx }: PromoteShellProps) {
  const lang = ctx.lang;
  const t = usePromoteCopy(lang);
  const router = useRouter();
  const uid = useId();
  const q = ctx.query;
  const desktop = useDesktop();
  const api = usePromoteDraft({ id: q.draft, lang });
  const { draft, dto } = api;
  const draftId = dto?.campaignId ?? null;

  // ----- The flow and its steps
  const [goalPick, setGoalPick] = useState<GoalKey>(() => initialCreateGoal(ctx));
  const kind: FlowKind = draft ? (draft.source.kind !== "new" ? "boost" : "create") : ctx.kind;
  const goal: GoalKey = draft?.goal ?? goalPick;
  const steps = flowSteps(kind, goal);
  // An address with a draft resumes once the draft (its goal, so its steps) has loaded: a lead form ad reloaded on its form
  // step opens there (D28). Until the member moves, the step comes from the address.
  const [stepState, setStepState] = useState<StepId | null>(() => (q.draft ? null : resumeStep(flowSteps(ctx.kind, ctx.kind === "create" ? initialCreateGoal(ctx) : null), q.step, false)));
  const step = clampStep(steps, stepState ?? (draft ? draftStep(kind, draft.goal, q.step) : steps[0]), !!draftId || !!q.draft);
  const index = Math.max(0, steps.indexOf(step));
  const next = steps[index + 1] ?? null;

  // ----- What a screen edits that can't go through draft paths while half-typed
  const [pick, setPick] = useState<PostPick | null>(null);
  const [link, setLink] = useState("");
  const [welcome, setWelcome] = useState<WelcomeValue>({ message: needsWelcome(goalPick) ? ctx.welcomeMessage : "", iceBreakers: [] });
  const [pageAssetId, setPageAssetId] = useState<string | null>(ctx.pageAssetId);
  const [facebookOnly, setFacebookOnly] = useState(false);
  const [adValue, setAdValue] = useState<AdStepValue | null>(null);
  const [formChoice, setFormChoice] = useState<"new" | "saved">("new");
  const [formState, setFormState] = useState<BuilderState | null>(null);
  const [formTouched, setFormTouched] = useState(false);
  const [formErrors, setFormErrors] = useState<Partial<Record<BuilderField, string>>>({});
  // A form built on this page (or about to be); a reloaded lead form draft keeps its saved form until the member makes a new one.
  const [formBuiltHere, setFormBuiltHere] = useState<boolean>(() => !q.draft);
  const [savedFormId, setSavedFormId] = useState<string | null>(() => formsForPage(ctx.forms, ctx.pageAssetId)[0]?.id ?? null);
  const [leaving, setLeaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createQuestion, setCreateQuestion] = useState<{ text: string; categories: string[] } | null>(null);
  const [previewsOpen, setPreviewsOpen] = useState(false);
  const categoryAnswer = useRef<string | null>(null);
  const leadSince = useRef<string | null>(null);
  const kit = useRef<FormKit | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const moved = useRef(false);

  // ----- Seed the screens from a draft once it loads (and again after "Someone else changed this draft": api.conflicts)
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!draft || !dto) return;
    const key = `${dto.campaignId}:${api.conflicts}`;
    if (seededFor.current === key) return;
    seededFor.current = key;
    setLink(draft.text.link ?? "");
    setWelcome({ message: draft.welcome.message, iceBreakers: draft.welcome.iceBreakers });
    if (draft.leadFormId) {
      setFormChoice("saved");
      setSavedFormId(draft.leadFormId);
    }
    setAdValue(null);
  }, [draft, dto, api.conflicts]);

  // ----- The ad step's value from the draft's media (a reload, a fix copy)
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    const d = draftRef.current;
    if (step !== "ad" || adValue || !d) return;
    const ids = draftMediaIds(d);
    if (!ids.length) {
      setAdValue(adStepFromDraft(d, () => null));
      return;
    }
    let live = true;
    void Promise.all(ids.map((id) => jsonRequest("GET", `/api/promote/media/${encodeURIComponent(id)}`))).then((answers) => {
      if (!live) return;
      const views = new Map<string, AdMediaView>();
      answers.forEach((res, i) => {
        const m = (res.body as { media?: AdMediaView } | null)?.media;
        if (res.status === 200 && m) views.set(ids[i], m);
      });
      setAdValue(adStepFromDraft(draftRef.current ?? d, (id) => (id ? (views.get(id) ?? null) : null)));
    });
    return () => {
      live = false;
    };
  }, [step, adValue, draftId]);

  // ----- The form builder's helpers load with the form step
  useEffect(() => {
    if (step !== "form" || formState) return;
    let live = true;
    void import("./form-builder-helpers").then((m) => {
      if (!live) return;
      kit.current = m;
      setFormState(m.newBuilderState({ privacyUrl: ctx.privacyUrl, whatsappNumber: ctx.whatsappNumber, name: m.defaultFormName(ctx.today) }));
    });
    return () => {
      live = false;
    };
  }, [step, formState, ctx.privacyUrl, ctx.whatsappNumber, ctx.today]);

  // ----- The address keeps the draft and the step (D28). Native replaceState with null state: the App Router syncs it without
  // a server round trip, so a reload or a shared link resumes the same draft and screen.
  // While a draft from the address is still loading, the address stays as it is (its draft and step are what resume it).
  useEffect(() => {
    if (typeof window === "undefined" || (q.draft && !draftId)) return;
    const href = draftId ? flowHref(kind, { draft: draftId, step }) : flowHref(kind, { goal: kind === "create" ? goal : q.goal, source: q.source, id: q.id, days: q.days, step });
    if (`${window.location.pathname}${window.location.search}` !== href) window.history.replaceState(null, "", href);
  }, [kind, draftId, step, goal, q.draft, q.goal, q.source, q.id, q.days]);

  // ----- Focus moves to the step's h2 on every step change (7.6)
  useEffect(() => {
    if (!moved.current) return;
    headingRef.current?.focus();
  }, [step]);

  const go = useCallback((to: StepId | null) => {
    if (!to) return;
    moved.current = true;
    setStepState(to);
    setProblem(null);
    setShowErrors(false);
    setCreateError(null);
    if (typeof window !== "undefined") window.scrollTo?.({ top: 0 });
  }, []);

  // ----- Saving, creating and an edited copy
  const flushOk = async (): Promise<boolean> => {
    const before = api.refusalCount();
    const state = await api.flush();
    return savedEnough(state, api.refusalCount() !== before, api.refusalNow());
  };

  const create = async (body: Record<string, unknown>): Promise<boolean> => {
    setCreateError(null);
    const answer = categoryAnswer.current;
    const r: CreateResult = await api.create(answer ? { ...body, categoryAnswer: answer } : body);
    if (r.ok) {
      categoryAnswer.current = null;
      setCreateQuestion(null);
      return true;
    }
    if (isCategoryQuestion(r.body)) {
      setCreateQuestion({ text: r.message, categories: Array.isArray(r.body.categories) ? r.body.categories : [] });
      return false;
    }
    setCreateError(r.message);
    return false;
  };

  /** A new draft with everything else the same, then the old one discarded (restorable for 15 minutes). */
  const recreate = async (body: Record<string, unknown>): Promise<boolean> => {
    const old = draftId;
    await api.flush();
    const ok = await create(body);
    if (ok && old) void api.discard(old);
    return ok;
  };

  const boostSource = (draft && draft.source.kind !== "new" ? draft.source.kind : pick ? postSourceOf(pick.item).kind : "ig_media") as Exclude<SourceKind, "new">;
  const boostChips = kind === "boost" ? boostGoalChips(ctx.offered, boostSource, lang) : [];
  const goalChip = boostChips.find((c) => c.key === goal);

  // "Use a saved form" lists the forms of the Page the ad runs from (a saved draft's form tells which Page that is).
  const formPage = (draft?.leadFormId ? ctx.forms.find((f) => f.id === draft.leadFormId)?.pageAssetId : null) ?? pageAssetId;
  const pageForms = formsForPage(ctx.forms, formPage);
  const savedFormOk = !!savedFormId && (pageForms.some((f) => f.id === savedFormId) || savedFormId === draft?.leadFormId);
  // A lead form draft reloaded here keeps its saved form: the page can't read its questions back (formKept).
  const keptForm = !!draft && formChoice === "new" && formKept({ goal: draft.goal, leadFormId: draft.leadFormId, builtHere: formBuiltHere || leadSince.current === draftId });

  const currentProblem = (): string | null =>
    stepProblem(
      {
        step,
        pick: pick?.item ?? (draft && draft.source.kind !== "new" ? { eligibility: "unknown", reasons: [] } : null),
        goal,
        // A boost goal the post's app can't take (a Facebook post with an Instagram-only goal) stops here, not at the review.
        goalUsable: goalChip ? goalChip.usable : kind !== "boost",
        goalChoices: kind === "boost" ? boostChips.map((c) => c.key) : undefined,
        link,
        welcome,
        form: { choice: formChoice, savedId: savedFormOk ? savedFormId : null, problems: 0 },
        ad: adValue,
        audience: draft?.audience ?? null,
      },
      lang,
    );

  const leave = async (): Promise<boolean> => {
    switch (step) {
      case "post": {
        if (!pick) return !!draftId && (await flushOk());
        const src = postSourceOf(pick.item);
        if (!draftId) {
          const plan = boostPlan(planFactsOf(ctx), { source: src.kind, hasLink: src.hasLink, asked: q.goal, days: q.days }, new Date());
          return create(boostCreateBody(pick.item, plan, pick.identity, pick.alsoOtherApp));
        }
        // Another post: a new draft with everything else the same, and a goal this post can take (boostSwitchBody).
        if (draft && src.ref !== draft.source.ref) return recreate(boostSwitchBody(pick.item, draft, pick.identity, pick.alsoOtherApp, planFactsOf(ctx), new Date()));
        if (draft && pick.alsoOtherApp !== draft.alsoOtherApp) api.stage({ alsoOtherApp: pick.alsoOtherApp });
        return flushOk();
      }
      case "goal": {
        const set: Record<string, unknown> = { ...(needsLink(goal) ? linkSet(link) : {}), ...(needsWelcome(goal) ? welcomeSet(welcome) : {}), ...(facebookOnly ? { "placements.mode": "facebook", "placements.positions": [] } : {}) };
        if (!draftId) {
          // A lead form ad is made with its form (next screen); every other new ad is made now.
          if (goal === "lead_form") return true;
          return create(createDraftBody({ goal, days: planDays(q.days), pageAssetId, igAssetId: ctx.igAssetId, set }));
        }
        api.stage(set);
        return flushOk();
      }
      case "form": {
        if (formChoice === "saved") {
          if (!draftId) return create(createDraftBody({ goal: "lead_form", days: planDays(q.days), pageAssetId, igAssetId: ctx.igAssetId, set: { leadFormId: savedFormId, ...(facebookOnly ? { "placements.mode": "facebook" } : {}) } }));
          api.stage({ leadFormId: savedFormId });
          return flushOk();
        }
        // The saved form stays as it is (Continue keeps it).
        if (keptForm) return flushOk();
        const k = kit.current ?? (await import("./form-builder-helpers"));
        kit.current = k;
        if (!formState) return false;
        const built = k.buildFormSpec(formState, { whatsappNumber: ctx.whatsappNumber, businessName: ctx.businessName, pageName: ctx.pageName }, { today: ctx.today });
        if (!built.spec) {
          setFormErrors(k.problemsByField(built.problems));
          setProblem(t("flow.fix_fields"));
          return false;
        }
        setFormErrors({});
        if (!draftId) return create(createDraftBody({ goal: "lead_form", days: planDays(q.days), pageAssetId, igAssetId: ctx.igAssetId, set: facebookOnly ? { "placements.mode": "facebook" } : {}, form: built.spec }));
        // The stored spec can't be read back: a changed form, a switch from a saved one, or a draft that became a lead form ad
        // here makes an edited copy of the draft with this spec. A reloaded draft whose form wasn't touched keeps its own.
        if (draft && (formTouched || draft.leadFormId || leadSince.current === draftId)) {
          const ok = await recreate(createDraftBody({ goal: "lead_form", days: draft.run.runDays, pageAssetId, igAssetId: ctx.igAssetId, set: { ...draftSetOf(draft), leadFormId: null }, form: built.spec }));
          if (ok) {
            setFormTouched(false);
            // The copy's form is the one on this builder, so Back shows it here (not "Your form is saved").
            setFormBuiltHere(true);
          }
          return ok;
        }
        return flushOk();
      }
      case "ad":
      case "audience":
        return flushOk();
      case "review":
        return true;
    }
  };

  const onContinue = async () => {
    if (busy || !ctx.canWrite) return;
    setShowErrors(true);
    const p = currentProblem();
    if (p) {
      setProblem(p);
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      if (await leave()) go(next);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Save and exit, and Back on the first screen: the draft is saved first, and the page leaves only once it is. A save that
   * didn't go through (the network, a refusal, the special-category question) asks "Leave without saving?": Stay keeps the
   * screen with the footer's message and [Save now], or the question to answer.
   */
  const leaveFlow = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      if (exitAction(!!draftId, !draftId || (await flushOk())) === "ask") {
        const ok = await confirm({ title: t("flow.leave_question"), body: t("flow.leave_body"), confirmLabel: t("flow.leave_unsaved"), cancelLabel: t("flow.stay"), tone: "danger" });
        if (!ok) return;
      }
      router.push(ADS_PATH);
    } finally {
      setLeaving(false);
    }
  };

  const goBack = () => {
    if (index === 0) {
      void leaveFlow();
      return;
    }
    if (draftId) void api.flush();
    go(steps[index - 1]);
  };

  // ----- Edits from the screens
  const changeGoal = (g: GoalKey) => {
    setGoalPick(g);
    if (draftId && g === "lead_form" && draft?.goal !== "lead_form") leadSince.current = draftId;
    if (needsWelcome(g) && !welcome.message.trim()) setWelcome((w) => ({ ...w, message: ctx.welcomeMessage }));
    if (draft) {
      const set = goalSet(g, draft, lang);
      if (typeof set["welcome.message"] === "string") setWelcome((w) => ({ ...w, message: set["welcome.message"] as string }));
      api.stage(set);
    }
  };
  const changeLink = (v: string) => {
    setLink(v);
    if (draft) api.stage(linkSet(v));
  };
  const changeWelcome = (w: WelcomeValue) => {
    setWelcome(w);
    if (draft) api.stage(welcomeSet(w));
  };
  const runFacebookOnly = () => {
    setFacebookOnly(true);
    if (draft) api.stage({ "placements.mode": "facebook", "placements.positions": [] });
  };
  const changeAd = (v: AdStepValue) => {
    setAdValue(v);
    if (draft) api.stage(adStepSet(v, { link: draft.text.link, compareMode: draft.compare.mode }));
  };

  // ----- What the page shows
  const saveQuestion = isCategoryQuestion(api.refusal) ? api.refusal : null;
  const question = createQuestion ?? (saveQuestion ? { text: api.message ?? saveQuestion.error ?? promoteText("category.question", {}, lang), categories: saveQuestion.categories ?? [] } : null);
  const onAnswer = (answer: string) => {
    if (createQuestion) {
      categoryAnswer.current = answer;
      setCreateQuestion(null);
      void onContinue();
      return;
    }
    void api.resend({ categoryAnswer: answer });
  };

  const saveText = draftId ? api.stateText : null;
  const saveMessage = saveQuestion ? null : api.message;
  const saveLine = (
    <SaveLine
      text={saveText}
      message={saveMessage}
      canRetry={!!draftId && (api.state === "unsaved" || api.state === "error" || api.state === "conflict") && !saveQuestion}
      onRetry={() => void api.retry()}
      retryLabel={t("flow.save_now")}
    />
  );

  const readinessQuery = {
    placements: (draft ? (draft.placements.mode === "custom" ? "auto" : draft.placements.mode) : facebookOnly ? "facebook" : "auto") as "auto" | "instagram" | "facebook",
    nearShop: draft?.audience.mode === "near_shop",
    pageAssetId: pick?.identity.page?.assetId ?? pageAssetId,
    igAssetId: pick?.identity.instagram && !pick.identity.instagram.pageBacked ? pick.identity.instagram.assetId : ctx.igAssetId,
  };

  const title = kind === "boost" ? t("flow.boost_title") : t("flow.create_title");
  const headingId = `${uid}-step`;
  const blockers = blockingChips(ctx.chips);
  const notices = ctx.chips.filter((c) => !blockers.includes(c));

  // ----- The live preview (desktop column, and the phone's sheet from the review card)
  const feed = adValue ? (adStepInUse(adValue).versions[0]?.feed ?? null) : null;
  const previewMedia = kind === "boost" ? (pick?.item.thumbnailUrl ? { url: pick.item.thumbnailUrl, kind: "image" as const } : null) : feed ? { url: mediaFileUrl(feed), kind: feed.kind, width: feed.width, height: feed.height } : null;
  const previewReady = !!draft && (kind === "boost" ? !!draft.source.ref : !!feed || draftMediaIds(draft).length > 0);
  const ctas = draft ? ctaOptions(draft.goal, lang) : [];
  const preview =
    draft && previewReady ? (
      <PlacementPreview
        placements={previewPositions(draft)}
        reviewKey={previewKey(draft)}
        source={draftId ? { draftId } : null}
        mode={ctx.previews}
        carousel={draft.format === "carousel"}
        frame={{
          profile: { name: ctx.profileName ?? ctx.pageName ?? "" },
          text: { primary: kind === "boost" ? (pick?.item.caption?.text ?? dto?.caption?.text ?? "") : draft.text.primary, headline: kind === "boost" ? null : draft.text.headline || null },
          ctaLabel: (ctas.find((o) => o.type === draft.ctaType) ?? ctas[0])?.label ?? null,
          media: previewMedia,
        }}
        lang={lang}
      />
    ) : (
      <p className="text-sm text-muted">{t("flow.preview_note")}</p>
    );

  // ----- Pages that can't be edited here
  if (!ctx.canWrite) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 py-4" data-testid={PROMOTE_TEST_IDS.shell}>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <Alert tone="info">{t("flow.writers_only")}</Alert>
        <Link href={ADS_PATH} className={cn("inline-flex min-h-11 items-center justify-center self-start rounded-full px-5 text-sm font-semibold", buttonVariants.secondary)}>
          {t("flow.back_to_ads")}
        </Link>
      </div>
    );
  }
  if (q.draft && !draft) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 py-4" data-testid={PROMOTE_TEST_IDS.shell}>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {api.loadError ? (
          <Alert
            tone="bad"
            action={
              <Button type="button" variant="secondary" className="pointer-coarse:min-h-11" onClick={() => q.draft && void api.load(q.draft)}>
                {t("media.picker.retry")}
              </Button>
            }
          >
            {api.loadError}
          </Alert>
        ) : (
          <StepLoading />
        )}
      </div>
    );
  }
  if (dto && (!dto.editable || dto.discardedAt)) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 py-4" data-testid={PROMOTE_TEST_IDS.shell}>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <Alert tone="info">{dto.discardedAt ? t("flow.discarded") : t("flow.not_editable")}</Alert>
        <Link
          href={dto.discardedAt ? ADS_PATH : `${ADS_PATH}/${encodeURIComponent(dto.campaignId)}`}
          className={cn("inline-flex min-h-11 items-center justify-center self-start rounded-full px-5 text-sm font-semibold", buttonVariants.secondary)}
        >
          {dto.discardedAt ? t("flow.back_to_ads") : t("flow.see_campaign")}
        </Link>
      </div>
    );
  }

  // ----- One step
  const heading = (
    <h2 ref={headingRef} id={headingId} tabIndex={-1} className="rounded-control text-lg font-semibold tracking-tight text-balance outline-none focus-visible:ring-2 focus-visible:ring-accent">
      {t(STEP_TITLE_KEYS[step])}
    </h2>
  );
  const formHeadingOwn = step === "form" && formChoice === "new" && !!formState && !keptForm;

  let body: ReactNode = null;
  switch (step) {
    case "post":
      body = (
        <PostPicker
          value={pick}
          onChange={setPick}
          initial={draft && draft.source.kind !== "new" ? { source: draft.source.kind === "ig_media" ? "instagram" : "facebook", id: draft.source.ref } : { source: q.source === "facebook" || q.source === "instagram" ? q.source : null, id: q.id }}
          goal={q.goal}
          tz={ctx.tz}
          lang={lang}
        />
      );
      break;
    case "goal":
      body = (
        <div className="flex min-w-0 flex-col gap-5">
          {kind === "create" && !draftId && ctx.pages.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${uid}-page`} className="text-sm font-medium">
                {t("picker.page")}
              </label>
              <Select
                id={`${uid}-page`}
                value={pageAssetId ?? ""}
                onChange={(e) => {
                  // The saved forms follow the Page: Meta refuses a form of another Page.
                  const next = e.target.value || null;
                  const first = formsForPage(ctx.forms, next)[0]?.id ?? null;
                  setPageAssetId(next);
                  setSavedFormId(first);
                  if (!first) setFormChoice("new");
                }}
              >
                <option value="">{t("picker.page_hint")}</option>
                {ctx.pages.map((p) => (
                  <option key={p.assetId} value={p.assetId}>
                    {p.name ?? p.assetId}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <GoalStep
            variant={kind === "boost" ? "chips" : "cards"}
            offered={ctx.offered}
            value={goal}
            onChange={changeGoal}
            source={kind === "boost" ? boostSource : undefined}
            link={link}
            onLinkChange={changeLink}
            welcome={welcome}
            onWelcomeChange={changeWelcome}
            showErrors={showErrors}
            readinessQuery={readinessQuery}
            onFacebookOnly={runFacebookOnly}
            pageName={ctx.pageName}
            lang={lang}
          />
        </div>
      );
      break;
    case "form": {
      const choice = (
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className="mb-1 text-sm font-semibold">{t("flow.form.which")}</legend>
          {(["new", "saved"] as const)
            .filter((c) => c === "new" || pageForms.length > 0 || formChoice === "saved")
            .map((c) => (
              <label key={c} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                <input type="radio" name={`${uid}-form`} value={c} checked={formChoice === c} onChange={() => setFormChoice(c)} className="h-4 w-4 shrink-0 accent-accent" />
                {t(c === "new" ? "flow.form.new" : "flow.form.saved")}
              </label>
            ))}
        </fieldset>
      );
      if (formChoice === "saved") {
        body = (
          <div className="flex min-w-0 flex-col gap-4">
            {choice}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${uid}-saved-form`} className="text-sm font-medium">
                {t("flow.form.saved_label")}
              </label>
              <Select id={`${uid}-saved-form`} value={savedFormId ?? ""} onChange={(e) => setSavedFormId(e.target.value || null)}>
                <option value="">{t("flow.form.choose")}</option>
                {pageForms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        );
      } else if (keptForm) {
        // The saved form's questions can't be shown here: say it is kept, and offer a new form to replace it.
        body = (
          <div className="flex min-w-0 flex-col gap-4">
            {choice}
            <Alert tone="info">
              <p className="break-words">{t("flow.form.kept")}</p>
            </Alert>
            <Button
              type="button"
              variant="secondary"
              className="self-start pointer-coarse:min-h-11"
              onClick={() => {
                setFormBuiltHere(true);
                // Opening the builder means replacing the saved form: Continue makes an edited copy with the new one.
                setFormTouched(true);
              }}
            >
              {t("flow.form.replace")}
            </Button>
          </div>
        );
      } else if (formState) {
        body = (
          <FormStep
            state={formState}
            onChange={(s) => {
              setFormState(s);
              setFormTouched(true);
            }}
            ctx={{ whatsappNumber: ctx.whatsappNumber, businessName: ctx.businessName, pageName: ctx.pageName }}
            errors={formErrors}
            focusOnMount={moved.current}
          >
            {choice}
          </FormStep>
        );
      } else body = <StepLoading />;
      break;
    }
    case "ad":
      body =
        draft && adValue ? (
          <AdStep
            value={adValue}
            onChange={changeAd}
            goal={goal}
            placements={previewPositions(draft)}
            hasInstagramIdentity={ctx.hasInstagram}
            videoEnabled={ctx.video}
            onUsePost={() => router.push(flowHref("boost", { goal, days: draft.run.runDays }))}
            linkMode={goal === "lead_form" ? "lead_form" : needsLink(goal) ? "link" : "none"}
            lang={lang}
          />
        ) : (
          <StepLoading />
        );
      break;
    case "audience":
      body = draft ? (
        <div className="flex min-w-0 flex-col gap-4">
          {notices.map((c) => (
            <Alert key={c.key} tone="info">
              {c.text}
            </Alert>
          ))}
          <AudienceBudgetStep
            draft={draft}
            onChange={api.stage}
            ctx={ctx}
            kind={kind === "boost" ? "boost" : "ads"}
            format={kind === "boost" ? "existing_post" : draft.format}
            mediaKind={kind === "boost" ? (pick?.item.kind === "reel" || /video/i.test(pick?.item.mediaType ?? "") ? "video" : "image") : draft.format === "single_video" ? "video" : "image"}
            lang={lang}
          />
        </div>
      ) : (
        <StepLoading />
      );
      break;
    case "review":
      body = null;
      break;
  }

  const continueBar = (
    <StickyBar status={saveLine}>
      <BarButton disabled={busy} loading={busy} onClick={() => void onContinue()} data-testid={PROMOTE_TEST_IDS.primary}>
        {t("flow.continue")}
      </BarButton>
    </StickyBar>
  );

  return (
    <div className="flex min-w-0 flex-col" data-testid={PROMOTE_TEST_IDS.shell} data-kind={kind}>
      <header className="flex min-w-0 items-center gap-2 pb-3">
        <button type="button" onClick={goBack} className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full px-2 text-sm font-semibold hover:bg-surface-2" data-testid={PROMOTE_TEST_IDS.back}>
          <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true" focusable="false">
            <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t("flow.back")}
        </button>
        <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <ol aria-label={t("flow.steps")} className="flex items-center gap-1.5">
            {steps.map((s, i) => (
              <li key={s} aria-current={i === index ? "step" : undefined} className={cn("h-2 rounded-full transition-all duration-(--dur-fast) motion-reduce:transition-none", i === index ? "w-5 bg-accent" : i < index ? "w-2 bg-accent" : "w-2 bg-border-strong")}>
                <span className="sr-only">{t(STEP_TITLE_KEYS[s])}</span>
              </li>
            ))}
          </ol>
          <p aria-live="polite" className="text-xs text-muted" data-testid={PROMOTE_TEST_IDS.stepCount}>
            {stepCountLabel(index, steps.length, lang)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void leaveFlow()}
          disabled={leaving}
          aria-busy={leaving || undefined}
          className="inline-flex min-h-11 shrink-0 items-center rounded-full px-2 text-sm font-semibold text-accent-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid={PROMOTE_TEST_IDS.saveExit}
        >
          {t("flow.save_exit")}
        </button>
      </header>
      <h1 className="sr-only">{title}</h1>

      <div className="grid min-w-0 grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section
          aria-labelledby={formHeadingOwn ? undefined : headingId}
          className="flex min-w-0 flex-col gap-5"
          data-testid={PROMOTE_TEST_IDS.step(step)}
          onBlur={() => {
            if (draftId) void api.flush();
          }}
        >
          {blockers.length > 0 && (
            <Alert tone="warn">
              <ul className="flex flex-col gap-1">
                {blockers.map((c) => (
                  <li key={c.key} className="break-words">
                    {c.href ? (
                      <Link href={c.href} className="font-semibold underline underline-offset-2">
                        {c.text}
                      </Link>
                    ) : (
                      c.text
                    )}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
          {!formHeadingOwn && heading}
          {question && <CategoryQuestion key={question.text} text={question.text} categories={question.categories} onAnswer={onAnswer} lang={lang} />}
          {step === "review" && draftId ? (
            <ReviewStep
              ctx={ctx}
              draftId={draftId}
              saveDraft={(set) => api.save(set)}
              onSeePreviews={desktop ? undefined : () => setPreviewsOpen(true)}
              saveLine={saveLine}
              pageAssetId={readinessQuery.pageAssetId ?? null}
            />
          ) : (
            <>
              {body}
              {(problem || createError) && (
                <Alert tone={createError ? "bad" : "warn"}>
                  <p className="break-words">{createError ?? problem}</p>
                </Alert>
              )}
              {continueBar}
            </>
          )}
        </section>

        {desktop && (
          <aside aria-label={t("flow.preview")} className="sticky top-4 flex min-w-0 flex-col gap-3 self-start" data-testid={PROMOTE_TEST_IDS.preview}>
            <h2 className="text-sm font-semibold">{t("flow.preview")}</h2>
            {preview}
          </aside>
        )}
      </div>

      {previewsOpen && (
        <Dialog title={t("flow.preview")} onClose={() => setPreviewsOpen(false)} closeLabel={t("flow.close")} closeClassName="min-h-11 min-w-11">
          {preview}
        </Dialog>
      )}
    </div>
  );
}

export default PromoteShell;
