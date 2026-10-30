import { prisma } from "@/lib/db";
import { queueEmail } from "@/lib/email";
import type { Rendered } from "@/lib/email/templates";

/** Claims a one-time marker. Returns true for exactly one caller, even across concurrent workers (unique key). */
export async function claimOnce(key: string): Promise<boolean> {
  try {
    await prisma.platformSetting.create({ data: { key, value: { at: new Date().toISOString() } } });
    return true;
  } catch {
    return false;
  }
}

/** Gives a claimed marker back so the next sweep tries again (used when the mail it stood for could not be queued). */
export async function releaseClaim(key: string): Promise<void> {
  try {
    await prisma.platformSetting.deleteMany({ where: { key } });
  } catch {
    console.warn("[lifecycle] could not release a notice marker");
  }
}

export async function readState<T>(key: string): Promise<T | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  return (row?.value as T | undefined) ?? null;
}

export async function writeState(key: string, value: object): Promise<void> {
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

/** Active owners of a workspace who can receive mail. */
export async function ownerContacts(tenantId: string): Promise<{ email: string; name: string }[]> {
  const rows = await prisma.membership.findMany({
    where: { tenantId, role: "owner", user: { disabledAt: null } },
    select: { user: { select: { email: true, name: true } } },
    take: 10,
  });
  return rows.map((r) => r.user);
}

/**
 * Queues one mail per active owner and returns how many were queued (0 when the workspace has no owner who can receive mail).
 * Throws when the queue refuses a message, so a caller that keeps a one-time marker can give it back and try again later.
 */
export async function emailOwners(tenantId: string, render: (owner: { name: string }) => Rendered): Promise<number> {
  const owners = await ownerContacts(tenantId);
  for (const o of owners) await queueEmail({ to: o.email, ...render(o) }, { strict: true });
  return owners.length;
}

/**
 * Runs a "send once" step: claims the marker first (so two workers never both mail), then runs the step. When the step queued nothing
 * (no owner to mail) or threw, the marker is released so the notice is retried on the next sweep instead of being lost.
 */
export async function onceWithRetry(key: string, send: () => Promise<number>): Promise<number> {
  if (!(await claimOnce(key))) return 0;
  try {
    const queued = await send();
    if (queued === 0) await releaseClaim(key);
    return queued;
  } catch {
    await releaseClaim(key);
    console.warn("[lifecycle] a notice could not be queued and will be retried");
    return 0;
  }
}
