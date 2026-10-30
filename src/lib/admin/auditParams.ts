import type { AuditFilter } from "./queries";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACTION = /^[a-z0-9_.]{1,60}$/;

function date(value: string | null, endOfDay: boolean): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const d = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function parseAuditParams(p: URLSearchParams): AuditFilter {
  const tenantId = p.get("tenantId") ?? "";
  const userId = p.get("userId") ?? "";
  const action = p.get("action") ?? "";
  return {
    tenantId: ID.test(tenantId) ? tenantId : undefined,
    userId: ID.test(userId) ? userId : undefined,
    action: ACTION.test(action) ? action : undefined,
    from: date(p.get("from"), false),
    to: date(p.get("to"), true),
    page: Math.max(1, Number(p.get("page")) || 1),
  };
}
