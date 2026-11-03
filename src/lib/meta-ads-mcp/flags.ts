/**
 * Switches of the read-only Meta ads MCP features (docs/specs/ADS-MCP-CANVA-CREATIVE-SPEC.md 5.8, D25; MCC-00). Read on every
 * call, so an env change takes effect without a restart. src/lib/env-rules.mjs refuses an unknown value at startup; here an
 * unknown value falls back to the safe default:
 *   META_ADS_MCP=off (the Health check tab, the tenant MCP ad tools and Eddy's ad checks stay hidden; the owner turns it on
 *   only after ads_mcp_management is in the use case and the Login for Business configuration),
 *   META_ADS_MCP_RULES=off (the optional "Block AI tools from raising budgets at Meta" card), META_ADS_MCP_DAILY_CALLS=600.
 *
 * Pure: no database, no network.
 */
import { boundedNumber } from "@/lib/studio/flags";

type Env = Record<string, string | undefined>;

const read = (env: Env, key: string): string => (env[key] ?? "").trim().toLowerCase();

/** Ad checks from Meta's ads MCP server (default off). */
export function metaAdsMcpEnabled(env: Env = process.env): boolean {
  return read(env, "META_ADS_MCP") === "on";
}

/** The owner-only card that sets Meta-side rules for AI tools on the spending ad account (default off, 5.4.4). */
export function metaAdsMcpRules(env: Env = process.env): boolean {
  return read(env, "META_ADS_MCP_RULES") === "on";
}

/** Ads MCP network calls a workspace may make per day, cache misses only (50 to 10000, default 600). */
export function metaAdsMcpDailyCalls(env: Env = process.env): number {
  return boundedNumber(env, "META_ADS_MCP_DAILY_CALLS");
}
