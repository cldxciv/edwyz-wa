import { getActor } from "@/lib/auth";
import { assertConversationVisible } from "@/lib/teams/visibility";
import { assertSameOrigin, readJson, reqString } from "@/lib/inbox/http";
import { setStatus } from "@/lib/inbox/status";
import { errorResponse } from "@/lib/tenancy";

type Ctx = { params: Promise<{ id: string }> };

async function handle(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJson(request);
    await assertConversationVisible(actor, (await params).id);
    return Response.json({ conversation: await setStatus(actor, (await params).id, reqString(body, "status", 20)) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** PATCH { status: "open" | "pending" | "solved" | "blocked" } -> { conversation }. PUT is kept for older clients. */
export const PATCH = handle;
export const PUT = handle;
