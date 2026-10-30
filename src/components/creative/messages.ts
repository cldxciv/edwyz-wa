import { AI_OFF_MESSAGE, isAiOffError } from "@/lib/ai-configured";

const TECHNICAL = /failed to fetch|networkerror|load failed|unexpected token|undefined|\bnull\b|\bjson\b|\bat \w+\.\w+|\b[45]\d\d\b|\bECONN|stack|prisma|sql|invalid (time|date)|rangeerror/i;

/**
 * The text to show a person after a failed request. Server messages written for people ("Choose a time in the
 * future.") pass through; browser and runtime noise is replaced by the fallback, which says what to do next. The
 * server's "AI is not configured." refusal becomes the same sentence the inbox uses, naming whom to ask.
 */
export function friendlyMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  if (isAiOffError(message)) return AI_OFF_MESSAGE;
  if (!message || message.length > 240 || TECHNICAL.test(message)) return fallback;
  return message === "Something went wrong." ? fallback : message;
}
