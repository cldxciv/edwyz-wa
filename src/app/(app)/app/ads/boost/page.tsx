import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { flowContextOf, parseFlowQuery, readOnlyContext } from "@/components/promote/flow-helpers";
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
export const metadata = { title: promoteText("flow.boost_title") };

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
 * /app/ads/boost?source=&id=&goal=&days=&draft= (docs/IG-PAGE-ADS-SPEC.md 3.3, 7.1, D2, D28; PRM-14): Boost a post in 4 screens.
 * Not found unless Instagram and Facebook Page ads are open to this member (promoteAccess.visible): nothing is looked up while
 * PROMOTE_ENABLED is off, and there is no nav item, so the nav counts are unchanged. Agents see who can make ads. The 3.1 defaults
 * (spending account, Page, Instagram account, ₹300 or the most that fits, 7 days) are read here; Meta is never called.
 */
export default async function BoostPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  if (promoteEnabled() === "off") notFound();
  const actor = await currentActor();
  if (!actor) notFound();
  const access = await accessFor(actor);
  if (!access.visible) notFound();
  const query = parseFlowQuery((await searchParams) ?? {});
  if (!access.canWrite) return <PromoteShell ctx={readOnlyContext("boost", query)} />;

  const tenantId = actor.tenantId;
  const offered = offeredGoals(access);
  const now = new Date();
  const facts = await loadDefaultFacts(actor, { allowedGoals: offered, now });
  const defaults = smartDefaults(facts, { goal: query.goal, days: query.days, lang: "en" });
  const [phone, settings, control] = await Promise.all([
    prisma.phoneNumber.findFirst({ where: { tenantId, status: "connected" }, orderBy: { createdAt: "asc" }, select: { displayPhone: true, verifiedName: true } }).catch(() => null),
    getPromoteSettings(tenantId).catch(() => null),
    prisma.spendControl.findUnique({ where: { tenantId }, select: { timezone: true } }).catch(() => null),
  ]);

  const ctx = flowContextOf(
    "boost",
    {
      facts,
      defaults,
      access,
      offered,
      phone: phone ? { displayPhone: phone.displayPhone ?? null, verifiedName: phone.verifiedName ?? null } : null,
      privacyUrl: settings?.privacyUrl ?? null,
      shop: shopLocation(facts.shop),
      forms: [],
      workspaceTz: control?.timezone ?? null,
      now,
    },
    query,
  );
  return <PromoteShell ctx={ctx} />;
}
