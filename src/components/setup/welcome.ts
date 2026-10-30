export const WELCOME_VERSION = "v1";

export const welcomeKey = (userId: string) => `edwyz.welcome.${WELCOME_VERSION}.${userId}`;

type Store = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** True when the welcome dialog was already shown. Storage that is blocked or broken counts as "seen" so the dialog never nags on every visit. */
export function hasSeenWelcome(userId: string, store: Store | null = browserStorage()): boolean {
  if (!store) return true;
  try {
    return store.getItem(welcomeKey(userId)) !== null;
  } catch {
    return true;
  }
}

export function markWelcomeSeen(userId: string, store: Store | null = browserStorage()): void {
  try {
    store?.setItem(welcomeKey(userId), new Date().toISOString());
  } catch {
    // nothing to do: the dialog will show again next visit
  }
}

export const WELCOME_POINTS = [
  { art: "welcome-chat", title: "Talk to customers in one shared inbox", body: "Every WhatsApp message lands in one place. Reply from any device, hand chats to teammates and keep notes." },
  { art: "welcome-send", title: "Message many people at once", body: "Send approved announcements, offers and reminders to the customers who agreed to hear from you." },
  { art: "welcome-auto", title: "Let automation answer for you", body: "Chatbots and an AI agent reply to common questions at any hour and pass tricky ones to a person." },
] as const;
