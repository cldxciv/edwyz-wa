"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { Button, DataTable, EmptyState, ErrorState, StatusPill, apiFetch, type Column } from "@/components/ui";
import { friendlyMessage } from "./messages";
import { LinkButton } from "./shared";
import { briefStatus, goalLabel } from "./wizard";

type Row = { id: string; goal: string; offer: string; status: string; brand: { name: string } };

export function BriefList() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setRows((await apiFetch<{ items: Row[] }>("/api/creative/briefs")).items);
    } catch (e) {
      setError(friendlyMessage(e, "Check your connection and try again."));
      setRows((cur) => cur ?? []);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const columns = useMemo<Column<Row>[]>(
    () => [
      {
        key: "brand",
        header: "Brand",
        primary: true,
        accessor: (r) => r.brand.name,
        sortable: true,
        cell: (r) => (
          <Link href={`/app/creative/briefs/${r.id}`} className="font-semibold underline-offset-2 hover:underline">
            {r.brand.name}
          </Link>
        ),
      },
      { key: "goal", header: "Goal", accessor: (r) => goalLabel(r.goal), sortable: true },
      { key: "offer", header: "Offer", cell: (r) => <span className="line-clamp-2 max-w-md text-muted">{r.offer}</span> },
      {
        key: "status",
        header: "Status",
        accessor: (r) => briefStatus(r.status).label,
        sortable: true,
        cell: (r) => <StatusPill status={r.status} label={briefStatus(r.status).label} tone={briefStatus(r.status).tone} />,
      },
    ],
    [],
  );

  return (
    <div>
      <PageHeader
        title="Creative Studio"
        description="Turn an offer into ad ideas, ad text and pictures. We check them for common ad problems, then you send them to your client for approval."
        actions={
          <>
            <LinkButton href="/app/creative/brands">Brand kits</LinkButton>
            <LinkButton variant="primary" href="/app/creative/new">
              New brief
            </LinkButton>
          </>
        }
      />
      {error && rows !== null && rows.length === 0 ? (
        <ErrorState title="We could not load your briefs" message={error} action={<Button variant="secondary" onClick={() => void load()}>Try again</Button>} />
      ) : (
        <DataTable
          caption="Creative briefs"
          columns={columns}
          rows={rows ?? []}
          rowKey={(r) => r.id}
          loading={rows === null}
          empty={
            <EmptyState
              title="No briefs yet"
              body="A brief is one thing you want to promote. Tell us about it and we suggest ideas, write the ads and check them. You need a brand kit first."
              action={<LinkButton variant="primary" href="/app/creative/new">Start your first brief</LinkButton>}
            />
          }
        />
      )}
    </div>
  );
}
