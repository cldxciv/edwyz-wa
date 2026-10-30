import type { Role } from "@/generated/prisma/client";
import { HOME_ITEM, hasRole, navFor, SECTIONS, type IconName } from "./nav";
import { goShortcutForHref } from "./shortcuts";

export type CommandRun = "toggle-theme" | "sign-out" | "open-shortcuts" | "ask-eddy";

export type Command = {
  id: string;
  label: string;
  group: "Quick actions" | "Pages";
  hint?: string;
  icon: IconName;
  href?: string;
  run?: CommandRun;
  keywords: string[];
  shortcut?: string[];
};

type ActionDef = Omit<Command, "group"> & { minRole: Role };

const ACTIONS: ActionDef[] = [
  // Eddy, the in-app AI helper (docs/EDDY-SPEC.md 6.1): always listed; with no match, the palette offers Ask Eddy: "query".
  { id: "ask-eddy", label: "Ask Eddy", hint: "The AI helper: ask anything about Edwyz", icon: "sparkles", run: "ask-eddy", minRole: "agent", keywords: ["eddy", "ai", "assistant", "question", "chat"] },
  { id: "new-broadcast", label: "New broadcast", icon: "megaphone", href: "/app/broadcasts/new", minRole: "admin", keywords: ["send", "campaign", "create"] },
  { id: "new-template", label: "New template", icon: "template", href: "/app/templates/new", minRole: "agent", keywords: ["message", "create"] },
  { id: "add-contact", label: "Add contact", icon: "plus", href: "/app/contacts?add=1", minRole: "agent", keywords: ["customer", "person", "create"] },
  { id: "new-chatbot", label: "New chatbot", icon: "bot", href: "/app/automation/chatbots/new", minRole: "agent", keywords: ["flow", "bot", "create"] },
  { id: "invite-teammate", label: "Invite teammate", icon: "team", href: "/app/settings/team?invite=1", minRole: "admin", keywords: ["member", "user", "add"] },
  { id: "go-inbox", label: "Go to inbox", icon: "inbox", href: "/app/inbox", minRole: "agent", keywords: ["chats", "messages"] },
  { id: "toggle-theme", label: "Toggle theme", hint: "Switch between light and dark", icon: "moon", run: "toggle-theme", minRole: "agent", keywords: ["dark", "light", "mode", "appearance"] },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: "keyboard", run: "open-shortcuts", minRole: "agent", shortcut: ["?"], keywords: ["keys", "help", "hotkeys"] },
  { id: "docs", label: "Open help and docs", icon: "book", href: "/docs", minRole: "agent", keywords: ["support", "guide", "documentation"] },
  { id: "sign-out", label: "Sign out", icon: "logout", run: "sign-out", minRole: "agent", keywords: ["log out", "logout", "exit"] },
];

const sectionLabel = (id?: string) => SECTIONS.find((s) => s.id === id)?.label;

/** Quick actions then pages, already filtered to what this role may do or open. */
export function buildCommands(role: Role): Command[] {
  const actions: Command[] = ACTIONS.filter((a) => hasRole(role, a.minRole)).map(({ minRole: _min, ...rest }) => ({ ...rest, group: "Quick actions" as const }));
  const pages: Command[] = [HOME_ITEM, ...navFor(role)].map((i) => {
    const go = goShortcutForHref(i.href);
    return {
      id: `page:${i.href}`,
      label: i.label,
      hint: sectionLabel(i.section),
      icon: i.icon ?? "grid",
      href: i.href,
      keywords: i.keywords ?? [],
      shortcut: go ? ["g", go.key] : undefined,
      group: "Pages" as const,
    };
  });
  return [...actions, ...pages];
}

/** The no-results row of the palette (6.1): opens Eddy and sends the query as the member's message. */
export function askEddyLabel(query: string): string {
  return `Ask Eddy: "${query.trim()}"`;
}
