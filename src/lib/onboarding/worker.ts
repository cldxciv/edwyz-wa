import { audit } from "@/lib/auth/audit";
import { PIN_REF_PREFIX } from "@/lib/crypto/tokens";
import { prisma } from "@/lib/db";
import { siteUrl } from "@/lib/config";
import { emailOwners } from "@/lib/lifecycle/state";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import type { WorkerModule } from "@/worker/registry";
import { EXPIRING_DAYS, REJECTED_FLAG_PREFIX, classifyToken, latestTokenRow } from "./token-health";

const BATCH = 500;
/** Notices go out this many days before expiry, and once more when the token has expired. */
export const NOTICE_STAGES = [14, 3, 0] as const;
export type NoticeStage = (typeof NOTICE_STAGES)[number];

/** The smallest stage the token has reached (14, 3 or 0 for expired), or null when it is not close to expiring. */
export function stageFor(expiresAt: Date, now: Date): NoticeStage | null {
  const daysLeft = (expiresAt.getTime() - now.getTime()) / 86_400_000;
  if (daysLeft <= 0) return 0;
  if (daysLeft <= 3) return 3;
  if (daysLeft <= EXPIRING_DAYS) return 14;
  return null;
}

function render(stage: NoticeStage, expiresAt: Date) {
  const link = `${siteUrl()}/app/settings/connect`;
  const when = expiresAt.toISOString().slice(0, 10);
  const expired = stage === 0;
  const subject = expired ? "Reconnect WhatsApp: your connection has expired" : `Reconnect WhatsApp within ${stage} days`;
  const lead = expired
    ? "Your WhatsApp connection has expired, so messages cannot be sent from your workspace until you reconnect."
    : `Your WhatsApp connection expires on ${when}. After that, messages cannot be sent until you reconnect.`;
  const text = `${lead}\n\nReconnecting takes about a minute and keeps your number, templates and chats as they are. Open ${link} and select Connect WhatsApp again.\n\nIncoming messages keep arriving only while the connection is valid, so please do this soon.`;
  const html = `<p>${lead}</p><p>Reconnecting takes about a minute and keeps your number, templates and chats as they are.</p><p><a href="${link}">Reconnect WhatsApp</a></p>`;
  return { subject, text, html };
}

/** Claims the notice. The unique key makes a repeated run, or two worker processes, send each stage once per token. */
async function claimNotice(tokenId: string, stage: NoticeStage): Promise<boolean> {
  try {
    await prisma.platformSetting.create({ data: { key: `wa-token-notice:${tokenId}:${stage}`, value: {} } });
    return true;
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return false;
    throw e;
  }
}

/** Gives the claim back so the next run (every 6 hours) tries again. */
async function releaseNotice(tokenId: string, stage: NoticeStage): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key: `wa-token-notice:${tokenId}:${stage}` } }).catch(() => undefined);
}

/**
 * The claim is kept only when at least one mail was queued. A workspace with no owner who can receive mail, or a queue that refuses
 * the message, gives the claim back so the warning is retried on the next run instead of being lost for this token and stage.
 */
async function notifyOwners(tenantId: string, tokenId: string, stage: NoticeStage, expiresAt: Date): Promise<boolean> {
  if (!(await tenantMayRunBackground(tenantId)) || !(await claimNotice(tokenId, stage))) return false;
  let sent = 0;
  try {
    sent = await emailOwners(tenantId, () => render(stage, expiresAt));
  } catch {
    console.warn("[onboarding] the token notice could not be queued and will be retried");
  }
  if (sent === 0) {
    await releaseNotice(tokenId, stage);
    return false;
  }
  await audit({ tenantId, action: stage === 0 ? "whatsapp.token_expired" : "whatsapp.token_expiring", target: tokenId, meta: { stage, owners: sent } });
  return true;
}

/**
 * Emails the owners of every workspace whose current WhatsApp token is close to its stored expiry (14 days, 3 days, expired),
 * or that Meta refused on a send (error 190). Only each workspace's newest token counts: a reconnect silences the old one.
 * Returns the number of workspaces notified.
 */
export async function checkWhatsAppTokens(now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + EXPIRING_DAYS * 86_400_000);
  const candidates = await prisma.accessToken.findMany({
    where: { expiresAt: { not: null, lt: horizon, gt: new Date(now.getTime() - 30 * 86_400_000) }, OR: [{ wabaRefId: null }, { NOT: { wabaRefId: { startsWith: PIN_REF_PREFIX } } }] },
    orderBy: { expiresAt: "asc" },
    take: BATCH,
    select: { tenantId: true },
  });
  const notified = new Set<string>();
  for (const tenantId of new Set(candidates.map((c) => c.tenantId))) {
    const newest = await latestTokenRow(tenantId);
    const stage = newest?.expiresAt ? stageFor(newest.expiresAt, now) : null;
    if (!newest?.expiresAt || stage === null) continue;
    if (await notifyOwners(tenantId, newest.id, stage, newest.expiresAt)) notified.add(tenantId);
  }
  return notified.size + (await noticeRejected(now, notified));
}

/** A workspace whose token Meta refused is told the same way as one whose token expired, once per token. */
async function noticeRejected(now: Date, already: Set<string>): Promise<number> {
  const flags = await prisma.platformSetting.findMany({ where: { key: { startsWith: REJECTED_FLAG_PREFIX } }, orderBy: { updatedAt: "desc" }, take: BATCH, select: { key: true, updatedAt: true } });
  let count = 0;
  for (const flag of flags) {
    const tenantId = flag.key.slice(REJECTED_FLAG_PREFIX.length);
    if (!tenantId || already.has(tenantId)) continue;
    const newest = await latestTokenRow(tenantId);
    if (!newest || classifyToken(newest, flag.updatedAt, now).state !== "rejected") continue;
    if (await notifyOwners(tenantId, newest.id, 0, flag.updatedAt)) count++;
  }
  return count;
}

export const worker: WorkerModule = {
  queues: {},
  periodic: [{ name: "wa-token-health", everyMs: 6 * 3_600_000, run: () => checkWhatsAppTokens() }],
};
