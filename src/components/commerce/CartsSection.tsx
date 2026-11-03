"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, DataTable, EmptyState, ErrorState, FormField, Select, apiFetch, toast, type Column } from "@/components/ui";
import { CART_STATUS_FILTERS, REMINDERS, cartStatusView, friendlyError, maskPhone, money, stageLabel } from "./helpers";
import type { Cart } from "./types";

type Page = { carts: Cart[]; nextCursor: string | null };

function nextReminder(c: Cart): string {
  if (c.status !== "open") return "None";
  if (!c.nextReminderAt) return c.remindersSent >= REMINDERS ? "All sent" : "Not scheduled";
  return new Date(c.nextReminderAt).toLocaleString();
}

export function CartsSection({ storeId }: { storeId?: string }) {
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<Cart[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const loadedKey = useRef("");

  const load = useCallback(
    async (after: string | null) => {
      const mine = ++request.current;
      if (after) setMore(true);
      else setLoading(true);
      const key = `${storeId ?? ""}|${status}`;
      const q = new URLSearchParams();
      if (storeId) q.set("storeId", storeId);
      if (status) q.set("status", status);
      if (after) q.set("cursor", after);
      try {
        const page = await apiFetch<Page>(`/api/commerce/carts?${q}`);
        if (mine !== request.current) return;
        setRows((prev) => (after ? [...prev, ...page.carts] : page.carts));
        setCursor(page.nextCursor);
        setError("");
        loadedKey.current = key;
      } catch (e) {
        if (mine !== request.current) return;
        if (after) toast.error("We could not load more carts", { description: friendlyError(e) });
        else {
          if (loadedKey.current !== key) {
            setRows([]);
            setCursor(null);
          }
          setError(friendlyError(e));
        }
      } finally {
        if (mine === request.current) {
          setLoading(false);
          setMore(false);
        }
      }
    },
    [storeId, status],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const columns: Column<Cart>[] = useMemo(
    () => [
      {
        key: "when",
        header: "When",
        primary: true,
        cell: (c) => (
          <div>
            <div>{new Date(c.createdAt).toLocaleString()}</div>
            <div className="text-xs font-normal text-muted">{stageLabel(c.stage)}</div>
          </div>
        ),
      },
      { key: "customer", header: "Customer", accessor: (c) => maskPhone(c.phone) },
      { key: "total", header: "Cart total", accessor: (c) => money(c.totalMinor, c.currency) },
      { key: "reminders", header: "Reminders sent", cell: (c) => `${c.remindersSent} of ${REMINDERS}` },
      { key: "next", header: "Next reminder", cell: (c) => nextReminder(c) },
      {
        key: "status",
        header: "Outcome",
        cell: (c) => {
          const v = cartStatusView(c.status);
          return (
            <Badge dot tone={v.tone}>
              <span title={v.hint}>{v.label}</span>
            </Badge>
          );
        },
      },
    ],
    [],
  );

  const firstLoad = loading && rows.length === 0;

  return (
    <Card
      title="Abandoned carts"
      description="Shoppers who left without buying. Phone numbers are partly hidden to protect your customers."
      actions={
        <div className="w-44">
          <FormField label="Outcome">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All outcomes</option>
              {CART_STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {cartStatusView(s).label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      }
    >
      {error && rows.length > 0 && (
        <Alert
          className="mb-4"
          tone="bad"
          title="We could not refresh your carts"
          action={
            <Button size="sm" variant="secondary" onClick={() => void load(null)}>
              Try again
            </Button>
          }
        >
          {error}{" "}You are still seeing the earlier results.
        </Alert>
      )}
      {error && rows.length === 0 ? (
        <ErrorState
          title="We could not load abandoned carts"
          message={error}
          action={
            <Button variant="secondary" onClick={() => void load(null)}>
              Try again
            </Button>
          }
        />
      ) : (
        <DataTable
          caption="Abandoned carts"
          columns={columns}
          rows={rows}
          rowKey={(c) => c.id}
          loading={firstLoad}
          empty={
            status ? (
              <EmptyState
                compact
                title={`No ${cartStatusView(status).label.toLowerCase()} carts`}
                body="No carts have this outcome yet."
                action={
                  <Button variant="secondary" onClick={() => setStatus("")}>
                    Show all outcomes
                  </Button>
                }
              />
            ) : (
              <EmptyState
                compact
                title="No abandoned carts yet"
                body="When a shopper leaves a checkout with a phone number, it shows up here. Make sure reminders are turned on above so we can start winning them back."
              />
            )
          }
          footer={
            cursor ? (
              <div className="text-center">
                <Button variant="secondary" loading={more} onClick={() => void load(cursor)}>
                  Load more carts
                </Button>
              </div>
            ) : undefined
          }
        />
      )}
    </Card>
  );
}
