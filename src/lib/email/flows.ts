import { hashToken, newOpaqueToken } from "@/lib/auth/tokens";
import { siteUrl } from "@/lib/config";
import { prisma } from "@/lib/db";
import { queueEmail } from "./index";
import { passwordChangedTemplate, passwordResetTemplate, verifyEmailTemplate } from "./templates";
import { createEmailToken } from "./tokens";

/** A fresh link (earlier unused verify links stop working), with the body sealed in the queue because it carries the one-time link. */
export async function sendVerificationEmail(user: { id: string; email: string; name: string }): Promise<void> {
  const token = await createEmailToken(user.id, "verify");
  await queueEmail({ to: user.email, ...verifyEmailTemplate({ name: user.name, link: `${siteUrl()}/verify-email?token=${token}` }) }, { seal: true });
}

/** Tells the account holder their password changed, so a change they did not make does not go unnoticed. Carries no link. */
export async function sendPasswordChangedEmail(user: { email: string; name: string }): Promise<void> {
  await queueEmail({ to: user.email, ...passwordChangedTemplate({ name: user.name }) });
}

/**
 * Runs after the generic response has been sent. Unknown emails do an equivalent amount of token and database work
 * so neither the response nor its timing tells an attacker whether the account exists.
 */
export async function processPasswordResetRequest(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, name: true, disabledAt: true } });
  if (user && !user.disabledAt) {
    const token = await createEmailToken(user.id, "reset");
    await queueEmail({ to: user.email, ...passwordResetTemplate({ name: user.name, link: `${siteUrl()}/reset-password?token=${token}` }) }, { seal: true });
    return;
  }
  const decoy = hashToken(newOpaqueToken());
  await prisma.emailToken.findUnique({ where: { tokenHash: decoy } });
  await prisma.emailToken.updateMany({ where: { tokenHash: decoy }, data: { usedAt: new Date() } });
  await prisma.job.count({ where: { queue: "email", status: "queued" } });
}
