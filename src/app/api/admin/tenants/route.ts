import { handleAdmin } from "@/lib/admin/http";
import { listTenants, TENANT_FILTERS, type TenantFilter } from "@/lib/admin/tenants";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAdmin(
    request,
    false,
    async () => {
      const p = new URL(request.url).searchParams;
      const filter = TENANT_FILTERS.includes(p.get("filter") as TenantFilter) ? (p.get("filter") as TenantFilter) : "all";
      return listTenants({ filter, q: (p.get("q") ?? "").slice(0, 100), page: Math.max(1, Number(p.get("page")) || 1) });
    },
    "admin.api.list_tenants",
  );
}

export { adminMethodNotAllowed as POST, adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
