import { mergeById, type InboxMessage } from "./helpers";

/** One page of a conversation as the detail endpoint returns it: newest messages first, and a cursor for the page before them. */
export type HistoryPage = { messages: InboxMessage[]; nextCursor: string | null };

/**
 * The messages loaded for one chat. `latest` is the newest page and is replaced on every refresh; `older` holds the pages the
 * reader loaded by paging back. `cursor` points at the next older page. Once the reader has paged back (`usedOlder`), a refresh
 * must not move the cursor back to the first page's, or the next click would fetch a page that is already on screen.
 */
export type History = { latest: InboxMessage[]; older: InboxMessage[]; cursor: string | null; usedOlder: boolean };

export const EMPTY_HISTORY: History = { latest: [], older: [], cursor: null, usedOlder: false };

/** A refresh (poll, stream update, read mark) replaces the newest page. The cursor follows it only until the reader has paged back. */
export function applyLatestPage(history: History, page: HistoryPage): History {
  return { ...history, latest: page.messages, cursor: history.usedOlder ? history.cursor : page.nextCursor };
}

/** An older page is merged in (duplicates are dropped) and the cursor moves on to the page before it. */
export function applyOlderPage(history: History, page: HistoryPage): History {
  return { ...history, older: mergeById(page.messages, history.older), cursor: page.nextCursor, usedOlder: true };
}

/**
 * Where the scroller must be after content was added above the reader, so the message they were looking at stays put.
 * When nothing was added the height did not change and the position is left alone, instead of being thrown to the top.
 */
export function restoredScrollTop(scrollTopBefore: number, heightBefore: number, heightAfter: number): number {
  return scrollTopBefore + Math.max(heightAfter - heightBefore, 0);
}
