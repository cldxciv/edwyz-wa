import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { formatMinor } from "@/lib/spend/money";
import type { ApprovalDecision, ApprovalSubject } from "./types";

/** Stored files have no public URL; the creative module hands out a short-lived signed one. Loaded lazily so the approvals module does not depend on it at import time. */
async function signedImageUrl(tenantId: string, assetId: string): Promise<string | undefined> {
  try {
    const { signedAssetUrl } = await import("@/lib/creative");
    return signedAssetUrl(tenantId, assetId, 3600);
  } catch {
    console.error("[approvals] could not sign an image link for the approval page");
    return undefined;
  }
}

export type SummaryRow = { label: string; value: string };
export type SubjectSummary = { kindLabel: string; title: string; rows: SummaryRow[]; text?: string; imageUrl?: string };

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g;

/** Plain text only: control and bidi-override characters removed, length capped. Callers still render through React text nodes, which escape. */
export function clean(value: string | null | undefined, max = 2000): string {
  return (value ?? "").replace(CONTROL, "").trim().slice(0, max);
}

export function safeHttpsUrl(value: string | null | undefined): string | undefined {
  const v = (value ?? "").trim();
  if (!/^https:\/\/[^\s"'<>\\]{1,2000}$/.test(v)) return undefined;
  try {
    return new URL(v).protocol === "https:" ? v : undefined;
  } catch {
    return undefined;
  }
}

const dateText = (d: Date | null | undefined) =>
  d ? `${d.toLocaleString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} UTC` : "";

const dayText = (d: Date | null | undefined) => (d ? d.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }) : "");

/**
 * A budget in its currency, with that currency's exponent (docs/SPEND-CONTROLS-SPEC.md 7.3: "approval summaries format with
 * the currency exponent"): 50000 INR is "₹500", 1500 JPY is "¥1,500", 1234 KWD is "KWD 1.234". Never divides by 100 blindly.
 */
export function money(minor: number, currency: string): string {
  const code = /^[A-Z]{3}$/.test(currency) ? currency : "INR";
  if (!Number.isFinite(minor)) return "";
  return formatMinor(BigInt(Math.trunc(minor)), code);
}

const rows = (list: [string, string | null | undefined][]): SummaryRow[] =>
  list.filter(([, v]) => v).map(([label, value]) => ({ label, value: clean(value, 200) }));

export type SubjectOwner = { createdByUserId: string | null };

type Handler = {
  load(tenantId: string, id: string): Promise<SubjectSummary | null>;
  owner(tenantId: string, id: string): Promise<SubjectOwner | null>;
  /** A digest of everything the client is shown, so a decision can be refused when the content changed after the link was made. Null when unknown. */
  fingerprint(tenantId: string, id: string): Promise<string | null>;
  /** fp is the fingerprint the decision was checked against (null when the approval predates fingerprints). */
  apply(tenantId: string, id: string, decision: ApprovalDecision, fp?: string | null): Promise<void>;
};

export const digest = (parts: unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const creativeAsset: Handler = {
  async load(tenantId, id) {
    const a = await prisma.creativeAsset.findFirst({ where: { id, tenantId }, select: { kind: true, placement: true, headline: true, body: true, storageKey: true } });
    if (!a) return null;
    return {
      kindLabel: "Ad creative",
      title: clean(a.headline, 200) || "Ad creative",
      rows: rows([["Format", a.kind], ["Placement", a.placement === "none" ? "" : a.placement]]),
      text: clean(a.body) || undefined,
      imageUrl: a.kind === "image" ? (safeHttpsUrl(a.storageKey) ?? (a.storageKey ? await signedImageUrl(tenantId, id) : undefined)) : undefined,
    };
  },
  async fingerprint(tenantId, id) {
    const a = await prisma.creativeAsset.findFirst({ where: { id, tenantId }, select: { kind: true, placement: true, headline: true, body: true, storageKey: true } });
    return a ? digest([a.kind, a.placement, a.headline, a.body, a.storageKey]) : null;
  },
  async owner(tenantId, id) {
    const a = await prisma.creativeAsset.findFirst({ where: { id, tenantId }, select: { brief: { select: { createdByUserId: true } } } });
    return a ? { createdByUserId: a.brief?.createdByUserId ?? null } : null;
  },
  async apply(tenantId, id, decision) {
    if (decision === "changes_requested") return;
    await prisma.creativeAsset.updateMany({
      where: { id, tenantId, status: { in: ["ready", "approved", "rejected"] } },
      data: { status: decision === "approved" ? "approved" : "rejected" },
    });
  },
};

const creativeBrief: Handler = {
  async load(tenantId, id) {
    const b = await prisma.creativeBrief.findFirst({ where: { id, tenantId }, select: { goal: true, offer: true } });
    if (!b) return null;
    return { kindLabel: "Creative brief", title: "Creative brief", rows: rows([["Goal", b.goal]]), text: clean(b.offer) || undefined };
  },
  async fingerprint(tenantId, id) {
    const b = await prisma.creativeBrief.findFirst({ where: { id, tenantId }, select: { goal: true, offer: true } });
    return b ? digest([b.goal, b.offer]) : null;
  },
  async owner(tenantId, id) {
    const b = await prisma.creativeBrief.findFirst({ where: { id, tenantId }, select: { createdByUserId: true } });
    return b ? { createdByUserId: b.createdByUserId } : null;
  },
  async apply(tenantId, id, decision) {
    if (decision !== "approved") return;
    await prisma.creativeBrief.updateMany({ where: { id, tenantId, status: { in: ["angles_ready", "ready"] } }, data: { status: "approved" } });
  },
};

export const campaignApprovalKey = (tenantId: string, campaignId: string) => `approval:ad_campaign:${tenantId}:${campaignId}`;

type CampaignMaterial = { core: string; budgetMinor: number };

/** What a client approves in a campaign: everything but the budget is compared exactly; the budget may only go down afterwards. */
async function campaignMaterial(tenantId: string, id: string): Promise<CampaignMaterial | null> {
  const c = await prisma.adCampaign.findFirst({ where: { id, tenantId }, select: { name: true, objective: true, dailyBudgetMinor: true, currency: true, startsAt: true, endsAt: true } });
  if (!c) return null;
  return { core: digest([c.name, c.objective, c.currency, c.startsAt?.toISOString() ?? null, c.endsAt?.toISOString() ?? null]), budgetMinor: c.dailyBudgetMinor };
}

/**
 * The ad launcher calls this before activating a campaign that went through client approval. Stored in PlatformSetting (no schema
 * change). The approval is bound to the campaign as the client saw it: a changed name, objective, dates or currency, or a daily budget
 * above the approved one (the optimiser can raise budgets), makes it count as not approved until a new approval is sent.
 */
export async function isCampaignClientApproved(tenantId: string, campaignId: string): Promise<boolean> {
  const row = await prisma.platformSetting.findUnique({ where: { key: campaignApprovalKey(tenantId, campaignId) } });
  const v = row?.value as { approved?: boolean; core?: string; budgetMinor?: number } | null;
  if (v?.approved !== true) return false;
  if (v.core === undefined) return true;
  const now = await campaignMaterial(tenantId, campaignId);
  return Boolean(now) && now!.core === v.core && typeof v.budgetMinor === "number" && now!.budgetMinor <= v.budgetMinor;
}

const adCampaign: Handler = {
  async load(tenantId, id) {
    const c = await prisma.adCampaign.findFirst({
      where: { id, tenantId },
      select: { name: true, objective: true, dailyBudgetMinor: true, currency: true, startsAt: true, endsAt: true },
    });
    if (!c) return null;
    return {
      kindLabel: "Ad campaign",
      title: clean(c.name, 200) || "Ad campaign",
      rows: rows([
        ["Objective", c.objective],
        ["Daily budget", money(c.dailyBudgetMinor, c.currency)],
        ["Starts", dayText(c.startsAt)],
        ["Ends", dayText(c.endsAt)],
      ]),
    };
  },
  async fingerprint(tenantId, id) {
    const m = await campaignMaterial(tenantId, id);
    return m ? digest([m.core, m.budgetMinor]) : null;
  },
  async owner(tenantId, id) {
    const c = await prisma.adCampaign.findFirst({ where: { id, tenantId }, select: { createdByUserId: true } });
    return c ? { createdByUserId: c.createdByUserId } : null;
  },
  async apply(tenantId, id, decision, fp) {
    const key = campaignApprovalKey(tenantId, id);
    const m = fp ? await campaignMaterial(tenantId, id) : null;
    const bound = m && digest([m.core, m.budgetMinor]) === fp ? { core: m.core, budgetMinor: m.budgetMinor } : {};
    const value = { approved: decision === "approved" && (!fp || Object.keys(bound).length > 0), decision, at: new Date().toISOString(), ...bound };
    await prisma.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  },
};

const postFingerprint = (p: { body: string; scheduledAt: Date; mediaKeys: string[]; targets?: { assetId: string }[] }) =>
  digest([p.body, p.scheduledAt.toISOString(), p.mediaKeys, (p.targets ?? []).map((t) => t.assetId).sort()]);

const scheduledPost: Handler = {
  async load(tenantId, id) {
    const p = await prisma.scheduledPost.findFirst({ where: { id, tenantId }, select: { body: true, scheduledAt: true, mediaKeys: true } });
    if (!p) return null;
    return {
      kindLabel: "Social post",
      title: "Social post",
      rows: rows([["Scheduled for", dateText(p.scheduledAt)], ["Attachments", p.mediaKeys.length ? String(p.mediaKeys.length) : ""]]),
      text: clean(p.body, 5000) || undefined,
    };
  },
  async fingerprint(tenantId, id) {
    const p = await prisma.scheduledPost.findFirst({ where: { id, tenantId }, select: { body: true, scheduledAt: true, mediaKeys: true, targets: { select: { assetId: true } } } });
    return p ? postFingerprint(p) : null;
  },
  async owner(tenantId, id) {
    const p = await prisma.scheduledPost.findFirst({ where: { id, tenantId }, select: { createdByUserId: true } });
    return p ? { createdByUserId: p.createdByUserId } : null;
  },
  async apply(tenantId, id, decision, fp) {
    if (decision === "approved") {
      const p = await prisma.scheduledPost.findFirst({ where: { id, tenantId, status: "draft" }, select: { body: true, scheduledAt: true, mediaKeys: true, targets: { select: { assetId: true } } } });
      if (!p || (fp && postFingerprint(p) !== fp)) return;
      await prisma.scheduledPost.updateMany({ where: { id, tenantId, status: "draft", body: p.body, scheduledAt: p.scheduledAt }, data: { status: "scheduled" } });
    } else {
      await prisma.scheduledPost.updateMany({ where: { id, tenantId, status: { in: ["draft", "scheduled"] } }, data: { status: "draft" } });
    }
  },
};

export const optimizerApprovalKey = (tenantId: string, proposalId: string) => `approval:optimizer_proposal:${tenantId}:${proposalId}`;

/** The client's decision on an optimiser suggestion. The proposal's own status is never touched here; an admin still applies or rejects it. */
export async function getOptimizerClientDecision(tenantId: string, proposalId: string): Promise<{ decision: string; approved: boolean; at: string } | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: optimizerApprovalKey(tenantId, proposalId) } });
  const v = row?.value as { decision?: string; approved?: boolean; at?: string } | null;
  return v && typeof v.decision === "string" ? { decision: v.decision, approved: v.approved === true, at: String(v.at ?? "") } : null;
}

export type OptimizerClientDecision = { decision: string; approved: boolean; at: string };

/** Client decisions for several proposals at once (one query). Proposals without a recorded decision are absent from the map. */
export async function getOptimizerClientDecisions(tenantId: string, proposalIds: string[]): Promise<Map<string, OptimizerClientDecision>> {
  const out = new Map<string, OptimizerClientDecision>();
  if (proposalIds.length === 0) return out;
  const keys = proposalIds.map((id) => optimizerApprovalKey(tenantId, id));
  const rows = (await prisma.platformSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } })) ?? [];
  for (const row of rows) {
    const v = row.value as { decision?: string; approved?: boolean; at?: string } | null;
    if (!v || typeof v.decision !== "string") continue;
    out.set(row.key.slice(optimizerApprovalKey(tenantId, "").length), { decision: v.decision, approved: v.approved === true, at: String(v.at ?? "") });
  }
  return out;
}

const KIND_LABEL: Record<string, string> = {
  pause_ad: "Pause an ad",
  shift_budget: "Shift budget",
  rotate_creative: "Rotate creative",
  new_angle: "Try a new angle",
};

const optimizerProposal: Handler = {
  async load(tenantId, id) {
    const p = await prisma.optimizerProposal.findFirst({ where: { id, tenantId }, select: { kind: true, rationale: true } });
    if (!p) return null;
    return { kindLabel: "Optimiser suggestion", title: KIND_LABEL[p.kind] ?? "Optimiser suggestion", rows: [], text: clean(p.rationale) || undefined };
  },
  async fingerprint(tenantId, id) {
    const p = await prisma.optimizerProposal.findFirst({ where: { id, tenantId }, select: { kind: true, rationale: true, payload: true } });
    return p ? digest([p.kind, p.rationale, p.payload]) : null;
  },
  async owner(tenantId, id) {
    const p = await prisma.optimizerProposal.findFirst({ where: { id, tenantId }, select: { id: true } });
    return p ? { createdByUserId: null } : null;
  },
  async apply(tenantId, id, decision) {
    const key = optimizerApprovalKey(tenantId, id);
    const value = { decision, approved: decision === "approved", at: new Date().toISOString() };
    await prisma.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  },
};

export const HANDLERS: Record<ApprovalSubject, Handler> = {
  creative_asset: creativeAsset,
  creative_brief: creativeBrief,
  ad_campaign: adCampaign,
  scheduled_post: scheduledPost,
  optimizer_proposal: optimizerProposal,
};

export const SUBJECT_TYPES = Object.keys(HANDLERS) as ApprovalSubject[];
export const isSubjectType = (v: unknown): v is ApprovalSubject => typeof v === "string" && (SUBJECT_TYPES as string[]).includes(v);

/**
 * One-off repair for proposals that an earlier version of the approval handler moved to "approved" without any admin acting on them.
 * Those can never be applied or rejected (only applied or failed may follow approved). A proposal approved by an admin always records
 * decidedByUserId; one with none and no appliedAt is a leftover and goes back to "proposed". Run it once after deploying this change.
 */
export async function repairStuckOptimizerProposals(tenantId?: string, olderThanMs = 10 * 60_000, now = Date.now()): Promise<number> {
  const { count } = await prisma.optimizerProposal.updateMany({
    where: { ...(tenantId ? { tenantId } : {}), status: "approved", decidedByUserId: null, appliedAt: null, createdAt: { lt: new Date(now - olderThanMs) } },
    data: { status: "proposed" },
  });
  return count;
}

const REPAIR_MARKER = "migration:optimizer-stuck-approved:v1";

/**
 * Runs repairStuckOptimizerProposals once per installation. Safe to call as often as you like: it returns 0 straight away once the
 * marker is set, and the repair itself is idempotent (it only touches approved rows nobody decided), so a crash before the marker is
 * written just means the next call repeats it.
 */
export async function repairStuckOptimizerProposalsOnce(): Promise<number> {
  const done = await prisma.platformSetting.findUnique({ where: { key: REPAIR_MARKER } });
  if (done) return 0;
  const repaired = await repairStuckOptimizerProposals();
  const value = { at: new Date().toISOString(), repaired };
  await prisma.platformSetting.upsert({ where: { key: REPAIR_MARKER }, create: { key: REPAIR_MARKER, value }, update: { value } });
  return repaired;
}
