export const PAUSE_REASONS = [
  "tenant_blocked",
  "template_paused",
  "template_quality",
  "number_quality",
  "missing_values",
  "number_quality_yellow",
  "spending_stopped",
  "messaging_limit",
] as const;
export type PauseReasonCode = (typeof PAUSE_REASONS)[number];

/** Pause reasons that come from the spending controls (docs/SPEND-CONTROLS-SPEC.md 4.9, 6.3): the owner also gets an in-app notice. */
export const SPEND_PAUSE_REASONS: ReadonlySet<PauseReasonCode> = new Set<PauseReasonCode>(["number_quality_yellow", "spending_stopped", "messaging_limit"]);

/** Plain-language explanation and next step for each pause reason (shown on the broadcast page and in the email). */
export const PAUSE_COPY: Record<PauseReasonCode, { title: string; body: string }> = {
  tenant_blocked: { title: "Paused because the workspace is locked", body: "Sending stopped because the workspace is suspended or its plan needs attention. Resume it once that is fixed." },
  template_paused: {
    title: "Paused because the template was paused by WhatsApp",
    body: "WhatsApp paused or turned off this template, usually because people reported it or rated it low. Nobody is lost: the people who have not received it yet are kept. Wait for the template to work again and resume, or send the same people another approved template.",
  },
  template_quality: {
    title: "Paused because the template's quality dropped",
    body: "WhatsApp rated this template's quality as low, which usually means people are blocking or reporting it. Sending stopped before WhatsApp turns the template off. Nobody is lost: the people who have not received it yet are kept. Resume if you are sure, or send the same people another approved template.",
  },
  number_quality: { title: "Paused because the number's quality rating is low", body: "Sending stops by itself while the rating is low so it does not get worse. Resume once the rating recovers." },
  missing_values: { title: "Paused because a contact is missing a value", body: "Your broadcast is set to stop when a contact has no value for a placeholder. Fix the contact, or switch the broadcast to skip those contacts, then resume." },
  number_quality_yellow: {
    title: "Paused because the number's quality rating dropped to medium",
    body: "WhatsApp rated this number's quality as medium, so marketing broadcasts from it stop until it recovers. Nobody is lost: the people who have not received it yet are kept. Other messages, like replies and order updates, still go out. Resume once the rating is back to high, or wait and we will tell you when it recovers.",
  },
  spending_stopped: {
    title: "Paused because spending is stopped",
    body: "Spending is stopped for this workspace, so broadcasts wait. Nobody is lost: the people who have not received it yet are kept. The owner can turn spending back on in Settings > Spending limits, then resume this broadcast.",
  },
  messaging_limit: {
    title: "Paused because it won't fit your WhatsApp limit",
    body: "At today's figures the rest of this broadcast could cost more than is left in your WhatsApp limit, so it stopped before sending more. Nobody is lost: the people who have not received it yet are kept. Raise the limit in Settings > Spending limits or send to fewer people, then resume.",
  },
};
