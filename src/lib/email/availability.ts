import { COMPANY } from "@/lib/config";

/**
 * Whether outgoing email can be delivered at all. sendEmail() drops every message when SMTP_USER is unset, so a screen
 * that promises "we sent you a link" must check this first instead of letting the person wait for mail that never comes.
 */
export function emailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.SMTP_USER);
}

export const RESET_EMAIL_UNAVAILABLE = `Password reset by email is not available yet. Write to ${COMPANY.email} from the email address on your account and we will help you sign in again.`;

export const VERIFY_EMAIL_UNAVAILABLE = `Email is not set up on this server yet, so we cannot send a confirmation link. Write to ${COMPANY.email} and we will confirm your address for you.`;
