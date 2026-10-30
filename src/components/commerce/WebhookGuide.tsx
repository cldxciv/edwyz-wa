"use client";

import { useState } from "react";
import { CopyButton } from "@/components/ui";
import { WEBHOOKS } from "./helpers";

/**
 * Exact steps for adding the three Shopify webhooks. Shopify calls them "webhooks"; the page says what each one does so the
 * word is not a barrier. The tick boxes only help the person keep their place and are not saved.
 */
export function WebhookGuide({ url }: { url: string }) {
  const [done, setDone] = useState<Record<string, boolean>>({});
  const count = WEBHOOKS.filter((w) => done[w.topic]).length;

  return (
    <div className="space-y-4 text-sm">
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          In your Shopify admin, open <strong>Settings</strong>, then <strong>Notifications</strong>.
        </li>
        <li>
          Scroll to the <strong>Webhooks</strong> section and choose <strong>Create webhook</strong>.
        </li>
        <li>
          Add the three webhooks below, one at a time. Each one uses format <strong>JSON</strong>, the newest API version, and the same address.
        </li>
      </ol>

      <div>
        <p className="mb-1.5 font-medium">
          Address to paste into every webhook
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-control border border-border bg-surface px-3 py-2 text-xs">
            {url || "Loading address"}
          </code>
          {url && <CopyButton value={url} label="Copy address" copiedLabel="Address copied" size="md" />}
        </div>
      </div>

      <fieldset>
        <legend className="mb-1.5 font-medium">
          The three webhooks <span className="font-normal text-muted">({count} of {WEBHOOKS.length} added)</span>
        </legend>
        <ul className="space-y-2">
          {WEBHOOKS.map((w) => (
            <li key={w.topic} className="flex items-start gap-3 rounded-control border border-border bg-surface p-3">
              <input
                id={`webhook-${w.topic}`}
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-accent"
                checked={!!done[w.topic]}
                onChange={(e) => setDone((d) => ({ ...d, [w.topic]: e.target.checked }))}
              />
              <label htmlFor={`webhook-${w.topic}`} className="min-w-0">
                <span className="block font-medium">
                  Event: {w.event}
                </span>
                <span className="block text-muted">{w.why}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    </div>
  );
}
