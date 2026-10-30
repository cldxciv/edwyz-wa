"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { hasHost, mountHost, unmountHost } from "./host";

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  /** Name the action ("Delete contact"), not "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" focuses Cancel first and styles the confirm button red. */
  tone?: "default" | "danger";
};

type ConfirmDialogProps = ConfirmOptions & {
  open: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Controlled confirmation dialog. Prefer useConfirm() unless the confirm step must show progress. */
export function ConfirmDialog({ open, title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", tone = "default", busy, onConfirm, onCancel }: ConfirmDialogProps) {
  if (!open) return null;
  const danger = tone === "danger";
  return (
    <Dialog
      title={title}
      size="sm"
      role={danger ? "alertdialog" : "dialog"}
      onClose={onCancel}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy} data-autofocus={danger ? "" : undefined}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={busy} data-autofocus={danger ? undefined : ""}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body ? <div className="text-sm text-muted">{body}</div> : null}
    </Dialog>
  );
}

type Pending = ConfirmOptions & { id: number; resolve: (ok: boolean) => void };

let queue: Pending[] = [];
let seq = 0;
let providers = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Resolves true when the user confirms, false on cancel, Escape or backdrop click. Requests queue one after another. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);
  if (providers === 0 && !hasHost("confirm")) mountHost("confirm", <ConfirmHost />);
  return new Promise<boolean>((resolve) => {
    queue = [...queue, { ...options, id: ++seq, resolve }];
    emit();
  });
}

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return confirm;
}

function ConfirmHost() {
  const head = useSyncExternalStore(subscribe, () => queue[0] ?? null, () => null);
  if (!head) return null;

  function settle(ok: boolean) {
    if (!head || queue[0] !== head) return;
    queue = queue.slice(1);
    head.resolve(ok);
    emit();
  }

  const { id, resolve: _resolve, ...options } = head;
  return <ConfirmDialog key={id} open {...options} onConfirm={() => settle(true)} onCancel={() => settle(false)} />;
}

/** Optional. Renders the confirm host inside your React tree instead of the lazily created one. */
export function ConfirmProvider({ children }: { children?: ReactNode }) {
  useEffect(() => {
    providers++;
    unmountHost("confirm");
    return () => void providers--;
  }, []);
  return (
    <>
      {children}
      <ConfirmHost />
    </>
  );
}
