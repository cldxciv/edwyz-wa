"use client";

/**
 * The strict markdown subset Eddy's replies render through (docs/EDDY-SPEC.md 6.3, 6.15, 12.1a decision 0: replies are
 * richly styled, never plain text).
 *
 * Supported: paragraphs and line breaks, **bold** and __bold__, *italics* and _italics_, `inline code`, fenced code shown as
 * plain preformatted text, bullet and numbered lists (nested up to 3 levels), small headings (# to ### render as h3,
 * #### and deeper as h4), compact pipe tables (at most 6 columns, in a horizontally scrollable region so a phone at
 * 360 px never scrolls the page sideways), horizontal rules, and links to allowlisted /app paths rendered as buttons.
 *
 * Never: raw HTML (it shows as the literal characters), images (only their alt text shows), links anywhere else (a link to
 * another site, to Meta or to javascript: shows its label as plain text), and never inner HTML of any kind: the parser
 * builds React elements, and React escapes every string. A markdown blockquote is shown as an ordinary paragraph, so model
 * text can never look like a CustomerQuote. Devanagari text renders at 16 px with line-height 1.6 (6.13).
 */
import { memo, useMemo, type ReactNode } from "react";
import { buttonSizes, buttonVariants, cn } from "@/components/ui";
import { safeAppPath } from "@/lib/eddy/contract";
import { htmlLang, isMostlyDevanagari, t, type EddyLang } from "@/lib/eddy/i18n";

/** Inside the Eddy root only: system fonts with the Devanagari faces each OS ships (2.5). No webfont, no CSP change. */
export const EDDY_FONT_STACK = "system-ui, 'Nirmala UI', 'Noto Sans Devanagari', 'Kohinoor Devanagari', 'Mangal', sans-serif";

export const MD_MAX_CHARS = 20_000;
export const MD_MAX_TABLE_COLUMNS = 6;
export const MD_MAX_TABLE_ROWS = 50;
const MAX_LIST_DEPTH = 3;
const MAX_INLINE_DEPTH = 4;

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; path: string; c: Inline[] }
  | { t: "br" };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { type: "p"; c: Inline[] }
  | { type: "h"; level: 3 | 4; c: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][]; align: Align[]; hiddenColumns: number }
  | { type: "code"; v: string }
  | { type: "hr" };

// ===== Block parsing =====

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
// Linear patterns only: the text is the model's, and a crafted line must never stall the member's browser.
const HEADING = /^\s{0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const SEP_CELL = /^:?-+:?$/;

const isBlank = (line: string) => line.trim().length === 0;

/** A heading's text without the optional closing run of #s ("## Title ##" is "Title"). */
function headingText(raw: string): string {
  const text = raw.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  // A closing run counts only when a space separates it from the text (or it is all there is).
  if (end < text.length && (end === 0 || text[end - 1] === " " || text[end - 1] === "\t")) return text.slice(0, end).trimEnd();
  return text;
}
const indentOf = (line: string) => (/^\s*/.exec(line.replace(/\t/g, "    "))?.[0].length ?? 0);

function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** A separator row such as `|---|:--:|--:|`: every cell is dashes with optional colons. Checked cell by cell, so it is linear. */
function isTableSep(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((c) => SEP_CELL.test(c));
}

/** A header row followed by a separator row with the same number of cells (the GFM rule). */
const isTableStart = (lines: string[], i: number) =>
  i + 1 < lines.length && lines[i].includes("|") && isTableSep(lines[i + 1]) && splitCells(lines[i]).length === splitCells(lines[i + 1]).length;

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || LIST_ITEM.test(line) || QUOTE.test(line) || isTableStart(lines, i);
}

function parseTable(lines: string[], i: number): { block: Block; next: number } {
  const headCells = splitCells(lines[i]);
  const alignCells = splitCells(lines[i + 1]);
  const columns = Math.min(headCells.length, MD_MAX_TABLE_COLUMNS);
  const align: Align[] = alignCells.slice(0, columns).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
  while (align.length < columns) align.push(null);
  const rows: Inline[][][] = [];
  let j = i + 2;
  while (j < lines.length && !isBlank(lines[j]) && lines[j].includes("|")) {
    if (rows.length < MD_MAX_TABLE_ROWS) {
      const cells = splitCells(lines[j]).slice(0, columns);
      while (cells.length < columns) cells.push("");
      rows.push(cells.map((c) => parseInline(c)));
    }
    j++;
  }
  return {
    block: { type: "table", head: headCells.slice(0, columns).map((c) => parseInline(c)), rows, align, hiddenColumns: Math.max(0, headCells.length - columns) },
    next: j,
  };
}

function parseList(lines: string[], start: number, depth: number): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[start])!;
  const baseIndent = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items: Block[][] = [];
  let current: { text: string[]; blocks: Block[] } | null = null;
  const flush = () => {
    if (!current) return;
    const blocks: Block[] = [];
    const text = current.text.join("\n").trim();
    if (text) blocks.push({ type: "p", c: parseInline(text) });
    items.push([...blocks, ...current.blocks]);
    current = null;
  };
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = LIST_ITEM.exec(line);
    if (!m) {
      if (isBlank(line)) {
        const next = lines[i + 1];
        const nm = next !== undefined ? LIST_ITEM.exec(next) : null;
        if (nm && indentOf(nm[1]) >= baseIndent && /\d/.test(nm[2]) === ordered) {
          i++;
          continue;
        }
        break;
      }
      if (current && indentOf(line) > baseIndent) {
        (current as { text: string[] }).text.push(line.trim());
        i++;
        continue;
      }
      if (current && !startsBlock(lines, i)) {
        // A lazy continuation line of the item's paragraph.
        (current as { text: string[] }).text.push(line.trim());
        i++;
        continue;
      }
      break;
    }
    const indent = indentOf(m[1]);
    if (indent < baseIndent) break;
    if (indent > baseIndent && current) {
      if (depth + 1 < MAX_LIST_DEPTH) {
        const nested = parseList(lines, i, depth + 1);
        (current as { blocks: Block[] }).blocks.push(nested.block);
        i = nested.next;
      } else {
        (current as { text: string[] }).text.push(m[3]);
        i++;
      }
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;
    flush();
    current = { text: [m[3]], blocks: [] };
    i++;
  }
  flush();
  const startNumber = ordered ? Math.max(0, Math.min(1_000_000, parseInt(first[2], 10) || 1)) : 1;
  return { block: { type: "list", ordered, start: startNumber, items }, next: i };
}

/** Parses Eddy's markdown into blocks. Linear in practice; inputs are cut at MD_MAX_CHARS. */
export function parseMarkdown(source: string): Block[] {
  const text = (typeof source === "string" ? source : "").slice(0, MD_MAX_CHARS).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}\\${marker}{3,}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ type: "code", v: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const text = headingText(heading[2] ?? "");
      if (text) blocks.push({ type: "h", level: heading[1].length <= 3 ? 3 : 4, c: parseInline(text) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    if (isTableStart(lines, i)) {
      const table = parseTable(lines, i);
      blocks.push(table.block);
      i = table.next;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, i, 0);
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
      blocks.push({ type: "p", c: parseInline(body.join("\n").trim()) });
      continue;
    }
    const para: string[] = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) para.push(lines[i++]);
    blocks.push({ type: "p", c: parseInline(para.join("\n").trim()) });
  }
  return blocks;
}

// ===== Inline parsing =====

const ESCAPABLE = new Set("\\`*_{}[]()#+-.!|~<>".split(""));
const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

/**
 * Finds closing delimiters in one string, shared by every nested range of a parse, so the whole inline parse stays linear:
 * - find() remembers its last answer per token (any `from` up to that answer gets it again) and every miss;
 * - closer() answers "the first valid closer at or after `from`" from a table built once per token in one right-to-left
 *   pass, so an opener never walks a run of rejected closers (the old quadratic case: `*a ` repeated).
 */
class Finder {
  private miss = new Map<string, number>();
  private last = new Map<string, { from: number; at: number }>();
  private closers = new Map<string, Int32Array>();
  constructor(private readonly s: string) {}
  find(token: string, from: number): number {
    const missedFrom = this.miss.get(token);
    if (missedFrom !== undefined && from >= missedFrom) return -1;
    const memo = this.last.get(token);
    if (memo && from >= memo.from && from <= memo.at) return memo.at;
    const at = this.s.indexOf(token, from);
    if (at < 0) this.miss.set(token, Math.min(from, missedFrom ?? from));
    else this.last.set(token, { from, at });
    return at;
  }
  /** The first position at or after `from` where `token` starts and `valid` holds (-1 for none). `valid` must depend on the position only. */
  closer(token: string, from: number, valid: (at: number) => boolean): number {
    const n = this.s.length;
    if (from < 0 || from >= n) return -1;
    let table = this.closers.get(token);
    if (!table) {
      table = new Int32Array(n + 1);
      let next = -1;
      table[n] = -1;
      for (let p = n - 1; p >= 0; p--) {
        if (this.s.startsWith(token, p) && valid(p)) next = p;
        table[p] = next;
      }
      this.closers.set(token, table);
    }
    return table[from];
  }
}

function pushText(out: Inline[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

function plainOf(nodes: Inline[]): string {
  return nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? " " : n.t === "link" || n.t === "strong" || n.t === "em" ? plainOf(n.c) : "")).join("");
}

function parseRange(s: string, start: number, end: number, depth: number, finder: Finder, inLink: boolean): Inline[] {
  const out: Inline[] = [];
  let i = start;
  while (i < end) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < end && ESCAPABLE.has(s[i + 1])) {
      pushText(out, s[i + 1]);
      i += 2;
      continue;
    }
    if (ch === "\n") {
      out.push({ t: "br" });
      i++;
      continue;
    }
    if (ch === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const close = finder.find(fence, i + n);
      if (close >= 0 && close + n <= end) {
        let v = s.slice(i + n, close).replace(/\n/g, " ");
        if (v.length > 1 && v.startsWith(" ") && v.endsWith(" ")) v = v.slice(1, -1);
        out.push({ t: "code", v });
        i = close + n;
        continue;
      }
      pushText(out, fence);
      i += n;
      continue;
    }
    if ((ch === "*" || ch === "_") && depth < MAX_INLINE_DEPTH) {
      const double = s[i + 1] === ch;
      const token = double ? ch + ch : ch;
      const left = s[i - 1];
      const after = s[i + token.length];
      const opens = after !== undefined && after !== " " && after !== "\n" && after !== ch && !(ch === "_" && isWordChar(left));
      if (opens) {
        // A closer is not after a space, not part of a longer run (single delimiters), and `_` not before a letter or digit.
        const close = finder.closer(token, i + token.length + 1, (at) => !(s[at - 1] === " " || (!double && s[at + 1] === ch) || (!double && s[at - 1] === ch) || (ch === "_" && isWordChar(s[at + token.length]))));
        if (close >= 0 && close + token.length <= end) {
          const inner = parseRange(s, i + token.length, close, depth + 1, finder, inLink);
          out.push(double ? { t: "strong", c: inner } : { t: "em", c: inner });
          i = close + token.length;
          continue;
        }
      }
      pushText(out, token);
      i += token.length;
      continue;
    }
    if (ch === "!" && s[i + 1] === "[") {
      const link = readLink(s, i + 1, end, finder);
      if (link) {
        // No images: the alt text only, as plain text.
        pushText(out, s.slice(link.labelStart, link.labelEnd));
        i = link.next;
        continue;
      }
    }
    if (ch === "[") {
      const link = readLink(s, i, end, finder);
      if (link) {
        const label = parseRange(s, link.labelStart, link.labelEnd, depth + 1, finder, true);
        const path = inLink ? null : safeAppPath(link.url);
        if (path) out.push({ t: "link", path, c: label.length ? label : [{ t: "text", v: path }] });
        else for (const node of label) node.t === "text" ? pushText(out, node.v) : out.push(node);
        i = link.next;
        continue;
      }
    }
    pushText(out, ch);
    i++;
  }
  return out;
}

function readLink(s: string, open: number, end: number, finder: Finder): { labelStart: number; labelEnd: number; url: string; next: number } | null {
  const mid = finder.find("](", open + 1);
  if (mid < 0 || mid >= end) return null;
  // The label may not contain an unescaped newline pair or another "[": keep it simple and safe. Checked through the finder,
  // so a run of "[" before one far "](" stays linear.
  const bracket = finder.find("[", open + 1);
  const gap = finder.find("\n\n", open + 1);
  if ((bracket >= 0 && bracket < mid) || (gap >= 0 && gap < mid)) return null;
  const close = finder.find(")", mid + 2);
  if (close < 0 || close >= end) return null;
  const inside = s.slice(mid + 2, close).trim();
  const url = inside.split(/\s+/)[0] ?? "";
  return { labelStart: open + 1, labelEnd: mid, url, next: close + 1 };
}

/** Parses inline markdown. Exported for tests. */
export function parseInline(text: string): Inline[] {
  const s = text ?? "";
  return parseRange(s, 0, s.length, 0, new Finder(s), false);
}

// ===== Rendering =====

const linkButton = cn(buttonVariants.secondary, buttonSizes.sm, "inline-flex items-center justify-center gap-1 rounded-full font-semibold no-underline align-middle my-0.5 pointer-coarse:min-h-11");

function renderInline(nodes: Inline[], onNavigate: ((path: string) => void) | undefined, key = "i"): ReactNode[] {
  return nodes.map((n, idx) => {
    const k = `${key}.${idx}`;
    switch (n.t) {
      case "text":
        return n.v;
      case "br":
        return <br key={k} />;
      case "code":
        return (
          <code key={k} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em] break-words">
            {n.v}
          </code>
        );
      case "strong":
        return (
          <strong key={k} className="font-semibold">
            {renderInline(n.c, onNavigate, k)}
          </strong>
        );
      case "em":
        return <em key={k}>{renderInline(n.c, onNavigate, k)}</em>;
      case "link":
        return (
          <a
            key={k}
            href={n.path}
            className={linkButton}
            data-eddy-link
            onClick={
              onNavigate
                ? (e) => {
                    e.preventDefault();
                    onNavigate(n.path);
                  }
                : undefined
            }
          >
            {renderInline(n.c, onNavigate, k)}
          </a>
        );
    }
  });
}

const ALIGN_CLASS: Record<string, string> = { left: "text-left", center: "text-center", right: "text-right" };

function renderBlocks(blocks: Block[], lang: EddyLang, onNavigate: ((path: string) => void) | undefined, key = "b"): ReactNode[] {
  return blocks.map((b, idx) => {
    const k = `${key}.${idx}`;
    switch (b.type) {
      case "p":
        return (
          <p key={k} className="my-1.5 first:mt-0 last:mb-0">
            {renderInline(b.c, onNavigate, k)}
          </p>
        );
      case "h":
        return b.level === 3 ? (
          <h3 key={k} className="mb-1 mt-3 text-base font-semibold tracking-tight first:mt-0">
            {renderInline(b.c, onNavigate, k)}
          </h3>
        ) : (
          <h4 key={k} className="mb-1 mt-2.5 text-sm font-semibold first:mt-0">
            {renderInline(b.c, onNavigate, k)}
          </h4>
        );
      case "hr":
        return <hr key={k} className="my-3 border-border" />;
      case "code":
        return (
          <pre key={k} className="my-2 max-w-full overflow-x-auto rounded-md bg-surface-2 p-2.5 font-mono text-xs leading-relaxed">
            <code>{b.v}</code>
          </pre>
        );
      case "list": {
        const items = b.items.map((item, j) => <li key={`${k}.${j}`}>{renderBlocks(item, lang, onNavigate, `${k}.${j}`)}</li>);
        return b.ordered ? (
          <ol key={k} start={b.start !== 1 ? b.start : undefined} className="my-1.5 list-decimal space-y-0.5 pl-5 first:mt-0 last:mb-0 [&_p]:my-0">
            {items}
          </ol>
        ) : (
          <ul key={k} className="my-1.5 list-disc space-y-0.5 pl-5 first:mt-0 last:mb-0 [&_p]:my-0">
            {items}
          </ul>
        );
      }
      case "table":
        return (
          <div key={k} className="my-2">
            <div role="region" aria-label={t(lang, "a11y.table")} tabIndex={0} className="max-w-full overflow-x-auto rounded-md border border-border" data-eddy-table-scroll>
              <table className="w-max min-w-full border-collapse text-sm">
                <thead className="bg-surface-2">
                  <tr>
                    {b.head.map((cell, j) => (
                      <th key={`${k}.h${j}`} scope="col" className={cn("whitespace-nowrap px-2.5 py-1.5 font-semibold", ALIGN_CLASS[b.align[j] ?? "left"])}>
                        {renderInline(cell, onNavigate, `${k}.h${j}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={`${k}.r${r}`}>
                      {row.map((cell, j) => (
                        <td key={`${k}.r${r}.${j}`} className={cn("border-t border-border px-2.5 py-1.5 align-top", ALIGN_CLASS[b.align[j] ?? "left"])}>
                          {renderInline(cell, onNavigate, `${k}.r${r}.${j}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {b.hiddenColumns > 0 && (
              <p className="mt-1 text-xs text-muted" data-eddy-table-hidden={b.hiddenColumns}>
                {b.hiddenColumns === 1 ? t(lang, "a11y.table_more_column") : t(lang, "a11y.table_more_columns", { count: b.hiddenColumns })}
              </p>
            )}
          </div>
        );
    }
  });
}

/** Card and row text: Devanagari at 16 px with line-height 1.6 (6.13), Latin at 14 px. */
export function cardTextClass(lang: EddyLang, text = ""): string {
  return lang === "hi" || isMostlyDevanagari(text) ? "text-base leading-[1.6]" : "text-sm";
}

/** Typography for a message in this language: Devanagari at 16 px and line-height 1.6, Latin at the body size. */
export function messageTypeClass(lang: EddyLang, text = ""): string {
  return lang === "hi" || isMostlyDevanagari(text) ? "text-base leading-[1.6]" : "text-sm leading-relaxed";
}

/**
 * Memoised: the transcript re-renders on every streamed delta, and a finished reply's text never changes, so it is parsed
 * once, not on every delta of every later reply.
 */
export const SafeMarkdown = memo(function SafeMarkdown({ text, lang, onNavigate, className }: { text: string; lang: EddyLang; onNavigate?: (path: string) => void; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div lang={htmlLang(lang)} dir="auto" className={cn("min-w-0 max-w-full break-words", messageTypeClass(lang, text), className)} data-eddy-md>
      {renderBlocks(blocks, lang, onNavigate)}
    </div>
  );
});

/** Plain text of markdown (for the polite status region: "Eddy replied: " plus the first 140 characters). */
export function markdownPlainText(text: string): string {
  return parseMarkdown(text)
    .map((b) => {
      if (b.type === "p" || b.type === "h") return plainOf(b.c);
      if (b.type === "list") return b.items.map((item) => item.map((x) => (x.type === "p" ? plainOf(x.c) : "")).join(" ")).join("; ");
      if (b.type === "table") return b.head.map(plainOf).join(", ");
      if (b.type === "code") return b.v;
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
