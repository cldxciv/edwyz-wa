import { prisma } from "@/lib/db";
import { disconnect } from "@/lib/meta-connect/service";
import { BATCH, chunk, delegateFor, deleteByIds } from "./batch";

/**
 * Decision: when Meta tells us a Facebook user removed the app, we erase what came from that user's Meta connection and
 * leave the rest of the workspace alone. That is the connection row, its assets (Pages, Instagram accounts, ad accounts,
 * datasets, catalogs) with their tokens, and data derived only from those assets: lead forms and leads from its Pages (with
 * their follow-up runs and conversion events), contacts created only by those leads, campaigns, ad sets, ads, ad performance
 * snapshots and optimizer proposals for its ad accounts, and post targets for its assets. WhatsApp contacts, conversations,
 * messages, billing and team members belong to the business, not to the Facebook user, and stay. An asset is unique per
 * workspace (tenantId, type, externalId), so everything keyed by an asset id came solely from one connection.
 */

export type MetaErasureCounts = Record<string, number>;

const add = (counts: MetaErasureCounts, key: string, n: number) => void (counts[key] = (counts[key] ?? 0) + n);

async function eraseLeads(tenantId: string, pageIds: string[], counts: MetaErasureCounts): Promise<void> {
  if (pageIds.length === 0) return;
  const forms = await prisma.leadForm.findMany({ where: { tenantId, pageAssetId: { in: pageIds } }, select: { id: true } });
  const formIds = forms.map((f) => f.id);
  if (formIds.length === 0) return;

  const contactIds = new Set<string>();
  for (;;) {
    const leads = await prisma.lead.findMany({ where: { tenantId, leadFormId: { in: formIds } }, select: { id: true, contactId: true }, take: BATCH });
    if (leads.length === 0) break;
    const ids = leads.map((l) => l.id);
    for (const l of leads) if (l.contactId) contactIds.add(l.contactId);
    add(counts, "LeadSequenceRun", (await prisma.leadSequenceRun.deleteMany({ where: { tenantId, leadId: { in: ids } } })).count);
    add(counts, "ConversionEvent", (await prisma.conversionEvent.deleteMany({ where: { tenantId, leadId: { in: ids } } })).count);
    const { count } = await prisma.lead.deleteMany({ where: { tenantId, id: { in: ids } } });
    add(counts, "Lead", count);
    if (count === 0) break;
  }

  for (const part of chunk([...contactIds])) {
    const candidates = await prisma.contact.findMany({
      where: { tenantId, id: { in: part }, optInSource: "lead_form", conversations: { none: {} }, broadcastRecipients: { none: {} } },
      select: { id: true },
    });
    if (candidates.length) add(counts, "Contact", (await prisma.contact.deleteMany({ where: { tenantId, id: { in: candidates.map((c) => c.id) } } })).count);
  }
  add(counts, "LeadForm", (await prisma.leadForm.deleteMany({ where: { tenantId, id: { in: formIds } } })).count);
}

async function eraseAdData(tenantId: string, adAccountIds: string[], counts: MetaErasureCounts): Promise<void> {
  if (adAccountIds.length === 0) return;
  for (;;) {
    const campaigns = await prisma.adCampaign.findMany({ where: { tenantId, adAccountAssetId: { in: adAccountIds } }, select: { id: true, metaCampaignId: true }, take: BATCH });
    if (campaigns.length === 0) break;
    const campaignIds = campaigns.map((c) => c.id);
    const adSets = await prisma.adSet.findMany({ where: { tenantId, campaignId: { in: campaignIds } }, select: { id: true, metaAdSetId: true } });
    const adSetIds = adSets.map((s) => s.id);
    const ads = adSetIds.length ? await prisma.ad.findMany({ where: { tenantId, adSetId: { in: adSetIds } }, select: { id: true, metaAdId: true } }) : [];

    const metaIds = [...campaigns.map((c) => c.metaCampaignId), ...adSets.map((s) => s.metaAdSetId), ...ads.map((a) => a.metaAdId)].filter((v): v is string => !!v);
    add(counts, "InsightSnapshot", await deleteByIds("InsightSnapshot", { tenantId }, "entityMetaId", metaIds));
    add(counts, "OptimizerProposal", await deleteByIds("OptimizerProposal", { tenantId }, "targetMetaId", metaIds));
    add(counts, "ApprovalRequest", await deleteByIds("ApprovalRequest", { tenantId, subjectType: "ad_campaign" }, "subjectId", campaignIds));
    add(counts, "PlatformSetting", await deleteByIds("PlatformSetting", {}, "key", campaignIds.map((id) => `approval:ad_campaign:${tenantId}:${id}`), "key"));
    add(counts, "Ad", await deleteByIds("Ad", { tenantId }, "adSetId", adSetIds));
    add(counts, "AdSet", (await prisma.adSet.deleteMany({ where: { tenantId, id: { in: adSetIds } } })).count);
    const { count } = await prisma.adCampaign.deleteMany({ where: { tenantId, id: { in: campaignIds } } });
    add(counts, "AdCampaign", count);
    if (count === 0) break;
  }
}

/** Erases one Meta connection of one workspace and the data derived solely from it. Other connections and other workspaces are untouched. */
export async function eraseMetaConnectionData(tenantId: string, connectionId: string): Promise<MetaErasureCounts> {
  const counts: MetaErasureCounts = {};
  const connection = await prisma.metaConnection.findFirst({ where: { id: connectionId, tenantId }, select: { id: true, status: true } });
  if (!connection) return counts;

  if (connection.status !== "revoked") {
    try {
      await disconnect({ userId: "system", tenantId, role: "owner" }, connection.id);
    } catch {
      counts.revokeFailed = 1;
    }
  }

  const assets = await prisma.metaAsset.findMany({ where: { tenantId, connectionId: connection.id }, select: { id: true, type: true, externalId: true } });
  const ids = (type?: string) => assets.filter((a) => !type || a.type === type).map((a) => a.id);

  await eraseLeads(tenantId, ids("page"), counts);
  await eraseAdData(tenantId, ids("ad_account"), counts);
  add(counts, "PostTarget", await deleteByIds("PostTarget", { tenantId }, "assetId", ids()));
  const datasetExternalIds = assets.filter((a) => a.type === "dataset").map((a) => a.externalId);
  add(counts, "ConversionEvent", await deleteByIds("ConversionEvent", { tenantId }, "datasetId", datasetExternalIds));

  await delegateFor("MetaAsset").updateMany({ where: { tenantId, connectionId: connection.id }, data: { tokenEnc: null } });
  add(counts, "MetaAsset", (await prisma.metaAsset.deleteMany({ where: { tenantId, connectionId: connection.id } })).count);
  await prisma.metaConnection.updateMany({ where: { id: connection.id, tenantId }, data: { tokenEnc: "" } });
  add(counts, "MetaConnection", (await prisma.metaConnection.deleteMany({ where: { id: connection.id, tenantId } })).count);
  return counts;
}

export type MetaUserErasure = { connections: number; workspaces: number; counts: MetaErasureCounts };

/** Finds every workspace connection made by this Facebook user id and erases each one. A user id nobody connected matches nothing. */
export async function eraseMetaUserData(metaUserId: string): Promise<MetaUserErasure> {
  const connections = await findConnections(metaUserId);
  const counts: MetaErasureCounts = {};
  for (const c of connections) {
    const one = await eraseMetaConnectionData(c.tenantId, c.id);
    for (const [k, v] of Object.entries(one)) add(counts, k, v);
  }
  return { connections: connections.length, workspaces: new Set(connections.map((c) => c.tenantId)).size, counts };
}

async function findConnections(metaUserId: string): Promise<{ id: string; tenantId: string }[]> {
  return prisma.metaConnection.findMany({ where: { metaUserId }, select: { id: true, tenantId: true }, take: 500 });
}
