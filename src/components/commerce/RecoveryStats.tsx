"use client";

import { Button, Stat } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import { money } from "./helpers";
import type { Stats } from "./types";

export function RecoveryStats({ storeId }: { storeId?: string }) {
  const { data, error, loading, reload } = useApi<Stats>(`/api/commerce/stats${storeId ? `?storeId=${encodeURIComponent(storeId)}` : ""}`);

  if (error && !data) {
    return (
      <p className="flex flex-wrap items-center gap-3 text-sm text-muted">
        Results are not available right now.
        <Button size="sm" variant="secondary" onClick={reload}>
          Try again
        </Button>
      </p>
    );
  }

  const days = data?.days ?? 30;
  const pending = loading && !data;
  const value = data?.recoveredValue.length ? data.recoveredValue.map((v) => money(v.totalMinor, v.currency)).join(", ") : "None yet";
  return (
    <section aria-label="Results" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Stat label="Abandoned carts" value={data?.total ?? 0} hint={`Last ${days} days`} loading={pending} />
      <Stat label="Reminders sent" value={data?.remindersSent ?? 0} loading={pending} />
      <Stat label="Carts recovered" value={data?.recovered ?? 0} hint={data ? `${data.recoveryRatePercent}% of abandoned carts` : undefined} loading={pending} />
      <Stat label="Recovered after a reminder" value={data ? `${data.reminderRecoveryRatePercent}%` : "0%"} hint={data ? `${data.recoveredAfterReminder} of ${data.reminded} reminded` : undefined} loading={pending} />
      <Stat className="col-span-2 lg:col-span-1" label="Sales won back" value={value} hint="After a reminder" loading={pending} />
    </section>
  );
}
