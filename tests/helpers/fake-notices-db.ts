/**
 * In-memory stand-in for the Prisma client in the notice, retention and erasure tests (docs/EDDY-SPEC.md 6.7, 7.6, 9.1,
 * EDDY-16). Any model name is a table. Supported: findMany (where, select with the membership.user relation, orderBy as an
 * object or a list, distinct, take), findFirst, findUnique, count, create, createMany (skipDuplicates), update, updateMany,
 * deleteMany, upsert and $transaction (interactive and array). Where: equality, null, Date, in / notIn, not, lt / lte /
 * gt / gte, has, isEmpty, startsWith, AND / OR / NOT, and compound unique keys (tenantId_dedupeKey: {...}).
 * The unique indexes of the notice store are enforced (code P2002, like Prisma). Every write is logged in `writes` as
 * "<model>.<op>", so a test can prove a producer wrote nothing outside the notice store.
 */
export type Row = Record<string, unknown>;

const OPS = new Set(["in", "notIn", "not", "lt", "lte", "gt", "gte", "has", "hasSome", "isEmpty", "startsWith", "equals", "contains"]);
const isPlain = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
const num = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number | string));

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  return a === b || (a === undefined && b === null) || (a === null && b === undefined);
}

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (!isPlain(cond)) return same(value, cond);
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case "equals":
        if (!same(value, arg)) return false;
        break;
      case "in":
        if (!(arg as unknown[]).some((x) => same(value, x))) return false;
        break;
      case "notIn":
        if ((arg as unknown[]).some((x) => same(value, x))) return false;
        break;
      case "not":
        if (fieldMatches(value, arg)) return false;
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        if (value === null || value === undefined) return false;
        const v = num(value);
        const a = num(arg);
        if (op === "lt" && !(v < a)) return false;
        if (op === "lte" && !(v <= a)) return false;
        if (op === "gt" && !(v > a)) return false;
        if (op === "gte" && !(v >= a)) return false;
        break;
      }
      case "has":
        if (!Array.isArray(value) || !value.includes(arg)) return false;
        break;
      case "hasSome":
        if (!Array.isArray(value) || !(arg as unknown[]).some((x) => value.includes(x))) return false;
        break;
      case "isEmpty":
        if (!Array.isArray(value) || (value.length === 0) !== arg) return false;
        break;
      case "startsWith":
        if (typeof value !== "string" || !value.startsWith(arg as string)) return false;
        break;
      case "contains":
        if (typeof value !== "string" || !value.includes(arg as string)) return false;
        break;
      default:
        throw new Error(`fake-notices-db: unsupported operator ${op}`);
    }
  }
  return true;
}

export function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (k === "AND") return (Array.isArray(v) ? v : [v]).every((w) => matches(row, w as Row));
    if (k === "OR") return (v as Row[]).some((w) => matches(row, w));
    if (k === "NOT") return Array.isArray(v) ? !v.some((w) => matches(row, w as Row)) : !matches(row, v as Row);
    // A compound unique key (tenantId_dedupeKey: {...}): every part must match the row.
    if (isPlain(v) && !(k in row) && !Object.keys(v).every((x) => OPS.has(x))) return matches(row, v);
    return fieldMatches(row[k], v);
  });
}

const UNIQUE: Record<string, string[][]> = {
  notice: [["id"], ["tenantId", "dedupeKey"]],
  noticeReceipt: [["noticeId", "userId"]],
  noticeScanState: [["tenantId", "scanner"]],
  eddyUserPref: [["tenantId", "userId"]],
  membership: [["tenantId", "userId"]],
};

const DEFAULTS: Record<string, () => Row> = {
  notice: () => ({ audienceUserId: null, audienceMinRole: "agent", subjectType: null, subjectId: null, payload: {}, actions: [], count: 1, source: "eddy", resolvedAt: null }),
  noticeReceipt: () => ({ seenAt: null, dismissedAt: null, toastedAt: null }),
  eddyUserPref: () => ({ language: "auto", proactive: true, mutedNoticeKinds: [], firstUseAckAt: null, firstUseVersion: null }),
  eddyConversation: () => ({ status: "active", closedReason: null }),
  eddyMessage: () => ({ contactIds: [], conversationIds: [] }),
  actionRecord: () => ({ contactIds: [], decidedAt: null, expiresAt: null }),
};

type Args = { where?: Row; select?: Row; orderBy?: Row | Row[]; take?: number; distinct?: string[]; by?: string[]; data?: Row | Row[]; create?: Row; update?: Row; skipDuplicates?: boolean };

export type FakeNoticesDb = ReturnType<typeof createFakeNoticesDb>;

export function createFakeNoticesDb(clock: () => Date = () => new Date()) {
  const tables: Record<string, Row[]> = {};
  const writes: string[] = [];
  const failures = new Map<string, Error>();
  let seq = 0;
  const t = (name: string) => (tables[name] ??= []);

  function project(model: string, row: Row, select?: Row): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v) continue;
      if (isPlain(v) && model === "membership" && k === "user") {
        const user = t("user").find((u) => u.id === row.userId) ?? null;
        out.user = user ? project("user", user, (v.select as Row) ?? undefined) : null;
      } else out[k] = row[k];
    }
    return out;
  }

  function sort(rows: Row[], orderBy?: Row | Row[]): Row[] {
    if (!orderBy) return rows;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o));
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const x = num(a[k]);
        const y = num(b[k]);
        if (x === y) continue;
        if (x === undefined || x === null) return 1;
        if (y === undefined || y === null) return -1;
        return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1);
      }
      return 0;
    });
  }

  function checkUnique(model: string, row: Row, except?: Row) {
    for (const fields of UNIQUE[model] ?? []) {
      if (fields.some((f) => row[f] === undefined || row[f] === null)) continue;
      const clash = t(model).find((r) => r !== except && fields.every((f) => same(r[f], row[f])));
      if (clash) throw Object.assign(new Error(`Unique constraint failed on ${fields.join(",")}`), { code: "P2002" });
    }
  }

  function failIfAsked(model: string, op: string) {
    const e = failures.get(`${model}.${op}`);
    if (e) {
      failures.delete(`${model}.${op}`);
      throw e;
    }
  }

  function insert(model: string, data: Row): Row {
    const now = clock();
    const row: Row = { ...(DEFAULTS[model]?.() ?? {}), createdAt: now, updatedAt: now, ...data };
    if (row.id === undefined && !["noticeReceipt", "noticeScanState", "eddyUserPref"].includes(model)) row.id = `${model.slice(0, 3)}_${++seq}`;
    checkUnique(model, row);
    t(model).push(row);
    return row;
  }

  const delegate = (model: string) => ({
    async findMany(a: Args = {}) {
      failIfAsked(model, "findMany");
      let rows = sort(t(model).filter((r) => matches(r, a.where)), a.orderBy);
      if (a.distinct?.length) {
        const seen = new Set<string>();
        rows = rows.filter((r) => {
          const k = JSON.stringify(a.distinct!.map((f) => r[f]));
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      if (a.take !== undefined) rows = rows.slice(0, a.take);
      return rows.map((r) => project(model, r, a.select));
    },
    async findFirst(a: Args = {}) {
      const rows = sort(t(model).filter((r) => matches(r, a.where)), a.orderBy);
      return rows[0] ? project(model, rows[0], a.select) : null;
    },
    async findUnique(a: Args = {}) {
      const row = t(model).find((r) => matches(r, a.where));
      return row ? project(model, row, a.select) : null;
    },
    async count(a: Args = {}) {
      failIfAsked(model, "count");
      return t(model).filter((r) => matches(r, a.where)).length;
    },
    /** One row per distinct value of the `by` fields (no aggregates). */
    async groupBy(a: Args = {}) {
      failIfAsked(model, "groupBy");
      const groups = new Map<string, Row>();
      for (const r of t(model).filter((x) => matches(x, a.where))) {
        const by = a.by ?? [];
        groups.set(JSON.stringify(by.map((f) => r[f])), Object.fromEntries(by.map((f) => [f, r[f]])));
      }
      return [...groups.values()];
    },
    async create(a: Args) {
      failIfAsked(model, "create");
      writes.push(`${model}.create`);
      return project(model, insert(model, a.data as Row), a.select);
    },
    async createMany(a: Args) {
      writes.push(`${model}.createMany`);
      let count = 0;
      for (const d of a.data as Row[]) {
        try {
          insert(model, d);
          count++;
        } catch (e) {
          if (!a.skipDuplicates) throw e;
        }
      }
      return { count };
    },
    async update(a: Args) {
      writes.push(`${model}.update`);
      const row = t(model).find((r) => matches(r, a.where));
      if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
      Object.assign(row, a.data);
      return { ...row };
    },
    async updateMany(a: Args) {
      failIfAsked(model, "updateMany");
      writes.push(`${model}.updateMany`);
      const rows = t(model).filter((r) => matches(r, a.where));
      for (const r of rows) Object.assign(r, a.data);
      return { count: rows.length };
    },
    async deleteMany(a: Args = {}) {
      writes.push(`${model}.deleteMany`);
      const keep = t(model).filter((r) => !matches(r, a.where));
      const count = t(model).length - keep.length;
      tables[model] = keep;
      return { count };
    },
    async upsert(a: Args) {
      writes.push(`${model}.upsert`);
      const row = t(model).find((r) => matches(r, a.where));
      if (row) {
        Object.assign(row, a.update);
        return { ...row };
      }
      return { ...insert(model, a.create as Row) };
    },
  });

  const delegates = new Map<string, ReturnType<typeof delegate>>();
  const client: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== "string" || name === "then") return undefined;
        if (name === "$transaction")
          return async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => Promise<unknown>)(client) : Promise.all(arg as Promise<unknown>[]));
        if (name.startsWith("$")) return async () => 0;
        if (!delegates.has(name)) delegates.set(name, delegate(name));
        return delegates.get(name);
      },
    },
  );

  return {
    client,
    tables,
    writes,
    rows: (model: string) => t(model),
    seed: (model: string, ...rows: Row[]) => rows.map((r) => insert(model, r)),
    failNext: (model: string, op: string, error: Error = new Error("down")) => void failures.set(`${model}.${op}`, error),
    reset: () => {
      for (const k of Object.keys(tables)) delete tables[k];
      writes.length = 0;
      failures.clear();
      seq = 0;
    },
  };
}
