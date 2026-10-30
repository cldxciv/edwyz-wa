import { headers } from "next/headers";
import { DecidedNotice, DecisionForm, InvalidLink, Intro, SummaryCard } from "@/components/approvals/ApprovalPage";
import { loadApprovalPage } from "@/lib/approvals";
import { viewIpLimiter } from "@/lib/approvals/guards";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const first = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] : v) ?? null;

export default async function ApprovePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await params;
  const query = await searchParams;
  const notice = first(query.notice) ?? first(query.e);
  const h = await headers();
  const ip = h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",").pop()?.trim() || "unknown";
  if (!viewIpLimiter.consume(ip)) return <InvalidLink />;
  const data = await loadApprovalPage(token);
  if (data.state === "invalid") return <InvalidLink />;
  if (data.state !== "pending") {
    return (
      <div className="space-y-4">
        <DecidedNotice decision={data.decision} />
        <SummaryCard summary={data.summary} />
      </div>
    );
  }
  return (
    <>
      <Intro kindLabel={data.summary.kindLabel} />
      <SummaryCard summary={data.summary} />
      <DecisionForm token={token} nonce={data.nonce} notice={notice} />
    </>
  );
}
