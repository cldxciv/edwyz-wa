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
/** The goal keys PROMOTE_GOALS may list (docs/IG-PAGE-ADS-SPEC.md 4.4); equal to PROMOTE_GOAL_KEYS in src/lib/promote/flags.ts. */
export const PROMOTE_GOAL_KEYS: readonly string[];
/** The page languages PROMOTE_PAGE_LANGS may list. */
export const PROMOTE_PAGE_LANG_VALUES: readonly string[];
/** The single-value promote flags and the values each accepts. */
export const PROMOTE_FLAG_VALUES: Readonly<Record<string, readonly string[]>>;
/** The comma-list promote flags and the items each may hold. */
export const PROMOTE_LIST_VALUES: Readonly<Record<string, readonly string[]>>;
/** True for an http or https address on 127.0.0.1, localhost or [::1], with no user, password, query or fragment. */
export function isLoopbackGraphBaseUrl(raw: string | null | undefined): boolean;
/** GRAPH_BASE_URL (the fake Meta server for tests) when it may be used: outside production and on a loopback address; else null. */
export function testGraphBaseUrl(env?: Record<string, string | undefined>): string | null;
/** The on|off switches of Studio, Canva and Meta's ads MCP (all off by default; ADS-MCP-CANVA-CREATIVE-SPEC 5.8). */
export const STUDIO_FLAG_VALUES: Readonly<Record<"STUDIO_ENABLED" | "CANVA_VIDEO" | "META_ADS_MCP" | "META_ADS_MCP_RULES", readonly string[]>>;
/** Whole-number Studio and ads MCP settings: [min, max, default]. */
export const STUDIO_NUMBERS: Readonly<Record<"STUDIO_DAILY_RENDERS" | "META_ADS_MCP_DAILY_CALLS", readonly [number, number, number]>>;
/** The values CREATIVE_IMAGE_PROVIDER accepts. */
export const CREATIVE_IMAGE_PROVIDERS: readonly string[];
/** The test-only addresses of the fake Canva and ads MCP servers. */
export const STUDIO_TEST_URLS: readonly string[];
/** CANVA_API_BASE_URL and CANVA_AUTH_BASE_URL (the fake Canva server for tests), each null unless outside production and on a loopback address. */
export function testCanvaBaseUrls(env?: Record<string, string | undefined>): { api: string | null; auth: string | null };
/** META_ADS_MCP_URL (the fake ads MCP server for tests) when it may be used: outside production and on a loopback address; else null. */
export function testMetaAdsMcpUrl(env?: Record<string, string | undefined>): string | null;
