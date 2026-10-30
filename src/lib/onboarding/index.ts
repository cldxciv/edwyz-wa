import { sanitizeMessage } from "@/lib/safe-error";
import { randomInt } from "node:crypto";
import { prisma } from "@/lib/db";
import { storeAccessToken, storeRegistrationPin } from "@/lib/crypto/tokens";
import { appGraphFetch, graphFetch, GraphError } from "@/lib/graph";
import { normalizeTier } from "@/lib/messaging-limit";
import { HttpError } from "@/lib/tenancy";
import { clearWhatsAppAuthRejected, latestTokenRow, pruneOlderTokens } from "./token-health";

export const STEPS = ["exchange_code", "verify_ids", "subscribe_app", "register_number", "fetch_details", "mark_live"] as const;
export type StepName = (typeof STEPS)[number];
export type StepStatus = "pending" | "started" | "done" | "failed";
export type StepState = { step: StepName; status: StepStatus };

export type OnboardingInput = {
  tenantId: string;
  code: string;
  wabaId: string;
  phoneNumberId: string;
  redirectUri?: string;
  /** Coexistence onboarding (FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING): the number is already live in the WhatsApp Business app, so register is skipped. */
  skipRegistration?: boolean;
};

export type OnboardingResult = {
  ok: boolean;
  steps: StepState[];
  failedStep?: StepName;
  error?: string;
  /** True when this WABA and number were already connected: the run only replaced the token and refreshed details. */
  reauthorized?: boolean;
};

const ID_PATTERN = /^\d{5,30}$/;
export const isMetaId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);

/** A fresh 6-digit two-step verification PIN, leading zeros kept. */
export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

const refOf = (input: Pick<OnboardingInput, "wabaId" | "phoneNumberId">) => `${input.wabaId}:${input.phoneNumberId}`;

function safeDetail(ref: string, error?: unknown) {
  if (!error) return { ref };
  if (error instanceof GraphError) return { ref, error: sanitizeMessage(error.message), code: error.code ?? null, subcode: error.subcode ?? null, httpStatus: error.status };
  return { ref, error: error instanceof Error ? sanitizeMessage(error.message) : "Unknown error" };
}

async function log(tenantId: string, step: StepName, status: "started" | "done" | "failed", detail: object) {
  await prisma.onboardingLog.create({ data: { tenantId, step, status, detail } });
}

async function isDone(tenantId: string, step: StepName, ref: string): Promise<boolean> {
  const rows = await prisma.onboardingLog.findMany({ where: { tenantId, step, status: "done" }, orderBy: { createdAt: "desc" }, take: 20 });
  return rows.some((row) => (row.detail as { ref?: string } | null)?.ref === ref);
}

type Ctx = OnboardingInput & { ref: string; tokenId?: string };
type StepFn = (ctx: Ctx) => Promise<object | void>;

const exchangeCode: StepFn = async (ctx) => {
  const { tenantId, code, redirectUri } = ctx;
  const query: Record<string, string> = { code };
  if (redirectUri) query.redirect_uri = redirectUri;
  const res = await appGraphFetch<{ access_token?: string; expires_in?: number }>({ path: "oauth/access_token", query });
  if (!res?.access_token) throw new Error("Meta did not return an access token");
  const expiresAt = res.expires_in ? new Date(Date.now() + res.expires_in * 1000) : null;
  ctx.tokenId = await storeAccessToken(tenantId, null, res.access_token, expiresAt);
  // The rejected flag is cleared only once the new token has passed verify_ids (see runSteps), never before.
  return { expiresAt: expiresAt ? expiresAt.toISOString() : null };
};

/** The ids come from the browser, so confirm with the business token that the number belongs to the WABA before storing anything. */
const verifyIds: StepFn = async ({ tenantId, wabaId, phoneNumberId }) => {
  const res = await graphFetch<{ data?: { id?: string }[] }>({ tenantId, path: `${wabaId}/phone_numbers`, query: { fields: "id", limit: "100" } });
  if (!res?.data?.some((p) => p.id === phoneNumberId)) throw new Error("The phone number does not belong to this WhatsApp Business Account");
};

const subscribeApp: StepFn = async ({ tenantId, wabaId }) => {
  await graphFetch({ tenantId, path: `${wabaId}/subscribed_apps`, method: "POST" });
};

async function isAlreadyRegistered(tenantId: string, phoneNumberId: string): Promise<boolean> {
  try {
    const res = await graphFetch<{ status?: string }>({ tenantId, path: phoneNumberId, query: { fields: "status" } });
    return res?.status === "CONNECTED";
  } catch {
    return false;
  }
}

const registerNumber: StepFn = async ({ tenantId, phoneNumberId, skipRegistration }) => {
  if (skipRegistration) return { skipped: "coexistence" };
  const pin = generatePin();
  const pinRowId = await storeRegistrationPin(tenantId, phoneNumberId, pin);
  try {
    await graphFetch({ tenantId, path: `${phoneNumberId}/register`, method: "POST", body: { messaging_product: "whatsapp", pin } });
  } catch (e) {
    if (!(e instanceof GraphError) || !(await isAlreadyRegistered(tenantId, phoneNumberId))) throw e;
    await prisma.accessToken.deleteMany({ where: { id: pinRowId, tenantId } });
    return { alreadyRegistered: true };
  }
};

type PhoneDetails = {
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  messaging_limit_tier?: string;
  name_status?: string;
};

/**
 * Meta now applies the messaging limit to the whole business portfolio and reports it on the WhatsApp Business Account
 * (whatsapp_business_manager_messaging_limit). When that is readable, it is stored; any
 * failure falls back to the number's tier, because setup must never fail over an informational field.
 */
async function portfolioTier(tenantId: string, wabaId: string, own: string | null): Promise<string | null> {
  try {
    const waba = await graphFetch<{ whatsapp_business_manager_messaging_limit?: string }>({ tenantId, path: wabaId, query: { fields: "whatsapp_business_manager_messaging_limit" } });
    // The portfolio value is Meta's current limit for the whole portfolio, so it wins when readable (a downgrade must not be masked by
    // the number's own older tier). The number's own tier is only the fallback.
    return normalizeTier(waba.whatsapp_business_manager_messaging_limit) ?? own;
  } catch {
    return own;
  }
}

const fetchDetails: StepFn = async ({ tenantId, wabaId, phoneNumberId }) => {
  const d = await graphFetch<PhoneDetails>({
    tenantId,
    path: phoneNumberId,
    query: { fields: "display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status" },
  });
  const fields = {
    displayPhone: d.display_phone_number ?? phoneNumberId,
    verifiedName: d.verified_name ?? null,
    qualityRating: d.quality_rating ?? null,
    messagingLimitTier: await portfolioTier(tenantId, wabaId, normalizeTier(d.messaging_limit_tier)),
    nameStatus: d.name_status ?? null,
    status: "connected",
    registeredAt: new Date(),
  };
  // The ownership check and both upserts run in one transaction under an advisory lock on the number, so two workspaces cannot race for it.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wa-number:${phoneNumberId}`}))`;
    await assertNotOwnedByOthers({ tenantId, wabaId, phoneNumberId }, tx);
    const waba = await tx.waba.upsert({ where: { wabaId }, create: { tenantId, wabaId }, update: {} });
    await tx.phoneNumber.upsert({
      where: { phoneNumberId },
      create: { tenantId, wabaRefId: waba.id, phoneNumberId, ...fields },
      update: { ...fields, wabaRefId: waba.id },
    });
  });
};

const markLive: StepFn = async ({ tenantId }) => {
  await prisma.tenant.update({ where: { id: tenantId }, data: { onboardingStatus: "live" } });
};

const HANDLERS: Record<StepName, StepFn> = {
  exchange_code: exchangeCode,
  verify_ids: verifyIds,
  subscribe_app: subscribeApp,
  register_number: registerNumber,
  fetch_details: fetchDetails,
  mark_live: markLive,
};

/** Rejects ids already connected to a different tenant, so one tenant cannot claim another's WABA or number. */
async function assertNotOwnedByOthers(
  input: Pick<OnboardingInput, "tenantId" | "wabaId" | "phoneNumberId">,
  db: Pick<typeof prisma, "waba" | "phoneNumber"> = prisma,
) {
  const [waba, phone] = await Promise.all([
    db.waba.findUnique({ where: { wabaId: input.wabaId }, select: { tenantId: true } }),
    db.phoneNumber.findUnique({ where: { phoneNumberId: input.phoneNumberId }, select: { tenantId: true } }),
  ]);
  if ((waba && waba.tenantId !== input.tenantId) || (phone && phone.tenantId !== input.tenantId)) {
    throw new HttpError(409, "This WhatsApp account is already connected to another workspace.");
  }
}

/**
 * Steps that must not run twice for the same WABA and number. Registering again would replace the two-step verification PIN, so
 * it is skipped once done. Every other step runs on each attempt: every attempt carries a fresh authorization code, so the code
 * exchange has to store the new token (this is what makes reconnecting work after a token expires), and the token-dependent checks
 * and the details refresh are cheap and prove the new token works.
 */
const RUN_ONCE: readonly StepName[] = ["register_number"];

/** Runs the steps in order. A failed run resumes at register_number if that was already done; see RUN_ONCE. */
export async function runOnboarding(input: OnboardingInput): Promise<OnboardingResult> {
  if (!isMetaId(input.wabaId) || !isMetaId(input.phoneNumberId)) throw new HttpError(400, "Invalid WhatsApp account details.");
  await assertNotOwnedByOthers(input);
  const release = await acquireRunLock(input.tenantId);
  try {
    return await runSteps(input);
  } finally {
    await release();
  }
}

const LOCK_STALE_MS = 5 * 60_000;

/** One onboarding run per tenant at a time (a PlatformSetting row is the lock; a stale lock expires after 5 minutes). */
async function acquireRunLock(tenantId: string): Promise<() => Promise<void>> {
  const key = `onboarding-lock:${tenantId}`;
  await prisma.platformSetting.deleteMany({ where: { key, updatedAt: { lt: new Date(Date.now() - LOCK_STALE_MS) } } });
  try {
    await prisma.platformSetting.create({ data: { key, value: {} } });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") throw new HttpError(409, "A connection attempt is already running. Wait a minute and try again.");
    throw e;
  }
  return async () => void (await prisma.platformSetting.deleteMany({ where: { key } }).catch(() => undefined));
}

async function runSteps(input: OnboardingInput): Promise<OnboardingResult> {
  const ctx: Ctx = { ...input, ref: refOf(input) };
  const reauthorized = await isDone(input.tenantId, "mark_live", ctx.ref);
  // Any token already stored. If the new one fails a step it is deleted so this one (or none) stays in charge, as before the attempt.
  const hadToken = (await latestTokenRow(input.tenantId).catch(() => null)) !== null;
  await prisma.tenant.update({ where: { id: input.tenantId }, data: { onboardingStatus: "in_progress" } });

  for (const step of STEPS) {
    if (RUN_ONCE.includes(step) && (await isDone(input.tenantId, step, ctx.ref))) continue;
    await log(input.tenantId, step, "started", { ref: ctx.ref });
    try {
      const extra = await HANDLERS[step](ctx);
      await log(input.tenantId, step, "done", { ref: ctx.ref, ...(extra ?? {}) });
      // The new token is proven by the first call made with it. Only now is a rejection recorded against the old token forgotten.
      if (step === "verify_ids") await clearWhatsAppAuthRejected(input.tenantId);
    } catch (e) {
      await log(input.tenantId, step, "failed", safeDetail(ctx.ref, e));
      await prisma.tenant.update({ where: { id: input.tenantId }, data: { onboardingStatus: "failed" } });
      // A token that failed verification must not shadow a working one: getAccessToken always picks the newest row.
      if (ctx.tokenId && hadToken) await discardNewToken(input.tenantId, ctx.tokenId);
      if (reauthorized) await restoreLive(input.tenantId);
      return { ok: false, steps: await getStepStates(input.tenantId), failedStep: step, error: failureMessage(e), reauthorized };
    }
  }
  if (ctx.tokenId) await pruneOlderTokens(input.tenantId, ctx.tokenId).catch(() => undefined);
  return { ok: true, steps: await getStepStates(input.tenantId), reauthorized };
}

/** Removes the token stored by a run that then failed, so the previous token (if any) is the newest again. */
async function discardNewToken(tenantId: string, tokenId: string) {
  await prisma.accessToken.deleteMany({ where: { id: tokenId, tenantId } }).catch(() => undefined);
}

/** A failed re-authorisation must not take a working connection offline: the old connection is exactly as usable as before the attempt. */
async function restoreLive(tenantId: string) {
  await prisma.tenant.update({ where: { id: tenantId }, data: { onboardingStatus: "live" } }).catch(() => undefined);
}

function failureMessage(e: unknown): string {
  const retry = "You can retry and it will continue from this step.";
  if (e instanceof GraphError) return `Meta said: ${sanitizeMessage(e.message)} ${retry}`;
  return `This step failed. ${retry}`;
}

/** Latest status of each step for the tenant, derived from the log. */
export function summarizeSteps(rows: { step: string; status: string }[]): StepState[] {
  return STEPS.map((step) => {
    const latest = rows.find((r) => r.step === step);
    return { step, status: (latest?.status as StepStatus | undefined) ?? "pending" };
  });
}

export async function getStepStates(tenantId: string): Promise<StepState[]> {
  const rows = await prisma.onboardingLog.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 100 });
  return summarizeSteps(rows);
}
