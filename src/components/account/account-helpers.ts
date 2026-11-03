/** Same limits as src/lib/auth/password.ts (which uses node:crypto, so it cannot load in the browser). A test keeps them equal. */
export const MIN_NEW_PASSWORD = 10;
export const MAX_NEW_PASSWORD = 200;
export const MAX_NAME = 100;

/** The error under a name field, or null. `what` is "your name" or "a name for the workspace". */
export function nameError(value: string, what: "your name" | "a name for the workspace"): string | null {
  const v = value.trim();
  if (!v) return `Enter ${what}.`;
  return v.length > MAX_NAME ? `Use ${MAX_NAME} characters or fewer.` : null;
}

export type PasswordForm = { current: string; next: string; confirm: string };
export type PasswordErrors = Record<keyof PasswordForm, string | null>;

/** POST /api/account/password's refusal of a wrong current password (403), shown under that field. */
export const WRONG_CURRENT_PASSWORD = "That is not your current password. Check it and try again.";
/** The same words in the page's own check and in the server's refusal (400). */
export const SAME_PASSWORD = "Choose a password that is different from your current one.";

/** The `field` POST /api/account/password names in a refusal the page shows under one field instead of as a toast. */
export type PasswordField = "currentPassword" | "newPassword";

/** One error per field of the change-password form, worded as the fix. */
export function passwordErrors(f: PasswordForm): PasswordErrors {
  let next: string | null = null;
  if (f.next.length < MIN_NEW_PASSWORD) next = `Use at least ${MIN_NEW_PASSWORD} characters.`;
  else if (f.next.length > MAX_NEW_PASSWORD) next = `Use ${MAX_NEW_PASSWORD} characters or fewer.`;
  else if (f.current && f.next === f.current) next = SAME_PASSWORD;
  return {
    current: f.current ? null : "Enter your current password.",
    next,
    confirm: f.confirm === f.next ? null : "The two new passwords do not match. Type the new password again.",
  };
}

export const hasErrors = (errors: Record<string, string | null>) => Object.values(errors).some(Boolean);

const FORM_FIELD: Record<PasswordField, keyof PasswordForm> = { currentPassword: "current", newPassword: "next" };

/**
 * Where a refused password change belongs: under the form field the server named (a wrong current password, a new password it will
 * not take), since the person must fix it before trying again. Null for anything else (offline, too many attempts), which is a toast.
 * `err` is what apiFetch threw: the server's text is the message and its JSON is on `body`.
 */
export function passwordRefusal(err: unknown): { field: keyof PasswordForm; message: string } | null {
  if (!(err instanceof Error) || !err.message) return null;
  const field = (err as Error & { body?: { field?: unknown } }).body?.field;
  return field === "currentPassword" || field === "newPassword" ? { field: FORM_FIELD[field], message: err.message } : null;
}

/** What the workspace card says to someone who cannot rename it. */
export const RENAME_OWNER_ONLY = "Only an owner can rename the workspace.";

/** The toast after a password change: what happened to the other devices. */
export const PASSWORD_CHANGED = "Password changed. You were signed out on your other devices; this one stays signed in.";
