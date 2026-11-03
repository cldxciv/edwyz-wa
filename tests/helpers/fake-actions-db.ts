/**
 * In-memory stand-in for the Prisma client in the action-layer tests (docs/EDDY-SPEC.md 9.1, EDDY-03, EDDY-04). It models
 * just what src/lib/actions and src/lib/inbox/actor-ops use: create, findFirst, findUnique, findMany, count, updateMany and
 * deleteMany with equality, null, Date, in / notIn, not, gt / gte / lt / lte, startsWith, equals (also on arrays), has,
 * AND / OR / NOT, compound unique keys (tenantId_userId), orderBy, take and nested select.
 *
 * Every operation is synchronous inside its promise, so a conditional updateMany is atomic the way one UPDATE statement is
 * in Postgres: two concurrent confirms race exactly as they would on the database. failNext(table, op) injects one failure.
 */
export type Row = Record<string, unknown>;

const OPS = new Set(["in", "notIn", "not", "gt", "gte", "lt", "lte", "startsWith", "contains", "equals", "has", "hasSome", "isEmpty"]);

const isPlain = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  return a === b;
}

const num = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number | string));

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date || !isPlain(cond)) return sameValue(value, cond);
  const keys = Object.keys(cond);
  if (!keys.every((k) => OPS.has(k))) {
    // A compound key (tenantId_userId) or a relation filter: every field must match.
    if (!isPlain(value)) return false;
    return keys.every((k) => fieldMatches(value[k], cond[k]));
  }
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case "in":
        if (!(arg as unknown[]).some((x) => sameValue(value, x))) return false;
        break;
      case "notIn":
        if ((arg as unknown[]).some((x) => sameValue(value, x))) return false;
        break;
      case "not":
        if (fieldMatches(value, arg)) return false;
        break;
      case "equals":
        if (!sameValue(value, arg)) return false;
        break;
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
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (value === null || value === undefined) return false;
        const v = num(value);
        const a = num(arg);
        if (op === "gt" && !(v > a)) return false;
        if (op === "gte" && !(v >= a)) return false;
        if (op === "lt" && !(v < a)) return false;
        if (op === "lte" && !(v <= a)) return false;
        break;
      }
    }
  }
  return true;
}

export function rowMatches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Row[]).every((w) => rowMatches(row, w));
    if (key === "OR") return (cond as Row[]).some((w) => rowMatches(row, w));
    if (key === "NOT") return !rowMatches(row, cond as Row);
    if (key.includes("_") && isPlain(cond) && !Object.keys(cond).some((k) => OPS.has(k))) {
      return Object.entries(cond).every(([k, v]) => fieldMatches(row[k], v));
    }
    return fieldMatches(row[key], cond);
  });
}

const clone = (row: Row): Row => {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = Array.isArray(v) ? [...v] : v instanceof Date ? new Date(v.getTime()) : isPlain(v) ? JSON.parse(JSON.stringify(v)) : v;
  return out;
};

function pick(row: Row, select: Row | undefined): Row {
  if (!select) return clone(row);
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    const value = row[k];
    if (isPlain(v) && isPlain(v.select) && isPlain(value)) out[k] = pick(value, v.select);
    else out[k] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

type OrderBy = Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[];

function sortRows(rows: Row[], orderBy: OrderBy | undefined): Row[] {
  if (!orderBy) return rows;
  const order = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const o of order) {
      const [key, dir] = Object.entries(o)[0];
      const x = num(a[key]);
      const y = num(b[key]);
      if (x === y) continue;
      return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1);
    }
    return 0;
  });
}

const TABLE_DEFAULTS: Record<string, () => Row> = {
  actionRecord: () => ({ conversationId: null, turnId: null, toolUseId: null, preview: null, previewHash: null, nonceHash: null, expiresAt: null, decidedAt: null, result: null, error: null, undo: null, undoUntil: null, undoneAt: null, spendPot: null, spendCorrelationId: null, spendApprovalId: null, supersededById: null, contactIds: [], createdAt: new Date(), updatedAt: new Date() }),
  actionInvocation: () => ({ createdAt: new Date() }),
  // The schema's defaults for a chatbot row (prisma/schema.prisma model Chatbot).
  chatbot: () => ({ status: "draft", publishedFlow: null, version: 1, phoneNumberId: null, triggerKeywords: [], updatedAt: new Date() }),
};

export type FakeActionsDb = ReturnType<typeof createFakeActionsDb>;

export function createFakeActionsDb() {
  const tables: Record<string, Row[]> = {};
  const failures: { table: string; op: string; error: Error }[] = [];
  let seq = 0;
  const t = (name: string) => (tables[name] ??= []);
  const maybeFail = (table: string, op: string) => {
    const i = failures.findIndex((f) => f.table === table && f.op === op);
    if (i >= 0) throw failures.splice(i, 1)[0].error;
  };

  const delegate = (name: string) => ({
    create: async ({ data }: { data: Row }) => {
      maybeFail(name, "create");
      const row: Row = { ...(TABLE_DEFAULTS[name]?.() ?? {}), id: `${name}_${++seq}`, createdAt: new Date(), ...clone(data) };
      t(name).push(row);
      return clone(row);
    },
    findFirst: async ({ where, select, orderBy }: { where?: Row; select?: Row; orderBy?: OrderBy } = {}) => {
      maybeFail(name, "findFirst");
      const row = sortRows(t(name).filter((r) => rowMatches(r, where)), orderBy)[0];
      return row ? pick(row, select) : null;
    },
    findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
      maybeFail(name, "findUnique");
      const row = t(name).find((r) => rowMatches(r, where));
      return row ? pick(row, select) : null;
    },
    findMany: async ({ where, select, orderBy, take }: { where?: Row; select?: Row; orderBy?: OrderBy; take?: number } = {}) => {
      maybeFail(name, "findMany");
      const rows = sortRows(t(name).filter((r) => rowMatches(r, where)), orderBy);
      return (take === undefined ? rows : rows.slice(0, take)).map((r) => pick(r, select));
    },
    count: async ({ where }: { where?: Row } = {}) => t(name).filter((r) => rowMatches(r, where)).length,
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      maybeFail(name, "updateMany");
      const rows = t(name).filter((r) => rowMatches(r, where));
      for (const r of rows) Object.assign(r, clone(data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: { where?: Row } = {}) => {
      const keep = t(name).filter((r) => !rowMatches(r, where));
      const count = t(name).length - keep.length;
      tables[name] = keep;
      return { count };
    },
  });

  const prisma = new Proxy({} as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop === "then") return undefined;
      if (prop === "$transaction") return async (fn: unknown) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn as Promise<unknown>[]));
      if (!(prop in target)) target[prop] = delegate(prop);
      return target[prop];
    },
  });

  return {
    prisma,
    tables,
    rows: (name: string) => t(name),
    insert: (name: string, row: Row) => {
      const full = { ...(TABLE_DEFAULTS[name]?.() ?? {}), ...row };
      t(name).push(full);
      return full;
    },
    failNext: (table: string, op: string, error: Error = new Error(`fake ${table}.${op} failure`)) => failures.push({ table, op, error }),
    reset: () => {
      for (const key of Object.keys(tables)) delete tables[key];
      failures.length = 0;
    },
  };
}
