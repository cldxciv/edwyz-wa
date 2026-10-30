import { prisma } from "@/lib/db";
import { COMPANY } from "@/lib/config";

/** Platform configuration a super admin can change without a deploy. Anything not set falls back to these defaults. */
export type PlatformSettings = {
  trialDays: number;
  /** Days a failed payment keeps working before the workspace is locked. */
  graceDays: number;
  /** GST rate in basis points (1800 = 18%). */
  gstRateBps: number;
  invoicePrefix: string;
  /** Seller details printed on invoices. The owner must fill in the GSTIN. */
  sellerLegalName: string;
  sellerGstin: string;
  sellerAddress: string;
  sellerStateCode: string;
  supportEmail: string;
};

export const DEFAULT_SETTINGS: PlatformSettings = {
  trialDays: 7,
  graceDays: 3,
  gstRateBps: 1800,
  invoicePrefix: "EDW",
  sellerLegalName: COMPANY.legalName,
  sellerGstin: "",
  sellerAddress: COMPANY.address,
  sellerStateCode: "",
  supportEmail: COMPANY.email,
};

const KEY = "settings";

export async function getSettings(): Promise<PlatformSettings> {
  const row = await prisma.platformSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<PlatformSettings> | null) ?? {}) };
}

export async function updateSettings(patch: Partial<PlatformSettings>): Promise<PlatformSettings> {
  const next = { ...(await getSettings()), ...patch };
  await prisma.platformSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: next }, update: { value: next } });
  return next;
}
