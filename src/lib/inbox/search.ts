/**
 * Inbox search rules shared by the list query (server) and the search box (browser), so the box can say what the query does.
 * Pure: no database import, safe in a client component.
 */

/** Message-text search starts at three characters and looks at the newest matches only, so it stays cheap on large workspaces. */
export const MIN_TEXT_SEARCH = 3;

/**
 * The note under the search box while the query is too short to search message text. Names and numbers are matched at any
 * length, so the note says what is searched now and what one more character adds. Null when it does not apply.
 */
export function shortSearchHint(query: string): string | null {
  const q = query.trim();
  if (q.length === 0 || q.length >= MIN_TEXT_SEARCH) return null;
  return `Names and numbers match now. Type at least ${MIN_TEXT_SEARCH} characters to search messages too.`;
}
