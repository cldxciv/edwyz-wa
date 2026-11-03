import { describe, expect, it, vi } from "vitest";

/**
 * docs/EDDY-SPEC.md 4.2 (load rules), 4.6 (the v1 tool list and its counts), 4.9 (toolsets) and 4.8 test 5: the registry
 * loads the v1 definitions sorted and valid, refuses every broken rule, and gives byte-identical toolsets whose hash is
 * pinned here, so a change to any tool is a deliberate, reviewed change (TOOLSET_VERSION starts new Eddy conversations).
 * Since PRM-13 (docs/IG-PAGE-ADS-SPEC.md 6.4) the registry also holds Eddy's 41 promotion, lead-form and audience tools: 37
 * are v1 (get_creative_specs the only one agents get) and 4 are v2, offered only with EDDY_PHASE=2.
 */
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { PENDING_SPEND_TOOLS } from "@/lib/actions/defs";
import { EAGER_INPUT_TOOLS, roleClassOf, TOOLSET_VERSION, toolsetHash, toolsetVersion, toolsFor } from "@/lib/actions/model-tools";
import { ACTIONS, actionByName, definitionProblem, RegistryLoadError, validateDefinitions, type AnyActionDef } from "@/lib/actions/registry";
import { deriveRisk, effectiveRisk } from "@/lib/actions/risk";
import type { Effects } from "@/lib/actions/types";
import "@/lib/eddy/copy/defs";
import { hasKey } from "@/lib/eddy/i18n";

const AGENT_TOOLS = [
  // look-ups (25, get_spending included since EDDY-06, get_chatbot since the chatbot tools of 2026-10-30)
  "explain_error", "get_activity", "get_attention", "get_broadcast", "get_chatbot", "get_contact", "get_conversation", "get_lead", "get_report_summary", "get_spending",
  "get_template", "get_workspace_status", "estimate_broadcast", "list_approvals", "list_automations", "list_broadcasts", "list_conversations",
  "list_leads", "list_notices", "list_segments", "list_team", "list_templates", "search_contacts", "search_help", "test_automation_rule",
  // intents
  "draft_reply", "open_page",
  // undoable
  "assign_conversation", "create_contact", "create_quick_reply", "move_conversation_to_team", "set_contact_owner_stage", "set_conversation_status",
  "set_my_availability", "stop_bot_on_conversation", "tag_contacts", "tag_conversations", "undo_last_action", "update_contact",
  // cards
  "add_internal_note", "record_opt_out", "revoke_approval_link", "send_text_reply",
  // (PRM-13) the static ad catalogue: agents may read it
  "get_creative_specs",
].sort();

/** (PRM-13, IG-PAGE-ADS-SPEC 6.4) the v1 promotion, lead-form and audience tools for owners and admins: 36 of the 37 v1 ones. */
const PROMOTE_ADMIN_V1 = [
  // reads
  "list_boostable_posts", "check_promotion_setup", "list_ad_media", "preview_ad", "get_promotion", "review_promotion", "get_promotion_results",
  "get_version_comparison", "explain_ad_rejection", "get_promote_settings", "get_ad_media", "list_lead_forms", "list_audiences", "get_audience",
  "get_audience_size", "search_places", "search_interests",
  // undoable, local
  "create_promotion_draft", "update_promotion_draft", "discard_promotion_draft", "duplicate_campaign", "set_promote_settings", "import_lead_form",
  "hide_lead_form", "save_audience",
  // cards (Meta writes that spend nothing)
  "create_instagram_identity", "prepare_ad_media", "create_pixel", "create_lead_form", "copy_lead_form", "send_test_lead", "create_audience",
  "create_lookalike", "create_customer_audience", "refresh_customer_audience", "delete_audience",
].sort();

/** (PRM-13) the four v2 promotion tools: offered only with EDDY_PHASE=2 (train P5). */
const PROMOTE_V2 = ["change_end_date", "pick_winning_version", "save_promotion_paused", "start_promotion"];

const ADMIN_ONLY = [
  "preview_audience", "connect_whatsapp", "connect_facebook",
  "create_template_draft", "create_broadcast_draft", "create_segment", "pause_broadcast", "disable_automation", "create_chatbot", "update_chatbot",
  "block_conversation", "submit_template", "delete_template", "delete_contact", "record_opt_in", "cancel_broadcast", "delete_segment", "enable_automation", "invite_teammate", "publish_chatbot",
  "stop_spending", "decline_spend_request",
  ...PROMOTE_ADMIN_V1,
].sort();

/**
 * Pinned: change it only together with a reviewed change to a tool (name, description or input schema).
 * Last change (2026-10-31, PRM-13 review): check_promotion_setup and explain_ad_rejection now say the Opens Meta button is on
 * the Ads page (Eddy's card doesn't render it yet), and set_promote_settings says a new PIN code clears the shop's map pin.
 * The sets are pinned with PROMOTE_ENABLED on; with it off the 41 ads tools are left out (TOOLSET_HASHES_PROMOTE_OFF).
 * Before that (2026-10-31, PRM-13): Eddy's 37 v1 promotion, lead-form and audience tools joined the admin set and
 * get_creative_specs the agent set (the 4 v2 ones are not in the phase-1 sets). Before that (2026-10-31, D3 projects):
 * open_page's page list gained /app/projects (All projects joined the navigation, src/components/app/nav.ts); (2026-10-30,
 * Eddy builds chatbots) get_chatbot joined both toolsets and create_chatbot, update_chatbot and publish_chatbot the admin
 * set; (EDDY-06) the spend front desk added get_spending, stop_spending and decline_spend_request.
 */
const TOOLSET_HASHES = {
  agent: "9d9f351dd42865753146ea4504b883696c05508f643d1ac27adf6bf5f29a5fde",
  admin: "901e5ffb97560edf40bdd89f193361ef05872931b2866597e9e9dd4616d36974",
};

/** The phase-1 sets with PROMOTE_ENABLED off (the platform default): Eddy as it was before PRM-13. */
const TOOLSET_HASHES_PROMOTE_OFF = {
  agent: "1a6bcffafb92af108d0208288d085f9bd9f0c92e99c333aef812edc651e30e85",
  admin: "42ca18665f7ccfd88eba8c7ef465242dd33937a4cc8fa9c52cd82e31d1d19005",
};

const copy = (name: string, over: Partial<AnyActionDef> = {}): AnyActionDef => ({ ...(actionByName(name) as AnyActionDef), ...over });

describe("the v1 registry (4.6, EDDY-05 acceptance 1)", () => {
  it("loads every v1 definition, sorted by name, each passing the 4.2 load rules", () => {
    const names = ACTIONS.map((d) => d.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...AGENT_TOOLS, ...ADMIN_ONLY, ...PROMOTE_V2].sort());
    for (const def of ACTIONS) expect(definitionProblem(def), def.name).toBeNull();
    expect(() => validateDefinitions(ACTIONS)).not.toThrow();
  });

  it("gives 44 agent tools and 102 admin and owner tools in phase 1, and 106 in phase 2 (4.6 counts, EDDY-06, PRM-13)", () => {
    const agent = toolsFor("agent", "eddy", { phase: 1, promote: true }).map((t) => t.name);
    const admin = toolsFor("admin", "eddy", { phase: 1, promote: true }).map((t) => t.name);
    expect(agent).toEqual(AGENT_TOOLS);
    expect(agent).toHaveLength(44);
    expect(admin).toEqual([...AGENT_TOOLS, ...ADMIN_ONLY].sort());
    expect(admin).toHaveLength(102);
    // The v2 promotion tools are absent in phase 1 and offered to owners and admins only in phase 2.
    for (const name of PROMOTE_V2) expect(admin, name).not.toContain(name);
    const admin2 = toolsFor("admin", "eddy", { phase: 2, promote: true }).map((t) => t.name);
    expect(admin2).toEqual([...AGENT_TOOLS, ...ADMIN_ONLY, ...PROMOTE_V2].sort());
    expect(admin2).toHaveLength(106);
    expect(toolsFor("agent", "eddy", { phase: 2, promote: true }).map((t) => t.name)).toEqual(AGENT_TOOLS);
    // (PRM-13 review) With PROMOTE_ENABLED off, the platform default, none of the 41 ads tools is offered: 43 tools for agents
    // and 65 for admins and owners, in both phases. They stay registered (actionByName resolves them).
    const withoutAds = (names: readonly string[]) => names.filter((n) => n !== "get_creative_specs" && !PROMOTE_ADMIN_V1.includes(n) && !PROMOTE_V2.includes(n));
    expect(toolsFor("agent", "eddy", { phase: 1, promote: false }).map((t) => t.name)).toEqual(withoutAds(AGENT_TOOLS));
    expect(toolsFor("agent", "eddy", { phase: 1, promote: false })).toHaveLength(43);
    for (const phase of [1, 2] as const) {
      const off = toolsFor("admin", "eddy", { phase, promote: false }).map((t) => t.name);
      expect(off, `phase ${phase}`).toEqual(withoutAds([...AGENT_TOOLS, ...ADMIN_ONLY]).sort());
      expect(off, `phase ${phase}`).toHaveLength(65);
    }
    for (const name of [...PROMOTE_ADMIN_V1, ...PROMOTE_V2, "get_creative_specs"]) expect(actionByName(name)?.feature, name).toBe("promote");
    expect(PENDING_SPEND_TOOLS).toEqual([]);
    // get_spending is an agent look-up; stop_spending and decline_spend_request are admin cards (4.6).
    expect(agent).toContain("get_spending");
    expect(agent).not.toContain("stop_spending");
    expect(admin).toEqual(expect.arrayContaining(["get_spending", "stop_spending", "decline_spend_request"]));
    expect(actionByName("approve_spend_request")).toBeUndefined();
    expect(roleClassOf("owner")).toBe("admin");
  });

  it("every tool but the four v2 promotion tools is v1, on the eddy surface, spends nothing from messaging or ads and returns no secret", () => {
    for (const def of ACTIONS) {
      expect(def.version, def.name).toBe(PROMOTE_V2.includes(def.name) ? "v2" : "v1");
      expect(def.surfaces, def.name).toContain("eddy");
      if (typeof def.effects !== "function") {
        const e = def.effects as Effects;
        if (def.version === "v1") expect(e.spends === "messaging" || e.spends === "ads", def.name).toBe(false);
        expect(e.returnsSecret ?? false, def.name).toBe(false);
      }
      if (def.version === "v1") expect(def.spendIntent, def.name).toBeUndefined();
    }
    // No definition hands the bridge a spend intent: invoke.ts never calls spendIntent. Start and a later end reach the Spend
    // Book through promote/service and ads/service with invoke.ts's via_eddy actor forwarded (PRM-13 review, B14).
    expect(ACTIONS.filter((d) => typeof d.spendIntent === "function").map((d) => d.name)).toEqual([]);
  });

  it("every undoable definition has stillApplies and inverse; every card has a server-side preview", () => {
    for (const def of ACTIONS) {
      const staticRisk = typeof def.effects === "function" ? null : effectiveRisk(def.risk, def.effects as Effects);
      if (def.undo) {
        expect(typeof def.undo.stillApplies, def.name).toBe("function");
        expect(typeof def.undo.inverse, def.name).toBe("function");
      }
      if (staticRisk === "undoable" && !def.isUndo) expect(def.undo, def.name).toBeDefined();
      if (staticRisk === "confirm" || def.risk === "confirm" || typeof def.effects === "function" || def.automationEvents) expect(typeof def.preview, def.name).toBe("function");
    }
    expect(ACTIONS.filter((d) => d.isUndo).map((d) => d.name)).toEqual(["undo_last_action"]);
  });

  it("every tag, attribute, status and contact write announces its automation events (4.2a)", () => {
    for (const name of ["tag_contacts", "tag_conversations", "update_contact", "create_contact", "set_conversation_status", "block_conversation"]) {
      expect(typeof actionByName(name)?.automationEvents, name).toBe("function");
    }
    for (const name of ["tag_contacts", "tag_conversations", "update_contact", "set_conversation_status"]) expect(typeof actionByName(name)?.undo?.automationEvents, name).toBe("function");
  });

  it("needsWhatsApp and callsMeta follow 6.14", () => {
    const callsMeta = ACTIONS.filter((d) => d.callsMeta).map((d) => d.name).sort();
    // (PRM-13) every promotion, lead-form and audience tool that reaches Meta; the local reads and writes don't.
    const promoteCallsMeta = [
      "change_end_date", "check_promotion_setup", "copy_lead_form", "create_audience", "create_customer_audience", "create_instagram_identity",
      "create_lead_form", "create_lookalike", "create_pixel", "delete_audience", "explain_ad_rejection", "get_audience_size", "import_lead_form",
      "list_boostable_posts", "list_lead_forms", "pick_winning_version", "prepare_ad_media", "preview_ad", "refresh_customer_audience",
      "review_promotion", "save_promotion_paused", "search_interests", "search_places", "send_test_lead", "start_promotion",
    ];
    expect(callsMeta).toEqual(["connect_facebook", "connect_whatsapp", "delete_template", "send_text_reply", "submit_template", ...promoteCallsMeta].sort());
    for (const name of ["send_text_reply", "submit_template", "delete_template"]) expect(actionByName(name)?.needsWhatsApp, name).toBe(true);
  });

  it("every label key a definition uses is in the catalogue", () => {
    for (const def of ACTIONS) {
      expect(hasKey(def.titleKey), def.titleKey).toBe(true);
      if (def.undo && !def.isUndo) expect(hasKey(`done.${def.name}`), `done.${def.name}`).toBe(true);
      const e = typeof def.effects === "function" ? null : (def.effects as Effects);
      if (e && (deriveRisk(e) === "confirm" || def.risk === "confirm")) {
        expect(hasKey(`card.${def.name}.title`), `card.${def.name}.title`).toBe(true);
        expect(hasKey(`card.${def.name}.confirm`), `card.${def.name}.confirm`).toBe(true);
      }
    }
    for (const sends of ["text", "material", "chatbot", "template", "ai_agent", "lead_sequence"]) expect(hasKey(`card.fact.automation.${sends}`)).toBe(true);
  });

  it("declares untrusted result paths in the projection's syntax and names no link or Meta host in a description", () => {
    for (const def of ACTIONS) {
      for (const p of def.untrustedPaths) expect(p, def.name).toMatch(/^[A-Za-z0-9_]+(\[\])?(\.[A-Za-z0-9_]+(\[\])?)*$/);
      expect(/https?:\/\/|facebook\.com|meta\.com|fb\.me/i.test(def.description), def.name).toBe(false);
    }
  });
});

describe("registry load rules throw (4.2)", () => {
  const expectRefused = (defs: AnyActionDef[], pattern: RegExp) => {
    expect(() => validateDefinitions(defs)).toThrow(RegistryLoadError);
    expect(() => validateDefinitions(defs)).toThrow(pattern);
  };

  it("a static risk below the derived risk", () => {
    expectRefused([copy("send_text_reply", { risk: "instant" })], /risk|below/i);
  });

  it("an undoable action without undo, and an undo action with one", () => {
    expectRefused([copy("assign_conversation", { undo: undefined })], /undo/);
    expectRefused([copy("undo_last_action", { undo: actionByName("assign_conversation")!.undo })], /undo action/);
  });

  it("a card without a preview", () => {
    expectRefused([copy("delete_contact", { preview: undefined })], /preview/);
  });

  it("a secret on the eddy surface, and a v1 action that spends from messaging or ads", () => {
    expectRefused([copy("list_team", { effects: { writes: false, returnsSecret: true }, preview: actionByName("delete_contact")!.preview })], /secret/);
    expectRefused([copy("record_opt_out", { effects: { writes: true, spends: "messaging" } })], /v2 only/);
    expectRefused([copy("record_opt_out", { effects: { writes: true, spends: "ads" } })], /v2 only/);
  });

  it("duplicated and unsorted names", () => {
    expectRefused([copy("get_contact"), copy("get_contact")], /twice/);
    expectRefused([copy("list_team"), copy("get_contact")], /sorted/);
  });

  it("a schema that is not strict", () => {
    expectRefused([copy("get_contact", { inputSchema: { type: "object", properties: {}, required: [] } })], /additionalProperties/);
  });
});

describe("toolsets (4.9)", () => {
  it("are sorted, strict, byte-identical across calls and pinned by hash", () => {
    for (const roleClass of ["agent", "admin"] as const) {
      const a = toolsFor(roleClass, "eddy", { phase: 1, promote: true });
      const b = toolsFor(roleClass, "eddy", { phase: 1, promote: true });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.map((t) => t.name)).toEqual([...a.map((t) => t.name)].sort());
      for (const tool of a) {
        expect(tool.strict).toBe(true);
        expect(tool.input_schema.type).toBe("object");
        expect(tool.input_schema.additionalProperties).toBe(false);
      }
    }
    const hashes = { agent: toolsetHash(toolsFor("agent", "eddy", { phase: 1, promote: true })), admin: toolsetHash(toolsFor("admin", "eddy", { phase: 1, promote: true })) };
    expect(hashes).toEqual(TOOLSET_HASHES);
    const off = { agent: toolsetHash(toolsFor("agent", "eddy", { phase: 1, promote: false })), admin: toolsetHash(toolsFor("admin", "eddy", { phase: 1, promote: false })) };
    expect(off).toEqual(TOOLSET_HASHES_PROMOTE_OFF);
  });

  it("sets eager input streaming only on the four long-text tools, and TOOLSET_VERSION follows the registry", () => {
    const admin = toolsFor("admin", "eddy", { phase: 1, promote: true });
    expect(admin.filter((t) => t.eager_input_streaming).map((t) => t.name)).toEqual([...EAGER_INPUT_TOOLS].sort());
    expect(TOOLSET_VERSION).toBe(toolsetVersion());
    expect(TOOLSET_VERSION).toMatch(/^ts_[0-9a-f]{24}$/);
  });
});
