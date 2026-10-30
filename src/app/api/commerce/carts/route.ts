import { getActor } from "@/lib/auth";
import { listCarts, parseCartQuery } from "@/lib/commerce/queries";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET ?storeId&status&stage&cursor&limit -> { carts, nextCursor }. status: open|recovered|expired|opted_out|replied. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json(await listCarts(actor.tenantId, parseCartQuery(new URL(request.url).searchParams)));
  } catch (e) {
    return errorResponse(e);
  }
}
