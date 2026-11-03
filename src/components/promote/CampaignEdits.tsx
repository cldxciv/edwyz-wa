"use client";

/**
 * CampaignEdits (docs/IG-PAGE-ADS-SPEC.md 3.8, 3.9 edits table, 7.3, D25, D29; PRM-15b): the edits of a campaign on Meta.
 *
 * - [Pause]: instant, POST /api/ads/campaigns/[id]/pause (a lowering, never refused).
 * - [End earlier] and [Spend less per day]: the person picks the new value and it applies at once (lowerings through
 *   POST …/end and …/budget), then [Undo] is offered. Undoing a lowering is a raise, so Undo opens the confirm sheet.
 * - [Run longer] and [Spend more per day]: a confirm sheet with the CostLine first (raises: reserveAds extend_end and
 *   raise_budget on the server). A refusal shows the server's words: the room left, or Meta's budget-change limit
 *   (spend.meta_rate).
 * - [Resume]: the existing POST …/resume through activateCampaign, after the confirm sheet with the amount it confirms: the
 *   daily budgets plus any lifetime budget (promotions only: old-wizard campaigns keep their typed activation, D5).
 * - [Make a copy]: a local draft through POST …/duplicate, never Meta's own copy endpoint (D25).
 * While a fair test of versions runs (3.8), a budget edit sends the daily total for all versions without an ad set, so the
 * server's fair-split service keeps every version at the same share; the sheet says how it splits, and the confirm, the cost
 * line and the message use the sum of the shares, never the typed total.
 * While the ad account is restricted, or all spending is stopped, every raise is disabled with the reason; pausing and every
 * lowering still work. What a Phase 0 stop paused, only the owner or an approver resumes (2.3.13): for anyone else, and while
 * the page hasn't checked yet, [Resume] is disabled with the reason. It is also disabled while starting is closed (canStart).
 */
import { useId, useState } from "react";
import { Alert, Button, Dialog, FormField, Input, Select, apiFetch, cn, toast } from "@/components/ui";
import { endProblem, toDateTimeLocal } from "@/components/ads/campaign-edit";
import { formatMinor, minorToText, toMinor } from "@/components/ads/helpers";
import type { CostHeadroom } from "@/lib/promote/cost";
import { CostLine } from "./CostLine";
import {
  EDITS_TEXT,
  RESUME_TEXT,
  appliedBudget,
  availableEdits,
  budgetEdit,
  daysLeft,
  editLabel,
  endEdit,
  fairSplitLine,
  resumeAmounts,
  runningFairTest,
  undoKindOf,
  type EditKind,
} from "./results-helpers";

export const CAMPAIGN_EDITS_TEST_ID = "campaign-edits";

export type EditAdSet = { id: string; name: string; metaAdSetId: string | null; dailyBudgetMinor: number | null; lifetimeBudgetMinor?: number | null; variantKey?: string | null };

export type EditCampaign = {
  id: string;
  name: string;
  status: string;
  surface?: string | null;
  template?: string | null;
  currency: string;
  metaCampaignId: string | null;
  totalDailyBudgetMinor: number;
  confirmTotalMinor?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  adSets: EditAdSet[];
  adTest?: { mode?: string | null; status?: string | null; winnerAdSetId?: string | null } | null;
};

export type CampaignEditsProps = {
  campaign: EditCampaign;
  /** The ad account's zone (D30), for the cost line. */
  timeZone?: string | null;
  /** What is left of the ads limits, for the cost line. */
  headroom?: CostHeadroom | null;
  /** The ad account is restricted (review-status account): raises are disabled. */
  blocksStart?: boolean;
  /** Offer [Resume] (default: promotions only). */
  showResume?: boolean;
  /**
   * False when a stop paused it and this member is neither the owner nor an approver (Phase 0 2.3.13), or while the page hasn't
   * checked yet (pauseCauseOf): [Resume] is disabled with resumeNote.
   */
  canResume?: boolean;
  /** Why [Resume] is disabled when canResume is false. */
  resumeNote?: string | null;
  /** All spending is stopped: [Resume], every raise and the Undo of a lowering are disabled with this reason. */
  raisesBlocked?: string | null;
  /** False while starting promotions is closed (promoteAccess canStart): the server refuses a resume. */
  canStart?: boolean;
  /** Reload the campaign after a change. */
  onChanged?: () => void;
  /** A copy was made: its campaign id (the page opens it). */
  onCopied?: (campaignId: string) => void;
  className?: string;
};

type SheetKind = "end_earlier" | "run_longer" | "spend_less" | "spend_more" | "resume";
type Sheet = { kind: SheetKind; prefill?: string; adSetId?: string };
type Undo = { kind: "spend_less" | "end_earlier"; text: string; prefill: string; adSetId?: string };

const SHEET_TEXT = {
  budgetLabel: (currency: string) => `New daily budget (${currency})`,
  totalLabel: (currency: string) => `New daily total for all versions (${currency})`,
  adSet: "Ad set",
  budgetHint: "For example 500.",
  amountProblem: "Enter an amount above zero, like 500 or 499.50.",
  endLabel: "New end",
  endHint: "It stops showing at this time.",
  now: (amount: string) => `Now ${amount} a day.`,
  nowEnd: (date: string) => `Now it ends on ${date}.`,
  noEnd: "Now it has no end date.",
  raiseNote: "This lets it spend more. We check it against your spending limits first. If it doesn't fit, nothing changes and we say how much room is left.",
  noCostLine: "Meta can spend up to 75% more than a daily budget on a busy day.",
  cutNote: "This applies on Meta right away. You can undo it after.",
  spendLess: (amount: string) => `Spend ${amount} a day`,
  spendMore: (amount: string) => `Confirm: ${amount} a day`,
  endEarlier: (date: string) => `End on ${date}`,
  runLonger: (date: string) => `Confirm: run until ${date}`,
  same: "That's the same as now. Choose a different value.",
  cancel: "Cancel",
  undo: "Undo",
  refused: "Nothing changed",
} as const;

const fmtDate = (d: Date) => d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export function CampaignEdits({ campaign: c, timeZone, headroom, blocksStart, showResume, canResume, resumeNote, raisesBlocked, canStart, onChanged, onCopied, className }: CampaignEditsProps) {
  const headingId = useId();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [said, setSaid] = useState("");
  const buttons = availableEdits(c, { blocksStart, showResume, canResume, resumeNote, raisesBlocked, canStart });
  // Why a button is disabled, each reason once, in words under the buttons (and tied to them by aria-describedby).
  const reasons = [...new Set(buttons.map((b) => b.reason).filter((r): r is string => !!r))];
  if (buttons.length === 0) return null;

  async function pause() {
    setBusy("pause");
    try {
      await apiFetch(`/api/ads/campaigns/${encodeURIComponent(c.id)}/pause`, { method: "POST" });
      setUndo(null);
      setSaid(EDITS_TEXT.paused);
      toast.success(EDITS_TEXT.paused);
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    setBusy("copy");
    try {
      const res = await apiFetch<{ campaignId: string }>(`/api/ads/campaigns/${encodeURIComponent(c.id)}/duplicate`, { method: "POST", body: {} });
      setSaid(EDITS_TEXT.copied);
      toast.success(EDITS_TEXT.copied);
      onCopied?.(res.campaignId);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function open(kind: EditKind) {
    if (kind === "pause") return void pause();
    if (kind === "copy") return void copy();
    setSheet({ kind });
  }

  return (
    <section aria-labelledby={headingId} className={cn("min-w-0 space-y-3", className)} data-testid={CAMPAIGN_EDITS_TEST_ID}>
      <h2 id={headingId} className="text-base font-semibold tracking-tight">
        {EDITS_TEXT.heading}
      </h2>
      <div className="flex flex-wrap gap-2">
        {buttons.map((b) => (
          <Button
            key={b.kind}
            variant={b.kind === "resume" ? "primary" : "secondary"}
            loading={busy === b.kind}
            disabled={b.disabled || busy !== null}
            aria-describedby={b.reason ? `${headingId}-reason-${reasons.indexOf(b.reason)}` : undefined}
            onClick={() => open(b.kind)}
            data-testid={`edit-${b.kind}`}
          >
            {b.label}
          </Button>
        ))}
      </div>
      {reasons.map((r, i) => (
        <p key={r} id={`${headingId}-reason-${i}`} className="text-xs text-muted" data-testid="edits-reason">
          {r}
        </p>
      ))}
      <div aria-live="polite" className="empty:hidden" data-testid="edits-status">
        {undo ? (
          <p className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 break-words">{undo.text}</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null || blocksStart || !!raisesBlocked}
              onClick={() => setSheet({ kind: undoKindOf(undo.kind), prefill: undo.prefill, adSetId: undo.adSetId })}
              data-testid="edit-undo"
            >
              {SHEET_TEXT.undo}
            </Button>
          </p>
        ) : (
          said && <span className="sr-only">{said}</span>
        )}
      </div>
      {sheet && (
        <EditSheet
          key={`${sheet.kind}-${sheet.prefill ?? ""}`}
          campaign={c}
          sheet={sheet}
          timeZone={timeZone}
          headroom={headroom}
          onCancel={() => setSheet(null)}
          onDone={(result) => {
            setSheet(null);
            setUndo(result.undo);
            setSaid(result.message);
            toast.success(result.message);
            onChanged?.();
          }}
        />
      )}
    </section>
  );
}

type Done = { message: string; undo: Undo | null };

/** The ad sets a budget edit can name: launched, with a daily budget. */
const budgetSets = (c: EditCampaign) => c.adSets.filter((s) => s.metaAdSetId && (s.dailyBudgetMinor !== null || s.lifetimeBudgetMinor === null || s.lifetimeBudgetMinor === undefined));

function EditSheet({ campaign: c, sheet, timeZone, headroom, onCancel, onDone }: { campaign: EditCampaign; sheet: Sheet; timeZone?: string | null; headroom?: CostHeadroom | null; onCancel: () => void; onDone: (r: Done) => void }) {
  const [now] = useState(() => new Date());
  const isBudget = sheet.kind === "spend_less" || sheet.kind === "spend_more";
  const isEnd = sheet.kind === "end_earlier" || sheet.kind === "run_longer";
  const fair = runningFairTest(c.adTest, c.adSets);
  const sets = budgetSets(c);
  const [setId, setSetId] = useState(sheet.adSetId ?? sets[0]?.id ?? "");
  const set = sets.find((s) => s.id === setId) ?? sets[0];
  const versions = fair ? c.adSets.filter((s) => s.metaAdSetId && s.variantKey).length : 1;
  const currentBudget = fair ? c.totalDailyBudgetMinor : (set?.dailyBudgetMinor ?? c.totalDailyBudgetMinor);
  const currentEnd = c.endsAt ? new Date(c.endsAt) : null;
  const [text, setText] = useState(sheet.prefill ?? (isBudget ? minorToText(currentBudget, c.currency) : isEnd && currentEnd ? toDateTimeLocal(currentEnd) : ""));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const tz = timeZone || "Asia/Kolkata";

  // Budget: the typed amount (one ad set's, or the total for every version of a fair test).
  const typed = isBudget ? toMinor(text, c.currency) : null;
  // What the server applies: the typed amount, or in a fair test the sum of the equal shares (3.8: ₹301 on two is ₹300).
  const applied = typed === null ? null : appliedBudget(typed, { fair, versions, currency: c.currency });
  const shareProblem = applied?.problem ?? null;
  const minor = applied?.minor ?? null;
  const budget = minor === null || shareProblem ? null : budgetEdit(currentBudget, minor);
  // The daily total the campaign would have, for the cost line.
  const newTotal = minor === null ? c.totalDailyBudgetMinor : fair ? minor : c.totalDailyBudgetMinor - currentBudget + minor;
  // End: the new end.
  const problem = isEnd ? endProblem(text, now, c.startsAt ? new Date(c.startsAt) : null) : null;
  const nextEnd = isEnd && !problem ? new Date(text) : null;
  const end = nextEnd ? endEdit(currentEnd, nextEnd) : null;
  // [Resume] confirms the daily budgets plus any lifetime budget, the exact amount the server checks.
  const amounts = resumeAmounts(c);

  const kind: SheetKind = sheet.kind === "resume" ? "resume" : isBudget ? (budget?.kind ?? sheet.kind) : (end?.kind ?? sheet.kind);
  const raise = kind === "spend_more" || kind === "run_longer" || kind === "resume";
  const ready = sheet.kind === "resume" || (isBudget ? budget !== null : end !== null);
  const runDays = daysLeft(kind === "run_longer" && nextEnd ? nextEnd : c.endsAt, now);
  const costDaily = BigInt(Math.max(0, kind === "spend_more" ? newTotal : c.totalDailyBudgetMinor));
  // A lifetime budget isn't a daily amount, so the cost line can't show it: it is said in words next to it.
  const lifetimeText = (kind === "resume" || kind === "run_longer") && amounts.lifetimeMinor > 0 ? formatMinor(amounts.lifetimeMinor, c.currency) : null;
  const amountText = formatMinor(isBudget && minor !== null ? minor : c.totalDailyBudgetMinor, c.currency);

  let primary: string;
  if (kind === "resume") primary = RESUME_TEXT.label(amounts, c.currency);
  else if (kind === "spend_less") primary = SHEET_TEXT.spendLess(amountText);
  else if (kind === "spend_more") primary = SHEET_TEXT.spendMore(amountText);
  else if (kind === "end_earlier") primary = SHEET_TEXT.endEarlier(nextEnd ? fmtDate(nextEnd) : "");
  else primary = SHEET_TEXT.runLonger(nextEnd ? fmtDate(nextEnd) : "");

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setRefusal(null);
    const path = `/api/ads/campaigns/${encodeURIComponent(c.id)}`;
    try {
      if (kind === "resume") {
        await apiFetch(`${path}/resume`, { method: "POST", body: { confirm: true, confirmedTotalMinor: amounts.confirmMinor } });
        onDone({ message: EDITS_TEXT.resumed, undo: null });
      } else if (isBudget && minor !== null) {
        // A running fair test: the total for every version and no ad set, so the server keeps the split (3.8).
        const res = await apiFetch<{ appliedDailyBudgetMinor?: unknown; dailyTotalMinor?: unknown } | null>(`${path}/budget`, { method: "POST", body: fair || !set ? { dailyBudgetMinor: minor } : { dailyBudgetMinor: minor, adSetId: set.id } });
        // Say what the server applied: the new daily total of a fair test, or the ad set's new budget.
        const appliedMinor = [res?.dailyTotalMinor, res?.appliedDailyBudgetMinor].find((v): v is number => typeof v === "number" && Number.isFinite(v)) ?? minor;
        const message = EDITS_TEXT.undoBudget(formatMinor(appliedMinor, c.currency));
        onDone({ message, undo: kind === "spend_less" ? { kind: "spend_less", text: message, prefill: minorToText(currentBudget, c.currency), adSetId: fair ? undefined : set?.id } : null });
      } else if (nextEnd) {
        await apiFetch(`${path}/end`, { method: "POST", body: { endsAt: nextEnd.toISOString() } });
        const message = EDITS_TEXT.undoEnd(fmtDate(nextEnd));
        onDone({ message, undo: kind === "end_earlier" && currentEnd && currentEnd.getTime() > now.getTime() ? { kind: "end_earlier", text: message, prefill: toDateTimeLocal(currentEnd) } : null });
      }
    } catch (e) {
      // Phase 0's refusal in its own words: the room left today and this month, or Meta's budget-change limit.
      setRefusal((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const sameValue = isBudget ? minor !== null && !shareProblem && budget === null : isEnd && nextEnd !== null && end === null;
  const budgetError = text.trim() !== "" && typed === null ? SHEET_TEXT.amountProblem : (shareProblem ?? (sameValue ? SHEET_TEXT.same : null));
  return (
    <Dialog
      title={editLabel(kind)}
      description={isBudget ? SHEET_TEXT.now(formatMinor(currentBudget, c.currency)) : isEnd ? (currentEnd ? SHEET_TEXT.nowEnd(fmtDate(currentEnd)) : SHEET_TEXT.noEnd) : undefined}
      onClose={onCancel}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {SHEET_TEXT.cancel}
          </Button>
          <Button onClick={() => void submit()} disabled={!ready} loading={busy} className="max-w-full whitespace-normal" data-testid="edit-sheet-primary">
            {primary}
          </Button>
        </>
      }
    >
      <form
        noValidate
        className="space-y-4"
        data-testid={`edit-sheet-${kind}`}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {isBudget && !fair && sets.length > 1 && (
          <FormField label={SHEET_TEXT.adSet}>
            <Select
              value={set?.id ?? ""}
              onChange={(e) => {
                const next = sets.find((s) => s.id === e.target.value);
                setSetId(e.target.value);
                if (next) setText(minorToText(next.dailyBudgetMinor ?? c.totalDailyBudgetMinor, c.currency));
              }}
            >
              {sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        {isBudget && (
          <FormField
            label={fair ? SHEET_TEXT.totalLabel(c.currency) : SHEET_TEXT.budgetLabel(c.currency)}
            hint={SHEET_TEXT.budgetHint}
            required
            error={budgetError}
          >
            <Input inputMode="decimal" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} data-autofocus="" />
          </FormField>
        )}
        {isBudget && fair && typed !== null && !shareProblem && <p className="text-sm text-muted" data-testid="edit-fair-split">{fairSplitLine(typed, versions, c.currency)}</p>}
        {isEnd && (
          <FormField label={SHEET_TEXT.endLabel} hint={SHEET_TEXT.endHint} required error={text.trim() !== "" ? (problem ?? (sameValue ? SHEET_TEXT.same : null)) : null}>
            <Input type="datetime-local" value={text} onChange={(e) => setText(e.target.value)} data-autofocus="" />
          </FormField>
        )}
        {kind === "resume" && (
          <p className="text-sm" data-testid="edit-resume-body">
            {RESUME_TEXT.body(amounts, c.currency)}
          </p>
        )}
        {raise && ready && (
          <div className="space-y-2" data-testid="edit-sheet-cost">
            {costDaily > 0n && runDays !== null ? (
              <CostLine dailyMinor={costDaily} runDays={runDays} startMode="now" tz={tz} currency={c.currency} headroom={headroom ?? null} kind="ads" />
            ) : costDaily > 0n || !lifetimeText ? (
              <p className="text-sm text-muted">{SHEET_TEXT.noCostLine}</p>
            ) : null}
            {lifetimeText && (
              <p className="text-sm text-muted" data-testid="edit-sheet-lifetime">
                {costDaily > 0n ? RESUME_TEXT.lifetime(lifetimeText) : RESUME_TEXT.lifetimeOnly(lifetimeText)}
              </p>
            )}
            {kind !== "resume" && <Alert tone="warn">{SHEET_TEXT.raiseNote}</Alert>}
          </div>
        )}
        {!raise && ready && <Alert tone="info">{SHEET_TEXT.cutNote}</Alert>}
        {refusal && (
          <Alert tone="bad" title={SHEET_TEXT.refused}>
            <span data-testid="edit-refusal">{refusal}</span>
          </Alert>
        )}
      </form>
    </Dialog>
  );
}

export default CampaignEdits;
