import { leadFormErrorResponse, sendTestLead } from "@/lib/promote/lead-forms";
import { promoteRoute } from "@/lib/promote/route-guard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST (admin; Eddy's send_test_lead, a confirm card: X). Sends a Meta test lead to the form. It shows in Leads tagged Test and
 * sends no WhatsApp message and no conversion event (D33). At most 10 an hour per form (429). Answers
 * { formId, testLeadId, code, testLeadUntil }, where testLeadUntil only drives the "Test sent" label.
 * Until lead ingest marks test leads (promote/test-leads.ts TEST_LEADS_MARKED_ON_INGEST) it answers 409
 * "Test leads aren't available yet." and sends nothing, because the lead would be handled as a real one.
 */
export const POST = promoteRoute<Ctx>("write", async ({ actor, dryRun }, _request, { params }) => {
  try {
    return Response.json({ ...(await sendTestLead(actor, (await params).id, { dryRun })), dryRun });
  } catch (error) {
    const answer = leadFormErrorResponse(error);
    if (answer) return answer;
    throw error;
  }
});
