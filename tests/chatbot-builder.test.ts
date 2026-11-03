import { describe, expect, it } from "vitest";
import { addNode, connect, disconnect, duplicateNode, pruneEdges, reachable, reconnectEdge, removeNode, updateNode } from "@/components/chatbots/flow";
import { NODE_W, autoLayout, freeSpot, nodeHeight } from "@/components/chatbots/layout";
import { canRedo, canUndo, commit, createHistory, redo, undo } from "@/components/chatbots/history";
import { hasErrors, LONG_WAIT_MINUTES, validateFlowIssues, validateTrigger, validateTriggerConflicts, type PublishedBot } from "@/components/chatbots/validation";
import { docFromChatbot, hasUnpublishedChanges } from "@/components/chatbots/editor";
import { evaluateCondition, interpolate, reply, startPreview, triggerMatches } from "@/components/chatbots/preview";
import { fitView, reveal, wheelZoom, zoomAt } from "@/components/chatbots/viewport";
import { NODE_TYPES, type FlowDefinition, type FlowNode, type NodeType } from "@/components/chatbots/types";
import { emptyFlow } from "@/components/chatbots/types";

function build(): { flow: FlowDefinition; ids: Record<string, string> } {
  let flow = emptyFlow();
  const ids: Record<string, string> = {};
  const add = (key: string, type: NodeType, text?: string) => {
    const r = addNode(flow, type, { x: 0, y: 0 });
    flow = r.flow;
    ids[key] = r.id as string;
    if (text !== undefined) flow = updateNode(flow, ids[key], (n) => ({ ...n, data: { ...n.data, text } }) as FlowNode);
  };
  add("hello", "send_text", "Hi {{name}}");
  add("menu", "send_buttons", "Pick one");
  add("ask", "ask", "Your email?");
  add("end", "end");
  return { flow, ids };
}

describe("flow edits", () => {
  it("makes the first node the start and caps node ids unique", () => {
    const { flow, ids } = build();
    expect(flow.start).toBe(ids.hello);
    expect(new Set(flow.nodes.map((n) => n.id)).size).toBe(4);
  });

  it("creates every node type", () => {
    let flow = emptyFlow();
    for (const t of NODE_TYPES) flow = addNode(flow, t, { x: 0, y: 0 }).flow;
    expect(flow.nodes.map((n) => n.type)).toEqual([...NODE_TYPES]);
  });

  it("connect replaces the edge on the same handle and ignores self links", () => {
    const { flow, ids } = build();
    let f = connect(flow, ids.menu, "b1", ids.ask);
    f = connect(f, ids.menu, "b1", ids.end);
    expect(f.edges).toHaveLength(1);
    expect(f.edges[0]).toMatchObject({ from: ids.menu, to: ids.end, label: "b1" });
    expect(connect(f, ids.menu, "b2", ids.menu)).toBe(f);
  });

  it("reconnects an edge target and keeps its label", () => {
    const { flow, ids } = build();
    let f = connect(flow, ids.menu, "b2", ids.ask);
    f = reconnectEdge(f, f.edges[0].id, ids.end);
    expect(f.edges[0]).toMatchObject({ to: ids.end, label: "b2", from: ids.menu });
    expect(reconnectEdge(f, f.edges[0].id, ids.menu)).toBe(f);
    expect(reconnectEdge(f, "missing", ids.end)).toBe(f);
  });

  it("prunes edges when a button is removed", () => {
    const { flow, ids } = build();
    let f = connect(flow, ids.menu, "b2", ids.end);
    f = updateNode(f, ids.menu, (n) => (n.type === "send_buttons" ? { ...n, data: { ...n.data, buttons: n.data.buttons.slice(0, 1) } } : n));
    expect(f.edges).toHaveLength(0);
    expect(pruneEdges(f)).toBe(f);
  });

  it("removing a node drops its edges and moves the start", () => {
    const { flow, ids } = build();
    let f = connect(flow, ids.hello, undefined, ids.menu);
    f = removeNode(f, ids.hello);
    expect(f.edges).toHaveLength(0);
    expect(f.start).toBe(ids.menu);
    expect(removeNode(removeNode(removeNode(f, ids.menu), ids.ask), ids.end).start).toBe("");
  });

  it("duplicates a node with an offset, a new id and no edges", () => {
    const { flow, ids } = build();
    const r = duplicateNode(connect(flow, ids.hello, undefined, ids.menu), ids.menu);
    expect(r.id).not.toBeNull();
    const copy = r.flow.nodes.find((n) => n.id === r.id) as FlowNode;
    expect(copy.type).toBe("send_buttons");
    expect(r.flow.edges).toHaveLength(1);
    (copy.data as { buttons: { title: string }[] }).buttons[0].title = "changed";
    expect((flow.nodes.find((n) => n.id === ids.menu)?.data as { buttons: { title: string }[] }).buttons[0].title).toBe("Yes");
  });

  it("disconnect removes only that handle", () => {
    const { flow, ids } = build();
    let f = connect(flow, ids.menu, "b1", ids.end);
    f = connect(f, ids.menu, "b2", ids.ask);
    expect(disconnect(f, ids.menu, "b1").edges.map((e) => e.label)).toEqual(["b2"]);
  });
});

describe("auto layout", () => {
  it("places nodes in columns by depth without overlap", () => {
    const { flow, ids } = build();
    let f = connect(flow, ids.hello, undefined, ids.menu);
    f = connect(f, ids.menu, "b1", ids.ask);
    f = connect(f, ids.menu, "b2", ids.end);
    const out = autoLayout(f);
    const x = (id: string) => out.nodes.find((n) => n.id === id)?.position.x as number;
    expect(x(ids.hello)).toBeLessThan(x(ids.menu));
    expect(x(ids.menu)).toBeLessThan(x(ids.ask));
    expect(x(ids.ask)).toBe(x(ids.end));
    const a = out.nodes.find((n) => n.id === ids.ask) as FlowNode;
    const e = out.nodes.find((n) => n.id === ids.end) as FlowNode;
    expect(Math.abs(a.position.y - e.position.y)).toBeGreaterThanOrEqual(Math.min(nodeHeight(a), nodeHeight(e)));
    expect(f.nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it("puts unreachable nodes in a trailing column", () => {
    const { flow, ids } = build();
    const out = autoLayout(connect(flow, ids.hello, undefined, ids.menu));
    const x = (id: string) => out.nodes.find((n) => n.id === id)?.position.x as number;
    expect(x(ids.ask)).toBeGreaterThan(x(ids.menu));
    expect(x(ids.menu) - x(ids.hello)).toBeGreaterThan(NODE_W);
  });

  it("terminates on cycles", () => {
    const { flow, ids } = build();
    let f = connect(flow, ids.hello, undefined, ids.ask);
    f = connect(f, ids.ask, undefined, ids.hello);
    expect(autoLayout(f).nodes).toHaveLength(4);
  });

  it("a new step goes to a free place: where it was asked for when that is empty, otherwise below the steps in the way", () => {
    const { flow } = build();
    const laid = autoLayout(flow);
    const overlaps = (f: FlowDefinition, p: { x: number; y: number }, h: number) =>
      f.nodes.some((n) => p.x < n.position.x + NODE_W && n.position.x < p.x + NODE_W && p.y < n.position.y + nodeHeight(n) && n.position.y < p.y + h);
    // far from everything: unchanged
    expect(freeSpot(laid, { x: 5000, y: 5000 }, 84)).toEqual({ x: 5000, y: 5000 });
    // right on top of the existing steps (the "Ask a question" over "Hand over" case): moved clear of every one of them
    for (const n of laid.nodes) {
      const spot = freeSpot(laid, n.position, 84);
      expect(spot.x).toBe(n.position.x);
      expect(spot.y).toBeGreaterThan(n.position.y);
      expect(overlaps(laid, spot, 84)).toBe(false);
    }
    // a whole stack of steps in one column: the new one ends up under the last
    const stack = { ...laid, nodes: laid.nodes.map((n, i) => ({ ...n, position: { x: 0, y: i * 90 } }) as FlowNode) };
    const below = freeSpot(stack, { x: 10, y: 10 }, 84);
    expect(overlaps(stack, below, 84)).toBe(false);
    expect(freeSpot(emptyFlow(), { x: 1, y: 2 }, 84)).toEqual({ x: 1, y: 2 });
  });
});

describe("viewport", () => {
  it("zoom keeps the anchor point fixed and clamps", () => {
    const v = zoomAt({ x: 10, y: 20, k: 1 }, 2, 100, 100);
    expect(v.k).toBe(2);
    expect((100 - v.x) / v.k).toBeCloseTo((100 - 10) / 1);
    expect(zoomAt({ x: 0, y: 0, k: 1 }, 100, 0, 0).k).toBe(2);
    expect(zoomAt({ x: 0, y: 0, k: 1 }, 0.001, 0, 0).k).toBe(0.25);
  });

  it("a plain mouse wheel scrolls the page; only Ctrl or Cmd with the wheel (or a trackpad pinch) zooms", () => {
    expect(wheelZoom({ deltaY: 100, ctrlKey: false, metaKey: false })).toBeNull();
    expect(wheelZoom({ deltaY: -100, ctrlKey: false, metaKey: false })).toBeNull();
    expect(wheelZoom({ deltaY: 100, ctrlKey: true, metaKey: false })).toBeLessThan(1);
    expect(wheelZoom({ deltaY: -100, ctrlKey: false, metaKey: true })).toBeGreaterThan(1);
  });

  it("reveal pans just enough to show a new step and leaves a step already in view alone", () => {
    const view = { x: 0, y: 0, k: 1 };
    expect(reveal(view, { x: 100, y: 100, w: 220, h: 84 }, 800, 500)).toBe(view);
    const down = reveal(view, { x: 100, y: 700, w: 220, h: 84 }, 800, 500);
    expect(down.k).toBe(1);
    expect(700 + 84 + down.y).toBeLessThanOrEqual(500 - 24);
    expect(700 + down.y).toBeGreaterThanOrEqual(24);
    const left = reveal({ x: 0, y: 0, k: 0.5 }, { x: -400, y: 10, w: 220, h: 84 }, 800, 500);
    expect(-400 * 0.5 + left.x).toBe(24);
  });

  it("fits content inside the viewport", () => {
    const { flow } = build();
    const v = fitView(autoLayout(flow), 800, 600);
    expect(v.k).toBeGreaterThan(0);
    expect(v.k).toBeLessThanOrEqual(1);
    expect(fitView(emptyFlow(), 800, 600)).toEqual({ x: 0, y: 0, k: 1 });
  });
});

describe("history", () => {
  it("undoes, redoes and clears redo on new edits", () => {
    let h = createHistory(1);
    h = commit(h, 2);
    h = commit(h, 3);
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toBe(2);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.present).toBe(3);
    h = undo(undo(h));
    h = commit(h, 9);
    expect(canRedo(h)).toBe(false);
    expect(undo(h).present).toBe(1);
  });

  it("coalesces commits with the same key and ignores no-ops", () => {
    let h = createHistory("a");
    h = commit(h, "b", "typing");
    h = commit(h, "bc", "typing");
    h = commit(h, "bcd", "typing");
    expect(h.past).toEqual(["a"]);
    expect(commit(h, h.present)).toBe(h);
    h = commit(h, "x", "other");
    expect(h.past).toEqual(["a", "bcd"]);
    expect(undo(createHistory(0)).present).toBe(0);
  });

  it("caps the stack", () => {
    let h = createHistory(0);
    for (let i = 1; i <= 150; i++) h = commit(h, i);
    expect(h.past).toHaveLength(100);
  });
});

describe("validation", () => {
  it("reports an empty flow and a missing start", () => {
    expect(validateFlowIssues(emptyFlow())[0].message).toMatch(/no steps/);
    const { flow } = build();
    const issues = validateFlowIssues({ ...flow, start: "" });
    expect(issues.some((i) => /no start/.test(i.message))).toBe(true);
  });

  it("flags empty text, too many buttons and unreachable nodes", () => {
    const { flow, ids } = build();
    let f = updateNode(flow, ids.menu, (n) =>
      n.type === "send_buttons"
        ? { ...n, data: { ...n.data, text: "ok", buttons: ["a", "b", "c", "d"].map((t) => ({ id: t, title: t })) } }
        : n,
    );
    f = updateNode(f, ids.hello, (n) => ({ ...n, data: { text: "  " } }) as FlowNode);
    f = connect(f, ids.hello, undefined, ids.menu);
    const issues = validateFlowIssues(f);
    expect(issues.find((i) => i.nodeId === ids.hello && /empty/.test(i.message))?.severity).toBe("error");
    expect(issues.some((i) => i.nodeId === ids.menu && /Too many buttons/.test(i.message))).toBe(true);
    expect(issues.find((i) => i.nodeId === ids.end && /cannot be reached/.test(i.message))?.severity).toBe("warning");
    expect(hasErrors(issues)).toBe(true);
  });

  it("passes a valid small flow", () => {
    const { flow, ids } = build();
    let f = updateNode(flow, ids.menu, (n) => ({ ...n, data: { ...n.data, text: "Pick" } }) as FlowNode);
    f = updateNode(f, ids.ask, (n) => ({ ...n, data: { ...n.data, text: "Email?" } }) as FlowNode);
    f = updateNode(f, ids.hello, (n) => ({ ...n, data: { text: "Hello" } }) as FlowNode);
    f = connect(connect(connect(connect(f, ids.hello, undefined, ids.menu), ids.menu, "b1", ids.ask), ids.menu, "b2", ids.end), ids.ask, undefined, ids.end);
    expect(hasErrors(validateFlowIssues(f))).toBe(false);
    expect(validateFlowIssues(f).filter((i) => i.severity === "warning")).toHaveLength(0);
  });

  it("validates webhook urls and trigger settings", () => {
    let f = addNode(emptyFlow(), "webhook", { x: 0, y: 0 }).flow;
    expect(validateFlowIssues(f).some((i) => /https/.test(i.message))).toBe(true);
    f = updateNode(f, "n1", (n) => ({ ...n, data: { ...n.data, url: "https://example.com/hook" } }) as FlowNode);
    expect(validateFlowIssues(f).some((i) => /https/.test(i.message))).toBe(false);
    expect(validateTrigger("keyword", [], "Bot")).toHaveLength(1);
    expect(validateTrigger("manual", [], "")).toHaveLength(1);
    expect(validateTrigger("any_message", [], "Bot")).toHaveLength(0);
  });

  it("reachable follows edges", () => {
    const { flow, ids } = build();
    expect([...reachable(connect(flow, ids.hello, undefined, ids.menu))].sort()).toEqual([ids.hello, ids.menu].sort());
  });
});

describe("preview walker", () => {
  function demo(): { flow: FlowDefinition; ids: Record<string, string> } {
    const { flow, ids } = build();
    let f = updateNode(flow, ids.hello, (n) => ({ ...n, data: { text: "Welcome" } }) as FlowNode);
    f = updateNode(f, ids.menu, (n) => ({ ...n, data: { ...n.data, text: "Sales or support?" } }) as FlowNode);
    f = updateNode(f, ids.ask, (n) => ({ ...n, data: { text: "Your email?", variable: "email", validate: "email", retryText: "Try again", maxRetries: 1 } }) as FlowNode);
    f = connect(connect(connect(connect(f, ids.hello, undefined, ids.menu), ids.menu, "b1", ids.ask), ids.menu, "b2", ids.end), ids.ask, undefined, ids.end);
    return { flow: f, ids };
  }

  it("runs until the first question and waits", () => {
    const { flow } = demo();
    const s = startPreview(flow);
    expect(s.status).toBe("waiting");
    expect(s.messages.map((m) => m.text)).toEqual(["Welcome", "Sales or support?"]);
    expect(s.messages[1].options?.map((o) => o.id)).toEqual(["b1", "b2"]);
  });

  it("follows a button choice, validates the answer and finishes", () => {
    const { flow } = demo();
    let s = startPreview(flow);
    s = reply(flow, s, { optionId: "b1" });
    expect(s.waiting?.kind).toBe("ask");
    s = reply(flow, s, { text: "nope" });
    expect(s.messages.at(-1)?.text).toBe("Try again");
    s = reply(flow, s, { text: "a@b.co" });
    expect(s.variables.email).toBe("a@b.co");
    expect(s.status).toBe("ended");
  });

  it("stops after too many invalid answers", () => {
    const { flow } = demo();
    let s = reply(flow, startPreview(flow), { optionId: "b1" });
    s = reply(flow, s, { text: "x" });
    s = reply(flow, s, { text: "y" });
    expect(s.status).toBe("ended");
    expect(s.messages.at(-1)?.text).toMatch(/Too many invalid/);
  });

  it("accepts a typed button title and rejects unknown text", () => {
    const { flow } = demo();
    const s0 = startPreview(flow);
    const bad = reply(flow, s0, { text: "banana" });
    expect(bad.status).toBe("waiting");
    expect(reply(flow, s0, { text: "no" }).status).toBe("ended");
  });

  it("branches on conditions and interpolates variables", () => {
    let f = addNode(emptyFlow(), "ask", { x: 0, y: 0 }).flow;
    f = updateNode(f, "n1", (n) => ({ ...n, data: { text: "Age?", variable: "age", validate: "number", maxRetries: 0 } }) as FlowNode);
    f = addNode(f, "condition", { x: 0, y: 0 }).flow;
    f = updateNode(f, "n2", (n) => ({ ...n, data: { variable: "age", operator: "gt", value: "17" } }) as FlowNode);
    f = addNode(f, "send_text", { x: 0, y: 0 }).flow;
    f = updateNode(f, "n3", (n) => ({ ...n, data: { text: "Adult {{age}}" } }) as FlowNode);
    f = addNode(f, "handoff", { x: 0, y: 0 }).flow;
    f = connect(connect(connect(connect(f, "n1", undefined, "n2"), "n2", "yes", "n3"), "n2", "no", "n4"), "n3", undefined, "n4");
    const adult = reply(f, startPreview(f), { text: "30" });
    expect(adult.messages.some((m) => m.text === "Adult 30")).toBe(true);
    expect(adult.status).toBe("handoff");
    const minor = reply(f, startPreview(f), { text: "5" });
    expect(minor.messages.some((m) => m.text.startsWith("Adult"))).toBe(false);
  });

  it("stops loops that never wait", () => {
    let f = addNode(emptyFlow(), "send_text", { x: 0, y: 0 }).flow;
    f = connect(addNode(f, "send_text", { x: 0, y: 0 }).flow, "n1", undefined, "n2");
    f = connect(f, "n2", undefined, "n1");
    const s = startPreview(f);
    expect(s.status).toBe("ended");
    expect(s.messages.some((m) => /loops/.test(m.text))).toBe(true);
  });

  it("handles a flow with no start", () => {
    expect(startPreview(emptyFlow()).status).toBe("ended");
  });

  it("matches triggers", () => {
    expect(triggerMatches("keyword", ["Price", " "], "what is the PRICE?", false)).toBe(true);
    expect(triggerMatches("keyword", ["price"], "hello", false)).toBe(false);
    expect(triggerMatches("first_message", [], "x", true)).toBe(true);
    expect(triggerMatches("first_message", [], "x", false)).toBe(false);
    expect(triggerMatches("any_message", [], "x", false)).toBe(true);
    expect(triggerMatches("manual", [], "x", true)).toBe(false);
  });

  it("evaluates operators and interpolation", () => {
    expect(evaluateCondition("equals", " Yes ", "yes")).toBe(true);
    expect(evaluateCondition("exists", undefined, "")).toBe(false);
    expect(evaluateCondition("lt", "3", "10")).toBe(true);
    expect(evaluateCondition("contains", "hello world", "wor")).toBe(true);
    expect(interpolate("Hi {{ name }} {{missing}}!", { name: "Sam" })).toBe("Hi Sam !");
  });
});

describe("restoring a deleted step", () => {
  it("puts the step, its connections and the start marker back exactly", async () => {
    const { restoreNode, snapshotNode } = await import("@/components/chatbots/flow");
    const { flow: base, ids } = build();
    let flow = connect(base, ids.hello, undefined, ids.menu);
    flow = connect(flow, ids.menu, flow.nodes.find((n) => n.id === ids.menu)!.type === "send_buttons" ? "b1" : undefined, ids.ask);
    const snap = snapshotNode(flow, ids.hello)!;
    const after = removeNode(flow, ids.hello);
    expect(after.nodes.some((n) => n.id === ids.hello)).toBe(false);
    const back = restoreNode(after, snap);
    expect(back.nodes.map((n) => n.id)).toEqual(flow.nodes.map((n) => n.id));
    expect(back.edges).toEqual(expect.arrayContaining(flow.edges));
    expect(back.start).toBe(ids.hello);
  });

  it("keeps later edits and skips connections that no longer fit", async () => {
    const { restoreNode, snapshotNode } = await import("@/components/chatbots/flow");
    const { flow: base, ids } = build();
    const flow = connect(base, ids.hello, undefined, ids.menu);
    const snap = snapshotNode(flow, ids.menu)!;
    let after = removeNode(flow, ids.menu);
    after = updateNode(after, ids.ask, (n) => ({ ...n, data: { ...n.data, text: "Edited later" } }) as FlowNode);
    after = removeNode(after, ids.end);
    const back = restoreNode(after, snap);
    expect(back.nodes.find((n) => n.id === ids.ask)?.data).toMatchObject({ text: "Edited later" });
    expect(back.nodes.some((n) => n.id === ids.end)).toBe(false);
    expect(back.edges.every((e) => back.nodes.some((n) => n.id === e.from) && back.nodes.some((n) => n.id === e.to))).toBe(true);
    expect(restoreNode(back, snap)).toBe(back);
  });

  it("numbers template gaps without reusing one that is still there", async () => {
    const { nextGapKey } = await import("@/components/chatbots/flow");
    expect(nextGapKey([])).toBe("1");
    expect(nextGapKey(["1", "3"])).toBe("2");
    expect(nextGapKey(["1", "2", "3"])).toBe("4");
  });
});

describe("checks against the other chatbots", () => {
  const bot = (extra: Partial<PublishedBot>): PublishedBot => ({ id: "b1", name: "Welcome menu", status: "published", triggerType: "first_message", triggerKeywords: [], phoneNumberId: null, ...extra });
  const first = { triggerType: "first_message" as const, triggerKeywords: [], phoneNumberId: null };

  it("warns when another published bot already starts on the first message, naming it and who wins", () => {
    const issues = validateTriggerConflicts(first, "new", [bot({})]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning", tab: "settings" });
    expect(issues[0].message).toContain('"Welcome menu" is already published and also starts when a customer writes for the first time');
    expect(issues[0].message).toMatch(/Which chatbot goes first.*otherwise the older one/);
    expect(issues[0].message).not.toMatch(/first_message|_/);
    expect(hasErrors(issues)).toBe(false);
  });

  it("ignores itself, drafts, archived bots, other triggers and bots tied to another number", () => {
    expect(validateTriggerConflicts(first, "b1", [bot({})])).toHaveLength(0);
    expect(validateTriggerConflicts(first, "new", [bot({ status: "draft" }), bot({ id: "b2", status: "archived" })])).toHaveLength(0);
    expect(validateTriggerConflicts(first, "new", [bot({ triggerType: "any_message" })])).toHaveLength(0);
    expect(validateTriggerConflicts({ ...first, phoneNumberId: "pn1" }, "new", [bot({ phoneNumberId: "pn2" })])).toHaveLength(0);
    expect(validateTriggerConflicts({ ...first, phoneNumberId: "pn1" }, "new", [bot({ phoneNumberId: "pn1" }), bot({ id: "b2", phoneNumberId: null })])).toHaveLength(2);
    expect(validateTriggerConflicts({ ...first, triggerType: "manual" }, "new", [bot({ triggerType: "manual" })])).toHaveLength(0);
  });

  it("warns about shared keywords only, case-insensitively", () => {
    const mine = { triggerType: "keyword" as const, triggerKeywords: ["Price", "hours"], phoneNumberId: null };
    const issues = validateTriggerConflicts(mine, undefined, [bot({ triggerType: "keyword", triggerKeywords: ["price", "menu"] }), bot({ id: "b2", name: "Other", triggerType: "keyword", triggerKeywords: ["menu"] })]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('also starts on "price"');
    expect(issues[0].message).toMatch(/Remove the shared words/);
  });
});

describe("drafts of a published bot's trigger and long waits (P5)", () => {
  const steps: FlowDefinition = { version: 1, start: "a", nodes: [{ id: "a", type: "send_text", position: { x: 0, y: 0 }, data: { text: "Hi" } } as FlowNode], edges: [] };
  const live = { status: "published" as const, triggerType: "keyword" as const, triggerKeywords: ["hi"], phoneNumberId: null, flow: steps, publishedFlow: steps };
  const withPending = (trigger: Record<string, unknown>) => ({ ...live, flow: { ...steps, trigger } as unknown as FlowDefinition });

  it("shows the saved draft trigger in the builder, not the live one", () => {
    const doc = docFromChatbot({ name: "Bot", ...withPending({ triggerType: "any_message", triggerKeywords: [], phoneNumberId: "pn2" }) });
    expect(doc).toMatchObject({ triggerType: "any_message", triggerKeywords: [], phoneNumberId: "pn2" });
    expect(doc.flow).not.toHaveProperty("trigger");
    expect(docFromChatbot({ name: "Bot", ...live })).toMatchObject({ triggerType: "keyword", triggerKeywords: ["hi"], phoneNumberId: null });
  });

  it("counts a saved trigger change as not published yet", () => {
    expect(hasUnpublishedChanges(live)).toBe(false);
    expect(hasUnpublishedChanges(withPending({ triggerType: "any_message", triggerKeywords: [], phoneNumberId: null }))).toBe(true);
    expect(hasUnpublishedChanges(withPending({ triggerType: "keyword", triggerKeywords: ["hi", "hello"], phoneNumberId: null }))).toBe(true);
    expect(hasUnpublishedChanges(withPending({ triggerType: "keyword", triggerKeywords: ["hi"], phoneNumberId: "pn2" }))).toBe(true);
    // The same trigger as live is no change, and a bot that is not live has nothing unpublished.
    expect(hasUnpublishedChanges(withPending({ triggerType: "keyword", triggerKeywords: ["hi"], phoneNumberId: null }))).toBe(false);
    expect(hasUnpublishedChanges({ ...withPending({ triggerType: "any_message" }), status: "draft" })).toBe(false);
  });

  it("asks for a Send template step after a wait of 23 hours or more", () => {
    const flowWith = (minutes: number, next: FlowNode): FlowDefinition => ({
      version: 1,
      start: "w",
      nodes: [{ id: "w", type: "delay", position: { x: 0, y: 0 }, data: { minutes } } as FlowNode, next],
      edges: [{ id: "e1", from: "w", to: next.id }],
    });
    const text = { id: "t", type: "send_text", position: { x: 0, y: 0 }, data: { text: "Still there?" } } as FlowNode;
    const template = { id: "p", type: "send_template", position: { x: 0, y: 0 }, data: { templateId: "tp1", variables: {} } } as FlowNode;
    const long = validateFlowIssues(flowWith(LONG_WAIT_MINUTES, text)).filter((i) => i.severity === "error");
    expect(long).toEqual([expect.objectContaining({ nodeId: "w", message: expect.stringMatching(/^Wait: after a wait of 23 hours or more, the next message the bot sends must be Send template/) })]);
    expect(hasErrors(validateFlowIssues(flowWith(LONG_WAIT_MINUTES, template)))).toBe(false);
    expect(hasErrors(validateFlowIssues(flowWith(LONG_WAIT_MINUTES - 1, text)))).toBe(false);
  });

  it("matches the server: steps that send nothing may come first, a free message behind them is still an error", () => {
    const step = (id: string, type: string, data: Record<string, unknown>) => ({ id, type, position: { x: 0, y: 0 }, data }) as FlowNode;
    const chain = (...nodes: FlowNode[]): FlowDefinition => ({
      version: 1,
      start: "w",
      nodes: [step("w", "delay", { minutes: 1440 }), ...nodes],
      edges: [{ id: "e0", from: "w", to: nodes[0].id }, ...nodes.slice(1).map((n, i) => ({ id: `e${i + 1}`, from: nodes[i].id, to: n.id }))],
    });
    const longWaitErrors = (flow: FlowDefinition) => validateFlowIssues(flow).filter((i) => i.severity === "error" && /23 hours/.test(i.message));
    expect(longWaitErrors(chain(step("s", "set_status", { status: "solved" })))).toEqual([]);
    expect(longWaitErrors(chain(step("g", "add_tag", { tag: "x" }), step("p", "send_template", { templateId: "tp1", variables: {} })))).toEqual([]);
    expect(longWaitErrors(chain(step("h", "handoff", { message: "" })))).toEqual([]);
    expect(longWaitErrors(chain(step("g", "add_tag", { tag: "x" }), step("t", "send_text", { text: "Still there?" })))).toHaveLength(1);
    expect(longWaitErrors(chain(step("h", "handoff", { message: "A teammate will reply." })))).toHaveLength(1);
  });
});
