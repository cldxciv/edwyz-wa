"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Card, EmptyState, ErrorState, Skeleton, StatusPill, apiFetch, buttonSizes, buttonVariants, cn, toast } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { friendlyError } from "@/components/contacts/helpers";
import { Preview } from "./Preview";
import { TemplateEditor } from "./TemplateEditor";
import { EDITABLE, categoryLabel, draftFromTemplate, groupedButtons, languageLabel, templateStatusView } from "./helpers";

type TemplateRecord = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  rejectionReason: string | null;
  components: unknown;
  headerMedia: unknown;
  atMeta: boolean;
};

const linkButton = (variant: "primary" | "secondary" | "ghost") => cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap max-sm:min-h-11", buttonVariants[variant], buttonSizes.md);
const BACK = { label: "Templates", href: "/app/templates" };

/** Why a template that is not a draft or rejected cannot be changed here, and what to do instead. */
function lockedNote(status: string): string {
  if (status === "pending") return "Meta is reviewing this template, so it cannot be changed now. Make a copy if you want a different version.";
  if (status === "approved") return "Meta approved this wording. To change it, make a copy, edit the copy and send it for review.";
  return "This template cannot be changed here. Make a copy, edit the copy and send it for review.";
}

/**
 * The page of one template. Owners and admins edit a draft or a rejected template in place; every other template (and every
 * template for agents) is shown read-only with its parts, a preview and, for admins, Make a copy and Download.
 */
export function TemplateDetail({ id }: { id: string }) {
  const router = useRouter();
  const role = useRole();
  const admin = canManage(role);
  const { data, error, loading, retry } = useApi<{ template: TemplateRecord }>(`/api/templates/${encodeURIComponent(id)}?details=1`);
  const [copying, setCopying] = useState(false);

  if (error && !data) {
    if (/not found/i.test(error)) {
      return (
        <div>
          <PageHeader title="Template not found" breadcrumbs={[BACK, { label: "Not found" }]} />
          <EmptyState
            title="This template does not exist"
            body="It may have been deleted, or the link is wrong."
            action={
              <Link href="/app/templates" className={linkButton("primary")}>
                Back to templates
              </Link>
            }
          />
        </div>
      );
    }
    return (
      <div>
        <PageHeader title="Template" breadcrumbs={[BACK, { label: "Not available" }]} />
        <ErrorState
          title="We could not load this template"
          message={friendlyError(error, "Check your connection and try again.")}
          action={
            <Button variant="secondary" onClick={retry}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  // Waits for the role too, so the editor mounts once with the saved template instead of flashing the read-only view.
  if (loading || !data || role === null) {
    return (
      <div aria-busy="true">
        <PageHeader title="Template" breadcrumbs={[BACK, { label: "Loading" }]} />
        <span className="sr-only" role="status">
          Loading template
        </span>
        <Skeleton className="mb-4 h-40 w-full max-w-3xl" />
        <Skeleton className="h-64 w-full max-w-3xl" />
      </div>
    );
  }

  const t = data.template;
  const draft = draftFromTemplate(t);
  if (admin && EDITABLE.includes(t.status)) {
    return <TemplateEditor editing={{ id: t.id, draft, status: t.status, rejectionReason: t.rejectionReason, atMeta: t.atMeta }} />;
  }

  const view = templateStatusView(t.status, t.rejectionReason);
  const auth = draft.category === "AUTHENTICATION";
  const buttons = groupedButtons(draft.buttons);

  async function copy() {
    setCopying(true);
    try {
      const { template } = await apiFetch<{ template: { id: string; name: string } }>(`/api/templates/${t.id}/duplicate`, { method: "POST" });
      toast.success("Copy created", { description: `${template.name} is a draft. Change it here, then send it for review.` });
      router.push(`/app/templates/${template.id}`);
    } catch (e) {
      toast.error(`We could not copy ${t.name}`, { description: friendlyError(e, "Check your connection and try again.") });
      setCopying(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t.name}
        breadcrumbs={[BACK, { label: t.name }]}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusPill status={t.status} label={view.label} tone={view.tone} />
            <span>{categoryLabel(t.category)}</span>
            <span>{languageLabel(t.language)}</span>
          </span>
        }
        actions={
          admin && (
            <>
              <Button variant="secondary" className="max-sm:min-h-11" loading={copying} onClick={() => void copy()}>
                Make a copy
              </Button>
              <a href={`/api/templates/${t.id}`} download className={linkButton("ghost")} aria-label={`Download ${t.name} as a file`}>
                Download
              </a>
            </>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-5">
          {view.detail && (
            <Alert tone={view.tone === "neutral" ? "info" : view.tone} title={view.label}>
              {view.detail}
            </Alert>
          )}
          {admin && <p className="text-sm text-muted">{lockedNote(t.status)}</p>}
          <Card title="What it contains">
            <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
              {auth ? (
                <>
                  <dt className="font-medium">Message</dt>
                  <dd className="min-w-0">Meta&apos;s fixed login-code message{draft.securityNote ? ", with the security note" : ""}.</dd>
                  <dt className="font-medium">Code expiry</dt>
                  <dd>{draft.codeExpiry ? `${draft.codeExpiry} minutes` : "Not shown"}</dd>
                  <dt className="font-medium">Button</dt>
                  <dd className="min-w-0 break-words">{draft.copyCodeLabel} (copies the code)</dd>
                </>
              ) : (
                <>
                  <dt className="font-medium">Header</dt>
                  <dd className="min-w-0 break-words">{draft.headerKind !== "TEXT" ? `${draft.headerKind.charAt(0)}${draft.headerKind.slice(1).toLowerCase()} file` : draft.header || "None"}</dd>
                  <dt className="font-medium">Message</dt>
                  <dd className="min-w-0 whitespace-pre-wrap break-words">{draft.body || "None"}</dd>
                  <dt className="font-medium">Footer</dt>
                  <dd className="min-w-0 break-words">{draft.footer || "None"}</dd>
                  <dt className="font-medium">Buttons</dt>
                  <dd className="min-w-0">
                    {buttons.length === 0 ? (
                      "None"
                    ) : (
                      <ul className="space-y-1">
                        {buttons.map((b, i) => (
                          <li key={i} className="break-words">
                            {b.text || "(no label)"}: {b.type === "URL" ? `opens ${b.url}` : b.type === "PHONE_NUMBER" ? `calls ${b.phone}` : "sends a quick reply"}
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </>
              )}
            </dl>
          </Card>
        </div>
        <aside className="min-w-0 lg:sticky lg:top-6 lg:self-start">
          <h2 className="mb-2 text-sm font-semibold">Preview</h2>
          <Preview draft={draft} />
          <p className="mt-2 text-xs text-muted">Approximate, with Meta&apos;s sample values. WhatsApp may show it slightly differently.</p>
        </aside>
      </div>
    </div>
  );
}
