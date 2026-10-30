"use client";

import { useEffect, useState } from "react";
import { Button, Card, ErrorState, Skeleton, apiFetch } from "@/components/ui";

type Row = { id: string; displayPhone: string; verifiedName: string | null; tierLabel: string; tier: string | null; meter: string; hint: string | null; unlimited: boolean; dailyLimit: number | null; sentLast24h: number };

/** How many different people the business can start chats with in a day, per connected number. Hidden until a number is connected. */
export function MessagingLimitCard() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    apiFetch<{ numbers: Row[] }>("/api/workspace/messaging-limits")
      .then((r) => alive && (setError(null), setRows(r.numbers)))
      .catch((e: unknown) => alive && setError(e instanceof Error && e.message ? e.message : "Something went wrong."));
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = () => {
    setError(null);
    setRows(null);
    setAttempt((n) => n + 1);
  };

  if (rows && rows.length === 0) return null;
  return (
    <Card title="Your daily sending limit" description="WhatsApp limits how many different people your business can start a chat with in 24 hours. The limit is shared by all numbers in the same Meta business portfolio, and it grows by itself when your messages keep a good quality rating.">
      {error ? (
        <ErrorState
          title="We could not load your sending limit"
          message={`${error} Only owners and admins can see this. If you should have access, try again.`}
          action={<Button variant="secondary" size="sm" onClick={retry}>Try again</Button>}
        />
      ) : !rows ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((n) => (
            <li key={n.id} className="py-3 text-sm">
              <p className="font-medium">
                {n.displayPhone}
                {n.verifiedName ? <span className="text-muted"> &middot; {n.verifiedName}</span> : null}
              </p>
              <p className="mt-1">{n.tierLabel}</p>
              <p className="text-muted">{n.meter}</p>
              {n.hint ? <p className="mt-1 text-xs text-muted">{n.hint}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
