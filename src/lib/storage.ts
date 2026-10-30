import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";

/**
 * Meta data-deletion requests live in PlatformSetting rows keyed "deletion:<code>" (no schema change).
 * Status stays "received" until the request is completed: automatically by src/lib/lifecycle/deletion-requests.ts once
 * the Meta connections of that Facebook user are erased, or by an admin. Nothing in this file deletes data.
 */
export type DeletionOutcome = { connections: number; workspaces: number };
export type DeletionRecord = {
  code: string;
  userId: string;
  receivedAt: string;
  status: "received" | "completed";
  completedAt?: string;
  outcome?: DeletionOutcome;
  failedAttempts?: number;
};

const PREFIX = "deletion:";
export const CODE_PATTERN = /^[0-9a-f]{18}$/;

export async function recordDeletionRequest(userId: string, now = new Date()): Promise<string> {
  const code = randomBytes(9).toString("hex");
  const record: DeletionRecord = { code, userId, receivedAt: now.toISOString(), status: "received" };
  await prisma.platformSetting.create({ data: { key: `${PREFIX}${code}`, value: record } });
  return code;
}

export async function getDeletionRequest(code: string): Promise<DeletionRecord | null> {
  if (!CODE_PATTERN.test(code)) return null;
  const row = await prisma.platformSetting.findUnique({ where: { key: `${PREFIX}${code}` } });
  return (row?.value as DeletionRecord | undefined) ?? null;
}

export async function listDeletionRequests(limit = 200): Promise<DeletionRecord[]> {
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: PREFIX } }, orderBy: { key: "asc" }, take: limit });
  return rows.map((r) => r.value as DeletionRecord).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

/** Called by the super-admin action once the data has really been erased. Returns false when the code is unknown. */
export async function markDeletionCompleted(code: string, now = new Date()): Promise<boolean> {
  const record = await getDeletionRequest(code);
  if (!record) return false;
  const next: DeletionRecord = { ...record, status: "completed", completedAt: now.toISOString() };
  await prisma.platformSetting.update({ where: { key: `${PREFIX}${code}` }, data: { value: next } });
  return true;
}

/** Completes a request after automatic erasure. The Facebook user id is replaced by a short hash so it is not kept. */
export async function finishDeletionRequest(code: string, outcome: DeletionOutcome, now = new Date()): Promise<boolean> {
  const record = await getDeletionRequest(code);
  if (!record) return false;
  const userId = `erased:${createHash("sha256").update(record.userId).digest("hex").slice(0, 16)}`;
  const next: DeletionRecord = { ...record, userId, status: "completed", completedAt: now.toISOString(), outcome };
  await prisma.platformSetting.update({ where: { key: `${PREFIX}${code}` }, data: { value: next } });
  return true;
}

export async function noteDeletionFailure(code: string): Promise<void> {
  const record = await getDeletionRequest(code);
  if (!record) return;
  const next: DeletionRecord = { ...record, failedAttempts: (record.failedAttempts ?? 0) + 1 };
  await prisma.platformSetting.update({ where: { key: `${PREFIX}${code}` }, data: { value: next } });
}
