import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionList } from "@/components/automation/ActionEditor";
import { EMPTY_OPTIONS, type Options } from "@/components/automation/rulesV2";
import { Inspector } from "@/components/chatbots/Inspector";
import type { FlowDefinition, FlowNode } from "@/components/chatbots/types";

/** P5: the rule builder only offers templates a rule can send, and the Wait step explains long waits and replies during a wait. */

describe("rule step 'Send template'", () => {
  const options = {
    ...EMPTY_OPTIONS,
    templates: [
      { id: "tp1", name: "Promo", language: "en", category: "MARKETING", variables: 0, sendable: false, reason: "needs a picture, video or file" },
      { id: "tp2", name: "Hello", language: "en", category: "UTILITY", variables: 1, sendable: true },
      // An older server answer without the field counts as sendable.
      { id: "tp3", name: "Legacy", language: "hi", category: "UTILITY", variables: 0 },
    ],
  } as Options;
  const render = (templateId: string) =>
    renderToStaticMarkup(
      createElement(ActionList, { actions: [{ type: "send_template", templateId, variables: [] }], trigger: { type: "message_received" }, options, onMaterialCreated: () => undefined, onChange: () => undefined }),
    );

  it("lists the templates a rule cannot send as unavailable, with the reason", () => {
    const html = render("");
    expect(html).toMatch(/<option value="tp1" disabled="">Promo \(en\): rules cannot send it, it needs a picture, video or file<\/option>/);
    expect(html).toMatch(/<option value="tp2">Hello \(en\)<\/option>/);
    expect(html).toMatch(/<option value="tp3">Legacy \(hi\)<\/option>/);
    // A heading picture or value and a button link value are filled in by the step (D4), so the hint no longer rules them out.
    expect(html).toContain("If a template has a picture, video or file at the top, or a value in its heading or button link, you fill it in below.");
  });

  it("an older rule that already uses such a template says why it cannot run, under the field", () => {
    const html = render("tp1");
    expect(html).toMatch(/role="alert"[^>]*>A rule cannot send &quot;Promo&quot;: it needs a picture, video or file\. Choose another template, or send this one from a broadcast or a chatbot\.<\/p>/);
    // The chosen option stays selectable so the select still shows it.
    expect(html).toMatch(/<option value="tp1" selected="">/);
  });

  it("explains that a rule starts the AI agent whatever its Reply when setting", () => {
    const html = renderToStaticMarkup(
      createElement(ActionList, { actions: [{ type: "start_ai_agent" }], trigger: { type: "message_received" }, options, onMaterialCreated: () => undefined, onChange: () => undefined }),
    );
    expect(html).toContain("whatever its Reply when setting says");
    expect(html).toContain("Only when an automation rule starts it");
  });
});

describe("chatbot Wait step", () => {
  const wait = (minutes: number, onReply?: string): FlowNode => ({ id: "w", type: "delay", position: { x: 0, y: 0 }, data: { minutes, ...(onReply ? { onReply } : {}) } }) as FlowNode;
  const render = (node: FlowNode) => {
    const flow: FlowDefinition = { version: 1, start: "w", nodes: [node], edges: [] };
    return renderToStaticMarkup(
      createElement(Inspector, { node, flow, templates: [], members: [], onData: () => undefined, onConnect: () => undefined, onDelete: () => undefined, onDuplicate: () => undefined, onSetStart: () => undefined }),
    );
  };

  it("says the next message after a wait of 23 hours or more must be a template, and that silent steps may come first", () => {
    expect(render(wait(60))).toContain("after a wait of 23 hours or more the next message the bot sends must be Send template. Steps that send nothing, such as Add a tag, can come first.");
    expect(render(wait(60))).not.toContain("This is a long wait.");
    expect(render(wait(2 * 1440))).toContain("This is a long wait. Make Send template the next message after it, or the chatbot cannot be published.");
  });

  it("offers what a customer's message does during the wait, keeping the message by default, and says what each choice does", () => {
    const html = render(wait(60));
    expect(html).toContain("If the customer writes during the wait");
    expect(html).toMatch(/<option value="" selected="">Keep waiting\. The bot keeps the message and nothing else answers it<\/option>/);
    expect(html).toContain("Stop waiting and go on to the next step");
    expect(html).toContain("Chat routing, rules and the AI agent leave the message alone until the bot finishes.");
    const pass = render(wait(60, "pass"));
    expect(pass).toMatch(/<option value="pass" selected="">Keep waiting, and let chat routing and rules see the message<\/option>/);
    // Nothing answers the customer while the bot still owns the chat: the hint says so, tied to the select for screen readers.
    const hint = /<select[^>]*aria-describedby="([^"]+)"/.exec(pass)?.[1];
    expect(hint).toBeTruthy();
    expect(pass).toContain(`id="${hint}" class="text-xs text-muted">Chat routing can give the chat to a teammate, and rules can tag or assign it. Nothing answers the customer automatically while the bot waits: the AI agent and rule replies stay quiet.`);
    expect(render(wait(60, "continue"))).toContain("What the customer wrote is saved as {{last_reply}}.");
  });
});
