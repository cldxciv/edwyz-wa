import { handleAdmin } from "@/lib/admin/http";
import { isSpendingFilter, listSpending, spendingAlerts, type SpendingFilter } from "@/lib/admin/spending";

export const dynamic = "force-dynamic";

/*
 * GET /api/admin/spending?filter=&q=&page=: every workspace's spending row (from the 5-minute summary cache), the platform
 * switch and the alerts strip (docs/SPEND-CONTROLS-SPEC.md 8.3). Platform admins only (handleAdmin: allowlist, verified email,
 * TOTP step-up); anyone else gets the same 404 as a missing page.
 */
export async function GET(request: Request) {
  return handleAdmin(
    request,
    false,
    async () => {
      const p = new URL(request.url).searchParams;
      const raw = p.get("filter");
      const filter: SpendingFilter = isSpendingFilter(raw) ? raw : "all";
      const { all, ...list } = await listSpending({ filter, q: (p.get("q") ?? "").slice(0, 100), page: Math.max(1, Number(p.get("page")) || 1) });
      return { ...list, alerts: await spendingAlerts(all) };
    },
    "admin.api.list_spending",
  );
}

export { adminMethodNotAllowed as POST, adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
