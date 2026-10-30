import { getBillingStatus } from "@/lib/billing";
import { prisma } from "@/lib/db";
import type { SetupFacts } from "./checklist";

const SENT = ["sent", "delivered", "read"] as const;

/** Every query filters on tenantId. Counts only; no contact or message content is read. */
export async function gatherFacts(tenantId: string, now = new Date()): Promise<SetupFacts> {
  const [tenant, templateGroups, contacts, optedIn, startedBroadcasts, members, pendingInvites, routing, chatbots, agents, connections, billing] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { onboardingStatus: true } }),
    prisma.template.groupBy({ by: ["status"], where: { tenantId }, _count: { _all: true } }),
    prisma.contact.count({ where: { tenantId } }),
    prisma.contact.count({ where: { tenantId, optIn: true, optedOutAt: null } }),
    prisma.broadcast.count({ where: { tenantId, status: { not: "draft" } } }),
    prisma.membership.count({ where: { tenantId } }),
    prisma.invite.count({ where: { tenantId, acceptedAt: null, expiresAt: { gt: now } } }),
    prisma.routingConfig.findUnique({ where: { tenantId }, select: { autoAssign: true } }),
    prisma.chatbot.count({ where: { tenantId, status: "published" } }),
    prisma.aiAgent.count({ where: { tenantId, enabled: true } }),
    prisma.metaConnection.count({ where: { tenantId, status: { in: ["active", "expiring"] } } }),
    getBillingStatus(tenantId),
  ]);
  const live = tenant?.onboardingStatus === "live";
  const byStatus = (status: string) => templateGroups.find((g) => g.status === status)?._count._all ?? 0;

  const needsSentCheck = live && startedBroadcasts === 0;
  const sent = needsSentCheck
    ? await prisma.message.findFirst({ where: { tenantId, direction: "outbound", templateName: { not: null }, status: { in: [...SENT] } }, select: { id: true } })
    : null;

  return {
    onboardingLive: live,
    approvedTemplates: byStatus("approved"),
    pendingTemplates: byStatus("pending"),
    rejectedTemplates: byStatus("rejected"),
    contacts,
    optedInContacts: optedIn,
    startedBroadcasts,
    sentTemplateMessages: sent ? 1 : 0,
    members,
    pendingInvites,
    autoAssign: routing?.autoAssign ?? false,
    publishedChatbots: chatbots,
    enabledAiAgents: agents,
    metaConnections: connections,
    billing: { state: billing.state, daysLeftInTrial: billing.daysLeftInTrial, planName: billing.planName },
  };
}
