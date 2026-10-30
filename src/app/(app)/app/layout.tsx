import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app/AppShell";
import { getActor } from "@/lib/auth";
import { safeNext } from "@/lib/auth/next";
import { UiProvider } from "@/components/ui/UiProvider";
import { SessionKeepAlive } from "@/components/app/SessionKeepAlive";
import { BillingBanner } from "@/components/billing/BillingBanner";
import { UsageBanner } from "@/components/billing/UsageBanner";
import { VerifyEmailBanner } from "@/components/account/VerifyEmailBanner";
import { WhatsAppConnectionBanner } from "@/components/connect/WhatsAppConnectionBanner";
import { SpendBanner } from "@/components/spend/SpendBanner";
import { emailVerificationRequired } from "@/lib/auth/verification";
import { getBillingStatus } from "@/lib/billing";
import { prisma } from "@/lib/db";
import type { Actor } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };
export const metadata: Metadata = { title: { default: "Workspace", template: "%s | Edwyz WA" }, robots: { index: false, follow: false } };

async function currentActor(): Promise<Actor | null> {
  const jar = await cookies();
  const cookie = jar.getAll().map((c) => `${c.name}=${c.value}`).join("; ");
  try {
    return await getActor(new Request("http://internal/", { headers: { cookie } }));
  } catch {
    return null;
  }
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await currentActor();
  if (!actor) {
    const path = safeNext((await headers()).get("x-pathname"));
    redirect(`/api/auth/continue?next=${encodeURIComponent(path)}`);
  }

  const [user, tenant, billing] = await Promise.all([
    prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true, email: true, emailVerifiedAt: true } }),
    prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { name: true } }),
    getBillingStatus(actor.tenantId),
  ]);
  if (!user || !tenant) redirect("/login?next=/app");

  return (
    <>
      {/* The theme init script runs from the root layout, on every page. */}
      <SessionKeepAlive />
      <UiProvider>
      {/* SpendBanner: one spending notice at a time, in the docs/SPEND-CONTROLS-SPEC.md 8.2 priority order, for every member. */}
      <AppShell role={actor.role} workspaceName={tenant.name} userName={user.name} email={user.email} banner={<>{user.emailVerifiedAt === null && emailVerificationRequired() && <VerifyEmailBanner email={user.email} />}<SpendBanner /><WhatsAppConnectionBanner /><BillingBanner status={billing} />{actor.role !== "agent" && <UsageBanner />}</>}>
        {children}
      </AppShell>
      </UiProvider>
    </>
  );
}
