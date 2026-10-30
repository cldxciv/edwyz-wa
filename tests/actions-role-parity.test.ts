import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * docs/EDDY-SPEC.md 4.8 test 2 and EDDY-05 acceptance 2: for each definition with a route (and each equivalent route), the
 * route handler's role guard is read from its source (requireRole, adminActor, writeActor, requireOnboardingActor, owner
 * checks). A definition weaker than its route fails. Definitions stricter than their route are allowed (4.10a item 5: Eddy may
 * be stricter) but must be listed below with the reason, so the list stays exact. The broken fixture proves the check bites.
 */
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { EQUIVALENT_ROUTES } from "@/lib/actions/not-exposed";
import { ACTIONS, actionByName, type AnyActionDef } from "@/lib/actions/registry";

type Role = "agent" | "admin" | "owner";
const RANK: Record<Role, number> = { agent: 1, admin: 2, owner: 3 };
const ROOT = path.resolve(__dirname, "..");
const API = path.join(ROOT, "src", "app", "api");

/** Known stricter-than-route cases: the route lets anyone in and checks finer rules inside; Eddy restates the stricter role. */
const STRICTER_THAN_ROUTE: Record<string, string> = {
  "block_conversation PUT /api/inbox/conversations/[id]/status": "The status route admits any member and setStatus refuses blocked for agents; the tool is admin-only.",
  "record_opt_in PATCH /api/contacts/[id]": "The contacts route admits any member and updateContact requires an admin for optIn; the tool is admin-only.",
  "stop_spending PUT /api/spend/freeze": "The freeze route admits any member and kill.ts refuses a team member's stop (403, ledgered); the tool is admin-only (EDDY-06).",
  "decline_spend_request POST /api/spend/approvals/[id]": "The approvals route admits any member and decideApproval refuses a team member's decline; the tool is admin-only (EDDY-06).",
};

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The source of the function that handles a method: `export async function M`, or `export const M = handler` followed to it. */
export function handlerSource(source: string, method: string): string | null {
  const code = stripComments(source);
  const lines = code.split("\n");
  const take = (startRe: RegExp): string | null => {
    const start = lines.findIndex((l) => startRe.test(l));
    if (start < 0) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^(export\s|async\s+function\s|function\s|const\s|type\s)/.test(lines[i])) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join("\n");
  };
  const direct = take(new RegExp(`^export\\s+(?:async\\s+)?function\\s+${method}\\s*\\(`));
  if (direct) return direct;
  const alias = new RegExp(`^export\\s+const\\s+${method}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*;?\\s*$`, "m").exec(code);
  if (alias) return take(new RegExp(`^(?:async\\s+)?function\\s+${alias[1]}\\s*\\(`)) ?? take(new RegExp(`^const\\s+${alias[1]}\\s*=`));
  const inline = take(new RegExp(`^export\\s+const\\s+${method}\\s*=`));
  return inline;
}

/** The role a handler requires before it does anything: owner, admin, or agent (any member). */
export function guardOf(handler: string): Role {
  if (/requireRole\(\s*actor\s*,\s*["']owner["']\s*\)/.test(handler)) return "owner";
  if (/requireRole\(\s*actor\s*,\s*["']admin["']\s*\)|\badminActor\(|\bwriteActor\(|\brequireOnboardingActor\(/.test(handler)) return "admin";
  return "agent";
}

type Check = { key: string; def: string; minRole: Role; guard: Role };

function checks(defs: readonly AnyActionDef[], fileFor: (route: string) => string, equivalents = EQUIVALENT_ROUTES): Check[] {
  const out: Check[] = [];
  const add = (def: AnyActionDef, method: string, route: string) => {
    const handler = handlerSource(readFileSync(fileFor(route), "utf8"), method);
    if (handler === null) throw new Error(`${def.name}: no ${method} handler in ${route}`);
    out.push({ key: `${def.name} ${method} ${route}`, def: def.name, minRole: def.minRole as Role, guard: guardOf(handler) });
  };
  for (const def of defs) if (def.route !== "virtual") add(def, def.route.method, def.route.path);
  for (const e of equivalents) {
    const def = defs.find((d) => d.name === e.action);
    if (def) add(def, e.method, e.route);
  }
  return out;
}

const fileOf = (route: string) => path.join(API, ...route.replace(/^\/api\//, "").split("/"), "route.ts");
const weaker = (list: Check[]) => list.filter((c) => RANK[c.minRole] < RANK[c.guard]).map((c) => `${c.key}: the tool says ${c.minRole}, the route needs ${c.guard}`);
const stricter = (list: Check[]) => list.filter((c) => RANK[c.minRole] > RANK[c.guard]).map((c) => c.key);

describe("role parity (4.8 test 2)", () => {
  const all = checks(ACTIONS, fileOf);

  it("checks every routed definition and every equivalent route", () => {
    expect(all.length).toBe(ACTIONS.filter((d) => d.route !== "virtual").length + EQUIVALENT_ROUTES.length);
  });

  it("no definition is weaker than its route's guard", () => {
    expect(weaker(all)).toEqual([]);
  });

  it("every stricter-than-route case is listed with its reason, and the list has no stale entries", () => {
    expect(stricter(all).sort()).toEqual(Object.keys(STRICTER_THAN_ROUTE).sort());
    for (const reason of Object.values(STRICTER_THAN_ROUTE)) expect(reason.length).toBeGreaterThan(20);
  });

  it("reads the guards the routes use", () => {
    expect(guardOf(handlerSource(readFileSync(fileOf("/api/templates"), "utf8"), "POST")!)).toBe("admin");
    expect(guardOf(handlerSource(readFileSync(fileOf("/api/templates"), "utf8"), "GET")!)).toBe("agent");
    expect(guardOf(handlerSource(readFileSync(fileOf("/api/onboarding/start"), "utf8"), "GET")!)).toBe("admin");
    expect(guardOf(handlerSource(readFileSync(fileOf("/api/quick-replies/[id]"), "utf8"), "DELETE")!)).toBe("admin");
    expect(guardOf(handlerSource(readFileSync(fileOf("/api/quick-replies/[id]"), "utf8"), "PATCH")!)).toBe("agent");
    // `export const PUT = handle` is followed to the handler.
    expect(handlerSource(readFileSync(fileOf("/api/inbox/conversations/[id]/status"), "utf8"), "PUT")).toContain("setStatus");
  });
});

describe("self-test: the broken fixture route fails parity (EDDY-07 acceptance 2)", () => {
  const FIXTURE = path.join(ROOT, "tests", "fixtures", "actions-broken-route", "route.ts");
  const route = "/api/fixtures/actions-broken-route";

  it("an agent tool on an admin route and on an owner route is reported", () => {
    const get = { ...(actionByName("list_team") as AnyActionDef), name: "fixture_read", route: { method: "GET" as const, path: route } };
    const del = { ...(actionByName("delete_contact") as AnyActionDef), name: "fixture_delete", minRole: "admin" as const, route: { method: "DELETE" as const, path: route } };
    const found = weaker(checks([get, del], () => FIXTURE, []));
    expect(found).toEqual([`fixture_read GET ${route}: the tool says agent, the route needs admin`, `fixture_delete DELETE ${route}: the tool says admin, the route needs owner`]);
  });

  it("matching roles pass", () => {
    const get = { ...(actionByName("list_team") as AnyActionDef), name: "fixture_read", minRole: "admin" as const, route: { method: "GET" as const, path: route } };
    expect(weaker(checks([get], () => FIXTURE, []))).toEqual([]);
  });
});
