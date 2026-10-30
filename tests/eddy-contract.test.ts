import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

/**
 * docs/EDDY-SPEC.md 5.2 and 5.12, EDDY-10/11 acceptance 5: the SSE event union of POST /api/eddy/turn and the model port
 * match the spec, at the type level and at run time (frames written by sse.ts parse back into the union; the ports Eddy
 * binds all satisfy EddyModelPort).
 */

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { EDDY_EVENT_TYPES, type EddyEvent, type EddyIntentKind, type EddyLang, type EddyState, type I18nKey, type PendingCardDTO } from "@/lib/eddy/contract";
import type { EddyModelPort, EddyRequest, GatewayCtx, StreamEvent } from "@/lib/eddy/model";
import { scriptedModelPort, streamScripted } from "@/lib/eddy/model-binding";
import { KEEPALIVE_FRAME, parseSseFrames, sseFrame, SSE_HEADERS } from "@/lib/eddy/sse";
import { anthropicStreamPort } from "@/lib/spend/exec/ai-stream";
import { createFakeModel } from "./fixtures/eddy-fake-model";

type Ev<T extends EddyEvent["type"]> = Extract<EddyEvent, { type: T }>;

describe("the SSE union (5.12)", () => {
  it("lists exactly the 5.12 events, in order", () => {
    expect(EDDY_EVENT_TYPES).toEqual(["turn", "status", "delta", "message", "reset", "card", "done_action", "refused_action", "intent", "end", "error"]);
  });

  it("each member has the 5.12 fields", () => {
    expectTypeOf<Ev<"turn">>().toEqualTypeOf<{ type: "turn"; turnId: string; conversationId: string; lang: EddyLang }>();
    expectTypeOf<Ev<"status">>().toEqualTypeOf<{ type: "status"; text?: string; key?: I18nKey }>();
    expectTypeOf<Ev<"delta">>().toEqualTypeOf<{ type: "delta"; text: string }>();
    expectTypeOf<Ev<"message">>().toEqualTypeOf<{ type: "message"; text: string; lang: EddyLang }>();
    expectTypeOf<Ev<"reset">>().toEqualTypeOf<{ type: "reset" }>();
    expectTypeOf<Ev<"card">>().toEqualTypeOf<{ type: "card"; card: PendingCardDTO }>();
    expectTypeOf<Ev<"done_action">>().toEqualTypeOf<{ type: "done_action"; actionId: string; summaryKey: I18nKey; vars: Record<string, string | number>; undoUntil?: string }>();
    expectTypeOf<Ev<"refused_action">>().toEqualTypeOf<{ type: "refused_action"; action: string; code: string; who?: string[] }>();
    expectTypeOf<Ev<"intent">>().toEqualTypeOf<{ type: "intent"; kind: EddyIntentKind; payload: unknown }>();
    expectTypeOf<Ev<"end">>().toEqualTypeOf<{ type: "end"; credits: number; truncated?: boolean }>();
    expectTypeOf<Ev<"error">>().toEqualTypeOf<{ type: "error"; state: EddyState; params?: Record<string, string | number> }>();
    expectTypeOf<EddyIntentKind>().toEqualTypeOf<"navigate" | "composer_draft" | "open_templates" | "connect_whatsapp" | "connect_facebook">();
    expectTypeOf<PendingCardDTO["nonce"]>().toEqualTypeOf<string>();
  });

  it("every event survives the SSE framing", () => {
    const card = { actionId: "a_1", action: "send_text_reply", nonce: "n", previewHash: "h", preview: { titleKey: "k", vars: {}, facts: [], cost: { state: "free", reason: "internal" }, warnings: [], editable: [], confirmLabelKey: "c", danger: false, material: {} }, lang: "en", state: "pending", createdAt: "x", expiresAt: "y", confirmGuardMs: 600 } as PendingCardDTO;
    const samples: EddyEvent[] = [
      { type: "turn", turnId: "t_1", conversationId: "c_1", lang: "hinglish" },
      { type: "status", key: "status.list_templates", text: "Checking your templates…" },
      { type: "delta", text: "नमस्ते\n\n**bold**" },
      { type: "message", text: "Line one\nline two: `code`", lang: "hi" },
      { type: "reset" },
      { type: "card", card },
      { type: "done_action", actionId: "a_2", summaryKey: "done.tag", vars: { count: 2 }, undoUntil: "2026-10-29T10:15:00Z" },
      { type: "refused_action", action: "delete_template", code: "role", who: ["Priya"] },
      { type: "intent", kind: "navigate", payload: { path: "/app/templates" } },
      { type: "end", credits: 3, truncated: true },
      { type: "error", state: "allowance_used", params: { need: 4, left: 1 } },
    ];
    expect(samples.map((s) => s.type)).toEqual([...EDDY_EVENT_TYPES]);
    const stream = samples.map(sseFrame).join(KEEPALIVE_FRAME);
    for (const s of samples) expect(stream).toContain(`event: ${s.type}\ndata: `);
    expect(parseSseFrames(stream)).toEqual(samples);
    expect(SSE_HEADERS["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(SSE_HEADERS["cache-control"]).toBe("no-cache, no-store, no-transform");
    expect(SSE_HEADERS["x-accel-buffering"]).toBe("no");
  });
});

describe("the model port (5.2)", () => {
  it("EddyModelPort.stream(params, ctx, {signal, onEvent}) returns the beta message", () => {
    type Stream = EddyModelPort["stream"];
    expectTypeOf<Parameters<Stream>[0]>().toEqualTypeOf<EddyRequest>();
    expectTypeOf<Parameters<Stream>[1]>().toEqualTypeOf<GatewayCtx>();
    expectTypeOf<Parameters<Stream>[2]>().toEqualTypeOf<{ signal: AbortSignal; onEvent: (e: StreamEvent) => void }>();
    expectTypeOf<ReturnType<Stream>>().toEqualTypeOf<Promise<Anthropic.Beta.Messages.BetaMessage>>();
    expectTypeOf<StreamEvent>().toEqualTypeOf<Anthropic.Beta.Messages.BetaRawMessageStreamEvent>();
  });

  it("GatewayCtx carries requestedBy (never a SpendActor), the credits, ref eddy_turn, subjectId and settle (5.10, E9)", () => {
    expectTypeOf<GatewayCtx["feature"]>().toEqualTypeOf<"eddy">();
    expectTypeOf<GatewayCtx["requestedBy"]>().toEqualTypeOf<{ userId: string; role: "agent" | "admin" | "owner" }>();
    expectTypeOf<GatewayCtx["ref"]>().toEqualTypeOf<{ type: "eddy_turn"; id: string }>();
    expectTypeOf<GatewayCtx["subjectId"]>().toEqualTypeOf<string>();
    expectTypeOf<GatewayCtx["credits"]>().toEqualTypeOf<number>();
    expectTypeOf<GatewayCtx>().not.toHaveProperty("actor");
  });

  it("the production binding, the scripted e2e port and the unit-test fake all satisfy it", () => {
    expectTypeOf(anthropicStreamPort).toMatchTypeOf<EddyModelPort>();
    expectTypeOf(scriptedModelPort([])).toMatchTypeOf<EddyModelPort>();
    expectTypeOf(createFakeModel()).toMatchTypeOf<EddyModelPort>();
    expect(typeof anthropicStreamPort.stream).toBe("function");
  });

  it("the scripted port streams raw events and returns a final message shaped like the API's", async () => {
    const events: string[] = [];
    let settled = 0;
    const ctx: GatewayCtx = { tenantId: "t1", feature: "eddy", requestedBy: { userId: "u", role: "agent" }, credits: 3, ref: { type: "eddy_turn", id: "tn" }, subjectId: "tn:0", settle: () => ++settled };
    const params = { model: "claude-sonnet-5-5", max_tokens: 8000, messages: [{ role: "user", content: "hi" }] } as unknown as EddyRequest;
    const msg = await streamScripted(
      { content: [{ type: "thinking", thinking: "note", signature: "s" }, { type: "text", text: "Hello" }, { type: "tool_use", name: "list_templates", input: {} }], stop_reason: "tool_use" },
      params,
      ctx,
      { signal: new AbortController().signal, onEvent: (e) => events.push(e.type) },
      { scenario: "c", round: 0 },
    );
    expect(events[0]).toBe("message_start");
    expect(events.at(-2)).toBe("message_delta");
    expect(events.at(-1)).toBe("message_stop");
    expect(msg).toMatchObject({ type: "message", role: "assistant", stop_reason: "tool_use", model: "claude-sonnet-5-5" });
    expect(msg.content.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(settled).toBe(1);
  });
});

describe("the e2e scripted fixtures (EDDY_FAKE_MODEL=scripted, 9.4)", () => {
  it("load from e2e/fixtures/eddy, name real v1 tools with valid input, and have a default", { timeout: 60_000 }, async () => {
    const { loadScriptedFixtures } = await import("@/lib/eddy/model-binding");
    const { actionByName } = await import("@/lib/actions");
    const { validate } = await import("@/lib/actions/schema");
    const fixtures = loadScriptedFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(1);
    const scenarios = fixtures.flatMap((f) => f.scenarios);
    expect(scenarios.some((s) => s.match === "*" || s.id === "default")).toBe(true);
    for (const s of scenarios) {
      expect(s.rounds.length, s.id).toBeGreaterThan(0);
      for (const round of s.rounds) {
        for (const block of round.content) {
          if (block.type !== "tool_use") continue;
          const def = actionByName(block.name);
          expect(def, `${s.id}: ${block.name}`).toBeDefined();
          expect(validate(def!.inputSchema, block.input), `${s.id}: ${block.name} input`).toBeNull();
        }
      }
    }
  });

  it("the scripted port picks the scenario by the member's text and the step by the round", async () => {
    const { scriptedModelPort, fakeModelActive } = await import("@/lib/eddy/model-binding");
    const port = scriptedModelPort([
      { version: 1, scenarios: [{ id: "a", match: "alpha", rounds: [{ content: [{ type: "text", text: "first" }] }, { content: [{ type: "text", text: "second" }] }] }, { id: "default", match: "*", rounds: [{ content: [{ type: "text", text: "fallback" }] }] }] },
    ]);
    const ctx: GatewayCtx = { tenantId: "t1", feature: "eddy", requestedBy: { userId: "u", role: "agent" }, credits: 1, ref: { type: "eddy_turn", id: "tn" }, subjectId: "tn:0", settle: () => 0 };
    const o = { signal: new AbortController().signal, onEvent: () => undefined };
    const ask = (messages: unknown[]) => port.stream({ model: "claude-sonnet-5-5", max_tokens: 8000, messages } as unknown as EddyRequest, ctx, o);
    const first = await ask([{ role: "user", content: "say ALPHA please" }, { role: "system", content: "note" }]);
    expect(first.content[0]).toMatchObject({ text: "first" });
    const second = await ask([{ role: "user", content: "say ALPHA please" }, { role: "system", content: "note" }, { role: "assistant", content: [] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "{}" }] }]);
    expect(second.content[0]).toMatchObject({ text: "second" });
    expect((await ask([{ role: "user", content: "anything else" }])).content[0]).toMatchObject({ text: "fallback" });
    expect(fakeModelActive({ EDDY_FAKE_MODEL: "scripted", NODE_ENV: "test" })).toBe(true);
    expect(fakeModelActive({ EDDY_FAKE_MODEL: "scripted", NODE_ENV: "production" })).toBe(false);
    expect(fakeModelActive({ NODE_ENV: "test" })).toBe(false);
  });
});
