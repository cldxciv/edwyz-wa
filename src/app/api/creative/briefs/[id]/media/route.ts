import { errorResponse } from "@/lib/tenancy";
import { readActor, writeActor, readJson, type Ctx } from "@/lib/creative/http";
import { generateMedia } from "@/lib/creative/service";

export const dynamic = "force-dynamic";

export const maxDuration = 120;

/** POST { kind: image|video, angleId, placement?, headline?, prompt? } -> 201 { item }. Video returns 501 until a provider exists. */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const actor = await writeActor(request);
    return Response.json({ item: await generateMedia(actor.tenantId, (await params).id, await readJson(request)) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
