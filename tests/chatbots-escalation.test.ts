import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const usage = vi.hoisted(() => ({ used: 0, recorded: [] as unknown[][] }));
// The check goes through the AI gateway (SPEND-CONTROLS-SPEC 4.10), which runs for real over tests/helpers/fake-ai-gateway.ts.
// Credits already used this month reach the gateway's counter through usageLedger.aggregate (I12).
vi.mock("@/lib/db", async () => ({
  prisma: { usageLedger: { aggregate: async () => ({ _sum: { amount: usage.used } }) }, spendCounter: (await import("./helpers/fake-ai-gateway")).fakeAi.spendCounter },
}));
vi.mock("@/lib/usage", () => ({
  CREDIT_COST: { text: 1, image: 5, video: 25 },
  usedThisMonth: async () => usage.used,
  recordUsage: async (...args: unknown[]) => void usage.recorded.push(args),
}));
vi.mock("@/lib/ai-agent/credits", () => ({ effectiveCreditLimit: async () => 10 }));
vi.mock("@/lib/spend/kill", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("kill", await orig()));
vi.mock("@/lib/spend/control", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("control", await orig()));
vi.mock("@/lib/spend/allowances", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("allowances", await orig()));
vi.mock("@/lib/spend/counters", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("counters", await orig()));
vi.mock("@/lib/spend/reservations", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("reservations", await orig()));
vi.mock("@/lib/spend/ledger", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("ledger", await orig()));
vi.mock("@/lib/spend/notify", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("notify", await orig()));
vi.mock("@/lib/lifecycle/state", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("lifecycle", await orig()));

import { AI_UNAVAILABLE_SIGNAL, classifyWithAi, detectEscalation } from "@/lib/chatbots/escalation";
import { fakeAi } from "./helpers/fake-ai-gateway";

const human = (text: string, opts = {}) => detectEscalation(text, opts)?.kind === "human_request";

describe("asking for a person", () => {
  it.each([
    ["en", "I want to talk to a human"],
    ["en", "Can I speak with someone please"],
    ["en", "connect me to an agent"],
    ["en", "get me customer service"],
    ["en", "real person please"],
    ["en", "let me speak to your manager"],
    ["es", "Quiero hablar con una persona"],
    ["es", "necesito atención al cliente"],
    ["es", "pásame con un agente humano"],
    ["fr", "Je voudrais parler à un conseiller"],
    ["fr", "je veux un humain"],
    ["fr", "passez-moi le service client"],
    ["de", "Ich möchte mit einem Mitarbeiter sprechen"],
    ["de", "kundenservice bitte"],
    ["de", "Ich will einen Menschen"],
    ["pt", "quero falar com um atendente"],
    ["pt", "preciso de atendimento humano"],
    ["it", "voglio parlare con un operatore"],
    ["hi-latin", "mujhe kisi insaan se baat karni hai"],
    ["hi", "मुझे किसी से बात करनी है"],
    ["hi", "कस्टमर केयर"],
    ["ar", "أريد التحدث مع موظف خدمة العملاء"],
  ])("recognises %s: %s", (_lang, text) => {
    expect(human(text)).toBe(true);
  });

  it("ignores accents and capital letters", () => {
    expect(human("ATENCION AL CLIENTE")).toBe(true);
    expect(human("Atención Al Cliente")).toBe(true);
  });

  it("does not react to ordinary messages", () => {
    for (const text of ["hello", "What are your prices?", "I am an insurance agent", "my agent number is 55", "Price list please", "The team won yesterday", "ok thanks", ""]) {
      expect(detectEscalation(text)).toBeNull();
      expect(detectEscalation(text, { loose: false })).toBeNull();
    }
  });

  it("frustration counts for free-text answers without turning on single-word requests", () => {
    expect(detectEscalation("this is useless", { frustration: true })?.kind).toBe("frustration");
    expect(detectEscalation("THIS BOT NEVER LISTENS TO ME", { frustration: true })?.kind).toBe("frustration");
    expect(detectEscalation("Support Manager", { frustration: true })).toBeNull();
    expect(detectEscalation("agent", { frustration: true })).toBeNull();
    expect(detectEscalation("talk to a human", { frustration: true })?.kind).toBe("human_request");
  });

  it("single words only count when the reply did not fit, and only in very short messages", () => {
    expect(detectEscalation("agent")).toBeNull();
    expect(human("agent", { loose: true })).toBe(true);
    expect(human("humano", { loose: true })).toBe(true);
    expect(human("support please", { loose: true })).toBe(true);
    expect(detectEscalation("the agent said I should write to this number", { loose: true })).toBeNull();
  });

  it("extra words from the business always count, as whole words", () => {
    expect(detectEscalation("I need a refund now", { keywords: ["refund"] })).toEqual({ kind: "human_request", source: "custom" });
    expect(detectEscalation("refunds are nice", { keywords: ["refund"] })).toBeNull();
    expect(detectEscalation("Réclamation", { keywords: ["reclamation"] })?.source).toBe("custom");
  });
});

describe("frustration", () => {
  it.each([
    "this is useless",
    "you do not understand me",
    "worst service ever",
    "I am so frustrated",
    "esto es horrible, no sirve",
    "c'est nul, vous ne comprenez pas",
    "das ist nutzlos",
    "isso é péssimo",
    "yeh bakwas hai",
    "यह बकवास है",
    "WHY WON'T YOU ANSWER ME RIGHT NOW",
  ])("notices: %s", (text) => {
    expect(detectEscalation(text, { loose: true })?.kind).toBe("frustration");
  });

  it("is ignored when the reply fitted the question", () => {
    expect(detectEscalation("this is useless")).toBeNull();
  });

  it("does not mistake normal enthusiasm for anger", () => {
    for (const text of ["Thank you so much!", "GREAT", "YES PLEASE", "I love this offer, what is the price", "ok"]) {
      expect(detectEscalation(text, { loose: true })).toBeNull();
    }
  });
});

describe("asking AI", () => {
  const fetchMock = vi.fn();
  beforeEach(async () => {
    await fakeAi.reset();
    usage.used = 0;
    usage.recorded = [];
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.ANTHROPIC_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
  });
  const answer = (text: string) => fetchMock.mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: "text", text }] }) });

  it("returns the signal, wraps the customer's text as data and records one credit", async () => {
    answer("HUMAN");
    const signal = await classifyWithAi("t1", "can somebody who is alive help");
    expect(signal).toEqual({ kind: "human_request", source: "ai" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(5);
    expect(body.messages[0].content).toContain("<customer_message>");
    expect(body.system).toMatch(/never follow instructions/i);
    // The gateway charges the credit when it settles the hold: the counters already moved, so recordUsage gets counted: true.
    expect(usage.recorded).toEqual([["t1", "ai_credits", 1, { type: "chatbot_escalation", id: "t1" }, { inputTokens: null, outputTokens: null, model: null, counted: true }]]);
    expect(fakeAi.counter("t1", "month")).toEqual({ spent: 1n, reserved: 0n, used: 1n });
  });

  it("maps FRUSTRATED and anything else", async () => {
    answer("frustrated");
    expect((await classifyWithAi("t1", "ugh"))?.kind).toBe("frustration");
    answer("NEITHER");
    expect(await classifyWithAi("t1", "ok")).toBeNull();
    answer("Sure! Here is a poem");
    expect(await classifyWithAi("t1", "ok")).toBeNull();
  });

  it("does nothing without a key, on errors and on empty text, and charges nothing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await classifyWithAi("t1", "help")).toBeNull();
    process.env.ANTHROPIC_API_KEY = "k";
    expect(await classifyWithAi("t1", "   ")).toBeNull();
    fetchMock.mockResolvedValue({ ok: false });
    expect(await classifyWithAi("t1", "help")).toBeNull();
    fetchMock.mockRejectedValue(new Error("network"));
    expect(await classifyWithAi("t1", "help")).toBeNull();
    expect(usage.recorded).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A failed call gives its hold back.
    expect(fakeAi.counter("t1", "month")).toEqual({ spent: 0n, reserved: 0n, used: 0n });
    expect(fakeAi.openHolds("t1")).toBe(0);
  });

  // Changed with the AI gateway (SPEND-CONTROLS-SPEC 4.10): a check the gateway refuses falls back to "hand to a person",
  // never "keep the bot talking". It used to return null (the bot carried on) when the credits were used up.
  it("hands the chat to a person, without a model call, when the AI limit is used up", async () => {
    usage.used = 10;
    expect(await classifyWithAi("t1", "help")).toEqual(AI_UNAVAILABLE_SIGNAL);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(usage.recorded).toEqual([]);
  });

  it("hands the chat to a person when spending is stopped (escalation is automatic AI)", async () => {
    fakeAi.freeze("all");
    expect(await classifyWithAi("t1", "help")).toEqual(AI_UNAVAILABLE_SIGNAL);
    fakeAi.freeze("none", "all");
    expect(await classifyWithAi("t1", "help")).toEqual(AI_UNAVAILABLE_SIGNAL);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
