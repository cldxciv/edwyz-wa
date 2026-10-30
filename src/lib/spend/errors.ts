/**
 * Errors the Spend Book throws (docs/SPEND-CONTROLS-SPEC.md 4.3, 4.6, 4.7, 4.13). Each is an HttpError, so the existing
 * route helper errorResponse() already answers with the right status and the plain sentence; spendErrorResponse() in
 * http.ts adds the code and parameters for clients that show their own copy (the UI, Eddy).
 */
import { HttpError } from "@/lib/tenancy";
import { spendCopy, type CopyAmount, type SpendCopyCode, type SpendCopyParams } from "./copy";

/** HTTP status per refusal code: 409 unless the spec says otherwise (8.1: an admin raise is 403; 4.10: the AI hard stop is 402). */
export const SPEND_CODE_STATUS: Partial<Record<SpendCopyCode, number>> = {
  "spend.only_owner_raise": 403,
  ai_quota: 402,
  "spend.busy": 503,
};

/** Parameters as JSON can carry them: amounts become {minor: "123", currency}, dates ISO strings. */
export type SerializedCopyParams = Record<string, string | number | { minor: string; currency: string }>;

export function serializeCopyParams(params: SpendCopyParams): SerializedCopyParams {
  const out: SerializedCopyParams = {};
  for (const [key, value] of Object.entries(params) as [string, unknown][]) {
    if (value === undefined || value === null) continue;
    if (value instanceof Date) out[key] = value.toISOString();
    else if (typeof value === "object" && value && "minor" in value && "currency" in value) {
      const a = value as CopyAmount;
      out[key] = { minor: String(a.minor), currency: a.currency };
    } else if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return out;
}

/** A raise the book refused. The message is the 4.13 copy for the code; `params` let other surfaces render their own. */
export class SpendBlockedError extends HttpError {
  readonly code: SpendCopyCode;
  readonly params: SpendCopyParams;
  constructor(code: SpendCopyCode, params: SpendCopyParams = {}) {
    super(SPEND_CODE_STATUS[code] ?? 409, spendCopy(code, params));
    this.name = "SpendBlockedError";
    this.code = code;
    this.params = params;
  }
  toJSON() {
    return { error: this.message, code: this.code, params: serializeCopyParams(this.params) };
  }
}

/** The spend lock could not be taken in time (lock_timeout 3 s). Safe to retry. */
export class SpendBusyError extends HttpError {
  readonly code = "spend.busy" as const;
  constructor() {
    super(503, spendCopy("spend.busy"));
    this.name = "SpendBusyError";
  }
}

/** An assistant action that needs an approver: a SpendApproval was created in the same transaction (4.6 step 10). */
export class NeedsApprovalError extends HttpError {
  readonly code = "spend.needs_approval" as const;
  readonly approvalId: string;
  readonly expiresAt: Date | null;
  constructor(approvalId: string, expiresAt: Date | null = null, message = "This needs the owner's approval. We've asked them.") {
    super(202, message);
    this.name = "NeedsApprovalError";
    this.approvalId = approvalId;
    this.expiresAt = expiresAt;
  }
}

/** An assistant in its learning period: the action was recorded as what it would have done, and nothing ran (7.5). */
export class ShadowOnlyError extends HttpError {
  readonly code = "spend.shadow" as const;
  readonly shadowRecordId: string | null;
  constructor(shadowRecordId: string | null = null, message = "The assistant is still learning, so this was saved as a suggestion and nothing was changed.") {
    super(202, message);
    this.name = "ShadowOnlyError";
    this.shadowRecordId = shadowRecordId;
  }
}

/**
 * A raising Graph write reached the transport without a valid permit while SPEND_TRIPWIRE=enforce (4.7). Thrown before any
 * network I/O. The message never carries the token or the full path.
 */
export class SpendGuardBypassError extends HttpError {
  readonly code = "spend_bypass" as const;
  readonly reason: string;
  constructor(reason = "no_permit", message = "This change was stopped by a spending safety check, and nothing was sent to Meta. Try again from Edwyz.") {
    super(500, message);
    this.name = "SpendGuardBypassError";
    this.reason = reason;
  }
}

export type SpendError = SpendBlockedError | SpendBusyError | NeedsApprovalError | ShadowOnlyError | SpendGuardBypassError;

export function isSpendError(error: unknown): error is SpendError {
  return (
    error instanceof SpendBlockedError ||
    error instanceof SpendBusyError ||
    error instanceof NeedsApprovalError ||
    error instanceof ShadowOnlyError ||
    error instanceof SpendGuardBypassError
  );
}
