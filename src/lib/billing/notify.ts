import { siteUrl } from "@/lib/config";
import { prisma } from "@/lib/db";
import { queueEmail } from "@/lib/email";
import { paymentReceivedTemplate } from "@/lib/email/templates";
import { ownerContacts } from "@/lib/lifecycle/state";

/**
 * Sends the payment receipt with a link to the invoice: to the billing email when the workspace set one, plus the owners.
 * Never throws; a mail problem must not fail the payment webhook.
 */
export async function sendPaymentReceived(input: { tenantId: string; invoiceId: string; amountPaise: number }): Promise<number> {
  try {
    const [tenant, profile, owners] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { name: true } }),
      prisma.billingProfile.findUnique({ where: { tenantId: input.tenantId }, select: { billingEmail: true } }),
      ownerContacts(input.tenantId),
    ]);
    const recipients = new Set<string>();
    if (profile?.billingEmail) recipients.add(profile.billingEmail.toLowerCase());
    for (const o of owners) recipients.add(o.email.toLowerCase());
    const mail = paymentReceivedTemplate({
      workspaceName: tenant?.name ?? "your workspace",
      amountPaise: input.amountPaise,
      invoiceUrl: `${siteUrl()}/app/billing/invoices/${input.invoiceId}`,
    });
    for (const to of recipients) await queueEmail({ to, ...mail });
    return recipients.size;
  } catch {
    console.warn("[billing] could not queue the payment receipt");
    return 0;
  }
}
