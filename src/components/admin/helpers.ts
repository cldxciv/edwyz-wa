import type { Metadata } from "next";
import type { Tone } from "@/components/ui";
import { stateSummary } from "@/components/billing/helpers";
import { failureHint, UNKNOWN_FAILURE_HINT } from "@/components/inbox/ux";
import { normalizeTier } from "@/lib/messaging-limit";

export const ADMIN_TITLE_SUFFIX = "Platform admin";

/**
 * Title and robots for one admin page. Pages carry this instead of the admin layout because layout metadata is applied even when
 * the page answers 404 to a stranger, and that answer must look like any other missing page.
 */
export function adminPageMetadata(title: string): Metadata {
  return { title: { absolute: `${title} | ${ADMIN_TITLE_SUFFIX}` }, robots: { index: false, follow: false, nocache: true } };
}

export const TENANT_FILTER_LABELS: Record<string, string> = {
  all: "All active workspaces",
  trial: "On a free trial",
  paying: "Paying",
  suspended: "Suspended",
  exempt: "Complimentary",
  deleted: "Deleted",
  deletion_requested: "Deletion requested",
};

export function tenantFilterLabel(filter: string): string {
  return TENANT_FILTER_LABELS[filter] ?? TENANT_FILTER_LABELS.all;
}

/** Empty-state wording that says what was searched or filtered, as the UI guidelines ask. */
export function emptyTenants(q: string, filter: string): { title: string; body: string } {
  const query = q.trim();
  if (query && filter !== "all") return { title: `No workspaces match "${query}"`, body: `Nothing in "${tenantFilterLabel(filter)}" matches that name. Clear the search or choose a different filter.` };
  if (query) return { title: `No workspaces match "${query}"`, body: "Check the spelling, or try part of the name or the short web address." };
  if (filter !== "all") return { title: `No workspaces are ${tenantFilterLabel(filter).toLowerCase()}`, body: "Choose a different filter to see other workspaces." };
  return { title: "No workspaces yet", body: "Workspaces appear here once customers sign up." };
}

export function emptyUsers(q: string): { title: string; body: string } {
  const query = q.trim();
  return query ? { title: `No users match "${query}"`, body: "Search by email address or by name. Try fewer letters." } : { title: "No users yet", body: "People appear here once they sign up." };
}

export function billingLabel(state: string): string {
  return stateSummary(state).label;
}

export function billingTone(state: string): Tone {
  return stateSummary(state).tone;
}

const ONBOARDING: Record<string, { label: string; tone: Tone }> = {
  not_started: { label: "Not started", tone: "neutral" },
  in_progress: { label: "Setting up", tone: "info" },
  live: { label: "Connected", tone: "good" },
  failed: { label: "Setup failed", tone: "bad" },
};

export function onboardingInfo(status: string): { label: string; tone: Tone } {
  return ONBOARDING[status] ?? { label: humanize(status), tone: "neutral" };
}

export function humanize(raw: string): string {
  const words = raw.replace(/[_.]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown";
}

const QUALITY: Record<string, { label: string; tone: Tone }> = {
  GREEN: { label: "High quality", tone: "good" },
  YELLOW: { label: "Medium quality", tone: "warn" },
  RED: { label: "Low quality", tone: "bad" },
};

export function qualityInfo(rating: string | null | undefined): { label: string; tone: Tone } {
  return QUALITY[(rating ?? "").toUpperCase()] ?? { label: "Not rated yet", tone: "neutral" };
}

const TIERS: Record<string, string> = {
  TIER_50: "50 customers a day",
  TIER_250: "250 customers a day",
  TIER_1K: "1,000 customers a day",
  TIER_2K: "2,000 customers a day",
  TIER_10K: "10,000 customers a day",
  TIER_100K: "100,000 customers a day",
  TIER_UNLIMITED: "No daily limit",
};

export function tierLabel(tier: string | null | undefined): string {
  if (!tier) return "Not set yet";
  return TIERS[normalizeTier(tier) ?? ""] ?? humanize(tier);
}

const AUDIT_LABELS: Record<string, string> = {
  "admin.view": "Opened an admin page",
  "admin.settings.update": "Changed platform settings",
  "admin.test_message": "Sent a test message",
  "admin.stepup.ok": "Passed two-factor check",
  "admin.stepup.failed": "Failed two-factor check",
  "admin.stepup.recovery_used": "Used a recovery code",
  "admin.totp.enroll_start": "Started two-factor setup",
  "admin.totp.enrolled": "Turned on two-factor sign-in",
  "admin.totp.enroll_failed": "Two-factor setup failed",
  "admin.tenant.suspend": "Suspended a workspace",
  "admin.tenant.unsuspend": "Unsuspended a workspace",
  "admin.tenant.extend_trial": "Extended a free trial",
  "admin.tenant.comp": "Changed a workspace's complimentary status",
  "admin.tenant.change_plan": "Assigned a plan by hand",
  "admin.tenant.soft_delete": "Deleted a workspace",
  "admin.tenant.restore": "Restored a workspace",
  "admin.tenant.erase": "Erased a workspace permanently",
  "admin.plan.create": "Created a plan",
  "admin.plan.update": "Edited a plan",
  "admin.plan.publish": "Published a plan to Razorpay",
  "admin.plan.archive": "Archived a plan",
  "admin.plan.unarchive": "Restored a plan",
  "admin.plan.delete": "Deleted a plan",
  "admin.plan.duplicate": "Duplicated a plan",
  "admin.user.disable": "Disabled a user",
  "admin.user.enable": "Enabled a user",
  "admin.user.force_signout": "Signed a user out everywhere",
  "admin.user.resend_verification": "Resent a verification email",
  "admin.user.mark_verified": "Marked an email as verified",
  "admin.user.reset_link": "Created a password reset link",
  // Spending controls (docs/SPEND-CONTROLS-SPEC.md 8.3)
  "admin.tenant.set_spend_ceiling": "Set a spending override for a workspace",
  "admin.tenant.clear_spend_ceiling": "Removed a workspace's spending override",
  "admin.tenant.lower_spend_limits": "Lowered a workspace's spending limits",
  "admin.tenant.lower_assistant_level": "Lowered an assistant's level or limits",
  "admin.tenant.meta_limit_offboard": "Applied a choice for Meta's spending limit",
  "admin.tenant.lift_probation": "Lifted a workspace's new-workspace limits",
  "admin.tenant.set_probation": "Changed a workspace's new-workspace limits",
  "admin.tenant.verify_workspace": "Changed whether a workspace is verified",
  "admin.tenant.freeze_spending": "Stopped spending for a workspace",
  "admin.tenant.unfreeze_spending": "Turned spending back on for a workspace",
  "admin.tenant.clear_breaker": "Cleared a safety stop",
  "admin.tenant.mark_test_ad_account": "Changed whether an ad account is a test account",
  "admin.tenant.end_learning": "Ended an assistant's learning period",
  "admin.tenant.resync_meta_limit": "Read Meta's spending limit again",
  "admin.spend.stop_assistants": "Stopped assistants for every workspace",
  "admin.spend.stop_all": "Stopped all spending for every workspace",
  "admin.spend.resume": "Turned spending back on for every workspace",
  "admin.spend.ceiling": "Changed new-workspace limits or platform ceilings",
  "admin.spend.clear_ceiling": "Cleared a new-workspace limit or platform ceiling",
  "admin.spend.fx": "Changed an exchange rate for limits",
  "admin.spend.notifier": "Changed the notification sender",
  "admin.spend.defaults": "Changed the spending defaults",
  "admin.plan.ceilings": "Changed a plan's spending ceilings",
  "admin.api.list_spending": "Opened spending across workspaces",
  "admin.api.view_tenant_spending": "Opened a workspace's spending",
  "admin.api.spending_settings": "Opened spending settings",
};

/** True when an audit action has its own plain label (the spending pages' actions are all covered; checked by a test). */
export function hasAuditLabel(action: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUDIT_LABELS, action);
}

export function auditActionLabel(action: string): string {
  return AUDIT_LABELS[action] ?? humanize(action);
}

const PAYMENT_EVENT_LABELS: Record<string, string> = {
  "subscription.activated": "Subscription started",
  "subscription.charged": "Subscription payment taken",
  "subscription.cancelled": "Subscription cancelled",
  "subscription.completed": "Subscription finished",
  "subscription.halted": "Subscription stopped after failed payments",
  "subscription.pending": "Subscription payment pending",
  "payment.captured": "Payment received",
  "payment.failed": "Payment failed",
};

export function paymentEventLabel(type: string): string {
  return PAYMENT_EVENT_LABELS[type] ?? humanize(type);
}

export function paymentEventStatus(status: string): { label: string; tone: Tone } {
  if (status === "processed") return { label: "Handled", tone: "good" };
  if (status === "error") return { label: "Needs attention", tone: "bad" };
  return { label: "Waiting to be handled", tone: "warn" };
}

export function invoiceInfo(status: string): { label: string; tone: Tone } {
  if (status === "paid") return { label: "Paid", tone: "good" };
  if (status === "void") return { label: "Cancelled", tone: "neutral" };
  return { label: "Issued", tone: "info" };
}

/** The typed-confirmation gate: the exact text must be entered, ignoring surrounding spaces. */
export function confirmationMatches(typed: string, expected: string | undefined): boolean {
  if (!expected) return true;
  return typed.trim() === expected.trim();
}

export type ActionMode = "form" | "confirm";

/** Actions that collect no input only need a yes/no confirmation; everything else opens a form dialog. */
export function actionMode(opts: { fieldCount: number; needsReason: boolean; confirmText?: string }): ActionMode {
  return opts.fieldCount === 0 && !opts.needsReason && !opts.confirmText ? "confirm" : "form";
}

export type Attention = { id: string; tone: "bad" | "warn"; title: string; body: string; href?: string; linkLabel?: string };

type Metrics = {
  tenantsByState: Record<string, number>;
  quality: { rating: string; count: number }[];
  jobs: Record<string, number>;
  failedEvents: { id: string }[];
};

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** What the operator should look at first, most urgent first. Empty when everything is healthy. */
export function attentionItems(m: Metrics): Attention[] {
  const out: Attention[] = [];
  const failedJobs = m.jobs.failed ?? 0;
  if (failedJobs > 0) out.push({ id: "jobs", tone: "bad", title: `${plural(failedJobs, "background job has", "background jobs have")} failed`, body: "Messages, broadcasts or emails may not have gone out. Check the worker logs on the server." });
  const low = m.quality.find((q) => q.rating.toUpperCase() === "RED")?.count ?? 0;
  if (low > 0) out.push({ id: "quality", tone: "bad", title: `${plural(low, "phone number has", "phone numbers have")} low quality`, body: "WhatsApp may limit or block these numbers. Check the workspaces below." });
  if (m.failedEvents.length > 0) out.push({ id: "events", tone: "warn", title: `${m.failedEvents.length >= 10 ? "10 or more" : m.failedEvents.length} recent webhook ${m.failedEvents.length === 1 ? "event" : "events"} failed`, body: "Incoming WhatsApp events could not be processed. See the list further down." });
  const pastDue = m.tenantsByState.past_due_grace ?? 0;
  if (pastDue > 0) out.push({ id: "pastdue", tone: "warn", title: `${plural(pastDue, "workspace has", "workspaces have")} a failed payment`, body: "They are in the grace period. Sending stops if the payment is not fixed.", href: "/admin/payments", linkLabel: "Open payments" });
  const locked = m.tenantsByState.locked ?? 0;
  if (locked > 0) out.push({ id: "locked", tone: "warn", title: `${plural(locked, "workspace is", "workspaces are")} read-only`, body: "Their trial or subscription ended.", href: "/admin/tenants", linkLabel: "Open workspaces" });
  return out;
}

/** Admin timestamps are always shown in UTC so two operators read the same time. */
export const when = (iso: string | Date | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "-");

/** Same format as formatInr in the server queries, usable from client components. */
export function inrText(paise: number): string {
  return `INR ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function validatePrice(input: string): string | null {
  return /^\d{1,8}(\.\d{1,2})?$/.test(input.trim()) ? null : "Enter an amount in rupees, like 999 or 999.50.";
}

export function validatePlanCode(input: string): string | null {
  return /^[a-z0-9][a-z0-9_-]{1,39}$/.test(input.trim().toLowerCase()) ? null : "Use 2 to 40 lowercase letters, numbers, dashes or underscores, like starter.";
}

export function validateFeatures(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (text.length > 4000) return "This is too long. Keep it under 4,000 characters.";
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? null : 'Enter a JSON object, like {"api": true}.';
  } catch {
    return 'This is not valid JSON. Enter an object like {"api": true}.';
  }
}

export function validateLimit(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  return /^\d+$/.test(text) && Number(text) >= 1 ? null : "Enter a whole number of 1 or more, or leave empty for unlimited.";
}

/* ---------- Spending (docs/SPEND-CONTROLS-SPEC.md 8.3) ---------- */

/** Ads currencies the plan form and the settings page offer; INR first. */
export const PLAN_CEILING_CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED"] as const;

/** The typed confirmations of the platform switch. The same words as src/lib/spend/kill.ts (checked by a test). */
export const STOP_SPENDING_PHRASE = "STOP SPENDING";
export const START_SPENDING_PHRASE = "START SPENDING";

/** An amount typed in the currency's main unit: "2000", "2,000" or "2000.50". Empty is allowed (no ceiling / Not set). */
export function validateMoneyText(input: string, opts: { wholeOnly?: boolean } = {}): string | null {
  const text = input.replace(/[\s,₹]/g, "");
  if (!text) return null;
  if (opts.wholeOnly) return /^\d{1,15}$/.test(text) ? null : "Enter a whole number, like 500.";
  return /^\d{1,15}(\.\d{1,3})?$/.test(text) ? null : "Enter an amount using numbers only, like 2000 or 2000.50.";
}

export const SPENDING_FILTER_LABELS: Record<string, string> = {
  all: "All workspaces",
  new_workspace: "On new-workspace limits",
  stopped: "Stopped",
  near_limit: "Near a limit (80% or more)",
  meta_attention: "Meta limit needs attention",
  safety_stop: "Safety stop open",
};

export function spendingFilterLabel(filter: string): string {
  return SPENDING_FILTER_LABELS[filter] ?? SPENDING_FILTER_LABELS.all;
}

export function emptySpending(q: string, filter: string): { title: string; body: string } {
  const query = q.trim();
  if (query) return { title: `No workspaces match "${query}"`, body: "Search by name or web address, or clear the search." };
  if (filter !== "all") return { title: `No workspaces: ${spendingFilterLabel(filter).toLowerCase()}`, body: "Nothing needs this filter right now. Choose All workspaces to see every row." };
  return { title: "No workspaces yet", body: "Workspaces appear here once customers sign up." };
}

export function spendStateInfo(state: string): { label: string; tone: Tone } {
  if (state === "stopped") return { label: "Stopped", tone: "bad" };
  if (state === "assistants_stopped") return { label: "Assistants stopped", tone: "warn" };
  return { label: "On", tone: "good" };
}

export function newWorkspaceLimitsInfo(value: string): { label: string; tone: Tone } {
  if (value === "forced") return { label: "Forced", tone: "warn" };
  if (value === "on") return { label: "On", tone: "info" };
  return { label: "Lifted", tone: "neutral" };
}

const META_TONES: Record<string, Tone> = {
  managed: "good",
  ready: "info",
  sandbox: "neutral",
  demo: "neutral",
  off: "neutral",
  withdrawn: "neutral",
  no_ad_account: "neutral",
  other_workspace: "info",
  kept_while_paused: "info",
  pending_owner: "warn",
  deferred: "warn",
  loose: "warn",
  needs_monthly_limit: "warn",
  unavailable_prepaid: "warn",
  currency_mismatch: "warn",
  no_permission: "bad",
  error: "bad",
};

export function metaLimitTone(state: string): Tone {
  return META_TONES[state] ?? "neutral";
}

type Money = { formatted: string } | null | undefined;

/** A limit or amount as text; a missing limit reads "Not set", never 0. */
export function moneyText(m: Money, notSet = "Not set"): string {
  return m ? m.formatted : notSet;
}

/** One list cell: spent / set aside / limit. */
export function cellText(cell: { spent: Money; setAside: Money; limit: Money } | null | undefined): string {
  if (!cell) return "No ad account";
  return `${moneyText(cell.spent, "-")} / ${moneyText(cell.setAside, "-")} / ${moneyText(cell.limit)}`;
}

export const OFFBOARD_CHOICE_OPTIONS = [
  { value: "keep", label: "Keep the current limit on Meta (default)" },
  { value: "restore", label: "Put back the owner's old limit, where there was one" },
  { value: "remove", label: "Remove the limit" },
];

export const POT_NAMES: Record<string, string> = { ads: "Ads", messaging: "WhatsApp", ai: "AI credits" };

export const CANNOT_SEND_NOTE = "no WhatsApp token, cannot send";

/** An approved template offered for a number. variables 0 can be sent from the panel; anything else is listed but disabled. */
export type TestTemplateOption = { id: string; label: string; variables: number | null };
export type TestNumberOption = { id: string; label: string; templates: TestTemplateOption[] };

/**
 * Options for the test-message number picker: numbers that can send come first; the rest say so in their label. Each number carries
 * the approved templates of its workspace and WhatsApp Business Account (all of the workspace's when the number has no account id).
 */
export function testMessageNumbers(
  tenants: { id: string; name: string; phoneNumbers: { id: string; wabaRefId?: string; displayPhone: string; verifiedName: string | null }[] }[],
  sendable: Set<string>,
  templates: { id: string; tenantId: string; wabaRefId: string; name: string; language: string; variables: number | null }[] = [],
): TestNumberOption[] {
  return tenants
    .flatMap((t) =>
      t.phoneNumbers.map((p) => ({
        id: p.id,
        canSend: sendable.has(t.id),
        label: `${p.displayPhone}${p.verifiedName ? ` (${p.verifiedName})` : ""} - ${t.name}${sendable.has(t.id) ? "" : ` (${CANNOT_SEND_NOTE})`}`,
        templates: templates
          .filter((x) => x.tenantId === t.id && (!p.wabaRefId || x.wabaRefId === p.wabaRefId))
          .map((x) => ({ id: x.id, label: `${x.name} (${x.language})`, variables: x.variables })),
      })),
    )
    .sort((a, b) => Number(b.canSend) - Number(a.canSend))
    .map(({ id, label, templates }) => ({ id, label, templates }));
}

export const NO_TEMPLATES_NOTE = "No approved templates in this workspace yet";
/** The way out of an empty picker: sync templates in that workspace, or open the 24-hour window from the test phone. */
export const NO_TEMPLATES_HELP =
  "To get one listed, open that workspace's Templates page, choose Update from Meta, then reload this page. Or send any message from the test phone to this business number first; plain text then works for 24 hours.";
export const TEMPLATE_HINT = "Only templates approved for this number's WhatsApp account are listed. Templates with fill-in values are sent from that inbox; ones with a media or button value from Broadcasts.";
export const NONE_SENDABLE_NOTE = "None of these templates can be sent from here, since each needs a value. Use that workspace's inbox or Broadcasts, or send plain text.";
export const CHOOSE_TEMPLATE = "Choose a template";
export const NEEDS_VALUES_NOTE = "needs values, send it from the inbox";
export const NEEDS_BROADCAST_NOTE = "has a media or button value, send it from Broadcasts";

/** The <option> text for one template: variable-free ones are plain, the rest say why they are disabled and where to send them from. */
export function testTemplateLabel(t: TestTemplateOption): string {
  if (t.variables === 0) return t.label;
  return `${t.label} - ${t.variables === null ? NEEDS_BROADCAST_NOTE : NEEDS_VALUES_NOTE}`;
}

export type TestMessageOutcome = { tone: Tone; title: string; body: string; final: boolean };

/** How long a send may sit at queued before the panel calls it a worker problem (the worker polls every 2 s). */
export const QUEUED_WARN_AFTER_MS = 10_000;

/** The sentence under a failed test send: the inbox hint for a known code, otherwise the code itself with what to do with it. */
export function testFailureBody(errorCode: string | null | undefined): string {
  if (!errorCode) return "The message could not be delivered, and WhatsApp gave no error code. Copy the details below and share them with support.";
  const hint = failureHint(errorCode);
  return hint === UNKNOWN_FAILURE_HINT ? `WhatsApp returned error code ${errorCode}, which we do not have an explanation for yet. Copy the details below and share them with support.` : hint;
}

/**
 * What the panel says for the polled status of a test send. final is true once no further status update is expected. elapsedMs is how
 * long the panel has been polling; hint is the server's sentence for a failure, used over the local one when present.
 */
export function testMessageOutcome(status: string, errorCode: string | null | undefined, opts: { elapsedMs?: number; hint?: string | null } = {}): TestMessageOutcome {
  switch (status) {
    case "queued":
      return (opts.elapsedMs ?? 0) < QUEUED_WARN_AFTER_MS
        ? { tone: "info", title: "Queued for sending", body: "The background worker picks it up within a few seconds.", final: false }
        : { tone: "warn", title: "Still waiting for the worker to send it", body: "It has been queued for more than 10 seconds, which is unusual. Check the background jobs counters above.", final: false };
    case "sent":
      return { tone: "info", title: "WhatsApp accepted the message", body: "Delivery is confirmed by a status update, usually within seconds.", final: false };
    case "delivered":
      return { tone: "good", title: "Delivered to the phone", body: "WhatsApp confirmed the message reached the recipient's device.", final: true };
    case "read":
      return { tone: "good", title: "Delivered and read", body: "WhatsApp confirmed the recipient opened the message.", final: true };
    case "failed":
      return { tone: "bad", title: "Not delivered", body: opts.hint || testFailureBody(errorCode), final: true };
    default:
      return { tone: "neutral", title: humanize(status), body: "", final: false };
  }
}

export const NO_CONFIRMATION_YET = "No delivery confirmation yet. Open the chat in that workspace inbox to keep watching.";
export const POLL_FAILED = "The status could not be checked. Your admin session may have expired: reload this page and sign in again. The message itself was queued once and is not sent twice.";
