import { handleAdmin } from "@/lib/admin/http";
import { listUsers } from "@/lib/admin/users";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAdmin(
    request,
    false,
    async () => {
      const p = new URL(request.url).searchParams;
      return listUsers({ q: (p.get("q") ?? "").slice(0, 100), page: Math.max(1, Number(p.get("page")) || 1) });
    },
    "admin.api.list_users",
  );
}

export { adminMethodNotAllowed as POST, adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
