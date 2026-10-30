import type { TenantOverview } from "@/lib/admin/service";
import { Badge, EmptyState } from "@/components/ui";

const tone = (status: string) => (status === "live" ? "good" : status === "failed" ? "bad" : status === "in_progress" ? "warn" : "neutral");
const date = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function TenantTable({ tenants }: { tenants: TenantOverview[] }) {
  if (tenants.length === 0) return <EmptyState title="No workspaces yet" body="Workspaces appear here once customers sign up." />;
  return (
    <div className="overflow-x-auto rounded-2xl border border-border">
      <table className="w-full min-w-[56rem] text-left text-sm">
        <caption className="sr-only">Workspaces and their WhatsApp onboarding state</caption>
        <thead className="bg-surface text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-4 py-3">Workspace</th>
            <th scope="col" className="px-4 py-3">Created</th>
            <th scope="col" className="px-4 py-3">Onboarding</th>
            <th scope="col" className="px-4 py-3">Numbers</th>
            <th scope="col" className="px-4 py-3">Quality / tier</th>
            <th scope="col" className="px-4 py-3">Recent onboarding log</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border align-top">
          {tenants.map((t) => (
            <tr key={t.id}>
              <th scope="row" className="px-4 py-3 font-medium">{t.name}</th>
              <td className="whitespace-nowrap px-4 py-3 text-muted">{date(t.createdAt)}</td>
              <td className="px-4 py-3"><Badge tone={tone(t.onboardingStatus)}>{t.onboardingStatus.replace("_", " ")}</Badge></td>
              <td className="px-4 py-3">{t.phoneNumbers.length}</td>
              <td className="px-4 py-3">
                {t.phoneNumbers.length === 0 ? <span className="text-muted">-</span> : (
                  <ul className="space-y-1">
                    {t.phoneNumbers.map((p) => (
                      <li key={p.id}>{p.qualityRating ?? "unknown"} / {p.messagingLimitTier ?? "unknown"}</li>
                    ))}
                  </ul>
                )}
              </td>
              <td className="px-4 py-3">
                {t.recentLogs.length === 0 ? <span className="text-muted">No entries</span> : (
                  <ul className="space-y-1 text-xs">
                    {t.recentLogs.map((l, i) => (
                      <li key={i}>{l.step.replace("_", " ")}: {l.status} <span className="text-muted">({date(l.at)})</span></li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
