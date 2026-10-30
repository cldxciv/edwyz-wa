import { errorResponse } from "@/lib/tenancy";
import { readActor, writeActor, readJson, type Ctx } from "@/lib/creative/http";
import { deleteBrand, getBrand, updateBrand, withSuggestion } from "@/lib/creative/service";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await readActor(request);
    return Response.json({ item: withSuggestion(await getBrand(actor.tenantId, (await params).id)) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const actor = await writeActor(request);
    return Response.json({ item: await updateBrand(actor.tenantId, (await params).id, await readJson(request)) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Deletes the brand, its briefs, assets and stored files. */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const actor = await writeActor(request);
    await deleteBrand(actor.tenantId, (await params).id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
