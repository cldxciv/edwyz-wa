import { createHash, createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { createState, verifyState } from "@/lib/oauth-state";
import { HttpError } from "@/lib/tenancy";

const MAX_AGE_MS = 10 * 60_000;
const MIN_SECRET_LENGTH = 32;

type Flavor = { prefix: string; label: string; hashed?: boolean };

/** Meta Connect (Pages, Instagram, ads). */
const CONNECT: Flavor = { prefix: "meta-connect-state:", label: "meta-connect-state-v1" };
/** WhatsApp Embedded Signup. Its own prefix and label, so a state minted for Connect never verifies for signup and the other way round. */
const SIGNUP: Flavor = { prefix: "wa-signup-state:", label: "wa-signup-state-v1", hashed: true };

/** The root key is derived from STATE_SECRET with a domain label, so STATE_SECRET itself never signs a state: a state minted for another feature from the same secret does not verify here. */
function rootKey(flavor: Flavor): Buffer {
  const base = process.env.STATE_SECRET;
  if (!base) throw new HttpError(503, "Meta connection is not configured yet.");
  if (process.env.NODE_ENV === "production" && base.length < MIN_SECRET_LENGTH) throw new HttpError(503, "Meta connection is not configured yet.");
  return createHmac("sha256", base).update(flavor.label).digest();
}

/** The row key: the nonce, or its SHA-256 for the signup flavor so a database read never shows a nonce. */
const rowKey = (flavor: Flavor, nonce: string) => `${flavor.prefix}${flavor.hashed ? createHash("sha256").update(nonce).digest("hex") : nonce}`;

function secretFor(flavor: Flavor, tenantId: string, userId: string): string {
  return createHmac("sha256", rootKey(flavor)).update(`${tenantId}\n${userId}`).digest("hex");
}

/**
 * A signed state whose signing key is derived from the tenant and user, so it only verifies for the same session. The nonce is stored
 * (PlatformSetting row, so it works with one pm2 instance and survives a restart) to make it single use; expired rows are swept on issue.
 */
async function issue(flavor: Flavor, tenantId: string, userId: string): Promise<string> {
  const state = createState(secretFor(flavor, tenantId, userId));
  const nonce = state.split(".")[0];
  await prisma.platformSetting.deleteMany({ where: { key: { startsWith: flavor.prefix }, updatedAt: { lt: new Date(Date.now() - MAX_AGE_MS) } } });
  await prisma.platformSetting.create({ data: { key: rowKey(flavor, nonce), value: { tenantId, userId } } });
  return state;
}

/** Verifies the signature, tenant, user and age, then deletes the nonce row: a second use finds nothing and is refused. */
async function consume(flavor: Flavor, tenantId: string, userId: string, state: string | null | undefined, message: string): Promise<void> {
  const bad = new HttpError(400, message);
  if (!state || state.length > 200 || !verifyState(state, secretFor(flavor, tenantId, userId), Date.now(), MAX_AGE_MS)) throw bad;
  const used = await prisma.platformSetting.deleteMany({ where: { key: rowKey(flavor, state.split(".")[0]) } });
  if (used.count !== 1) throw bad;
}

const EXPIRED = "This connection attempt has expired. Please start again.";

export const issueState = (tenantId: string, userId: string) => issue(CONNECT, tenantId, userId);
export const consumeState = (tenantId: string, userId: string, state: string | null | undefined) => consume(CONNECT, tenantId, userId, state, EXPIRED);

/** WhatsApp Embedded Signup state: bound to the workspace and user, single use, valid for 10 minutes. */
export const issueSignupState = (tenantId: string, userId: string) => issue(SIGNUP, tenantId, userId);
export const consumeSignupState = (tenantId: string, userId: string, state: string | null | undefined) => consume(SIGNUP, tenantId, userId, state, EXPIRED);
