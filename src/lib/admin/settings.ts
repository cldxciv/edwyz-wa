import { audit } from "@/lib/auth/audit";
import { getSettings, type PlatformSettings, updateSettings } from "@/lib/platform-settings";
import { HttpError } from "@/lib/tenancy";
import { int, str } from "./http";

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "18" or "12.5" percent to basis points without float maths. */
export function percentToBps(input: unknown): number {
  const text = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : "";
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(text);
  const bps = m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0) : NaN;
  if (!Number.isInteger(bps) || bps > 4000) throw new HttpError(400, "GST rate must be a percentage between 0 and 40.");
  return bps;
}

export function parseSettings(body: Record<string, unknown>): PlatformSettings {
  const gstin = str(body, "sellerGstin", "GSTIN", 15, false).toUpperCase();
  if (gstin && !GSTIN.test(gstin)) throw new HttpError(400, "GSTIN format is not valid (15 characters, for example 22AAAAA0000A1Z5).");
  const prefix = str(body, "invoicePrefix", "Invoice prefix", 8).toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(prefix)) throw new HttpError(400, "Invoice prefix must be 2 to 8 letters or digits.");
  const stateCode = str(body, "sellerStateCode", "State code", 2, false);
  if (stateCode && !/^\d{2}$/.test(stateCode)) throw new HttpError(400, "State code must be two digits.");
  const supportEmail = str(body, "supportEmail", "Support email", 200);
  if (!EMAIL.test(supportEmail)) throw new HttpError(400, "Support email is not valid.");
  return {
    trialDays: int(body, "trialDays", "Trial days", 0, 365),
    graceDays: int(body, "graceDays", "Grace days", 0, 60),
    gstRateBps: percentToBps(body.gstRatePercent),
    invoicePrefix: prefix,
    sellerLegalName: str(body, "sellerLegalName", "Seller legal name", 200),
    sellerGstin: gstin,
    sellerAddress: str(body, "sellerAddress", "Seller address", 500),
    sellerStateCode: stateCode,
    supportEmail,
  };
}

export async function saveSettings(adminUserId: string, body: Record<string, unknown>) {
  const next = parseSettings(body);
  const before = await getSettings();
  const changed = (Object.keys(next) as (keyof PlatformSettings)[]).filter((k) => next[k] !== before[k]);
  const saved = await updateSettings(next);
  await audit({ userId: adminUserId, action: "admin.settings.update", meta: { changed: changed.join(",") } });
  return saved;
}
