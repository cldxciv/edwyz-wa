"use client";

import { PageHeader } from "@/components/app/PageHeader";
import { Card, CopyButton, EmptyState } from "@/components/ui";
import { RoleGate } from "@/components/team/RoleGate";
import { DOC_SNIPPETS } from "./helpers";
import { KeysSection } from "./KeysSection";
import { WebhooksSection } from "./WebhooksSection";

function Docs() {
  return (
    <Card title="Developer guide" description="Examples your developer can copy. Replace the capitalised placeholders with your own values.">
      <details className="group">
        <summary className="flex min-h-10 cursor-pointer items-center text-sm font-semibold text-accent-ink">Show examples</summary>
        <p className="mt-2 text-sm text-muted">
          Send your key in the header <code className="rounded bg-surface-2 px-1 py-0.5 text-xs">Authorization: Bearer YOUR_API_KEY</code>. Each key can make 60 requests per minute.
        </p>
        <p className="mt-2 text-sm text-muted">
          The full reference lists every endpoint, webhook event and error.{" "}
          <a href="/docs" target="_blank" rel="noreferrer" className="text-accent-ink underline underline-offset-2">
            Open the API documentation
          </a>{" "}
          or{" "}
          <a href="/docs/openapi.json" target="_blank" rel="noreferrer" className="text-accent-ink underline underline-offset-2">
            download the OpenAPI file
          </a>{" "}
          for your developer or code generator.
        </p>
        {DOC_SNIPPETS.map((s) => (
          <div key={s.title} className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{s.title}</h3>
              <CopyButton value={s.code} label="Copy example" className="max-sm:min-h-10" />
            </div>
            <pre tabIndex={0} role="region" aria-label={`${s.title} example`} className="mt-1 max-w-full overflow-x-auto rounded-control border border-border bg-surface p-3 text-xs">
              <code>{s.code}</code>
            </pre>
          </div>
        ))}
      </details>
    </Card>
  );
}

export function ApiSettings() {
  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="API and webhooks" description="Connect your own software: send messages, keep contacts in sync and get told when something happens." />
      <RoleGate
        loadingLabel="Loading"
        skeletonClass="h-40"
        denied={<EmptyState title="Only owners and admins can use this page" body="API keys can act on the whole account, so we keep them with owners and admins. Ask one of them to set this up." />}
      >
        <div className="space-y-6">
          <KeysSection />
          <WebhooksSection />
          <Docs />
        </div>
      </RoleGate>
    </div>
  );
}
