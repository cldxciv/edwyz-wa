"use client";

/**
 * CompareVersions (docs/IG-PAGE-ADS-SPEC.md 3.8, 7.3, D12; PRM-15b): the compare card of a fair test.
 *
 * - Each version's spend, results and cost per result as bars with their text ("Version B: 46 chats, ₹38 each"), cheapest
 *   first, so colour and length are never the only signal.
 * - The verdict: "Version B gets chats at ₹38 vs ₹55: likely winner." once every version ran 7 days with 15 results and one
 *   is at least 20% cheaper; otherwise "Too early to tell." with what is still missing.
 * - [Keep B, pause the others]: POST /api/promote/tests/[id]/winner, a lowering (the others pause through recordLowering,
 *   never refused). Its Undo is an activate card, because turning a version back on spends again: DELETE …/winner
 *   { confirm: true }, checked against the limits and refused in plain words when it doesn't fit.
 * It reads GET /api/promote/tests/[id] itself when given `testId`, or shows the `comparison` it is handed.
 */
import { useId, useState } from "react";
import { Alert, Button, Dialog, Skeleton, apiFetch, cn, toast } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import { promoteText } from "@/lib/promote/copy";
import { COMPARE_TEXT, keepCandidate, keepLabel, resultBars, verdictText, type BarRow, type ResultRowLite, type VerdictLite } from "./results-helpers";

export const COMPARE_VERSIONS_TEST_ID = "compare-versions";

/**
 * Bars with their text value (3.10, 7.3): the sentence carries the numbers and the bar only repeats them, so colour and
 * length are never the only signal. The bar is hidden from screen readers. Shared with ResultsByPlacement.
 */
export function ResultBars({ rows, label, testId }: { rows: readonly BarRow[]; label: string; testId?: string }) {
  if (rows.length === 0) return null;
  return (
    <ul aria-label={label} className="space-y-3" data-testid={testId}>
      {rows.map((r) => (
        <li key={r.key} className="min-w-0" data-testid="result-bar">
          <p className="text-sm break-words tabular-nums">{r.text}</p>
          <div aria-hidden className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-accent" style={{ width: `${r.percent}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export type ComparisonLite = {
  test: { id: string; status: string; winnerAdSetId: string | null };
  resultNoun: string;
  days?: number;
  versions: (ResultRowLite & { adSetId: string; version: string; isWinner?: boolean })[];
  verdict: VerdictLite;
  canPickWinner: boolean;
};

type UndoCard = { title: string; body: string; request: { method: "DELETE"; path: string; body: { confirm: true } } };

export type CompareVersionsProps = {
  /** AdTest id: the card reads GET /api/promote/tests/[id]. */
  testId?: string | null;
  /** A comparison already loaded (the "Which version worked" tab). */
  comparison?: ComparisonLite | null;
  /** Owners and admins: [Keep …]. */
  canWrite?: boolean;
  onChanged?: () => void;
  className?: string;
};

export function CompareVersions({ testId, comparison, canWrite = true, onChanged, className }: CompareVersionsProps) {
  const headingId = useId();
  const loaded = useApi<{ comparison: ComparisonLite }>(testId && !comparison ? `/api/promote/tests/${encodeURIComponent(testId)}` : null);
  const c = comparison ?? loaded.data?.comparison ?? null;
  const [busy, setBusy] = useState<"keep" | "undo" | null>(null);
  const [undo, setUndo] = useState<UndoCard | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [said, setSaid] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);

  if (!c) {
    if (loaded.error) {
      return (
        <Alert tone="warn" className={className} action={<Button size="sm" variant="secondary" onClick={loaded.retry}>Try again</Button>}>
          {COMPARE_TEXT.failed}
        </Alert>
      );
    }
    return testId ? <Skeleton className={cn("h-24 w-full", className)} /> : null;
  }

  const keep = canWrite ? keepCandidate(c) : null;
  const verdict = verdictText(c.verdict, c.resultNoun);
  const kept = c.versions.find((v) => v.isWinner || v.adSetId === c.test.winnerAdSetId) ?? null;

  async function keepWinner() {
    if (!keep || !c) return;
    setBusy("keep");
    setRefusal(null);
    try {
      const res = await apiFetch<{ message?: string; undo: UndoCard | null }>(`/api/promote/tests/${encodeURIComponent(c.test.id)}/winner`, { method: "POST", body: { adSetId: keep.adSetId } });
      const text = res.message ?? COMPARE_TEXT.kept(keep.key);
      setUndo(res.undo);
      setSaid(text);
      toast.success(text);
      if (!comparison) loaded.reload();
      onChanged?.();
    } catch (e) {
      setRefusal((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function undoWinner() {
    if (!undo) return;
    setBusy("undo");
    setRefusal(null);
    try {
      await apiFetch(undo.request.path, { method: undo.request.method, body: undo.request.body });
      setUndo(null);
      setConfirming(false);
      setSaid(COMPARE_TEXT.undone);
      toast.success(COMPARE_TEXT.undone);
      if (!comparison) loaded.reload();
      onChanged?.();
    } catch (e) {
      setConfirming(false);
      setRefusal((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby={headingId} className={cn("min-w-0 space-y-3", className)} data-testid={COMPARE_VERSIONS_TEST_ID}>
      <h2 id={headingId} className="text-base font-semibold tracking-tight">
        {COMPARE_TEXT.heading}
      </h2>
      <p className="text-xs text-muted">{promoteText("version.fair")}</p>
      <ResultBars rows={resultBars(c.versions.map((v) => ({ ...v, key: v.adSetId, label: v.label ?? `Version ${v.version}` })))} label={COMPARE_TEXT.heading} />
      <div aria-live="polite" className="space-y-2">
        <p className={cn("rounded-card border p-3 text-sm font-medium break-words", c.verdict.state === "likely_winner" ? "border-good-line bg-good-soft text-good-fg" : "border-border bg-surface")} data-testid="compare-verdict" data-state={c.verdict.state}>
          {verdict}
          {c.verdict.state === "too_early" && c.verdict.hint && <span className="mt-1 block text-xs font-normal">{c.verdict.hint}</span>}
        </p>
        {kept && c.test.winnerAdSetId && <p className="text-sm">{COMPARE_TEXT.kept(kept.version)}</p>}
        {said && !undo && <span className="sr-only">{said}</span>}
        {undo && (
          <p className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 break-words">{said}</span>
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => setConfirming(true)} data-testid="compare-undo">
              {promoteText("edit.undo")}
            </Button>
          </p>
        )}
        {refusal && <Alert tone="bad">{refusal}</Alert>}
      </div>
      {keep && !c.test.winnerAdSetId && (
        <Button loading={busy === "keep"} disabled={busy !== null} onClick={() => void keepWinner()} className="max-w-full whitespace-normal" data-testid="compare-keep">
          {keepLabel(keep.key)}
        </Button>
      )}
      {confirming && undo && (
        <Dialog
          title={undo.title || COMPARE_TEXT.undoTitle}
          description={undo.body || COMPARE_TEXT.undoBody}
          onClose={() => setConfirming(false)}
          dismissible={busy === null}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)} disabled={busy !== null}>
                Cancel
              </Button>
              <Button loading={busy === "undo"} onClick={() => void undoWinner()} data-testid="compare-undo-confirm">
                {COMPARE_TEXT.undoConfirm}
              </Button>
            </>
          }
        >
          <p className="text-sm">{COMPARE_TEXT.undoBody}</p>
        </Dialog>
      )}
    </section>
  );
}

export default CompareVersions;
