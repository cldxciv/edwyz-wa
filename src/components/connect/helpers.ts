export const PAYMENT_URL = "https://business.facebook.com/wa/manage/home/";

export type StepStatus = "pending" | "started" | "done" | "failed";
export type StepState = { step: string; status: StepStatus };

/** The four things the owner experiences, in order. "time" is a rough guide, not a promise. */
export const STAGES = [
  { id: "prepare", title: "Get ready", time: "1 minute" },
  { id: "facebook", title: "Sign in with Facebook", time: "About 3 minutes" },
  { id: "finish", title: "We finish the setup", time: "Under a minute" },
  { id: "payment", title: "Add a payment method", time: "About 2 minutes" },
] as const;

export type StageNumber = 1 | 2 | 3 | 4;
export type StageState = "done" | "current" | "upcoming" | "failed";

export type FlowView =
  | { name: "loading" }
  | { name: "idle" }
  | { name: "waiting" }
  | { name: "connecting" }
  | { name: "cancelled" }
  | { name: "error"; stage: 2 | 3 }
  | { name: "connected" };

export function currentStage(view: FlowView): StageNumber {
  switch (view.name) {
    case "waiting":
    case "cancelled":
      return 2;
    case "connecting":
      return 3;
    case "error":
      return view.stage;
    case "connected":
      return 4;
    default:
      return 1;
  }
}

export function stageState(stage: StageNumber, view: FlowView): StageState {
  const now = currentStage(view);
  if (stage < now) return "done";
  if (stage > now) return "upcoming";
  return view.name === "error" ? "failed" : "current";
}

/** Server-side steps in the order they run, with plain-language names and what each one does. */
export const SETUP_STEPS: { step: string; title: string; text: string }[] = [
  { step: "exchange_code", title: "Confirm your sign-in with Meta", text: "Meta gives us a one-time pass when you finish the window. We swap it for a secure access key and store it encrypted." },
  { step: "verify_ids", title: "Check your account", text: "We confirm with Meta that the number belongs to the WhatsApp account you just chose." },
  { step: "subscribe_app", title: "Turn on message delivery", text: "We ask Meta to send incoming messages and delivery updates to Edwyz, so they show up in your inbox." },
  { step: "register_number", title: "Register your number", text: "We switch the number on for business messaging. This is skipped if you keep using the WhatsApp Business app." },
  { step: "fetch_details", title: "Read your number's details", text: "We read your display name, quality rating and daily messaging limit from Meta." },
  { step: "mark_live", title: "Go live", text: "Your workspace is marked as connected and ready to use." },
];

export function stepTitle(step: string): string {
  const known = SETUP_STEPS.find((s) => s.step === step);
  if (known) return known.title;
  const words = step.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Setup step";
}

/** Always returns every known step, in order, filling in "pending" for any the server has not reported yet. */
export function mergeSteps(reported: readonly StepState[]): { step: string; title: string; text: string; status: StepStatus }[] {
  return SETUP_STEPS.map((s) => ({ ...s, status: reported.find((r) => r.step === s.step)?.status ?? "pending" }));
}

/** Status key from the central status map plus the label shown for it. A step that has not started yet reads "Waiting" in grey. */
export function stepPill(status: StepStatus): { status: string; label: string } {
  switch (status) {
    case "done":
      return { status: "done", label: "Done" };
    case "started":
      return { status: "started", label: "In progress" };
    case "failed":
      return { status: "failed", label: "Failed" };
    default:
      return { status: "not_started", label: "Waiting" };
  }
}

/** The step running right now: the one the server marked started, else the first one not done yet. Null when all are done. */
export function activeStepTitle(reported: readonly StepState[]): string | null {
  const merged = mergeSteps(reported);
  const running = merged.find((s) => s.status === "started") ?? merged.find((s) => s.status !== "done");
  return running ? running.title : null;
}

/** What a screen reader hears when the view changes: the stage, and while setup runs, the step in progress. */
export function liveAnnouncement(view: FlowView, reported: readonly StepState[], fresh: boolean): string {
  const now = currentStage(view);
  const base = `Step ${now} of ${STAGES.length}: ${STAGES[now - 1].title}.`;
  if (view.name === "connecting") {
    const step = activeStepTitle(reported);
    return step ? `${base} Now: ${step}.` : base;
  }
  if (view.name === "connected" && fresh) return `Setup finished. ${base}`;
  return base;
}

export function setupProgress(steps: readonly { status: StepStatus }[]): number {
  if (steps.length === 0) return 0;
  return Math.round((steps.filter((s) => s.status === "done").length / steps.length) * 100);
}

/** The step the server reported as failed, as a title, or null. */
export function failedStepTitle(reported: readonly StepState[]): string | null {
  const failed = reported.find((s) => s.status === "failed");
  return failed ? stepTitle(failed.step) : null;
}

/** What Meta's own window asks, screen by screen. Meta may skip or reorder screens depending on the account. */
export const POPUP_SCREENS: { title: string; text: string }[] = [
  { title: "Log in to Facebook", text: "Use the Facebook account that manages your business. You type your password into Facebook's window, so we never see it." },
  { title: "Choose or create a business portfolio", text: "This is Meta's name for your business profile. Pick yours, or create one with your business name and details." },
  { title: "Choose or create a WhatsApp Business account", text: "This account holds your number, message templates and billing. Pick an existing one or create a new one, and choose the display name customers will see." },
  { title: "Add and verify your phone number", text: "Enter the number and choose text message or call. Meta sends you a code to type back in. Use a number you can answer right now." },
  { title: "Review what you are allowing", text: "Meta lists what Edwyz can do: send and receive WhatsApp messages and manage templates for this account. Select the final button to finish. The window then closes by itself." },
];

export const PREPARE_CHECKLIST = [
  "The Facebook login that manages your business.",
  "Your business name, and a website or business details if Meta asks for them.",
  "A phone number that can receive a text message or call right now, to confirm it is yours.",
  "About 5 minutes without interruptions.",
];

export type Failure = {
  kind: "expired" | "taken" | "busy" | "unavailable" | "blocked" | "no-details" | "limit" | "permission" | "meta" | "generic";
  title: string;
  causes: string[];
  /** True when the server resumes from the failed step on the next attempt. */
  resumes: boolean;
};

const WINDOW_NOTE = "Meta's sign-in code only works for about 30 seconds. If the last screen sat open for a while, the code runs out.";

const FACEBOOK_WINDOW_CAUSES = [
  "The Facebook account you used must have full control of the business portfolio. Ask the person who owns it.",
  "The phone number must be able to receive the code Meta sends, and must not still be tied to another WhatsApp provider.",
  "Meta may ask your business to verify itself first. Check the notices in Meta Business Suite.",
  "Check the details below. Meta explains the reason there.",
];

/**
 * Turns a raw error message into a heading and the most likely causes. The raw message stays available under "Details".
 * Pass stage 2 for errors reported by Meta's own window: its text is Meta's, not ours, so unknown messages get Meta's common causes.
 */
export function classifyFailure(message: string, stage?: 2 | 3): Failure {
  const m = message.toLowerCase();
  if (m.includes("expired") || m.includes("start again")) {
    return { kind: "expired", title: "This attempt timed out", causes: [WINDOW_NOTE, "Start again and finish the last screen straight away."], resumes: false };
  }
  if (m.includes("another workspace")) {
    return {
      kind: "taken",
      title: "This WhatsApp account is already connected elsewhere",
      causes: ["The same WhatsApp Business account is linked to a different Edwyz workspace.", "Use a different number, or ask the owner of the other workspace."],
      resumes: false,
    };
  }
  if (m.includes("already running") || m.includes("wait a minute")) {
    return { kind: "busy", title: "A connection is already in progress", causes: ["Another attempt for this workspace is still running, maybe in another tab.", "Wait a minute, then try again."], resumes: true };
  }
  if (m.includes("not configured")) {
    return { kind: "unavailable", title: "Connecting is not available yet", causes: ["This is a problem on our side, not yours.", "Please try again later. If it keeps happening, contact support."], resumes: false };
  }
  if (m.includes("facebook sign-in") || m === "sdk") {
    return {
      kind: "blocked",
      title: "The Facebook window could not open",
      causes: [
        "A pop-up blocker or ad blocker may be stopping it. Allow pop-ups for this site and try again.",
        "A privacy extension or a work network may be blocking facebook.com.",
        "Try another browser, or switch off extensions for this page.",
      ],
      resumes: false,
    };
  }
  if (m.includes("did not return") || m.includes("account details")) {
    return {
      kind: "no-details",
      title: "Meta did not send back your WhatsApp details",
      causes: ["The window was closed before the final screen. Stay until it closes by itself.", "No WhatsApp Business account or number was chosen on the way. Pick or create one, then finish."],
      resumes: false,
    };
  }
  if (/too many|rate limit|(^|[^a-z])limit/.test(m)) {
    return {
      kind: "limit",
      title: "Meta is limiting new connections right now",
      causes: ["Meta caps how many new businesses we can connect in any 7 days.", "Wait a day and try again. Nothing is wrong with your account."],
      resumes: true,
    };
  }
  if (m.includes("permission") || m.includes("verif") || m.includes("not authorized") || m.includes("unauthorized")) {
    return {
      kind: "permission",
      title: "Meta needs more from your business account",
      causes: [
        "The Facebook account you used must have full control of the business portfolio. Ask the person who owns it.",
        "Meta may ask your business to verify itself first. Check the notices in Meta Business Suite.",
        "The phone number must be able to receive the code Meta sends.",
      ],
      resumes: true,
    };
  }
  if (m.includes("meta said")) {
    return {
      kind: "meta",
      title: "Meta stopped the setup",
      causes: [
        "The number may still be linked to another WhatsApp service or provider. Disconnect it there first.",
        "The Facebook account must have full control of the business portfolio.",
        "Check the details below. Meta explains the reason there.",
      ],
      resumes: true,
    };
  }
  if (stage === 2) {
    return { kind: "meta", title: "Facebook stopped the sign-in", causes: FACEBOOK_WINDOW_CAUSES, resumes: false };
  }
  return { kind: "generic", title: "We could not finish connecting", causes: ["This is usually temporary. Check your connection and try again."], resumes: true };
}

/** Meta reports where a person stopped as an upper-case step name. Turn it into words for a sentence, or null when unclear. */
export function describeCancelStep(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toUpperCase();
  if (s.includes("PHONE") || s.includes("NUMBER")) return "adding your phone number";
  if (s.includes("VERIF") || s.includes("CODE") || s.includes("OTP")) return "entering the verification code";
  if (s.includes("WABA") || s.includes("WHATSAPP")) return "choosing your WhatsApp Business account";
  if (s.includes("BUSINESS") || s.includes("PORTFOLIO")) return "choosing your business";
  if (s.includes("LOGIN") || s.includes("AUTH")) return "logging in";
  if (s.includes("PERMISSION") || s.includes("REVIEW") || s.includes("CONSENT")) return "reviewing what you allow";
  return null;
}

export const TROUBLE_TOPICS: { question: string; answer: string }[] = [
  { question: "The Facebook window did not open", answer: "Allow pop-ups for this site, switch off ad blockers for this page, then select Try again. If it still fails, try another browser." },
  { question: "I closed the window by mistake", answer: "Nothing is changed when you close it early. Select Try again and start from the top." },
  { question: "I cannot choose my business or WhatsApp account", answer: "The Facebook account you log in with needs full control of the business portfolio. Ask the person who owns it to give you access, or log in as them. Meta may also ask your business to verify itself first." },
  { question: "Meta says my number cannot be used", answer: "The number must be able to receive a text or call, and must not be tied to another WhatsApp provider. Disconnect it from the other provider first." },
  { question: "It says connections are limited", answer: "Meta limits how many new businesses we can connect each week. Wait a day and try again." },
  { question: "The setup failed on the last screen", answer: "Meta's sign-in code lasts about 30 seconds. Start again and finish the last screen right away." },
  { question: "I am connected but cannot send messages", answer: "Add a payment method in WhatsApp Manager first. Also remember that outside a 24-hour chat window you can only send approved templates, and only to people who agreed to hear from you." },
];
