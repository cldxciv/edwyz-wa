/**
 * Words and small pure helpers for the All projects page (src/components/projects/ProjectsView.tsx). Everything a card says is
 * built here, so it is tested without rendering.
 */
import { formatDate, stateSummary } from "@/components/billing/helpers";
import { roleLabel } from "@/components/team/helpers";
import type { Tone } from "@/components/ui/status";
import type { ProjectAdSpend, ProjectBilling, ProjectWhatsApp } from "@/lib/projects/types";

export const NOT_AVAILABLE = "Not available";

export const PAGE_DESCRIPTION = "Each project is its own workspace, with its own WhatsApp number, team, contacts and plan. Switch to one to work in it.";
export const NEW_PROJECT_DESCRIPTION = "A project is a separate workspace for one business or client: its own WhatsApp number, team, contacts and plan. It starts with a free trial.";
export const NEW_PROJECT_HINT = "Usually the business or client name. You can rename it later.";
export const SPEND_HINT =
  "Ad spend comes from Edwyz's spending controls. They read Meta only for ad accounts with an ad running through Edwyz or a spending limit set here, so other accounts show as not tracked.";
export const NO_AD_ACCOUNT = "No ad account";
export const NOT_TRACKED = "Not tracked";

/** Show the find box once the list is longer than this. */
export const FILTER_FROM = 6;

const dateText = (iso: string | null): string => (iso ? formatDate(iso) : "");

/** The one sentence about the date that matters for the project's plan, or null. */
export function billingDateText(billing: ProjectBilling): string | null {
  const date = dateText(billing.endsAt);
  if (!date || !billing.endKind) return null;
  switch (billing.endKind) {
    case "trial_ends": {
      const left = billing.daysLeftInTrial;
      return left !== null && left <= 3 ? `Trial ends on ${date} (${left} ${left === 1 ? "day" : "days"} left)` : `Trial ends on ${date}`;
    }
    case "renews":
      return `Renews on ${date}`;
    case "ends":
      return `Ends on ${date}`;
    case "read_only_from":
      return `Becomes read-only on ${date} unless the payment goes through`;
    case "ended":
      return `Ended on ${date}`;
    default:
      return null;
  }
}

export type BillingLine = { label: string; tone: Tone; plan: string | null; date: string | null };

/** The plan pill (state label and tone, the same words as the Billing page), the plan name and the date sentence. */
export function billingLine(billing: ProjectBilling): BillingLine {
  const summary = stateSummary(billing.state);
  return { label: summary.label, tone: summary.tone, plan: billing.planName, date: billingDateText(billing) };
}

export function whatsappText(w: ProjectWhatsApp | null): string {
  if (!w) return NOT_AVAILABLE;
  if (w.state === "none") return "Not connected";
  if (w.state === "setup") return "Not connected yet";
  const more = w.numbers > 1 ? ` and ${w.numbers - 1} more` : "";
  return `${w.display ?? "Connected"}${more}`;
}

export function countText(n: number | null): string {
  return n === null ? NOT_AVAILABLE : n.toLocaleString("en-IN");
}

/**
 * Ad spend in each currency, never added together across currencies. "None" only when every connected ad account is tracked
 * and spent nothing; an account Edwyz does not read is called not tracked, never counted as nothing spent.
 */
export function spendText(spend: ProjectAdSpend | null): string {
  if (spend === null) return NOT_AVAILABLE;
  if (spend.accounts === 0) return NO_AD_ACCOUNT;
  if (spend.tracked === 0) return NOT_TRACKED;
  const amounts = spend.amounts.length === 0 ? "None" : spend.amounts.map((m) => m.formatted).join(" + ");
  const untracked = spend.accounts - spend.tracked;
  return untracked > 0 ? `${amounts} (${untracked} of ${spend.accounts} ad accounts not tracked)` : amounts;
}

export const roleText = (role: string): string => roleLabel(role);

/** Projects whose name contains every word of the query, ignoring case. */
export function filterProjects<T extends { name: string }>(projects: T[], query: string): T[] {
  const words = query.toLocaleLowerCase("en").split(/\s+/).filter(Boolean);
  if (words.length === 0) return projects;
  return projects.filter((p) => {
    const name = p.name.toLocaleLowerCase("en");
    return words.every((w) => name.includes(w));
  });
}

/** The count line under the header, also announced when the list loads or is filtered. */
export function listSummary(shown: number, total: number, query: string): string {
  if (query.trim()) return shown === 0 ? `No projects match "${query.trim()}"` : `${shown} of ${total} ${total === 1 ? "project" : "projects"} match "${query.trim()}"`;
  return `${total} ${total === 1 ? "project" : "projects"}`;
}

/** Where a refusal of POST /api/projects belongs: under the name field, or above the form. */
export function createRefusal(err: unknown): { field: string | null; form: string | null } {
  const message = err instanceof Error && err.message ? err.message : "We could not start the project. Check your connection and try again.";
  const field = (err as { body?: { field?: unknown } } | null)?.body?.field;
  return field === "name" ? { field: message, form: null } : { field: null, form: message };
}

export const switchingText = (name: string) => `Opening ${name}...`;
export const switchFailedText = (name: string, reason: string) => `We could not open ${name}. ${reason}`;
export const createdButNotOpenedText = (name: string, reason: string) => `${name} is ready, but we could not open it. ${reason} Switch to it from All projects.`;
