import { CART_LIFETIME_MS, DEFAULT_GAPS_MIN, MAX_GAP_MIN, MAX_REMINDERS } from "@/lib/commerce/schedule";

export type Tone = "neutral" | "good" | "warn" | "bad" | "info";

export const REMINDERS = MAX_REMINDERS;
export const LIFETIME_DAYS = CART_LIFETIME_MS / 86_400_000;
export { DEFAULT_GAPS_MIN, MAX_GAP_MIN };

export type Stage = "cart" | "checkout";

export const WEBHOOKS = [
  { event: "Checkout creation", topic: "checkouts/create", why: "Tells us a shopper started checking out." },
  { event: "Checkout update", topic: "checkouts/update", why: "Keeps the phone number and cart total up to date." },
  { event: "Order creation", topic: "orders/create", why: "Tells us the shopper bought, so we stop the reminders." },
] as const;

export function friendlyError(e: unknown, fallback = "Something went wrong. Try again."): string {
  const message = e instanceof Error ? e.message.trim() : "";
  if (!message) return fallback;
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) return "We could not reach the server. Check your connection and try again.";
  return message;
}

export const maskPhone = (p: string | null) => (p ? `${p.slice(0, 4)}${"*".repeat(Math.max(p.length - 7, 2))}${p.slice(-3)}` : "Not shared");

export function money(minor: number | null, currency: string | null): string {
  if (minor === null) return "Not shown";
  return `${currency ?? ""} ${(minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** 90 becomes "1 hour 30 minutes". At most two units are shown. */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0 minutes";
  const total = Math.round(minutes);
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  return [d ? plural(d, "day") : "", h ? plural(h, "hour") : "", m ? plural(m, "minute") : ""].filter(Boolean).slice(0, 2).join(" ");
}

const ORDINAL = ["first", "second", "third"];

export type ScheduleRow = { number: number; ordinal: string; gap: number; total: number; gapLabel: string; totalLabel: string; late: boolean };

/**
 * The server counts the first gap from the shopper's last action and each later gap from the moment the previous reminder was due,
 * so the real time for reminder 3 is the sum of all three gaps. Reminders due after the cart's lifetime are never sent.
 */
export function scheduleRows(gaps: number[]): ScheduleRow[] {
  let total = 0;
  return gaps.slice(0, REMINDERS).map((gap, i) => {
    const safe = Number.isFinite(gap) && gap > 0 ? gap : 0;
    total += safe;
    return {
      number: i + 1,
      ordinal: ORDINAL[i] ?? `${i + 1}th`,
      gap: safe,
      total,
      gapLabel: i === 0 ? `${formatMinutes(safe)} after` : `${formatMinutes(safe)} later`,
      totalLabel: `${formatMinutes(total)} after`,
      late: total * 60_000 > CART_LIFETIME_MS,
    };
  });
}

export function parseGap(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

/** One message per bad gap index, matching the server rule: whole minutes from 1 to 4320. */
export function gapErrors(gaps: number[]): (string | null)[] {
  return gaps.map((g) => {
    if (!Number.isInteger(g) || g < 1) return "Enter at least 1 minute.";
    if (g > MAX_GAP_MIN) return `Enter ${MAX_GAP_MIN.toLocaleString()} minutes (3 days) or less.`;
    return null;
  });
}

export function lateReminders(gaps: number[]): number[] {
  return scheduleRows(gaps).filter((r) => r.late).map((r) => r.number);
}

/* ---------- Connecting a store ---------- */

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const ADMIN_LINK = /^(?:https?:\/\/)?admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]{0,60})(?:[/?#]|$)/;

/** Accepts what people actually paste (a full address, with or without https and a path) and returns the plain domain, or null. */
export function parseShopDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  const admin = ADMIN_LINK.exec(value);
  if (admin) value = `${admin[1]}.myshopify.com`;
  value = value.replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  return SHOP_DOMAIN.test(value) ? value : null;
}

export function shopDomainError(input: string): string | null {
  if (!input.trim()) return "Enter your store address.";
  return parseShopDomain(input) ? null : "Use the address that ends in .myshopify.com, for example my-store.myshopify.com.";
}

export function secretError(input: string): string | null {
  const v = input.trim();
  if (!v) return "Paste the signing secret from Shopify.";
  if (/\s/.test(v)) return "The secret has no spaces. Copy it again from Shopify.";
  if (v.length < 8) return "That looks too short to be the signing secret. Copy it again from Shopify.";
  if (v.length > 300) return "That is too long to be the signing secret. Copy only the secret.";
  return null;
}

/** Same shape the server accepts for an Admin API access token (letters, numbers, dashes and underscores, no spaces). */
export function accessTokenError(input: string): string | null {
  const v = input.trim();
  if (!v) return "Paste the Admin API access token from Shopify.";
  if (/\s/.test(v)) return "The token has no spaces. Copy it again from Shopify.";
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(v)) return "That does not look like an Admin API access token. Copy it again from your custom app in Shopify.";
  return null;
}

/** True when the server refused a store change only because it holds no usable access token for the store. */
export const needsAccessToken = (e: unknown) => e instanceof Error && /Admin API access token/i.test(e.message);

export type StoreLike = { status: string; verified?: boolean };
export type StoreView = { tone: Tone; label: string; detail: string; pending: boolean };

export function storeView(store: StoreLike): StoreView {
  if (store.status === "disabled") return { tone: "neutral", label: "Paused", detail: "No reminders are sent while the store is paused.", pending: false };
  if (store.verified || store.status === "active") return { tone: "good", label: "Verified", detail: "Shopify is sending us checkout and order updates.", pending: false };
  return { tone: "warn", label: "Waiting for Shopify", detail: "We have not been able to confirm this store with Shopify yet.", pending: true };
}

/** The sentence a screen reader hears when a store's status changes while the page is open. */
export function storeAnnouncement(domain: string, view: StoreView): string {
  if (view.pending) return `${domain} is waiting for Shopify to confirm the connection`;
  return `${domain} is ${view.label.toLowerCase()}`;
}

export type CartView = { tone: Tone; label: string; hint: string };

export function cartStatusView(status: string): CartView {
  switch (status) {
    case "open":
      return { tone: "info", label: "Open", hint: "Still could be recovered." };
    case "recovered":
      return { tone: "good", label: "Recovered", hint: "The shopper bought after a reminder." };
    case "replied":
      return { tone: "neutral", label: "Replied", hint: "The shopper wrote back, so reminders stopped." };
    case "opted_out":
      return { tone: "neutral", label: "Not opted in", hint: "This customer has not agreed to WhatsApp messages." };
    case "expired":
      return { tone: "neutral", label: "Expired", hint: `Not recovered within ${LIFETIME_DAYS} days.` };
    default:
      return { tone: "neutral", label: status ? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ") : "Unknown", hint: "" };
  }
}

export const CART_STATUS_FILTERS = ["open", "recovered", "replied", "opted_out", "expired"] as const;

export function stageLabel(stage: string): string {
  if (stage === "cart") return "Added to cart";
  if (stage === "checkout") return "Started checkout";
  return stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : "Unknown";
}
