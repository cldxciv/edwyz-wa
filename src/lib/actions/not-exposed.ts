/**
 * Every app route that has no Eddy action, each with its reason (docs/EDDY-SPEC.md 4.8). tests/actions-route-coverage.test.ts
 * walks src/app/api/**\/route.ts: each exported method must be the route of a registered definition, an equivalent route
 * of one (EQUIVALENT_ROUTES), or listed here (PENDING is empty since the spend front desk landed, EDDY-06). A new, unclassified route fails CI and the failure
 * names the file and the two ways to fix it.
 *
 * Reasons (4.8), plus `page_only` (this package's addition, reported with it): the reason table of 4.8 lists what is never
 * reachable through Eddy for safety; `page_only` is what simply has no v1 tool, because it is an editor, a builder, a
 * settings form or an internal helper of one screen. Eddy reaches all of these with open_page.
 *
 * Pure data and a matcher: no imports, so tests and tools can read it without loading anything.
 */

export type NotExposedReason =
  | "platform"
  | "auth"
  | "public_or_system"
  | "plumbing"
  | "secret"
  | "account"
  | "money_controls"
  | "file"
  | "bulk_export"
  | "stream"
  | "v2"
  | "page_only";

export const REASONS: Readonly<Record<NotExposedReason, string>> = Object.freeze({
  platform: "Platform admin (super admin) only.",
  auth: "Sign-in, sign-up, passwords and two-factor: never through an assistant.",
  public_or_system: "Called by Meta, Razorpay, the browser's CSP reporter, internal jobs or public links, not by a signed-in member.",
  plumbing: "Eddy's own transport or another machine surface (Eddy, cards, notices, MCP, the public APIs).",
  secret: "Creates, shows or uses a secret or a link that works without signing in (API keys, webhook secrets, MCP tokens, store tokens).",
  account: "Billing, plan, workspace deletion, ownership, roles and removal of members, and disconnecting Meta: the owner does these on the page.",
  money_controls: "Raising spending limits, turning spending back on, Meta's spending limit, approvers and assistant levels: owner-only on the Spending page.",
  file: "Uploads and downloads of files and media.",
  bulk_export: "Bulk exports of personal data.",
  stream: "The inbox's live event stream.",
  v2: "Spends money or acts on ads, leads, conversions, content, creative or the optimizer: Eddy v2 (4.7), behind Phase 0.",
  page_only: "An editor, builder, settings form or internal helper of one screen with no v1 tool; Eddy opens the page instead.",
});

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** A route pattern is a route path as the file tree names it ("/api/contacts/[id]"); "/**" at the end matches it and below. */
export type RouteEntry = { route: string; methods: "*" | readonly HttpMethod[]; reason: NotExposedReason; note?: string };

const all = "*" as const;

export const NOT_EXPOSED: readonly RouteEntry[] = Object.freeze([
  // ===== platform, auth, plumbing =====
  { route: "/api/admin/**", methods: all, reason: "platform" },
  { route: "/api/auth/**", methods: all, reason: "auth" },
  { route: "/api/eddy/**", methods: all, reason: "plumbing" },
  { route: "/api/actions/**", methods: all, reason: "plumbing", note: "Card buttons only; undo_last_action reaches the undo route through invoke.ts." },
  { route: "/api/notices/**", methods: all, reason: "plumbing" },
  { route: "/api/mcp", methods: all, reason: "plumbing" },
  { route: "/api/ext/**", methods: all, reason: "plumbing" },
  { route: "/api/v1/**", methods: all, reason: "plumbing" },

  // ===== public and system =====
  { route: "/api/[...rest]", methods: all, reason: "public_or_system", note: "The catch-all 404 for unknown API paths." },
  { route: "/api/webhooks/**", methods: all, reason: "public_or_system" },
  { route: "/api/meta/**", methods: all, reason: "public_or_system", note: "Meta deauthorize and data deletion callbacks." },
  { route: "/api/meta-connect/callback", methods: all, reason: "public_or_system" },
  { route: "/api/csp-report", methods: all, reason: "public_or_system" },
  { route: "/api/internal/**", methods: all, reason: "public_or_system" },
  { route: "/api/approvals/[id]/decide", methods: all, reason: "public_or_system", note: "Clients decide by public token." },
  { route: "/api/content/media-public/**", methods: all, reason: "public_or_system" },
  { route: "/api/creative/public/**", methods: all, reason: "public_or_system" },
  { route: "/api/spend/approvals/token", methods: all, reason: "public_or_system", note: "Decline by token, logged out (Phase 0 WP-14)." },

  // ===== secrets =====
  { route: "/api/integrations/**", methods: all, reason: "secret" },
  { route: "/api/mcp-connections/**", methods: all, reason: "secret" },
  { route: "/api/commerce/stores", methods: all, reason: "secret", note: "Shopify store tokens." },
  { route: "/api/commerce/stores/[id]", methods: all, reason: "secret", note: "Shopify store tokens." },
  { route: "/api/commerce/stores/[id]/verify", methods: all, reason: "secret", note: "Shopify store tokens." },
  { route: "/api/approvals", methods: ["POST"], reason: "secret", note: "Returns a public approval link once." },

  // ===== account =====
  { route: "/api/billing/**", methods: all, reason: "account" },
  { route: "/api/workspace/ownership", methods: all, reason: "account" },
  { route: "/api/workspace/members/[userId]", methods: all, reason: "account", note: "Role changes and removal." },
  { route: "/api/workspace/invites/[id]", methods: all, reason: "account", note: "Revoking an invite." },
  { route: "/api/meta-connect/disconnect", methods: all, reason: "account" },

  // ===== money controls (owner-only on the Spending page) =====
  { route: "/api/ads/caps", methods: all, reason: "money_controls" },
  { route: "/api/optimizer/settings", methods: all, reason: "money_controls" },
  { route: "/api/spend/ledger", methods: all, reason: "bulk_export", note: "The spending ledger and its CSV." },
  { route: "/api/spend/**", methods: all, reason: "money_controls", note: "Limits, control, approvers, Meta's limit, mandates, notifications. get_spending, stop_spending and decline_spend_request take the summary, the freeze PUT and the approvals POST (EDDY-06)." },

  // ===== files =====
  { route: "/api/contacts/import", methods: all, reason: "file" },
  { route: "/api/inbox/conversations/[id]/attachments", methods: all, reason: "file" },
  { route: "/api/inbox/media/**", methods: all, reason: "file" },
  { route: "/api/templates/media", methods: all, reason: "file" },
  { route: "/api/content/media", methods: all, reason: "file" },
  { route: "/api/content/media/[file]", methods: all, reason: "file" },
  { route: "/api/creative/assets/[id]/file", methods: all, reason: "file" },

  // ===== bulk exports and the stream =====
  { route: "/api/export/**", methods: all, reason: "bulk_export" },
  { route: "/api/leads/export", methods: all, reason: "bulk_export" },
  { route: "/api/inbox/conversations/[id]/export", methods: all, reason: "bulk_export", note: "Chat export." },
  { route: "/api/inbox/stream", methods: all, reason: "stream" },

  // ===== v2 (4.7): spending, ads, leads, conversions, content, creative, optimizer =====
  { route: "/api/ads/**", methods: all, reason: "v2" },
  { route: "/api/broadcasts/[id]/start", methods: all, reason: "v2", note: "start_broadcast and resume_broadcast (Phase 0 reserveBulk)." },
  { route: "/api/broadcasts/[id]", methods: ["PATCH"], reason: "v2", note: "schedule_broadcast." },
  { route: "/api/inbox/conversations", methods: ["POST"], reason: "v2", note: "start_chat: a paid template." },
  { route: "/api/chatbots/[id]/start", methods: all, reason: "v2", note: "Starting a bot messages the customer (the inverse of stop_bot_on_conversation)." },
  { route: "/api/leads/[id]", methods: ["PATCH"], reason: "v2", note: "update_lead_status and assign_lead." },
  { route: "/api/conversions/**", methods: all, reason: "v2" },
  { route: "/api/content/**", methods: all, reason: "v2" },
  { route: "/api/creative/**", methods: all, reason: "v2" },
  { route: "/api/optimizer/**", methods: all, reason: "v2" },

  // ===== page only: editors, builders, settings and screen helpers =====
  { route: "/api/ai-agent/**", methods: all, reason: "page_only", note: "AI agent setup, knowledge sources, test chats and usage. Turning one off is disable_automation." },
  { route: "/api/approvals/[id]/resend", methods: all, reason: "page_only" },
  { route: "/api/automation", methods: ["POST"], reason: "page_only", note: "The rule builder." },
  { route: "/api/automation/[id]", methods: ["GET", "DELETE"], reason: "page_only" },
  { route: "/api/automation/[id]/convert", methods: all, reason: "page_only" },
  { route: "/api/automation/[id]/move", methods: all, reason: "page_only" },
  { route: "/api/automation/executions", methods: all, reason: "page_only" },
  { route: "/api/automation/materials/**", methods: all, reason: "page_only" },
  { route: "/api/automation/materials", methods: all, reason: "page_only" },
  { route: "/api/automation/options", methods: all, reason: "page_only" },
  { route: "/api/automation/settings", methods: all, reason: "page_only" },
  { route: "/api/broadcasts/[id]/follow-up", methods: all, reason: "page_only" },
  { route: "/api/broadcasts/[id]/funnel", methods: all, reason: "page_only", note: "get_broadcast returns the funnel." },
  { route: "/api/broadcasts/[id]/report", methods: all, reason: "page_only", note: "get_broadcast returns the report." },
  { route: "/api/broadcasts/calendar", methods: all, reason: "page_only" },
  { route: "/api/broadcasts/options", methods: all, reason: "page_only" },
  { route: "/api/broadcasts/overview", methods: all, reason: "page_only" },
  { route: "/api/chatbots", methods: all, reason: "page_only", note: "The chatbot builder." },
  { route: "/api/chatbots/[id]", methods: all, reason: "page_only" },
  { route: "/api/chatbots/[id]/archive", methods: all, reason: "page_only" },
  { route: "/api/chatbots/[id]/duplicate", methods: all, reason: "page_only" },
  { route: "/api/chatbots/[id]/sessions", methods: all, reason: "page_only" },
  { route: "/api/chatbots/[id]/stats", methods: all, reason: "page_only" },
  { route: "/api/chatbots/[id]/test-run", methods: all, reason: "page_only" },
  { route: "/api/chatbots/live", methods: ["GET"], reason: "page_only" },
  { route: "/api/chatbots/options", methods: all, reason: "page_only" },
  { route: "/api/commerce/carts", methods: all, reason: "page_only" },
  { route: "/api/commerce/options", methods: all, reason: "page_only" },
  { route: "/api/commerce/stats", methods: all, reason: "page_only" },
  { route: "/api/commerce/stores/[id]/settings", methods: ["GET"], reason: "page_only" },
  { route: "/api/inbox/conversations/[id]/context", methods: all, reason: "page_only" },
  { route: "/api/inbox/conversations/[id]/marks", methods: all, reason: "page_only", note: "The member's own favourite and unread marks." },
  { route: "/api/inbox/conversations/[id]/notes", methods: ["GET"], reason: "page_only" },
  { route: "/api/inbox/conversations/[id]/read", methods: all, reason: "page_only" },
  { route: "/api/inbox/conversations/[id]/suggest", methods: all, reason: "page_only", note: "Reply suggestions in the composer (an AI call metered by the gateway)." },
  { route: "/api/inbox/filters/**", methods: all, reason: "page_only" },
  { route: "/api/inbox/filters", methods: all, reason: "page_only" },
  { route: "/api/inbox/mentions", methods: all, reason: "page_only" },
  { route: "/api/inbox/numbers", methods: all, reason: "page_only", note: "get_workspace_status lists the numbers." },
  { route: "/api/inbox/settings", methods: all, reason: "page_only" },
  { route: "/api/leads/forms/**", methods: all, reason: "page_only" },
  { route: "/api/leads/forms", methods: all, reason: "page_only" },
  { route: "/api/leads/sequences", methods: all, reason: "page_only" },
  { route: "/api/leads/sequences/[id]", methods: ["GET", "DELETE"], reason: "page_only" },
  { route: "/api/meta-connect/connections", methods: all, reason: "page_only" },
  { route: "/api/meta-connect/refresh", methods: all, reason: "page_only" },
  { route: "/api/onboarding/complete", methods: all, reason: "page_only", note: "Embedded Signup's own completion step, called by the connect page." },
  { route: "/api/onboarding/status", methods: all, reason: "page_only" },
  { route: "/api/onboarding/token-health", methods: all, reason: "page_only", note: "get_workspace_status reports token health." },
  { route: "/api/quick-replies", methods: ["GET"], reason: "page_only" },
  { route: "/api/quick-replies/[id]", methods: all, reason: "page_only" },
  { route: "/api/reports/usage", methods: all, reason: "page_only" },
  { route: "/api/routing/**", methods: all, reason: "page_only", note: "Routing settings. The member's own availability is set_my_availability." },
  { route: "/api/segments/[id]", methods: ["PATCH"], reason: "page_only" },
  { route: "/api/setup/dismiss", methods: all, reason: "page_only" },
  { route: "/api/teams", methods: all, reason: "page_only", note: "list_team lists the teams." },
  { route: "/api/teams/[id]", methods: all, reason: "page_only" },
  { route: "/api/teams/[id]/members", methods: all, reason: "page_only" },
  { route: "/api/templates/[id]/duplicate", methods: all, reason: "page_only" },
  { route: "/api/templates/sync", methods: all, reason: "page_only" },
  { route: "/api/workspace/invites", methods: ["GET"], reason: "page_only" },
  { route: "/api/workspace/messaging-limits", methods: all, reason: "page_only", note: "get_workspace_status reports each number's limit." },
] satisfies RouteEntry[]);

/** A route an action reaches as an equivalent of its main route (the action's other kinds), checked by role parity too. */
export type EquivalentRoute = { route: string; method: HttpMethod; action: string; note: string };

export const EQUIVALENT_ROUTES: readonly EquivalentRoute[] = Object.freeze([
  { route: "/api/inbox/conversations/[id]/status", method: "PATCH", action: "set_conversation_status", note: "The same handler as PUT." },
  { route: "/api/inbox/conversations/bulk", method: "POST", action: "tag_conversations", note: "More than 10 chats go through bulkUpdate(actor)." },
  { route: "/api/chatbots/[id]/unpublish", method: "POST", action: "disable_automation", note: "kind chatbot." },
  { route: "/api/ai-agent/agents/[id]", method: "PATCH", action: "disable_automation", note: "kind ai_agent." },
  { route: "/api/leads/sequences/[id]", method: "PATCH", action: "disable_automation", note: "kind lead_sequence." },
  { route: "/api/commerce/stores/[id]/settings", method: "PUT", action: "disable_automation", note: "kind cart_reminders." },
  { route: "/api/chatbots/[id]/publish", method: "POST", action: "enable_automation", note: "kind chatbot." },
  { route: "/api/broadcasts/audience", method: "POST", action: "preview_audience", note: "Reach of tags plus a segment or filters." },
] satisfies EquivalentRoute[]);

/**
 * Routes whose tools were still waiting for their package. Empty: the three spend front-desk tools (get_spending,
 * stop_spending, decline_spend_request) landed with the spend bridge (EDDY-06), so the list shrank to nothing as EDDY-07
 * acceptance 3 asks. The coverage test keeps it empty.
 */
export const PENDING: readonly EquivalentRoute[] = Object.freeze([] satisfies EquivalentRoute[]);

/** True when a route pattern ("/api/admin/**", "/api/contacts/[id]") covers a route path from the file tree. */
export function routeMatches(pattern: string, route: string): boolean {
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    return route === base || route.startsWith(`${base}/`);
  }
  return pattern === route;
}

/** The first NOT_EXPOSED entry for a route and method, or null. */
export function notExposedEntry(route: string, method: HttpMethod): RouteEntry | null {
  return NOT_EXPOSED.find((e) => routeMatches(e.route, route) && (e.methods === "*" || e.methods.includes(method))) ?? null;
}
