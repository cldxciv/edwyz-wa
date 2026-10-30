"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, DataTable, EmptyState, ErrorState, FormField, Select, apiFetch, type Column } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { useApi } from "@/components/contacts/hooks";
import { humanError } from "./helpers";
import { linkButton } from "./linkButton";
import { OUTCOME_LABEL, relativeTime, type RuleRow } from "./rulesV2";

type Item = { id: string; ruleId: string; ruleName: string; conversationId: string | null; contactName: string | null; outcome: string; detail: string | null; createdAt: string };
type Page = { items: Item[]; nextCursor: string | null };

/** What each rule did, newest first. Skipped runs say why, so "why did my rule not reply?" has an answer. */
export function ExecutionLog({ initialRuleId }: { initialRuleId?: string }) {
  const rules = useApi<{ rules: RuleRow[] }>("/api/automation");
  const [ruleId, setRuleId] = useState(initialRuleId ?? "");
  const [outcome, setOutcome] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const query = useMemo(() => {
    const q = new URLSearchParams({ limit: "30" });
    if (ruleId) q.set("ruleId", ruleId);
    if (outcome) q.set("outcome", outcome);
    return q;
  }, [ruleId, outcome]);

  const load = useCallback(
    async (after: string | null) => {
      const q = new URLSearchParams(query);
      if (after) q.set("cursor", after);
      return apiFetch<Page>(`/api/automation/executions?${q.toString()}`);
    },
    [query],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    load(null)
      .then((page) => {
        if (!live) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((e) => live && setError(humanError(e, "load the history")))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [load, attempt]);

  async function loadMore() {
    if (!cursor) return;
    setMore(true);
    try {
      const page = await load(cursor);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(humanError(e, "load more"));
    } finally {
      setMore(false);
    }
  }

  const columns: Column<Item>[] = [
    { key: "when", header: "When", primary: true, cell: (r) => <span title={new Date(r.createdAt).toLocaleString()}>{relativeTime(r.createdAt)}</span> },
    { key: "rule", header: "Rule", cell: (r) => <span className="font-medium">{r.ruleName}</span> },
    { key: "who", header: "Customer", cell: (r) => (r.contactName ? <span>{r.contactName}</span> : <span className="text-muted">-</span>) },
    {
      key: "result",
      header: "Result",
      cell: (r) => {
        const o = OUTCOME_LABEL[r.outcome] ?? OUTCOME_LABEL.ok;
        return <Badge tone={o.tone} dot>{o.label}</Badge>;
      },
    },
    { key: "detail", header: "What happened", cell: (r) => <span className="line-clamp-3 max-w-md text-sm text-muted">{r.detail ?? "-"}</span> },
  ];

  const selectedName = rules.data?.rules.find((r) => r.id === ruleId)?.name;

  return (
    <div>
      <PageHeader
        title="Rule history"
        description="Every time a rule ran, was skipped or ran into a problem. History is kept for 90 days."
        actions={
          <Link href="/app/automation" className={linkButton("secondary", "md")}>
            All rules
          </Link>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
        <FormField label="Rule">
          <Select value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
            <option value="">All rules</option>
            {rules.data?.rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Result">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">All results</option>
            <option value="ok">Ran</option>
            <option value="skipped">Skipped</option>
            <option value="failed">Failed</option>
          </Select>
        </FormField>
      </div>
      {error && items.length === 0 ? (
        <ErrorState title="We could not load the history" message={error} action={<Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>} />
      ) : (
        <>
          <DataTable
            caption="Rule history"
            columns={columns}
            rows={items}
            rowKey={(r) => r.id}
            loading={loading}
            skeletonRows={5}
            empty={<EmptyState compact title={ruleId || outcome ? "Nothing matches these filters" : "No rule history yet"} body={selectedName ? `"${selectedName}" has not run yet.` : "When a rule runs, you will see it here with what it did."} />}
          />
          {error && <Alert tone="bad" className="mt-3">{error}</Alert>}
          {cursor && (
            <div className="mt-4 text-center">
              <Button variant="secondary" loading={more} onClick={() => void loadMore()}>
                Show older history
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
