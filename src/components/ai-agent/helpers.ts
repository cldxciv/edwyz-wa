import { AI_OFF_MESSAGE, isAiOffError } from "@/lib/ai-configured";

export const AI_OFF_TITLE = "AI is not switched on for this workspace yet";
export const AI_OFF_BODY = "Ask an admin to set up AI. Until then the agent cannot reply to customers, even when it is enabled, and the test chat cannot answer.";

/** What to tell the person when a test message gets no reply. It is shown as a notice, never inside a bubble as if the assistant had said it. */
export function testChatProblem(message: string | null | undefined): string {
  if (isAiOffError(message)) return AI_OFF_MESSAGE;
  const text = (message ?? "").trim();
  return text && text.length <= 200 ? `We could not get a reply. ${text}` : "We could not get a reply. Try again.";
}
