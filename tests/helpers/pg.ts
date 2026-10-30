/**
 * Database integration helper for the vitest `db` project (docs/SPEND-CONTROLS-SPEC.md 10.2).
 *
 * Tests run only when DATABASE_URL_TEST names a disposable Postgres (11 or later). Each test file gets its own schema
 * (`edwyz_t_<random>`), applies prisma/migrations in order inside it the way the release does (psql -1 for every file, and
 * WITHOUT a transaction for 0010_spend_message_indexes, whose CREATE INDEX CONCURRENTLY cannot run in one), and drops the
 * schema afterwards. Nothing outside that schema is touched. With the variable unset, `describe.skipIf(!HAS_TEST_DB)` skips
 * the whole file.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";

export const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST?.trim() || undefined;
export const HAS_TEST_DB = !!DATABASE_URL_TEST;

export const MIGRATIONS_DIR = path.resolve(__dirname, "../../prisma/migrations");

/** Migration folder names in apply order (0001_init, 0002_platform, ...). */
export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}_/.test(d.name))
    .map((d) => d.name)
    .sort();
}

export function readMigration(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

/** True for a migration that must be applied without psql -1 (it uses CREATE INDEX CONCURRENTLY). */
export function needsNoTransaction(sql: string): boolean {
  return /\bCONCURRENTLY\b/i.test(stripSqlComments(sql));
}

/** Removes -- line comments outside quotes and dollar-quoted bodies. */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote) {
      if (sql.startsWith(quote, i)) {
        out += quote;
        i += quote.length;
        quote = null;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        quote = tag[0];
        out += tag[0];
        i += tag[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Splits a migration into statements on top-level semicolons (quotes and $$ bodies respected). */
export function splitSqlStatements(sql: string): string[] {
  const text = stripSqlComments(sql);
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (text.startsWith(quote, i)) {
        cur += quote;
        i += quote.length - 1;
        quote = null;
      } else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i));
      if (tag) {
        quote = tag[0];
        cur += tag[0];
        i += tag[0].length - 1;
        continue;
      }
    }
    if (ch === ";" && !quote) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Applies one migration file: in a single transaction (psql -1), or statement by statement for the CONCURRENTLY file. */
export async function applyMigration(client: pg.Client, name: string): Promise<void> {
  const sql = readMigration(name);
  if (needsNoTransaction(sql)) {
    for (const statement of splitSqlStatements(sql)) await client.query(statement);
    return;
  }
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export type TestDb = {
  schema: string;
  /** The main connection, with search_path set to the test schema. */
  client: pg.Client;
  query: <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) => Promise<pg.QueryResult<R>>;
  /** A second, independent connection on the same schema (for concurrency and lock tests). Closed by close(). */
  connect: () => Promise<pg.Client>;
  /** Applies the given migrations, or all that are not applied yet, in order. */
  migrate: (names?: string[]) => Promise<string[]>;
  applied: string[];
  close: () => Promise<void>;
};

function assertDisposable(url: string): void {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() === url) {
    throw new Error("DATABASE_URL_TEST must not be the application database (DATABASE_URL). Point it at a disposable Postgres.");
  }
}

async function open(url: string, schema: string | null): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  if (schema) await client.query(`SET search_path TO "${schema}"`);
  return client;
}

/**
 * Creates a fresh schema and applies migrations up to and including `upTo` (default: all). Seed old data between steps by
 * passing `upTo` and calling migrate() again, as the backfill tests do.
 */
export async function createTestDb(opts: { upTo?: string } = {}): Promise<TestDb> {
  if (!DATABASE_URL_TEST) throw new Error("DATABASE_URL_TEST is not set.");
  assertDisposable(DATABASE_URL_TEST);
  const schema = `edwyz_t_${randomBytes(6).toString("hex")}`;
  const admin = await open(DATABASE_URL_TEST, null);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const client = await open(DATABASE_URL_TEST, schema);
  const extra: pg.Client[] = [];
  const applied: string[] = [];
  const all = migrationNames();

  const migrate = async (names?: string[]): Promise<string[]> => {
    const todo = names ?? all.filter((n) => !applied.includes(n));
    for (const name of todo) {
      await applyMigration(client, name);
      applied.push(name);
    }
    return todo;
  };

  const target = opts.upTo ? all.slice(0, all.indexOf(opts.upTo) + 1) : all;
  if (opts.upTo && !all.includes(opts.upTo)) throw new Error(`Unknown migration ${opts.upTo}`);
  await migrate(target);

  return {
    schema,
    client,
    query: (text, values) => client.query(text, values as unknown[]),
    connect: async () => {
      const c = await open(DATABASE_URL_TEST, schema);
      extra.push(c);
      return c;
    },
    migrate,
    applied,
    close: async () => {
      for (const c of extra) await c.end().catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}

/** Resolves with the SQLSTATE of the error the promise rejects with, or null when it resolves. */
export async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

/** Runs `fn` inside BEGIN / COMMIT on the given client, rolling back on error. */
export async function inTransaction<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const out = await fn();
    await client.query("COMMIT");
    return out;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
