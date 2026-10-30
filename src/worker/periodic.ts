import { prisma } from "@/lib/db";
import type { PeriodicTask } from "./registry";

/**
 * Runs the task if its interval has elapsed. The claim is a single atomic SQL statement, so when several worker
 * processes call this at once only one of them wins the right to run.
 */
export async function runPeriodic(task: PeriodicTask): Promise<boolean> {
  const key = `periodic:${task.name}`;
  const claimed = await prisma.$queryRaw<{ key: string }[]>`
    INSERT INTO "PlatformSetting" (key, value, "updatedAt")
    VALUES (${key}, jsonb_build_object('lastRunAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), now())
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_build_object('lastRunAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), "updatedAt" = now()
      WHERE "PlatformSetting"."updatedAt" < now() - (${task.everyMs} * interval '1 millisecond')
    RETURNING key`;
  if (claimed.length === 0) return false;
  try {
    await task.run();
  } catch (error) {
    console.error(`[worker] periodic task ${task.name} failed:`, error instanceof Error ? error.message : "unknown");
  }
  return true;
}
