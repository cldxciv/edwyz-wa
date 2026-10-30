/**
 * The v1 action definitions (docs/EDDY-SPEC.md 4.6, EDDY-05, EDDY-06), including the three spend front-desk tools
 * (get_spending, stop_spending, decline_spend_request), which reach Phase 0 through the spend bridge.
 *
 * src/lib/actions/registry.ts imports this list once and registers it at load (sorted by name, every 4.2 load rule checked).
 * Nothing else imports these files (4.8 test 3): Eddy and later MCP reach a definition only through invoke.ts.
 *
 * Toolsets: 42 tools for agents and 61 for admins and owners (4.6 counts).
 */
import type { AnyActionDef } from "../registry";
import { AUTOMATION_DEFS } from "./automation";
import { BROADCASTS_DEFS } from "./broadcasts";
import { CONTACTS_DEFS } from "./contacts";
import { FRONTDESK_DEFS } from "./frontdesk";
import { HELP_DEFS } from "./help";
import { INBOX_DEFS } from "./inbox";
import { NAVIGATION_DEFS } from "./navigation";
import { REPORTS_DEFS } from "./reports";
import { SPEND_DEFS } from "./spend";
import { TEMPLATES_DEFS } from "./templates";
import { WORKSPACE_DEFS } from "./workspace";

/** Every v1 definition, sorted by name (the registry refuses an unsorted list). */
export const V1_DEFINITIONS: readonly AnyActionDef[] = [
  ...AUTOMATION_DEFS,
  ...BROADCASTS_DEFS,
  ...CONTACTS_DEFS,
  ...FRONTDESK_DEFS,
  ...HELP_DEFS,
  ...INBOX_DEFS,
  ...NAVIGATION_DEFS,
  ...REPORTS_DEFS,
  ...SPEND_DEFS,
  ...TEMPLATES_DEFS,
  ...WORKSPACE_DEFS,
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** Spend front-desk tools still waiting for the spend bridge: none since EDDY-06 landed (the coverage test checks it stays empty). */
export const PENDING_SPEND_TOOLS: readonly string[] = [];
