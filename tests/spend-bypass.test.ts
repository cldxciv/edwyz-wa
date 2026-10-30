import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Static bypass test (docs/SPEND-CONTROLS-SPEC.md 4.12; Eddy requests E2 and E8). It walks src/**, strips comments, and fails
 * when code calls a spend endpoint or host outside its allowlist. Every allowlist entry carries a one-line reason. The deploy
 * steps run this file before `next build` (deploy/README-deploy.md). It catches accidents, not malice (12.2 risk 10): the
 * runtime tripwire is the real backstop for Meta, and the AI gateway for Anthropic.
 *
 * Paths below are relative to src/. "dir/**" allows a whole directory.
 */

type Allow = Readonly<Record<string, string>>;
type Hit = { index: number; text: string };
type Rule = {
  id: string;
  title: string;
  /** Only files this returns true for are scanned (default: every file). */
  scope?: (rel: string) => boolean;
  find: (code: string, rel: string) => Hit[];
  allow: Allow;
};
type SourceFile = { rel: string; code: string };
type Violation = { rule: string; file: string; line: number; text: string };

// =====================================================================================================================
// Reading the tree
// =====================================================================================================================

/** Removes // and /* *\/ comments, keeping strings, template literals, regex literals and every newline (for line numbers). */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let lastSig = "";
  let lastWord = "";
  const REGEX_AFTER = "(,=:[!&|?{};+-*%<>~^";
  const REGEX_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && src[j] !== ch && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      lastSig = ch;
      lastWord = "";
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (depth === 0 && src[j] === "`") break;
        if (src[j] === "$" && src[j + 1] === "{") {
          depth++;
          j += 2;
          continue;
        }
        if (depth > 0 && src[j] === "{") depth++;
        else if (depth > 0 && src[j] === "}") depth--;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      lastSig = "`";
      lastWord = "";
      continue;
    }
    if (ch === "/" && (lastSig === "" || REGEX_AFTER.includes(lastSig) || REGEX_WORDS.has(lastWord))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      lastSig = "/";
      lastWord = "";
      continue;
    }
    out += ch;
    if (/[A-Za-z0-9_$]/.test(ch)) {
      lastWord = /[A-Za-z0-9_$]/.test(lastSig) ? lastWord + ch : ch;
      lastSig = ch;
    } else if (!/\s/.test(ch)) {
      lastSig = ch;
      lastWord = "";
    }
    i++;
  }
  return out;
}

export function loadSources(root: string): SourceFile[] {
  const src = path.join(root, "src");
  const files: SourceFile[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (entry === "generated" || entry === "node_modules") continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts|mjs|js|cjs)$/.test(entry) && !entry.endsWith(".d.ts") && !entry.endsWith(".d.mts")) {
        files.push({ rel: path.relative(src, full).split(path.sep).join("/"), code: stripComments(readFileSync(full, "utf8")) });
      }
    }
  })(src);
  return files;
}

const matchAll = (re: RegExp) => (code: string): Hit[] => [...code.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))].map((m) => ({ index: m.index ?? 0, text: m[0] }));
const under = (...dirs: string[]) => (rel: string) => dirs.some((d) => rel === d || rel.startsWith(d.endsWith("/") ? d : d + "/"));
const isAllowed = (allow: Allow, rel: string) => Object.keys(allow).some((k) => (k.endsWith("/**") ? rel.startsWith(k.slice(0, -2)) : rel === k));
const lineOf = (code: string, index: number) => code.slice(0, index).split("\n").length;

/** Every import specifier with whether the import is type-only. */
function imports(code: string): { spec: string; typeOnly: boolean; index: number }[] {
  const out: { spec: string; typeOnly: boolean; index: number }[] = [];
  // An import or export clause never contains ";", so a match cannot run from one statement into the next.
  for (const m of code.matchAll(/\b(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g)) out.push({ spec: m[4], typeOnly: !!m[2], index: m.index ?? 0 });
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm)) out.push({ spec: m[1] ?? m[2] ?? m[3], typeOnly: false, index: m.index ?? 0 });
  return out;
}

/** Resolves an import to a path under src without extension ("lib/spend/permit"), or null for a package. */
function resolveImport(rel: string, spec: string): string | null {
  if (spec.startsWith("@/")) return spec.slice(2).replace(/\.(ts|tsx|js|mjs)$/, "");
  if (spec.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)).replace(/\.(ts|tsx|js|mjs)$/, "");
  return null;
}

// =====================================================================================================================
// B12 support: who may call fetch(), and to which hosts
// =====================================================================================================================

/** Hosts server code may reach with fetch(): Graph, Anthropic, Razorpay and Meta's media CDN. SMTP and creative providers are not fetch. */
const ALLOWED_HOSTS = ["graph.facebook.com", "api.anthropic.com", "api.razorpay.com", "lookaside.fbsbx.com"];

/** Files that may call fetch() with a computed URL, each with its reason and any extra hosts named in it. */
const FETCH_FILES: Readonly<Record<string, { reason: string; hosts?: string[] }>> = {
  "lib/graph/index.ts": { reason: "The Graph transport: every Meta call, behind the spend tripwire." },
  "lib/templates/upload.ts": { reason: "Template sample media: Meta's resumable upload to graph.facebook.com (not spend)." },
  "lib/billing/razorpay.ts": { reason: "The platform fee through Razorpay's API (R9)." },
  "lib/inbox/media.ts": { reason: "Downloads WhatsApp media from Meta's media hosts only (host-checked before the call)." },
  "lib/spend/exec/ai.ts": { reason: "The AI gateway: the only caller of api.anthropic.com (I9)." },
  "components/ui.tsx": { reason: "apiFetch: the browser's same-origin /api wrapper." },
  "components/connect/ConnectWhatsApp.tsx": { reason: "Same-origin /api calls of Embedded Signup; connect.facebook.net is the SDK script tag.", hosts: ["connect.facebook.net"] },
  "components/site/auth-ui.tsx": { reason: "Same-origin /api/auth form posts." },
  "components/eddy/MessageView.tsx": { reason: "Same-origin /api/actions undo, with an injectable fetcher for tests." },
  "components/eddy/PreviewCard.tsx": { reason: "Same-origin /api/actions confirm, revise and cancel, with an injectable fetcher for tests." },
};

const FETCH_CALL = /(?<![\w.$])fetch\s*\(\s*/g;

function findFetchBypass(code: string, rel: string): Hit[] {
  const listed = FETCH_FILES[rel];
  const hits: Hit[] = [];
  let calls = 0;
  for (const m of code.matchAll(FETCH_CALL)) {
    calls++;
    const after = code.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 2);
    const sameOrigin = /^["'`]\/(?!\/)/.test(after);
    // A literal same-origin path ("/api/...") is the app talking to itself. Anything else needs a reasoned entry.
    if (!sameOrigin && !listed) hits.push({ index: m.index ?? 0, text: code.slice(m.index ?? 0, (m.index ?? 0) + 60).split("\n")[0] });
  }
  if (calls > 0 && listed) {
    const hosts = [...ALLOWED_HOSTS, ...(listed.hosts ?? [])];
    for (const m of code.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
      if (!hosts.includes(m[1].toLowerCase())) hits.push({ index: m.index ?? 0, text: m[0] });
    }
  }
  // Any absolute URL literal handed straight to fetch must be an allowed host, listed or not.
  for (const m of code.matchAll(/(?<![\w.$])fetch\s*\(\s*["'`]https?:\/\/([A-Za-z0-9.-]+)/g)) {
    const hosts = [...ALLOWED_HOSTS, ...(listed?.hosts ?? [])];
    if (!hosts.includes(m[1].toLowerCase()) || !listed) hits.push({ index: m.index ?? 0, text: m[0] });
  }
  return hits;
}

// =====================================================================================================================
// The rules (4.12 table, plus B2b from Eddy E2 and B14 with Eddy E8)
// =====================================================================================================================

const SPEND_TABLES = ["spendAllowance", "spendCeiling", "spendControl", "spendCommitment", "spendCounter", "spendReservation", "assistantMandate", "spendApproval", "spendBreaker", "metaSpendLimit"];
const SPEND_SQL_TABLES = SPEND_TABLES.map((t) => t[0].toUpperCase() + t.slice(1));

export const RULES: Rule[] = [
  {
    id: "B1",
    title: "graph.facebook.com only in the transport",
    find: matchAll(/graph\.facebook\.com/),
    allow: {
      "lib/graph/index.ts": "The Graph transport, with the spend tripwire in run().",
      "lib/templates/upload.ts": "Template sample media upload (resumable upload API), not spend.",
      "lib/security/csp.ts": "Content-Security-Policy connect-src and frame-src entries.",
    },
  },
  {
    id: "B2",
    title: "api.anthropic.com only in the AI gateway",
    find: matchAll(/api\.anthropic\.com/),
    allow: {
      "lib/spend/exec/ai.ts": "The AI gateway (4.10): freeze check, reserveAi, settlement.",
    },
  },
  {
    id: "B2c",
    title: "the gateway's unmetered HTTP helper only for Creative Studio's caller-held calls",
    find: matchAll(/\banthropicMessagesHeldByCaller\b/),
    allow: {
      "lib/spend/exec/ai.ts": "Where the helper is defined, next to the gateway's own call.",
      "lib/creative/llm.ts": "Creative Studio holds its credits with reserveCredits and counts them with recordUsage itself.",
    },
  },
  {
    id: "B2b",
    title: "@anthropic-ai/sdk is imported (as a value) only by the streaming gateway (Eddy E2)",
    find: (code) => imports(code).filter((i) => /^@anthropic-ai\/sdk(\/|$)/.test(i.spec) && !i.typeOnly).map((i) => ({ index: i.index, text: i.spec })),
    allow: { "lib/spend/exec/ai-stream.ts": "Eddy's streaming sibling of the AI gateway; the worker never imports it." },
  },
  {
    id: "B2b-type",
    title: "type-only @anthropic-ai/sdk imports are erased at build, and still only where Eddy's port is declared",
    find: (code) => imports(code).filter((i) => /^@anthropic-ai\/sdk(\/|$)/.test(i.spec) && i.typeOnly).map((i) => ({ index: i.index, text: i.spec })),
    allow: {
      "lib/spend/exec/ai-stream.ts": "The streaming gateway's own types.",
      "lib/eddy/model.ts": "EddyModelPort's message types; erased at build, so no runtime path reaches the SDK.",
    },
  },
  {
    id: "B3",
    title: "adsClient( only at the ads choke point",
    find: matchAll(/\badsClient\s*\(/),
    allow: {
      "lib/ads/client.ts": "Where the guarded client is defined.",
      "lib/ads/service.ts": "Launch, activate, pause and archive through the Spend Book.",
      "lib/ads/actions.ts": "Budget, pause and resume actions through the Spend Book.",
      "lib/ads/stop.ts": "Stops campaigns (stopCommitments): lowering only.",
      "lib/spend/reconcile.ts": "Reconciler reads (GET only).",
      "lib/spend/sync/fast-insights.ts": "Fast insights sync, reads only.",
      "lib/spend/sync/structure.ts": "Structure sync of Edwyz campaigns, reads only.",
    },
  },
  {
    id: "B4",
    title: "a Graph path ending in /messages only in the send job",
    find: (code) =>
      [...code.matchAll(/(["'`])([^"'`\n]*)\/messages\1/g)]
        // App routes ("/api/..."), full URLs (the Anthropic Messages API is B2) and module specifiers are not Graph paths.
        .filter((m) => !/^(\/api\/|https?:|\.{1,2}(\/|$)|@)/.test(m[2]))
        .map((m) => ({ index: m.index ?? 0, text: m[0] })),
    allow: {
      "lib/inbox/send.ts": "The send job (processSendJob): the one WhatsApp POST, inside the send gate's msg_send permit.",
      "lib/compat/spec.ts": "OpenAPI documentation of the compat API's own route, not a Graph path.",
    },
  },
  {
    id: "B5",
    title: 'enqueue("send" only in the inbox send path',
    find: matchAll(/\benqueue\s*\(\s*["']send["']/),
    allow: {
      "lib/inbox/service.ts": "queueOutbound: origin and category are stamped here.",
      "lib/inbox/interactive.ts": "Interactive messages, stamped like queueOutbound.",
      "lib/inbox/send.ts": "Retries of the send job itself.",
    },
  },
  {
    id: "B6",
    title: "SpendLedger and SpendConsent are append-only",
    find: (code) => [
      ...matchAll(/\b(spendLedger|spendConsent)\s*\.\s*(update|updateMany|updateManyAndReturn|delete|deleteMany|upsert)\b/)(code),
      ...matchAll(/\b(UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+"?(SpendLedger|SpendConsent)\b/i)(code),
    ],
    allow: { "lib/lifecycle/erase-workspace.ts": "Workspace erasure: the per-workspace purge under edwyz.purge (12.1c R2)." },
  },
  {
    id: "B7",
    title: "spend tables are written only by the Spend Book",
    find: (code) => [
      ...matchAll(new RegExp(`\\b(${SPEND_TABLES.join("|")})\\s*\\.\\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\\b`))(code),
      ...matchAll(new RegExp(`\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+"(${SPEND_SQL_TABLES.join("|")})"`, "i"))(code),
    ],
    allow: {
      "lib/spend/**": "The Spend Book owns every money decision (4.2).",
      "lib/lifecycle/erase-workspace.ts": "Workspace erasure deletes the workspace's own rows.",
    },
  },
  {
    id: "B8",
    title: "permits are minted and imported only by the book, the send gate, metacap and the tripwire",
    find: (code, rel) => [
      ...imports(code)
        .filter((i) => !i.typeOnly && resolveImport(rel, i.spec) === "lib/spend/permit")
        .map((i) => ({ index: i.index, text: i.spec })),
      ...matchAll(/\bmintPermit\b/)(code),
    ],
    allow: {
      "lib/spend/permit.ts": "Where permits are minted and counted.",
      "lib/spend/book.ts": "reserveAds, recordLowering and permitForPausedCreate mint ads, lowering and create permits.",
      "lib/spend/commitments.ts": "Commitment bookkeeping next to the book.",
      "lib/spend/messaging/gate.ts": "The WhatsApp send gate mints the msg_send permit.",
      "lib/spend/metacap/client.ts": "The only writer of Meta's spending limit.",
      "lib/spend/tripwire.ts": "Checks permits at the transport.",
    },
  },
  {
    id: "B8-cast",
    title: "no cast to a permit type (a forged permit)",
    find: matchAll(/\bas\s+(unknown\s+as\s+)?(Spend|Ads|Lowering|Create|Msg|MetaCap)?Permit\b|\bas\s+Minted\s*</),
    allow: {},
  },
  {
    id: "B9",
    title: "spend_cap only in metacap, the classifier and the account read",
    find: matchAll(/(?<![\w.])spend_cap(?!\.)/),
    allow: {
      "lib/spend/metacap/**": "Wall (a): the only writer of Meta's spending limit.",
      "lib/spend/classify.ts": "The tripwire's classifier recognises the field.",
      "lib/meta-connect/discovery.ts": "Reads the field when listing ad accounts (read only).",
      "lib/spend/copy.ts": "The banned-words list: copy must never say it (4.13).",
    },
  },
  {
    id: "B10",
    title: "budget and end fields only in the builders, the client, the classifier and read-only field lists",
    find: matchAll(/\b(lifetime_budget|end_time|daily_budget)\b/),
    allow: {
      "lib/ads/builders.ts": "Builds create bodies (always PAUSED).",
      "lib/ads/client.ts": "The guarded ads client.",
      "lib/spend/classify.ts": "The tripwire's classifier recognises the fields.",
      "lib/ads/insights-fetch.ts": "Read-only field list.",
      "lib/spend/reconcile.ts": "Read-only field list for the reconciler.",
      "lib/spend/sync/structure.ts": "Read-only field list for the structure sync.",
    },
  },
  {
    id: "B11",
    title: "funding_source is never written (R9: Edwyz never holds ad money)",
    find: matchAll(/funding_source/),
    allow: {},
  },
  {
    id: "B12",
    title: "fetch() only to allowlisted hosts, from listed files",
    find: findFetchBypass,
    allow: {},
  },
  {
    id: "B13",
    title: "a worker can never claim a human origin",
    scope: under("lib/automation", "lib/chatbots", "lib/leads", "lib/commerce", "lib/broadcasts", "lib/worker", "worker"),
    find: matchAll(/\borigin\s*:\s*["']human["']/),
    allow: {},
  },
  {
    id: "B14",
    title: "only Eddy's single executor builds a user actor or a human origin (Phase 0 4.15, Eddy E8)",
    scope: under("lib/actions", "lib/eddy", "components/eddy"),
    find: (code) => [...matchAll(/\borigin\s*:\s*["']human["']/)(code), ...matchAll(/\btype\s*:\s*["']user["']/)(code)],
    allow: { "lib/actions/invoke.ts": "The one executor: builds {type:'user', reasonCodes:['via_eddy']} from the refreshed principal." },
  },
];

export function scan(files: SourceFile[], rules: Rule[] = RULES): Violation[] {
  const out: Violation[] = [];
  for (const rule of rules) {
    for (const f of files) {
      if (rule.scope && !rule.scope(f.rel)) continue;
      if (isAllowed(rule.allow, f.rel)) continue;
      for (const hit of rule.find(f.code, f.rel)) out.push({ rule: rule.id, file: f.rel, line: lineOf(f.code, hit.index), text: hit.text.trim().slice(0, 80) });
    }
  }
  return out;
}

const describeViolations = (v: Violation[]) => v.map((x) => `${x.rule} src/${x.file}:${x.line} ${x.text}`).join("\n");

// =====================================================================================================================
// The tests
// =====================================================================================================================

const FILES = loadSources(process.cwd());

describe("static bypass rules on the current tree (4.12)", () => {
  it("found the source tree", () => {
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES.some((f) => f.rel === "lib/graph/index.ts")).toBe(true);
  });

  it.each(RULES.map((r) => [r.id, r.title, r] as const))("%s: %s", (_id, _title, rule) => {
    const violations = scan(FILES, [rule]);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it("every allowlist entry carries a one-line reason", () => {
    for (const rule of RULES) {
      for (const [file, reason] of Object.entries(rule.allow)) {
        expect(reason, `${rule.id} ${file}`).toMatch(/^[A-Za-z@(].{8,}\.$/);
        expect(reason.includes("\n"), `${rule.id} ${file}`).toBe(false);
      }
    }
    for (const [file, entry] of Object.entries(FETCH_FILES)) expect(entry.reason, file).toMatch(/^[A-Za-z].{8,}\.$/);
  });

  it("B2 allows only the AI gateway: WP-13 moved the three legacy callers behind it and removed their temporary entries", () => {
    const b2 = RULES.find((r) => r.id === "B2")!;
    expect(Object.keys(b2.allow)).toEqual(["lib/spend/exec/ai.ts"]);
    for (const rule of RULES) for (const reason of Object.values(rule.allow)) expect(reason).not.toContain("until WP-13");
    // The former legacy callers now reach the model only through the gateway.
    for (const rel of ["lib/ai-agent/generate.ts", "lib/creative/llm.ts", "lib/chatbots/escalation.ts"]) {
      const file = FILES.find((f) => f.rel === rel)!;
      expect(file, rel).toBeDefined();
      expect(file.code, rel).not.toMatch(/api\.anthropic\.com|x-api-key|anthropic-version|(?<![\w.$])fetch\s*\(/);
      expect(file.code, rel).toMatch(/from "@\/lib\/spend\/exec\/ai"/);
    }
  });

  it("B2b and B2c keep the SDK and the gateway's unmetered helper in their single files", () => {
    expect(Object.keys(RULES.find((r) => r.id === "B2b")!.allow)).toEqual(["lib/spend/exec/ai-stream.ts"]);
    expect(Object.keys(RULES.find((r) => r.id === "B2c")!.allow).sort()).toEqual(["lib/creative/llm.ts", "lib/spend/exec/ai.ts"]);
  });

  it("B14 names src/lib/actions/invoke.ts as the only allowed file (Eddy E8)", () => {
    const b14 = RULES.find((r) => r.id === "B14")!;
    expect(Object.keys(b14.allow)).toEqual(["lib/actions/invoke.ts"]);
    expect(b14.scope!("lib/actions/defs/inbox.ts")).toBe(true);
    expect(b14.scope!("lib/eddy/loop.ts")).toBe(true);
    expect(b14.scope!("components/eddy/PreviewCard.tsx")).toBe(true);
    expect(b14.scope!("lib/spend/book.ts")).toBe(false);
  });
});

describe("the deploy runbook runs this gate and documents the 3.2.1 order (WP-05 acceptance 4 and 5)", () => {
  const readme = readFileSync(path.join(process.cwd(), "deploy/README-deploy.md"), "utf8");

  it("runs the bypass test before next build", () => {
    const gate = readme.indexOf("npx vitest run tests/spend-bypass.test.ts");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(readme.indexOf("npm run build"));
  });

  it("orders train 1: backup with triggers, server_version 11+, 0009 with -1, the backfill, the restart, 0010 without -1 off-peak", () => {
    const c = readme.slice(readme.indexOf("## C. Spend controls and Eddy"));
    const steps = [
      "CREATE TRIGGER",
      "SHOW server_version",
      "-1 -f 0009_spend_controls/migration.sql",
      "scripts/spend-backfill-commitments.mjs",
      "Restart web and worker",
      "-f 0010_spend_message_indexes/migration.sql",
    ];
    const at = steps.map((s) => c.indexOf(s));
    for (const [i, s] of steps.entries()) expect(at[i], s).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(c).not.toMatch(/-1 -f 0010_spend_message_indexes/);
    expect(c).toMatch(/WITHOUT `-1`, off-peak/);
    expect(c).toContain("pg_dump --format=plain` writes functions and triggers by default");
  });
});

describe("the comment stripper", () => {
  it("drops comments but keeps strings, template literals, regex literals and line numbers", () => {
    const code = [
      'const a = "https://api.anthropic.com"; // fetch("https://evil.example")',
      "/* adsClient( */ const b = `${x}/messages`;",
      "const re = /\\/\\/not-a-comment/; const c = 1 / 2; // tail",
      "const d = 'it''s'; /*",
      "spend_cap",
      "*/ const e = `a${`b${1}`}c // inside a template`;",
    ].join("\n");
    const out = stripComments(code);
    expect(out.split("\n")).toHaveLength(6);
    expect(out).toContain('"https://api.anthropic.com"');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("adsClient(");
    expect(out).toContain("`${x}/messages`");
    expect(out).toContain("/\\/\\/not-a-comment/");
    expect(out).not.toContain("tail");
    expect(out).not.toContain("spend_cap");
    expect(out).toContain("// inside a template");
  });
});

describe("self-test: a planted fixture fails the scan", () => {
  const root = mkdtempSync(path.join(tmpdir(), "spend-bypass-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const plant = (rel: string, text: string) => {
    const full = path.join(root, "src", rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  };

  plant("lib/planted/leak.ts", "export const leak = () => fetch('https://api.anthropic.com/v1/messages', { method: 'POST' });\n");
  plant("lib/actions/defs/planted.ts", "export const run = () => queue({ origin: 'human', body: 'x' });\n");
  plant("lib/eddy/planted.ts", 'import Anthropic from "@anthropic-ai/sdk";\nexport const c = new Anthropic();\n');
  plant("lib/planted/ads.ts", 'import { adsClient } from "@/lib/ads/client";\nexport const go = (t: string) => adsClient(t, "act_1").setStatus("1", "ACTIVE");\n');
  plant("lib/planted/forge.ts", 'import { mintPermit } from "@/lib/spend/permit";\nexport const p = {} as SpendPermit;\nexport const q = mintPermit;\n');
  plant("lib/planted/commented.ts", "// fetch('https://api.anthropic.com') in a comment is fine\nexport const ok = 1;\n");
  plant("lib/eddy/sneaky.ts", 'export type X = { a: 1 };\nimport Anthropic from "@anthropic-ai/sdk";\nexport const y = Anthropic;\n');
  plant("lib/ai-agent/generate.ts", 'export const old = () => fetch("https://api.anthropic.com/v1/messages", { method: "POST" });\n');
  plant("lib/inbox/unmetered.ts", 'import { anthropicMessagesHeldByCaller } from "@/lib/spend/exec/ai";\nexport const go = () => anthropicMessagesHeldByCaller({}, 1000);\n');

  it("fails on the planted fixture, naming each broken rule and file", () => {
    const violations = scan(loadSources(root));
    const got = violations.map((v) => `${v.rule}:${v.file}`);
    expect(got).toEqual(
      expect.arrayContaining([
        "B2:lib/planted/leak.ts",
        "B12:lib/planted/leak.ts",
        "B14:lib/actions/defs/planted.ts",
        "B2b:lib/eddy/planted.ts",
        "B2b:lib/eddy/sneaky.ts",
        "B3:lib/planted/ads.ts",
        "B8:lib/planted/forge.ts",
        "B8-cast:lib/planted/forge.ts",
        // A former legacy caller is no longer allowed to name the Anthropic host (WP-13 removed its temporary entry).
        "B2:lib/ai-agent/generate.ts",
        "B2c:lib/inbox/unmetered.ts",
      ]),
    );
    expect(got.some((g) => g.endsWith("commented.ts"))).toBe(false);
    expect(violations.find((v) => v.rule === "B2")?.line).toBe(1);
  });
});
