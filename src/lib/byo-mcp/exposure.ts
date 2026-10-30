import { prisma } from "@/lib/db";
import { isCustomerSafeTool, type ToolHints } from "./risk";

const MAX_ENTRIES = 2000;

type ToolRef = { connectionId: string; name: string; description: string } & ToolHints;

export const customerToolsKey = (tenantId: string) => `byo-mcp:customer-tools:${tenantId}`;
export const exposureEntry = (connectionId: string, toolName: string) => `${connectionId}:${toolName}`;

/** Entries ("connectionId:toolName") the admin explicitly let the customer-facing AI agent call. Fails closed: any problem means none. */
export async function getCustomerExposure(tenantId: string): Promise<Set<string>> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: customerToolsKey(tenantId) } });
    const value = row?.value;
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

async function save(tenantId: string, entries: Set<string>): Promise<void> {
  const value = [...entries].slice(0, MAX_ENTRIES);
  const key = customerToolsKey(tenantId);
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

/** One read-modify-write at a time per workspace in this process, so two saves cannot restore each other's stale entries. */
const queues = new Map<string, Promise<unknown>>();

function serialised<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(tenantId) ?? Promise.resolve()).catch(() => undefined).then(work);
  queues.set(tenantId, run);
  const clear = () => {
    if (queues.get(tenantId) === run) queues.delete(tenantId);
  };
  run.then(clear, clear);
  return run;
}

/** Replaces the exposure entries of one connection (other connections are untouched). Throws when the write fails. */
export function setConnectionExposure(tenantId: string, connectionId: string, toolNames: string[]): Promise<void> {
  return serialised(tenantId, async () => {
    const prefix = `${connectionId}:`;
    const row = await prisma.platformSetting.findUnique({ where: { key: customerToolsKey(tenantId) } });
    const current = Array.isArray(row?.value) ? (row.value as unknown[]).filter((v): v is string => typeof v === "string") : [];
    const next = new Set(current.filter((e) => !e.startsWith(prefix)));
    for (const name of toolNames) next.add(exposureEntry(connectionId, name));
    await save(tenantId, next);
  });
}

export const clearConnectionExposure = (tenantId: string, connectionId: string) => setConnectionExposure(tenantId, connectionId, []);

/**
 * Read-only by default: a tool reaches customers without a flag only when it positively looks read-only (the server's readOnlyHint or a lookup-style name).
 * Everything else (send, refund, delete, update, create, add, approve, issue, book...) needs the admin's explicit customer flag.
 */
export function filterCustomerTools<T extends ToolRef>(tools: T[], exposed: Set<string>): T[] {
  return tools.filter((t) => isCustomerSafeTool(t.name, t.description, t) || exposed.has(exposureEntry(t.connectionId, t.name)));
}

export async function listCustomerTools<T extends ToolRef>(tenantId: string, tools: T[]): Promise<T[]> {
  return filterCustomerTools(tools, await getCustomerExposure(tenantId));
}
