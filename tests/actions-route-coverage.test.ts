import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * docs/EDDY-SPEC.md 4.8 test 1 and EDDY-07 acceptance 1-3: every exported method of every src/app/api/**\/route.ts is the
 * route of a registered definition, an equivalent route of one, a temporary PENDING spend front-desk route, or listed in
 * src/lib/actions/not-exposed.ts with a reason. A new, unclassified route fails, naming the file and the two ways to fix it.
 */
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { PENDING_SPEND_TOOLS } from "@/lib/actions/defs";
import { EQUIVALENT_ROUTES, HTTP_METHODS, NOT_EXPOSED, PENDING, REASONS, notExposedEntry, routeMatches, type HttpMethod } from "@/lib/actions/not-exposed";
import { ACTIONS, actionByName, type AnyActionDef } from "@/lib/actions/registry";

const ROOT = path.resolve(__dirname, "..");
const API = path.join(ROOT, "src", "app", "api");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "actions-broken-route", "route.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

/** Drops block and line comments (route files document their methods in JSDoc; exports start at column 0). */
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The HTTP methods a route module exports: functions, consts and `export { x as GET }` lists. */
export function exportedMethods(source: string): HttpMethod[] {
  const code = stripComments(source);
  const found = new Set<HttpMethod>();
  const names = HTTP_METHODS.join("|");
  for (const m of code.matchAll(new RegExp(`^export\\s+(?:async\\s+)?function\\s+(${names})\\s*\\(`, "gm"))) found.add(m[1] as HttpMethod);
  for (const m of code.matchAll(new RegExp(`^export\\s+(?:const|let|var)\\s+(${names})\\b`, "gm"))) found.add(m[1] as HttpMethod);
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const alias = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (alias && (HTTP_METHODS as readonly string[]).includes(alias)) found.add(alias as HttpMethod);
    }
  }
  return [...found];
}

/** "src/app/api/contacts/[id]/route.ts" -> "/api/contacts/[id]". */
const routeOf = (file: string, base = path.join(ROOT, "src", "app")) => `/${path.relative(base, path.dirname(file)).split(path.sep).join("/")}`;

type Classified = { kind: "action" | "equivalent" | "pending" | "not_exposed"; detail: string };

export function classify(route: string, method: HttpMethod, defs: readonly AnyActionDef[] = ACTIONS): Classified | null {
  const def = defs.find((d) => d.route !== "virtual" && d.route.path === route && d.route.method === method);
  if (def) return { kind: "action", detail: def.name };
  const eq = EQUIVALENT_ROUTES.find((e) => e.route === route && e.method === method);
  if (eq) return { kind: "equivalent", detail: eq.action };
  const pending = PENDING.find((e) => e.route === route && e.method === method);
  if (pending) return { kind: "pending", detail: pending.action };
  const entry = notExposedEntry(route, method);
  return entry ? { kind: "not_exposed", detail: entry.reason } : null;
}

/** The failures for a set of route files, each naming the file, the method and the two ways to fix it. */
export function uncovered(files: string[], defs: readonly AnyActionDef[] = ACTIONS, routeFor: (file: string) => string = (f) => routeOf(f)): string[] {
  const out: string[] = [];
  for (const file of files) {
    const route = routeFor(file);
    for (const method of exportedMethods(readFileSync(file, "utf8"))) {
      if (!classify(route, method, defs)) {
        out.push(`${path.relative(ROOT, file).split(path.sep).join("/")}: ${method} ${route} is not classified. Either give an action in src/lib/actions/defs this route, or list it in src/lib/actions/not-exposed.ts with a reason.`);
      }
    }
  }
  return out;
}

const FILES = walk(API);

describe("every API route is classified (4.8 test 1)", () => {
  it("finds the route files", () => {
    expect(FILES.length).toBeGreaterThan(250);
  });

  it("every exported method is an action's route, an equivalent, pending or not exposed with a reason", () => {
    expect(uncovered(FILES)).toEqual([]);
  });

  it("every definition's route exists and exports that method", () => {
    const missing: string[] = [];
    for (const def of ACTIONS) {
      if (def.route === "virtual") continue;
      const file = path.join(API, ...def.route.path.replace(/^\/api\//, "").split("/"), "route.ts");
      if (!existsSync(file) || !exportedMethods(readFileSync(file, "utf8")).includes(def.route.method)) missing.push(`${def.name}: ${def.route.method} ${def.route.path}`);
    }
    expect(missing).toEqual([]);
  });

  it("equivalents name registered actions and existing routes", () => {
    for (const e of EQUIVALENT_ROUTES) {
      expect(actionByName(e.action), e.action).toBeDefined();
      const file = path.join(API, ...e.route.replace(/^\/api\//, "").split("/"), "route.ts");
      expect(existsSync(file) && exportedMethods(readFileSync(file, "utf8")).includes(e.method), `${e.method} ${e.route}`).toBe(true);
    }
  });

  it("every not-exposed entry has a known reason and still matches a route (Phase 0 spend routes may land later)", () => {
    const routes = FILES.map((f) => routeOf(f));
    for (const entry of NOT_EXPOSED) {
      expect(Object.keys(REASONS), entry.route).toContain(entry.reason);
      const later = entry.route.startsWith("/api/spend/") || entry.route.startsWith("/api/eddy") || entry.route.startsWith("/api/notices");
      if (!later) expect(routes.some((r) => routeMatches(entry.route, r)), `stale entry ${entry.route}`).toBe(true);
    }
  });

  it("the pending list is empty now that the three spend front-desk tools landed (EDDY-06, EDDY-07 acceptance 3)", () => {
    expect(PENDING).toEqual([]);
    expect(PENDING.map((p) => p.action).sort()).toEqual([...PENDING_SPEND_TOOLS].sort());
    for (const p of PENDING) expect(actionByName(p.action), `${p.action} is registered: remove it from PENDING in not-exposed.ts`).toBeUndefined();
  });

  it("the 4.8 reasons are classified as the spec says", () => {
    expect(classify("/api/admin/tenants", "GET")?.detail).toBe("platform");
    expect(classify("/api/auth/login", "POST")?.detail).toBe("auth");
    expect(classify("/api/webhooks/razorpay", "POST")?.detail).toBe("public_or_system");
    expect(classify("/api/eddy/turn", "POST")?.detail).toBe("plumbing");
    expect(classify("/api/mcp", "PUT")?.detail).toBe("plumbing");
    expect(classify("/api/integrations/api-keys", "POST")?.detail).toBe("secret");
    expect(classify("/api/billing/subscribe", "POST")?.detail).toBe("account");
    expect(classify("/api/spend/allowances", "PUT")?.detail).toBe("money_controls");
    expect(classify("/api/contacts/import", "POST")?.detail).toBe("file");
    expect(classify("/api/export/contacts.csv", "GET")?.detail).toBe("bulk_export");
    expect(classify("/api/inbox/stream", "GET")?.detail).toBe("stream");
    expect(classify("/api/broadcasts/[id]/start", "POST")?.detail).toBe("v2");
    expect(classify("/api/spend/freeze", "PUT")).toEqual({ kind: "action", detail: "stop_spending" });
    expect(classify("/api/spend/summary", "GET")).toEqual({ kind: "action", detail: "get_spending" });
    expect(classify("/api/spend/approvals/[id]", "POST")).toEqual({ kind: "action", detail: "decline_spend_request" });
    expect(classify("/api/spend/notify", "POST")?.detail).toBe("money_controls");
    expect(classify("/api/inbox/conversations/[id]/messages", "POST")).toEqual({ kind: "action", detail: "send_text_reply" });
  });
});

describe("self-test: the broken fixture route fails (EDDY-07 acceptance 2)", () => {
  it("an unclassified route fails, naming the file and the two ways to fix it", () => {
    const failures = uncovered([FIXTURE], ACTIONS, () => "/api/fixtures/actions-broken-route");
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("tests/fixtures/actions-broken-route/route.ts");
    expect(failures[0]).toMatch(/GET \/api\/fixtures\/actions-broken-route is not classified/);
    expect(failures[0]).toMatch(/give an action .* this route, or list it in src\/lib\/actions\/not-exposed\.ts with a reason/);
  });

  it("it passes once a definition takes the route", () => {
    const def = { ...(actionByName("list_team") as AnyActionDef), route: { method: "GET" as const, path: "/api/fixtures/actions-broken-route" } };
    const def2 = { ...(actionByName("delete_contact") as AnyActionDef), route: { method: "DELETE" as const, path: "/api/fixtures/actions-broken-route" } };
    expect(uncovered([FIXTURE], [def, def2], () => "/api/fixtures/actions-broken-route")).toEqual([]);
  });

  it("the method parser reads functions, consts and export lists, and ignores comments", () => {
    expect(exportedMethods("export async function GET() {}\nexport const PUT = handle;\nexport { a as PATCH, b as DELETE } from 'x';\n// export async function POST() {}\n/** export function HEAD */").sort()).toEqual(["DELETE", "GET", "PATCH", "PUT"]);
  });
});
