import { errorResponse } from "@/lib/tenancy";
import { readActor, writeActor, readJson, type Ctx } from "@/lib/creative/http";
import { deleteAsset, getAsset, updateAsset } from "@/lib/creative/service";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await readActor(request);
    return Response.json({ item: await getAsset(actor.tenantId, (await params).id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** PATCH { headline?, body?, description? } -> { item } with a fresh policyCheck */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const actor = await writeActor(request);
    return Response.json({ item: await updateAsset(actor.tenantId, (await params).id, await readJson(request)) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const actor = await writeActor(request);
    await deleteAsset(actor.tenantId, (await params).id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
