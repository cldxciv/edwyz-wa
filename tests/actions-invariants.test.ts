import { describe, expect, it, vi } from "vitest";

/**
 * docs/EDDY-SPEC.md 4.2 (load rules), 4.6 (the v1 tool list and its counts), 4.9 (toolsets) and 4.8 test 5: the registry
 * loads the v1 definitions sorted and valid, refuses every broken rule, and gives byte-identical toolsets whose hash is
 * pinned here, so a change to any tool is a deliberate, reviewed change (TOOLSET_VERSION starts new Eddy conversations).
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
  // look-ups (24, get_spending included since EDDY-06)
  "explain_error", "get_activity", "get_attention", "get_broadcast", "get_contact", "get_conversation", "get_lead", "get_report_summary", "get_spending",
  "get_template", "get_workspace_status", "estimate_broadcast", "list_approvals", "list_automations", "list_broadcasts", "list_conversations",
  "list_leads", "list_notices", "list_segments", "list_team", "list_templates", "search_contacts", "search_help", "test_automation_rule",
  // intents
  "draft_reply", "open_page",
  // undoable
  "assign_conversation", "create_contact", "create_quick_reply", "move_conversation_to_team", "set_contact_owner_stage", "set_conversation_status",
  "set_my_availability", "stop_bot_on_conversation", "tag_contacts", "tag_conversations", "undo_last_action", "update_contact",
  // cards
  "add_internal_note", "record_opt_out", "revoke_approval_link", "send_text_reply",
].sort();

const ADMIN_ONLY = [
  "preview_audience", "connect_whatsapp", "connect_facebook",
  "create_template_draft", "create_broadcast_draft", "create_segment", "pause_broadcast", "disable_automation",
  "block_conversation", "submit_template", "delete_template", "delete_contact", "record_opt_in", "cancel_broadcast", "delete_segment", "enable_automation", "invite_teammate",
  "stop_spending", "decline_spend_request",
].sort();

/**
 * Pinned: change it only together with a reviewed change to a tool (name, description or input schema).
 * Last change (EDDY-06, the spend front desk): get_spending, stop_spending and decline_spend_request joined the toolsets,
 * and get_workspace_status, get_activity and list_approvals describe the spend fields they now fill in.
 */
const TOOLSET_HASHES = {
  agent: "74c225a7ea6546446bc8464efe8abb80b0da45a3959b4a385af3ff949ae8551a",
  admin: "4c210bdb1acce25c33e8acc2f19adbd91f23873eb82557a54ed3158cc7986401",
};

const copy = (name: string, over: Partial<AnyActionDef> = {}): AnyActionDef => ({ ...(actionByName(name) as AnyActionDef), ...over });

describe("the v1 registry (4.6, EDDY-05 acceptance 1)", () => {
  it("loads every v1 definition, sorted by name, each passing the 4.2 load rules", () => {
    const names = ACTIONS.map((d) => d.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...AGENT_TOOLS, ...ADMIN_ONLY].sort());
    for (const def of ACTIONS) expect(definitionProblem(def), def.name).toBeNull();
    expect(() => validateDefinitions(ACTIONS)).not.toThrow();
  });

  it("gives 42 agent tools and 61 admin and owner tools, the spend front desk included (4.6 counts, EDDY-06)", () => {
    const agent = toolsFor("agent", "eddy", { phase: 1 }).map((t) => t.name);
    const admin = toolsFor("admin", "eddy", { phase: 1 }).map((t) => t.name);
    expect(agent).toEqual(AGENT_TOOLS);
    expect(agent).toHaveLength(42);
    expect(admin).toEqual([...AGENT_TOOLS, ...ADMIN_ONLY].sort());
    expect(admin).toHaveLength(61);
    expect(PENDING_SPEND_TOOLS).toEqual([]);
    // get_spending is an agent look-up; stop_spending and decline_spend_request are admin cards (4.6).
    expect(agent).toContain("get_spending");
    expect(agent).not.toContain("stop_spending");
    expect(admin).toEqual(expect.arrayContaining(["get_spending", "stop_spending", "decline_spend_request"]));
    expect(actionByName("approve_spend_request")).toBeUndefined();
    expect(roleClassOf("owner")).toBe("admin");
  });

  it("every tool is v1, on the eddy surface, spends nothing from messaging or ads and returns no secret", () => {
    for (const def of ACTIONS) {
      expect(def.version, def.name).toBe("v1");
      expect(def.surfaces, def.name).toContain("eddy");
      if (typeof def.effects !== "function") {
        const e = def.effects as Effects;
        expect(e.spends === "messaging" || e.spends === "ads", def.name).toBe(false);
        expect(e.returnsSecret ?? false, def.name).toBe(false);
      }
      expect(def.spendIntent, def.name).toBeUndefined();
    }
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
    expect(callsMeta).toEqual(["connect_facebook", "connect_whatsapp", "delete_template", "send_text_reply", "submit_template"]);
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
      const a = toolsFor(roleClass, "eddy", { phase: 1 });
      const b = toolsFor(roleClass, "eddy", { phase: 1 });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.map((t) => t.name)).toEqual([...a.map((t) => t.name)].sort());
      for (const tool of a) {
        expect(tool.strict).toBe(true);
        expect(tool.input_schema.type).toBe("object");
        expect(tool.input_schema.additionalProperties).toBe(false);
      }
    }
    const hashes = { agent: toolsetHash(toolsFor("agent", "eddy", { phase: 1 })), admin: toolsetHash(toolsFor("admin", "eddy", { phase: 1 })) };
    expect(hashes).toEqual(TOOLSET_HASHES);
  });

  it("sets eager input streaming only on the four long-text tools, and TOOLSET_VERSION follows the registry", () => {
    const admin = toolsFor("admin", "eddy", { phase: 1 });
    expect(admin.filter((t) => t.eager_input_streaming).map((t) => t.name)).toEqual([...EAGER_INPUT_TOOLS].sort());
    expect(TOOLSET_VERSION).toBe(toolsetVersion());
    expect(TOOLSET_VERSION).toMatch(/^ts_[0-9a-f]{24}$/);
  });
});
