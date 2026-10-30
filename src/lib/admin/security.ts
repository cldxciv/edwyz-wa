import { audit } from "@/lib/auth/audit";
import { decrypt, encrypt } from "@/lib/crypto/tokens";
import { prisma } from "@/lib/db";
import { createLimiter } from "@/lib/ratelimit";
import { HttpError } from "@/lib/tenancy";
import { consumeRecoveryHash, generateRecoveryCodes, generateSecret, otpauthUri, verifyTotp } from "./totp";

const attemptLimiter = createLimiter(5, 15 * 60 * 1000, "admin-totp");
export const resetAttemptLimiter = () => attemptLimiter.clear();

const lastStepKey = (userId: string) => `totp-last:${userId}`;

async function getLastStep(userId: string): Promise<number | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: lastStepKey(userId) } });
  const v = (row?.value as { step?: number } | null)?.step;
  return typeof v === "number" ? v : null;
}

async function setLastStep(userId: string, step: number) {
  await prisma.platformSetting.upsert({ where: { key: lastStepKey(userId) }, create: { key: lastStepKey(userId), value: { step } }, update: { value: { step } } });
}

async function loadSecret(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { totpCiphertext: true, totpIv: true, totpTag: true } });
  if (!u?.totpCiphertext || !u.totpIv || !u.totpTag) return null;
  return decrypt({ ciphertext: u.totpCiphertext, iv: u.totpIv, authTag: u.totpTag });
}

async function takeAttempt(userId: string) {
  if (!(await attemptLimiter.consumeShared(userId))) throw new HttpError(429, "Too many attempts. Wait 15 minutes and try again.");
}

export async function startEnrollment(userId: string, email: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } });
  if (user?.totpEnabledAt) throw new HttpError(409, "Two-factor authentication is already enabled.");
  const secret = generateSecret();
  const enc = encrypt(secret);
  await prisma.user.update({ where: { id: userId }, data: { totpCiphertext: enc.ciphertext, totpIv: enc.iv, totpTag: enc.authTag } });
  await audit({ userId, action: "admin.totp.enroll_start" });
  return { secret, uri: otpauthUri(secret, email) };
}

export async function confirmEnrollment(userId: string, code: string, now = Date.now()) {
  await takeAttempt(userId);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } });
  if (user?.totpEnabledAt) throw new HttpError(409, "Two-factor authentication is already enabled.");
  const secret = await loadSecret(userId);
  const step = secret ? verifyTotp(secret, code, now) : null;
  if (step === null) {
    await audit({ userId, action: "admin.totp.enroll_failed" });
    throw new HttpError(400, "That code is not correct. Check the time on your phone and try again.");
  }
  const { codes, hashes } = generateRecoveryCodes();
  await prisma.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date(now), totpRecoveryHashes: hashes } });
  await setLastStep(userId, step);
  await audit({ userId, action: "admin.totp.enrolled" });
  return { recoveryCodes: codes };
}

/** Verifies a TOTP code (or a single-use recovery code). Returns true on success; the caller sets the cookie. */
export async function verifyStepUpCode(userId: string, input: { code?: string; recoveryCode?: string }, now = Date.now()): Promise<void> {
  await takeAttempt(userId);
  const fail = async (how: string): Promise<never> => {
    await audit({ userId, action: "admin.stepup.failed", meta: { how } });
    throw new HttpError(400, "That code is not correct.");
  };

  if (input.recoveryCode) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { totpRecoveryHashes: true } });
    const remaining = consumeRecoveryHash(user?.totpRecoveryHashes ?? [], input.recoveryCode);
    if (!user || !remaining) return fail("recovery");
    const res = await prisma.user.updateMany({ where: { id: userId, totpRecoveryHashes: { equals: user.totpRecoveryHashes } }, data: { totpRecoveryHashes: remaining } });
    if (res.count !== 1) return fail("recovery");
    await audit({ userId, action: "admin.stepup.recovery_used", meta: { remaining: remaining.length } });
    return;
  }

  const secret = await loadSecret(userId);
  const step = secret && input.code ? verifyTotp(secret, input.code, now, await getLastStep(userId)) : null;
  if (step === null) return fail("totp");
  await setLastStep(userId, step);
  await audit({ userId, action: "admin.stepup.ok" });
}
