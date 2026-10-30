/**
 * HTTP helpers for the spend routes (/api/spend/*, the admin spending routes and Eddy's spend bridge).
 *
 * - spendErrorResponse() turns the book's errors into the JSON the UI and Eddy expect: the plain sentence (4.13) plus a code
 *   and parameters. Anything else falls back to the shared errorResponse(), so unexpected errors stay generic.
 * - Money goes out as decimal strings plus formatted text (3.1). spendJson() makes any bigint JSON-safe.
 * - parseLimitInput() reads a limit from a request body: a decimal string of minor units, a safe integer, or null for Not set.
 */
import { errorResponse, HttpError } from "@/lib/tenancy";
import { serializeCopyParams, NeedsApprovalError, ShadowOnlyError, SpendBlockedError, SpendBusyError, SpendGuardBypassError } from "./errors";
import { fitsStoredMinor, toMinor, toMoneyDTO, toMoneyDTOOrNull, type MinorInput, type MoneyDTO } from "./money";

export { toMoneyDTO as moneyDTO, toMoneyDTOOrNull as moneyDTOOrNull };
export type { MoneyDTO };

/** Recursively converts bigint to decimal strings and Dates to ISO strings, so Response.json never throws on a bigint. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

/** Response.json for spend payloads that may hold bigint. */
export function spendJson(data: unknown, init?: ResponseInit): Response {
  return Response.json(jsonSafe(data), init);
}

/** The JSON body of a spend refusal; `error` is the sentence to show. */
export type SpendErrorBody = { error: string; code: string; params?: Record<string, unknown>; approvalId?: string; expiresAt?: string | null };

/** Maps every spend error to its status and body. Non-spend errors go through errorResponse() unchanged. */
export function spendErrorResponse(error: unknown): Response {
  if (error instanceof SpendBlockedError) {
    return spendJson({ error: error.message, code: error.code, params: serializeCopyParams(error.params) } satisfies SpendErrorBody, { status: error.status });
  }
  if (error instanceof SpendBusyError) {
    return spendJson({ error: error.message, code: error.code } satisfies SpendErrorBody, { status: 503, headers: { "Retry-After": "2" } });
  }
  if (error instanceof NeedsApprovalError) {
    return spendJson(
      { error: error.message, code: error.code, approvalId: error.approvalId, expiresAt: error.expiresAt?.toISOString() ?? null } satisfies SpendErrorBody,
      { status: 202 },
    );
  }
  if (error instanceof ShadowOnlyError) {
    return spendJson({ error: error.message, code: error.code } satisfies SpendErrorBody, { status: 202 });
  }
  if (error instanceof SpendGuardBypassError) {
    // The reason is logged by the tripwire; the client only learns that nothing was sent.
    return spendJson({ error: error.message, code: error.code } satisfies SpendErrorBody, { status: 500 });
  }
  return errorResponse(error);
}

/**
 * A limit field from a request body. undefined = "leave unchanged", null or "" = "Not set". Otherwise a positive whole number
 * of minor units as a decimal string or a safe integer. Throws HttpError(400) with a plain sentence for anything else.
 */
export function parseLimitInput(value: unknown, field = "limit"): bigint | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  // Digits only up to 30 (as toMinor reads them), checked against BIGINT here so an over-long number is a 400, not a 500.
  if (typeof value === "string" && /^\d{1,30}$/.test(value.trim()) && !fitsStoredMinor(BigInt(value.trim()))) {
    throw new HttpError(400, `That ${field} is too large. Enter a smaller amount, or leave it empty for Not set.`);
  }
  let minor: bigint;
  try {
    if (typeof value !== "string" && typeof value !== "number") throw new RangeError("type");
    minor = toMinor(value as MinorInput);
  } catch {
    throw new HttpError(400, `Enter the ${field} as a whole number, or leave it empty for Not set.`);
  }
  if (minor <= 0n) throw new HttpError(400, `Enter a ${field} above zero, or leave it empty for Not set.`);
  return minor;
}

/** The pot's period figures as DTO money, keeping null "left" as null ("Not set"). */
export function periodDTO(
  figures: { spent: bigint; committed: bigint; held: bigint; left: bigint | null },
  currency: string,
): { spent: MoneyDTO; committed: MoneyDTO; held: MoneyDTO; left: MoneyDTO | null } {
  return {
    spent: toMoneyDTO(figures.spent, currency),
    committed: toMoneyDTO(figures.committed, currency),
    held: toMoneyDTO(figures.held, currency),
    left: toMoneyDTOOrNull(figures.left, currency),
  };
}
