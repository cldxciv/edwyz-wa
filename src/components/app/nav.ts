import type { Role } from "@/generated/prisma/client";

export type IconName =
  | "home" | "inbox" | "users" | "target" | "megaphone" | "template" | "ads" | "sparkles" | "calendar"
  | "zap" | "bot" | "brain" | "cart" | "chart" | "trend" | "sliders" | "team" | "route" | "phone"
  | "plug" | "wrench" | "link" | "code" | "card" | "settings" | "search" | "help" | "sun" | "moon"
  | "menu" | "close" | "chevron-down" | "chevron-right" | "logout" | "keyboard" | "plus" | "check"
  | "book" | "mail" | "building" | "user" | "grid" | "command";

export type SectionId = "conversations" | "customers" | "campaigns" | "automation" | "insights" | "settings";

export type NavItem = {
  href: string;
  label: string;
  minRole: Role;
  group?: "settings";
  section?: SectionId;
  icon?: IconName;
  keywords?: string[];
};

export type NavSection = { id: SectionId; label: string; icon: IconName };

export const SECTIONS: NavSection[] = [
  { id: "conversations", label: "Conversations", icon: "inbox" },
  { id: "customers", label: "Customers", icon: "users" },
  { id: "campaigns", label: "Campaigns", icon: "megaphone" },
  { id: "automation", label: "Automation", icon: "zap" },
  { id: "insights", label: "Insights", icon: "chart" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export const HOME_ITEM: NavItem = { href: "/app", label: "Home", minRole: "agent", icon: "home", keywords: ["dashboard", "overview"] };

const RANK: Record<Role, number> = { agent: 1, admin: 2, owner: 3 };

export const NAV_ITEMS: NavItem[] = [
  { href: "/app/inbox", label: "Inbox", minRole: "agent", section: "conversations", icon: "inbox", keywords: ["chats", "messages", "conversations"] },
  { href: "/app/contacts", label: "Contacts", minRole: "agent", section: "customers", icon: "users", keywords: ["customers", "people", "audience"] },
  { href: "/app/contacts/segments", label: "Segments", minRole: "agent", section: "customers", icon: "sliders", keywords: ["audience", "filter", "group", "list", "saved"] },
  { href: "/app/leads", label: "Leads", minRole: "agent", section: "customers", icon: "target", keywords: ["forms", "prospects", "sales"] },
  { href: "/app/broadcasts", label: "Broadcasts", minRole: "admin", section: "campaigns", icon: "megaphone", keywords: ["campaign", "bulk", "send"] },
  { href: "/app/templates", label: "Templates", minRole: "agent", section: "campaigns", icon: "template", keywords: ["message", "approved"] },
  { href: "/app/ads", label: "Ad campaigns", minRole: "admin", section: "campaigns", icon: "ads", keywords: ["ads", "meta", "facebook", "instagram"] },
  { href: "/app/creative", label: "Creative Studio", minRole: "agent", section: "campaigns", icon: "sparkles", keywords: ["design", "images", "ideas"] },
  { href: "/app/content", label: "Content calendar", minRole: "agent", section: "campaigns", icon: "calendar", keywords: ["posts", "schedule", "social"] },
  { href: "/app/automation", label: "Automation", minRole: "agent", section: "automation", icon: "zap", keywords: ["rules", "workflows", "triggers"] },
  { href: "/app/automation/chatbots", label: "Chatbots", minRole: "agent", section: "automation", icon: "bot", keywords: ["flows", "bot"] },
  { href: "/app/automation/ai-agent", label: "AI agent", minRole: "agent", section: "automation", icon: "brain", keywords: ["assistant", "knowledge", "ai"] },
  { href: "/app/automation/materials", label: "Reply materials", minRole: "agent", section: "automation", icon: "book", keywords: ["canned", "saved replies", "files", "price list", "attachments"] },
  { href: "/app/commerce", label: "Shopify recovery", minRole: "agent", section: "automation", icon: "cart", keywords: ["abandoned", "cart", "store", "shop"] },
  { href: "/app/reports", label: "Reports", minRole: "agent", section: "insights", icon: "chart", keywords: ["analytics", "stats", "metrics"] },
  { href: "/app/ads/insights", label: "Ad insights", minRole: "agent", section: "insights", icon: "trend", keywords: ["ads", "performance", "spend"] },
  { href: "/app/ads/optimizer", label: "Optimiser", minRole: "admin", section: "insights", icon: "sliders", keywords: ["optimizer", "suggestions", "budget"] },
  { href: "/app/conversions", label: "Conversions", minRole: "admin", section: "insights", icon: "trend", keywords: ["meta", "dataset", "leads", "sales", "events", "tracking"] },
  { href: "/app/settings/team", label: "Team", minRole: "admin", group: "settings", section: "settings", icon: "team", keywords: ["members", "invite", "users", "roles"] },
  { href: "/app/settings/teams", label: "Teams", minRole: "admin", group: "settings", section: "settings", icon: "users", keywords: ["groups", "sales", "support", "departments"] },
  { href: "/app/settings/routing", label: "Chat routing", minRole: "admin", group: "settings", section: "settings", icon: "route", keywords: ["assign", "round robin", "availability"] },
  { href: "/app/settings/connect", label: "Connect WhatsApp", minRole: "admin", group: "settings", section: "settings", icon: "phone", keywords: ["number", "signup", "waba"] },
  { href: "/app/settings/connections", label: "Meta connections", minRole: "agent", group: "settings", section: "settings", icon: "plug", keywords: ["facebook", "instagram", "pages", "ad account"] },
  { href: "/app/settings/ai-tools", label: "AI tools", minRole: "admin", group: "settings", section: "settings", icon: "wrench", keywords: ["mcp", "tools", "connect"] },
  { href: "/app/settings/mcp", label: "MCP connection", minRole: "admin", group: "settings", section: "settings", icon: "link", keywords: ["claude", "chatgpt", "model context protocol"] },
  { href: "/app/settings/api", label: "API and webhooks", minRole: "admin", group: "settings", section: "settings", icon: "code", keywords: ["keys", "developer", "integration"] },
  { href: "/app/billing", label: "Billing", minRole: "admin", group: "settings", section: "settings", icon: "card", keywords: ["plan", "invoice", "payment", "subscription"] },
  // Every member sees the page (docs/SPEND-CONTROLS-SPEC.md 8.1): the owner edits, admins lower and stop, team members read.
  // Kept last so Eddy's open_page list (which already offered this page) keeps its order.
  { href: "/app/settings/spending", label: "Spending limits", minRole: "agent", group: "settings", section: "settings", icon: "card", keywords: ["budget", "limit", "spend", "cap", "money", "approvals", "assistants", "stop"] },
];

export const hasRole = (role: Role, minRole: Role) => RANK[role] >= RANK[minRole];

export function navFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter((i) => hasRole(role, i.minRole));
}

export type NavGroup = NavSection & { items: NavItem[] };

/** Sections in display order with the pages this role may see; sections with no visible pages are dropped. */
export function groupNav(role: Role): NavGroup[] {
  const visible = navFor(role);
  return SECTIONS.map((s) => ({ ...s, items: visible.filter((i) => i.section === s.id) })).filter((g) => g.items.length > 0);
}

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The single best matching link (longest href) so nested pages such as /app/ads/insights do not also light up /app/ads. */
export function activeHref(pathname: string, items: NavItem[]): string | null {
  let best: string | null = null;
  for (const i of items) {
    if (isActive(pathname, i.href) && (best === null || i.href.length > best.length)) best = i.href;
  }
  return best;
}

export function activeSection(pathname: string, role: Role): SectionId | null {
  const href = activeHref(pathname, navFor(role));
  return NAV_ITEMS.find((i) => i.href === href)?.section ?? null;
}

const TAB_PREFERENCE: string[][] = [
  ["/app/inbox"],
  ["/app/contacts"],
  ["/app/broadcasts", "/app/templates"],
  ["/app/automation"],
  ["/app/reports"],
];

/** The five most important destinations for the mobile tab bar; each slot takes its first link the role may see. */
export function mobileTabs(role: Role): NavItem[] {
  const visible = navFor(role);
  const tabs: NavItem[] = [];
  for (const slot of TAB_PREFERENCE) {
    const found = slot.map((href) => visible.find((i) => i.href === href)).find(Boolean);
    if (found) tabs.push(found);
  }
  return tabs;
}
