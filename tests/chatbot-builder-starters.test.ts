import { describe, expect, it } from "vitest";
import { validateFlow } from "@/lib/chatbots/flow";
import { STARTERS, getStarter, starterDoc } from "@/components/chatbots/starters";
import { hasErrors, validateFlowIssues, validateNode, validateTrigger } from "@/components/chatbots/validation";
import { docToPayload } from "@/components/chatbots/editor";
import { reply, startPreview } from "@/components/chatbots/preview";
import { describeStep, formatMinutes, savedVariables, summarize } from "@/components/chatbots/catalog";
import { durationProblem, fromDuration, toDuration } from "@/components/chatbots/duration";
import { addNode, updateNode } from "@/components/chatbots/flow";
import { emptyFlow, type FlowNode } from "@/components/chatbots/types";

describe("starter templates", () => {
  it("offers the three starters in order", () => {
    expect(STARTERS.map((s) => s.id)).toEqual(["welcome-menu", "collect-lead", "business-hours"]);
    expect(STARTERS.map((s) => s.name)).toEqual(["Welcome and menu", "Collect lead details", "Business hours reply"]);
    expect(getStarter("collect-lead")?.name).toBe("Collect lead details");
    expect(getStarter("nope")).toBeUndefined();
    expect(getStarter(undefined)).toBeUndefined();
  });

  for (const starter of STARTERS) {
    describe(starter.name, () => {
      const doc = starterDoc(starter);

      it("passes the server flow validation exactly as it will be saved", () => {
        const result = validateFlow(docToPayload(doc).flow);
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.warnings).toEqual([]);
      });

      it("has no problems in the builder checks", () => {
        const issues = [...validateTrigger(doc.triggerType, doc.triggerKeywords, doc.name), ...validateFlowIssues(doc.flow)];
        expect(issues).toEqual([]);
        expect(hasErrors(issues)).toBe(false);
      });

      it("is laid out so no two steps overlap and every step is complete", () => {
        const spots = new Set(doc.flow.nodes.map((n) => `${n.position.x},${n.position.y}`));
        expect(spots.size).toBe(doc.flow.nodes.length);
        for (const n of doc.flow.nodes) expect(validateNode(n)).toEqual([]);
      });

      it("returns independent copies each time", () => {
        const a = starterDoc(starter);
        const b = starterDoc(starter);
        expect(a).toEqual(b);
        expect(a.flow).not.toBe(b.flow);
        expect(a.flow.nodes[0]).not.toBe(b.flow.nodes[0]);
        a.triggerKeywords.push("changed");
        expect(starterDoc(starter).triggerKeywords).toEqual(starter.triggerKeywords);
      });

      it("describes what it does in plain words", () => {
        expect(starter.summary.length).toBeGreaterThan(10);
        expect(starter.steps).toHaveLength(3);
        expect(JSON.stringify(starter.steps)).not.toMatch(/webhook|payload/i);
      });
    });
  }

  it("starts the welcome menu on a first message and the others on words", () => {
    expect(starterDoc(getStarter("welcome-menu")!)).toMatchObject({ triggerType: "first_message", triggerKeywords: [] });
    for (const id of ["collect-lead", "business-hours"]) {
      const d = starterDoc(getStarter(id)!);
      expect(d.triggerType).toBe("keyword");
      expect(d.triggerKeywords.length).toBeGreaterThan(0);
    }
  });

  it("walks the welcome menu in the preview, from menu to handoff", () => {
    const flow = starterDoc(getStarter("welcome-menu")!).flow;
    let s = startPreview(flow);
    expect(s.waiting?.kind).toBe("buttons");
    expect(s.messages[0].options?.map((o) => o.title)).toEqual(["Our services", "Opening hours", "Talk to a person"]);
    s = reply(flow, s, { optionId: "b3" });
    expect(s.status).toBe("handoff");
  });

  it("collects name, email and need, retries a bad email, and hands over", () => {
    const flow = starterDoc(getStarter("collect-lead")!).flow;
    let s = startPreview(flow);
    s = reply(flow, s, { text: "Asha" });
    s = reply(flow, s, { text: "not an email" });
    expect(s.messages.at(-1)?.text).toMatch(/does not look like an email/);
    s = reply(flow, s, { text: "asha@example.com" });
    s = reply(flow, s, { text: "A quote for 20 chairs" });
    expect(s.variables).toMatchObject({ name: "Asha", email: "asha@example.com", need: "A quote for 20 chairs" });
    expect(s.messages.some((m) => m.text === "Thank you, Asha. We have your details and will get back to you soon.")).toBe(true);
    expect(s.status).toBe("handoff");
  });

  it("answers the hours question and then hands over or ends politely", () => {
    const flow = starterDoc(getStarter("business-hours")!).flow;
    const first = startPreview(flow);
    expect(first.messages[0].text).toMatch(/Monday to Saturday/);
    expect(reply(flow, first, { optionId: "b1" }).status).toBe("handoff");
    expect(reply(flow, first, { optionId: "b2" }).status).toBe("ended");
  });
});

describe("step names and wait times", () => {
  it("names steps by position and content without internal ids", () => {
    const flow = starterDoc(getStarter("welcome-menu")!).flow;
    const label = describeStep(flow.nodes, flow.nodes[0]);
    expect(label.startsWith("1. Send buttons: Hi, thanks for messaging us")).toBe(true);
    expect(label).not.toMatch(/\bn1\b/);
    expect(describeStep(flow.nodes, flow.nodes[4])).toBe("5. End");
  });

  it("lists the answers a flow saves", () => {
    expect(savedVariables(starterDoc(getStarter("collect-lead")!).flow.nodes)).toEqual(["name", "email", "need"]);
  });

  it("summarises steps in words rather than raw values", () => {
    let flow = addNode(emptyFlow(), "set_status", { x: 0, y: 0 }).flow;
    expect(summarize(flow.nodes[0])).toBe("Pending");
    flow = addNode(flow, "send_template", { x: 0, y: 0 }).flow;
    flow = updateNode(flow, "n2", (n) => ({ ...n, data: { templateId: "tpl_123", variables: {} } }) as FlowNode);
    expect(summarize(flow.nodes[1])).toBe("Template chosen");
    flow = addNode(flow, "condition", { x: 0, y: 0 }).flow;
    flow = updateNode(flow, "n3", (n) => ({ ...n, data: { variable: "age", operator: "gt", value: "17" } }) as FlowNode);
    expect(summarize(flow.nodes[2])).toBe("age is greater than 17");
  });

  it("converts waits between minutes, hours and days", () => {
    expect(toDuration(1440)).toEqual({ amount: 1, unit: "days" });
    expect(toDuration(120)).toEqual({ amount: 2, unit: "hours" });
    expect(toDuration(90)).toEqual({ amount: 90, unit: "minutes" });
    expect(toDuration(0)).toEqual({ amount: 0, unit: "minutes" });
    expect(fromDuration(2, "hours")).toBe(120);
    expect(fromDuration(3, "days")).toBe(4320);
    expect(fromDuration(Number.NaN, "days")).toBe(0);
    expect(fromDuration(-4, "minutes")).toBe(0);
  });

  it("explains out-of-range waits in words", () => {
    expect(durationProblem(0)).toMatch(/at least 1 minute/);
    expect(durationProblem(10081)).toMatch(/7 days/);
    expect(durationProblem(10080)).toBeNull();
    expect(durationProblem(5)).toBeNull();
  });

  it("formats minutes for people", () => {
    expect(formatMinutes(1)).toBe("1 minute");
    expect(formatMinutes(90)).toBe("1 hour 30 minutes");
    expect(formatMinutes(2880)).toBe("2 days");
    expect(formatMinutes(0)).toBe("0 minutes");
  });
});

describe("question step with fixed choices", () => {
  it("needs at least one allowed answer and accepts only those answers in the preview", () => {
    let flow = addNode(emptyFlow(), "ask", { x: 0, y: 0 }).flow;
    flow = updateNode(flow, "n1", (n) => ({ ...n, data: { text: "Size?", variable: "size", validate: "choice", maxRetries: 0 } }) as FlowNode);
    expect(validateNode(flow.nodes[0])).toContain("Add at least one allowed answer.");
    flow = updateNode(flow, "n1", (n) => ({ ...n, data: { ...n.data, choices: ["Small", "Large"] } }) as FlowNode);
    expect(validateNode(flow.nodes[0])).toEqual([]);
    expect(validateFlow(flow).errors).toEqual([]);
    expect(reply(flow, startPreview(flow), { text: "large" }).variables.size).toBe("large");
    expect(reply(flow, startPreview(flow), { text: "Medium" }).status).toBe("ended");
  });
});

describe("step names", () => {
  it("shortens long text with a real ellipsis, never a replacement character", () => {
    const flow = addNode(emptyFlow(), "send_text", { x: 0, y: 0 });
    const id = flow.id as string;
    const long = updateNode(flow.flow, id, (n) => ({ ...n, data: { ...n.data, text: "A very long welcome message that keeps going and going" } }) as FlowNode);
    const name = describeStep(long.nodes, long.nodes[0]);
    expect(name).toContain("…");
    expect(name).not.toContain("�");
  });
});
