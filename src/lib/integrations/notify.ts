import { COMPANY, siteUrl } from "@/lib/config";
import { prisma } from "@/lib/db";
import { escapeHtml, type Rendered } from "@/lib/email/templates";
import { claimOnce, emailOwners } from "@/lib/lifecycle/state";

const DAY_MS = 86_400_000;

/** The host only: the path and query of a webhook url can carry a secret. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "your endpoint";
  }
}

export function webhookDisabledMail(p: { workspaceName: string; host: string; failures: number }): Rendered {
  const link = `${siteUrl()}/app/settings/api`;
  const lines = [
    `We stopped sending webhook events to ${p.host} for "${p.workspaceName}" because ${p.failures} deliveries in a row failed.`,
    "Events that happen while it is switched off are not sent later. Fix the receiving server, then switch the endpoint back on from the API settings page.",
  ];
  const footer = `${COMPANY.legalName}. Questions: ${COMPANY.email}`;
  return {
    subject: "A webhook endpoint was switched off",
    text: ["Hello,", "", ...lines, "", `Open API settings: ${link}`, "", "--", footer].join("\n"),
    html: `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111"><p>Hello,</p>${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}<p><a href="${escapeHtml(link)}">Open API settings</a></p><hr><p style="color:#555;font-size:12px">${escapeHtml(footer)}</p></body></html>`,
  };
}

/** Tells the workspace owners once a day per endpoint. Never throws: a mail problem must not undo the delivery bookkeeping. */
export async function notifyEndpointDisabled(input: { tenantId: string; endpointId: string; url: string; failures: number }, now = Date.now()): Promise<number> {
  try {
    if (!(await claimOnce(`integrations:disabled:${input.endpointId}:${Math.floor(now / DAY_MS)}`))) return 0;
    const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { name: true } });
    return await emailOwners(input.tenantId, () => webhookDisabledMail({ workspaceName: tenant?.name ?? "your workspace", host: hostOf(input.url), failures: input.failures }));
  } catch {
    console.error("[integrations] could not queue the endpoint-disabled notice");
    return 0;
  }
}
