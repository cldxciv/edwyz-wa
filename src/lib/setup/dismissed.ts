import { prisma } from "@/lib/db";
import { parseDismissed, STEP_IDS, type StepId } from "./checklist";

export const dismissedKey = (tenantId: string) => `setup:${tenantId}:dismissed`;

export async function getDismissed(tenantId: string): Promise<StepId[]> {
  const row = await prisma.platformSetting.findUnique({ where: { key: dismissedKey(tenantId) } }).catch(() => null);
  return parseDismissed(row?.value);
}

/** Adds or removes one step from the workspace's "not now" list and returns the new list. */
export async function setDismissed(tenantId: string, stepId: StepId, dismissed: boolean): Promise<StepId[]> {
  const current = await getDismissed(tenantId);
  const next = STEP_IDS.filter((id) => (id === stepId ? dismissed : current.includes(id)));
  const key = dismissedKey(tenantId);
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value: next }, update: { value: next } });
  return next;
}
