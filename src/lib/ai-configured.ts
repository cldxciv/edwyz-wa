/**
 * Whether the AI features (AI agent, inbox suggestions, Creative Studio ideas and ad text) can run on this server.
 * Every AI call checks the same key, so the pages can say up front that AI is off instead of failing on the first click.
 */
export function isAiConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

/** The one sentence every screen uses when AI is off, so the person always hears the same thing and knows whom to ask. */
export const AI_OFF_MESSAGE = "AI is not switched on for this workspace yet. Ask an admin to set up AI.";

/** True for the server's "AI is not configured." refusal, however it reached the browser. */
export const isAiOffError = (message: string | null | undefined): boolean => /not configured/i.test(message ?? "");
