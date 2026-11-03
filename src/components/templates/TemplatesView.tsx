"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Button, DataTable, EmptyState, ErrorState, Input, Select, StatusPill, apiFetch, buttonSizes, buttonVariants, cn, confirm, toast, type Column } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { friendlyError } from "@/components/contacts/helpers";
import { EDITABLE, STATUS_FILTERS, type StatusFilter, bodyText, categoryLabel, filterTemplates, languageLabel, templateStatusView } from "./helpers";

export type TemplateRow = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  rejectionReason: string | null;
  components: { type: string; text?: string }[];
  wabaRefId?: string;
  metaTemplateId?: string | null;
};

/**
 * What deleting a template removes. Meta deletes one language when it knows the template's id; without the id it deletes every
 * language of the name, and the other languages here go with it (lib/templates/service.ts deleteTemplate).
 */
export function deleteWarning(t: TemplateRow, all: readonly TemplateRow[]): string {
  if (t.status === "draft") return "This draft will be removed.";
  const others = t.metaTemplateId ? [] : all.filter((o) => o.id !== t.id && o.name === t.name && o.wabaRefId === t.wabaRefId && o.status !== "draft");
  const languages = others.length ? ` Meta deletes it in every language, so ${others.length === 1 ? "the other language" : `the ${others.length} other languages`} (${others.map((o) => languageLabel(o.language)).join(", ")}) will be deleted too.` : "";
  return `It will also be removed from your WhatsApp Business account at Meta.${languages} A template that a broadcast has used cannot be deleted.`;
}

const linkButton = cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap transition-colors duration-(--dur-fast)", buttonVariants.primary, buttonSizes.md, "max-sm:min-h-11");

export function TemplatesView() {
  const router = useRouter();
  const role = useRole();
  const admin = canManage(role);
  const { data, error, loading, reload, retry } = useApi<{ templates: TemplateRow[] }>("/api/templates");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  const all = data?.templates;
  const visible = useMemo(() => (all ? filterTemplates(all, q, status) : []), [all, q, status]);

  async function run(id: string, fn: () => Promise<unknown>, success: (r: unknown) => { title: string; description?: string }, failure: string) {
    setBusyId(id);
    try {
      const result = await fn();
      const message = success(result);
      toast.success(message.title, message.description ? { description: message.description } : undefined);
      reload();
    } catch (e) {
      toast.error(failure, { description: friendlyError(e, "Check your connection and try again.") });
    } finally {
      setBusyId(null);
    }
  }

  const sync = () =>
    run(
      "sync",
      () => apiFetch<{ synced: number; disabled?: number }>("/api/templates/sync", { method: "POST" }),
      (r) => {
        const { synced: count, disabled = 0 } = r as { synced: number; disabled?: number };
        const gone = disabled > 0 ? ` ${disabled} ${disabled === 1 ? "template was" : "templates were"} deleted in WhatsApp Manager, so ${disabled === 1 ? "it is" : "they are"} turned off here.` : "";
        return { title: "Templates are up to date", description: `${count} ${count === 1 ? "template" : "templates"} checked against your WhatsApp account.${gone}` };
      },
      "We could not update your templates from Meta",
    );

  const submit = (t: TemplateRow) =>
    run(
      t.id,
      () => apiFetch(`/api/templates/${t.id}/submit`, { method: "POST" }),
      () => ({ title: "Sent to Meta for review", description: "Review usually takes minutes to a day. The status updates here." }),
      `We could not send ${t.name} for review`,
    );

  async function duplicate(t: TemplateRow) {
    setBusyId(t.id);
    try {
      const { template } = await apiFetch<{ template: { id: string; name: string } }>(`/api/templates/${t.id}/duplicate`, { method: "POST" });
      toast.success("Copy created", {
        description: `${template.name} is saved as a draft. Edit it, then send it for review.`,
        action: { label: "Edit copy", onAction: () => router.push(`/app/templates/${template.id}`) },
      });
      reload();
    } catch (e) {
      toast.error(`We could not copy ${t.name}`, { description: friendlyError(e, "Check your connection and try again.") });
    } finally {
      setBusyId(null);
    }
  }

  const importRef = useRef<HTMLInputElement>(null);
  async function importFile(file: File | undefined) {
    if (!file) return;
    setBusyId("import");
    try {
      if (file.size > 200_000) throw new Error("That file is too large to be a template.");
      const body = JSON.parse(await file.text()) as Record<string, unknown>;
      const { template } = await apiFetch<{ template: { id: string } }>("/api/templates", { method: "POST", body });
      toast.success("Template imported", {
        description: "It is saved as a draft. Check it, then send it for review.",
        action: { label: "Open it", onAction: () => router.push(`/app/templates/${template.id}`) },
      });
      reload();
    } catch (e) {
      const unreadable = e instanceof SyntaxError;
      toast.error("We could not import that file", { description: unreadable ? "It is not a template file. Use a file downloaded from Templates." : friendlyError(e, "Check the file and try again.") });
    } finally {
      setBusyId(null);
      if (importRef.current) importRef.current.value = "";
    }
  }

  async function remove(t: TemplateRow) {
    const ok = await confirm({
      title: `Delete ${t.name}?`,
      body: deleteWarning(t, all ?? []),
      confirmLabel: "Delete template",
      tone: "danger",
    });
    if (ok) await run(t.id, () => apiFetch(`/api/templates/${t.id}`, { method: "DELETE" }), () => ({ title: "Template deleted" }), `We could not delete ${t.name}`);
  }

  const allColumns: Column<TemplateRow>[] = [
    {
      key: "name",
      header: "Template",
      primary: true,
      cell: (t) => (
        <span className="block min-w-0 max-sm:text-left">
          <Link href={`/app/templates/${t.id}`} className="block break-words font-medium text-accent-ink underline-offset-2 hover:underline">
            {t.name}
          </Link>
          <span className="mt-1 line-clamp-2 block text-xs font-normal text-muted">{bodyText(t) || (t.category === "AUTHENTICATION" ? "Meta's fixed login-code message" : "")}</span>
        </span>
      ),
    },
    { key: "category", header: "Type", cell: (t) => categoryLabel(t.category) },
    { key: "language", header: "Language", cell: (t) => languageLabel(t.language) },
    {
      key: "status",
      header: "Status",
      cell: (t) => {
        const view = templateStatusView(t.status, t.rejectionReason);
        return (
          <span className="flex max-w-64 flex-col items-start gap-1 max-sm:items-end max-sm:text-right">
            <StatusPill status={t.status} label={view.label} tone={view.tone} />
            {view.detail && <span className="text-xs text-muted">{view.detail}</span>}
          </span>
        );
      },
    },
    {
      key: "actions",
      header: "Actions",
      srOnlyHeader: true,
      align: "right",
      cell: (t) =>
        admin ? (
          <span className="flex flex-wrap justify-end gap-1">
            {EDITABLE.includes(t.status) && (
              <Link href={`/app/templates/${t.id}`} className={cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap max-sm:min-h-10", buttonVariants.ghost, buttonSizes.sm)} aria-label={`Edit ${t.name}`}>
                Edit
              </Link>
            )}
            {(t.status === "draft" || t.status === "rejected") && (
              <Button size="sm" variant="secondary" className="max-sm:min-h-10" loading={busyId === t.id} disabled={busyId !== null} onClick={() => void submit(t)} aria-label={`${t.status === "draft" ? "Send" : "Send again"} ${t.name} for review`}>
                {t.status === "draft" ? "Send for review" : "Send again"}
              </Button>
            )}
            <Button size="sm" variant="ghost" className="max-sm:min-h-10" disabled={busyId !== null} onClick={() => void duplicate(t)} aria-label={`Make a copy of ${t.name}`}>
              Copy
            </Button>
            <a href={`/api/templates/${t.id}`} download className={cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap max-sm:min-h-10", buttonVariants.ghost, buttonSizes.sm)} aria-label={`Download ${t.name} as a file`}>
              Download
            </a>
            <Button size="sm" variant="ghost" className="max-sm:min-h-10" disabled={busyId !== null} onClick={() => void remove(t)} aria-label={`Delete ${t.name}`}>
              Delete
            </Button>
          </span>
        ) : null,
    },
  ];
  const columns = admin ? allColumns : allColumns.filter((c) => c.key !== "actions");

  const hasTemplates = !!all && all.length > 0;
  const filtering = q.trim() !== "" || status !== "all";

  return (
    <div>
      <PageHeader
        title="Templates"
        description="Pre-approved messages. WhatsApp requires one whenever you message someone first or send a broadcast, and Meta must approve each template."
        actions={
          admin && (
            <>
              <Button variant="secondary" className="max-sm:min-h-11" loading={busyId === "sync"} disabled={busyId !== null} onClick={() => void sync()}>
                Update from Meta
              </Button>
              <Button variant="secondary" className="max-sm:min-h-11" loading={busyId === "import"} disabled={busyId !== null} onClick={() => importRef.current?.click()}>
                Import from a file
              </Button>
              <input ref={importRef} type="file" accept="application/json,.json" className="sr-only" tabIndex={-1} aria-label="Choose a template file to import" onChange={(e) => void importFile(e.target.files?.[0])} />
              <Link href="/app/templates/new" className={linkButton}>
                New template
              </Link>
            </>
          )
        }
      />

      {error ? (
        <ErrorState
          title="We could not load your templates"
          message={friendlyError(error, "Check your connection and try again.")}
          action={
            <Button variant="secondary" onClick={retry}>
              Try again
            </Button>
          }
        />
      ) : loading || hasTemplates ? (
        <>
          {hasTemplates && (
            <div className="mb-4 flex flex-wrap items-end gap-3" role="search" aria-label="Find templates">
              <div className="min-w-0 flex-[2_1_14rem]">
                <label htmlFor="tpl-search" className="mb-1 block text-sm font-medium">
                  Search
                </label>
                <Input id="tpl-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Template name or message text" autoComplete="off" />
              </div>
              <div className="min-w-0 flex-[1_1_10rem]">
                <label htmlFor="tpl-status" className="mb-1 block text-sm font-medium">
                  Show
                </label>
                <Select id="tpl-status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                  {STATUS_FILTERS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          )}
          <DataTable
            caption="Message templates"
            columns={columns}
            rows={visible}
            rowKey={(t) => t.id}
            loading={loading}
            empty={
              <EmptyState
                compact
                title={q.trim() ? `No templates match "${q.trim()}"` : "No templates in this view"}
                body="Try a different search or show all templates."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setQ("");
                      setStatus("all");
                    }}
                  >
                    Clear search
                  </Button>
                }
              />
            }
            footer={
              hasTemplates && (
                <p role="status" aria-live="polite" className="text-sm text-muted">
                  {filtering ? `Showing ${visible.length} of ${all.length} ${all.length === 1 ? "template" : "templates"}.` : `${all.length} ${all.length === 1 ? "template" : "templates"}.`}
                </p>
              )
            }
          />
        </>
      ) : (
        <EmptyState
          title="No templates yet"
          body={
            admin
              ? "A template is a message Meta has approved in advance. Create one to start broadcasts, or pull in the ones already on your WhatsApp Business account."
              : "Ask an owner or admin to create a template. You can use it once Meta approves it."
          }
          action={
            admin && (
              <>
                <Link href="/app/templates/new" className={linkButton}>
                  Create a template
                </Link>
                <Button variant="secondary" className="max-sm:min-h-11" loading={busyId === "sync"} onClick={() => void sync()}>
                  Update from Meta
                </Button>
              </>
            )
          }
        />
      )}
    </div>
  );
}
