import { errorResponse } from "@/lib/tenancy";
import { readActor, writeActor, readJson, type Ctx } from "@/lib/creative/http";
import { createBrand, listBrands } from "@/lib/creative/service";

export const dynamic = "force-dynamic";

/** GET -> { items } (each with suggestedSpecialAdCategory) */
export async function GET(request: Request) {
  try {
    const actor = await readActor(request);
    return Response.json({ items: await listBrands(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { name, websiteUrl?, logoUrl?, colors?, fonts?, tone?, bannedWords?, industry?, specialAdCategory? } -> 201 { item } */
export async function POST(request: Request) {
  try {
    const actor = await writeActor(request);
    return Response.json({ item: await createBrand(actor.tenantId, await readJson(request)) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
