import { prisma } from "@/lib/db";
import { lowerFirst } from "./personal-data";

export const BATCH = 1000;

type Where = Record<string, unknown>;
export type Delegate = {
  findMany(args: { where: Where; select?: Record<string, boolean>; take?: number }): Promise<Record<string, unknown>[]>;
  deleteMany(args: { where: Where }): Promise<{ count: number }>;
  updateMany(args: { where: Where; data: Record<string, unknown> }): Promise<{ count: number }>;
};

export const delegateFor = (model: string): Delegate => (prisma as unknown as Record<string, Delegate>)[lowerFirst(model)];

export function chunk<T>(items: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Deletes every row that matches `where`, BATCH rows at a time: ids are read with the original filter and the delete repeats
 * that filter, so a batch can never reach rows outside it. Returns the number of rows deleted.
 */
export async function deleteBatched(model: string, where: Where, primaryKey = "id"): Promise<number> {
  const d = delegateFor(model);
  let total = 0;
  for (;;) {
    const rows = await d.findMany({ where, select: { [primaryKey]: true }, take: BATCH });
    if (rows.length === 0) break;
    const { count } = await d.deleteMany({ where: { AND: [where, { [primaryKey]: { in: rows.map((r) => r[primaryKey]) } }] } });
    total += count;
    if (count === 0 || rows.length < BATCH) break;
  }
  return total;
}

/** Same as deleteBatched for a list of ids that is itself possibly large. */
export async function deleteByIds(model: string, base: Where, field: string, values: readonly string[], primaryKey = "id"): Promise<number> {
  let total = 0;
  for (const part of chunk(values)) total += await deleteBatched(model, { ...base, [field]: { in: part } }, primaryKey);
  return total;
}
