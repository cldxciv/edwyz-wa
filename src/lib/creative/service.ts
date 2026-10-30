import { createApproval } from "@/lib/approvals";
import { reserveCredits } from "@/lib/billing/limits";
import { prisma } from "@/lib/db";
import { CREDIT_COST, recordUsage } from "@/lib/usage";
import { HttpError } from "@/lib/tenancy";
import { COPY_LIMITS, GOALS, PLACEMENTS, SPECIAL_CATEGORIES, suggestSpecialAdCategory, type Placement } from "./constants";
import { fetchSiteText } from "./site";
import { generateJson, INJECTION_GUARD, untrusted, type Ask } from "./llm";
import { parseAngles, parseCopy, parseResearch } from "./schemas";
import { checkPolicy } from "./policy";
import { getImageProvider, getVideoProvider } from "./providers";
import { getStorage } from "./storage";
import type { Prisma } from "@/generated/prisma/client";

const HEX = /^#[0-9a-fA-F]{6}$/;

export type BrandInput = {
  name?: string;
  websiteUrl?: string | null;
  logoUrl?: string | null;
  colors?: string[];
  fonts?: string[];
  tone?: string | null;
  bannedWords?: string[];
  industry?: string | null;
  specialAdCategory?: string;
};

function cleanList(v: unknown, label: string, maxItems: number, maxLen: number, pattern?: RegExp): string[] {
  if (!Array.isArray(v)) throw new HttpError(400, `${label} must be a list.`);
  if (v.length > maxItems) throw new HttpError(400, `${label} has too many entries.`);
  return v.map((x) => {
    if (typeof x !== "string" || x.trim().length === 0 || x.length > maxLen || (pattern && !pattern.test(x.trim()))) throw new HttpError(400, `${label} contains an invalid entry.`);
    return x.trim();
  });
}

function cleanUrl(v: unknown, label: string): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 2048) throw new HttpError(400, `${label} is not valid.`);
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new HttpError(400, `${label} is not valid.`);
  }
  if (u.protocol !== "https:" || u.username || u.password) throw new HttpError(400, `${label} must be an https URL.`);
  return u.href;
}

function cleanText(v: unknown, label: string, max: number): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max) throw new HttpError(400, `${label} is not valid.`);
  return v.trim();
}

export function validateBrand(input: Record<string, unknown>, partial: boolean): Prisma.BrandUncheckedUpdateInput {
  const out: Prisma.BrandUncheckedUpdateInput = {};
  if (input.name !== undefined || !partial) {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120) throw new HttpError(400, "A brand name is required.");
    out.name = input.name.trim();
  }
  if (input.websiteUrl !== undefined) out.websiteUrl = cleanUrl(input.websiteUrl, "Website");
  if (input.logoUrl !== undefined) out.logoUrl = cleanUrl(input.logoUrl, "Logo URL");
  if (input.colors !== undefined) out.colors = cleanList(input.colors, "Colours", 8, 7, HEX);
  if (input.fonts !== undefined) out.fonts = cleanList(input.fonts, "Fonts", 5, 60);
  if (input.bannedWords !== undefined) out.bannedWords = cleanList(input.bannedWords, "Banned words", 100, 60);
  if (input.tone !== undefined) out.tone = cleanText(input.tone, "Tone", 500);
  if (input.industry !== undefined) out.industry = cleanText(input.industry, "Industry", 120);
  if (input.specialAdCategory !== undefined) {
    if (typeof input.specialAdCategory !== "string" || !(SPECIAL_CATEGORIES as readonly string[]).includes(input.specialAdCategory)) throw new HttpError(400, "Unknown special ad category.");
    out.specialAdCategory = input.specialAdCategory;
  }
  return out;
}

export const withSuggestion = <T extends { industry: string | null }>(brand: T) => ({ ...brand, suggestedSpecialAdCategory: suggestSpecialAdCategory(brand.industry) });

export async function listBrands(tenantId: string) {
  const rows = await prisma.brand.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 200 });
  return rows.map(withSuggestion);
}

export async function getBrand(tenantId: string, id: string) {
  const brand = await prisma.brand.findFirst({ where: { id, tenantId } });
  if (!brand) throw new HttpError(404, "Brand not found.");
  return brand;
}

export async function createBrand(tenantId: string, input: Record<string, unknown>) {
  const data = validateBrand(input, false);
  if (input.specialAdCategory === undefined) data.specialAdCategory = suggestSpecialAdCategory(data.industry as string | null | undefined);
  const brand = await prisma.brand.create({ data: { ...(data as Prisma.BrandUncheckedCreateInput), tenantId } });
  return withSuggestion(brand);
}

export async function updateBrand(tenantId: string, id: string, input: Record<string, unknown>) {
  await getBrand(tenantId, id);
  const data = validateBrand(input, true);
  const res = await prisma.brand.updateMany({ where: { id, tenantId }, data });
  if (res.count === 0) throw new HttpError(404, "Brand not found.");
  return withSuggestion(await getBrand(tenantId, id));
}

export async function deleteBrand(tenantId: string, id: string): Promise<void> {
  await getBrand(tenantId, id);
  const assets = await prisma.creativeAsset.findMany({ where: { tenantId, brief: { brandId: id }, storageKey: { not: null } }, select: { storageKey: true } });
  for (const a of assets) await getStorage().remove(tenantId, a.storageKey!).catch(() => undefined);
  await prisma.brand.deleteMany({ where: { id, tenantId } });
}

export async function createBrief(tenantId: string, userId: string, input: Record<string, unknown>) {
  const brand = await getBrand(tenantId, String(input.brandId ?? ""));
  if (typeof input.goal !== "string" || !(GOALS as readonly string[]).includes(input.goal)) throw new HttpError(400, "Choose a goal.");
  if (typeof input.offer !== "string" || !input.offer.trim() || input.offer.length > 1000) throw new HttpError(400, "Describe the offer in 1000 characters or fewer.");
  const notes = cleanText(input.competitorNotes ?? null, "Competitor notes", 3000);
  return prisma.creativeBrief.create({
    data: { tenantId, brandId: brand.id, goal: input.goal, offer: input.offer.trim(), createdByUserId: userId, researchSummary: notes ? { competitorNotes: notes } : undefined },
  });
}

export async function getBrief(tenantId: string, id: string) {
  const brief = await prisma.creativeBrief.findFirst({ where: { id, tenantId }, include: { brand: true, angles: { orderBy: { id: "asc" } }, assets: { orderBy: { createdAt: "asc" } } } });
  if (!brief) throw new HttpError(404, "Brief not found.");
  return brief;
}

export type ClientFeedback = { status: string; comment: string | null; decidedAt: Date | null };
type FeedbackRow = { subjectId: string; status: string; comment: string | null; decidedAt: Date | null; expiresAt: Date; createdAt: Date };

/**
 * The newest approval request per ad, as the client left it. A "changes requested" decision never changes the ad's own status (the ad
 * stays ready so it can be edited and sent again), so this is the only place the client's comment reaches the workspace. A link the
 * client never used counts as expired once its time is up, as in listApprovals.
 */
export function latestClientFeedback(rows: FeedbackRow[], now = Date.now()): Map<string, ClientFeedback> {
  const out = new Map<string, ClientFeedback>();
  for (const r of [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    if (out.has(r.subjectId)) continue;
    const status = r.status === "pending" && r.expiresAt.getTime() <= now ? "expired" : r.status;
    out.set(r.subjectId, { status, comment: r.comment, decidedAt: r.decidedAt });
  }
  return out;
}

/** The brief as the workspace shows it: each ad carries what the client last said about it (approval links are made per ad). */
export async function getBriefView(tenantId: string, id: string) {
  const brief = await getBrief(tenantId, id);
  const ids = brief.assets.map((a) => a.id);
  const rows = ids.length
    ? await prisma.approvalRequest.findMany({
        where: { tenantId, subjectType: "creative_asset", subjectId: { in: ids } },
        orderBy: { createdAt: "desc" },
        select: { subjectId: true, status: true, comment: true, decidedAt: true, expiresAt: true, createdAt: true },
      })
    : [];
  const feedback = latestClientFeedback(rows ?? []);
  return { ...brief, assets: brief.assets.map((a) => ({ ...a, clientFeedback: feedback.get(a.id) ?? null })) };
}

export async function listBriefs(tenantId: string, brandId?: string) {
  return prisma.creativeBrief.findMany({ where: { tenantId, ...(brandId ? { brandId } : {}) }, orderBy: { createdAt: "desc" }, take: 100, include: { brand: { select: { name: true } } } });
}

type Dep = { ask?: Ask; now?: () => Date; resolve?: Parameters<typeof fetchSiteText>[1]; transport?: Parameters<typeof fetchSiteText>[2] };

const brandContext = (b: { name: string; tone: string | null; industry: string | null; bannedWords: string[] }) =>
  `Brand: ${b.name}\nIndustry: ${b.industry ?? "unknown"}\nTone: ${b.tone ?? "not set"}\nNever use these words: ${b.bannedWords.join(", ") || "none"}`;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export async function runResearch(tenantId: string, briefId: string, dep: Dep = {}) {
  const brief = await getBrief(tenantId, briefId);
  const release = await reserveCredits(tenantId, CREDIT_COST.text);
  try {
    const previous = asRecord(brief.researchSummary);
    const competitorNotes = typeof previous.competitorNotes === "string" ? previous.competitorNotes : "";
    await prisma.creativeBrief.updateMany({ where: { id: briefId, tenantId }, data: { status: "researching" } });
    try {
      const site = brief.brand.websiteUrl ? await fetchSiteText(brief.brand.websiteUrl, dep.resolve, dep.transport) : { pages: [], skipped: [] };
      const siteText = site.pages.map((p) => `[${p.url}]\n${p.text}`).join("\n\n");
      const system = `You summarise a business for an advertising team. ${INJECTION_GUARD} Reply with JSON only: {"offer": string, "audience": string, "tone": string, "proofPoints": string[]}. Only state facts present in the sources; use "unknown" when not stated. Do not invent statistics, prices or testimonials.`;
      const user = [brandContext(brief.brand), `Campaign goal: ${brief.goal}`, untrusted("offer", brief.offer, 1000), untrusted("website", siteText || "(no website content available)", 12000), competitorNotes ? untrusted("competitor_notes", competitorNotes, 3000) : ""].filter(Boolean).join("\n\n");
      const summary = await generateJson(system, user, parseResearch, dep.ask, 1200);
      await recordUsage(tenantId, "ai_credits", CREDIT_COST.text, { type: "creative_brief", id: briefId });
      const stored = { ...summary, competitorNotes, sources: site.pages.map((p) => p.url), skipped: site.skipped, researchedAt: (dep.now?.() ?? new Date()).toISOString() };
      await prisma.creativeBrief.updateMany({ where: { id: briefId, tenantId }, data: { status: "draft", researchSummary: stored } });
      return stored;
    } catch (e) {
      await prisma.creativeBrief.updateMany({ where: { id: briefId, tenantId }, data: { status: "draft" } });
      throw e;
    }
  } finally {
    release();
  }
}

export async function generateAngles(tenantId: string, briefId: string, dep: Dep = {}) {
  const brief = await getBrief(tenantId, briefId);
  if (!brief.researchSummary) throw new HttpError(409, "Run research first.");
  const release = await reserveCredits(tenantId, CREDIT_COST.text);
  try {
    const research = asRecord(brief.researchSummary);
    const system = `You are a direct-response advertising strategist for Meta ads. ${INJECTION_GUARD} Reply with JSON only: {"angles": [{"hook": string, "audience": string, "cta": string, "rationale": string}]} containing 3 to 5 distinct angles. Do not make guarantees, medical or income claims, and do not address personal attributes.`;
    const user = [brandContext(brief.brand), `Goal: ${brief.goal}`, `Special ad category: ${brief.brand.specialAdCategory}`, untrusted("offer", brief.offer, 1000), untrusted("research", JSON.stringify({ offer: research.offer, audience: research.audience, tone: research.tone, proofPoints: research.proofPoints }), 4000), typeof research.competitorNotes === "string" && research.competitorNotes ? untrusted("competitor_notes", research.competitorNotes, 3000) : ""].filter(Boolean).join("\n\n");
    const angles = await generateJson(system, user, parseAngles, dep.ask, 1800);
    await recordUsage(tenantId, "ai_credits", CREDIT_COST.text, { type: "creative_brief", id: briefId });
    await prisma.creativeAngle.deleteMany({ where: { tenantId, briefId, assets: { none: {} } } });
    await prisma.creativeAngle.createMany({ data: angles.map((a) => ({ ...a, tenantId, briefId })) });
    await prisma.creativeBrief.updateMany({ where: { id: briefId, tenantId }, data: { status: "angles_ready" } });
    return prisma.creativeAngle.findMany({ where: { tenantId, briefId }, orderBy: { id: "asc" } });
  } finally {
    release();
  }
}

export async function updateAngle(tenantId: string, angleId: string, input: Record<string, unknown>) {
  const data: Prisma.CreativeAngleUncheckedUpdateInput = {};
  if (input.selected !== undefined) {
    if (typeof input.selected !== "boolean") throw new HttpError(400, "selected must be true or false.");
    data.selected = input.selected;
  }
  for (const [key, max] of [["hook", 300], ["audience", 300], ["cta", 80], ["rationale", 600]] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string" || !(input[key] as string).trim() || (input[key] as string).length > max) throw new HttpError(400, `${key} is not valid.`);
    data[key] = (input[key] as string).trim();
  }
  const res = await prisma.creativeAngle.updateMany({ where: { id: angleId, tenantId }, data });
  if (res.count === 0) throw new HttpError(404, "Angle not found.");
  return prisma.creativeAngle.findFirst({ where: { id: angleId, tenantId } });
}

function parsePlacements(v: unknown): Placement[] {
  const list = v === undefined ? ["feed"] : v;
  if (!Array.isArray(list) || list.length === 0 || list.length > PLACEMENTS.length || list.some((p) => !(PLACEMENTS as readonly string[]).includes(p as string))) throw new HttpError(400, "Choose valid placements.");
  return [...new Set(list as Placement[])];
}

async function loadAngle(tenantId: string, briefId: string, angleId: unknown) {
  const angle = typeof angleId === "string" ? await prisma.creativeAngle.findFirst({ where: { id: angleId, briefId, tenantId } }) : null;
  if (!angle) throw new HttpError(404, "Angle not found.");
  return angle;
}

export async function generateCopy(tenantId: string, briefId: string, input: Record<string, unknown>, dep: Dep = {}) {
  const brief = await getBrief(tenantId, briefId);
  const angle = await loadAngle(tenantId, briefId, input.angleId);
  const placements = parsePlacements(input.placements);
  const release = await reserveCredits(tenantId, CREDIT_COST.text);
  try {
    const limits = placements.map((p) => `${p}: headline <= ${COPY_LIMITS[p].headline}, primaryText <= ${COPY_LIMITS[p].primaryText}, description <= ${COPY_LIMITS[p].description}`).join("\n");
    const system = `You write Meta ad copy. ${INJECTION_GUARD} Reply with JSON only: {"variants": [{"placement": string, "headline": string, "primaryText": string, "description": string}]} with exactly one variant per requested placement, within the character limits. No guarantees, no medical or income claims, no ALL CAPS, no more than one exclamation mark, never use banned words.`;
    const user = [brandContext(brief.brand), `Goal: ${brief.goal}`, untrusted("offer", brief.offer, 1000), untrusted("angle", JSON.stringify({ hook: angle.hook, audience: angle.audience, cta: angle.cta }), 1000), `Placements and limits:\n${limits}`].join("\n\n");
    const variants = await generateJson(system, user, (raw) => parseCopy(raw, placements), dep.ask, 1500);
    await recordUsage(tenantId, "ai_credits", CREDIT_COST.text, { type: "creative_brief", id: briefId });
    const created = [];
    for (const v of variants) {
      const policy = checkPolicy({ headline: v.headline, body: v.primaryText, description: v.description, placement: v.placement, brand: brief.brand });
      created.push(
        await prisma.creativeAsset.create({
          data: { tenantId, briefId, angleId: angle.id, kind: "copy", placement: v.placement, headline: v.headline, body: v.primaryText, provider: "claude", aiGenerated: true, creditCost: 0, status: "ready", policyCheck: { ...policy, description: v.description } as unknown as Prisma.InputJsonValue },
        }),
      );
    }
    await prisma.creativeBrief.updateMany({ where: { id: briefId, tenantId }, data: { status: "ready" } });
    return created;
  } finally {
    release();
  }
}

export async function generateMedia(tenantId: string, briefId: string, input: Record<string, unknown>) {
  const kind = input.kind === "video" ? "video" : "image";
  if (kind === "video") getVideoProvider();
  const brief = await getBrief(tenantId, briefId);
  const angle = await loadAngle(tenantId, briefId, input.angleId);
  const placement = parsePlacements([input.placement ?? "feed"])[0];
  const given = typeof input.headline === "string" ? input.headline.trim() : "";
  if (given.length > 120) throw new HttpError(400, "headline is too long.");
  const headline = given || angle.hook.slice(0, 120);
  const prompt = typeof input.prompt === "string" ? input.prompt.slice(0, 500) : undefined;
  const provider = getImageProvider();
  const release = provider.metered ? await reserveCredits(tenantId, CREDIT_COST.image) : () => undefined;
  try {
    const file = await provider.generate({ brandName: brief.brand.name, colors: brief.brand.colors, headline, placement, prompt });
    const cost = provider.metered && !file.fallback ? CREDIT_COST.image : 0;
    const providerName = file.fallback ? "placeholder" : provider.name;
    const asset = await prisma.creativeAsset.create({ data: { tenantId, briefId, angleId: angle.id, kind: "image", placement, headline, provider: providerName, aiGenerated: true, creditCost: cost, status: "pending" } });
    try {
      const key = await getStorage().put(tenantId, `${asset.id}.${file.ext}`, file.data);
      const policy = checkPolicy({ headline, placement, brand: brief.brand });
      if (cost > 0) await recordUsage(tenantId, "ai_credits", cost, { type: "creative_asset", id: asset.id });
      await prisma.creativeAsset.updateMany({ where: { id: asset.id, tenantId }, data: { storageKey: key, status: "ready", policyCheck: policy as unknown as Prisma.InputJsonValue } });
    } catch (e) {
      await prisma.creativeAsset.updateMany({ where: { id: asset.id, tenantId }, data: { status: "failed", creditCost: 0 } });
      throw e;
    }
    return prisma.creativeAsset.findFirst({ where: { id: asset.id, tenantId } });
  } finally {
    release();
  }
}

export async function getAsset(tenantId: string, id: string) {
  const asset = await prisma.creativeAsset.findFirst({ where: { id, tenantId } });
  if (!asset) throw new HttpError(404, "Asset not found.");
  return asset;
}

export async function updateAsset(tenantId: string, id: string, input: Record<string, unknown>) {
  const asset = await getAsset(tenantId, id);
  const brief = await getBrief(tenantId, asset.briefId);
  const prior = asRecord(asset.policyCheck);
  const headline = input.headline === undefined ? asset.headline : cleanText(input.headline, "Headline", 200);
  const body = input.body === undefined ? asset.body : cleanText(input.body, "Primary text", 1000);
  const description = input.description === undefined ? (typeof prior.description === "string" ? prior.description : "") : cleanText(input.description, "Description", 200) ?? "";
  const policy = checkPolicy({ headline, body, description, placement: asset.placement as Placement, brand: brief.brand, aiGenerated: asset.aiGenerated });
  const policyCheck = (asset.kind === "copy" ? { ...policy, description } : policy) as unknown as Prisma.InputJsonValue;
  await prisma.creativeAsset.updateMany({ where: { id, tenantId }, data: { headline, body, policyCheck, status: asset.status === "approved" || asset.status === "rejected" ? "ready" : asset.status } });
  return getAsset(tenantId, id);
}

export async function deleteAsset(tenantId: string, id: string): Promise<void> {
  const asset = await getAsset(tenantId, id);
  if (asset.storageKey) await getStorage().remove(tenantId, asset.storageKey).catch(() => undefined);
  await prisma.creativeAsset.deleteMany({ where: { id, tenantId } });
}

const CONTENT_TYPES: Record<string, string> = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export async function readAssetFile(tenantId: string, id: string): Promise<{ data: Buffer; contentType: string }> {
  const asset = await getAsset(tenantId, id);
  if (!asset.storageKey) throw new HttpError(404, "This asset has no file.");
  const data = await getStorage().get(tenantId, asset.storageKey);
  return { data, contentType: CONTENT_TYPES[asset.storageKey.slice(asset.storageKey.lastIndexOf(".") + 1)] ?? "application/octet-stream" };
}

export async function sendForApproval(tenantId: string, briefId: string, assetId?: string) {
  await getBrief(tenantId, briefId);
  const assets = await prisma.creativeAsset.findMany({ where: assetId ? { id: assetId, briefId, tenantId } : { briefId, tenantId, status: "ready" } });
  if (assets.length === 0) throw new HttpError(404, "Nothing to send for approval.");
  if (assets.some((a) => asRecord(a.policyCheck).result === "block")) throw new HttpError(409, "Fix the blocked items before sending for approval.");
  try {
    return assetId
      ? await createApproval(tenantId, { subjectType: "creative_asset", subjectId: assetId })
      : await createApproval(tenantId, { subjectType: "creative_brief", subjectId: briefId });
  } catch (e) {
    if (e instanceof Error && /not implemented/i.test(e.message)) throw new HttpError(501, "Client approval links are not available yet.");
    throw e;
  }
}
