import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { flowContextOf, flowHref, parseFlowQuery, readOnlyContext } from "@/components/promote/flow-helpers";
import { PromoteShell } from "@/components/promote/PromoteShell";
import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { promoteText } from "@/lib/promote/copy";
import { loadDefaultFacts, smartDefaults } from "@/lib/promote/defaults";
import { promoteEnabled } from "@/lib/promote/flags";
import { shopLocation } from "@/lib/promote/geo";
import { accessFor } from "@/lib/promote/route-guard";
import { offeredGoals } from "@/lib/promote/service";
import { getPromoteSettings } from "@/lib/promote/settings";
import type { Actor } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
export const metadata = { title: promoteText("flow.create_title") };

type SearchParams = Record<string, string | string[] | undefined>;

async function currentActor(): Promise<Actor | null> {
  try {
    const jar = await cookies();
    const cookie = jar
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    return await getActor(new Request("http://internal/", { headers: { cookie } }));
  } catch {
    return null;
  }
}

/**
 * /app/ads/create?goal=&source=&days=&draft= (docs/IG-PAGE-ADS-SPEC.md 3.4 to 3.6, 7.1, D2, D15, D28; PRM-14): a new ad by goal,
 * including lead form ads and messaging ads. Not found unless Instagram and Facebook Page ads are open to this member
 * (promoteAccess.visible): nothing is looked up while PROMOTE_ENABLED is off, and there is no nav item, so the nav counts are
 * unchanged. Agents see who can make ads. ?source=post hands over to Boost (3.4 "Use a post"). The 3.1 defaults and the saved
 * lead forms of the workspace's Pages, each with its Page ("Use a saved form", 3.5), are read here; Meta is never called.
 */
export default async function CreatePage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  if (promoteEnabled() === "off") notFound();
  const actor = await currentActor();
  if (!actor) notFound();
  const access = await accessFor(actor);
  if (!access.visible) notFound();
  const query = parseFlowQuery((await searchParams) ?? {});
  // "Use a post" starts with Boost's post picker (3.4 step 2), keeping the goal and days.
  if (query.source === "post" && !query.draft) redirect(flowHref("boost", { goal: query.goal ?? undefined, days: query.days ?? undefined }));
  if (!access.canWrite) return <PromoteShell ctx={readOnlyContext("create", query)} />;

  const tenantId = actor.tenantId;
  const offered = offeredGoals(access);
  const now = new Date();
  const facts = await loadDefaultFacts(actor, { allowedGoals: offered, now });
  const defaults = smartDefaults(facts, { goal: query.goal, days: query.days, lang: "en" });
  const pageIds = facts.pages.map((p) => p.assetId);
  const [phone, settings, control, forms] = await Promise.all([
    prisma.phoneNumber.findFirst({ where: { tenantId, status: "connected" }, orderBy: { createdAt: "asc" }, select: { displayPhone: true, verifiedName: true } }).catch(() => null),
    getPromoteSettings(tenantId).catch(() => null),
    prisma.spendControl.findUnique({ where: { tenantId }, select: { timezone: true } }).catch(() => null),
    // Saved forms of every Page the ad may run from that aren't hidden (every LeadForm row is a form on Meta), newest first,
    // each with its Page: the form step lists only the chosen Page's forms (Meta refuses a form of another Page).
    pageIds.length
      ? prisma.leadForm.findMany({ where: { tenantId, pageAssetId: { in: pageIds }, hiddenAt: null }, select: { id: true, name: true, pageAssetId: true }, orderBy: { createdAt: "desc" }, take: 200 }).catch(() => [])
      : Promise.resolve([]),
  ]);

  const ctx = flowContextOf(
    "create",
    {
      facts,
      defaults,
      access,
      offered,
      phone: phone ? { displayPhone: phone.displayPhone ?? null, verifiedName: phone.verifiedName ?? null } : null,
      privacyUrl: settings?.privacyUrl ?? null,
      shop: shopLocation(facts.shop),
      forms: forms ?? [],
      workspaceTz: control?.timezone ?? null,
      now,
    },
    query,
  );
  return <PromoteShell ctx={ctx} />;
}
