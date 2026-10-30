export const CHUNK_SIZE = 800;
export const TOP_CHUNKS = 4;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === "#") {
        const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : " ";
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLong(piece: string): string[] {
  if (piece.length <= CHUNK_SIZE) return [piece];
  const out: string[] = [];
  let current = "";
  for (const sentence of piece.split(/(?<=[.!?])\s+/)) {
    if (current && current.length + sentence.length + 1 > CHUNK_SIZE) {
      out.push(current);
      current = "";
    }
    current = current ? `${current} ${sentence}` : sentence;
    while (current.length > CHUNK_SIZE) {
      out.push(current.slice(0, CHUNK_SIZE));
      current = current.slice(CHUNK_SIZE);
    }
  }
  if (current) out.push(current);
  return out;
}

/** Splits into chunks of about CHUNK_SIZE characters, keeping paragraphs together where they fit. */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    for (const piece of splitLong(paragraph)) {
      if (current && current.length + piece.length + 2 > CHUNK_SIZE) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const STOPWORDS = new Set("a an and are as at be by for from has have how i in is it its of on or that the this to was what when where which who will with you your do does can we our me my".split(" "));

export function tokenize(text: string): string[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export type Chunk = { sourceId: string; title: string; text: string };

/** BM25 over the chunks. Returns at most `limit` chunks with a positive score, best first. */
export function topChunks(query: string, chunks: Chunk[], limit = TOP_CHUNKS): Chunk[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || chunks.length === 0) return [];
  const docs = chunks.map((c) => tokenize(`${c.title} ${c.text}`));
  const avgLen = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const term of queryTerms) df.set(term, docs.filter((d) => d.includes(term)).length);
  const k1 = 1.4;
  const b = 0.75;
  const scored = chunks.map((chunk, i) => {
    const doc = docs[i];
    let score = 0;
    for (const term of queryTerms) {
      const n = df.get(term) ?? 0;
      if (n === 0) continue;
      const tf = doc.filter((t) => t === term).length;
      if (tf === 0) continue;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgLen)));
    }
    return { chunk, score };
  });
  return scored.filter((s) => s.score > 0).sort((x, y) => y.score - x.score).slice(0, limit).map((s) => s.chunk);
}
