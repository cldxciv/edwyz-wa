"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { canManage, useRole } from "@/components/contacts/hooks";
import { MCP_TOOL_LIST, mcpSnippets, withScopeNames } from "./helpers";

function CopyBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <Button size="sm" variant="secondary" onClick={() => void copy()} aria-label={`Copy ${title}`}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {/* Wide snippets scroll sideways on phones, so the block is focusable and keyboard users can scroll it too. */}
      <pre tabIndex={0} role="region" aria-label={title} className="mt-2 overflow-x-auto rounded-lg bg-surface p-3 text-xs"><code>{code}</code></pre>
    </div>
  );
}

export function McpSettings() {
  const role = useRole();
  if (role === null) return <Spinner label="Loading" />;
  if (!canManage(role)) return <EmptyState title="Owners and admins only" body="Ask an owner or admin to set up the MCP connection." />;

  const url = `${window.location.origin}/api/mcp`;
  const snippets = mcpSnippets(url);

  return (
    <div className="space-y-6">
      <PageHeader title="MCP connection" description="Let an AI assistant such as Claude read your inbox and take careful actions in this workspace." />

      <Card>
        <h2 className="text-base font-semibold">Endpoint</h2>
        <code className="mt-2 block break-all rounded-lg bg-surface p-3 text-sm" data-testid="mcp-url">{url}</code>
        <p className="mt-2 text-sm text-muted">Streamable HTTP, JSON-RPC 2.0. Authenticate with an API key as a bearer token. Limit: 60 calls per minute per key.</p>
      </Card>

      <Card>
        <h2 className="text-base font-semibold">1. Create an API key</h2>
        <p className="mt-1 text-sm text-muted">
          Open <Link className="underline" href="/app/settings/api">API and webhooks</Link>{" "}and create a key just for this assistant. Pick only what it needs:
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li><code>{withScopeNames("conversations:read")}</code>: read conversations and messages, and draft replies.</li>
          <li><code>{withScopeNames("contacts:read")}</code>: read contacts and reports. It also still reads conversations, for keys made before the conversation permissions existed.</li>
          <li><code>{withScopeNames("templates:read")}</code>: list templates, and draft template messages.</li>
          <li><code>{withScopeNames("conversations:write")}</code>: change conversation status and assign conversations.</li>
          <li><code>{withScopeNames("contacts:write")}</code>: add tags, and also manage conversations.</li>
          <li><code>{withScopeNames("messages:write")}</code>: actually send (only when the assistant passes confirm) and create broadcast drafts.</li>
        </ul>
        <p className="mt-2 text-sm text-muted">For a read-only assistant, leave out <code>messages:write</code>, <code>conversations:write</code> and <code>contacts:write</code>. Tools a key cannot use are hidden from it.</p>
      </Card>

      <Card>
        <h2 className="text-base font-semibold">2. Connect your assistant</h2>
        <p className="mt-1 text-sm text-muted">Replace YOUR_API_KEY with the key. Keep it secret; do not paste it into shared chats.</p>
        {snippets.map((s) => <CopyBlock key={s.title} title={s.title} code={s.code} />)}
      </Card>

      <Card>
        <h2 className="text-base font-semibold">Tools</h2>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr><th className="py-1 pr-3">Tool</th><th className="pr-3">What it does</th><th>Scope</th></tr>
            </thead>
            <tbody>
              {MCP_TOOL_LIST.map((t) => (
                <tr key={t.name} className="border-t border-border align-top">
                  <td className="py-1.5 pr-3 font-mono text-xs">{t.name}</td>
                  <td className="pr-3">{t.description}</td>
                  <td className="font-mono text-xs">{withScopeNames(t.scope)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <h2 className="text-base font-semibold">Safety</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li>Everything runs inside this workspace only, with the permissions of the key you create. Revoke the key to cut access at once.</li>
          <li>Sending tools return a draft and a short-lived <code>confirmToken</code> tied to that key, tool and exact content. A message is sent only when the assistant calls again with confirm set to true, that token, and the key has <code>messages:write</code>.</li>
          <li>
            <strong>Only give <code>messages:write</code> keys to clients that make you approve each tool call.</strong>{" "}The token forces a second call but cannot prove a person approved it: a client that runs tools on its own can be steered by text a customer sends.
          </li>
          <li>Confirmed sends are capped per key (20 per hour) and per contact (3 per 24 hours) by default, and customer text returned to the assistant is wrapped in untrusted-text markers.</li>
          <li>Free text can only be sent inside the 24-hour window; otherwise only approved templates. Opted-out contacts are never messaged, and marketing templates need opt-in.</li>
          <li>Broadcasts can only be saved as drafts. A person must review and start them here in the app.</li>
          <li>Customer messages are untrusted text. A customer could write instructions aimed at your assistant, so keep confirmation on and review drafts before approving.</li>
          <li>Changes made through MCP are recorded in the audit log with the key prefix. Message content is not written to server logs.</li>
        </ul>
      </Card>
    </div>
  );
}
