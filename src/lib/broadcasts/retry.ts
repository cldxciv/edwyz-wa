const DAY_MS = 24 * 60 * 60 * 1000;

/** Meta's per-user marketing message limit. No other error is ever retried. */
export const RETRYABLE_ERROR_CODE = "131049";

export const isRetryableCode = (code: string | null | undefined) => (code ?? "").trim() === RETRYABLE_ERROR_CODE;

/** The retry window runs for retryDays from the moment the broadcast started. */
export function retryWindowEnd(startedAt: Date | null | undefined, retryDays: number, now = new Date()): Date {
  return new Date((startedAt ?? now).getTime() + retryDays * DAY_MS);
}

export type RetryPlan = { attempts: number; retryAfter: Date | null };

/**
 * attempts counts failures caused by the cap. A retry is scheduled for the next day only while
 * attempts stay within retryDays and the retry time falls inside the window.
 */
export function planRetry(input: {
  errorCode: string | null | undefined;
  attempts: number;
  retryDays: number;
  startedAt: Date | null | undefined;
  now?: Date;
}): RetryPlan | null {
  if (!isRetryableCode(input.errorCode)) return null;
  const now = input.now ?? new Date();
  const attempts = input.attempts + 1;
  if (input.retryDays <= 0 || attempts > input.retryDays) return { attempts, retryAfter: null };
  const retryAfter = new Date(now.getTime() + DAY_MS);
  const end = retryWindowEnd(input.startedAt, input.retryDays, now);
  return { attempts, retryAfter: retryAfter.getTime() <= end.getTime() ? retryAfter : null };
}

export type RetryContext = { attempts: number; retryDays: number; startedAt: Date | null };

/** Recipient columns for a failed send, with retry bookkeeping only for the retryable code. */
export function failedRecipientData(errorCode: string, ctx: RetryContext | undefined, now = new Date()): Record<string, unknown> {
  const base = { status: "failed", errorCode };
  const plan = ctx ? planRetry({ errorCode, attempts: ctx.attempts, retryDays: ctx.retryDays, startedAt: ctx.startedAt, now }) : null;
  return plan ? { ...base, attempts: plan.attempts, retryAfter: plan.retryAfter } : base;
}

export const retryWindowOpen = (startedAt: Date | null | undefined, retryDays: number, now: Date) =>
  retryDays > 0 && now.getTime() <= retryWindowEnd(startedAt, retryDays, now).getTime();
