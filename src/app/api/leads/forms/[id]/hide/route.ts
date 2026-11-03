import { readTextLimited } from "@/lib/http/body";
import { hideForm } from "@/lib/promote/lead-forms";
import { promoteRoute } from "@/lib/promote/route-guard";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** The body is optional: {} or nothing hides, { undo: true } shows the form again. */
async function undoFlag(request: Request): Promise<boolean> {
  const text = await readTextLimited(request, 1024);
  if (!text.trim()) return false;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "The request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "The request body must be a JSON object.");
  const undo = (body as { undo?: unknown }).undo;
  if (undo !== undefined && typeof undo !== "boolean") throw new HttpError(400, "Send undo as true to show the form again.");
  return undo === true;
}

/**
 * POST { undo?: true } (admin; Eddy's hide_lead_form, undoable). Hides the form in Edwyz only: forms are never archived on Meta
 * through the API (D13). { undo: true } shows it again. Answers { id, hidden }.
 */
export const POST = promoteRoute<Ctx>("write", async ({ actor }, request, { params }) => {
  const undo = await undoFlag(request);
  return Response.json(await hideForm(actor, (await params).id, undo));
});
