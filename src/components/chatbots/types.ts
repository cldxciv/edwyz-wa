export type Point = { x: number; y: number };

export const NODE_TYPES = [
  "send_text",
  "send_buttons",
  "send_list",
  "send_template",
  "ask",
  "condition",
  "set_attribute",
  "add_tag",
  "remove_tag",
  "delay",
  "webhook",
  "assign",
  "set_status",
  "handoff",
  "subscribe",
  "unsubscribe",
  "end",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export type ButtonItem = { id: string; title: string };
export type ListRow = { id: string; title: string; description?: string };
export type AskValidate = "text" | "number" | "email" | "phone" | "date" | "choice";
export type ConditionOperator = "equals" | "not_equals" | "contains" | "not_contains" | "starts_with" | "not_starts_with" | "exists" | "gt" | "lt";

export type NodeDataMap = {
  send_text: { text: string };
  send_buttons: { text: string; buttons: ButtonItem[]; header?: string; footer?: string };
  send_list: { text: string; buttonLabel: string; rows: ListRow[]; header?: string; footer?: string };
  send_template: { templateId: string; variables: Record<string, string>; headerVariable?: string; headerMediaUrl?: string; buttonVariable?: string };
  ask: { text: string; variable: string; validate: AskValidate; retryText?: string; maxRetries: number; choices?: string[] };
  condition: { variable: string; operator: ConditionOperator; value: string };
  set_attribute: { attribute: string; value: string };
  add_tag: { tag: string };
  remove_tag: { tag: string };
  delay: { minutes: number };
  webhook: { url: string; method: "GET" | "POST"; bodyTemplate?: string; saveAs?: string };
  assign: { userId: string; teamId?: string };
  set_status: { status: "open" | "pending" | "solved" };
  handoff: { message?: string; teamId?: string; userId?: string; note?: boolean };
  subscribe: { source?: string };
  unsubscribe: { message?: string };
  end: Record<string, never>;
};

export type FlowNode = { [K in NodeType]: { id: string; type: K; position: Point; data: NodeDataMap[K] } }[NodeType];
export type FlowEdge = { id: string; from: string; to: string; label?: string };
export type EscalationSettings = { enabled: boolean; useAi: boolean; keywords: string[]; message?: string; teamId?: string; userId?: string };
export type BotSettings = {
  priority: number;
  keywordMatch: "contains" | "exact";
  skipAssignedChats: boolean;
  stopOnHumanReply: boolean;
  interactive: boolean;
  fallbackText?: string;
  timeoutMinutes: number;
  timeoutMessage?: string;
  escalation: EscalationSettings;
};
export const DEFAULT_SETTINGS: BotSettings = {
  priority: 100,
  keywordMatch: "contains",
  skipAssignedChats: true,
  stopOnHumanReply: true,
  interactive: true,
  timeoutMinutes: 1440,
  escalation: { enabled: true, useAi: false, keywords: [] },
};
export type FlowDefinition = { version: 1; start: string; nodes: FlowNode[]; edges: FlowEdge[]; settings?: BotSettings };

export type TriggerType = "keyword" | "first_message" | "any_message" | "manual";
export type ChatbotStatus = "draft" | "published" | "archived";

export type ChatbotSummary = {
  id: string;
  name: string;
  status: ChatbotStatus;
  triggerType: TriggerType;
  triggerKeywords: string[];
  phoneNumberId?: string | null;
  version: number;
  updatedAt: string;
};

export type Chatbot = ChatbotSummary & { flow: FlowDefinition; publishedFlow: FlowDefinition | null };

/** Teammate value of a hand-over that leaves the chat in the chosen team's queue. Same value as the server uses. */
export const TEAM_QUEUE = "team_queue";

export const LIMITS = { nodes: 100, edges: 200, text: 1024, buttons: 3, buttonTitle: 20, rows: 10, rowTitle: 24, delayMin: 1, delayMax: 10080, choices: 20, choiceLength: 100, headerText: 60, footer: 60 } as const;

export function emptyFlow(): FlowDefinition {
  return { version: 1, start: "", nodes: [], edges: [] };
}
