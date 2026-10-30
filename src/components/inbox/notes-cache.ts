import { apiFetch } from "@/components/ui";
import type { Note } from "./types";

/** How long a fetched list of notes is handed out again without asking the server. Shorter than the 10 s polls, longer than opening a chat takes. */
export const NOTES_FRESH_MS = 5000;

type Fetcher = (conversationId: string) => Promise<{ notes: Note[] }>;
type Options = { fresh?: boolean; fetcher?: Fetcher; now?: () => number };

const defaultFetcher: Fetcher = (id) => apiFetch<{ notes: Note[] }>(`/api/inbox/conversations/${id}/notes`);
const inflight = new Map<string, Promise<Note[]>>();
const recent = new Map<string, { at: number; notes: Note[] }>();

/**
 * The chat timeline and the details panel both show a conversation's notes. They share one request: a call made while another is
 * in flight joins it, and a call made shortly after one finished gets the same list. After writing a note pass `fresh: true`, which
 * forgets the copy and asks the server again; readers that come after get the new list.
 */
export function fetchNotes(conversationId: string, options: Options = {}): Promise<Note[]> {
  const now = options.now ?? Date.now;
  if (options.fresh) {
    recent.delete(conversationId);
  } else {
    const hit = recent.get(conversationId);
    if (hit && now() - hit.at < NOTES_FRESH_MS) return Promise.resolve(hit.notes);
    const pending = inflight.get(conversationId);
    if (pending) return pending;
  }
  const request = (options.fetcher ?? defaultFetcher)(conversationId)
    .then((r) => {
      recent.set(conversationId, { at: now(), notes: r.notes });
      return r.notes;
    })
    .finally(() => {
      if (inflight.get(conversationId) === request) inflight.delete(conversationId);
    });
  inflight.set(conversationId, request);
  return request;
}

/** Drops what is remembered for one conversation, or for all of them. */
export function forgetNotes(conversationId?: string): void {
  if (conversationId === undefined) {
    recent.clear();
    inflight.clear();
    return;
  }
  recent.delete(conversationId);
  inflight.delete(conversationId);
}
