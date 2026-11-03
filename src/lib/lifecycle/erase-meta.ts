import { deleteMedia } from "@/lib/content/media";
import { prisma } from "@/lib/db";
import { disconnect } from "@/lib/meta-connect/service";
import { forgetContact, queueAdAccountAudienceDeletes } from "@/lib/promote/forget";
import { BATCH, chunk, delegateFor, deleteByIds } from "./batch";

/**
 * Decision: when Meta tells us a Facebook user removed the app, we erase what came from that user's Meta connection and
 * leave the rest of the workspace alone. That is the connection row, its assets (Pages, Instagram accounts, ad accounts,
 * datasets, catalogs) with their tokens, and data derived only from those assets: lead forms and leads from its Pages (with
 * their follow-up runs and conversion events), contacts created only by those leads, campaigns, ad sets, ads, version
 * comparisons, ad performance snapshots and breakdowns and optimizer proposals for its ad accounts, the ad media and audiences
 * of its ad accounts (their customer-list audiences are deleted on Meta first, best effort), and post targets for its assets.
 * WhatsApp contacts, conversations, messages, billing and team members belong to the business, not to the Facebook user, and
 * stay. An asset is unique per workspace (tenantId, type, externalId), so everything keyed by an asset id came solely from one
 * connection.
 */

/** AdMedia sources whose file Edwyz made only for ads (a copy of Instagram media, a crop). Library uploads and generated creatives keep their file. */
const ADS_ONLY_FILE_SOURCES: readonly string[] = ["ig_copy", "crop"];

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
    if (candidates.length === 0) continue;
    // Out of the workspace's customer-list audiences on Meta first, while the email and phone can still be read (IG-PAGE-ADS-SPEC 5.5).
    for (const c of candidates) await forgetContact(tenantId, c.id);
    add(counts, "Contact", (await prisma.contact.deleteMany({ where: { tenantId, id: { in: candidates.map((c) => c.id) } } })).count);
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
    add(counts, "InsightBreakdown", await deleteByIds("InsightBreakdown", { tenantId }, "entityMetaId", metaIds));
    add(counts, "OptimizerProposal", await deleteByIds("OptimizerProposal", { tenantId }, "targetMetaId", metaIds));
    add(counts, "ApprovalRequest", await deleteByIds("ApprovalRequest", { tenantId, subjectType: "ad_campaign" }, "subjectId", campaignIds));
    add(counts, "PlatformSetting", await deleteByIds("PlatformSetting", {}, "key", campaignIds.map((id) => `approval:ad_campaign:${tenantId}:${id}`), "key"));
    add(counts, "AdTest", await deleteByIds("AdTest", { tenantId }, "campaignId", campaignIds));
    add(counts, "Ad", await deleteByIds("Ad", { tenantId }, "adSetId", adSetIds));
    add(counts, "AdSet", (await prisma.adSet.deleteMany({ where: { tenantId, id: { in: adSetIds } } })).count);
    const { count } = await prisma.adCampaign.deleteMany({ where: { tenantId, id: { in: campaignIds } } });
    add(counts, "AdCampaign", count);
    if (count === 0) break;
  }
  await eraseAdAccountMediaAndAudiences(tenantId, adAccountIds, counts);
}

/**
 * The ad media and audiences of the erased ad accounts (docs/IG-PAGE-ADS-SPEC.md 5.5). Every AdMedia row goes; a file goes only
 * when Edwyz made it for ads (ADS_ONLY_FILE_SOURCES) and no other AdMedia row of the workspace still names it, through the content
 * store's own path checks. The audiences go with their upload records (their customer lists were deleted on Meta before the
 * connection was revoked, see deleteAccountAudiencesOnMeta).
 */
async function eraseAdAccountMediaAndAudiences(tenantId: string, adAccountIds: string[], counts: MetaErasureCounts): Promise<void> {
  const media = await prisma.adMedia.findMany({ where: { tenantId, adAccountAssetId: { in: adAccountIds } }, select: { source: true, sourceKey: true } });
  add(counts, "AdMedia", await deleteByIds("AdMedia", { tenantId }, "adAccountAssetId", adAccountIds));
  for (const key of new Set(media.filter((m) => ADS_ONLY_FILE_SOURCES.includes(m.source)).map((m) => m.sourceKey))) {
    if ((await prisma.adMedia.count({ where: { tenantId, sourceKey: key, source: { not: "creative" } } })) > 0) continue;
    if (await deleteMedia(tenantId, key).catch(() => false)) add(counts, "AdMediaFile", 1);
  }
  const audienceIds = (await prisma.adAudience.findMany({ where: { tenantId, adAccountAssetId: { in: adAccountIds } }, select: { id: true } })).map((a) => a.id);
  add(counts, "AdAudienceUpload", await deleteByIds("AdAudienceUpload", { tenantId }, "audienceId", audienceIds));
  add(counts, "AdAudience", await deleteByIds("AdAudience", { tenantId }, "id", audienceIds));
}

/**
 * Deletes the customer-list audiences of the connection's ad accounts on Meta (promote/forget.ts), while the connection's token
 * still works. Best effort: a failure is counted and never stops the erasure.
 */
async function deleteAccountAudiencesOnMeta(tenantId: string, adAccountIds: string[], counts: MetaErasureCounts): Promise<void> {
  if (adAccountIds.length === 0) return;
  try {
    const out = await queueAdAccountAudienceDeletes(tenantId, adAccountIds);
    if (out.queued) add(counts, "metaAudiencesDeleted", out.queued);
    if (out.failed) add(counts, "metaAudienceDeletesFailed", out.failed);
  } catch {
    add(counts, "metaAudienceDeletesFailed", 1);
  }
}

/** Erases one Meta connection of one workspace and the data derived solely from it. Other connections and other workspaces are untouched. */
export async function eraseMetaConnectionData(tenantId: string, connectionId: string): Promise<MetaErasureCounts> {
  const counts: MetaErasureCounts = {};
  const connection = await prisma.metaConnection.findFirst({ where: { id: connectionId, tenantId }, select: { id: true, status: true } });
  if (!connection) return counts;

  // Customer-list audiences of its ad accounts on Meta first, while the token still works and before their rows go (5.5).
  const adAccounts = await prisma.metaAsset.findMany({ where: { tenantId, connectionId: connection.id, type: "ad_account" }, select: { id: true } });
  await deleteAccountAudiencesOnMeta(tenantId, adAccounts.map((a) => a.id), counts);

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
