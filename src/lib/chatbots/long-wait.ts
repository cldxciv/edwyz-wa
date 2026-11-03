/**
 * The long-wait rule, shared by the server's publish check (lib/chatbots/flow.ts) and the builder's own check
 * (components/chatbots/validation.ts), so a flow that looks ready in the builder is accepted when publishing. No imports: the
 * builder runs it in the browser.
 *
 * WhatsApp allows free messages for 24 hours after the customer last wrote; after that only approved templates. A wait this long
 * (23 hours) leaves little or none of that window, so the next message the bot sends after it must be a template. Steps that send
 * nothing (tags, a contact detail, a status change, assigning, a web request, a check, another wait) may come first.
 */
export const LONG_WAIT_MINUTES = 23 * 60;

export const LONG_WAIT_MESSAGE =
  "After a wait of 23 hours or more, the next message the bot sends must be Send template. WhatsApp only allows approved templates once 24 hours have passed since the customer last wrote. Steps that send nothing, such as Add a tag or Change chat status, can come first; a hand-over or Stop messages step there cannot have a message.";

type StepLike = { id: string; type: string; data?: unknown };
type EdgeLike = { from: string; to: string };

/** Steps that send the customer nothing, so the bot passes through them without needing the 24-hour window. */
const SILENT = new Set(["condition", "set_attribute", "add_tag", "remove_tag", "delay", "webhook", "assign", "set_status", "subscribe"]);
const FREE = new Set(["send_text", "send_buttons", "send_list", "ask"]);
/** Steps that end the bot. They send something only when they carry a message. */
const WITH_OPTIONAL_MESSAGE = new Set(["handoff", "unsubscribe"]);

const hasMessage = (data: unknown) => {
  const message = data && typeof data === "object" ? (data as { message?: unknown }).message : undefined;
  return typeof message === "string" && message.trim() !== "";
};

/** True when the step sends a free (non-template) message: text, buttons, a menu, a question, or a hand-over or Stop messages step with a message. */
export function sendsFreeMessage(step: StepLike): boolean {
  return FREE.has(step.type) || (WITH_OPTIONAL_MESSAGE.has(step.type) && hasMessage(step.data));
}

/**
 * The first step after `fromId` that would send a free message before any template, following every path through the steps that
 * send nothing (both answers of a check, both outcomes of a web request). Null when every path first reaches a template, the end
 * of the flow, or a step that ends the bot without a message.
 */
export function freeMessageAhead(steps: readonly StepLike[], edges: readonly EdgeLike[], fromId: string): StepLike | null {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const seen = new Set<string>([fromId]);
  const queue = edges.filter((e) => e.from === fromId).map((e) => e.to);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const step = byId.get(id);
    if (!step) continue;
    if (sendsFreeMessage(step)) return step;
    if (SILENT.has(step.type)) for (const e of edges) if (e.from === id) queue.push(e.to);
  }
  return null;
}

/** The waits of 23 hours or more after which the bot would send a free message before a template. */
export function longWaitProblems(steps: readonly StepLike[], edges: readonly EdgeLike[]): StepLike[] {
  return steps.filter((s) => s.type === "delay" && Number((s.data as { minutes?: unknown } | undefined)?.minutes) >= LONG_WAIT_MINUTES && freeMessageAhead(steps, edges, s.id) !== null);
}
