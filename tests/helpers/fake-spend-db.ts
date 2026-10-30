/**
 * In-memory stand-in for the Prisma client for the spend controls' own tests (docs/SPEND-CONTROLS-SPEC.md 10.1).
 *
 * It wraps tests/helpers/fake-db.ts (same tables, same events, so lifecycle tests keep working) and adds what the Spend Book
 * needs:
 * - spend models with defaults, autoincrement `seq`, bigint comparisons, orderBy, select, increment/decrement updates and the
 *   unique and partial-unique indexes of migration 0009 (a violation throws code P2002, like Prisma);
 * - the append-only triggers of SpendLedger and SpendConsent: UPDATE and DELETE throw (sqlState 42501), except a DELETE inside
 *   a transaction that ran set_config('edwyz.purge', '<table>:<tenantId>', true), and only of that workspace's rows;
 * - interactive $transaction(fn): when fn throws, the transaction's own writes to spend models are undone (writes made outside
 *   it, like a refusal written on another connection, survive, as in Postgres); plus array $transaction;
 * - $executeRaw / $queryRaw (tagged template or Unsafe) recorded in `raw`, with an optional handler for results;
 * - failNext(model, op) to inject a failure.
 * The Eddy tables are not modelled here; their packages extend this helper locally.
 */
import { createFakeDb, type Row } from "./fake-db";

export type { Row };

export type RawCall = { sql: string; values: unknown[]; tx: number | null; kind: "execute" | "query" };
export type TxRecord = { id: number; status: "open" | "committed" | "rolled_back" };

type UniqueIndex = { name: string; fields: string[]; where?: (row: Row) => boolean };
type ModelSpec = { table: string; defaults: () => Row; unique: UniqueIndex[]; idPrefix?: string; seq?: boolean; appendOnly?: boolean; updatedAt?: boolean };

const now = () => new Date();

/** The 16 spend models of 0009 with their defaults and unique indexes. */
const SPEND_MODELS: Record<string, ModelSpec> = {
  spendControl: {
    table: "SpendControl",
    defaults: () => ({ freeze: "none", probation: "auto", timezone: "Asia/Kolkata", approverUserIds: [], approvalTtlHours: 12, breakersMayPauseHumanCampaigns: false, digestEnabled: true, version: 1 }),
    unique: [{ name: "SpendControl_pkey", fields: ["tenantId"] }],
    updatedAt: true,
  },
  spendAllowance: {
    table: "SpendAllowance",
    defaults: () => ({ version: 1, createdAt: now() }),
    unique: [{ name: "SpendAllowance_tenantId_pot_key", fields: ["tenantId", "pot"] }],
    idPrefix: "sa",
    updatedAt: true,
  },
  spendCeiling: {
    table: "SpendCeiling",
    defaults: () => ({ createdAt: now() }),
    unique: [{ name: "SpendCeiling_scope_scopeId_pot_currency_key", fields: ["scope", "scopeId", "pot", "currency"] }],
    idPrefix: "sc",
    updatedAt: true,
  },
  spendCommitment: {
    table: "SpendCommitment",
    defaults: () => ({ peakDailyBudgetMinor: 0n, weekPeakDailyBudgetMinor: 0n, sandbox: false, version: 1, createdAt: now() }),
    unique: [{ name: "SpendCommitment_open_object_key", fields: ["tenantId", "metaObjectId"], where: (r) => r.status !== "stopped" }],
    idPrefix: "cm",
    updatedAt: true,
  },
  spendCounter: {
    table: "SpendCounter",
    defaults: () => ({ reservedMinor: 0n, spentMinor: 0n }),
    unique: [{ name: "SpendCounter_pkey", fields: ["tenantId", "pot", "periodKind", "periodKey"] }],
    updatedAt: true,
  },
  spendReservation: {
    table: "SpendReservation",
    defaults: () => ({ consumedMinor: 0n, status: "held", createdAt: now() }),
    unique: [{ name: "SpendReservation_open_subject_key", fields: ["tenantId", "subjectType", "subjectId"], where: (r) => r.status === "held" }],
    idPrefix: "sr",
  },
  spendDaily: {
    table: "SpendDaily",
    defaults: () => ({ amountMinor: 0n }),
    unique: [{ name: "SpendDaily_pkey", fields: ["tenantId", "pot", "scopeType", "scopeId", "day", "origin"] }],
  },
  intradaySpendSample: { table: "IntradaySpendSample", defaults: () => ({}), unique: [], idPrefix: "is" },
  spendLedger: {
    table: "SpendLedger",
    defaults: () => ({ reasonCodes: [], observe: false, sandbox: false, createdAt: now() }),
    unique: [
      { name: "SpendLedger_seq_key", fields: ["seq"] },
      { name: "SpendLedger_idem_key", fields: ["tenantId", "idempotencyKey", "phase"], where: (r) => r.idempotencyKey !== null && r.idempotencyKey !== undefined },
      { name: "SpendLedger_one_outcome_key", fields: ["tenantId", "correlationId"], where: (r) => ["applied", "failed", "unconfirmed", "refused"].includes(String(r.phase)) },
      { name: "SpendLedger_one_reconciled_key", fields: ["tenantId", "correlationId"], where: (r) => r.phase === "reconciled" },
    ],
    idPrefix: "sl",
    seq: true,
    appendOnly: true,
  },
  metaSpendLimit: {
    table: "MetaSpendLimit",
    defaults: () => ({ mode: "off", unitMode: "unverified", semantics: "unverified", version: 1 }),
    unique: [
      { name: "MetaSpendLimit_pkey", fields: ["adAccountAssetId"] },
      { name: "MetaSpendLimit_one_manager_key", fields: ["accountExternalId"], where: (r) => r.mode === "managed" },
    ],
    updatedAt: true,
  },
  spendConsent: { table: "SpendConsent", defaults: () => ({ createdAt: now() }), unique: [], idPrefix: "scn", appendOnly: true },
  assistantMandate: {
    table: "AssistantMandate",
    defaults: () => ({ enabled: false, level: 0, allowedOps: [], raiseStepPct: 20, approvalSharePct: 25, sandboxOnly: false, version: 1, createdAt: now() }),
    unique: [{ name: "AssistantMandate_tenantId_assistantKey_key", fields: ["tenantId", "assistantKey"] }],
    idPrefix: "am",
    updatedAt: true,
  },
  spendApproval: {
    table: "SpendApproval",
    defaults: () => ({ status: "pending", createdAt: now() }),
    unique: [{ name: "SpendApproval_tokenHash_key", fields: ["tokenHash"] }],
    idPrefix: "sp",
  },
  spendBreaker: {
    table: "SpendBreaker",
    defaults: () => ({ state: "tripped", trippedAt: now() }),
    unique: [{ name: "SpendBreaker_open_key", fields: ["tenantId", "kind", "scopeType", "scopeId"], where: (r) => r.state === "tripped" }],
    idPrefix: "sb",
  },
  assistantShadowRecord: { table: "AssistantShadowRecord", defaults: () => ({ createdAt: now() }), unique: [], idPrefix: "as" },
  ownerNotifyChannel: {
    table: "OwnerNotifyChannel",
    defaults: () => ({ createdAt: now() }),
    unique: [{ name: "OwnerNotifyChannel_tenantId_userId_key", fields: ["tenantId", "userId"] }],
    idPrefix: "on",
    updatedAt: true,
  },
};

export const FAKE_SPEND_MODELS = Object.keys(SPEND_MODELS);

const OPERATORS = new Set(["equals", "in", "notIn", "not", "lt", "lte", "gt", "gte", "contains", "startsWith", "endsWith", "has", "hasSome", "isEmpty", "mode"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !(v instanceof Date) && !Array.isArray(v) && typeof v !== "bigint";
}

function norm(v: unknown): unknown {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  return v;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  const x = norm(a);
  const y = norm(b);
  if (typeof x === "bigint" && typeof y === "bigint") return x === y;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  return x === y;
}

function compare(a: unknown, b: unknown): number {
  const x = norm(a);
  const y = norm(b);
  if (typeof x === "bigint" || typeof y === "bigint") {
    const bx = typeof x === "bigint" ? x : BigInt(x as number);
    const by = typeof y === "bigint" ? y : BigInt(y as number);
    return bx < by ? -1 : bx > by ? 1 : 0;
  }
  return (x as number | string) < (y as number | string) ? -1 : (x as number | string) > (y as number | string) ? 1 : 0;
}

function matchField(value: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond === null) return value === null || value === undefined;
  if (!isPlainObject(cond)) return same(value, cond);
  const keys = Object.keys(cond);
  if (!keys.every((k) => OPERATORS.has(k))) throw new Error(`fake-spend-db: unsupported condition ${JSON.stringify(Object.keys(cond))}`);
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case "equals":
        if (!matchField(value, arg === null ? null : arg)) return false;
        break;
      case "in":
        if (!(arg as unknown[]).some((v) => same(value, v))) return false;
        break;
      case "notIn":
        if ((arg as unknown[]).some((v) => same(value, v))) return false;
        break;
      case "not":
        if (matchField(value, arg)) return false;
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        if (value === null || value === undefined) return false;
        const c = compare(value, arg);
        if (op === "lt" && !(c < 0)) return false;
        if (op === "lte" && !(c <= 0)) return false;
        if (op === "gt" && !(c > 0)) return false;
        if (op === "gte" && !(c >= 0)) return false;
        break;
      }
      case "contains":
        if (typeof value !== "string" || !value.includes(arg as string)) return false;
        break;
      case "startsWith":
        if (typeof value !== "string" || !value.startsWith(arg as string)) return false;
        break;
      case "endsWith":
        if (typeof value !== "string" || !value.endsWith(arg as string)) return false;
        break;
      case "has":
        if (!Array.isArray(value) || !value.some((v) => same(v, arg))) return false;
        break;
      case "hasSome":
        if (!Array.isArray(value) || !(arg as unknown[]).some((a) => value.some((v) => same(v, a)))) return false;
        break;
      case "isEmpty":
        if (!Array.isArray(value) || (value.length === 0) !== arg) return false;
        break;
    }
  }
  return true;
}

/** Flattens Prisma compound-unique selectors such as { tenantId_pot: { tenantId, pot } }. */
function flattenWhere(where: Row | undefined): Row {
  if (!where) return {};
  const out: Row = {};
  for (const [k, v] of Object.entries(where)) {
    if (k.includes("_") && isPlainObject(v) && !Object.keys(v).some((x) => OPERATORS.has(x))) Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}

export function matchesWhere(row: Row, where: Row | undefined): boolean {
  const w = flattenWhere(where);
  return Object.entries(w).every(([k, v]) => {
    if (k === "AND") return (Array.isArray(v) ? v : [v]).every((x) => matchesWhere(row, x as Row));
    if (k === "OR") return (v as Row[]).some((x) => matchesWhere(row, x));
    if (k === "NOT") return !(Array.isArray(v) ? v : [v]).some((x) => matchesWhere(row, x as Row));
    return matchField(row[k], v);
  });
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o as Record<string, "asc" | "desc">));
  return [...rows].sort((a, b) => {
    for (const [field, dir] of specs) {
      const av = a[field];
      const bv = b[field];
      if (av === bv) continue;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const c = compare(av, bv);
      if (c !== 0) return dir === "desc" ? -c : c;
    }
    return 0;
  });
}

const pick = (row: Row, select: Row | undefined): Row => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row });

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (isPlainObject(v) && ("increment" in v || "decrement" in v || "set" in v || "push" in v || "multiply" in v)) {
      const cur = row[k];
      if ("set" in v) row[k] = v.set;
      else if ("increment" in v) row[k] = typeof cur === "bigint" || typeof v.increment === "bigint" ? BigInt((cur as bigint) ?? 0n) + BigInt(v.increment as bigint) : ((cur as number) ?? 0) + (v.increment as number);
      else if ("decrement" in v) row[k] = typeof cur === "bigint" || typeof v.decrement === "bigint" ? BigInt((cur as bigint) ?? 0n) - BigInt(v.decrement as bigint) : ((cur as number) ?? 0) - (v.decrement as number);
      else if ("multiply" in v) row[k] = (cur as number) * (v.multiply as number);
      else if ("push" in v) row[k] = [...((cur as unknown[]) ?? []), ...(Array.isArray(v.push) ? v.push : [v.push])];
    } else row[k] = v;
  }
}

export function uniqueViolation(model: string, target: string[]): Error {
  return Object.assign(new Error(`Unique constraint failed on ${model} (${target.join(", ")})`), { code: "P2002", meta: { modelName: model, target } });
}

export function appendOnlyViolation(table: string, op: string): Error {
  return Object.assign(new Error(`${table} is append-only (${op} refused)`), { code: "P2010", sqlState: "42501", meta: { code: "42501" } });
}

export type FakeSpendDb = ReturnType<typeof createFakeSpendDb>;

/** A loosely typed model delegate, for tests that call the fake directly. */
export type FakeDelegate = {
  findMany(args?: Row): Promise<Row[]>;
  findFirst(args?: Row): Promise<Row | null>;
  findUnique(args: Row): Promise<Row | null>;
  count(args?: Row): Promise<number>;
  create(args: Row): Promise<Row>;
  createMany(args: Row): Promise<{ count: number }>;
  update(args: Row): Promise<Row>;
  updateMany(args: Row): Promise<{ count: number }>;
  upsert(args: Row): Promise<Row>;
  delete(args: Row): Promise<Row>;
  deleteMany(args?: Row): Promise<{ count: number }>;
};

/** A transaction context: its id, its transaction-local settings, and the undo steps of its own writes. */
type TxCtx = { id: number | null; gucs: Record<string, string>; journal: (() => void)[] | null };

export function createFakeSpendDb() {
  const base = createFakeDb();
  const { tables, events } = base;
  const raw: RawCall[] = [];
  const transactions: TxRecord[] = [];
  const failures: { model: string; op: string; error: unknown; times: number }[] = [];
  let rawHandler: ((call: RawCall) => unknown) | null = null;
  let seq = 0n;
  let ids = 0;
  let txIds = 0;
  const t = (name: string) => (tables[name] ??= []);

  function maybeFail(model: string, op: string): void {
    const i = failures.findIndex((f) => f.model === model && (f.op === op || f.op === "*"));
    if (i < 0) return;
    const f = failures[i];
    if (--f.times <= 0) failures.splice(i, 1);
    throw f.error;
  }

  function checkUnique(name: string, spec: ModelSpec, candidate: Row, self?: Row): void {
    for (const idx of spec.unique) {
      if (idx.where && !idx.where(candidate)) continue;
      if (idx.fields.some((f) => candidate[f] === undefined || candidate[f] === null)) continue;
      const clash = t(name).find((r) => r !== self && (!idx.where || idx.where(r)) && idx.fields.every((f) => same(r[f], candidate[f])));
      if (clash) throw uniqueViolation(spec.table, idx.fields);
    }
  }

  function spendDelegate(name: string, spec: ModelSpec, ctx: TxCtx) {
    // Like 0009's edwyz_append_only(): a DELETE passes only inside a transaction whose edwyz.purge names the table AND each
    // deleted row's workspace ('<table>:<tenantId>').
    const guardWrite = (op: "UPDATE" | "DELETE", rows: Row[] = []) => {
      if (!spec.appendOnly) return;
      if (op === "DELETE" && ctx.id !== null && rows.every((r) => ctx.gucs["edwyz.purge"] === `${spec.table}:${String(r.tenantId ?? "")}`)) return;
      throw appendOnlyViolation(spec.table, op);
    };
    const build = (data: Row): Row => {
      const row: Row = { ...spec.defaults(), ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
      if (spec.idPrefix && row.id === undefined) row.id = `${spec.idPrefix}_${++ids}`;
      if (spec.seq && row.seq === undefined) row.seq = ++seq;
      if (spec.updatedAt && row.updatedAt === undefined) row.updatedAt = now();
      return row;
    };
    // Undo steps for this transaction's own writes. Writes made outside it (another connection) survive a rollback, as in Postgres.
    const remember = (undo: () => void) => ctx.journal?.push(undo);
    const rememberRow = (row: Row) => {
      const prev = { ...row };
      remember(() => {
        for (const k of Object.keys(row)) delete row[k];
        Object.assign(row, prev);
      });
    };
    const create = async ({ data, select }: { data: Row; select?: Row }) => {
      maybeFail(name, "create");
      const row = build(data);
      checkUnique(name, spec, row);
      t(name).push(row);
      remember(() => {
        tables[name] = t(name).filter((r) => r !== row);
      });
      events.push(`create:${name}`);
      return pick(row, select);
    };
    return {
      findMany: async ({ where, orderBy, take, skip, select }: { where?: Row; orderBy?: unknown; take?: number; skip?: number; select?: Row } = {}) => {
        maybeFail(name, "findMany");
        let rows = sortRows(t(name).filter((r) => matchesWhere(r, where)), orderBy);
        if (skip) rows = rows.slice(skip);
        if (take !== undefined) rows = take >= 0 ? rows.slice(0, take) : rows.slice(take);
        return rows.map((r) => pick(r, select));
      },
      findFirst: async ({ where, orderBy, select }: { where?: Row; orderBy?: unknown; select?: Row } = {}) => {
        maybeFail(name, "findFirst");
        const row = sortRows(t(name).filter((r) => matchesWhere(r, where)), orderBy)[0];
        return row ? pick(row, select) : null;
      },
      findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
        maybeFail(name, "findUnique");
        const row = t(name).find((r) => matchesWhere(r, where));
        return row ? pick(row, select) : null;
      },
      count: async ({ where }: { where?: Row } = {}) => t(name).filter((r) => matchesWhere(r, where)).length,
      create,
      createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const d of data) {
          try {
            await create({ data: d });
            count++;
          } catch (error) {
            if (!(skipDuplicates && (error as { code?: string }).code === "P2002")) throw error;
          }
        }
        return { count };
      },
      update: async ({ where, data, select }: { where: Row; data: Row; select?: Row }) => {
        maybeFail(name, "update");
        guardWrite("UPDATE");
        const row = t(name).find((r) => matchesWhere(r, where));
        if (!row) throw Object.assign(new Error(`${spec.table} record not found`), { code: "P2025" });
        const next = { ...row };
        applyData(next, data);
        if (spec.updatedAt && data.updatedAt === undefined) next.updatedAt = now();
        checkUnique(name, spec, next, row);
        rememberRow(row);
        Object.assign(row, next);
        events.push(`update:${name}`);
        return pick(row, select);
      },
      updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
        maybeFail(name, "updateMany");
        const rows = t(name).filter((r) => matchesWhere(r, where));
        if (rows.length) guardWrite("UPDATE");
        for (const row of rows) {
          const next = { ...row };
          applyData(next, data);
          if (spec.updatedAt && data.updatedAt === undefined) next.updatedAt = now();
          checkUnique(name, spec, next, row);
          rememberRow(row);
          Object.assign(row, next);
        }
        events.push(`update:${name}`);
        return { count: rows.length };
      },
      upsert: async ({ where, create: createData, update: updateData, select }: { where: Row; create: Row; update: Row; select?: Row }) => {
        maybeFail(name, "upsert");
        const row = t(name).find((r) => matchesWhere(r, where));
        if (!row) return create({ data: createData, select });
        guardWrite("UPDATE");
        const next = { ...row };
        applyData(next, updateData);
        if (spec.updatedAt && updateData.updatedAt === undefined) next.updatedAt = now();
        checkUnique(name, spec, next, row);
        rememberRow(row);
        Object.assign(row, next);
        events.push(`update:${name}`);
        return pick(row, select);
      },
      delete: async ({ where }: { where: Row }) => {
        maybeFail(name, "delete");
        const row = t(name).find((r) => matchesWhere(r, where));
        if (!row) throw Object.assign(new Error(`${spec.table} record not found`), { code: "P2025" });
        guardWrite("DELETE", [row]);
        tables[name] = t(name).filter((r) => r !== row);
        remember(() => void t(name).push(row));
        events.push(`delete:${name}`);
        return row;
      },
      deleteMany: async ({ where }: { where?: Row } = {}) => {
        maybeFail(name, "deleteMany");
        const hit = t(name).filter((r) => matchesWhere(r, where));
        if (hit.length) guardWrite("DELETE", hit);
        tables[name] = t(name).filter((r) => !hit.includes(r));
        if (hit.length) remember(() => void t(name).push(...hit));
        events.push(`delete:${name}`);
        return { count: hit.length };
      },
    };
  }

  function rawCall(ctx: TxCtx, kind: "execute" | "query", first: unknown, rest: unknown[]): unknown {
    let sql: string;
    let values: unknown[];
    if (Array.isArray(first) && "raw" in (first as object)) {
      sql = (first as unknown as TemplateStringsArray).join("$?");
      values = rest;
    } else {
      sql = String(first);
      values = rest;
    }
    const call: RawCall = { sql, values, tx: ctx.id, kind };
    raw.push(call);
    events.push(`raw:${sql.replace(/\s+/g, " ").trim().slice(0, 60)}`);
    const guc = /set_config\(\s*'edwyz\.purge'\s*,\s*(?:'([^']*)'|\$\?)\s*,\s*true\s*\)/i.exec(sql);
    if (guc && ctx.id !== null) ctx.gucs["edwyz.purge"] = guc[1] ?? String(values[0]);
    const handled = rawHandler?.(call);
    if (handled !== undefined) return handled;
    return kind === "execute" ? 1 : [];
  }

  function client(ctx: TxCtx): Record<string, unknown> {
    const delegates: Record<string, unknown> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string) {
        if (prop === "then") return undefined;
        if (prop === "$executeRaw" || prop === "$executeRawUnsafe") return async (first: unknown, ...rest: unknown[]) => rawCall(ctx, "execute", first, rest);
        if (prop === "$queryRaw" || prop === "$queryRawUnsafe") return async (first: unknown, ...rest: unknown[]) => rawCall(ctx, "query", first, rest);
        if (prop === "$transaction") return ctx.id === null ? transaction : undefined;
        const spec = SPEND_MODELS[prop];
        if (spec) return (delegates[prop] ??= spendDelegate(prop, spec, ctx));
        return (base.prisma as Record<string, unknown>)[prop];
      },
    });
  }

  const top: TxCtx = { id: null, gucs: {}, journal: null };
  const prisma = client(top);

  async function transaction(arg: unknown, _opts?: unknown): Promise<unknown> {
    if (typeof arg !== "function") return Promise.all(arg as Promise<unknown>[]);
    const ctx: TxCtx = { id: ++txIds, gucs: {}, journal: [] };
    const record: TxRecord = { id: ctx.id!, status: "open" };
    transactions.push(record);
    events.push(`tx:begin:${ctx.id}`);
    try {
      const result = await (arg as (tx: unknown) => Promise<unknown>)(client(ctx));
      record.status = "committed";
      events.push(`tx:commit:${ctx.id}`);
      return result;
    } catch (error) {
      // Undo this transaction's own writes, newest first. Like a Postgres sequence, `seq` is not given back.
      for (const undo of ctx.journal!.reverse()) undo();
      record.status = "rolled_back";
      events.push(`tx:rollback:${ctx.id}`);
      throw error;
    }
  }

  return {
    prisma,
    tables,
    events,
    raw,
    transactions,
    seed: (name: string, rows: Row[]) => {
      const spec = SPEND_MODELS[name];
      for (const r of rows) {
        const row: Row = spec ? { ...spec.defaults(), ...r } : { ...r };
        if (spec?.seq && row.seq === undefined) row.seq = ++seq;
        t(name).push(row);
      }
    },
    rows: (name: string) => t(name),
    /** The delegate of a model on the top-level client (outside any transaction). */
    model: (name: string) => (prisma as Record<string, unknown>)[name] as FakeDelegate,
    /** Results for raw calls: return undefined to keep the default (1 for execute, [] for query). */
    onRaw: (handler: ((call: RawCall) => unknown) | null) => {
      rawHandler = handler;
    },
    /** The next `times` calls of model.op (op "*" for any) throw `error`. */
    failNext: (model: string, op: string, error: unknown = new Error("injected failure"), times = 1) => {
      failures.push({ model, op, error, times });
    },
    reset: () => {
      for (const k of Object.keys(tables)) delete tables[k];
      events.length = 0;
      raw.length = 0;
      transactions.length = 0;
      failures.length = 0;
      rawHandler = null;
      seq = 0n;
      ids = 0;
    },
  };
}
