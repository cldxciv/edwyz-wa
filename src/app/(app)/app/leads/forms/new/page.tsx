import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, PageHeader, buttonSizes, buttonVariants, cn } from "@/components/ui";
import { LeadFormBuilder } from "@/components/promote/FormStep";
import { BUILDER_PATH, FORMS_PATH, FORM_BUILDER_TEXT, canBuildForms, type BuilderPageOption, type BuilderProps } from "@/components/promote/form-builder-helpers";
import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { metaScreenHref } from "@/lib/meta-connect/meta-screens";
import { promoteEnabled } from "@/lib/promote/flags";
import { accessFor } from "@/lib/promote/route-guard";
import { getPromoteSettings } from "@/lib/promote/settings";
import type { Actor } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
export const metadata = { title: FORM_BUILDER_TEXT.pageTitle };

const FORM_ID = /^[A-Za-z0-9_-]{1,64}$/;

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

const leadgenOf = (meta: unknown): BuilderPageOption["leadgenTos"] => {
  const v = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>).leadgenTosAccepted : null;
  return v === true ? "ok" : v === false ? "missing" : "unknown";
};

/**
 * /app/leads/forms/new: the instant-form builder (docs/IG-PAGE-ADS-SPEC.md 7.1, 3.5 step 2, PRM-15). Hidden (404) unless
 * Instagram and Facebook Page ads are open to this member (promoteAccess). Owners and admins build; agents are told to ask one.
 * ?copy={formId} starts an edited copy of a form: Meta can't change a live form, so editing makes a new one (D13).
 * The Opens Meta address for Meta's lead ad terms is resolved here, from the allowlist, never in the browser.
 */
export default async function NewLeadFormPage({ searchParams }: { searchParams?: Promise<{ copy?: string | string[] }> }) {
  if (promoteEnabled() === "off") notFound();
  const actor = await currentActor();
  if (!actor) notFound();
  const access = await accessFor(actor);
  if (!access.visible) notFound();

  if (!canBuildForms(access)) {
    return (
      <div data-testid="form-builder-agents">
        <PageHeader title={FORM_BUILDER_TEXT.pageTitle} />
        <Alert tone="info">{FORM_BUILDER_TEXT.agentsOnly}</Alert>
        <Link href={FORMS_PATH} className={cn("mt-4 inline-flex min-h-11 items-center justify-center rounded-full font-semibold", buttonVariants.secondary, buttonSizes.md)}>
          {FORM_BUILDER_TEXT.backToForms}
        </Link>
      </div>
    );
  }

  const tenantId = actor.tenantId;
  const rawCopy = (await searchParams)?.copy;
  const copyId = typeof rawCopy === "string" && FORM_ID.test(rawCopy) ? rawCopy : null;
  if (rawCopy !== undefined && !copyId) notFound();

  const [assets, phone, settings, source] = await Promise.all([
    prisma.metaAsset.findMany({
      where: { tenantId, type: "page", status: "active", connection: { status: { not: "revoked" } } },
      select: { id: true, name: true, externalId: true, connectionId: true, meta: true },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
      take: 200,
    }),
    // "The workspace number" is the oldest connected one, as lead welcomes (leads/runner) and new chats use: a flagged or
    // disconnected number must never become the form's Chat on WhatsApp link.
    prisma.phoneNumber.findFirst({ where: { tenantId, status: "connected" }, orderBy: { createdAt: "asc" }, select: { displayPhone: true, verifiedName: true } }),
    getPromoteSettings(tenantId),
    copyId ? prisma.leadForm.findFirst({ where: { id: copyId, tenantId }, select: { id: true, name: true, pageAssetId: true, spec: true } }) : Promise.resolve(null),
  ]);
  if (copyId && !source) notFound();

  // One row per Page. The copied form's own Page row comes first, so a Page reached through two connections keeps that row.
  const ordered = source ? [...assets.filter((a) => a.id === source.pageAssetId), ...assets.filter((a) => a.id !== source.pageAssetId)] : assets;
  const seen = new Set<string>();
  const pages: BuilderPageOption[] = [];
  for (const a of ordered) {
    if (seen.has(a.externalId)) continue;
    seen.add(a.externalId);
    pages.push({
      id: a.id,
      name: a.name?.trim() || null,
      connectionId: a.connectionId,
      leadgenTos: leadgenOf(a.meta),
      leadgenHref: metaScreenHref("leadgen_tos", { pageId: a.externalId }),
    });
  }

  const props: BuilderProps = {
    pages,
    whatsappNumber: phone?.displayPhone ?? null,
    verifiedName: phone?.verifiedName ?? null,
    privacyUrl: settings.privacyUrl,
    copyFrom: source ? { id: source.id, name: source.name, pageAssetId: source.pageAssetId, spec: source.spec } : null,
    today: new Date().toISOString().slice(0, 10),
  };
  return <LeadFormBuilder key={copyId ?? BUILDER_PATH} {...props} />;
}
