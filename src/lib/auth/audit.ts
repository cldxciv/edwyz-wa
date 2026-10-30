import { prisma } from "@/lib/db";

/** Never pass passwords or tokens in meta. */
export async function audit(entry: {
  tenantId?: string | null;
  userId?: string | null;
  action: string;
  target?: string;
  meta?: Record<string, string | number | boolean | null>;
}) {
  try {
    await prisma.auditLog.create({
      data: { tenantId: entry.tenantId ?? null, userId: entry.userId ?? null, action: entry.action, target: entry.target ?? null, meta: entry.meta ?? undefined },
    });
  } catch {
    console.error("[audit] failed to write", entry.action);
  }
}
