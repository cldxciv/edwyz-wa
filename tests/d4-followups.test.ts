import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionList, withTemplate } from "@/components/automation/ActionEditor";
import { CONVERT_BODY } from "@/components/automation/AutomationView";
import { EMPTY_OPTIONS, actionProblem, templateFillProblem, templatesForNumber, type Options } from "@/components/automation/rulesV2";
import type { Agent } from "@/components/ai-agent/types";
import { calendarHrefFor, monthOfDateParam } from "@/components/broadcasts/CampaignCalendar";
import { reply, startPreview } from "@/components/chatbots/preview";
import type { FlowDefinition, FlowNode, NodeDataMap } from "@/components/chatbots/types";
import { calendarFocus } from "@/components/content/ContentView";
import { leadQuickActions } from "@/components/inbox/SidePanel";
import { CTWA_LABEL, consentNote, leadOrigin } from "@/components/leads/LeadDrawer";
import { dayKey } from "@/lib/broadcasts/calendar";
import { buildTemplateComponents, templateFillNeeds } from "@/lib/chatbots/template-build";
import { parseAction, type Action } from "@/lib/automation/v2/model";
import { convertDefinition } from "@/lib/automation/v2/service";
import { ruleTemplateProblem } from "@/lib/automation/v2/template-check";
import { ENDPOINTS } from "@/lib/compat/spec";

/** D4 follow-ups from the production fix run (2026-10-31). */

const src = (file: string) => readFileSync(path.resolve(__dirname, "../src", file), "utf8");

const IMAGE_AND_BUTTON = [
  { type: "HEADER", format: "IMAGE" },
  { type: "BODY", text: "Hi {{1}}, order {{2}}" },
  { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }, { type: "URL", url: "https://shop.example.com/t/{{1}}" }] },
];

describe("the chatbot template builder, shared with automation rules (c)", () => {
  it("fills a heading picture, the text values and a link button, in the template's order", () => {
    expect(buildTemplateComponents(IMAGE_AND_BUTTON, { headerMediaUrl: " https://cdn.example.com/p.jpg ", body: ["Asha", "A-17"], button: "A-17" })).toEqual({
      components: [
        { type: "header", parameters: [{ type: "image", image: { link: "https://cdn.example.com/p.jpg" } }] },
        { type: "body", parameters: [{ type: "text", text: "Asha" }, { type: "text", text: "A-17" }] },
        { type: "button", sub_type: "url", index: "1", parameters: [{ type: "text", text: "A-17" }] },
      ],
    });
  });

  it("fills a heading value, cleaned the way WhatsApp needs it, and says what is missing", () => {
    const heading = [{ type: "HEADER", format: "TEXT", text: "Order {{1}}" }, { type: "BODY", text: "Thanks" }];
    expect(buildTemplateComponents(heading, { header: "A-17\n\tready", body: [] })).toEqual({ components: [{ type: "header", parameters: [{ type: "text", text: "A-17 ready" }] }] });
    expect(buildTemplateComponents(heading, { header: "  ", body: [] })).toEqual({ error: "missing_header_value" });
    expect(buildTemplateComponents(IMAGE_AND_BUTTON, { headerMediaUrl: "http://plain.example.com/p.jpg", body: [], button: "x" })).toEqual({ error: "missing_header_media" });
    expect(buildTemplateComponents(IMAGE_AND_BUTTON, { headerMediaUrl: "https://cdn.example.com/p.jpg", body: [] })).toEqual({ error: "missing_button_value" });
    // A plain template needs nothing more.
    expect(buildTemplateComponents([{ type: "BODY", text: "Hello" }], { body: [] })).toEqual({ components: [] });
  });

  it("reads what a template needs the sender to fill in", () => {
    expect(templateFillNeeds(IMAGE_AND_BUTTON)).toEqual({ headerText: false, headerMedia: "image", buttonValue: true, bodyValues: 2 });
    expect(templateFillNeeds([{ type: "HEADER", format: "TEXT", text: "Hi {{1}}" }, { type: "BODY", text: "x" }])).toEqual({ headerText: true, headerMedia: null, buttonValue: false, bodyValues: 0 });
    expect(templateFillNeeds([{ type: "HEADER", format: "DOCUMENT" }]).headerMedia).toBe("document");
    expect(templateFillNeeds(null)).toEqual({ headerText: false, headerMedia: null, buttonValue: false, bodyValues: 0 });
  });

  it("the chatbot engine builds through the shared builder", () => {
    expect(src("lib/chatbots/engine.ts")).toMatch(/import \{ buildTemplateComponents as buildSharedTemplate \} from "\.\/template-build"/);
    expect(src("lib/automation/v2/actions.ts")).toMatch(/from "@\/lib\/chatbots\/template-build"/);
  });
});

describe("the rule step Send template carries heading and button values (c)", () => {
  const base = { type: "send_template", templateId: "tp1", variables: [] };

  it("keeps the values it is given, trimmed, and leaves out empty ones", () => {
    expect(parseAction({ ...base, headerMediaUrl: " https://cdn.example.com/p.jpg ", headerVariable: " A-1 ", buttonVariable: "{{attribute.order}}" })).toEqual({
      ok: true,
      value: { ...base, headerMediaUrl: "https://cdn.example.com/p.jpg", headerVariable: "A-1", buttonVariable: "{{attribute.order}}" },
    });
    expect(parseAction({ ...base, headerMediaUrl: "{{attribute.photo}}" })).toMatchObject({ ok: true, value: { headerMediaUrl: "{{attribute.photo}}" } });
    expect(parseAction({ ...base, headerMediaUrl: "", headerVariable: "  ", buttonVariable: null })).toEqual({ ok: true, value: base });
  });

  it("refuses a picture link that is not https, and values that are too long", () => {
    expect(parseAction({ ...base, headerMediaUrl: "http://cdn.example.com/p.jpg" })).toEqual({ ok: false, error: "The link to the picture, video or file must start with https://." });
    expect(parseAction({ ...base, headerMediaUrl: "photo.jpg" })).toMatchObject({ ok: false });
    expect(parseAction({ ...base, headerVariable: "x".repeat(201) })).toEqual({ ok: false, error: "The heading value can be up to 200 characters." });
    expect(parseAction({ ...base, buttonVariable: 5 })).toEqual({ ok: false, error: "The button link value can be up to 200 characters." });
  });

  it("names the field a problem is about, so it shows under that field", () => {
    expect(actionProblem({ ...base, headerMediaUrl: "ftp://x" } as Action)).toEqual({ field: "headerMediaUrl", message: "The link to the picture, video or file must start with https://." });
    expect(actionProblem({ ...base, headerVariable: "x".repeat(201) } as Action)?.field).toBe("headerVariable");
    expect(actionProblem({ ...base, buttonVariable: "x".repeat(201) } as Action)?.field).toBe("buttonVariable");
    expect(actionProblem({ ...base, templateId: "" } as Action)?.field).toBe("template");
  });
});

const OPTIONS: Options = {
  ...EMPTY_OPTIONS,
  templates: [
    { id: "tp1", name: "Promo", language: "en", category: "MARKETING", variables: 1, wabaRefId: "w1", needs: { headerText: false, headerMedia: "image", buttonValue: true } },
    { id: "tp2", name: "Order update", language: "en", category: "UTILITY", variables: 0, wabaRefId: "w1", needs: { headerText: true, headerMedia: null, buttonValue: false } },
    { id: "tp3", name: "Other account", language: "en", category: "UTILITY", variables: 0, wabaRefId: "w2", needs: { headerText: false, headerMedia: null, buttonValue: false } },
    { id: "tp4", name: "Older answer", language: "hi", category: "UTILITY", variables: 0 },
  ],
  phoneNumbers: [
    { id: "pn1", displayPhone: "+91 1", verifiedName: "Shop", wabaRefId: "w1" },
    { id: "pn2", displayPhone: "+91 2", verifiedName: null, wabaRefId: "w2" },
  ],
};

describe("the rule builder's Send template step (b, c)", () => {
  const render = (action: Action, phoneNumberId: string | null, showErrors = false) =>
    renderToStaticMarkup(createElement(ActionList, { actions: [action], trigger: { type: "message_received" }, options: OPTIONS, phoneNumberId, showErrors, onMaterialCreated: () => undefined, onChange: () => undefined }));

  it("lists only the templates of the rule's number's WhatsApp account; all numbers lists them all", () => {
    expect(templatesForNumber(OPTIONS, "pn1").map((t) => t.id)).toEqual(["tp1", "tp2", "tp4"]);
    expect(templatesForNumber(OPTIONS, "pn2").map((t) => t.id)).toEqual(["tp3", "tp4"]);
    expect(templatesForNumber(OPTIONS, null).map((t) => t.id)).toEqual(["tp1", "tp2", "tp3", "tp4"]);
    expect(templatesForNumber(OPTIONS, "gone").map((t) => t.id)).toEqual(["tp1", "tp2", "tp3", "tp4"]);
    const html = render({ type: "send_template", templateId: "", variables: [] }, "pn1");
    expect(html).toContain("Promo (en)");
    expect(html).not.toContain("Other account");
    expect(html).toContain("Only approved templates of this number&#x27;s WhatsApp Business account are listed.");
  });

  it("the rule form passes the rule's number to the step list", () => {
    expect(src("components/automation/RuleBuilder.tsx")).toMatch(/<ActionList [^>]*phoneNumberId=\{draft\.phoneNumberId\}/);
  });

  it("asks for the heading picture link and the button value the template needs, like the chatbot builder", () => {
    const html = render({ type: "send_template", templateId: "tp1", variables: [""] }, null);
    expect(html).toContain("Link to the picture at the top");
    expect(html).toContain("Value for {{1}}");
    expect(html).toContain("Value for the button link");
    expect(html).not.toContain("Value for the heading");
    expect(render({ type: "send_template", templateId: "tp2", variables: [] }, null)).toContain("Value for the heading");
    // An older server answer without needs shows no extra fields.
    expect(render({ type: "send_template", templateId: "tp4", variables: [] }, null)).not.toContain("Link to the");
  });

  it("after Create rule, shows what is missing under its field, and a template of another account under the template", () => {
    const missing = render({ type: "send_template", templateId: "tp1", variables: ["x"] }, null, true);
    expect(missing).toContain("Add the link to the picture at the top of this template.");
    expect(templateFillProblem({ type: "send_template", templateId: "tp1", variables: ["x"], headerMediaUrl: "https://x.example.com/p.jpg" }, OPTIONS, null)).toEqual({
      field: "buttonVariable",
      message: "Fill in the value for the template's button link.",
    });
    expect(templateFillProblem({ type: "send_template", templateId: "tp2", variables: [] }, OPTIONS, "pn1")).toEqual({ field: "headerVariable", message: "Fill in the value for the template's heading." });
    const foreign = render({ type: "send_template", templateId: "tp3", variables: [] }, "pn1", true);
    // The chosen template stays in the list so the select can show it, with the reason under it.
    expect(foreign).toMatch(/<option value="tp3" selected="">Other account \(en\)<\/option>/);
    expect(foreign).toContain("&quot;Other account&quot; belongs to a different WhatsApp Business account than this rule&#x27;s number.");
    expect(templateFillProblem({ type: "send_template", templateId: "tp1", variables: ["x"], headerMediaUrl: "https://x.example.com/p.jpg", buttonVariable: "A" }, OPTIONS, "pn1")).toBeNull();
    expect(templateFillProblem({ type: "add_tag", tag: "x", scope: "both" }, OPTIONS, "pn1")).toBeNull();
  });

  it("choosing another template keeps only the values the new one has a gap for", () => {
    const step = { type: "send_template" as const, templateId: "tp1", variables: ["Asha"], headerMediaUrl: "https://x.example.com/p.jpg", buttonVariable: "A-1", headerVariable: "old" };
    expect(withTemplate(step, OPTIONS.templates[1])).toEqual({ type: "send_template", templateId: "tp2", variables: [], headerVariable: "old" });
    expect(withTemplate(step, OPTIONS.templates[0])).toEqual({ type: "send_template", templateId: "tp1", variables: ["Asha"], headerMediaUrl: "https://x.example.com/p.jpg", buttonVariable: "A-1" });
    expect(withTemplate(step, undefined)).toEqual({ type: "send_template", templateId: "", variables: [] });
  });
});

describe("templates a rule can never send are greyed out, refused on save and logged with the same reason (c)", () => {
  const body = { type: "BODY", text: "Hi {{1}}" };
  const instead = "Choose another template, or send this one from a broadcast.";

  it("a coupon-code button and named values, which only a broadcast's value mapping fills", () => {
    expect(ruleTemplateProblem([body, { type: "BUTTONS", buttons: [{ type: "COPY_CODE", example: "SAVE10" }] }])).toEqual({
      short: "has a coupon code button",
      long: "has a coupon code button, which a rule cannot fill in yet",
      instead,
    });
    expect(ruleTemplateProblem([{ type: "BODY", text: "Hi {{first_name}}, order {{order_id}} is ready" }])).toEqual({
      short: "has named values like {{first_name}}",
      long: "has named values like {{first_name}}, which a rule cannot fill in yet",
      instead,
    });
    expect(ruleTemplateProblem([{ type: "HEADER", format: "TEXT", text: "Hi {{ name }}" }, { type: "BODY", text: "Thanks" }])?.short).toBe("has named values like {{name}}");
  });

  it("login codes, carousels, special buttons and headings, and mixed values, which nothing here can send", () => {
    const other = "Choose another template.";
    expect(ruleTemplateProblem([{ type: "BODY", text: "{{1}} is your code." }, { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] }])).toEqual({
      short: "is a login-code template",
      long: "is a login-code template, which sends a new code to one person at a time",
      instead: other,
    });
    // Meta lists a synced login-code button as a URL button with the WhatsApp OTP link.
    expect(ruleTemplateProblem([{ type: "BODY", text: "{{1}}" }, { type: "BUTTONS", buttons: [{ type: "URL", url: "https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code_expiration_minutes=10" }] }])?.short).toBe("is a login-code template");
    expect(ruleTemplateProblem([body, { type: "CAROUSEL", cards: [] }])).toEqual({ short: "is a carousel or limited-time-offer template", long: "is a carousel or limited-time-offer template, which a rule cannot send", instead: other });
    expect(ruleTemplateProblem([body, { type: "LIMITED_TIME_OFFER", limited_time_offer: { text: "Ends soon" } }])?.short).toBe("is a carousel or limited-time-offer template");
    expect(ruleTemplateProblem([body, { type: "BUTTONS", buttons: [{ type: "FLOW", text: "Book" }] }])).toMatchObject({ short: "has a form, catalog or other special button", instead: other });
    expect(ruleTemplateProblem([body, { type: "BUTTONS", buttons: [{ type: "CATALOG", text: "View" }] }])?.short).toBe("has a form, catalog or other special button");
    expect(ruleTemplateProblem([{ type: "HEADER", format: "LOCATION" }, body])?.short).toBe("has a location or another kind of heading");
    expect(ruleTemplateProblem([{ type: "BODY", text: "Hi {{1}}, {{name}}" }])?.short).toBe("mixes numbered and named values");
    expect(ruleTemplateProblem([{ type: "BODY", text: "{{21}}" }])).toEqual({ short: "has too many values", long: "has more values than a rule can fill in", instead });
  });

  it("leaves alone what a rule fills in: numbered values, a heading picture or value, link buttons, quick replies and calls", () => {
    expect(ruleTemplateProblem(IMAGE_AND_BUTTON)).toBeNull();
    expect(ruleTemplateProblem([{ type: "HEADER", format: "TEXT", text: "Order {{1}}" }, body, { type: "BUTTONS", buttons: [{ type: "PHONE_NUMBER", text: "Call us", phone_number: "+911234567890" }] }])).toBeNull();
    expect(ruleTemplateProblem([{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "Watch" }])).toBeNull();
    expect(ruleTemplateProblem(null)).toBeNull();
  });

  it("the options list, the save check and the run log all ask the same checker, built on the broadcasts one", () => {
    const service = src("lib/automation/v2/service.ts");
    expect(service.match(/ruleTemplateProblem\(t\.components\)/g)).toHaveLength(2);
    expect(service).toMatch(/sendable: !problem,\s*\.\.\.\(problem \? \{ reason: problem\.short, instead: problem\.instead \} : \{\}\)/);
    expect(service).toMatch(/`The template "\$\{t\.name\}" \$\{problem\.long\}\. \$\{problem\.instead\}`/);
    expect(service).not.toMatch(/templateSendProblem/);
    expect(src("lib/automation/v2/actions.ts")).toMatch(/const problem = ruleTemplateProblem\(components\);\s*return problem \? `the template \$\{problem\.long\}` : null;/);
    expect(src("lib/automation/v2/template-check.ts")).toMatch(/if \(broadcastSupportReason\(all\)\)/);
  });

  it("the step shows the reason and what to do instead under the template", () => {
    const options = {
      ...EMPTY_OPTIONS,
      // As /api/automation/options sends it: sendable, reason and instead come on top of the Options shape.
      templates: [{ id: "tp9", name: "Coupon", language: "en", category: "MARKETING", variables: 0, sendable: false, reason: "has a coupon code button", instead }],
    } as unknown as Options;
    const html = renderToStaticMarkup(createElement(ActionList, { actions: [{ type: "send_template", templateId: "tp9", variables: [] }], trigger: { type: "message_received" }, options, phoneNumberId: null, onMaterialCreated: () => undefined, onChange: () => undefined }));
    expect(html).toContain("Coupon (en): rules cannot send it, it has a coupon code button");
    expect(html).toContain("A rule cannot send &quot;Coupon&quot;: it has a coupon code button. Choose another template, or send this one from a broadcast.");
  });
});

describe("converting a classic rule (d)", () => {
  it("keeps the rule quiet while a teammate handles the chat, as the classic reply was", () => {
    const def = convertDefinition({ type: "keyword", keywords: ["price"], matchMode: "contains", replyText: "Prices!", schedule: null, cooldownMinutes: 5 });
    expect(def.filters.options.allowWhenHumanActive).toBe(false);
    const welcome = convertDefinition({ type: "welcome", keywords: [], matchMode: "contains", replyText: "Hi", schedule: null, cooldownMinutes: 720 });
    expect(welcome.filters.options.allowWhenHumanActive).toBe(false);
    expect(src("lib/automation/v2/service.ts")).not.toMatch(/allowWhenHumanActive = true/);
  });

  it("the dialog says it still stays quiet then, and names only the two real changes", () => {
    expect(CONVERT_BODY).toContain("It keeps the same conditions, reply and waiting time, and it still stays quiet while a teammate is handling the chat.");
    expect(CONVERT_BODY).toContain("Two things change: each run counts toward your monthly rule runs, and it goes to the end of your new-format rules");
    expect(CONVERT_BODY).not.toMatch(/also replies while a teammate|Three things change|Reply even while a person/);
  });
});

describe("types (e)", () => {
  it("the agent's Reply when includes when_started, without a local widening in the page", () => {
    const activation: Agent["activation"] = "when_started";
    expect(activation).toBe("when_started");
    const view = src("components/ai-agent/AiAgentView.tsx");
    expect(view).not.toMatch(/Agent\["activation"\] \| "when_started"/);
    expect(view).not.toMatch(/as Activation/);
  });

  it("a wait step's data carries onReply, and the inspector reads it without a cast", () => {
    const data: NodeDataMap["delay"] = { minutes: 60, onReply: "pass" };
    expect(data.onReply).toBe("pass");
    expect(src("components/chatbots/Inspector.tsx")).not.toMatch(/as \{ onReply\?: string \}/);
  });
});

describe("the chatbot preview follows a wait step's onReply (e)", () => {
  const flow = (onReply?: "continue" | "pass"): FlowDefinition => ({
    version: 1,
    start: "w",
    nodes: [
      { id: "w", type: "delay", position: { x: 0, y: 0 }, data: { minutes: 60, ...(onReply ? { onReply } : {}) } } as FlowNode,
      { id: "t", type: "send_text", position: { x: 0, y: 0 }, data: { text: "You said: {{last_reply}}" } },
    ],
    edges: [{ id: "e1", from: "w", to: "t" }],
  });
  const texts = (s: { messages: { text: string }[] }) => s.messages.map((m) => m.text);

  it("continue: the preview waits; a reply ends the wait at once and is saved as {{last_reply}}", () => {
    const waiting = startPreview(flow("continue"));
    expect(waiting.status).toBe("waiting");
    expect(waiting.waiting).toEqual({ kind: "delay", nodeId: "w" });
    expect(texts(waiting).join(" ")).toMatch(/A reply from the customer ends the wait early/);
    const after = reply(flow("continue"), waiting, { text: "Tomorrow works" });
    expect(after.variables.last_reply).toBe("Tomorrow works");
    expect(texts(after)).toContain("You said: Tomorrow works");
    expect(texts(after)).toContain("The customer wrote during the wait, so the bot goes on now.");
    expect(after.status).toBe("ended");
    // An empty reply changes nothing.
    expect(reply(flow("continue"), waiting, { text: "  " })).toBe(waiting);
  });

  it("continue: letting the wait end goes on without a reply", () => {
    const after = reply(flow("continue"), startPreview(flow("continue")), { endWait: true });
    expect(texts(after)).toContain("The wait ended.");
    expect(texts(after)).toContain("You said: ");
    expect(after.variables.last_reply).toBeUndefined();
  });

  it("pass and the default keep the wait skipped, and say what a message during it does", () => {
    const pass = startPreview(flow("pass"));
    expect(pass.waiting).toBeNull();
    expect(texts(pass).join(" ")).toMatch(/goes to chat routing and rules; nothing answers it/);
    const keep = startPreview(flow());
    expect(texts(keep).join(" ")).toMatch(/The bot keeps any message sent during the wait/);
  });

  it("the preview panel offers to let the wait end, and shows menu buttons only while a menu waits", () => {
    const panel = src("components/chatbots/PreviewPanel.tsx");
    expect(panel).toMatch(/waiting\?\.kind === "delay"[\s\S]*Let the wait end/);
    expect(panel).toMatch(/waiting\.kind === "buttons" \|\| waiting\.kind === "list"/);
  });
});

describe("docs (g, h)", () => {
  it("the live chatbot route says what aiPaused means", () => {
    expect(src("app/api/chatbots/live/route.ts")).toMatch(/aiPaused: true when the AI agent is paused in this chat/);
  });

  it("messageTemplates/send explains named placeholders, coupon codes and login codes", () => {
    const send = ENDPOINTS.find((e) => e.id === "templates.send")!;
    const recipients = send.body!.find((f) => f.name === "recipients")!.description;
    expect(recipients).toMatch(/a template with named placeholders such as \{\{first_name\}\} takes them by name/);
    expect(recipients).toMatch(/or the code of a coupon-code button/);
    expect(recipients).toMatch(/A login-code \(authentication\) template takes the code as custom_params \{\{1\}\}/);
    expect(recipients).toMatch(/its copy-code button gets the same code unless button_params gives one/);
    expect(send.summary).toMatch(/a coupon-code button or a login code/);
  });
});

describe("leads from a WhatsApp ad (j)", () => {
  it("are labelled as such in the list, the board and the drawer", () => {
    expect(leadOrigin({ source: "ctwa", form: null })).toBe(CTWA_LABEL);
    expect(CTWA_LABEL).toBe("From a WhatsApp ad");
    expect(leadOrigin({ source: "meta_lead_form", form: { id: "f1", name: "Diwali offer" } })).toBe("Diwali offer");
    expect(leadOrigin({ source: "meta_lead_form", form: null })).toBe("Lead form");
    expect(src("components/leads/LeadsView.tsx")).toMatch(/header: "Came from", accessor: \(r\) => leadOrigin\(r\)/);
    expect(src("components/leads/PipelineBoard.tsx")).toMatch(/\{leadOrigin\(lead\)\}/);
    expect(src("components/leads/LeadDrawer.tsx")).toMatch(/lead\.source === "ctwa" && <Badge tone="info">\{CTWA_LABEL\}<\/Badge>/);
  });

  it("the Permission to message note follows the contact's own opt-in, like the badge above it", () => {
    expect(consentNote({ source: "ctwa", needsOptIn: true })).toBe("Writing to you from an ad is not agreement to marketing messages, so only service messages will be sent until they agree.");
    expect(consentNote({ source: "ctwa", needsOptIn: false })).toBe("They have already agreed to marketing messages. Writing to you from an ad did not change that.");
    expect(consentNote({ source: "meta_lead_form", needsOptIn: true })).toMatch(/^No proof that this lead agreed to marketing messages was saved, so only service messages will be sent\./);
    expect(consentNote({ source: "meta_lead_form", needsOptIn: false })).toMatch(/^They have already agreed to marketing messages, so marketing messages can be sent\. This form saved no consent wording\./);
    const drawer = src("components/leads/LeadDrawer.tsx");
    expect(drawer).toMatch(/<p className="text-muted">\{consentNote\(lead\)\}<\/p>/);
    expect(drawer).toMatch(/<ConsentBadge needsOptIn=\{lead\.needsOptIn\} \/>/);
  });

  it("the inbox contact panel offers Mark as qualified and Mark as sale for the contact's lead", () => {
    expect(leadQuickActions("new")).toEqual([
      { status: "qualified", label: "Mark as qualified" },
      { status: "won", label: "Mark as sale" },
    ]);
    expect(leadQuickActions("contacted").map((a) => a.status)).toEqual(["qualified", "won"]);
    expect(leadQuickActions("qualified")).toEqual([{ status: "won", label: "Mark as sale" }]);
    expect(leadQuickActions("won")).toEqual([]);
    const panel = src("components/inbox/SidePanel.tsx");
    // The leads API PATCH queues the QualifiedLead and Purchase conversions; the result is announced politely.
    expect(panel).toMatch(/apiFetch\(`\/api\/leads\/\$\{leadId\}`, \{ method: "PATCH", body: \{ status: next \} \}\)/);
    expect(panel).toMatch(/<p role="status" aria-live="polite" className="text-muted">\{leadNote\}<\/p>/);
  });
});

describe("calendars open on the planned day (k)", () => {
  it("content: after a post is saved with a time, the calendar opens on its month or week with its day picked", () => {
    const at = new Date(2026, 11, 3, 9, 30);
    expect(calendarFocus(at.toISOString())).toEqual({ anchor: at, selectedKey: dayKey(at) });
    expect(calendarFocus(undefined)).toBeNull();
    expect(calendarFocus("not a date")).toBeNull();
    const view = src("components/content/ContentView.tsx");
    expect(view).toMatch(/onDone=\{\(scheduledAt\) => \{[\s\S]*calendarFocus\(scheduledAt\)[\s\S]*setAnchor\(focus\.anchor\)/);
    expect(src("components/content/Composer.tsx")).toMatch(/onDone\(at\)/);
  });

  it("broadcasts: ?date= opens the calendar on that month; the wizard's Cancel goes back with the day", () => {
    expect(monthOfDateParam("2026-12-24")).toEqual({ year: 2026, month: 11 });
    expect(monthOfDateParam("2026-02-30")).toBeNull();
    expect(monthOfDateParam("24/12/2026")).toBeNull();
    expect(monthOfDateParam(null)).toBeNull();
    expect(src("components/broadcasts/BroadcastWizard.tsx")).toMatch(/setBackHref\(`\/app\/broadcasts\?date=\$\{date\}`\)/);
    expect(src("components/broadcasts/BroadcastsView.tsx")).toMatch(/setMode\("calendar"\)/);
  });

  it("broadcasts: scheduling one planned from a calendar day goes back to the calendar on the day it goes out", () => {
    // The local day of the time picked in the wizard, which may be in another month than the day it was planned on.
    expect(calendarHrefFor("2026-12-03T09:30")).toBe("/app/broadcasts?date=2026-12-03");
    expect(calendarHrefFor(new Date(2027, 0, 5, 23, 59))).toBe("/app/broadcasts?date=2027-01-05");
    expect(monthOfDateParam(new URLSearchParams(calendarHrefFor("2027-01-05T08:00")!.split("?")[1]).get("date"))).toEqual({ year: 2027, month: 0 });
    expect(calendarHrefFor("")).toBeNull();
    expect(calendarHrefFor("not a date")).toBeNull();
    const wizard = src("components/broadcasts/BroadcastWizard.tsx");
    expect(wizard).toMatch(/setBackHref\(`\/app\/broadcasts\?date=\$\{date\}`\);\s*setFromCalendar\(true\);/);
    expect(wizard).toMatch(/const calendar = whenMode === "later" && fromCalendar \? calendarHrefFor\(scheduledAt\) : null;/);
    // After a successful start: the calendar with the toast opening the broadcast; otherwise the broadcast page as before.
    expect(wizard).toMatch(/await apiFetch\(`\/api\/broadcasts\/\$\{draftId\}\/start`[\s\S]*if \(calendar\) \{[\s\S]*action: \{ label: "Open broadcast", onAction: \(\) => router\.push\(detail\) \}[\s\S]*router\.push\(calendar\);\s*return;\s*\}[\s\S]*router\.push\(detail\);/);
  });
});
