import { describe, expect, it } from "vitest";
import { argsHash, canonicalClone, canonicalJson, CanonicalJsonError, hashCanonical, previewHash } from "@/lib/actions/canonical";
import { assertRiskFloor, deriveRisk, effectiveRisk, maxRisk, mergeEffects, RiskFloorError } from "@/lib/actions/risk";
import type { Effects, Risk } from "@/lib/actions/types";

/** docs/EDDY-SPEC.md 4.2 and EDDY-01 acceptance 2-3: deriveRisk for every effect flag, the risk floor, canonical JSON. */

const LOUD: [string, Partial<Effects>][] = [
  ["messagesCustomers", { messagesCustomers: true }],
  ["spends messaging", { spends: "messaging" }],
  ["spends ads", { spends: "ads" }],
  ["spends ai", { spends: "ai" }],
  ["deletes", { deletes: true }],
  ["irreversible", { irreversible: true }],
  ["armsAutomation", { armsAutomation: true }],
  ["exportsPii", { exportsPii: true }],
  ["changesAccess", { changesAccess: true }],
  ["returnsSecret", { returnsSecret: true }],
  ["bulk", { bulk: true }],
];

describe("deriveRisk (4.2)", () => {
  it("reads are instant and plain writes are undoable", () => {
    expect(deriveRisk({ writes: false })).toBe("instant");
    expect(deriveRisk({ writes: true })).toBe("undoable");
    expect(deriveRisk({ writes: true, spends: "none" })).toBe("undoable");
    expect(deriveRisk({ writes: false, spends: "none" })).toBe("instant");
  });

  it.each(LOUD)("%s always needs a card, with or without writes", (_name, flag) => {
    expect(deriveRisk({ writes: false, ...flag })).toBe("confirm");
    expect(deriveRisk({ writes: true, ...flag })).toBe("confirm");
  });

  it.each(LOUD)("lowering activity does not soften %s", (_name, flag) => {
    expect(deriveRisk({ writes: true, lowersActivity: true, ...flag })).toBe("confirm");
  });

  it("an external write needs a card unless it lowers activity; an external read is instant", () => {
    expect(deriveRisk({ writes: true, external: true })).toBe("confirm");
    expect(deriveRisk({ writes: true, external: true, lowersActivity: true })).toBe("undoable");
    expect(deriveRisk({ writes: false, external: true })).toBe("instant");
  });

  it("lowersActivity on its own is an ordinary undoable write (Phase 0's asymmetric rule lives in the gates, not the class)", () => {
    expect(deriveRisk({ writes: true, lowersActivity: true })).toBe("undoable");
    expect(deriveRisk({ writes: false, lowersActivity: true })).toBe("instant");
  });

  it("false flags are the same as missing flags", () => {
    const allFalse: Effects = { writes: true, messagesCustomers: false, deletes: false, irreversible: false, external: false, armsAutomation: false, exportsPii: false, changesAccess: false, lowersActivity: false, bulk: false, returnsSecret: false };
    expect(deriveRisk(allFalse)).toBe("undoable");
  });
});

describe("risk floor", () => {
  it("refuses a declared risk below the derived one", () => {
    expect(() => assertRiskFloor("send_it", "undoable", { writes: true, messagesCustomers: true })).toThrow(RiskFloorError);
    expect(() => assertRiskFloor("tag_it", "instant", { writes: true })).toThrow(/below/);
  });

  it("keeps a stricter declared risk and fills in a missing one", () => {
    expect(assertRiskFloor("block_it", "confirm", { writes: true })).toBe("confirm");
    expect(assertRiskFloor("tag_it", undefined, { writes: true })).toBe("undoable");
    expect(assertRiskFloor("read_it", undefined, { writes: false })).toBe("instant");
  });

  it("maxRisk and effectiveRisk take the higher class", () => {
    const order: Risk[] = ["instant", "undoable", "confirm"];
    for (const a of order) for (const b of order) expect(maxRisk(a, b)).toBe(order[Math.max(order.indexOf(a), order.indexOf(b))]);
    expect(effectiveRisk("undoable", { writes: true, bulk: true })).toBe("confirm");
    expect(effectiveRisk("confirm", { writes: false })).toBe("confirm");
    expect(effectiveRisk(undefined, { writes: true })).toBe("undoable");
  });

  it("mergeEffects only raises flags and never replaces a spending pot", () => {
    expect(mergeEffects({ writes: true }, { messagesCustomers: true, armsAutomation: true })).toEqual({ writes: true, messagesCustomers: true, armsAutomation: true });
    expect(mergeEffects({ writes: true, spends: "ai" }, { spends: "messaging" }).spends).toBe("ai");
    expect(mergeEffects({ writes: true }, { spends: "messaging" }).spends).toBe("messaging");
    expect(mergeEffects({ writes: true, bulk: true }, { bulk: false }).bulk).toBe(true);
  });
});

describe("canonical JSON (argsHash, previewHash)", () => {
  it("is stable across key order", () => {
    const a = { b: 1, a: { y: [1, 2, { q: 1, p: 2 }], x: "z" } };
    const b = { a: { x: "z", y: [1, 2, { p: 2, q: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":"z","y":[1,2,{"p":2,"q":1}]},"b":1}');
    expect(argsHash(a)).toBe(argsHash(b));
  });

  it("is stable across Unicode normalisation, in values and keys", () => {
    const composed = "नमस्ते café";
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    expect(hashCanonical({ text: decomposed })).toBe(hashCanonical({ text: composed }));
    expect(hashCanonical({ ["cafe\u0301"]: 1 })).toBe(hashCanonical({ ["café"]: 1 }));
  });

  it("drops undefined, keeps array order, and converts dates and bigints", () => {
    expect(canonicalJson({ a: undefined, b: [3, 1, 2], c: null })).toBe('{"b":[3,1,2],"c":null}');
    expect(canonicalJson({ at: new Date("2026-10-28T10:00:00Z"), n: 12345678901234567890n })).toBe('{"at":"2026-10-28T10:00:00.000Z","n":"12345678901234567890"}');
    expect(canonicalJson([undefined, -0])).toBe("[null,0]");
    expect(canonicalClone({ z: 1, a: "e\u0301" })).toEqual({ a: "é", z: 1 });
  });

  it("refuses values that cannot be hashed honestly", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ n: Infinity })).toThrow(CanonicalJsonError);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => canonicalJson(loop)).toThrow(/itself/);
    expect(() => canonicalJson({ ["e\u0301"]: 1, ["é"]: 2 })).toThrow(/normalisation/);
  });

  it("previewHash is sha256 hex and differs when anything on the card differs", () => {
    const p = { titleKey: "card.send", vars: {}, material: { count: 3 } };
    expect(previewHash(p)).toMatch(/^[0-9a-f]{64}$/);
    expect(previewHash(p)).toBe(previewHash({ material: { count: 3 }, vars: {}, titleKey: "card.send" }));
    expect(previewHash(p)).not.toBe(previewHash({ ...p, material: { count: 4 } }));
  });
});
