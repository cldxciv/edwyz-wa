import { AI_OFF_MESSAGE, isAiOffError } from "@/lib/ai-configured";

export const AI_OFF_TITLE = "AI is not switched on for this workspace yet";
export const AI_OFF_BODY = "Ask an admin to set up AI. Until then the agent cannot reply to customers, even when it is enabled, and the test chat cannot answer.";

/** What to tell the person when a test message gets no reply. It is shown as a notice, never inside a bubble as if the assistant had said it. */
export function testChatProblem(message: string | null | undefined): string {
  if (isAiOffError(message)) return AI_OFF_MESSAGE;
  const text = (message ?? "").trim();
  return text && text.length <= 200 ? `We could not get a reply. ${text}` : "We could not get a reply. Try again.";
}

/** Languages the agent can be told to always use. "auto" answers in the language the customer writes in. */
export const LANGUAGES = ["auto", "English", "Hindi", "Hinglish", "Marathi", "Tamil", "Telugu", "Bengali", "Gujarati", "Kannada", "Malayalam", "Punjabi", "Urdu", "Arabic", "Spanish", "French", "German", "Portuguese", "Indonesian"] as const;

/** The choices for the language list. A language typed in before the list existed stays selectable, so saving never changes it. */
export function languageOptions(current: string): { value: string; label: string }[] {
  const known: string[] = [...LANGUAGES];
  const list = current && !known.some((l) => l.toLowerCase() === current.toLowerCase()) ? [...known, current] : known;
  return list.map((value) => ({ value, label: value === "auto" ? "Match the customer's language" : value }));
}

/** The handoff keywords as the server will store them: split on commas, trimmed, empty ones dropped. */
export const splitKeywords = (text: string) => text.split(",").map((k) => k.trim()).filter(Boolean);

const wholeIn = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

export type AgentProblems = Partial<Record<"name" | "instructions" | "minutes" | "max" | "keywords", string>>;

/**
 * Problems with the agent forms, checked on the page with the same limits as the server (src/lib/ai-agent/agents.ts) so
 * each one shows under its own field instead of the browser's own bubble.
 */
export function agentProblems(f: { name: string; instructions: string; activation?: string; noHumanReplyMinutes?: number; maxRepliesPerConversation?: number; keywords?: string }): AgentProblems {
  const out: AgentProblems = {};
  if (!f.name.trim()) out.name = "Give the agent a name.";
  if (!f.instructions.trim()) out.instructions = "Tell the agent what to do, for example which questions it answers.";
  if (f.activation === "no_human_reply_minutes" && f.noHumanReplyMinutes !== undefined && !wholeIn(f.noHumanReplyMinutes, 1, 1440)) out.minutes = "Use a whole number of minutes from 1 to 1440 (one day).";
  if (f.maxRepliesPerConversation !== undefined && !wholeIn(f.maxRepliesPerConversation, 1, 50)) out.max = "Use a whole number from 1 to 50.";
  if (f.keywords !== undefined) {
    const words = splitKeywords(f.keywords);
    if (words.length > 20) out.keywords = `Use up to 20 handoff keywords. You have ${words.length}.`;
    else if (words.some((w) => w.length > 40)) out.keywords = "Each handoff keyword can be up to 40 characters.";
  }
  return out;
}

export type SourceProblems = Partial<Record<"content" | "url" | "q" | "a", string>>;

/** Problems with the Add knowledge form. Whether a web page can be read is only known once the server has tried. */
export function sourceProblems(kind: "text" | "faq" | "url", f: { content: string; url: string; q: string; a: string }): SourceProblems {
  if (kind === "text") return f.content.trim() ? {} : { content: "Write or paste the text the assistant should know." };
  if (kind === "url") return !f.url.trim() ? { url: "Enter the address of the page." } : /^https:\/\//i.test(f.url.trim()) ? {} : { url: "Use a public page whose address starts with https://." };
  const out: SourceProblems = {};
  if (!f.q.trim()) out.q = "Write the question a customer asks.";
  if (!f.a.trim()) out.a = "Write the answer the assistant should give.";
  return out;
}
