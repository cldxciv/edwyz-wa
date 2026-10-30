import { HttpError } from "@/lib/tenancy";

export const API_SCOPES = [
  "messages:write",
  "contacts:read",
  "contacts:write",
  "templates:read",
  "conversations:read",
  "conversations:write",
  "broadcasts:read",
  "webhooks:manage",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/**
 * A scope that lets a key change something also lets it read the same thing, and a key that may send templates may list them.
 * The map lists, for each scope, the other scopes that satisfy it.
 */
const SATISFIED_BY: Partial<Record<ApiScope, readonly ApiScope[]>> = {
  "contacts:read": ["contacts:write"],
  "conversations:read": ["conversations:write"],
  "templates:read": ["messages:write"],
};

/** Every scope that opens an endpoint declared with these scopes: the declared ones plus the ones that satisfy them. */
export function acceptedScopes(required: ApiScope | readonly ApiScope[]): ApiScope[] {
  const declared = typeof required === "string" ? [required] : [...required];
  const out = new Set<ApiScope>(declared);
  for (const scope of declared) for (const other of SATISFIED_BY[scope] ?? []) out.add(other);
  return [...out];
}

export function holdsScope(held: readonly string[], required: ApiScope | readonly ApiScope[]): boolean {
  return acceptedScopes(required).some((scope) => held.includes(scope));
}

/** The one 403 sentence every API surface uses when a key lacks a scope. */
export function missingScopeMessage(required: ApiScope | readonly ApiScope[]): string {
  const accepted = acceptedScopes(required);
  return accepted.length === 1 ? `This API key needs the ${accepted[0]} scope.` : `This API key needs one of these scopes: ${accepted.join(", ")}.`;
}

export function assertScope(held: readonly string[], required: ApiScope | readonly ApiScope[]): void {
  if (!holdsScope(held, required)) throw new HttpError(403, missingScopeMessage(required));
}
