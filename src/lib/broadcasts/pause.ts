import { prisma } from "@/lib/db";
import { PAUSE_REASONS, type PauseReasonCode } from "./pause-copy";

export { PAUSE_COPY, PAUSE_REASONS } from "./pause-copy";
export type { PauseReasonCode } from "./pause-copy";

/** Why the system (not a person) paused a broadcast. There is no column for it, so it lives in a PlatformSetting row. */
export const pauseReasonKey = (broadcastId: string) => `broadcast.pause_reason.${broadcastId}`;

export type PauseReason = { reason: PauseReasonCode; at: string };

export async function storePauseReason(broadcastId: string, reason: PauseReasonCode, at = new Date()): Promise<void> {
  const value = { reason, at: at.toISOString() };
  try {
    await prisma.platformSetting.upsert({ where: { key: pauseReasonKey(broadcastId) }, create: { key: pauseReasonKey(broadcastId), value }, update: { value } });
  } catch {
    console.error("[broadcast] could not store the pause reason");
  }
}

export async function clearPauseReason(broadcastId: string): Promise<void> {
  try {
    await prisma.platformSetting.deleteMany({ where: { key: pauseReasonKey(broadcastId) } });
  } catch {
    /* the reason is informational */
  }
}

export async function readPauseReason(broadcastId: string): Promise<PauseReason | null> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: pauseReasonKey(broadcastId) } });
    const v = row?.value as { reason?: unknown; at?: unknown } | null | undefined;
    if (v && typeof v.reason === "string" && (PAUSE_REASONS as readonly string[]).includes(v.reason)) return { reason: v.reason as PauseReasonCode, at: typeof v.at === "string" ? v.at : "" };
  } catch {
    /* no reason to show */
  }
  return null;
}

