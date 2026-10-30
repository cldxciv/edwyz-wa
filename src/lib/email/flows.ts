import { hashToken, newOpaqueToken } from "@/lib/auth/tokens";
import { siteUrl } from "@/lib/config";
import { prisma } from "@/lib/db";
import { queueEmail } from "./index";
import { passwordResetTemplate, verifyEmailTemplate } from "./templates";
import { createEmailToken } from "./tokens";

export async function sendVerificationEmail(user: { id: string; email: string; name: string }): Promise<void> {
  const token = await createEmailToken(user.id, "verify");
  await queueEmail({ to: user.email, ...verifyEmailTemplate({ name: user.name, link: `${siteUrl()}/verify-email?token=${token}` }) }, { seal: true });
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
