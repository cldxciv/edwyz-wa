import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import { ApprovalReview } from "@/components/spend/ApprovalReview";
import { buttonSizes, buttonVariants } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { getActor } from "@/lib/auth";
import { createLimiter } from "@/lib/ratelimit";
import { loadApprovalByToken } from "@/lib/spend/summary";
import type { Actor } from "@/lib/tenancy";

/*
 * The one-tap spending request link, https://wa.edwyz.com/s/<token> (docs/SPEND-CONTROLS-SPEC.md 7.4). It shows the action,
 * "Could add up to ₹4,550 this month (worst case)", the reason and the time left.
 * - Decline works with the token alone (declining only lowers risk), so it works logged out.
 * - Approve needs a signed-in approver of this workspace (the owner, or an admin the owner named): holding the phone is not
 *   enough. Logged out, "Sign in to approve" leads through sign-in to the request on Settings > Spending limits, where it is
 *   one tap.
 * - A request past its time reads "Declined automatically (no answer in 12 hours)." with no buttons.
 * Only the token's hash is looked up, and a malformed token never reaches the database. Decisions go to
 * POST /api/spend/approvals/token, which applies its own per-token and per-address limits.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Spending request",
  robots: { index: false, follow: false, nocache: true },
  // The token stays out of third-party requests; the decision form still sends a real Origin.
  referrer: "same-origin",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

const viewLimiter = createLimiter(60, 15 * 60 * 1000, "spend-approve-view-ip");

async function currentActor(): Promise<Actor | null> {
  const jar = await cookies();
  const cookie = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  if (!cookie) return null;
  try {
    return await getActor(new Request("http://internal/", { headers: { cookie } }));
  } catch {
    return null;
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto w-full max-w-xl px-4 pb-10 pt-5 sm:pt-8">
        <p className="mb-5 text-sm font-semibold text-muted">Edwyz WA</p>
        {children}
      </main>
    </div>
  );
}

/** Every request also waits on this page. Signed out, the app sends the person through sign-in and back here. */
function SpendingLimitsLink() {
  return (
    <Link href="/app/settings/spending" className={cn("mt-5 inline-flex items-center justify-center rounded-lg font-medium", buttonVariants.secondary, buttonSizes.md)}>
      Open Spending limits
    </Link>
  );
}

function InvalidLink() {
  return (
    <Shell>
      <h1 className="text-xl font-semibold">This link doesn&apos;t work</h1>
      <p className="mt-2 text-sm text-muted">It may be incomplete or mistyped. Requests waiting for you are also under Settings &gt; Spending limits in Edwyz WA.</p>
      <SpendingLimitsLink />
    </Shell>
  );
}

/** Too many opens from one network (mobile carriers share one address between many people): the link is fine. */
function TooManyTries() {
  return (
    <Shell>
      <h1 className="text-xl font-semibold">Too many tries from this network</h1>
      <p className="mt-2 text-sm text-muted">Your link is fine. Wait a few minutes and open it again, or open Settings &gt; Spending limits in Edwyz WA, where the request is waiting too.</p>
      <SpendingLimitsLink />
    </Shell>
  );
}

export default async function SpendApprovalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const ip = h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",").pop()?.trim() || "unknown";
  if (!viewLimiter.consume(ip)) return <TooManyTries />;
  const actor = await currentActor();
  const data = await loadApprovalByToken(token, actor).catch(() => null);
  if (!data) return <InvalidLink />;
  const signedIn = actor?.tenantId === data.tenantId;
  const otherWorkspace = !!actor && !signedIn;
  const next = `/app/settings/spending?approval=${encodeURIComponent(data.approval.id)}`;
  const loginHref = `/login?next=${encodeURIComponent(next)}`;
  return (
    <Shell>
      <h1 className="text-xl font-semibold text-balance">Spending request for {data.workspaceName}</h1>
      <p className="mt-1 text-sm text-muted">An assistant asked before changing anything. Nothing happens unless someone approves.</p>
      <div className="mt-5">
        <ApprovalReview approval={data.approval} mode="link" token={token} signedIn={signedIn} loginHref={loginHref} />
      </div>
      {otherWorkspace && (
        <p className="mt-4 text-sm text-muted">You&apos;re signed in to another workspace. Switch to {data.workspaceName} to approve this, or decline it here.</p>
      )}
      <p className="mt-8 text-center text-sm text-muted">Declining works without signing in. Approving needs the owner, or an admin the owner chose, to sign in.</p>
    </Shell>
  );
}
