export type FuzzyMatch = { score: number; indices: number[] };

const isBoundary = (text: string, i: number) => i === 0 || /[\s\-_/:.]/.test(text[i - 1]);

/**
 * Subsequence match of every query character in order, case-insensitive. Returns null when the query does not match.
 * Higher scores for consecutive runs, word starts and earlier matches; shorter targets win ties.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (q === "") return { score: 0, indices: [] };
  const t = text.toLowerCase();
  if (q.length > t.length) return null;

  const direct = t.indexOf(q);
  if (direct !== -1) {
    const indices = Array.from({ length: q.length }, (_, k) => direct + k);
    const bonus = direct === 0 ? 60 : isBoundary(t, direct) ? 40 : 20;
    return { score: 100 + bonus + q.length * 10 - t.length * 0.1, indices };
  }

  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at === -1) return null;
    let gain = 1;
    if (at === prev + 1) gain += 8;
    if (isBoundary(t, at)) gain += 6;
    score += gain - Math.min(at - from, 5) * 0.2;
    indices.push(at);
    prev = at;
    from = at + 1;
  }
  return { score: score - t.length * 0.05, indices };
}

export type Ranked<T> = { item: T; score: number; indices: number[] };

/** Best match across the label and any extra search terms; label matches get their highlight indices, others none. */
export function fuzzyRank<T>(items: T[], query: string, label: (item: T) => string, extra: (item: T) => string[] = () => []): Ranked<T>[] {
  if (query.trim() === "") return items.map((item) => ({ item, score: 0, indices: [] }));
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const main = fuzzyMatch(query, label(item));
    let best: Ranked<T> | null = main ? { item, score: main.score + 15, indices: main.indices } : null;
    for (const term of extra(item)) {
      const m = fuzzyMatch(query, term);
      if (m && (best === null || m.score > best.score)) best = { item, score: m.score, indices: [] };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Splits text into alternating plain and highlighted runs for rendering matches. */
export function highlightRuns(text: string, indices: number[]): { text: string; match: boolean }[] {
  if (indices.length === 0) return [{ text, match: false }];
  const set = new Set(indices);
  const runs: { text: string; match: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const match = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last.match === match) last.text += text[i];
    else runs.push({ text: text[i], match });
  }
  return runs;
}
