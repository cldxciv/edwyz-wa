import { describe, expect, it } from "vitest";
import { validateFlow } from "@/lib/chatbots/flow";
import { evaluateCondition, interpolate, validateAnswer } from "@/lib/chatbots/vars";

const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const edge = (id: string, from: string, to: string, label?: string) => ({ id, from, to, ...(label ? { label } : {}) });
const flow = (nodes: unknown[], edges: unknown[] = [], start = "a") => ({ version: 1, start, nodes, edges });
const messages = (r: ReturnType<typeof validateFlow>) => r.errors.map((e) => e.message).join(" | ");

describe("validateFlow", () => {
  it("accepts a valid flow and returns a normalized copy", () => {
    const r = validateFlow(
      flow(
        [
          node("a", "send_buttons", { text: "Pick", buttons: [{ id: "b1", title: "Sales" }, { id: "b2", title: "Support" }] }),
          node("b", "ask", { text: "Email?", variable: "email", validate: "email", maxRetries: 2 }),
          node("c", "handoff", { message: "Connecting you" }),
        ],
        [edge("e1", "a", "b", "b1"), edge("e2", "a", "c", "b2"), edge("e3", "b", "c")],
      ),
    );
    expect(r.ok).toBe(true);
    expect(r.flow?.nodes).toHaveLength(3);
  });

  it("rejects bad version, missing nodes, unknown start and unknown types", () => {
    expect(validateFlow(null).ok).toBe(false);
    expect(messages(validateFlow({ version: 2, start: "a", nodes: [], edges: [] }))).toContain("version");
    expect(messages(validateFlow(flow([node("a", "end")], [], "zzz")))).toContain("start");
    expect(messages(validateFlow(flow([node("a", "teleport")])))).toContain("unknown type");
  });

  it("enforces node, edge and text limits", () => {
    const many = Array.from({ length: 101 }, (_, i) => node(`n${i}`, "end"));
    expect(messages(validateFlow(flow(many, [], "n0")))).toContain("at most 100");
    const edges = Array.from({ length: 201 }, (_, i) => edge(`e${i}`, "a", "a"));
    expect(messages(validateFlow(flow([node("a", "end")], edges)))).toContain("at most 200");
    expect(validateFlow(flow([node("a", "send_text", { text: "x".repeat(1025) })])).ok).toBe(false);
    expect(validateFlow(flow([node("a", "send_text", { text: "x".repeat(1024) })])).ok).toBe(true);
  });

  it("rejects duplicate node and edge ids and dangling edges", () => {
    expect(messages(validateFlow(flow([node("a", "end"), node("a", "end")])))).toContain("Duplicate step");
    expect(messages(validateFlow(flow([node("a", "send_text", { text: "1" }), node("b", "end")], [edge("e", "a", "b"), edge("e", "a", "b", "x")])))).toContain("Duplicate edge");
    expect(messages(validateFlow(flow([node("a", "send_text", { text: "1" })], [edge("e", "a", "nope")])))).toContain("does not exist");
  });

  it("limits buttons and rows and checks titles", () => {
    const buttons = [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: "T" }));
    expect(validateFlow(flow([node("a", "send_buttons", { text: "x", buttons })])).ok).toBe(false);
    expect(validateFlow(flow([node("a", "send_buttons", { text: "x", buttons: [{ id: "b1", title: "x".repeat(21) }] })])).ok).toBe(false);
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: "R" }));
    expect(validateFlow(flow([node("a", "send_list", { text: "x", buttonLabel: "Go", rows })])).ok).toBe(false);
    expect(validateFlow(flow([node("a", "send_list", { text: "x", buttonLabel: "Go", rows: rows.slice(0, 10) })])).ok).toBe(true);
  });

  it("checks edge labels against the node type", () => {
    const buttons = node("a", "send_buttons", { text: "x", buttons: [{ id: "b1", title: "One" }] });
    expect(messages(validateFlow(flow([buttons, node("b", "end")], [edge("e", "a", "b", "nope")])))).toContain('"nope"');
    const cond = node("a", "condition", { variable: "x", operator: "exists" });
    expect(validateFlow(flow([cond, node("y", "end"), node("n", "end")], [edge("e1", "a", "y", "yes"), edge("e2", "a", "n", "no")])).ok).toBe(true);
    expect(validateFlow(flow([node("a", "send_text", { text: "x" }), node("b", "end"), node("c", "end")], [edge("e1", "a", "b"), edge("e2", "a", "c")])).ok).toBe(false);
  });

  it("forbids connections out of end and handoff", () => {
    expect(messages(validateFlow(flow([node("a", "end"), node("b", "end")], [edge("e", "a", "b")])))).toContain("cannot have outgoing");
  });

  it("validates delay range, ask config, status and attribute names", () => {
    expect(validateFlow(flow([node("a", "delay", { minutes: 0 })])).ok).toBe(false);
    expect(validateFlow(flow([node("a", "delay", { minutes: 10081 })])).ok).toBe(false);
    expect(validateFlow(flow([node("a", "delay", { minutes: 10080 })])).ok).toBe(true);
    expect(validateFlow(flow([node("a", "ask", { text: "q", variable: "__sent", validate: "text", maxRetries: 1 })])).ok).toBe(false);
    expect(validateFlow(flow([node("a", "ask", { text: "q", variable: "age", validate: "choice", maxRetries: 1 })])).ok).toBe(false);
    expect(validateFlow(flow([node("a", "ask", { text: "q", variable: "age", validate: "number", maxRetries: 9 })])).ok).toBe(false);
    expect(validateFlow(flow([node("a", "set_status", { status: "closed" })])).ok).toBe(false);
    expect(validateFlow(flow([node("a", "set_attribute", { attribute: "__proto__", value: "x" })])).ok).toBe(false);
  });

  it("rejects webhook URLs that are not public https", () => {
    const hook = (url: string) => validateFlow(flow([node("a", "webhook", { url, method: "POST" })])).ok;
    expect(hook("http://example.com/x")).toBe(false);
    expect(hook("https://localhost/x")).toBe(false);
    expect(hook("https://127.0.0.1/x")).toBe(false);
    expect(hook("https://169.254.169.254/latest")).toBe(false);
    expect(hook("https://user:pw@example.com/x")).toBe(false);
    expect(hook("https://example.com/x")).toBe(true);
  });

  it("warns about unreachable steps", () => {
    const r = validateFlow(flow([node("a", "end"), node("b", "end")]));
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.nodeId)).toEqual(["b"]);
  });
});

describe("variables", () => {
  const ctx = { variables: { city: "Pune", resp: { data: { id: 7 } } }, contact: { name: "Asha", phone: "+911234567890", attributes: { plan: "pro", city: "Delhi" } } };
  it("interpolates contact fields, variables and attributes", () => {
    expect(interpolate("Hi {{contact.name}} ({{contact.phone}})", ctx)).toBe("Hi Asha (+911234567890)");
    expect(interpolate("{{city}} / {{plan}} / {{contact.plan}} / {{resp.data.id}}", ctx)).toBe("Pune / pro / pro / 7");
    expect(interpolate("[{{missing}}] [{{ contact.nothing }}]", ctx)).toBe("[] []");
  });
  it("does not expose prototype properties", () => {
    expect(interpolate("{{constructor}}{{__proto__}}{{city.length}}", ctx)).toBe("");
  });
  it("escapes values for JSON bodies", () => {
    const c = { ...ctx, variables: { q: 'say "hi"\n' } };
    expect(JSON.parse(interpolate('{"q":"{{q}}"}', c, { json: true }))).toEqual({ q: 'say "hi"\n' });
  });
  it("evaluates conditions", () => {
    expect(evaluateCondition("equals", "Yes", "yes")).toBe(true);
    expect(evaluateCondition("not_equals", "a", "b")).toBe(true);
    expect(evaluateCondition("contains", "Hello World", "world")).toBe(true);
    expect(evaluateCondition("exists", "", undefined)).toBe(false);
    expect(evaluateCondition("exists", 0, undefined)).toBe(true);
    expect(evaluateCondition("gt", "10", "9")).toBe(true);
    expect(evaluateCondition("lt", "abc", "9")).toBe(false);
  });
  it("validates answers", () => {
    expect(validateAnswer("number", "1,250.5")).toEqual({ ok: true, value: "1250.5" });
    expect(validateAnswer("number", "twelve").ok).toBe(false);
    expect(validateAnswer("email", " A@B.com ")).toEqual({ ok: true, value: "a@b.com" });
    expect(validateAnswer("email", "nope").ok).toBe(false);
    expect(validateAnswer("phone", "91 98765-43210")).toEqual({ ok: true, value: "+919876543210" });
    expect(validateAnswer("phone", "12").ok).toBe(false);
    expect(validateAnswer("choice", "2", ["Red", "Blue"])).toEqual({ ok: true, value: "Blue" });
    expect(validateAnswer("choice", "red", ["Red", "Blue"])).toEqual({ ok: true, value: "Red" });
    expect(validateAnswer("choice", "green", ["Red", "Blue"]).ok).toBe(false);
    expect(validateAnswer("text", "   ").ok).toBe(false);
  });
});

describe("long waits and replies during a wait (P5)", () => {
  const wait = (minutes: number, extra: Record<string, unknown> = {}) => node("w", "delay", { minutes, ...extra });

  it("refuses a free message after a wait of 23 hours or more, and accepts a template there", () => {
    const text = validateFlow(flow([wait(23 * 60), node("b", "send_text", { text: "Still there?" })], [edge("e1", "w", "b")], "w"));
    expect(text.ok).toBe(false);
    expect(text.errors).toEqual([expect.objectContaining({ nodeId: "w", message: expect.stringMatching(/next message the bot sends must be Send template/) })]);
    expect(validateFlow(flow([wait(3 * 1440), node("b", "send_template", { templateId: "tp1", variables: {} })], [edge("e1", "w", "b")], "w")).ok).toBe(true);
    // Shorter waits, and a long wait at the end of the flow, are fine.
    expect(validateFlow(flow([wait(22 * 60 + 59), node("b", "send_text", { text: "Hi" })], [edge("e1", "w", "b")], "w")).ok).toBe(true);
    expect(validateFlow(flow([wait(2 * 1440)], [], "w")).ok).toBe(true);
  });

  it("lets steps that send nothing come between a long wait and the template", () => {
    const template = node("t", "send_template", { templateId: "tp1", variables: {} });
    // Wait a day, then mark the chat solved: nothing is sent.
    expect(validateFlow(flow([wait(1440), node("s", "set_status", { status: "solved" })], [edge("e1", "w", "s")], "w")).ok).toBe(true);
    // Wait two days, add a tag, then send a template.
    expect(validateFlow(flow([wait(2 * 1440), node("g", "add_tag", { tag: "follow-up" }), template], [edge("e1", "w", "g"), edge("e2", "g", "t")], "w")).ok).toBe(true);
    // Wait a day, check an answer: a template on one side, the end on the other.
    const check = node("c", "condition", { variable: "plan", operator: "equals", value: "pro" });
    expect(validateFlow(flow([wait(1440), check, template, node("x", "end")], [edge("e1", "w", "c"), edge("e2", "c", "t", "yes"), edge("e3", "c", "x", "no")], "w")).ok).toBe(true);
    // A hand-over without a message sends nothing either.
    expect(validateFlow(flow([wait(1440), node("h", "handoff", {})], [edge("e1", "w", "h")], "w")).ok).toBe(true);
  });

  it("finds a free message behind steps that send nothing, on any branch, and after another wait", () => {
    const refused = (nodes: unknown[], edges: unknown[]) => {
      const result = validateFlow(flow(nodes, edges, "w"));
      return !result.ok && result.errors.every((e) => e.nodeId === "w");
    };
    const text = node("b", "send_text", { text: "Still there?" });
    expect(refused([wait(1440), node("g", "add_tag", { tag: "x" }), text], [edge("e1", "w", "g"), edge("e2", "g", "b")])).toBe(true);
    const check = node("c", "condition", { variable: "plan", operator: "exists" });
    const template = node("t", "send_template", { templateId: "tp1", variables: {} });
    expect(refused([wait(1440), check, template, text], [edge("e1", "w", "c"), edge("e2", "c", "t", "yes"), edge("e3", "c", "b", "no")])).toBe(true);
    expect(refused([wait(1440), node("w2", "delay", { minutes: 30 }), text], [edge("e1", "w", "w2"), edge("e2", "w2", "b")])).toBe(true);
    expect(refused([wait(1440), node("h", "handoff", { message: "A teammate will reply." })], [edge("e1", "w", "h")])).toBe(true);
    expect(refused([wait(1440), node("u", "unsubscribe", { message: "You will not hear from us again." })], [edge("e1", "w", "u")])).toBe(true);
    expect(messages(validateFlow(flow([wait(1440), node("h", "handoff", { message: "Hi" })], [edge("e1", "w", "h")], "w")))).toMatch(/cannot have a message/);
  });

  it("does not apply the rule to a flow that is already published, so a live bot keeps running", () => {
    const live = flow([wait(2 * 1440), node("b", "send_text", { text: "Still there?" })], [edge("e1", "w", "b")], "w");
    expect(validateFlow(live).ok).toBe(false);
    expect(validateFlow(live, { published: true }).ok).toBe(true);
  });

  it("keeps the choice of what a customer's message does during a wait", () => {
    expect(validateFlow(flow([wait(10, { onReply: "continue" })], [], "w")).flow?.nodes[0].data).toEqual({ minutes: 10, onReply: "continue" });
    expect(validateFlow(flow([wait(10, { onReply: "pass" })], [], "w")).flow?.nodes[0].data).toEqual({ minutes: 10, onReply: "pass" });
    expect(validateFlow(flow([wait(10, { onReply: "wait" })], [], "w")).flow?.nodes[0].data).toEqual({ minutes: 10 });
    expect(messages(validateFlow(flow([wait(10, { onReply: "explode" })], [], "w")))).toMatch(/customer writes during the wait/);
  });
});
