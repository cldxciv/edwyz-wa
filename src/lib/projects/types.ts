/**
 * The All projects overview (GET /api/projects/overview) and the New project action (POST /api/projects). Pure types and
 * constants with no imports, so the page and its components can use them in the browser.
 *
 * A project is one workspace (Tenant). A person can own or belong to several: one per business or client.
 */

export type ProjectRole = "owner" | "admin" | "agent";

/** The workspace billing states of src/lib/billing/status.ts. */
export type ProjectBillingState = "trialing" | "active" | "past_due_grace" | "locked" | "suspended" | "exempt";

/**
 * What the date on a project's plan line means:
 * - trial_ends: the free trial ends then;
 * - renews: the paid plan renews then;
 * - ends: the plan stops then and will not renew (cancelled, or set up by hand);
 * - read_only_from: a payment failed and the project becomes read-only then;
 * - ended: the trial or plan ended then and the project is read-only.
 */
export type ProjectEndKind = "trial_ends" | "renews" | "ends" | "read_only_from" | "ended";

export type ProjectBilling = {
  state: ProjectBillingState;
  /** The paid plan's name, when the project has (or had) one. */
  planName: string | null;
  /** ISO date that goes with endKind, or null when nothing is due (complimentary, suspended, no date known). */
  endsAt: string | null;
  endKind: ProjectEndKind | null;
  daysLeftInTrial: number | null;
};

/** connected: at least one number can send. setup: a number was added but is not connected (yet). none: no number. */
export type ProjectWhatsAppState = "connected" | "setup" | "none";

export type ProjectWhatsApp = { state: ProjectWhatsAppState; numbers: number; display: string | null };

/** An amount in one currency: exact minor units as a decimal string plus the formatted text (docs/SPEND-CONTROLS-SPEC.md 3.1). */
export type ProjectMoney = { minor: string; currency: string; formatted: string };

/**
 * Ad spend this month as Edwyz's spending controls read it from Meta. They read an ad account only while it has an ad running
 * through Edwyz or a Meta spending limit set in Edwyz (spend.sync.fast), so an account is "tracked" only while its figures are
 * fresh (synced in the last SPEND_TRACKED_WITHIN_HOURS hours). Untracked accounts are left out of the amounts, never shown as 0.
 */
export type ProjectAdSpend = {
  /** Spend of the tracked accounts per currency, largest first; each account's month in its own time zone. Empty: nothing spent. */
  amounts: ProjectMoney[];
  /** The project's connected ad accounts. */
  accounts: number;
  /** How many of them are tracked now. */
  tracked: number;
};

export type ProjectSummary = {
  id: string;
  name: string;
  role: ProjectRole;
  /** The workspace this browser is signed in to now. */
  current: boolean;
  billing: ProjectBilling;
  whatsapp: ProjectWhatsApp | null;
  /** Chats with unread messages that this person may see there. Null when it could not be counted. */
  unreadConversations: number | null;
  /** Leads that arrived in the last LEADS_WINDOW_DAYS days. Null when they could not be counted. */
  newLeads: number | null;
  /** Ad spend this month and how much of it Edwyz tracks. Null: it could not be read. */
  adSpendMonth: ProjectAdSpend | null;
};

export type NewProjectAccess = { allowed: true; reason: null } | { allowed: false; reason: string };

export type ProjectsOverview = {
  projects: ProjectSummary[];
  currentId: string;
  /** Every live workspace the person belongs to; more than projects.length when the list was cut at MAX_PROJECTS_LISTED. */
  total: number;
  truncated: boolean;
  leadsWindowDays: number;
  /** Whether "New project" will work for this person now, and why not. The server checks again on create. */
  newProject: NewProjectAccess;
  generatedAt: string;
};

/** POST /api/projects answers this with 201. */
export type CreatedProject = { project: { id: string; name: string; slug: string } };

/** The most workspaces the overview lists (the current one is always among them). */
export const MAX_PROJECTS_LISTED = 100;
/** The most live workspaces one person may own. */
export const MAX_OWNED_PROJECTS = 50;
/**
 * The most live workspaces one person may own that have no paid plan (on a free trial, or read-only after it). Each new
 * project starts its own free trial, so this stops trials being chained; paying for one frees a place.
 */
export const MAX_UNPAID_PROJECTS = 3;
/** New projects one person may start in 24 hours (on top of the signup limit per connection). */
export const NEW_PROJECTS_PER_DAY = 10;
/** Same length as the signup form's workspace name. */
export const PROJECT_NAME_MAX = 100;
export const LEADS_WINDOW_DAYS = 7;
/**
 * An ad account counts as tracked while its spend figures were synced within this many hours. spend.sync.fast runs every 15
 * minutes and backs off 30 minutes on a Meta rate limit, so a tracked account is never this far behind; one whose Edwyz ads
 * stopped mid-month is, and its frozen total is not shown as this month's spend.
 */
export const SPEND_TRACKED_WITHIN_HOURS = 2;
