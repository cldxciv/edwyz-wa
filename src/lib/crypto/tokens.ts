import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";

export const KEY_VERSION = 1;
export const PIN_REF_PREFIX = "pin:";

export type EncryptedValue = { ciphertext: string; iv: string; authTag: string; keyVersion: number };

function loadKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return key;
}

/** keyVersion 1: no AAD (legacy rows). keyVersion 2: the AAD (tenant id) is authenticated, so a row cannot be moved to another tenant. */
export const KEY_VERSION_AAD = 2;
const TAG_LENGTH = 16;

export function encrypt(plaintext: string, key: Buffer = loadKey(), aad?: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: aad !== undefined ? KEY_VERSION_AAD : KEY_VERSION,
  };
}

export function decrypt(
  value: Pick<EncryptedValue, "ciphertext" | "iv" | "authTag"> & { keyVersion?: number },
  key: Buffer = loadKey(),
  aad?: string,
): string {
  try {
    const tag = Buffer.from(value.authTag, "base64");
    if (tag.length !== TAG_LENGTH) throw new Error("bad tag length");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"), { authTagLength: TAG_LENGTH });
    if (value.keyVersion === KEY_VERSION_AAD) {
      if (aad === undefined) throw new Error("missing aad");
      decipher.setAAD(Buffer.from(aad, "utf8"));
    }
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Could not decrypt stored value (wrong key or tampered data)");
  }
}

export async function storeAccessToken(tenantId: string, wabaRefId: string | null, token: string, expiresAt?: Date | null) {
  const enc = encrypt(token, undefined, tenantId);
  const row = await prisma.accessToken.create({
    data: {
      tenantId,
      wabaRefId,
      tokenCiphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      keyVersion: enc.keyVersion,
      expiresAt: expiresAt ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * No usable business token: never connected, or every stored token has passed its expiry. Reconnecting WhatsApp fixes it.
 * An HttpError so routes answer 409 with this explanation instead of a generic 500 that hides the reason.
 */
export class NoValidTokenError extends HttpError {
  constructor() {
    super(409, "WhatsApp is not connected (no valid access token). Connect or reconnect WhatsApp in Settings, then try again.");
  }
}

export async function getAccessToken(tenantId: string): Promise<string> {
  const row = await prisma.accessToken.findFirst({
    where: {
      tenantId,
      OR: [{ wabaRefId: null }, { NOT: { wabaRefId: { startsWith: PIN_REF_PREFIX } } }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
    },
    orderBy: { createdAt: "desc" },
  });
  if (!row) throw new NoValidTokenError();
  return decrypt({ ciphertext: row.tokenCiphertext, iv: row.iv, authTag: row.authTag, keyVersion: row.keyVersion }, undefined, tenantId);
}

/** The 2-step verification PIN is kept as an encrypted AccessToken row tagged `pin:<phoneNumberId>` and is excluded from getAccessToken. */
export async function storeRegistrationPin(tenantId: string, phoneNumberId: string, pin: string) {
  return storeAccessToken(tenantId, `${PIN_REF_PREFIX}${phoneNumberId}`, pin, new Date(0));
}
