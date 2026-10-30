/** Placeholders an agent can use in quick replies. Pure: used by the composer in the browser and by tests. */

export type ReplyContext = { contactName?: string | null; phone?: string | null; agentName?: string | null };

export const REPLY_VARIABLES: { token: string; help: string }[] = [
  { token: "{{name}}", help: "The customer's name, or \"there\" when we do not know it" },
  { token: "{{first_name}}", help: "The customer's first name" },
  { token: "{{phone}}", help: "The customer's phone number" },
  { token: "{{agent}}", help: "Your name" },
  { token: "{{agent_first_name}}", help: "Your first name" },
];

const firstWord = (value: string | null | undefined) => (value ?? "").trim().split(/\s+/)[0] ?? "";

/** Replaces {{name}}, {{first_name}}, {{phone}}, {{agent}} and {{agent_first_name}}. Other {{...}} text, such as template numbers, is left alone. */
export function renderReplyVariables(body: string, ctx: ReplyContext): string {
  const values: Record<string, string> = {
    name: ctx.contactName?.trim() || "there",
    first_name: firstWord(ctx.contactName) || "there",
    phone: ctx.phone?.trim() ?? "",
    agent: ctx.agentName?.trim() ?? "",
    agent_first_name: firstWord(ctx.agentName),
  };
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) => {
    const value = values[key.toLowerCase()];
    return value === undefined ? match : value;
  });
}

export function hasReplyVariables(body: string): boolean {
  return /\{\{\s*(name|first_name|phone|agent|agent_first_name)\s*\}\}/i.test(body);
}
