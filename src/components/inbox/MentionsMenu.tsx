"use client";
import { useEffect, useRef, useState } from "react";
import { apiFetch, Button, cn } from "@/components/ui";
import { displayName } from "@/lib/contacts/identity";
import { relativeTime } from "./helpers";
import type { Mention } from "./types";
import { usePolling } from "./usePolling";

/** The in-app notice for @mentions: teammates who mentioned you in a note, until you open that chat. */
export function MentionsMenu({ onOpen, refreshKey }: { onOpen: (conversationId: string) => void; refreshKey: number }) {
  const [items, setItems] = useState<Mention[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = async () => {
    const r = await apiFetch<{ mentions: Mention[] }>("/api/inbox/mentions");
    setItems(r.mentions);
  };
  usePolling(load, 15_000);
  useEffect(() => {
    if (refreshKey > 0) void load().catch(() => undefined);
  }, [refreshKey]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <Button variant="ghost" size="sm" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((v) => !v)}>
        Mentions
        {items.length > 0 && <span className="ml-1 rounded-full bg-accent px-1.5 text-[10px] font-semibold text-on-accent" aria-label={`${items.length} unread`}>{items.length}</span>}
      </Button>
      {open && (
        <div role="region" aria-label="Your mentions" className="absolute right-0 top-full z-(--z-popover) mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-pop border border-border bg-raised p-2 shadow-pop">
          {items.length === 0 ? (
            <p className="p-2 text-sm text-muted">No new mentions. When a teammate writes @your name in a note, it shows up here.</p>
          ) : (
            <ul className="space-y-1">
              {items.map((m) => (
                <li key={m.conversationId}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onOpen(m.conversationId);
                    }}
                    className={cn("flex w-full items-center justify-between gap-3 rounded-control px-3 py-2 text-left text-sm hover:bg-surface-2")}
                  >
                    <span className="truncate font-medium">{displayName({ name: m.contactName, phone: m.phone, bsuid: m.bsuid, username: m.username })}</span>
                    <span className="shrink-0 text-xs text-muted">{relativeTime(m.mentionedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
