import type { BillingState } from "@/lib/billing";

export const STEP_IDS = ["connect", "template", "contacts", "broadcast", "invite", "routing", "automation", "facebook", "plan"] as const;
export type StepId = (typeof STEP_IDS)[number];
export type StepState = "done" | "todo" | "optional";
export type StepGroup = "launch" | "grow";

export type SetupFacts = {
  onboardingLive: boolean;
  approvedTemplates: number;
  pendingTemplates: number;
  rejectedTemplates: number;
  contacts: number;
  optedInContacts: number;
  startedBroadcasts: number;
  sentTemplateMessages: number;
  members: number;
  pendingInvites: number;
  autoAssign: boolean;
  publishedChatbots: number;
  enabledAiAgents: number;
  metaConnections: number;
  billing: { state: BillingState; daysLeftInTrial: number | null; planName: string | null };
};

export type SetupStep = {
  id: StepId;
  group: StepGroup;
  title: string;
  why: string;
  minutes: number;
  href: string;
  cta: string;
  alt: { href: string; cta: string } | null;
  /** Where "Review" goes once the step is done: the list of what was made, never the form that makes a new one. */
  reviewHref: string;
  state: StepState;
  detail: string | null;
  blockedBy: StepId | null;
  blockedReason: string | null;
  dismissed: boolean;
};

export type SetupSummary = {
  done: number;
  total: number;
  /** Steps asked of the owner (done plus todo): what "3 of 4 done" and the ring count, the same on the page and in Eddy. */
  asked: number;
  percent: number;
  /** Open steps that are still to do and have not been dismissed. */
  remaining: number;
  complete: boolean;
  minutesLeft: number;
  nextStepId: StepId | null;
};

export const TRIAL_NUDGE_DAYS = 3;

/** reviewHref defaults to href, for steps whose page already lists what was done. */
type Draft = Omit<SetupStep, "state" | "detail" | "blockedBy" | "blockedReason" | "dismissed" | "reviewHref"> & { reviewHref?: string };

const DRAFTS: Record<StepId, Draft> = {
  connect: {
    id: "connect",
    group: "launch",
    title: "Connect your WhatsApp number",
    why: "This links your business number to Edwyz so you can send and receive messages.",
    minutes: 5,
    href: "/app/settings/connect",
    cta: "Connect number",
    alt: null,
  },
  template: {
    id: "template",
    group: "launch",
    title: "Get a message template approved",
    why: "WhatsApp only lets you start a chat with pre-approved messages. Meta usually reviews them within a day.",
    minutes: 3,
    href: "/app/templates/new",
    cta: "Create a template",
    alt: { href: "/app/templates", cta: "See my templates" },
    reviewHref: "/app/templates",
  },
  contacts: {
    id: "contacts",
    group: "launch",
    title: "Add or import your contacts",
    why: "These are the people you will message. Only add people who agreed to hear from you.",
    minutes: 2,
    href: "/app/contacts",
    cta: "Add contacts",
    alt: null,
  },
  broadcast: {
    id: "broadcast",
    group: "launch",
    title: "Send a test or your first broadcast",
    why: "Sending to yourself first is the safest way to see what customers will get. Meta also needs a payment method on your WhatsApp Business account before it delivers marketing messages.",
    minutes: 3,
    href: "/app/broadcasts/new",
    cta: "Start a broadcast",
    alt: null,
    reviewHref: "/app/broadcasts",
  },
  invite: {
    id: "invite",
    group: "grow",
    title: "Invite a teammate",
    why: "Share the inbox so replies keep going when you are busy or away.",
    minutes: 1,
    href: "/app/settings/team",
    cta: "Invite someone",
    alt: null,
  },
  routing: {
    id: "routing",
    group: "grow",
    title: "Turn on chat routing",
    why: "New chats are shared out to your team automatically, so nothing sits unanswered.",
    minutes: 2,
    href: "/app/settings/routing",
    cta: "Set up routing",
    alt: null,
  },
  automation: {
    id: "automation",
    group: "grow",
    title: "Build a chatbot or turn on the AI agent",
    why: "Answer common questions instantly, day and night, and hand over to a person when needed.",
    minutes: 10,
    href: "/app/automation/chatbots/new",
    cta: "Build a chatbot",
    alt: { href: "/app/automation/ai-agent", cta: "Use the AI agent" },
    reviewHref: "/app/automation",
  },
  facebook: {
    id: "facebook",
    group: "grow",
    title: "Connect your Facebook Page and ad account",
    why: "Lets you run ads that open a WhatsApp chat and see which ads bring customers.",
    minutes: 3,
    href: "/app/settings/connections",
    cta: "Connect Facebook",
    alt: null,
  },
  plan: {
    id: "plan",
    group: "grow",
    title: "Add a payment plan",
    why: "Keeps your messaging running after the free trial ends.",
    minutes: 2,
    href: "/app/billing",
    cta: "Choose a plan",
    alt: null,
  },
};

type Eval = { done: boolean; urgent?: boolean; detail?: string | null; blockedBy?: StepId; blockedReason?: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const CONNECT_FIRST = { blockedBy: "connect" as const, blockedReason: "Connect your WhatsApp number first." };

function evalPlan(f: SetupFacts): Eval {
  const { state, daysLeftInTrial, planName } = f.billing;
  if (state === "active") return { done: true, detail: planName ? `You are on the ${planName} plan.` : "Your plan is active." };
  if (state === "exempt") return { done: true, detail: "Your workspace does not need a plan." };
  if (state === "past_due_grace") return { done: false, urgent: true, detail: "Your last payment failed. Update it to avoid being locked out." };
  if (state === "locked" || state === "suspended") return { done: false, urgent: true, detail: "Your workspace is read-only until a plan is active." };
  const left = daysLeftInTrial ?? 0;
  return { done: false, urgent: left <= TRIAL_NUDGE_DAYS, detail: left > 0 ? `${plural(left, "day")} left in your free trial.` : null };
}

function evalTemplate(f: SetupFacts): Eval {
  if (f.approvedTemplates > 0) return { done: true, detail: `${plural(f.approvedTemplates, "template")} approved.` };
  const blocked = f.onboardingLive ? {} : CONNECT_FIRST;
  if (f.pendingTemplates > 0) return { done: false, ...blocked, detail: `${plural(f.pendingTemplates, "template")} waiting for Meta to review. This is usually quick.` };
  if (f.rejectedTemplates > 0) return { done: false, ...blocked, detail: "Meta turned down your template. Open it to see why and fix it." };
  return { done: false, ...blocked };
}

function evalContacts(f: SetupFacts): Eval {
  if (f.contacts === 0) return { done: false };
  const note = f.optedInContacts === 0 ? " None are marked as agreed to receive messages yet." : "";
  return { done: true, detail: `${plural(f.contacts, "contact")} added.${note}` };
}

function evalBroadcast(f: SetupFacts): Eval {
  if (f.startedBroadcasts > 0 || f.sentTemplateMessages > 0) return { done: true };
  if (!f.onboardingLive) return { done: false, ...CONNECT_FIRST };
  if (f.approvedTemplates === 0) return { done: false, blockedBy: "template", blockedReason: "You need an approved template first." };
  if (f.contacts === 0) return { done: false, blockedBy: "contacts", blockedReason: "Add at least one contact first." };
  return { done: false };
}

function evalInvite(f: SetupFacts): Eval {
  const detail = f.members > 1 ? `${plural(f.members, "person", "people")} on your team.` : f.pendingInvites > 0 ? "Invitation sent, waiting for them to accept." : null;
  return { done: f.members > 1 || f.pendingInvites > 0, detail };
}

function evaluate(id: StepId, f: SetupFacts): Eval {
  switch (id) {
    case "connect":
      return { done: f.onboardingLive };
    case "template":
      return evalTemplate(f);
    case "contacts":
      return evalContacts(f);
    case "broadcast":
      return evalBroadcast(f);
    case "invite":
      return evalInvite(f);
    case "routing":
      return { done: f.autoAssign, detail: !f.autoAssign && f.members > 1 ? "You have a team now, so new chats can be shared out automatically." : null };
    case "automation":
      return { done: f.publishedChatbots > 0 || f.enabledAiAgents > 0, detail: f.enabledAiAgents > 0 ? "Your AI agent is on." : f.publishedChatbots > 0 ? "Your chatbot is live." : null };
    case "facebook":
      return { done: f.metaConnections > 0 };
    case "plan":
      return evalPlan(f);
  }
}

const ESSENTIAL = new Set<StepId>(["connect", "template", "contacts", "broadcast"]);

/** Essentials are always "todo" until done; the rest are "optional" unless something makes them urgent (a trial about to end or a failed payment). */
export function computeSteps(facts: SetupFacts, dismissed: Iterable<string> = []): SetupStep[] {
  const skipped = new Set(dismissed);
  return STEP_IDS.map((id) => {
    const e = evaluate(id, facts);
    const state: StepState = e.done ? "done" : ESSENTIAL.has(id) || e.urgent ? "todo" : "optional";
    return {
      ...DRAFTS[id],
      reviewHref: DRAFTS[id].reviewHref ?? DRAFTS[id].href,
      state,
      detail: e.detail ?? null,
      blockedBy: e.done ? null : (e.blockedBy ?? null),
      blockedReason: e.done ? null : (e.blockedReason ?? null),
      dismissed: state !== "done" && skipped.has(id),
    };
  });
}

/** The ring counts steps that were asked of the owner (done plus todo), so finishing an optional step never lowers the percentage. */
export function summarize(steps: SetupStep[]): SetupSummary {
  const done = steps.filter((s) => s.state === "done").length;
  const todo = steps.filter((s) => s.state === "todo");
  const open = todo.filter((s) => !s.dismissed);
  const counted = done + todo.length;
  const next = open.find((s) => !s.blockedBy) ?? open[0] ?? null;
  return {
    done,
    total: steps.length,
    asked: counted,
    percent: counted === 0 ? 100 : Math.round((done / counted) * 100),
    remaining: open.length,
    complete: todo.length === 0,
    minutesLeft: open.reduce((n, s) => n + s.minutes, 0),
    nextStepId: next?.id ?? null,
  };
}

export const isStepId = (v: unknown): v is StepId => typeof v === "string" && (STEP_IDS as readonly string[]).includes(v);

/** Reads the stored dismissal list defensively; anything unexpected is ignored. */
export function parseDismissed(value: unknown): StepId[] {
  const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { ids?: unknown }).ids) ? (value as { ids: unknown[] }).ids : [];
  return [...new Set(list.filter(isStepId))];
}

export function formatMinutes(minutes: number): string {
  if (minutes <= 1) return "About 1 min";
  if (minutes < 60) return `About ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `About ${h} h ${m} min` : `About ${h} h`;
}
