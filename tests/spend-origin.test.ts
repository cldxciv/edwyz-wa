import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  categoryForSend,
  DEFAULT_ORIGIN,
  HAND_OFF_ON_LIMIT,
  NEVER_BLOCKED_BY_COST,
  normalizeCategory,
  ORIGIN_CLASS,
  originClass,
  parseOrigin,
  SEND_ORIGINS,
  type SendOrigin,
} from "@/lib/spend/messaging/origin";

const ROOT = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

const SENDERS = /\b(sendText|sendMedia|sendTemplateMessage|sendInteractive|sendConversationTemplate)\(/g;

/** The argument text of every outbound send call in a source file (balanced parentheses, so nested calls are kept whole). */
function sendCalls(source: string): { fn: string; args: string }[] {
  const out: { fn: string; args: string }[] = [];
  for (const m of source.matchAll(SENDERS)) {
    const before = source.slice(Math.max(0, m.index! - 30), m.index!);
    if (/(function|import\s*\{[^}]*|\bas)\s*$/.test(before) || /export async function\s*$/.test(before)) continue;
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    const start = i + 1;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) break;
    }
    out.push({ fn: m[1], args: source.slice(start, i) });
  }
  return out;
}

/**
 * Every existing sender stamped by this package (WP-11 call sites, Eddy 4.10a item 3): file, the origin each of its sends
 * carries, and how many sends it has. A new send in one of these files without an origin fails here.
 */
const STAMPED: [file: string, origin: SendOrigin, sends: number][] = [
  ["src/lib/automation/engine.ts", "automation", 1],
  ["src/lib/automation/v2/actions.ts", "automation", 4],
  ["src/lib/automation/v2/holiday.ts", "automation", 1],
  ["src/lib/chatbots/engine.ts", "chatbot", 3],
  ["src/lib/chatbots/worker.ts", "chatbot", 1],
  ["src/lib/leads/runner.ts", "lead_sequence", 1],
  ["src/lib/commerce/reminders.ts", "commerce", 1],
  ["src/lib/approvals/resend.ts", "approval", 2],
  ["src/lib/admin/service.ts", "admin_test", 2],
  ["src/lib/inbox/new-chat.ts", "human", 1],
  ["src/app/api/inbox/conversations/[id]/messages/route.ts", "human", 3],
];

describe("origin stamps at the existing senders", () => {
  it.each(STAMPED)("%s sends as %s", (file, origin, sends) => {
    const calls = sendCalls(read(file));
    expect(calls).toHaveLength(sends);
    for (const call of calls) expect(call.args).toMatch(new RegExp(`\\borigin:\\s*(opts\\.origin \\?\\? )?"${origin}"`));
  });

  it("the member template path forwards the caller's origin and never defaults to a person", () => {
    const source = read("src/lib/inbox/template-send.ts");
    const [call] = sendCalls(source).filter((c) => c.fn === "sendTemplateMessage");
    expect(call.args).toMatch(/origin: opts\.origin \?\? DEFAULT_ORIGIN/);
    expect(DEFAULT_ORIGIN).toBe("unknown");
  });

  it("queueOutbound and sendInteractive stamp the Message and the job, with unknown for an unstamped caller", () => {
    const service = read("src/lib/inbox/service.ts");
    expect(service).toMatch(/const origin = base\.origin \?\? DEFAULT_ORIGIN;/);
    expect(service).toMatch(/origin,\s*\n\s*pricingCategory: stamp\.category,/);
    expect(service).toMatch(/origin,\s*\n\s*category: stamp\.category,\s*\n\s*wabaRefId: stamp\.wabaRefId,/);
    const interactive = read("src/lib/inbox/interactive.ts");
    expect(interactive).toMatch(/const origin = input\.origin \?\? DEFAULT_ORIGIN;/);
    expect(interactive).toMatch(/origin, category: FREE_FORM_CATEGORY, wabaRefId: null/);
  });
});

/** Bypass rule B13: a worker cannot claim a human origin. */
const WORKER_DIRS = ["src/lib/automation", "src/lib/chatbots", "src/lib/leads", "src/lib/commerce", "src/lib/broadcasts", "src/lib/worker", "src/worker"];

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const rel = path.join(dir, name);
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(name) ? [rel] : [];
  });
}

describe("bypass rule B13: no worker path claims human", () => {
  const files = WORKER_DIRS.flatMap(walk);
  it("scans the worker directories", () => {
    expect(files.length).toBeGreaterThan(20);
  });
  it("finds no origin: 'human' there", () => {
    const offenders = files.filter((f) => /origin:\s*["']human["']/.test(read(f)));
    expect(offenders).toEqual([]);
  });
  it("the scan would catch one", () => {
    expect(/origin:\s*["']human["']/.test(`await sendText({ tenantId, conversationId, body, origin: "human" });`)).toBe(true);
    expect(/origin:\s*["']human["']/.test(`await sendText({ tenantId, conversationId, body, origin: 'human' });`)).toBe(true);
  });
});

describe("the origin table", () => {
  it("classes every origin as in 4.9, with unknown treated as automated", () => {
    expect(Object.keys(ORIGIN_CLASS).sort()).toEqual([...SEND_ORIGINS].sort());
    expect(originClass("unknown")).toBe("automated");
    expect(originClass("approval")).toBe("human");
    expect(originClass("consent")).toBe("compliance");
    expect(originClass("system_notify")).toBe("platform");
    expect(originClass("admin_test")).toBe("platform");
    expect(originClass("mcp")).toBe("api");
    expect(originClass("eddy")).toBe("eddy");
    expect(originClass("assistant")).toBe("assistant");
    for (const o of ["broadcast", "automation", "chatbot", "ai_reply", "lead_sequence", "commerce"] as const) expect(originClass(o)).toBe("automated");
  });
  it("never blocks people's own, compliance, platform notices and Eddy-confirmed sends by cost; hands auto-replies off", () => {
    expect([...NEVER_BLOCKED_BY_COST].sort()).toEqual(["approval", "consent", "eddy", "human", "system_notify"]);
    expect([...HAND_OFF_ON_LIMIT].sort()).toEqual(["ai_reply", "chatbot"]);
  });
  it("reads anything unrecognised as unknown", () => {
    expect(parseOrigin("chatbot")).toBe("chatbot");
    expect(parseOrigin("HUMAN")).toBe("unknown");
    expect(parseOrigin(undefined)).toBe("unknown");
    expect(parseOrigin(42)).toBe("unknown");
  });
  it("prices free-form as SERVICE, a template at its category, and anything unknown as MARKETING", () => {
    expect(categoryForSend("text")).toBe("SERVICE");
    expect(categoryForSend("interactive", "MARKETING")).toBe("SERVICE");
    expect(categoryForSend("template", "utility")).toBe("UTILITY");
    expect(categoryForSend("template", null)).toBe("MARKETING");
    expect(normalizeCategory("authentication_international")).toBe("AUTHENTICATION");
    expect(normalizeCategory("marketing_lite")).toBe("MARKETING");
    expect(normalizeCategory("referral_conversion")).toBe("SERVICE");
    expect(normalizeCategory("service")).toBe("SERVICE");
    expect(normalizeCategory("brand_new")).toBe("MARKETING");
  });
});
