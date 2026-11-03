/**
 * The action definitions (docs/EDDY-SPEC.md 4.6, EDDY-05, EDDY-06), including the three spend front-desk tools
 * (get_spending, stop_spending, decline_spend_request), which reach Phase 0 through the spend bridge, and Eddy's 41
 * promotion, lead-form and audience tools (docs/IG-PAGE-ADS-SPEC.md 6.4, PRM-13).
 *
 * src/lib/actions/registry.ts imports this list once and registers it at load (sorted by name, every 4.2 load rule checked).
 * Nothing else imports these files (4.8 test 3): Eddy and later MCP reach a definition only through invoke.ts.
 *
 * The list keeps its name, V1_DEFINITIONS, but also holds the four v2 promotion tools (save_promotion_paused, start_promotion,
 * change_end_date, pick_winning_version). They are offered only with EDDY_PHASE=2 (model-tools.ts) and refused before that
 * by invoke.ts G2, so the phase-1 toolsets are unchanged by them.
 *
 * The 41 carry `feature: "promote"`: model-tools.ts offers them only while PROMOTE_ENABLED is not off (the default is off), so a
 * platform where the feature is dark never offers ads tools. They stay registered either way, so a stray call is answered by
 * the promote route guard (404) and an old card still resolves. PROMOTE_ENABLED is platform-wide: the sets stay byte-identical
 * for every tenant.
 *
 * Toolsets with EDDY_PHASE=1 and PROMOTE_ENABLED on: 44 tools for agents and 102 for admins and owners (4.6 counts, the four
 * chatbot tools of 2026-10-30, and the 37 v1 promotion tools, get_creative_specs the only one agents get). EDDY_PHASE=2 adds
 * the four v2 ones for admins and owners (106). With PROMOTE_ENABLED off: 43 and 65 in both phases.
 *
 * (MCC-00, docs/specs/ADS-MCP-CANVA-CREATIVE-SPEC.md 5.5) The ads MCP tools (META_ADS_DEFS, each marked `feature: "meta_ads_mcp"`
 * here) and the Studio and Canva tools (STUDIO_DEFS, each naming "studio" or "canva" itself) are spread in below. Both lists are
 * empty until MCC-07 and MCC-11 fill them, and their tools are offered only while their flags are on, so the counts above hold.
 */
import type { AnyActionDef } from "../registry";
import { AUDIENCE_DEFS } from "./audiences";
import { AUTOMATION_DEFS } from "./automation";
import { BROADCASTS_DEFS } from "./broadcasts";
import { CHATBOT_DEFS } from "./chatbots";
import { CONTACTS_DEFS } from "./contacts";
import { FRONTDESK_DEFS } from "./frontdesk";
import { HELP_DEFS } from "./help";
import { INBOX_DEFS } from "./inbox";
import { LEAD_FORM_DEFS } from "./lead-forms";
import { META_ADS_DEFS } from "./meta-ads";
import { NAVIGATION_DEFS } from "./navigation";
import { PROMOTE_DEFS } from "./promote";
import { REPORTS_DEFS } from "./reports";
import { SPEND_DEFS } from "./spend";
import { STUDIO_DEFS } from "./studio";
import { TEMPLATES_DEFS } from "./templates";
import { WORKSPACE_DEFS } from "./workspace";

/** Eddy's Instagram and Facebook Page ads tools (6.4): promotions, lead forms and audiences, sorted by name, each marked with the flag that offers it. */
export const PROMOTE_TOOL_DEFS: readonly AnyActionDef[] = [...AUDIENCE_DEFS, ...LEAD_FORM_DEFS, ...PROMOTE_DEFS]
  .map((d): AnyActionDef => ({ ...d, feature: "promote" }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** Eddy's read-only ad checks from Meta's ads MCP server (5.5), each marked with the flag that offers it (META_ADS_MCP). */
export const META_ADS_TOOL_DEFS: readonly AnyActionDef[] = META_ADS_DEFS.map((d): AnyActionDef => ({ ...d, feature: "meta_ads_mcp" }));

/** Every definition, sorted by name (the registry refuses an unsorted list). */
export const V1_DEFINITIONS: readonly AnyActionDef[] = [
  ...AUTOMATION_DEFS,
  ...BROADCASTS_DEFS,
  ...CHATBOT_DEFS,
  ...CONTACTS_DEFS,
  ...FRONTDESK_DEFS,
  ...HELP_DEFS,
  ...INBOX_DEFS,
  ...META_ADS_TOOL_DEFS,
  ...NAVIGATION_DEFS,
  ...PROMOTE_TOOL_DEFS,
  ...REPORTS_DEFS,
  ...SPEND_DEFS,
  ...STUDIO_DEFS,
  ...TEMPLATES_DEFS,
  ...WORKSPACE_DEFS,
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** Spend front-desk tools still waiting for the spend bridge: none since EDDY-06 landed (the coverage test checks it stays empty). */
export const PENDING_SPEND_TOOLS: readonly string[] = [];
