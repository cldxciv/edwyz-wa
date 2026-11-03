import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isOptedOut,
  mayReceive,
  OPT_IN_REPLY,
  OPT_OUT_EFFECT,
  OPT_OUT_REPLY,
  OPT_OUT_RULES,
  OPT_OUT_SCHEDULED,
  OPTED_OUT_LABEL,
  OPTED_OUT_OF_MARKETING,
  optedOutSince,
  POSSIBLE_OPT_OUT_NOTE,
  receivableWhere,
  sendKindForCategory,
} from "@/lib/contacts/opt-out";
import { addStopWord, STOP_WORDS_EXCEPTIONS } from "@/components/contacts/helpers";
import {
  AMBIGUOUS_STOP_WORDS,
  checkStopWord,
  cleanStopWords,
  DEFAULT_STOP_WORDS,
  effectiveStopWords,
  isOptOutButton,
  isStopMessage,
  MAX_STOP_WORD_LENGTH,
  mightBeOptOutRequest,
  mightBeStopWord,
  normalizeOptOutText,
  stopSourceOf,
} from "@/lib/webhooks/payload";

/** Owner default 1 (2026-10-31): an opt-out blocks marketing only. */
describe("mayReceive: the one opt-out rule", () => {
  const out = { optedOutAt: new Date("2026-10-01T00:00:00Z") };
  const inn = { optedOutAt: null };

  it("blocks only marketing for a contact who opted out", () => {
    expect(mayReceive(out, "marketing")).toBe(false);
    expect(mayReceive(out, "utility")).toBe(true);
    expect(mayReceive(out, "authentication")).toBe(true);
    expect(mayReceive(out, "service")).toBe(true);
  });

  it("lets everything through for a contact who has not opted out", () => {
    for (const kind of ["marketing", "utility", "authentication", "service"] as const) expect(mayReceive(inn, kind)).toBe(true);
  });

  it("reads the stored column, an ISO string or the boolean flag the bots and Eddy carry", () => {
    expect(mayReceive({ optedOutAt: "2026-10-01T00:00:00Z" }, "marketing")).toBe(false);
    expect(mayReceive({ optedOut: true }, "marketing")).toBe(false);
    expect(mayReceive({ optedOut: false, optedOutAt: null }, "marketing")).toBe(true);
    expect(isOptedOut(out)).toBe(true);
    expect(isOptedOut(null)).toBe(false);
  });

  it("has nothing on record for a missing contact; the caller decides what that means", () => {
    expect(mayReceive(null, "marketing")).toBe(true);
    expect(mayReceive(undefined, "marketing")).toBe(true);
  });
});

describe("sendKindForCategory: the kind comes from the stored template", () => {
  it("maps Meta's categories and fails closed to marketing", () => {
    expect(sendKindForCategory("UTILITY")).toBe("utility");
    expect(sendKindForCategory("utility")).toBe("utility");
    expect(sendKindForCategory("AUTHENTICATION")).toBe("authentication");
    expect(sendKindForCategory("AUTHENTICATION_INTERNATIONAL")).toBe("authentication");
    expect(sendKindForCategory("MARKETING")).toBe("marketing");
    expect(sendKindForCategory("MARKETING_LITE")).toBe("marketing");
    expect(sendKindForCategory(null)).toBe("marketing");
    expect(sendKindForCategory(undefined)).toBe("marketing");
    expect(sendKindForCategory("SOMETHING_NEW")).toBe("marketing");
  });
});

describe("receivableWhere: the rule as a database filter", () => {
  it("leaves opted-out contacts out of marketing only", () => {
    expect(receivableWhere("marketing")).toEqual({ optedOutAt: null });
    expect(receivableWhere("utility")).toEqual({});
    expect(receivableWhere("authentication")).toEqual({});
    expect(receivableWhere("service")).toEqual({});
  });
});

describe("optedOutSince: a STOP ends what was already running", () => {
  const started = new Date("2026-10-31T10:00:00Z");
  it("is true for an opt-out at or after the start, false for an earlier one", () => {
    expect(optedOutSince({ optedOutAt: new Date("2026-10-31T10:05:00Z") }, started)).toBe(true);
    expect(optedOutSince({ optedOutAt: started }, started)).toBe(true);
    expect(optedOutSince({ optedOutAt: new Date("2026-10-30T10:00:00Z") }, started)).toBe(false);
  });
  it("is false with no opt-out or no start time", () => {
    expect(optedOutSince({ optedOutAt: null }, started)).toBe(false);
    expect(optedOutSince(null, started)).toBe(false);
    expect(optedOutSince({ optedOutAt: new Date() }, undefined)).toBe(false);
  });
});

describe("opt-out copy says exactly the rule", () => {
  it("customer-facing confirmations: no marketing; order updates and replies still arrive; START brings offers back", () => {
    expect(OPT_OUT_REPLY).toMatch(/not get marketing messages/);
    expect(OPT_OUT_REPLY).toMatch(/Order updates and replies to your own messages can still arrive/);
    expect(OPT_OUT_REPLY).toMatch(/Send START to get offers again/);
    expect(OPT_IN_REPLY).toMatch(/offers/);
    expect(OPT_IN_REPLY).toMatch(/STOP/);
  });
  it("team-facing copy says the same", () => {
    expect(OPT_OUT_EFFECT).toMatch(/no marketing messages/);
    expect(OPT_OUT_EFFECT).toMatch(/Order updates and replies to their own messages can still arrive/);
    expect(OPT_OUT_EFFECT).toMatch(/send START to get offers again/);
    expect(OPTED_OUT_OF_MARKETING).toMatch(/opted out of marketing/);
    expect(OPTED_OUT_OF_MARKETING).toMatch(/utility template/);
    expect(OPTED_OUT_LABEL).toBe("Opted out of marketing");
  });
  it("automation copy says rules still answer and only marketing templates are skipped", () => {
    expect(OPT_OUT_RULES).toBe("People who opted out get no marketing templates from rules. Replies to their own messages and utility templates, like order updates, still go.");
    expect(OPT_OUT_SCHEDULED).toBe("People who opted out are skipped when the rule sends a marketing template.");
    const src = (file: string) => readFileSync(join(__dirname, "..", "src/components/automation", file), "utf8");
    expect(src("AutomationSettings.tsx")).toContain("{OPT_OUT_RULES}");
    expect(src("AutomationView.tsx")).toContain("${OPT_OUT_RULES}");
    expect(src("RuleBuilder.tsx")).toContain("{OPT_OUT_SCHEDULED}");
    for (const file of ["AutomationSettings.tsx", "AutomationView.tsx", "RuleBuilder.tsx"]) {
      expect(src(file)).not.toMatch(/after they opt out|never to people who opted out|People who opted out are always skipped/);
    }
  });
  it("the possible opt-out note tells the team what to do", () => {
    expect(POSSIBLE_OPT_OUT_NOTE).toMatch(/^Possible opt-out request\./);
    expect(POSSIBLE_OPT_OUT_NOTE).toMatch(/ask Eddy to record their opt-out/);
    expect(POSSIBLE_OPT_OUT_NOTE).toMatch(/AI agent left this message for your team/);
  });
  it("the STOP words editor says what does not count", () => {
    expect(STOP_WORDS_EXCEPTIONS).toMatch(/template button labelled Cancel, End or Quit is not a STOP/);
    expect(STOP_WORDS_EXCEPTIONS).toMatch(/"stop please" does not opt them out/);
  });
});

describe("STOP words (owner default 1)", () => {
  it("are exactly the owner's list", () => {
    expect([...DEFAULT_STOP_WORDS]).toEqual(["stop", "stop all", "unsubscribe", "opt out", "cancel", "end", "quit"]);
  });

  it("match the whole message only, after normalisation", () => {
    for (const yes of ["STOP", "Stop!", " stop all ", "Unsubscribe.", "opt-out", "OPT OUT", "optout", "Cancel", "END", "quit?", "stopall"]) expect(isStopMessage(yes)).toBe(true);
    for (const no of ["cancel my order", "stop please", "can you stop", "quitting", "the end of it", "unsubscribe me"]) expect(isStopMessage(no)).toBe(false);
    expect(isStopMessage("")).toBe(false);
    expect(isStopMessage("!!!")).toBe(false);
  });

  it("add the workspace's own words", () => {
    expect(isStopMessage("Band karo", ["band karo"])).toBe(true);
    expect(isStopMessage("bandkaro", ["band karo"])).toBe(true);
    expect(isStopMessage("band karo please", ["band karo"])).toBe(false);
    expect(isStopMessage("Band karo", [])).toBe(false);
    expect(isStopMessage("Band karo", null)).toBe(false);
    expect(isStopMessage("stop", ["band karo"])).toBe(true);
  });

  it("checkStopWord normalises and refuses empty, too long and START words", () => {
    expect(checkStopWord("  Band   Karo! ")).toEqual({ ok: true, word: "band karo" });
    expect(checkStopWord(42)).toMatchObject({ ok: false });
    expect(checkStopWord("...")).toMatchObject({ ok: false, reason: expect.stringMatching(/letter or number/) });
    expect(checkStopWord("x".repeat(MAX_STOP_WORD_LENGTH + 1))).toMatchObject({ ok: false, reason: expect.stringMatching(/40 characters/) });
    for (const start of ["start", "START", "subscribe", "opt in", "unstop"]) expect(checkStopWord(start)).toMatchObject({ ok: false, reason: expect.stringMatching(/get offers again/) });
  });

  it("cleanStopWords drops defaults, duplicates and junk, and keeps at most 20", () => {
    expect(cleanStopWords(["Band karo", "band  karo", "STOP", "Opt-Out", "", null, "nahi chahiye"])).toEqual(["band karo", "nahi chahiye"]);
    expect(cleanStopWords("band karo")).toEqual([]);
    expect(cleanStopWords(Array.from({ length: 25 }, (_, i) => `w${i}`))).toHaveLength(20);
  });

  it("effectiveStopWords is the full list: defaults first, then the workspace's", () => {
    expect(effectiveStopWords(["band karo"])).toEqual([...DEFAULT_STOP_WORDS, "band karo"]);
    expect(effectiveStopWords(undefined)).toEqual([...DEFAULT_STOP_WORDS]);
  });

  it("a tap on Meta's marketing opt-out template button counts; the same text typed does not", () => {
    expect(isOptOutButton({ type: "button", body: "Stop promotions" })).toBe(true);
    expect(isOptOutButton({ type: "button", body: "STOP PROMOTIONS!" })).toBe(true);
    expect(isOptOutButton({ type: "text", body: "Stop promotions" })).toBe(false);
    expect(isOptOutButton({ type: "button", body: "Track my order" })).toBe(false);
  });

  it("mightBeStopWord: only a short message needs the workspace's words", () => {
    expect(mightBeStopWord("band karo")).toBe(true);
    expect(mightBeStopWord("")).toBe(false);
    expect(mightBeStopWord("I would like to know when my order will arrive at my home")).toBe(false);
  });
});

describe("STOP words on a template button (the business's own wording)", () => {
  it("stopSourceOf: a reply id is a tapped choice, a template quick-reply is a template button, anything else is typed", () => {
    expect(stopSourceOf("interactive", "row1")).toBe("tapped_choice");
    expect(stopSourceOf(undefined, "row1")).toBe("tapped_choice");
    expect(stopSourceOf("button")).toBe("template_button");
    expect(stopSourceOf("text")).toBe("typed");
    expect(stopSourceOf("interactive")).toBe("typed");
    expect(stopSourceOf(undefined)).toBe("typed");
  });

  it("cancel, end and quit on a template button are not a STOP; the unambiguous words and the workspace's own still are", () => {
    expect([...AMBIGUOUS_STOP_WORDS]).toEqual(["cancel", "end", "quit"]);
    for (const word of ["Cancel", "END", "quit!"]) {
      expect(isStopMessage(word, [], "template_button")).toBe(false);
      expect(isStopMessage(word, [], "typed")).toBe(true);
    }
    for (const word of ["Stop", "Stop all", "Unsubscribe", "Opt-out"]) expect(isStopMessage(word, [], "template_button")).toBe(true);
    expect(isStopMessage("Band karo", ["band karo"], "template_button")).toBe(true);
  });

  it("a tapped reply button or list row is never a STOP", () => {
    for (const word of ["Stop", "Cancel", "Unsubscribe"]) expect(isStopMessage(word, ["stop"], "tapped_choice")).toBe(false);
  });
});

describe("STOP words in Hindi and other Indic scripts keep their marks", () => {
  it("a Devanagari word round-trips unchanged, so it is stored and shown as typed", () => {
    expect(normalizeOptOutText("बंद करो")).toBe("बंद करो");
    expect(checkStopWord(" बंद   करो! ")).toEqual({ ok: true, word: "बंद करो" });
    expect(cleanStopWords(["रोको", "बंद करो"])).toEqual(["रोको", "बंद करो"]);
    expect(addStopWord([], "रोको")).toEqual({ ok: true, word: "रोको", words: ["रोको"] });
  });

  it("words that differ only in their marks stay different: रुको (wait) is not रोको (stop)", () => {
    expect(isStopMessage("रोको", ["रोको"])).toBe(true);
    expect(isStopMessage("रोको!", ["रोको"])).toBe(true);
    expect(isStopMessage("रुको", ["रोको"])).toBe(false);
    expect(isStopMessage("रोक", ["रोको"])).toBe(false);
    expect(addStopWord(["रोको"], "रुको")).toMatchObject({ ok: true, word: "रुको" });
  });

  it("Latin words read as before, and emoji marks never stick to a word", () => {
    expect(normalizeOptOutText("  Band   Karo! ")).toBe("band karo");
    expect(isStopMessage("STOP ✋️")).toBe(true);
    expect(isStopMessage("stop️")).toBe(true);
    expect(isStopMessage("Stop 🛑")).toBe(true);
    expect(normalizeOptOutText("1️⃣")).toBe("1");
  });
});

describe("mightBeOptOutRequest: near-misses the team should see", () => {
  it.each(["Stop please", "please stop", "stop sending me offers", "please stop sending me offers", "unsubscribe me", "pls opt-out", "opt out please", "stop all messages"])(
    "%j may be an opt-out request",
    (body) => expect(mightBeOptOutRequest(body)).toBe(true),
  );

  it.each(["STOP", "opt out", "cancel my order", "end of the month sale?", "quit smoking tips", "Where is my order?", "stopped working", "", "please could you tell me if you will ever stop selling the blue shirt"])(
    "%j is not one",
    (body) => expect(mightBeOptOutRequest(body)).toBe(false),
  );
});
