"use client";

import { Badge, Card, EmptyState, ErrorState, Button, ProgressBar, Skeleton, Stat } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import { type Funnel, funnelRate } from "@/lib/broadcasts/funnel";
import { meterView, qualityView } from "@/lib/broadcasts/limits";
import { friendlyError, limitSummary } from "./helpers";

type Phone = { id: string; displayPhone: string; verifiedName: string | null; qualityRating: string | null; messagingLimitTier: string | null; portfolioTier?: string | null; sentLast24h: number };

export function LimitMeter({ phone }: { phone: Phone }) {
  const meter = meterView(phone.portfolioTier ?? phone.messagingLimitTier, phone.sentLast24h);
  const quality = qualityView(phone.qualityRating);
  return (
    <div className="rounded-control border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words text-sm font-medium">{phone.displayPhone}</span>
        <Badge tone={quality.tone}>Quality: {quality.label}</Badge>
      </div>
      {meter.known && !meter.unlimited ? (
        <ProgressBar
          value={Math.min(meter.used, meter.limit)}
          max={meter.limit}
          tone="auto"
          label={`Daily sending limit for ${phone.displayPhone}`}
          valueText={`${meter.percent}% of the daily limit used`}
        />
      ) : null}
      <p className="mt-2 text-sm">{limitSummary(meter)}</p>
      {meter.known && <p className="mt-0.5 text-xs text-muted">Counts different people who got a message you started, from any of your numbers. All numbers in your WhatsApp business account share this limit.</p>}
    </div>
  );
}

const STEPS: { key: keyof Omit<Funnel, "total">; label: string }[] = [
  { key: "sent", label: "Sent" },
  { key: "delivered", label: "Delivered" },
  { key: "read", label: "Read" },
  { key: "replied", label: "Replied" },
  { key: "failed", label: "Failed" },
];

export function FunnelChart({ funnel }: { funnel: Funnel }) {
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {STEPS.map((s) => (
          <Stat
            key={s.key}
            label={s.label}
            value={funnel[s.key].toLocaleString()}
            hint={s.key === "sent" ? `of ${funnel.total.toLocaleString()} people` : `${funnelRate(funnel[s.key], s.key === "failed" ? funnel.total : funnel.sent)}% ${s.key === "failed" ? "of all" : "of sent"}`}
          />
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">Replied counts people who wrote back within 24 hours of getting the message.</p>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-2" aria-busy="true">
      <span className="sr-only" role="status">
        Loading your sending limits and results
      </span>
      <Card>
        <Skeleton className="mb-3 h-5 w-48" />
        <Skeleton className="h-24 w-full" />
      </Card>
      <Card>
        <Skeleton className="mb-3 h-5 w-48" />
        <Skeleton className="h-24 w-full" />
      </Card>
    </div>
  );
}

export function OverviewPanels() {
  const { data, error, loading, reload } = useApi<{ days: number; phones: Phone[]; funnel: Funnel }>("/api/broadcasts/overview?days=30", 30_000);
  if (loading) return <OverviewSkeleton />;
  if (!data) {
    return (
      <div className="mb-6">
        <ErrorState
          title="We could not load your sending stats"
          message={`${friendlyError(error, "Something went wrong on our side.")} Check your connection and try again.`}
          action={
            <Button variant="secondary" onClick={reload}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-2">
      <Card title="Daily sending limit" description="How many different people your number can message in 24 hours, and how its quality is rated.">
        <div className="space-y-3">
          {data.phones.length === 0 ? (
            <EmptyState compact title="No WhatsApp number connected" body="Connect a number to see its sending limit and quality here." />
          ) : (
            data.phones.map((p) => <LimitMeter key={p.id} phone={p} />)
          )}
        </div>
      </Card>
      <Card title={`Results from the last ${data.days} days`} description="What happened to the messages your broadcasts sent.">
        {data.funnel.total === 0 ? <EmptyState compact title="No broadcast results yet" body="Results appear here after your first broadcast starts sending." /> : <FunnelChart funnel={data.funnel} />}
      </Card>
    </div>
  );
}
