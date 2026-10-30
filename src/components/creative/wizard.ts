import type { Tone } from "@/components/ui/status";

export const WIZARD_STEPS = [
  { id: "brand", label: "Brand", help: "Choose the brand kit" },
  { id: "offer", label: "Goal and offer", help: "Say what you want to promote" },
  { id: "angles", label: "Angles", help: "Pick the ideas to test" },
  { id: "creatives", label: "Creatives", help: "Write the ads" },
  { id: "review", label: "Review", help: "Check and send for approval" },
] as const;

export type StepId = (typeof WIZARD_STEPS)[number]["id"];
export type StepState = "done" | "current" | "upcoming";

export const stepIndex = (id: StepId): number => WIZARD_STEPS.findIndex((s) => s.id === id);

export function stepState(index: number, current: number): StepState {
  return index < current ? "done" : index === current ? "current" : "upcoming";
}

/** Share of the wizard reached, counting the current step. Step 1 of 5 is 20 percent. */
export function progressPercent(current: number, total: number = WIZARD_STEPS.length): number {
  if (total <= 0) return 0;
  return Math.round((Math.min(Math.max(current, 0), total - 1) + 1) * (100 / total));
}

export type WizardBrief = { angles: { selected: boolean }[]; assets: unknown[] };

/** A brief only exists once the first two steps are done, so the workspace starts at Angles or later. */
export function startStep(brief: WizardBrief): StepId {
  if (brief.assets.length > 0) return "review";
  if (brief.angles.some((a) => a.selected)) return "creatives";
  return "angles";
}

export type Gate = { ok: true } | { ok: false; reason: string };

/** Whether the person may move to a step yet, and if not, why in plain words. */
export function canEnterStep(step: StepId, brief: WizardBrief): Gate {
  if (step === "creatives" && !brief.angles.some((a) => a.selected)) return { ok: false, reason: "Choose at least one angle first." };
  if (step === "review" && brief.assets.length === 0) return { ok: false, reason: "Create at least one ad first." };
  return { ok: true };
}

export const GOAL_INFO: Record<string, { label: string; help: string }> = {
  leads: { label: "Get enquiries", help: "People leave their details in a short form on Facebook or Instagram." },
  messages: { label: "Get WhatsApp messages", help: "People tap the ad and start a chat with you on WhatsApp." },
  traffic: { label: "Send people to your website", help: "People tap the ad and land on a page you choose." },
  awareness: { label: "Get your brand seen", help: "Show your name to as many of the right people as possible." },
};

export const goalLabel = (goal: string): string => GOAL_INFO[goal]?.label ?? goal.charAt(0).toUpperCase() + goal.slice(1);

export const PLACEMENT_INFO: Record<string, { label: string; help: string }> = {
  feed: { label: "Feed post", help: "Shown while people scroll Facebook and Instagram." },
  square: { label: "Square post", help: "A square picture that works almost anywhere." },
  story: { label: "Story", help: "Full-screen and tall, shown between Stories." },
  reel: { label: "Reel", help: "Full-screen and tall, shown between Reels." },
};

export const placementLabel = (placement: string): string => PLACEMENT_INFO[placement]?.label ?? placement.charAt(0).toUpperCase() + placement.slice(1);

export const KIND_LABEL: Record<string, string> = { copy: "Ad text", image: "Picture", video: "Video" };
export const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);

const BRIEF_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  researching: { label: "Reading website", tone: "info" },
  angles_ready: { label: "Angles ready", tone: "info" },
  generating: { label: "Creating ads", tone: "info" },
  ready: { label: "Ready to review", tone: "warn" },
  approved: { label: "Approved", tone: "good" },
  archived: { label: "Archived", tone: "neutral" },
};

export function briefStatus(status: string): { label: string; tone: Tone } {
  return BRIEF_STATUS[status] ?? { label: status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), tone: "neutral" };
}

const ASSET_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Being created", tone: "info" },
  ready: { label: "Ready", tone: "good" },
  failed: { label: "Could not be created", tone: "bad" },
  approved: { label: "Approved by client", tone: "good" },
  rejected: { label: "Declined by client", tone: "bad" },
};

export function assetStatus(status: string): { label: string; tone: Tone } {
  return ASSET_STATUS[status] ?? { label: status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), tone: "neutral" };
}

export type ClientFeedbackView = { label: string; tone: Tone; comment: string | null; next: string | null };

/**
 * What the client last said about an ad, for its card. Approved and declined already show through the ad's own status, so this covers
 * the decisions that leave the ad as it was: changes requested (with the client's comment), a link still waiting, and a link that ran out.
 */
export function clientFeedback(asset: { status: string; clientFeedback?: { status: string; comment: string | null } | null }): ClientFeedbackView | null {
  const f = asset.clientFeedback;
  if (!f) return null;
  if (f.status === "changes_requested") return { label: "Changes requested", tone: "warn", comment: f.comment, next: "Edit the wording, then send it for approval again." };
  if (f.status === "pending") return { label: "Waiting for your client", tone: "info", comment: null, next: null };
  if (f.status === "expired" && asset.status === "ready") return { label: "Link expired", tone: "neutral", comment: null, next: "Your client did not decide in time. Send a new link." };
  return null;
}

export function creditsText(n: number): string {
  return n === 1 ? "Uses 1 credit" : `Uses ${n} credits`;
}

/** Six-digit hex colours only (what the server accepts), so a stored value can never inject anything into a style attribute. */
export function safeColour(value: string): string | null {
  const v = value.trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : null;
}

/** Comma or line separated text to a clean list. */
export function splitList(text: string): string[] {
  return text.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}

export function invalidColours(text: string): string[] {
  return splitList(text).filter((c) => !safeColour(c));
}
