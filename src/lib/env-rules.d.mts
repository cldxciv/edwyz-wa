export type EnvReport = { errors: string[]; warnings: string[]; disabled: string[] };
export function checkEnv(env?: Record<string, string | undefined>): EnvReport;
export function decodedSecretBytes(value: string): number;
export const EDDY_SUPPORTED_MODELS: readonly string[];
/** The price fields every EDDY_PRICES model needs (USD per million tokens). */
export const EDDY_PRICE_FIELDS: readonly string[];
/** Why an EDDY_PRICES override would be ignored, or null when it parses. Never echoes the value. */
export function eddyPricesProblem(raw: string | null | undefined): string | null;
/** The Android package used when ANDROID_PACKAGE is unset. */
export const DEFAULT_ANDROID_PACKAGE: string;
/** ANDROID_PACKAGE trimmed, the default when unset, or null when the value set is not an Android package name. */
export function androidPackage(env?: Record<string, string | undefined>): string | null;
/** Valid (upper-cased, de-duplicated, no placeholders) SHA-256 fingerprints from a comma-separated list, and how many were ignored. */
export function assetLinkFingerprints(raw: string | null | undefined): { valid: string[]; invalid: number };
