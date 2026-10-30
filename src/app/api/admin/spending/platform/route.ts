import { handleAdmin, readBody } from "@/lib/admin/http";
import { applyPlatformSwitch } from "@/lib/admin/spending";
import { stepUpCookie } from "@/lib/admin/stepup";

export const dynamic = "force-dynamic";

/*
 * POST /api/admin/spending/platform {action: "stop_assistants" | "stop_all" | "resume", reason, confirm, code?}: the
 * platform-wide spending switch (docs/SPEND-CONTROLS-SPEC.md 4.11, 8.3). Stopping needs the typed "STOP SPENDING", turning it
 * back on "START SPENDING"; both need a reason and a TOTP step-up no older than 5 minutes (a code typed in the dialog counts
 * as a fresh one, and refreshes the step-up cookie). Up to 25 workspaces are paused inline, the rest by the spend.stop job.
 */
export async function POST(request: Request) {
  return handleAdmin(request, true, async ({ actor }) => {
    const result = await applyPlatformSwitch(actor.userId, await readBody(request), request);
    const headers: Record<string, string> = { "cache-control": "no-store", "x-robots-tag": "noindex" };
    if (result.freshStepUp) headers["set-cookie"] = stepUpCookie(actor.userId);
    return Response.json(result, { headers });
  });
}

export { adminMethodNotAllowed as GET, adminMethodNotAllowed as HEAD, adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
