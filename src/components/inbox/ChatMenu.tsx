"use client";
import { useEffect, useRef, useState } from "react";
import { Button, toast } from "@/components/ui";

/** The "More" menu in the chat header: mark as unread, copy the link, download the chat. */
export function ChatMenu({ conversationId, onMarkUnread }: { conversationId: string; onMarkUnread: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

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

  async function copyLink() {
    setOpen(false);
    const url = `${window.location.origin}/app/inbox?c=${encodeURIComponent(conversationId)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied. Teammates with access can open this chat from it.");
    } catch {
      toast.error("We could not copy the link. Copy it from the address bar instead.");
    }
  }

  const download = (format: "txt" | "json", notes: boolean) => `/api/inbox/conversations/${encodeURIComponent(conversationId)}/export?format=${format}${notes ? "&notes=1" : ""}`;
  const item = "block w-full rounded-control px-3 py-2 text-left text-sm hover:bg-surface-2";

  return (
    <div ref={box} className="relative">
      <Button variant="secondary" size="sm" aria-expanded={open} aria-haspopup="true" aria-label="More actions" onClick={() => setOpen((v) => !v)}>
        More
      </Button>
      {open && (
        <div role="menu" aria-label="More actions" className="absolute right-0 top-full z-(--z-popover) mt-1 w-60 rounded-pop border border-border bg-raised p-1 shadow-pop">
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onMarkUnread(); }}>Mark as unread</button>
          <button type="button" role="menuitem" className={item} onClick={() => void copyLink()}>Copy link to this chat</button>
          <a role="menuitem" className={item} href={download("txt", false)} download onClick={() => setOpen(false)}>Download chat (text)</a>
          <a role="menuitem" className={item} href={download("json", false)} download onClick={() => setOpen(false)}>Download chat (JSON)</a>
          <a role="menuitem" className={item} href={download("txt", true)} download onClick={() => setOpen(false)}>Download with internal notes</a>
        </div>
      )}
    </div>
  );
}
