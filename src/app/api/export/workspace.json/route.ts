import { download, workspaceJson } from "@/lib/reports/export";
import { adminActor } from "@/lib/reports/http";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await adminActor(request);
    return download(workspaceJson(actor), "workspace.json", "application/json; charset=utf-8");
  } catch (e) {
    return errorResponse(e);
  }
}
