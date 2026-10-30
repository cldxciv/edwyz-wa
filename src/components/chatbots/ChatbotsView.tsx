"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Alert, Button, DataTable, EmptyState, ErrorState, StatusPill, apiFetch, confirm, toast, type Column } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { humanError, publishFailure } from "@/components/automation/helpers";
import { linkButton } from "@/components/automation/linkButton";
import { TRIGGER_LABEL } from "./editor";
import { StarterGallery } from "./StarterGallery";
import type { ChatbotSummary } from "./types";

type Action = "publish" | "unpublish" | "duplicate" | "delete";

const LAST_CHANGED = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function startsWhen(b: ChatbotSummary): string {
  if (b.triggerType !== "keyword" || b.triggerKeywords.length === 0) return TRIGGER_LABEL[b.triggerType];
  const shown = b.triggerKeywords.slice(0, 4).join(", ");
  return `Words: ${shown}${b.triggerKeywords.length > 4 ? ` +${b.triggerKeywords.length - 4} more` : ""}`;
}

const DONE: Record<Action, (name: string) => string> = {
  publish: (n) => `"${n}" is live. New matching conversations will use it.`,
  unpublish: (n) => `"${n}" is unpublished.`,
  duplicate: (n) => `A copy of "${n}" was created as a draft.`,
  delete: (n) => `"${n}" was deleted.`,
};

const FAILED: Record<Action, string> = {
  publish: "publish this chatbot",
  unpublish: "unpublish this chatbot",
  duplicate: "copy this chatbot",
  delete: "delete this chatbot",
};

export function ChatbotsView() {
  const role = useRole();
  const editable = canManage(role);
  const { data, error, loading, reload } = useApi<{ chatbots: ChatbotSummary[] }>("/api/chatbots");
  const router = useRouter();
  const [busy, setBusy] = useState<{ id: string; action: Action } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const bots = useMemo(() => data?.chatbots ?? [], [data]);

  async function run(bot: ChatbotSummary, action: Action) {
    if (action === "delete") {
      const ok = await confirm({
        title: `Delete "${bot.name}"?`,
        body: "The chatbot and all of its steps are removed for good. Customers will stop getting its replies.",
        confirmLabel: "Delete chatbot",
        tone: "danger",
      });
      if (!ok) return;
    }
    if (action === "unpublish") {
      const ok = await confirm({
        title: `Unpublish "${bot.name}"?`,
        body: "Customers will stop getting this bot's replies. You can publish it again at any time.",
        confirmLabel: "Unpublish chatbot",
      });
      if (!ok) return;
    }
    setBusy({ id: bot.id, action });
    try {
      if (action === "delete") await apiFetch(`/api/chatbots/${bot.id}`, { method: "DELETE" });
      else await apiFetch(`/api/chatbots/${bot.id}/${action}`, { method: "POST", body: {} });
      toast.success(DONE[action](bot.name));
      reload();
      // The row that held the keyboard focus is about to disappear. Park the focus on the list instead of the top of the page.
      if (action === "delete") listRef.current?.focus();
    } catch (e) {
      if (action === "publish") {
        const failure = publishFailure(e, bot.name);
        toast.error(failure.message, failure.kind === "invalid" ? { action: { label: "Open chatbot", onAction: () => router.push(`/app/automation/chatbots/${bot.id}`) } } : undefined);
      } else toast.error(humanError(e, FAILED[action]));
    } finally {
      setBusy(null);
    }
  }

  const columns: Column<ChatbotSummary>[] = [
    {
      key: "name",
      header: "Chatbot",
      primary: true,
      sortable: true,
      accessor: (b) => b.name.toLowerCase(),
      cell: (b) => (
        <Link href={`/app/automation/chatbots/${b.id}`} className="font-semibold underline-offset-2 hover:underline">
          {b.name}
        </Link>
      ),
    },
    { key: "status", header: "Status", sortable: true, accessor: (b) => b.status, cell: (b) => <StatusPill status={b.status} /> },
    { key: "when", header: "Starts", cell: (b) => <span className="text-muted">{startsWhen(b)}</span> },
    {
      key: "updated",
      header: "Last changed",
      sortable: true,
      accessor: (b) => new Date(b.updatedAt),
      cell: (b) => <span className="text-muted">{LAST_CHANGED.format(new Date(b.updatedAt))}</span>,
    },
    {
      key: "actions",
      header: "Actions",
      srOnlyHeader: true,
      cell: (b) => {
        const rowBusy = busy?.id === b.id;
        const loadingFor = (a: Action) => rowBusy && busy?.action === a;
        const touch = "max-sm:min-h-10";
        return (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <Link href={`/app/automation/chatbots/${b.id}`} aria-label={`${editable ? "Edit" : "View"} ${b.name}`} className={linkButton("secondary", "sm", touch)}>
              {editable ? "Edit" : "View"}
            </Link>
            {editable && (
              <>
                {b.status === "published" ? (
                  <Button size="sm" variant="secondary" className={touch} aria-label={`Unpublish ${b.name}`} loading={loadingFor("unpublish")} disabled={rowBusy} onClick={() => void run(b, "unpublish")}>
                    Unpublish
                  </Button>
                ) : b.status === "archived" ? null : (
                  <Button size="sm" variant="secondary" className={touch} aria-label={`Publish ${b.name}`} loading={loadingFor("publish")} disabled={rowBusy} onClick={() => void run(b, "publish")}>
                    Publish
                  </Button>
                )}
                <Button size="sm" variant="ghost" className={touch} aria-label={`Duplicate ${b.name}`} loading={loadingFor("duplicate")} disabled={rowBusy} onClick={() => void run(b, "duplicate")}>
                  Duplicate
                </Button>
                <Button size="sm" variant="ghost" className={`${touch} text-bad-fg`} aria-label={`Delete ${b.name}`} loading={loadingFor("delete")} disabled={rowBusy} onClick={() => void run(b, "delete")}>
                  Delete
                </Button>
              </>
            )}
          </div>
        );
      },
    },
  ];

  const isEmpty = Boolean(data) && bots.length === 0;

  return (
    <div>
      <PageHeader
        title="Chatbots"
        description="Chatbots answer customers automatically with buttons, menus and questions, and hand over to your team when they cannot help."
        actions={
          <>
            <Link href="/app/automation" className={linkButton("secondary", "md")}>
              Auto-replies
            </Link>
            {editable && (
              <Link href="/app/automation/chatbots/new" className={linkButton("primary", "md")}>
                New chatbot
              </Link>
            )}
          </>
        }
      />
      {role && !editable && (
        <Alert tone="info" className="mb-4">
          You can look at chatbots. Only admins and owners can change them.
        </Alert>
      )}

      <div ref={listRef} tabIndex={-1} role="region" aria-label="Your chatbots">
      {error && !data ? (
        <ErrorState title="We could not load your chatbots" message="Check your connection and try again." action={<Button onClick={reload}>Try again</Button>} />
      ) : isEmpty ? (
        <div className="space-y-8">
          <EmptyState
            title="No chatbots yet"
            body="A chatbot greets customers, answers common questions and passes the chat to your team. Start from a ready-made one below, or build your own."
            action={
              editable ? (
                <Link href="/app/automation/chatbots/new" className={linkButton("primary", "md")}>
                  Create a chatbot
                </Link>
              ) : undefined
            }
          />
          {editable && (
            <section aria-labelledby="starter-heading">
              <h2 id="starter-heading" className="mb-3 text-base font-semibold">
                Start from a template
              </h2>
              <StarterGallery hrefFor={(s) => `/app/automation/chatbots/new?starter=${s.id}`} />
            </section>
          )}
        </div>
      ) : (
        <DataTable caption="Your chatbots" columns={columns} rows={bots} rowKey={(b) => b.id} loading={loading && !data} skeletonRows={3} defaultSort={{ key: "updated", dir: "desc" }} />
      )}
      </div>
    </div>
  );
}
