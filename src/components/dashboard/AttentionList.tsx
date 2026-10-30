import Link from "next/link";
import { actionLinkClass, EmptyState } from "@/components/setup/EmptyState";
import { cn } from "@/components/ui";
import type { AttentionItem, QueueItem } from "@/lib/setup/dashboard-logic";
import { formatWait } from "@/lib/setup/dashboard-logic";

const DOT = { urgent: "bg-red-600", warn: "bg-amber-500", info: "bg-accent" } as const;
const LABEL = { urgent: "Urgent", warn: "Needs a look", info: "For your information" } as const;

/** The things that need a person today, most urgent first. Empty means everything is fine, and says so. */
export function AttentionList({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return <EmptyState compact illustration="success" title="You are all caught up" body="No waiting customers, failed messages or expiring connections right now." />;
  }
  return (
    <ul className="divide-y divide-border">
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex min-w-0 gap-3">
            <span aria-hidden className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", DOT[item.severity])} />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                <span className="sr-only">{LABEL[item.severity]}: </span>
                {item.title}
              </p>
              <p className="mt-0.5 text-sm text-muted">{item.detail}</p>
            </div>
          </div>
          <Link href={item.href} className={cn(actionLinkClass(false), "!px-3 !py-1.5 !text-xs")}>
            {item.cta}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Chats whose last message is from the customer, longest wait first. */
export function WaitingList({ items, total, emptyText }: { items: QueueItem[]; total: number; emptyText: string }) {
  if (items.length === 0) return <EmptyState compact illustration="inbox" title="Nobody is waiting" body={emptyText} />;
  return (
    <>
      <ul className="divide-y divide-border">
        {items.map((q) => (
          <li key={q.id} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{q.name}</p>
              <p className="text-xs text-muted">{q.assignedTo ? `With ${q.assignedTo}` : "Nobody assigned"}</p>
            </div>
            <span className="shrink-0 text-sm tabular-nums text-muted">
              <span className="sr-only">Waiting </span>
              {formatWait(q.waitingSeconds)}
            </span>
          </li>
        ))}
      </ul>
      {total > items.length && (
        <p className="mt-2 text-sm">
          <Link href="/app/inbox" className="font-medium text-accent underline underline-offset-2">
            See all {total} in the inbox
          </Link>
        </p>
      )}
    </>
  );
}
