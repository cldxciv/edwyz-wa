export type ChecklistInput = {
  onboardingLive: boolean;
  paymentMarkedDone: boolean;
  /** Templates that were submitted to Meta (any status except draft). */
  submittedTemplates: number;
  optedInContacts: number;
  /** Broadcasts that left the draft state. */
  startedBroadcasts: number;
};

export type ChecklistItem = {
  id: "connect" | "payment" | "template" | "contacts" | "broadcast";
  title: string;
  description: string;
  href: string;
  external?: boolean;
  state: "done" | "current" | "locked";
  /** Only the payment item can be toggled by the owner. */
  manual?: boolean;
};

export const PAYMENT_URL = "https://business.facebook.com/wa/manage/home/";

export function computeChecklist(input: ChecklistInput): ChecklistItem[] {
  const done = [
    input.onboardingLive,
    input.onboardingLive && input.paymentMarkedDone,
    input.submittedTemplates > 0,
    input.optedInContacts > 0,
    input.startedBroadcasts > 0,
  ];
  const items: Omit<ChecklistItem, "state">[] = [
    { id: "connect", title: "Connect your WhatsApp number", description: "Link your business number through Meta. It takes a few minutes.", href: "/app/settings/connect" },
    {
      id: "payment",
      title: "Add a payment method in WhatsApp Manager",
      description: "Meta needs a payment method on your account before you can message customers. We cannot check this for you, so mark it done yourself.",
      href: PAYMENT_URL,
      external: true,
      manual: true,
    },
    { id: "template", title: "Create and submit a template", description: "Templates are required to message people outside the 24-hour window.", href: "/app/templates" },
    { id: "contacts", title: "Import contacts with opt-in", description: "Only message people who agreed to hear from you.", href: "/app/contacts" },
    { id: "broadcast", title: "Send your first broadcast", description: "Send an approved template to your opted-in contacts.", href: "/app/broadcasts" },
  ];
  let currentAssigned = false;
  return items.map((item, i) => {
    if (done[i]) return { ...item, state: "done" as const };
    const locked = i > 0 && !input.onboardingLive;
    if (locked) return { ...item, state: "locked" as const };
    if (!currentAssigned) {
      currentAssigned = true;
      return { ...item, state: "current" as const };
    }
    return { ...item, state: "locked" as const };
  });
}

export const countLabel = (n: number, hasMore: boolean) => `${n}${hasMore ? "+" : ""}`;
