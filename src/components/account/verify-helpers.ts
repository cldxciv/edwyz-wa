export type ResendOutcome = "sent" | "error";

/** Plain-language result of asking for a new confirmation email. */
export function resendOutcomeText(outcome: ResendOutcome, email: string, detail?: string): string {
  if (outcome === "sent") return `We sent a new link to ${email}. It works for 48 hours.`;
  const reason = (detail ?? "").trim();
  return reason ? `We could not send the email. ${reason}` : "We could not send the email. Try again in a few minutes.";
}
