import { HttpError } from "@/lib/tenancy";

/**
 * Email verification policy. A user who has not confirmed their email address can look around (every read works) and change
 * settings, but cannot send messages, run campaigns, import data, create API keys or connect Meta until the address is confirmed.
 * EMAIL_VERIFICATION_REQUIRED=true or false forces the gate on or off; when unset it is on only if SMTP_USER is set (mail can be delivered).
 */
export const UNVERIFIED_MESSAGE = "Confirm your email address to do this. We sent you a link; check your inbox or ask for a new one from the banner at the top of the page.";

export function emailVerificationRequired(): boolean {
  const v = (process.env.EMAIL_VERIFICATION_REQUIRED ?? "").trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(v)) return false;
  if (["true", "1", "yes", "on"].includes(v)) return true;
  // Unset: only require it when mail can actually be delivered, otherwise nobody could ever confirm and everyone would be stuck read-only.
  return Boolean(process.env.SMTP_USER);
}

/** Writes an unverified user may still make: account, billing and settings screens. Everything else needs a confirmed address. */
const UNVERIFIED_WRITE_PREFIXES = [
  "/api/auth/",
  "/api/billing/",
  "/api/setup/",
  "/api/routing/",
  "/api/quick-replies",
  "/api/inbox/settings",
  "/api/inbox/filters",
  "/api/automation/settings",
  "/api/account/",
];

/** Marking a conversation as read changes nothing for the customer, so it stays allowed. */
const UNVERIFIED_WRITE_PATTERNS = [
  // Workspace settings, but not invites, members or ownership: an unverified signup must not be able to send platform mail to
  // other people (invites) or hand the workspace to someone else.
  /^\/api\/workspace\/(?!invites(\/|$)|members(\/|$)|ownership(\/|$))/,
  // PATCH /api/workspace only renames the workspace.
  /^\/api\/workspace$/,
  /^\/api\/inbox\/conversations\/[^/]+\/(read|marks)$/,
  // Team settings only. Putting a chat in a team or changing a contact's owner acts on customers' data, so it needs a confirmed address.
  /^\/api\/teams$/,
  /^\/api\/teams\/(?!assign$)[^/]+(\/members)?$/,
  // Eddy (docs/EDDY-SPEC.md 5.11 critic): an unverified member can chat, set their own Eddy preferences and delete their own
  // Eddy history. Every write Eddy would make for them is still refused by gate G7 on its concrete action path. Switching
  // Eddy on (PUT /api/eddy/settings) is NOT here: it sends workspace data to Anthropic and starts AI spend, so it keeps the
  // verified-email rule, like invites.
  /^\/api\/eddy\/turn$/,
  /^\/api\/eddy\/prefs$/,
  /^\/api\/eddy\/conversations(\/[A-Za-z0-9_-]{1,64})?$/,
];

export function unverifiedMayWrite(pathname: string): boolean {
  return UNVERIFIED_WRITE_PREFIXES.some((p) => pathname.startsWith(p)) || UNVERIFIED_WRITE_PATTERNS.some((re) => re.test(pathname));
}

/**
 * Throws 403 for a write by a user whose address is not confirmed. `emailVerifiedAt` of undefined means the caller did not load
 * it, which is treated as unknown and allowed; only an explicit null blocks.
 */
export function assertEmailVerifiedForWrite(emailVerifiedAt: Date | null | undefined, pathname: string): void {
  if (emailVerifiedAt !== null || !emailVerificationRequired()) return;
  if (unverifiedMayWrite(pathname)) return;
  throw new HttpError(403, UNVERIFIED_MESSAGE);
}
