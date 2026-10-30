import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJsonObject } from "@/lib/contacts/http";
import { spendErrorResponse, spendJson } from "@/lib/spend/http";
import { notifySettingsFor, optIn, optOutOwn } from "@/lib/spend/notify/owner-channel";

/*
 * /api/spend/notify: the caller's own WhatsApp alerts for spending (docs/SPEND-CONTROLS-SPEC.md 7.4 item 3, 8.1 NotifyCard).
 *
 * GET     The caller's own channel (full number for its owner only), whether they may set one (the owner, or an admin the
 *         owner named as an approver), the consent text and its version, and that email alerts are off (12.1a decision 2).
 * POST    { phone, consent: true, textVersion } signs the caller up: an append-only SpendConsent row, a pending channel,
 *         then spend_optin_v1 from Edwyz's own number. The "Yes" reply on WhatsApp finishes it. Same origin only. Refused
 *         with 409 before anything is stored when the sender cannot send now, and limited to 3 confirmations an hour.
 * DELETE  Turns the caller's own WhatsApp alerts off. A lowering, so it works in every workspace state.
 * /api/spend/ is exempt from the paywall in getActor: none of these raises spending.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return spendJson({ notify: await notifySettingsFor(actor) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return spendErrorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJsonObject(request);
    const channel = await optIn(actor, { phone: body.phone, consent: body.consent, textVersion: body.textVersion });
    return spendJson({ channel }, { status: 201 });
  } catch (e) {
    return spendErrorResponse(e);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    return spendJson({ channel: await optOutOwn(actor) });
  } catch (e) {
    return spendErrorResponse(e);
  }
}
