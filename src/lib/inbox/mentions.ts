/** @mentions in internal notes. Pure parsing and splitting; notifying lives in marks.ts. */

export type MentionMember = { userId: string; name: string };

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Candidate = { userId: string; text: string };

function candidates(members: MentionMember[]): Candidate[] {
  const out: Candidate[] = [];
  const firstCounts = new Map<string, number>();
  for (const m of members) {
    const first = m.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (first) firstCounts.set(first, (firstCounts.get(first) ?? 0) + 1);
  }
  for (const m of members) {
    const name = m.name.trim();
    if (!name) continue;
    out.push({ userId: m.userId, text: name });
    const first = name.split(/\s+/)[0];
    if (first !== name && firstCounts.get(first.toLowerCase()) === 1) out.push({ userId: m.userId, text: first });
  }
  return out.sort((a, b) => b.text.length - a.text.length);
}

function patternFor(list: Candidate[]): RegExp | null {
  if (list.length === 0) return null;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@(${list.map((c) => escape(c.text)).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
}

/** User ids mentioned as @Full Name (or @First when that first name is unique in the workspace). The author is never included. */
export function extractMentions(body: string, members: MentionMember[], authorId?: string): string[] {
  const list = candidates(members);
  const re = patternFor(list);
  if (!re) return [];
  const byText = new Map(list.map((c) => [c.text.toLowerCase(), c.userId]));
  const found = new Set<string>();
  for (const m of body.matchAll(re)) {
    const id = byText.get(m[2].toLowerCase());
    if (id && id !== authorId) found.add(id);
  }
  return [...found];
}

export type NotePart = { text: string; mention: boolean };

/** Splits a note into plain and @mention parts for display. */
export function splitMentions(body: string, members: MentionMember[]): NotePart[] {
  const re = patternFor(candidates(members));
  if (!re) return [{ text: body, mention: false }];
  const parts: NotePart[] = [];
  let last = 0;
  for (const m of body.matchAll(re)) {
    if (m.index === undefined) continue;
    const start = m.index + m[1].length;
    if (start > last) parts.push({ text: body.slice(last, start), mention: false });
    parts.push({ text: `@${m[2]}`, mention: true });
    last = start + 1 + m[2].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last), mention: false });
  return parts.length ? parts : [{ text: body, mention: false }];
}

/** The partial @word being typed right before the caret, for the mention picker. */
export function mentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([\p{L}\p{N}_ ]{0,30})$/u.exec(before);
  if (!m) return null;
  return { query: m[2].toLowerCase(), start: before.length - m[2].length - 1 };
}

export function mentionMatches(query: string, members: MentionMember[], limit = 6): MentionMember[] {
  const q = query.trim().toLowerCase();
  return members.filter((m) => m.name.toLowerCase().includes(q)).slice(0, limit);
}
