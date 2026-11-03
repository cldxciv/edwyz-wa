/**
 * Pure rules behind New project and the All projects cards. No database: the overview and the create service load the facts
 * and call these, so the page's "can I start a project?" answer and the server's refusal are the same function.
 *
 * Starting a project follows the signup rules (docs: the owner's 2026-10-31 default 5): a confirmed email address (when the
 * platform requires one, src/lib/auth/verification.ts), the signup rate limit per connection, and the signup name rule. On
 * top of that, because every project starts its own free trial: no new project while one of the person's projects is
 * suspended, at most MAX_OWNED_PROJECTS owned projects, and at most MAX_UNPAID_PROJECTS owned projects without a paid plan.
 * The state of the workspace the person is signed in to plays no part (POST /api/projects is exempt from its paywall): the new
 * project is a different workspace, and these facts are all the page and the server look at, so they always agree.
 */
import { HttpError } from "@/lib/tenancy";
import { NAME_REQUIRED, normalizeProjectName, projectNameProblem } from "./names";
import {
  MAX_OWNED_PROJECTS,
  MAX_UNPAID_PROJECTS,
  type NewProjectAccess,
  type ProjectBilling,
  type ProjectBillingState,
  type ProjectEndKind,
} from "./types";

const DAY_MS = 86_400_000;

export const PROJECT_COPY = {
  verify: "Confirm your email address before you start a new project. We sent you a link; check your inbox or ask for a new one from the banner at the top of the page.",
  suspended: "One of your projects is suspended, so you can't start a new one. Contact support to sort it out.",
  ownedCap: `You already own ${MAX_OWNED_PROJECTS} projects, the most one account can have. Delete one you no longer need, or contact support.`,
  unpaidCap: `You already have ${MAX_UNPAID_PROJECTS} projects without a paid plan. Choose a plan for one of them, or delete one you no longer need, then try again.`,
  perUserLimit: "You have started a lot of projects today. Try again tomorrow, or contact support.",
  perConnectionLimit: "Too many new projects or sign-ups from this connection. Wait an hour and try again, or contact support.",
  duplicate: (name: string) => `You already have a project called "${name}". Choose a different name.`,
} as const;

/** A refusal that belongs under one form field (the client shows it there instead of as a page error). */
export class ProjectFieldError extends HttpError {
  readonly field = "name" as const;
  constructor(status: number, message: string) {
    super(status, message);
  }
}

/** The project name from a request body, as it will be saved; throws ProjectFieldError(400) with the same words the form shows. */
export function projectNameFrom(body: Record<string, unknown>): string {
  const raw = body.name;
  const problem = projectNameProblem(raw);
  if (problem) throw new ProjectFieldError(400, problem);
  if (typeof raw !== "string") throw new ProjectFieldError(400, NAME_REQUIRED);
  return normalizeProjectName(raw);
}

/** Projects without a paid plan: on a free trial, or read-only after the trial or plan ended. */
export const isUnpaidState = (state: ProjectBillingState): boolean => state === "trialing" || state === "locked";

export type NewProjectFacts = {
  /** emailVerificationRequired() for this deployment. */
  verificationRequired: boolean;
  /** Null: not confirmed. Undefined: not loaded, treated as confirmed (the same as assertEmailVerifiedForWrite). */
  emailVerifiedAt: Date | null | undefined;
  /** The billing state of every live workspace the person owns. */
  ownedStates: readonly ProjectBillingState[];
};

export type ProjectRefusal = { status: number; message: string };

/** Why this person may not start a project now, in the order they would fix things, or null. */
export function newProjectRefusal(facts: NewProjectFacts): ProjectRefusal | null {
  if (facts.verificationRequired && facts.emailVerifiedAt === null) return { status: 403, message: PROJECT_COPY.verify };
  if (facts.ownedStates.includes("suspended")) return { status: 403, message: PROJECT_COPY.suspended };
  if (facts.ownedStates.length >= MAX_OWNED_PROJECTS) return { status: 409, message: PROJECT_COPY.ownedCap };
  if (facts.ownedStates.filter(isUnpaidState).length >= MAX_UNPAID_PROJECTS) return { status: 409, message: PROJECT_COPY.unpaidCap };
  return null;
}

export function newProjectAccess(facts: NewProjectFacts): NewProjectAccess {
  const refusal = newProjectRefusal(facts);
  return refusal ? { allowed: false, reason: refusal.message } : { allowed: true, reason: null };
}

/** What computeBillingStatus said, plus the subscription details a card needs for its date. */
export type BillingFacts = {
  state: ProjectBillingState;
  trialEndsAt: Date | null;
  daysLeftInTrial: number | null;
  planName: string | null;
  subscription: {
    status: "active" | "past_due" | "canceled" | "expired";
    currentPeriodEnd: Date | null;
    pastDueSince: Date | null;
    cancelAtPeriodEnd: boolean;
    /** Assigned by hand in the admin console: it does not renew by itself. */
    manual: boolean;
  } | null;
  graceDays: number;
};

const iso = (d: Date | null | undefined): string | null => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null);

/** The plan line of a project card: its state, the plan name and the one date that matters now. */
export function projectBilling(facts: BillingFacts): ProjectBilling {
  const sub = facts.subscription;
  const planName = sub ? facts.planName : null;
  const at = (endsAt: Date | null | undefined, endKind: ProjectEndKind): Pick<ProjectBilling, "endsAt" | "endKind"> => {
    const value = iso(endsAt);
    return value ? { endsAt: value, endKind } : { endsAt: null, endKind: null };
  };
  const graceEnd = sub?.pastDueSince ? new Date(sub.pastDueSince.getTime() + facts.graceDays * DAY_MS) : null;
  let when: Pick<ProjectBilling, "endsAt" | "endKind"> = { endsAt: null, endKind: null };
  switch (facts.state) {
    case "trialing":
      return { state: "trialing", planName: null, ...at(facts.trialEndsAt, "trial_ends"), daysLeftInTrial: facts.daysLeftInTrial };
    case "active": {
      if (sub?.currentPeriodEnd) {
        const live = sub.status === "active" || sub.status === "past_due";
        when = at(sub.currentPeriodEnd, !live || sub.manual || sub.cancelAtPeriodEnd ? "ends" : "renews");
      }
      break;
    }
    case "past_due_grace":
      when = at(graceEnd, "read_only_from");
      break;
    case "locked":
      if (sub?.status === "past_due" && graceEnd) when = at(graceEnd, "ended");
      else if (sub?.currentPeriodEnd) when = at(sub.currentPeriodEnd, "ended");
      else when = at(facts.trialEndsAt, "ended");
      break;
    default:
      break;
  }
  return { state: facts.state, planName, ...when, daysLeftInTrial: null };
}
