import { getActor } from "@/lib/auth";
import { listConnections } from "@/lib/meta-connect/service";
import { META_CONNECT_SCOPES, SCOPE_PURPOSES } from "@/lib/meta-connect/scopes";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const connections = await listConnections(actor.tenantId);
    const scopes = META_CONNECT_SCOPES.map((scope) => ({ scope, purpose: SCOPE_PURPOSES[scope] }));
    return Response.json({ connections, scopes, configured: Boolean(process.env.META_LOGIN_CONFIG_ID && process.env.META_APP_ID) });
  } catch (e) {
    return errorResponse(e);
  }
}
