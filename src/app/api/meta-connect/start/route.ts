import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { startConnect } from "@/lib/meta-connect/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * True when the browser opened Facebook Login for Business in a popup (docs/EDDY-SPEC.md 12.1a decision 11): `?popup=1`, or
 * a JSON body `{ "popup": 1 }` / `{ "popup": true }`. Anything else (no body, a form, another value) is the full-page redirect.
 */
async function wantsPopup(request: Request): Promise<boolean> {
  if (new URL(request.url).searchParams.get("popup") === "1") return true;
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return false;
  try {
    const body = (await request.json()) as { popup?: unknown } | null;
    return body?.popup === 1 || body?.popup === true || body?.popup === "1";
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json(await startConnect(actor, { popup: await wantsPopup(request) }));
  } catch (e) {
    return errorResponse(e);
  }
}
