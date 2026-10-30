import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonObject } from "@/lib/contacts/http";
import { DEFAULT_OPTIMIZER_CONFIG, getBudgetCap, getOptimizerConfig, parseConfigInput, saveOptimizerConfig } from "@/lib/optimizer/config";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ settings: await getOptimizerConfig(actor.tenantId), defaults: DEFAULT_OPTIMIZER_CONFIG, budgetCapMinor: await getBudgetCap(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "owner");
    const settings = await saveOptimizerConfig(actor.tenantId, parseConfigInput(await readJsonObject(request)));
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "optimizer.settings_updated" });
    return Response.json({ settings });
  } catch (e) {
    return errorResponse(e);
  }
}
