/** Minimal in-memory stand-in for the Prisma client: enough where-clause support for the lifecycle code. */
export type Row = Record<string, unknown>;

const RELATIONS: Record<string, { table: string; field: string }> = {
  conversations: { table: "conversation", field: "contactId" },
  broadcastRecipients: { table: "broadcastRecipient", field: "contactId" },
  runs: { table: "leadSequenceRun", field: "leadId" },
};

export type FakeDb = ReturnType<typeof createFakeDb>;

export function createFakeDb() {
  const tables: Record<string, Row[]> = {};
  const events: string[] = [];
  const t = (name: string) => (tables[name] ??= []);

  function field(row: Row, key: string, cond: unknown): boolean {
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (cond && typeof cond === "object") {
      const c = cond as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      if ("contains" in c) return typeof value === "string" && value.includes(c.contains as string);
      if ("startsWith" in c) return typeof value === "string" && value.startsWith(c.startsWith as string);
      if ("path" in c) {
        const base = value as Row | null;
        return !!base && base[(c.path as string[])[0]] === c.equals;
      }
      if ("not" in c) return !field(row, key, c.not);
      if ("lt" in c || "lte" in c || "gt" in c || "gte" in c) {
        if (value === null || value === undefined) return false;
        const v = value instanceof Date ? value.getTime() : (value as number | string);
        const num = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number | string));
        if ("lt" in c && !(v < num(c.lt))) return false;
        if ("lte" in c && !(v <= num(c.lte))) return false;
        if ("gt" in c && !(v > num(c.gt))) return false;
        if ("gte" in c && !(v >= num(c.gte))) return false;
        return true;
      }
      if ("none" in c || "some" in c) {
        const rel = RELATIONS[key];
        const inner = (("none" in c ? c.none : c.some) ?? {}) as Row;
        const related = t(rel.table).filter((r) => r[rel.field] === row.id && matches(r, inner));
        return "none" in c ? related.length === 0 : related.length > 0;
      }
      throw new Error(`fake-db: unsupported condition on ${key}: ${JSON.stringify(c)}`);
    }
    return value === cond;
  }

  function matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (k === "AND") return (v as Row[]).every((w) => matches(row, w));
      if (k === "OR") return (v as Row[]).some((w) => matches(row, w));
      return field(row, k, v);
    });
  }

  const delegate = (name: string) => ({
    findMany: async ({ where, take, select }: { where?: Row; take?: number; select?: Row } = {}) => {
      const rows = t(name).filter((r) => matches(r, where));
      const limited = take === undefined ? rows : rows.slice(0, take);
      return limited.map((r) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r }));
    },
    findFirst: async ({ where }: { where?: Row } = {}) => t(name).find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: { where: Row }) => t(name).find((r) => matches(r, where)) ?? null,
    count: async ({ where }: { where?: Row } = {}) => t(name).filter((r) => matches(r, where)).length,
    deleteMany: async ({ where }: { where?: Row } = {}) => {
      const keep = t(name).filter((r) => !matches(r, where));
      const count = t(name).length - keep.length;
      tables[name] = keep;
      events.push(`delete:${name}`);
      return { count };
    },
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      const rows = t(name).filter((r) => matches(r, where));
      for (const r of rows) Object.assign(r, data);
      events.push(`update:${name}`);
      return { count: rows.length };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = t(name).find((r) => matches(r, where));
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    },
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const row = t(name).find((r) => matches(r, where));
      if (row) Object.assign(row, update);
      else t(name).push({ ...create });
      return row ?? create;
    },
    create: async ({ data }: { data: Row }) => {
      t(name).push({ ...data });
      return data;
    },
  });

  const delegates: Record<string, ReturnType<typeof delegate>> = {};
  const prisma = new Proxy({} as Record<string, unknown>, {
    get(_target, prop: string) {
      if (prop === "$transaction") {
        return async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]));
      }
      if (prop === "then") return undefined;
      return (delegates[prop] ??= delegate(prop));
    },
  });

  return { prisma, tables, events, seed: (name: string, rows: Row[]) => void t(name).push(...rows.map((r) => ({ ...r }))), rows: (name: string) => t(name) };
}
