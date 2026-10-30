import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotSettings } from "@/components/chatbots/BotSettings";
import { NODE_META, cardSummary, handlesOf, isBranching, makeNode, summarize } from "@/components/chatbots/catalog";
import { docFromChatbot, docToPayload, hasUnpublishedChanges, newDoc } from "@/components/chatbots/editor";
import { normalizeFlow, pruneEdges, settingsOf, withSettings } from "@/components/chatbots/flow";
import { templateNeeds } from "@/components/chatbots/Inspector";
import { reply, startPreview } from "@/components/chatbots/preview";
import { sessionLength } from "@/components/chatbots/SessionsPanel";
import { emptyFlow, type FlowDefinition, type FlowNode } from "@/components/chatbots/types";
import { serverIssuesOf, validateFlowIssues, validateNode } from "@/components/chatbots/validation";

const node = <T extends FlowNode["type"]>(type: T, id: string, data: Record<string, unknown>): FlowNode => ({ ...makeNode(type, id, { x: 0, y: 0 }), data: { ...makeNode(type, id, { x: 0, y: 0 }).data, ...data } }) as FlowNode;
const flowOf = (nodes: FlowNode[], edges: FlowDefinition["edges"] = [], extra: Partial<FlowDefinition> = {}): FlowDefinition => ({ version: 1, start: nodes[0].id, nodes, edges, ...extra });

describe("handles", () => {
  it("buttons and lists get an optional 'anything else' exit after their options", () => {
    const b = node("send_buttons", "b", {});
    expect(handlesOf(b).map((h) => h.label)).toEqual(["b1", "b2", "default"]);
    expect(handlesOf(b).at(-1)).toMatchObject({ optional: true });
    expect(handlesOf(node("send_list", "l", {})).at(-1)).toMatchObject({ label: "default", optional: true });
  });

  it("templates, web calls and questions get an optional failure exit and show as branching cards", () => {
    expect(handlesOf(node("send_template", "t", {})).map((h) => [h.label, h.optional])).toEqual([[undefined, undefined], ["error", true]]);
    expect(handlesOf(node("webhook", "w", {})).at(-1)).toMatchObject({ label: "error", optional: true });
    expect(handlesOf(node("ask", "a", {})).at(-1)).toMatchObject({ label: "invalid", optional: true });
    for (const type of ["send_template", "webhook", "ask", "send_buttons", "send_list", "condition"] as const) expect(isBranching(node(type, "x", {}))).toBe(true);
    for (const type of ["send_text", "assign", "handoff", "end", "delay"] as const) expect(isBranching(node(type, "x", {}))).toBe(false);
  });

  it("keeps a failure connection when the step is edited", () => {
    const f = flowOf([node("send_template", "t", { templateId: "tp" }), node("end", "e", {})], [{ id: "e1", from: "t", to: "e", label: "error" }]);
    expect(pruneEdges(f).edges).toHaveLength(1);
    const dropped = flowOf([node("send_buttons", "b", {}), node("end", "e", {})], [{ id: "e1", from: "b", to: "e", label: "gone" }]);
    expect(pruneEdges(dropped).edges).toHaveLength(0);
  });

  it("describes team assignment in the card summary", () => {
    expect(summarize(node("assign", "a", { userId: "round_robin", teamId: "team1" }))).toBe("A team");
    expect(summarize(node("assign", "a", { userId: "round_robin" }))).toBe("Round robin");
    expect(NODE_META.handoff.help).toMatch(/note/);
  });

  it("never leaves a card for a step that needs nothing filled in reading 'Not set up yet'", () => {
    expect(cardSummary(node("handoff", "h", { message: "" }))).toBe("Hands the chat to your team");
    expect(cardSummary(node("handoff", "h", { message: "", userId: "team_queue" }))).toBe("Leaves the chat in your team's queue");
    expect(cardSummary(node("handoff", "h", { message: "One moment, a person will reply." }))).toBe("One moment, a person will reply.");
    expect(cardSummary(node("end", "e", {}))).toBe("The chat ends here");
    // Step names in Checks and the inspector stay content-only, so an End step is still just "End".
    expect(summarize(node("end", "e", {}))).toBe("");
    // A step that really is missing something still says so.
    expect(cardSummary(node("send_text", "s", { text: "" }))).toBe("Not set up yet");
  });
});

describe("checks", () => {
  it("does not warn about optional exits left empty, but still about the normal next step", () => {
    const f = flowOf([node("send_template", "t", { templateId: "tp" }), node("send_text", "s", { text: "ok" })], [{ id: "e1", from: "t", to: "s" }]);
    const warnings = validateFlowIssues(f).filter((i) => i.severity === "warning").map((i) => i.message);
    expect(warnings.some((m) => /cannot be sent/.test(m))).toBe(false);
    const open = flowOf([node("send_template", "t", { templateId: "tp" })]);
    expect(validateFlowIssues(open).some((i) => /nothing follows this step/.test(i.message))).toBe(true);
  });

  it("assign needs a person or a team", () => {
    expect(validateNode(node("assign", "a", { userId: "" }))).toEqual(["Choose a teammate or a team to assign the chat to."]);
    expect(validateNode(node("assign", "a", { userId: "", teamId: "team1" }))).toEqual([]);
    expect(validateNode(node("assign", "a", { userId: "round_robin" }))).toEqual([]);
  });

  it("checks header, footer and template media links", () => {
    expect(validateNode(node("send_buttons", "b", { text: "Hi", header: "x".repeat(61) })).join()).toMatch(/header can be at most 60/);
    expect(validateNode(node("send_list", "l", { text: "Hi", footer: "x".repeat(61) })).join()).toMatch(/footer can be at most 60/);
    expect(validateNode(node("send_template", "t", { templateId: "tp", headerMediaUrl: "http://x.example.com/a.png" })).join()).toMatch(/https/);
    expect(validateNode(node("send_template", "t", { templateId: "tp", headerMediaUrl: "{{photo}}" }))).toEqual([]);
    expect(validateNode(node("send_template", "t", { templateId: "tp", headerMediaUrl: "https://cdn.example.com/a.png" }))).toEqual([]);
  });
});

describe("settings in the document", () => {
  it("fills every missing value", () => {
    expect(settingsOf(emptyFlow())).toMatchObject({ priority: 100, keywordMatch: "contains", skipAssignedChats: true, stopOnHumanReply: true, interactive: true, escalation: { enabled: true, useAi: false, keywords: [] } });
  });

  it("changes one value and leaves the others, including nested escalation values", () => {
    const a = withSettings(emptyFlow(), { priority: 3 });
    const b = withSettings(a, { escalation: { teamId: "team1" } });
    expect(b.settings).toMatchObject({ priority: 3, escalation: { enabled: true, teamId: "team1" } });
    expect(a.settings?.escalation.teamId).toBeUndefined();
  });

  it("survives normalising and goes to the server inside the flow, with the number", () => {
    const flow = withSettings(emptyFlow(), { stopOnHumanReply: false });
    expect(normalizeFlow(flow).settings?.stopOnHumanReply).toBe(false);
    expect(normalizeFlow({ start: "a" })).not.toHaveProperty("settings");
    const payload = docToPayload({ ...newDoc(), name: " Bot ", phoneNumberId: "pn1", flow });
    expect(payload).toMatchObject({ name: "Bot", phoneNumberId: "pn1", flow: { settings: { stopOnHumanReply: false } } });
    expect(docFromChatbot({ name: "Bot", triggerType: "manual", triggerKeywords: [], phoneNumberId: "pn2", flow }).phoneNumberId).toBe("pn2");
    expect(docFromChatbot({ name: "Bot", triggerType: "manual", triggerKeywords: [], flow }).phoneNumberId).toBeNull();
  });
});

describe("checks that match the server", () => {
  it("refuses names the server refuses", () => {
    expect(validateNode(node("ask", "a", { text: "Name?", variable: "_name" })).length).toBe(1);
    expect(validateNode(node("ask", "a", { text: "Name?", variable: "name_1" }))).toEqual([]);
    expect(validateNode(node("set_attribute", "s", { attribute: "City!", value: "x" })).length).toBe(1);
    expect(validateNode(node("set_attribute", "s", { attribute: "Home city-1", value: "x" }))).toEqual([]);
    expect(validateNode(node("condition", "c", { variable: "1st", operator: "exists" })).length).toBe(1);
    expect(validateNode(node("condition", "c", { variable: "city", operator: "exists" }))).toEqual([]);
  });

  it.each(["http://example.com/hook", "https://10.0.0.5/hook", "https://localhost/hook", "https://example.com:9999/hook", "https://user:pw@example.com/hook", "https://metadata.google.internal/x", "https://[::1]/x", "https://2130706433/x"])("refuses the web address %s", (url) => {
    expect(validateNode(node("webhook", "w", { url })).length).toBe(1);
  });

  it("accepts public web addresses on 443 and 8443", () => {
    expect(validateNode(node("webhook", "w", { url: "https://hooks.example.com/a?b=1" }))).toEqual([]);
    expect(validateNode(node("webhook", "w", { url: "https://hooks.example.com:8443/a" }))).toEqual([]);
  });

  it("turns the server's per-step list into checks", () => {
    const f = flowOf([node("ask", "n2", { text: "Q", variable: "ok" })]);
    const out = serverIssuesOf(Object.assign(new Error("x"), { body: { errors: [{ nodeId: "n2", message: "Variable is required." }, { message: "Something general." }, { nodeId: "gone", message: "Odd." }] } }), f);
    expect(out).toEqual([
      { severity: "error", nodeId: "n2", message: `${NODE_META.ask.label}: Variable is required.` },
      { severity: "error", message: "Something general." },
      { severity: "error", message: "Odd." },
    ]);
    expect(serverIssuesOf(new Error("x"), f)).toEqual([]);
  });
});

describe("unpublished changes", () => {
  it("ignores empty optional fields the server drops when publishing", () => {
    const draft = flowOf([node("ask", "a", { text: "Q", variable: "v", retryText: "", choices: [] }), node("webhook", "w", { url: "https://x.example.com/", saveAs: "", bodyTemplate: "" })]);
    const published = flowOf([node("ask", "a", { text: "Q", variable: "v" }), node("webhook", "w", { url: "https://x.example.com/" })]);
    const bot = { flow: draft, publishedFlow: published, status: "published" as const };
    expect(hasUnpublishedChanges(bot)).toBe(false);
    const edited = flowOf([node("ask", "a", { text: "Other", variable: "v" }), node("webhook", "w", { url: "https://x.example.com/" })]);
    expect(hasUnpublishedChanges({ ...bot, flow: edited })).toBe(true);
  });
});

describe("preview", () => {
  const menu = (settings?: FlowDefinition["settings"]) =>
    flowOf(
      [node("send_buttons", "b", { text: "Pick", buttons: [{ id: "x", title: "Talk to an agent" }, { id: "y", title: "Prices" }] }), node("send_text", "t", { text: "Prices are low" })],
      [{ id: "e1", from: "b", to: "t", label: "y" }],
      settings ? { settings } : {},
    );

  it("picks an option by its number, like the live bot", () => {
    const f = menu();
    const out = reply(f, startPreview(f), { text: "2" });
    expect(out.messages.map((m) => m.text)).toContain("Prices are low");
    expect(reply(f, startPreview(f), { text: "7" }).messages.at(-1)?.text).toBe("Please choose one of the options.");
  });

  it("shows the hand-over when the customer asks for a person, but not for a tapped option", () => {
    const start = startPreview(menu());
    const asked = reply(menu(), start, { text: "I want to talk to a human" });
    expect(asked.status).toBe("handoff");
    expect(asked.messages.some((m) => m.from === "bot" && /connecting you/.test(m.text))).toBe(true);
    expect(asked.messages.some((m) => m.from === "note" && /asked for a person/.test(m.text))).toBe(true);
    const tapped = reply(menu(), start, { optionId: "x" });
    expect(tapped.status).not.toBe("handoff");
  });

  it("uses the bot's own message, and does nothing when switched off", () => {
    const custom = withSettings(menu(), { escalation: { message: "A person is coming" } });
    const out = reply(custom, startPreview(custom), { text: "human please" });
    expect(out.messages.some((m) => m.text === "A person is coming")).toBe(true);
    const off = withSettings(menu(), { escalation: { enabled: false } });
    const stay = reply(off, startPreview(off), { text: "human please" });
    expect(stay.status).toBe("waiting");
  });

  it("frustration hands over only when the words fit no option", () => {
    const f = menu();
    expect(reply(f, startPreview(f), { text: "this is useless" }).status).toBe("handoff");
    expect(reply(f, startPreview(f), { text: "prices" }).status).not.toBe("handoff");
  });

  it("notes team and hand-over details", () => {
    const f = flowOf([node("assign", "a", { userId: "", teamId: "team1" }), node("handoff", "h", {})], [{ id: "e1", from: "a", to: "h" }]);
    const out = startPreview(f);
    expect(out.messages.map((m) => m.text)).toEqual(expect.arrayContaining(["Put in a team's queue.", expect.stringMatching(/private note/)]));
  });
});

describe("template needs", () => {
  it("reads gaps, header and button needs from the template", () => {
    expect(templateNeeds([{ type: "BODY", text: "Hi {{1}}, {{3}}" }, { type: "HEADER", format: "IMAGE" }, { type: "BUTTONS", buttons: [{ type: "URL", url: "https://x.example.com/{{1}}" }] }])).toEqual({
      bodyGaps: 3,
      headerText: false,
      headerMedia: "picture",
      buttonGap: true,
    });
    expect(templateNeeds([{ type: "HEADER", format: "TEXT", text: "Order {{1}}" }, { type: "BODY", text: "Hello" }])).toMatchObject({ bodyGaps: 0, headerText: true, headerMedia: null });
    expect(templateNeeds([{ type: "HEADER", format: "DOCUMENT" }])).toMatchObject({ headerMedia: "document" });
    expect(templateNeeds(undefined)).toEqual({ bodyGaps: 0, headerText: false, headerMedia: null, buttonGap: false });
  });
});

describe("sessions", () => {
  it("shows how long a conversation lasted in plain units", () => {
    const start = "2026-10-27T10:00:00Z";
    expect(sessionLength(start, "2026-10-27T10:00:20Z")).toBe("Under a minute");
    expect(sessionLength(start, "2026-10-27T10:12:00Z")).toBe("12 min");
    expect(sessionLength(start, "2026-10-27T13:05:00Z")).toBe("3 h 5 min");
    expect(sessionLength(start, "2026-10-29T12:00:00Z")).toBe("2 d 2 h");
    expect(sessionLength(start, null, new Date("2026-10-27T10:30:00Z").getTime())).toBe("30 min");
  });
});

describe("settings panel", () => {
  const render = (props: Partial<Parameters<typeof BotSettings>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(BotSettings, {
        doc: newDoc(),
        triggerType: "keyword",
        options: { teams: [{ id: "team1", name: "Sales" }], phoneNumbers: [{ id: "pn1", displayPhone: "+91 99999 00000", verifiedName: "Shop" }] },
        members: [{ userId: "u1", name: "Asha" }],
        apply: () => undefined,
        ...props,
      }),
    );

  it("offers number, priority, matching, team rules and escalation in plain words", () => {
    const html = render();
    for (const text of ["Where it runs", "Shop (+91 99999 00000)", "Which chatbot goes first", "How words are matched", "Skip chats a teammate owns", "Stop when a teammate replies", "Use WhatsApp buttons and menus", "When a customer wants a person", "Sales", "Asha", "Ask AI when unsure"]) {
      expect(html).toContain(text);
    }
  });

  it("hides priority and matching for chatbots that only start by hand, and the details when escalation is off", () => {
    const manual = render({ triggerType: "manual" });
    expect(manual).not.toContain("Which chatbot goes first");
    expect(manual).not.toContain("How words are matched");
    const off = render({ doc: { ...newDoc(), flow: withSettings(emptyFlow(), { escalation: { enabled: false } }) } });
    expect(off).not.toContain("Extra words that ask for a person");
  });
});
