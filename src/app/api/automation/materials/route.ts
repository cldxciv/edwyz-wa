import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { createMaterial, listMaterials } from "@/lib/automation/v2/materials";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { materials }. Any member can read, so agents can see what rules send. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json({ materials: await listMaterials(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { name, kind: "text" | "media" | "document", body?, mediaKey?, mediaMime? } (admin or owner) -> 201 { material } */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ material: await createMaterial(actor.tenantId, await readJsonLimited(request, 16 * 1024)) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
