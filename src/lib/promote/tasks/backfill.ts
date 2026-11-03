/**
 * promote.leads.backfill, every 30 min (docs/IG-PAGE-ADS-SPEC.md 3.11, 4.9, PRM-10): reads the last 26 hours of leads of every form
 * whose ad runs or ran in the last 7 days, at most 500 leads a run, so a lead whose webhook was lost still reaches the Leads hub.
 * The worker (../worker.ts) skips it while PROMOTE_ENABLED=off.
 *
 * Lead reads stay in leads/ (4.1): the work is src/lib/leads/backfill.ts, loaded on the first run, so the worker module itself
 * imports neither the database nor the Graph client. With no form to read it makes two database reads (its stored state, then the
 * ads of campaigns that run or ran in the last 7 days) and no Meta call.
 */
import type { LeadBackfillResult } from "@/lib/leads/backfill";

export type { LeadBackfillResult };

export async function runLeadBackfill(): Promise<LeadBackfillResult> {
  const { backfillLeads } = await import("@/lib/leads/backfill");
  return backfillLeads();
}
