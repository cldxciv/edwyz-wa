import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { AudienceManager, type AudienceOption } from "@/components/promote/AudienceManager";
import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { metaScreenHref } from "@/lib/meta-connect/meta-screens";
import { promoteEnabled } from "@/lib/promote/flags";
import { accessFor } from "@/lib/promote/route-guard";
import type { Actor } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audiences" };

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

const option = (r: { id: string; name: string | null }, fallback: string): AudienceOption => ({ id: r.id, name: r.name?.trim() || fallback });

/**
 * /app/ads/audiences: the audience manager (docs/IG-PAGE-ADS-SPEC.md 3.7, 7.1; PRM-15b). Hidden (404) unless Instagram and
 * Facebook Page ads are open to this member (promoteAccess); the kinds it offers follow PROMOTE_AUDIENCES (access.audiences:
 * saved only at off, then engagement, website and lookalikes, then customer lists). Owners and admins manage audiences; agents
 * are told to ask one. The Opens Meta address for Meta's audience terms is resolved here from the allowlist, for the
 * workspace's spending ad account, never in the browser. Sources are listed by their Edwyz row ids, never by Meta ids.
 */
export default async function AudiencesPage() {
  if (promoteEnabled() === "off") notFound();
  const actor = await currentActor();
  if (!actor) notFound();
  const access = await accessFor(actor);
  if (!access.visible) notFound();
  if (!access.canWrite) return <AudienceManager level={access.audiences} canWrite={false} />;

  const tenantId = actor.tenantId;
  const control = await prisma.spendControl.findUnique({ where: { tenantId }, select: { spendingAdAccountAssetId: true } });
  const [account, assets, forms, segments] = await Promise.all([
    control?.spendingAdAccountAssetId ? prisma.metaAsset.findFirst({ where: { id: control.spendingAdAccountAssetId, tenantId }, select: { externalId: true } }) : Promise.resolve(null),
    access.audiences === "off"
      ? Promise.resolve([])
      : prisma.metaAsset.findMany({
          where: { tenantId, type: { in: ["page", "instagram"] }, status: "active", connection: { status: { not: "revoked" } } },
          select: { id: true, name: true, type: true },
          orderBy: [{ name: "asc" }, { createdAt: "asc" }],
          take: 200,
        }),
    access.audiences === "off"
      ? Promise.resolve([])
      : prisma.leadForm.findMany({ where: { tenantId, hiddenAt: null }, select: { id: true, name: true }, orderBy: { createdAt: "desc" }, take: 200 }),
    access.audiences === "all" ? prisma.segment.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }) : Promise.resolve([]),
  ]);

  return (
    <AudienceManager
      level={access.audiences}
      canWrite
      termsHref={account ? metaScreenHref("custom_audience_tos", { act: account.externalId }) : null}
      sources={{
        instagram: assets.filter((a) => a.type === "instagram").map((a) => option(a, "Instagram account")),
        page: assets.filter((a) => a.type === "page").map((a) => option(a, "Facebook Page")),
        lead_form: forms.map((f) => option(f, "Lead form")),
      }}
      segments={segments.map((s) => option(s, "Segment"))}
    />
  );
}
