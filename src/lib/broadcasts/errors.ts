const CODE_TEXT: Record<string, string> = {
  "131026": "This number could not receive the message. It may not be on WhatsApp.",
  "131047": "The 24-hour chat window was closed, so only approved templates can be sent.",
  "131048": "WhatsApp slowed sending because too many messages were reported as spam.",
  "131049": "WhatsApp held this message back because the person already received many marketing messages.",
  "131050": "This person chose to stop receiving marketing messages.",
  "131053": "WhatsApp could not use the image, video or document in the message header.",
  "131056": "Too many messages were sent to this person in a short time.",
  "130429": "Sending was too fast, so WhatsApp refused this message.",
  "130472": "WhatsApp chose not to deliver this marketing message to this person.",
  "130497": "WhatsApp does not allow this business to send marketing messages to this country.",
  "131042": "There is a payment problem on the WhatsApp Business account.",
  "132000": "The template values did not match the template.",
  "132001": "The template could not be found or is not approved.",
  "132005": "The translated template text is too long.",
  "132012": "A template value was in the wrong format.",
  "132015": "The template is paused because of low quality.",
  "132016": "The template is disabled because of low quality.",
  missing_variable: "A value needed by the template was missing for this contact.",
  bsuid_auth_template: "Login code templates need a phone number. This person uses a WhatsApp username and has not shared theirs.",
  no_recipient: "This contact has no phone number or WhatsApp user id, so there was nobody to send to.",
  no_message_id: "WhatsApp did not confirm that the message was accepted.",
  send_failed: "The message could not be sent.",
  blocked: "Someone in your team blocked this contact, so the broadcast skipped them.",
};

/** Plain-language reason for a failed or skipped recipient. The raw code stays available for a Details line. */
export function errorCodeText(code: string | null | undefined): string | null {
  const key = (code ?? "").trim();
  if (!key) return null;
  return CODE_TEXT[key] ?? "WhatsApp could not deliver this message.";
}
