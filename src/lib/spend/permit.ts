/**
 * Permits (docs/SPEND-CONTROLS-SPEC.md 4.6, 4.7, 4.9, 5.5). A permit is the Spend Book's proof that a raising Meta call or a
 * WhatsApp send was checked. The transport tripwire refuses a raising Graph write that runs without one.
 *
 * Bypass rule B8: only book.ts, commitments.ts, messaging/gate.ts, metacap/client.ts and tripwire.ts import this module.
 * A permit exists only through mintPermit(): the type is branded, and every minted object is registered in a WeakSet, so an
 * object literal shaped like a permit is still refused at run time. Minted permits are frozen; uses are counted here.
 * Times (issuedAt, expiresAt, each object's endsAt) are kept as numbers and read through getters that return a new Date, and
 * usePermit() checks the expiry recorded at mint, so no holder can extend a permit by mutating a Date (12.1c R6).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { SpendGuardBypassError } from "./errors";
import type { MintedFor, PermitData, SpendPermit } from "./types";

const MINTED = new WeakSet<object>();
const USES = new WeakMap<object, number>();
/** The expiry of each minted permit in epoch ms. usePermit() reads this, never the permit's own fields. */
const EXPIRES = new WeakMap<object, number>();

/** The permit the current async context runs under (graph run() reads it). */
export const permitStore = new AsyncLocalStorage<SpendPermit>();

/** Freezes own data properties all the way down. Accessor properties (the date getters below) are left as they are. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) if ("value" in d) deepFreeze(d.value);
    Object.freeze(value);
  }
  return value;
}

/**
 * A Date cannot be frozen (setTime still works on a frozen Date). So a permit keeps each time as epoch ms in a closure and
 * exposes it through a read-only getter that returns a NEW Date on every read: mutating what a reader got changes nothing.
 */
function defineDate(target: Record<string, unknown>, key: string, ms: number): void {
  Object.defineProperty(target, key, { enumerable: true, configurable: false, get: () => new Date(ms) });
}

function validTime(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function cloneData<D extends PermitData>(data: D): D {
  const { issuedAt, expiresAt, ...rest } = data;
  const copy: Record<string, unknown> = { ...rest, paths: [...data.paths] };
  defineDate(copy, "issuedAt", issuedAt.getTime());
  defineDate(copy, "expiresAt", expiresAt.getTime());
  if (data.type === "ads") {
    copy.objects = Object.fromEntries(
      Object.entries(data.objects).map(([id, o]) => {
        const { endsAt, ...fields } = o;
        const entry: Record<string, unknown> = { ...fields };
        if (endsAt !== undefined) defineDate(entry, "endsAt", endsAt.getTime());
        return [id, entry];
      }),
    );
  }
  if (data.type === "lowering") copy.metaObjectIds = [...data.metaObjectIds];
  return copy as D;
}

/** Validates and mints a permit. Throws (no permit) when any field is missing or already expired. */
export function mintPermit<D extends PermitData>(data: D): MintedFor<D> {
  const invalid = (why: string): never => {
    throw new SpendGuardBypassError(`invalid_permit:${why}`);
  };
  if (!data || typeof data !== "object") invalid("shape");
  if (!data.tenantId) invalid("tenant");
  if (!data.correlationId) invalid("correlation");
  if (!Array.isArray(data.paths) || data.paths.length === 0 || data.paths.some((p) => typeof p !== "string" || p.length === 0)) invalid("paths");
  if (!Number.isInteger(data.maxUses) || data.maxUses < 1) invalid("max_uses");
  if (!(data.expiresAt instanceof Date) || Number.isNaN(data.expiresAt.getTime())) invalid("expiry");
  if (!(data.issuedAt instanceof Date) || Number.isNaN(data.issuedAt.getTime())) invalid("issued");
  if (data.expiresAt.getTime() <= data.issuedAt.getTime()) invalid("expiry");
  if (data.type === "ads" && Object.keys(data.objects).length === 0) invalid("objects");
  if (data.type === "ads" && Object.values(data.objects).some((o) => o.endsAt !== undefined && !validTime(o.endsAt))) invalid("ends_at");
  if (data.type === "lowering" && data.metaObjectIds.length === 0) invalid("objects");
  const permit = deepFreeze(cloneData(data));
  MINTED.add(permit);
  USES.set(permit, 0);
  EXPIRES.set(permit, data.expiresAt.getTime());
  return permit as unknown as MintedFor<D>;
}

/** True only for objects mintPermit() returned. */
export function isMintedPermit(value: unknown): value is SpendPermit {
  return typeof value === "object" && value !== null && MINTED.has(value);
}

export function permitUses(permit: SpendPermit): number {
  return USES.get(permit) ?? 0;
}

export type PermitUseResult = { ok: true; remaining: number } | { ok: false; reason: "not_minted" | "expired" | "used_up" };

/** Counts one use if the permit is minted, unexpired and has uses left. The tripwire calls this once per Graph request. */
export function usePermit(permit: unknown, now: Date = new Date()): PermitUseResult {
  if (!isMintedPermit(permit)) return { ok: false, reason: "not_minted" };
  const expiresAt = EXPIRES.get(permit);
  if (expiresAt === undefined || expiresAt <= now.getTime()) return { ok: false, reason: "expired" };
  const used = USES.get(permit) ?? 0;
  if (used >= permit.maxUses) return { ok: false, reason: "used_up" };
  USES.set(permit, used + 1);
  return { ok: true, remaining: permit.maxUses - used - 1 };
}

/** The permit of the current async context, if any. */
export function currentPermit(): SpendPermit | undefined {
  return permitStore.getStore();
}

/** Runs `fn` with the permit in the async context. Refuses anything that was not minted. */
export function runWithPermit<T>(permit: SpendPermit, fn: () => T): T {
  if (!isMintedPermit(permit)) throw new SpendGuardBypassError("not_minted");
  return permitStore.run(permit, fn);
}
