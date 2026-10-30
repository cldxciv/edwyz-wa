import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/platform-settings";
import { HttpError } from "@/lib/tenancy";
import { getBillingStatus } from "./status";

/** Throws HttpError(402) when the workspace is locked and HttpError(403) when it is suspended. */
export async function assertTenantCanWrite(tenantId: string): Promise<void> {
  const status = await getBillingStatus(tenantId);
  if (status.state === "suspended") throw new HttpError(403, status.reason ?? "This workspace has been suspended.");
  if (status.state === "locked") {
    throw new HttpError(402, `${status.reason ?? "Your subscription is inactive."} Your data is read-only until you subscribe at /app/billing.`);
  }
}

/** Sets trialEndsAt for a new workspace from the platform's trial length. Does nothing if a trial was already started. */
export async function startTrial(tenantId: string): Promise<void> {
  const { trialDays } = await getSettings();
  const trialEndsAt = new Date(Date.now() + trialDays * 86_400_000);
  await prisma.tenant.updateMany({ where: { id: tenantId, trialEndsAt: null }, data: { trialEndsAt } });
}
