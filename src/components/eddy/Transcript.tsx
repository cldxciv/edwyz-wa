"use client";

/**
 * Eddy's transcript (docs/EDDY-SPEC.md 6.3, 6.4, 6.13, 12.1a decision 0).
 *
 * - `role="log" aria-live="off"`: streaming text is never read out token by token.
 * - A separate screen-reader-only `role="status" aria-live="polite" aria-atomic="true"` region announces each finished
 *   reply ("Eddy replied: " plus the first 140 characters), each new card ("Preview ready: … Send reply or cancel."), each
 *   done row, refusal and error. Items already on screen when the transcript mounts are not announced again.
 * - Items render through the cards package (MessageView, PreviewCard via CardController, ResultRow), so replies are always
 *   richly styled: markdown, cards with buttons, status chips, cost, undo bars and progress steps.
 * - An activity line (muted) shows while Eddy works, from progress notes or the tool's activity label.
 * - After a card is confirmed or an undo lands, pages are told through `wa:eddy-did {entity, ids}` (6.4).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { tp } from "@/lib/eddy/copy/panel";
import { htmlLang, t, translateKey, type EddyLang } from "@/lib/eddy/i18n";
import { cutGraphemes } from "./CustomerQuote";
import { announceEddyDid, type EddyEntity } from "./events";
import { errorText, MessageView, type TranscriptItem } from "./MessageView";
import { cardAnnouncement, refusalText } from "./PreviewCard";
import { markdownPlainText } from "./SafeMarkdown";
import { entityForAction, targetIdsOf, type Activity } from "./useEddyStream";

/** "Eddy replied: " carries at most this many characters of the reply (6.3). */
export const ANNOUNCE_REPLY_CHARS = 140;

function itemAnnouncement(item: TranscriptItem): string | null {
  switch (item.kind) {
    case "eddy": {
      if (item.interrupted) return t(item.lang, "interrupted");
      const plain = markdownPlainText(item.text).replace(/\s+/g, " ").trim();
      return plain ? t(item.lang, "a11y.eddy_replied", { text: cutGraphemes(plain, ANNOUNCE_REPLY_CHARS) }) : null;
    }
    case "card":
      return item.card.state === "pending" ? cardAnnouncement(item.lang, item.card) : null;
    case "done":
      return translateKey(item.lang, item.summaryKey, item.vars ?? {});
    case "refused":
      return refusalText(item.lang, item.code, { names: item.who ?? [] }) ?? t(item.lang, "refuse.not_allowed");
    case "error":
      return errorText(item.lang, item.state, item.params) || null;
    case "action":
      return item.title || null;
    default:
      return null;
  }
}

/**
 * What the status region says after the transcript changed from `prev` to `next`: finished replies and new cards, rows and
 * errors, never a growing streamed reply.
 */
export function announcementFor(prev: readonly TranscriptItem[], next: readonly TranscriptItem[]): string | null {
  const before = new Map(prev.map((it) => [it.id, it]));
  const lines: string[] = [];
  for (const item of next) {
    const old = before.get(item.id);
    if (item.kind === "eddy") {
      if (item.streaming) continue; // tokens are never announced
      const wasFinal = old && old.kind === "eddy" && !old.streaming && old.text === item.text && !!old.interrupted === !!item.interrupted;
      if (wasFinal) continue;
      const line = itemAnnouncement(item);
      if (line) lines.push(line);
      continue;
    }
    if (old) continue;
    if (item.kind === "member" || item.kind === "activity") continue;
    const line = itemAnnouncement(item);
    if (line) lines.push(line);
  }
  return lines.length ? lines.join(" ") : null;
}

/** The entity and ids a confirmed card or an undone row changed, for wa:eddy-did. */
export function didFor(items: readonly TranscriptItem[], actionId: string): { entity: EddyEntity; ids: string[] } | null {
  for (const it of items) {
    if (it.kind === "card" && it.card.actionId === actionId) {
      const entity = entityForAction(it.card.action);
      return entity ? { entity, ids: targetIdsOf(it.card) } : null;
    }
    if (it.kind === "done" && it.actionId === actionId) {
      const entity = entityForAction(it.summaryKey);
      return entity ? { entity, ids: [] } : null;
    }
  }
  return null;
}

/** Cards and done rows: what stays usable without the AI (6.11 "cards already on screen"). */
export function onScreenItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items.filter((it) => it.kind === "card" || it.kind === "done");
}

export type TranscriptProps = {
  items: readonly TranscriptItem[];
  /** The chrome language (labels); each message keeps its own lang. */
  lang: EddyLang;
  working: boolean;
  activity: Activity;
  isAdmin?: boolean;
  onNavigate?: (path: string) => void;
  onStarter?: (query: string) => void;
  /** Shown while the transcript is empty: the greeting and the starter chips. */
  empty?: ReactNode;
  className?: string;
};

export function Transcript({ items, lang, working, activity, isAdmin, onNavigate, onStarter, empty, className }: TranscriptProps) {
  const [announcement, setAnnouncement] = useState("");
  const seen = useRef<readonly TranscriptItem[]>(items);
  const end = useRef<HTMLDivElement>(null);
  const count = items.length;
  const streaming = items.some((it) => it.kind === "eddy" && it.streaming);

  useEffect(() => {
    const line = announcementFor(seen.current, items);
    seen.current = items;
    if (line) setAnnouncement(line);
  }, [items]);

  // Keep the newest item in view as it arrives (instant with reduced motion).
  useEffect(() => {
    const el = end.current;
    if (!el || typeof el.scrollIntoView !== "function") return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [count, working, streaming]);

  const onDid = (actionId: string) => {
    const did = didFor(items, actionId);
    if (did) announceEddyDid(did.entity, did.ids);
  };

  const showActivity = working && !streaming;
  return (
    <div className={cn("flex flex-col", className)}>
      <div role="log" aria-live="off" aria-label={tp(lang, "panel.log")} className="flex flex-col gap-3" data-eddy-log>
        {count === 0 && empty}
        {items.map((item) => (
          <MessageView key={item.id} item={item} onNavigate={onNavigate} onStarter={onStarter} onDid={onDid} isAdmin={isAdmin} />
        ))}
        {showActivity && <MessageView item={{ kind: "activity", id: "activity", lang, key: activity?.key, text: activity?.text }} />}
      </div>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" lang={htmlLang(lang)} data-eddy-announce>
        {announcement}
      </p>
      <div ref={end} aria-hidden="true" className="h-px shrink-0" />
    </div>
  );
}

/** The cards and done rows already on screen, for the off states (they keep working without the AI). */
export function OnScreenItems({ items, isAdmin, onNavigate }: { items: readonly TranscriptItem[]; isAdmin?: boolean; onNavigate?: (path: string) => void }) {
  const keep = onScreenItems(items);
  if (keep.length === 0) return null;
  const onDid = (actionId: string) => {
    const did = didFor(items, actionId);
    if (did) announceEddyDid(did.entity, did.ids);
  };
  return (
    <div className="flex flex-col gap-3">
      {keep.map((item) => (
        <MessageView key={item.id} item={item} onNavigate={onNavigate} onDid={onDid} isAdmin={isAdmin} />
      ))}
    </div>
  );
}
