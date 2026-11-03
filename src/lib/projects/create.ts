/**
 * POST /api/projects: start a new project, which is a new workspace owned by the person, with its own free trial, exactly as
 * signup creates one (src/app/api/auth/signup/route.ts): a unique web address part (slug) from the name, an owner membership,
 * then startTrial with the platform's trial length. The person stays signed in where they are; the page then switches to the
 * new workspace through the existing POST /api/auth/switch-workspace.
 *
 * Rules (src/lib/projects/rules.ts): the signup rate limit for the connection plus NEW_PROJECTS_PER_DAY per person, a
 * confirmed email address when the platform requires one, no suspended project, at most MAX_OWNED_PROJECTS owned and at most
 * MAX_UNPAID_PROJECTS owned without a paid plan, and a name the person does not already use for another project.
 *
 * Order, so a refusal costs nothing and parallel requests cannot slip past the caps:
 * 1. the read-only checks (email, suspension, caps, name), outside any transaction;
 * 2. the rate limits, only for an attempt that passed them, so a refused attempt never uses up the connection's or the
 *    person's allowance (the limiters keep their own rows, so they run before the transaction rather than inside it, where
 *    they would wait for a second pooled connection while holding the first);
 * 3. one transaction under a per-person advisory lock: the caps, the suspension rule and the name are read again with the
 *    transaction, then the workspace and the owner membership are created. A second request waits for the first to commit and
 *    then counts its project.
 */
import { randomBytes } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/auth/audit";
import { slugify } from "@/lib/auth/http";
import { checkSignupLimit } from "@/lib/auth/ratelimit";
import { emailVerificationRequired } from "@/lib/auth/verification";
import { startTrial } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { getSettings } from "@/lib/platform-settings";
import { createLimiter } from "@/lib/ratelimit";
import { HttpError, type Actor } from "@/lib/tenancy";
import { billingFactsOf, PROJECT_TENANT_SELECT } from "./billing";
import { sameProjectName } from "./names";
import { newProjectRefusal, PROJECT_COPY, ProjectFieldError } from "./rules";
import { MAX_OWNED_PROJECTS, MAX_PROJECTS_LISTED, NEW_PROJECTS_PER_DAY, type CreatedProject } from "./types";

const DAY_MS = 86_400_000;
const perPerson = createLimiter(NEW_PROJECTS_PER_DAY, DAY_MS, "projects-create-user");

/**
 * The most workspace names read for "you already have a project called ...": every owned project plus far more memberships
 * than the All projects page lists. The names are compared here, not in SQL: Prisma's case-insensitive `equals` becomes ILIKE
 * on Postgres, where `_`, `%` and `\` in a name act as pattern characters.
 */
export const NAME_CHECK_LIMIT = 200 + MAX_PROJECTS_LISTED;

/** The advisory lock key that serialises one person's project starts. */
export const createLockKey = (userId: string): string => `projects-create:${userId}`;

/** The signup limit for this connection (shared with signup, so one address cannot dodge it), then the per-person limit. */
export async function checkNewProjectLimits(userId: string, ip: string): Promise<void> {
  try {
    await checkSignupLimit(ip);
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) throw new HttpError(429, PROJECT_COPY.perConnectionLimit);
    throw error;
  }
  if (!(await perPerson.consumeShared(userId))) throw new HttpError(429, PROJECT_COPY.perUserLimit);
}

/** Test hook. */
export async function resetNewProjectLimits(): Promise<void> {
  await perPerson.clear();
}

type Tx = Pick<Prisma.TransactionClient, "tenant">;
type MembershipDb = Pick<Prisma.TransactionClient, "membership">;

/** Same scheme as signup: the slug of the name, then a short random suffix if it is taken. */
export async function uniqueSlug(tx: Tx, name: string): Promise<string> {
  const base = slugify(name) || "workspace";
  for (let i = 0; i < 5; i++) {
    const candidate = i === 0 ? base : `${base}-${randomBytes(2).toString("hex")}`;
    if (!(await tx.tenant.findUnique({ where: { slug: candidate }, select: { id: true } }))) return candidate;
  }
  return `${base}-${randomBytes(6).toString("hex")}`;
}

/** The person-level facts read once per request: they do not change between the first check and the locked one. */
export type CreateFacts = { verificationRequired: boolean; emailVerifiedAt: Date | null; graceDays: number };

/** Whether one of the person's live workspaces already has this name (any case, any spacing). */
export async function projectNameInUse(db: MembershipDb, userId: string, name: string): Promise<boolean> {
  const rows = await db.membership.findMany({
    where: { userId, tenant: { deletedAt: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: NAME_CHECK_LIMIT,
    select: { tenant: { select: { name: true } } },
  });
  return rows.some((m) => sameProjectName(m.tenant.name, name));
}

/** The caps, the suspension rule and the name rule, read with `db` (the transaction on the locked pass). Throws the refusal. */
async function assertRules(db: MembershipDb, userId: string, name: string, facts: CreateFacts, now: Date): Promise<void> {
  const owned = await db.membership.findMany({
    where: { userId, role: "owner", tenant: { deletedAt: null } },
    take: MAX_OWNED_PROJECTS + 1,
    select: { tenant: { select: PROJECT_TENANT_SELECT } },
  });
  const refusal = newProjectRefusal({
    verificationRequired: facts.verificationRequired,
    emailVerifiedAt: facts.emailVerifiedAt,
    ownedStates: owned.map((m) => billingFactsOf(m.tenant, facts.graceDays, now).state),
  });
  if (refusal) throw new HttpError(refusal.status, refusal.message);
  if (await projectNameInUse(db, userId, name)) throw new ProjectFieldError(409, PROJECT_COPY.duplicate(name));
}

/** Throws the HttpError the page shows when this person may not start a project called `name` now. Reads only. */
export async function assertMayCreateProject(userId: string, name: string): Promise<CreateFacts> {
  const [user, settings] = await Promise.all([prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } }), getSettings()]);
  if (!user) throw new HttpError(401, "Not signed in.");
  const facts: CreateFacts = { verificationRequired: emailVerificationRequired(), emailVerifiedAt: user.emailVerifiedAt, graceDays: settings.graceDays };
  await assertRules(prisma, userId, name, facts, new Date());
  return facts;
}

/** Creates the workspace and the owner membership in one locked transaction, then starts the trial and writes the audit line. */
export async function createProject(actor: Actor, name: string, ip: string): Promise<CreatedProject> {
  const facts = await assertMayCreateProject(actor.userId, name);
  await checkNewProjectLimits(actor.userId, ip);

  const project = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${createLockKey(actor.userId)}))`;
    // Again under the lock: a request that ran beside this one has committed its project by now and is counted.
    await assertRules(tx, actor.userId, name, facts, new Date());
    const tenant = await tx.tenant.create({ data: { name, slug: await uniqueSlug(tx, name) }, select: { id: true, name: true, slug: true } });
    await tx.membership.create({ data: { tenantId: tenant.id, userId: actor.userId, role: "owner" } });
    return tenant;
  });

  // As signup: a failure here leaves the workspace without a trial date, which support can set; it must not undo the create.
  await startTrial(project.id).catch((error) => log.error("projects.trial_failed", { err: error, tenantId: project.id }));
  await audit({ tenantId: project.id, userId: actor.userId, action: "workspace.created", target: project.id, meta: { from: actor.tenantId } });
  return { project };
}
