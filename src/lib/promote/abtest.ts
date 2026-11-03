/**
 * Compare versions (docs/IG-PAGE-ADS-SPEC.md 3.8, D12; PRM-12). A fair test (AdTest mode fair_split) runs each version as its
 * own ad set with an equal share of the daily total (ads/service keeps the split fair while it runs).
 *
 * - The verdict (pure, versionVerdict) needs at least 7 days and at least 15 results per version, and a cost per result at
 *   least 20% lower than the next version's: "Version B gets chats at ₹38 vs ₹55: likely winner." Otherwise "Too early to
 *   tell." The 20% is checked exactly (cross-multiplied in bigint), not on rounded amounts.
 * - [Keep B, pause the others] (pickWinner) is a lowering: every other running version is paused through
 *   ads/actions.pauseAdSet, which goes through the Spend Book's recordLowering, so it is never refused and works while spending
 *   is stopped. The test is marked decided with the numbers at decision time, and the answer carries the undo: an activate
 *   card, because turning a version back on spends again and is checked against the limits (reserveAds resume_adset).
 * - The undo (undoWinner, DELETE /api/promote/tests/[id]/winner {confirm: true}) turns those versions back on one by one through
 *   ads/actions.resumeAdSet (reserveAds resume_adset, behind the Start gate) and reopens the test. It is all or nothing: when a
 *   resume is refused, the versions already back on are paused again and the kept version stays kept.
 *
 * Numbers come from stored rows only; this file never calls Meta itself. Per version and per day: the placement breakdown rows
 * of its ads, else its ad set's level-sync row that day (counted for the goal only when that row can say, snapshotResult). For
 * a goal whose result is people reached, each version's reach and spend come from its own run total (R3a per ad set), because
 * reach never adds up across days.
 */
import { Prisma } from "@/generated/prisma/client";
import { pauseAdSet, resumeAdSet } from "@/lib/ads/actions";
import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import type { SpendActor } from "@/lib/spend/types";
import { type Actor, HttpError, requireRole } from "@/lib/tenancy";
import {
  addSnapshot,
  addTo,
  campaignResultKey,
  compareCost,
  costPerResultBig,
  dayOf,
  displayCost,
  formatVersionList,
  goalResultActions,
  isReachGoal,
  resultNoun,
  rowView,
  type ResultRowView,
  type SnapshotLike,
  type Totals,
} from "./breakdowns";
import { assertPromoteStartOpen } from "./route-guard";

export const MIN_DAYS = 7;
export const MIN_RESULTS = 15;
/** The winner's cost per result must be at least this much lower than the next version's. */
export const MIN_MARGIN_PCT = 20;

const DAY_MS = 86_400_000;

export const ABTEST_COPY = {
  tooEarly: "Too early to tell.",
  notFound: "Comparison not found.",
  chooseVersion: "Choose the version to keep.",
  notAVersion: "That ad set isn't one of the versions in this comparison.",
  notRunning: "Start the ad first. You can keep a version once the versions are running.",
  decided: "A version was already kept for this comparison.",
  metaStudy: "Meta runs this comparison, so its winner is picked there.",
  notOnMeta: "That version isn't on Meta yet, so it can't be kept.",
  raced: "Someone else just kept a version. Reload the page to see it.",
  undoBody: "Turning a version back on spends again, so it's checked against your limits first.",
  nothingToUndo: "No version has been kept for this comparison, so there's nothing to undo.",
  confirmUndo: "Confirm to turn the other versions back on.",
  undoRaced: "Someone else just changed this comparison. Reload the page to see it.",
} as const;

// =====================================================================================================================
// The verdict (pure)
// =====================================================================================================================

/** `uncounted`: the version's results for the goal aren't known yet (snapshotResult), so the verdict waits. */
export type VersionStat = { adSetId: string; key: string; spendMinor: bigint; results: number; uncounted?: boolean };

export type VersionCost = { adSetId: string; key: string; costPerResultMinor: string; costPerResult: string };

export type Verdict = {
  state: "too_early" | "likely_winner";
  /** "Version B gets chats at ₹38 vs ₹55: likely winner." or "Too early to tell." */
  text: string;
  /** What is still missing, in plain words, while it is too early. */
  hint: string | null;
  days: number;
  minDays: number;
  minResults: number;
  /** Why it is too early: fewer days than needed, a version with too few results or not counted yet, or no version 20% cheaper. */
  reasons: ("days" | "results" | "not_counted" | "margin")[];
  winner: VersionCost | null;
  runnerUp: VersionCost | null;
};

const costOf = (v: VersionStat, currency: string): VersionCost => {
  const cost = costPerResultBig(v.spendMinor, v.results) ?? 0n;
  return { adSetId: v.adSetId, key: v.key, costPerResultMinor: cost.toString(), costPerResult: displayCost(cost, currency) };
};

/**
 * The compare verdict (3.8, D12). A likely winner needs every version to have run `minDays` and reached `minResults`, and the
 * cheapest version's cost per result to be at most 80% of the next cheapest's.
 */
export function versionVerdict(input: { days: number; versions: readonly VersionStat[]; currency: string; resultKey: string | null; minDays?: number; minResults?: number }): Verdict {
  const minDays = input.minDays ?? MIN_DAYS;
  const minResults = input.minResults ?? MIN_RESULTS;
  const days = Math.max(0, Math.floor(input.days));
  const noun = resultNoun(input.resultKey);
  const reasons: Verdict["reasons"] = [];
  if (days < minDays) reasons.push("days");
  if (input.versions.length < 2 || input.versions.some((v) => !v.uncounted && v.results < minResults)) reasons.push("results");
  // A version whose results can't be counted for the goal yet is never compared on another metric.
  if (input.versions.some((v) => v.uncounted)) reasons.push("not_counted");
  const sorted = [...input.versions].sort(compareCost);
  const [best, next] = sorted;
  if (reasons.length === 0) {
    // best.cost <= next.cost * (100 - margin) / 100, exactly: best.spend * next.results * 100 <= next.spend * best.results * (100 - margin)
    const left = best.spendMinor * BigInt(next.results) * 100n;
    const right = next.spendMinor * BigInt(best.results) * BigInt(100 - MIN_MARGIN_PCT);
    if (left > right) reasons.push("margin");
  }
  if (reasons.length === 0) {
    const winner = costOf(best, input.currency);
    const runnerUp = costOf(next, input.currency);
    return {
      state: "likely_winner",
      text: `Version ${winner.key} gets ${noun} at ${winner.costPerResult} vs ${runnerUp.costPerResult}: likely winner.`,
      hint: null,
      days,
      minDays,
      minResults,
      reasons,
      winner,
      runnerUp,
    };
  }
  const hint =
    reasons.includes("days") || reasons.includes("results")
      ? `Each version needs at least ${minDays} days and ${minResults} ${noun} before the results can be compared.`
      : reasons.includes("not_counted")
        ? `Each version's ${noun} aren't counted yet. Check again in a few hours.`
        : `No version is at least ${MIN_MARGIN_PCT}% cheaper per ${resultNoun(input.resultKey, 1)} yet.`;
  return { state: "too_early", text: ABTEST_COPY.tooEarly, hint, days, minDays, minResults, reasons, winner: null, runnerUp: null };
}

/** Whole days the versions have run: from the start to now, or to the end when it ended earlier. */
export function daysRunning(start: Date | null, now: Date, endsAt: Date | null = null): number {
  if (!start) return 0;
  const end = endsAt && endsAt.getTime() < now.getTime() ? endsAt : now;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / DAY_MS));
}

// =====================================================================================================================
// Loading
// =====================================================================================================================

type VersionSet = { id: string; name: string; metaAdSetId: string | null; variantKey: string | null; status: string; optimizationGoal?: string | null; ads: { metaAdId: string | null }[] };
type TestRow = {
  id: string;
  tenantId: string;
  campaignId: string;
  kind: string;
  mode: string;
  status: string;
  minDays: number;
  minResults: number;
  winnerAdSetId: string | null;
  verdict: unknown;
  decidedAt: Date | null;
  decidedByUserId?: string | null;
  createdAt: Date;
  campaign: {
    id: string;
    name: string;
    goal: string | null;
    template: string;
    objective: string;
    currency: string;
    status: string;
    surface?: string | null;
    startsAt: Date | null;
    launchedAt: Date | null;
    endsAt: Date | null;
    adSets: VersionSet[];
  };
};

const TEST_SELECT = {
  id: true,
  tenantId: true,
  campaignId: true,
  kind: true,
  mode: true,
  status: true,
  minDays: true,
  minResults: true,
  winnerAdSetId: true,
  verdict: true,
  decidedAt: true,
  decidedByUserId: true,
  createdAt: true,
  campaign: {
    select: {
      id: true,
      name: true,
      goal: true,
      template: true,
      objective: true,
      currency: true,
      status: true,
      surface: true,
      startsAt: true,
      launchedAt: true,
      endsAt: true,
      adSets: { select: { id: true, name: true, metaAdSetId: true, variantKey: true, status: true, optimizationGoal: true, ads: { select: { metaAdId: true } } } },
    },
  },
} as const;

async function loadTest(tenantId: string, where: { id: string } | { campaignId: string }): Promise<TestRow | null> {
  return (await prisma.adTest.findFirst({ where: { ...where, tenantId }, select: TEST_SELECT })) as TestRow | null;
}

/** The versions of a test: ad sets with a version key, in A, B, C order. */
const versionsOf = (t: TestRow): VersionSet[] => t.campaign.adSets.filter((s) => !!s.variantKey).sort((a, b) => String(a.variantKey).localeCompare(String(b.variantKey)));

const startOf = (t: TestRow) => t.campaign.startsAt ?? t.campaign.launchedAt;
const dayDate = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);

const zeroTotals = (): Totals => ({ spendMinor: 0n, impressions: 0, clicks: 0, results: 0, leads: 0 });

/**
 * Spend and results per version since the start. Per version and per day: the placement breakdown rows of its ads (results
 * for the goal, exact spend) where that day has any, else its ad set's level-sync row that day, whose results count only when
 * they are the goal's (snapshotResult; otherwise the version is "not counted yet"). For a goal whose result is people reached,
 * each version's reach, spend, views and clicks come from its own run total (R3a per ad set), never a sum of daily reach.
 */
async function versionTotals(tenantId: string, versions: readonly VersionSet[], since: Date | null, resultKey: string | null): Promise<Map<string, Totals>> {
  const out = new Map<string, Totals>(versions.map((v) => [v.id, zeroTotals()]));
  const versionOfAd = new Map<string, string>();
  for (const v of versions) for (const a of v.ads) if (a.metaAdId) versionOfAd.set(a.metaAdId, v.id);
  const versionOfSet = new Map(versions.filter((v) => v.metaAdSetId).map((v) => [String(v.metaAdSetId), v.id]));
  const date = since ? { gte: dayDate(since) } : undefined;
  const covered = new Map<string, Set<string>>(versions.map((v) => [v.id, new Set<string>()]));
  if (versionOfAd.size) {
    const rows = (await prisma.insightBreakdown.findMany({
      where: { tenantId, entityType: "ad", entityMetaId: { in: [...versionOfAd.keys()] }, dimension: "placement", ...(date ? { date } : {}) },
      select: { entityMetaId: true, date: true, spendMinor: true, impressions: true, clicks: true, results: true },
    })) as { entityMetaId: string; date: Date; spendMinor: bigint; impressions: number; clicks: number; results: number }[];
    for (const r of rows) {
      const v = versionOfAd.get(r.entityMetaId);
      if (!v) continue;
      addTo(out.get(v)!, r);
      covered.get(v)!.add(dayOf(r.date));
    }
  }
  if (versionOfSet.size) {
    const snaps = (await prisma.insightSnapshot.findMany({
      where: { tenantId, entityType: "adset", entityMetaId: { in: [...versionOfSet.keys()] }, ...(date ? { date } : {}) },
      select: { entityMetaId: true, date: true, spendMinor: true, impressions: true, clicks: true, results: true, messagingStarts: true, thruplays: true, raw: true },
    })) as (SnapshotLike & { entityMetaId: string; date: Date; spendMinor: number; impressions: number; clicks: number })[];
    const actionsOf = new Map(versions.map((v) => [v.id, goalResultActions(resultKey, [v.optimizationGoal])]));
    for (const s of snaps) {
      const v = versionOfSet.get(s.entityMetaId);
      if (!v || covered.get(v)!.has(dayOf(s.date))) continue;
      addSnapshot(out.get(v)!, s, resultKey, actionsOf.get(v));
    }
  }
  if (isReachGoal(resultKey)) {
    const runs = versionOfSet.size
      ? ((await prisma.insightBreakdown.findMany({
          where: { tenantId, entityType: "adset", entityMetaId: { in: [...versionOfSet.keys()] }, dimension: "run_total" },
          select: { entityMetaId: true, spendMinor: true, impressions: true, clicks: true, reach: true },
        })) as { entityMetaId: string; spendMinor: bigint; impressions: number; clicks: number; reach: number | null }[])
      : [];
    const runOf = new Map(runs.map((r) => [r.entityMetaId, r]));
    for (const v of versions) {
      const run = v.metaAdSetId ? runOf.get(v.metaAdSetId) : undefined;
      if (run && typeof run.reach === "number") out.set(v.id, addTo(zeroTotals(), { spendMinor: run.spendMinor, impressions: run.impressions, clicks: run.clicks, results: run.reach }));
      else out.set(v.id, { ...out.get(v.id)!, results: 0, uncounted: true });
    }
  }
  return out;
}

export type ComparisonView = {
  test: { id: string; campaignId: string; kind: string; mode: string; status: string; minDays: number; minResults: number; winnerAdSetId: string | null; decidedAt: string | null };
  currency: string;
  goal: string | null;
  resultNoun: string;
  days: number;
  versions: (ResultRowView & { adSetId: string; version: string; name: string; status: string; isWinner: boolean })[];
  verdict: Verdict;
  /** [Keep B, pause the others] is offered while the test runs and has two or more versions on Meta. */
  canPickWinner: boolean;
};

async function comparisonOf(t: TestRow, now: Date): Promise<ComparisonView> {
  const versions = versionsOf(t);
  const resultKey = campaignResultKey(t.campaign);
  const currency = t.campaign.currency;
  const days = daysRunning(startOf(t), now, t.campaign.endsAt);
  const totals = await versionTotals(t.tenantId, versions, startOf(t), resultKey);
  const stats: VersionStat[] = versions.map((v) => {
    const x = totals.get(v.id)!;
    return { adSetId: v.id, key: String(v.variantKey), spendMinor: x.spendMinor, results: x.results, ...(x.uncounted ? { uncounted: true } : {}) };
  });
  const verdict = versionVerdict({ days, versions: stats, currency, resultKey, minDays: t.minDays, minResults: t.minResults });
  return {
    test: { id: t.id, campaignId: t.campaignId, kind: t.kind, mode: t.mode, status: t.status, minDays: t.minDays, minResults: t.minResults, winnerAdSetId: t.winnerAdSetId, decidedAt: t.decidedAt ? t.decidedAt.toISOString() : null },
    currency,
    goal: resultKey,
    resultNoun: resultNoun(resultKey),
    days,
    versions: versions.map((v) => ({
      ...rowView(v.id, `Version ${v.variantKey}`, totals.get(v.id)!, { currency, resultKey }),
      adSetId: v.id,
      version: String(v.variantKey),
      name: v.name,
      status: v.status,
      isWinner: t.winnerAdSetId === v.id,
    })),
    verdict,
    canPickWinner: t.mode === "fair_split" && t.status === "running" && !t.winnerAdSetId && versions.filter((v) => v.metaAdSetId).length > 1,
  };
}

/** GET /api/promote/tests/[id]: one comparison of the workspace, with its versions' numbers and the verdict. 404 when unknown. */
export async function getComparison(tenantId: string, testId: string, now = new Date()): Promise<ComparisonView> {
  const t = await loadTest(tenantId, { id: testId });
  if (!t) throw new HttpError(404, ABTEST_COPY.notFound);
  return comparisonOf(t, now);
}

/** The comparison of a campaign, or null when it compares nothing (the Results tab "Which version worked"). */
export async function comparisonForCampaign(tenantId: string, campaignId: string, now = new Date()): Promise<ComparisonView | null> {
  const t = await loadTest(tenantId, { campaignId });
  return t ? comparisonOf(t, now) : null;
}

// =====================================================================================================================
// Keep the winner
// =====================================================================================================================

export type PausedVersion = { adSetId: string; metaAdSetId: string; key: string; previousStatus: string };

/**
 * The undo of [Keep B, pause the others]: an activate card (confirm), because turning a version back on spends again. The card
 * runs `request` once the person confirms (undoWinner); it is the documented inverse Eddy (PRM-13) uses too.
 */
export type WinnerUndo = {
  kind: "activate_card";
  action: "resume_versions";
  risk: "confirm";
  testId: string;
  campaignId: string;
  versions: PausedVersion[];
  /** The Spend Book intents the card reserves (reserveAds resume_adset), one per version that was running. */
  intents: { kind: "resume_adset"; adSetId: string; metaAdSetId: string }[];
  /** DELETE /api/promote/tests/{id}/winner {confirm: true}. */
  request: { method: "DELETE"; path: string; body: { confirm: true } };
  title: string;
  body: string;
};

/** The undo's answer: the test runs again and these versions are back on. */
export type UndoWinnerResult = {
  test: { id: string; status: "running"; winnerAdSetId: null };
  resumed: { adSetId: string; key: string }[];
  message: string;
};

export type WinnerResult = {
  test: { id: string; status: "decided"; winnerAdSetId: string };
  winner: { adSetId: string; key: string };
  paused: { adSetId: string; key: string }[];
  verdict: Verdict;
  message: string;
  undo: WinnerUndo | null;
};

const OFF = new Set(["paused", "archived"]);

/**
 * [Keep B, pause the others] (pick_winning_version): admins and owners. Claims the test first (running to decided, so two
 * people can't keep different versions), then pauses every other running version through pauseAdSet (recordLowering: never
 * refused, works while spending is stopped). If a pause fails the claim is released, the versions already paused stay paused
 * (a lowering is always safe), and a retry pauses the rest. Returns the undo payload: an activate card.
 */
export async function pickWinner(actor: Actor, testId: string, adSetId: unknown, opts: { now?: Date; spendActor?: SpendActor } = {}): Promise<WinnerResult> {
  requireRole(actor, "admin");
  const now = opts.now ?? new Date();
  if (typeof adSetId !== "string" || !adSetId.trim()) throw new HttpError(400, ABTEST_COPY.chooseVersion);
  const tenantId = actor.tenantId;
  const t = await loadTest(tenantId, { id: testId });
  if (!t) throw new HttpError(404, ABTEST_COPY.notFound);
  if (t.mode !== "fair_split") throw new HttpError(409, ABTEST_COPY.metaStudy);
  if (t.status === "decided" || t.winnerAdSetId) throw new HttpError(409, ABTEST_COPY.decided);
  if (t.status !== "running") throw new HttpError(409, ABTEST_COPY.notRunning);
  const versions = versionsOf(t);
  const winner = versions.find((v) => v.id === adSetId.trim());
  if (!winner) throw new HttpError(400, ABTEST_COPY.notAVersion);
  if (!winner.metaAdSetId) throw new HttpError(409, ABTEST_COPY.notOnMeta);
  const winnerKey = String(winner.variantKey);

  // The numbers at decision time, kept with the decision, and the running versions the undo turns back on.
  const view = await comparisonOf(t, now);
  const verdictJson = {
    state: view.verdict.state,
    text: view.verdict.text,
    days: view.days,
    kept: winnerKey,
    keptVerdictWinner: view.verdict.winner?.adSetId === winner.id,
    currency: view.currency,
    versions: view.versions.map((v) => ({ key: v.version, adSetId: v.adSetId, spendMinor: v.spendMinor, results: v.results, costPerResultMinor: v.costPerResultMinor })),
    resume: versions.filter((v) => v.id !== winner.id && v.metaAdSetId && v.status === "active").map((v) => v.id),
  };

  const claimed = await prisma.adTest.updateMany({
    where: { id: t.id, tenantId, status: "running", winnerAdSetId: null },
    data: { status: "decided", winnerAdSetId: winner.id, verdict: verdictJson, decidedAt: now, decidedByUserId: actor.userId },
  });
  if (claimed.count === 0) throw new HttpError(409, ABTEST_COPY.raced);

  // Who the Spend Book records for the pauses: Eddy forwards its via_eddy actor (B14); the signed-in person by default.
  const who: SpendActor = opts.spendActor ?? { type: "user", userId: actor.userId, role: actor.role };
  const paused: PausedVersion[] = [];
  try {
    for (const v of versions) {
      if (v.id === winner.id || !v.metaAdSetId || OFF.has(v.status)) continue;
      const { revertPayload } = await pauseAdSet(tenantId, v.metaAdSetId, who, { reason: `Kept version ${winnerKey} of '${t.campaign.name}' and paused version ${v.variantKey}.` });
      paused.push({ adSetId: v.id, metaAdSetId: v.metaAdSetId, key: String(v.variantKey), previousStatus: typeof revertPayload.previousStatus === "string" ? revertPayload.previousStatus : v.status });
    }
  } catch (e) {
    await prisma.adTest
      .updateMany({ where: { id: t.id, tenantId, status: "decided", winnerAdSetId: winner.id }, data: { status: "running", winnerAdSetId: null, verdict: Prisma.DbNull, decidedAt: null, decidedByUserId: null } })
      .catch(() => console.error("[promote] could not reopen the comparison after a failed pause"));
    throw e;
  }

  await audit({ tenantId, userId: actor.userId, action: "promote.test.winner_kept", target: t.id, meta: { version: winnerKey, paused: paused.length, verdict: view.verdict.state } });
  const resumable = paused.filter((p) => p.previousStatus === "active");
  const keys = paused.map((p) => p.key);
  return {
    test: { id: t.id, status: "decided", winnerAdSetId: winner.id },
    winner: { adSetId: winner.id, key: winnerKey },
    paused: paused.map((p) => ({ adSetId: p.adSetId, key: p.key })),
    verdict: view.verdict,
    message: keys.length ? `Kept version ${winnerKey}. Paused ${formatVersionList(keys)}.` : `Kept version ${winnerKey}.`,
    undo: resumable.length
      ? {
          kind: "activate_card",
          action: "resume_versions",
          risk: "confirm",
          testId: t.id,
          campaignId: t.campaignId,
          versions: resumable,
          intents: resumable.map((p) => ({ kind: "resume_adset", adSetId: p.adSetId, metaAdSetId: p.metaAdSetId })),
          request: { method: "DELETE", path: `/api/promote/tests/${encodeURIComponent(t.id)}/winner`, body: { confirm: true } },
          title: `Turn ${formatVersionList(resumable.map((p) => p.key))} back on?`,
          body: ABTEST_COPY.undoBody,
        }
      : null,
  };
}

/** The versions the decision paused while they were running (stored with the decision by pickWinner). */
function resumeListOf(verdict: unknown): string[] {
  const list = verdict && typeof verdict === "object" && !Array.isArray(verdict) ? (verdict as { resume?: unknown }).resume : undefined;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The undo of [Keep B, pause the others] (DELETE /api/promote/tests/[id]/winner {confirm: true}): admins and owners, behind the
 * Start gate. Claims the decision first (decided back to running, so two people can't undo at once), then turns each version
 * the decision paused back on through resumeAdSet: reserveAds resume_adset, so it is checked against the limits and can be
 * refused. All or nothing: when a resume is refused or fails, the versions already back on are paused again (lowerings, never
 * refused), the decision is put back as it was, and the refusal is thrown with its reason. A version that is no longer paused
 * (turned on elsewhere) is left alone.
 */
export async function undoWinner(actor: Actor, testId: string, confirm: unknown): Promise<UndoWinnerResult> {
  requireRole(actor, "admin");
  const tenantId = actor.tenantId;
  const t = await loadTest(tenantId, { id: testId });
  if (!t) throw new HttpError(404, ABTEST_COPY.notFound);
  if (t.mode !== "fair_split") throw new HttpError(409, ABTEST_COPY.metaStudy);
  if (t.status !== "decided" || !t.winnerAdSetId) throw new HttpError(409, ABTEST_COPY.nothingToUndo);
  if (confirm !== true) throw new HttpError(400, ABTEST_COPY.confirmUndo);
  assertPromoteStartOpen(actor, t.campaign);
  const versions = versionsOf(t);
  const kept = versions.find((v) => v.id === t.winnerAdSetId);
  const keptKey = kept ? String(kept.variantKey) : "";
  const planned = new Set(resumeListOf(t.verdict));
  const toResume = versions.filter((v): v is VersionSet & { metaAdSetId: string } => v.id !== t.winnerAdSetId && planned.has(v.id) && !!v.metaAdSetId && v.status === "paused");

  const claimed = await prisma.adTest.updateMany({
    where: { id: t.id, tenantId, status: "decided", winnerAdSetId: t.winnerAdSetId },
    data: { status: "running", winnerAdSetId: null, verdict: Prisma.DbNull, decidedAt: null, decidedByUserId: null },
  });
  if (claimed.count === 0) throw new HttpError(409, ABTEST_COPY.undoRaced);

  const who: SpendActor = { type: "user", userId: actor.userId, role: actor.role };
  const resumed: (VersionSet & { metaAdSetId: string })[] = [];
  try {
    for (const v of toResume) {
      await resumeAdSet(tenantId, v.metaAdSetId, { action: "resume_adset", metaAdSetId: v.metaAdSetId, previousStatus: "active" }, who, {
        reason: `Turned version ${v.variantKey} of '${t.campaign.name}' back on (undid keeping version ${keptKey}).`,
      });
      resumed.push(v);
    }
  } catch (e) {
    for (const v of [...resumed].reverse()) {
      try {
        await pauseAdSet(tenantId, v.metaAdSetId, who, { reason: `Paused version ${v.variantKey} again: the undo of keeping version ${keptKey} was not completed.` });
      } catch {
        console.error("[promote] could not pause a version again after a refused undo");
      }
    }
    await prisma.adTest
      .updateMany({
        where: { id: t.id, tenantId, status: "running", winnerAdSetId: null },
        data: {
          status: "decided",
          winnerAdSetId: t.winnerAdSetId,
          verdict: t.verdict === null || t.verdict === undefined ? Prisma.DbNull : (t.verdict as Prisma.InputJsonValue),
          decidedAt: t.decidedAt,
          decidedByUserId: t.decidedByUserId ?? null,
        },
      })
      .catch(() => console.error("[promote] could not put the comparison's decision back after a refused undo"));
    throw e;
  }

  const keys = resumed.map((v) => String(v.variantKey));
  await audit({ tenantId, userId: actor.userId, action: "promote.test.winner_undone", target: t.id, meta: { version: keptKey, resumed: resumed.length } });
  return {
    test: { id: t.id, status: "running", winnerAdSetId: null },
    resumed: resumed.map((v) => ({ adSetId: v.id, key: String(v.variantKey) })),
    message: keys.length ? `Turned ${formatVersionList(keys)} back on. The comparison is running again.` : "The comparison is running again.",
  };
}
