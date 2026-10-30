"use client";

import { useEffect, useState } from "react";
import { Alert, Button, ErrorState, PageHeader, Skeleton } from "@/components/ui";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { CartsSection } from "./CartsSection";
import { RecoveryStats } from "./RecoveryStats";
import { ReminderSettings } from "./ReminderSettings";
import { StoreSection } from "./StoreSection";
import { storeView } from "./helpers";
import type { Store } from "./types";

const POLL_WHILE_WAITING_MS = 8000;

export function CommerceView() {
  const role = useRole();
  const editable = canManage(role);
  const [storeId, setStoreId] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [origin, setOrigin] = useState("");
  const stores = useApi<{ stores: Store[] }>("/api/commerce/stores", waiting ? POLL_WHILE_WAITING_MS : undefined);
  const list = stores.data?.stores ?? [];
  const active = list.find((s) => s.id === storeId) ?? list[0];
  const pending = list.some((s) => storeView(s).pending);

  useEffect(() => setWaiting(pending), [pending]);
  useEffect(() => setOrigin(window.location.origin), []);

  const webhookUrl = list[0]?.webhookUrl ?? (origin ? `${origin}/webhooks/shopify` : "");

  return (
    <div>
      <PageHeader
        title="Shopify recovery"
        description="Win back shoppers who leave without buying. We send a WhatsApp reminder to customers who agreed to messages, and stop the moment they buy, reply or send STOP."
      />
      {stores.error && !stores.data ? (
        <ErrorState
          title="We could not load your store"
          message={stores.error}
          action={
            <Button variant="secondary" onClick={stores.reload}>
              Try again
            </Button>
          }
        />
      ) : !stores.data ? (
        <div aria-busy="true" role="status" className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
          <span className="sr-only">Loading your store</span>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {stores.error && (
            <Alert
              tone="warn"
              title="Showing the last information we have"
              action={
                <Button size="sm" variant="secondary" onClick={stores.reload}>
                  Refresh
                </Button>
              }
            >
              We could not refresh the store status just now.
            </Alert>
          )}
          {active && <RecoveryStats storeId={active.id} />}
          <StoreSection stores={list} editable={editable} webhookUrl={webhookUrl} selected={active?.id} onSelect={setStoreId} onChange={stores.reload} />
          {active && <ReminderSettings key={active.id} store={active} editable={editable} />}
          {active && <CartsSection storeId={active.id} />}
        </div>
      )}
    </div>
  );
}
