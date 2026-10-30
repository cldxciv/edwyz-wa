export type Agent = {
  id: string;
  name: string;
  enabled: boolean;
  phoneNumberId: string | null;
  instructions: string;
  tone: string | null;
  language: string;
  activation: "always" | "outside_hours" | "no_human_reply_minutes";
  noHumanReplyMinutes: number;
  handoffKeywords: string[];
  maxRepliesPerConversation: number;
  model: string | null;
  effectiveModel?: string;
};

export type Source = { id: string; kind: string; title: string; sourceUrl: string | null; status: string; chars: number };

export type Usage = { used: number; limit: number | null; remaining: number | null; replies: number; /** False when this server has no AI key, so nothing here can reply. */ aiConfigured?: boolean };

export type ChatLine = { role: "you" | "ai"; text: string; note?: string };
