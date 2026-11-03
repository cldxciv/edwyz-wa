import { getActor } from "@/lib/auth";
import { templateAccounts } from "@/lib/templates/service";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { accounts: [{ id, name, numbers, isDefault }] }: the workspace's WhatsApp Business accounts, for the template editor's account choice. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json({ accounts: await templateAccounts(actor) });
  } catch (e) {
    return errorResponse(e);
  }
}
