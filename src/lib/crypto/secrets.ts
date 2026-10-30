import { decrypt, encrypt, type EncryptedValue } from "./tokens";

/** Encrypts a secret for storage in a String column. Bound to the tenant, so a stored value cannot be moved to another workspace. */
export function sealSecret(tenantId: string, plaintext: string): string {
  return JSON.stringify(encrypt(plaintext, undefined, tenantId));
}

export function openSecret(tenantId: string, sealed: string): string {
  const value = JSON.parse(sealed) as EncryptedValue;
  return decrypt(value, undefined, tenantId);
}
