import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { assertTenantCanWrite } from "@/lib/billing";
import { readJsonObject } from "@/lib/contacts/http";
import { getControl } from "@/lib/spend/control";
import { spendErrorResponse, spendJson } from "@/lib/spend/http";
import { assertMayToggleWorkspace, isFreezeLevel, setWorkspaceFreeze, spendState } from "@/lib/spend/kill";
import { stopInline } from "@/lib/spend/tasks/adsguard";
import type { FreezeLevel, SpendActor } from "@/lib/spend/types";
import { HttpError } from "@/lib/tenancy";

/*
 * PUT /api/spend/freeze, the workspace kill switch (docs/SPEND-CONTROLS-SPEC.md 4.11, 4.17, 2.3.13). Body:
 * { level: "all" | "assistants" | "none", reason?: string }. Settings > Spending limits and Eddy's stop_spending card use it.
 *
 * - Stopping (or stopping more) is a lowering: an owner or an admin may do it, in every workspace state, including locked and
 *   suspended (this path is exempt from the paywall in getActor). It pauses inline with a 20-second budget and answers
 *   "Paused 6 of 6 campaigns" or "Paused 4 of 6; the rest will follow within a minute"; the spend.stop job and the
 *   1-minute sweep finish the rest, even when the worker daemon is down (the /api/internal/tick fallback runs them).
 * - Turning spending back on is owner only, and it is the one raising operation here, so only it checks the paywall. It clears
 *   the workspace's stop and restarts nothing: paused campaigns stay paused until someone resumes them. A stop Edwyz put on
 *   every workspace is not cleared here; only Edwyz support can clear it.
 */

const RANK: Record<FreezeLevel, number> = { none: 0, assistants: 1, all: 2 };
const PLATFORM_NOTE = " Edwyz has paused spending for every workspace for now, so nothing new can start until Edwyz turns it back on.";

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJsonObject(request);
    if (!isFreezeLevel(body.level)) throw new HttpError(400, "Choose to stop assistants, stop all spending, or turn spending back on.");
    const level = body.level;
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) || null : null;
    const who: SpendActor = { type: "user", userId: actor.userId, role: actor.role };

    const current = (await getControl(actor.tenantId, { prune: false })).freeze;
    if (RANK[level] < RANK[current]) {
      // Turning spending (back) on is a raise: the paywall applies. Someone who may not do it at all gets the 403 (with its
      // ledger row) from setWorkspaceFreeze below, not a 402.
      let allowed = true;
      try {
        assertMayToggleWorkspace(current, level, who);
      } catch {
        allowed = false;
      }
      if (allowed) await assertTenantCanWrite(actor.tenantId);
    }

    const result = await setWorkspaceFreeze(actor.tenantId, level, who, reason, { inline: stopInline });
    const state = await spendState(actor.tenantId, { fresh: true });
    const text = level !== "all" && state.platform !== "none" && RANK[state.platform] > RANK[level] ? `${result.text}${PLATFORM_NOTE}` : result.text;
    return spendJson({ freeze: { ...result, text, workspace: state.workspace, platform: state.platform, effective: state.effective } });
  } catch (e) {
    return spendErrorResponse(e);
  }
}
