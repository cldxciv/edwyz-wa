/**
 * Eddy's read-only ad checks from Meta's ads MCP server (docs/specs/ADS-MCP-CANVA-CREATIVE-SPEC.md 5.5): check_ads_health,
 * get_ads_report, get_ads_benchmarks, get_ads_activity, search_meta_ads_help, search_ad_library and check_tracking_health.
 *
 * Empty until MCC-07 fills it. Every definition here carries `feature: "meta_ads_mcp"` (defs/index.ts sets it), so
 * model-tools.ts offers them only while META_ADS_MCP=on and the default toolsets stay as pinned while it is off.
 */
import type { AnyActionDef } from "../registry";

export const META_ADS_DEFS: readonly AnyActionDef[] = [];
