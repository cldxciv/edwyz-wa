"use client";

import { useState } from "react";
import { Alert, Button, CopyButton, Dialog, confirm } from "@/components/ui";

/**
 * One-time reveal for an API key or signing secret. The value is never shown again, so closing without copying asks first.
 */
export function SecretDialog({
  title,
  intro,
  value,
  lostHint,
  onClose,
}: {
  title: string;
  intro: string;
  value: string;
  lostHint: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function close() {
    if (!copied) {
      const ok = await confirm({
        title: "Close without copying?",
        body: lostHint,
        confirmLabel: "Close anyway",
        cancelLabel: "Go back and copy",
        tone: "danger",
      });
      if (!ok) return;
    }
    onClose();
  }

  return (
    <Dialog
      title={title}
      description={intro}
      onClose={() => void close()}
      footer={
        <>
          <CopyButton value={value} label="Copy to clipboard" copiedLabel="Copied" variant={copied ? "secondary" : "primary"} size="md" onCopied={() => setCopied(true)} />
          <Button variant={copied ? "primary" : "secondary"} onClick={() => void close()}>
            {copied ? "Done" : "Close"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Alert tone="warn" title="Copy it now. You will not see it again.">
          {lostHint}
        </Alert>
        <code data-testid="secret" className="block select-all break-all rounded-control border border-border bg-surface p-3 font-mono text-sm" data-autofocus tabIndex={0}>
          {value}
        </code>
        <p className="text-xs text-muted">Keep it private, like a password. Do not put it in emails, chats or public code.</p>
      </div>
    </Dialog>
  );
}
