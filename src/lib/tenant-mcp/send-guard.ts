import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";

export const CONFIRM_TOKEN_TTL_MS = 5 * 60_000;
export const DEFAULT_SENDS_PER_KEY_HOUR = 20;
export const DEFAULT_SENDS_PER_RECIPIENT_DAY = 3;
export const SEND_LEDGER_PREFIX = "mcp-send:";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const LEDGER_KEEP_MS = DAY_MS + HOUR_MS;
const CLEANUP_EVERY_MS = 10 * 60_000;

const usedTokens = new Map<string, number>();
const reservations = new Map<string, number[]>();
let lastCleanup = 0;

export function resetSendGuards() {
  usedTokens.clear();
  reservations.clear();
  lastCleanup = 0;
}

function secret(): string {
  const s = process.env.MCP_CONFIRM_SECRET || process.env.STATE_SECRET;
  if (!s) throw new HttpError(409, "Sending through MCP is not configured on this server. Nothing was sent.");
  return s;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sign(tenantId: string, keyId: string, tool: string, args: Record<string, unknown>, expiresAt: number): string {
  return createHmac("sha256", secret()).update(`mcp-confirm\n${tenantId}\n${keyId}\n${tool}\n${expiresAt}\n${canonical(args)}`).digest("base64url");
}

/** Short-lived token the draft step returns. It only matches the same API key (by id), tool and (normalised) arguments. */
export function issueConfirmToken(tenantId: string, keyId: string, tool: string, args: Record<string, unknown>, now = Date.now()): { token: string; expiresInSeconds: number } {
  const expiresAt = now + CONFIRM_TOKEN_TTL_MS;
  return { token: `${expiresAt}.${sign(tenantId, keyId, tool, args, expiresAt)}`, expiresInSeconds: CONFIRM_TOKEN_TTL_MS / 1000 };
}

const REFUSED = "A valid confirmToken is required. Call the tool without confirm, show the draft to the user, then call again with confirm: true and the confirmToken from the draft. Nothing was sent.";
const REPLAYED = "That confirmToken was already used. Request a new draft. Nothing was sent.";

/** Throws unless the token was issued by a draft for exactly these arguments, for this key, and is unexpired and unused. It does not mark the token used: claimSend does. */
export function verifyConfirmToken(tenantId: string, keyId: string, tool: string, args: Record<string, unknown>, token: unknown, now = Date.now()): string {
  if (typeof token !== "string" || token.length > 200) throw new HttpError(400, REFUSED);
  const [rawExpiry, mac] = token.split(".");
  const expiresAt = Number(rawExpiry);
  if (!mac || !Number.isInteger(expiresAt)) throw new HttpError(400, REFUSED);
  if (expiresAt < now) throw new HttpError(400, "The confirmToken has expired. Request a new draft and confirm it again. Nothing was sent.");
  const expected = Buffer.from(sign(tenantId, keyId, tool, args, expiresAt));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new HttpError(400, "The confirmToken does not match these arguments. Request a new draft for the exact content to send. Nothing was sent.");
  }
  if (usedTokens.has(token)) throw new HttpError(400, REPLAYED);
  return token;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = Number(raw);
  return raw?.trim() && Number.isInteger(n) && n >= 0 ? n : fallback;
}

export const sendsPerKeyHour = () => envInt("MCP_MAX_SENDS_PER_KEY_HOUR", DEFAULT_SENDS_PER_KEY_HOUR);
export const sendsPerRecipientDay = () => envInt("MCP_MAX_SENDS_PER_RECIPIENT_DAY", DEFAULT_SENDS_PER_RECIPIENT_DAY);

/** Takes a slot if the window has room; returns the timestamp to hand back to giveBack, or null when full. */
function take(key: string, windowMs: number, max: number, now: number): number | null {
  const recent = (reservations.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    reservations.set(key, recent);
    return null;
  }
  recent.push(now);
  reservations.set(key, recent);
  if (reservations.size > 20_000) reservations.clear();
  return now;
}

function giveBack(key: string, at: number | null) {
  const recent = at === null ? undefined : reservations.get(key);
  const i = recent && at !== null ? recent.indexOf(at) : -1;
  if (recent && i >= 0) recent.splice(i, 1);
}

const keyLimitMessage = (max: number) => `This API key reached its limit of ${max} confirmed sends per hour. Nothing was sent.`;
const recipientLimitMessage = (max: number) => `This contact already received ${max} messages through MCP in the last 24 hours. Nothing was sent.`;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 32);
const ledgerScope = (tenantId: string) => `${SEND_LEDGER_PREFIX}${tenantId}:`;

const countLedger = (filter: { startsWith: string; contains?: string }, since: Date) => prisma.platformSetting.count({ where: { key: filter, updatedAt: { gte: since } } });

async function cleanupLedger(tenantId: string, now: number) {
  if (now - lastCleanup < CLEANUP_EVERY_MS) return;
  lastCleanup = now;
  try {
    await prisma.platformSetting.deleteMany({ where: { key: { startsWith: ledgerScope(tenantId) }, updatedAt: { lt: new Date(now - LEDGER_KEEP_MS) } } });
  } catch {
    // old rows are harmless; the next sweep retries
  }
}

export type SendClaim = {
  /** Call when the send did not happen: frees the token and the cap slots again. */
  release: () => Promise<void>;
};

/**
 * Everything between a verified token and the send, ordered to close the races:
 * 1. synchronously (no await since the token was verified): mark the token used and take the in-process key and recipient slots,
 *    so parallel calls with the same token, or past a cap, are refused before any of them reaches the network;
 * 2. then the durable checks: the ledger of earlier confirmed sends (survives a restart and a second instance) and an atomic insert
 *    of this send keyed by the token, which a replay on another instance cannot repeat.
 * The ledger rows are the durable record the caps count, so a failed audit write cannot make the caps undercount.
 */
export async function claimSend(tenantId: string, keyId: string, tool: string, args: Record<string, unknown>, token: unknown, contactId: string, now = Date.now()): Promise<SendClaim> {
  const checked = verifyConfirmToken(tenantId, keyId, tool, args, token, now);
  const keyMax = sendsPerKeyHour();
  const recipientMax = sendsPerRecipientDay();
  for (const [t, exp] of usedTokens) if (exp < now) usedTokens.delete(t);
  usedTokens.set(checked, now + CONFIRM_TOKEN_TTL_MS);

  const keySlot = `k:${tenantId}:${keyId}`;
  const recipientSlot = `r:${tenantId}:${contactId}`;
  const keyAt = take(keySlot, HOUR_MS, keyMax, now);
  const recipientAt = keyAt === null ? null : take(recipientSlot, DAY_MS, recipientMax, now);
  const ledgerKey = `${ledgerScope(tenantId)}${keyId}:${contactId}:${hashToken(checked)}`;
  let inserted = false;

  const undo = async (keepToken: boolean) => {
    if (!keepToken) usedTokens.delete(checked);
    giveBack(keySlot, keyAt);
    giveBack(recipientSlot, recipientAt);
    if (inserted) await prisma.platformSetting.deleteMany({ where: { key: ledgerKey } }).catch(() => undefined);
  };

  try {
    if (keyAt === null) throw new HttpError(429, keyLimitMessage(keyMax));
    if (recipientAt === null) throw new HttpError(429, recipientLimitMessage(recipientMax));
    const [byKey, byRecipient] = await Promise.all([
      countLedger({ startsWith: `${ledgerScope(tenantId)}${keyId}:` }, new Date(now - HOUR_MS)),
      countLedger({ startsWith: ledgerScope(tenantId), contains: `:${contactId}:` }, new Date(now - DAY_MS)),
    ]);
    if (byKey >= keyMax) throw new HttpError(429, keyLimitMessage(keyMax));
    if (byRecipient >= recipientMax) throw new HttpError(429, recipientLimitMessage(recipientMax));
    try {
      await prisma.platformSetting.create({ data: { key: ledgerKey, value: { tool, at: new Date(now).toISOString() } } });
      inserted = true;
    } catch (e) {
      if ((e as { code?: string } | null)?.code === "P2002") {
        await undo(true);
        throw new HttpError(400, REPLAYED);
      }
      throw e;
    }
  } catch (e) {
    if (!(e instanceof HttpError && e.message === REPLAYED)) await undo(false);
    throw e;
  }
  void cleanupLedger(tenantId, now);
  return { release: () => undo(false) };
}

const isHidden = (c: number) =>
  c <= 8 ||
  (c >= 0x0b && c <= 0x1f) ||
  (c >= 0x7f && c <= 0x9f) ||
  c === 0xad ||
  c === 0x061c ||
  c === 0x180e ||
  (c >= 0x200b && c <= 0x200f) ||
  (c >= 0x2028 && c <= 0x202e) ||
  (c >= 0x2060 && c <= 0x206f) ||
  c === 0xfeff ||
  (c >= 0xfff9 && c <= 0xfffb) ||
  (c >= 0xe0000 && c <= 0xe007f) ||
  (c >= 0xe0100 && c <= 0xe01ef);
const stripHidden = (text: string) => [...text].filter((ch) => !isHidden(ch.codePointAt(0) as number)).join("");
const LOOKALIKE_OPEN = /[＜〈〈﹤‹❬⟨]/g;
const LOOKALIKE_CLOSE = /[＞〉〉﹥›❭⟩]/g;
const OWN_TAG = /<\/?\s*untrusted_customer_text[^>]*>/gi;

function stripOwnTags(text: string): string {
  let current = text;
  for (let i = 0; i < 5; i++) {
    const next = current.replace(OWN_TAG, "");
    if (next === current) return next;
    current = next;
  }
  return current.replace(/</g, "");
}

/** Customer-written text returned to the MCP client: control and invisible characters stripped, look-alike brackets normalised, wrapped in explicit untrusted delimiters. */
export function untrustedCustomerText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const plain = stripHidden(text).replace(LOOKALIKE_OPEN, "<").replace(LOOKALIKE_CLOSE, ">");
  return `<untrusted_customer_text>${stripOwnTags(plain)}</untrusted_customer_text>`;
}
