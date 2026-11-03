import { describe, expect, it } from "vitest";
import { cleanMap, choiceOf, choicesFor, defaultMap, firstMappingProblem, fromChoice, mappingProblems, policyNote, POLICY_CHOICES, templateSlots } from "@/components/broadcasts/mappingForm";
import { formToBody } from "@/components/admin/RateCardEditor";
import {
  OTHER_ATTRIBUTE,
  changeField,
  changeOp,
  draftIsEmpty,
  draftProblems,
  draftToFilter,
  emptyDraft,
  fieldOptions,
  filterToDraft,
  previewSentence,
  ruleProblem,
  selectValueFor,
  summarizeFilter,
} from "@/components/segments/helpers";

const components = [
  { type: "HEADER", format: "IMAGE" },
  { type: "BODY", text: "Hi {{1}}, code {{2}}" },
  { type: "BUTTONS", buttons: [{ type: "URL", text: "Open", url: "https://shop.example/{{1}}" }] },
];

describe("segment builder helpers", () => {
  it("round-trips a filter through the draft", () => {
    const filter = { any: [{ field: "tag", op: "has" as const, value: "vip" }, { field: "attr:city", op: "is" as const, value: "Pune" }] };
    const draft = filterToDraft(filter);
    expect(draft.match).toBe("any");
    expect(draftToFilter(draft)).toEqual(filter);
  });
  it("drops rules that are still being filled in", () => {
    const draft = { match: "all" as const, rules: [{ field: "tag", op: "has" as const, value: "" }, { field: "tag", op: "has" as const, value: "vip" }] };
    expect(draftToFilter(draft)).toEqual({ all: [{ field: "tag", op: "has", value: "vip" }] });
    expect(draftProblems(draft)).toEqual(["Fill in a value."]);
    expect(draftIsEmpty(emptyDraft())).toBe(true);
  });
  it("explains what is wrong with a rule in plain words", () => {
    expect(ruleProblem({ field: "attr:", op: "is", value: "x" })).toBe("Name the attribute.");
    expect(ruleProblem({ field: "createdAt", op: "within_days", value: "ten" })).toBe("Use a whole number of days.");
    expect(ruleProblem({ field: "createdAt", op: "before", value: "never" })).toBe("Pick a date.");
    expect(ruleProblem({ field: "attr:orders", op: "greater_than", value: "lots" })).toBe("Use a number.");
    expect(ruleProblem({ field: "name", op: "exists" })).toBeNull();
  });
  it("lists contact details and known attributes, plus a way to type another", () => {
    const options = fieldOptions(["city"]);
    expect(options.find((o) => o.value === "attr:city")?.group).toBe("Contact attributes");
    expect(options.at(-1)?.value).toBe(OTHER_ATTRIBUTE);
    expect(selectValueFor("attr:city", ["city"])).toBe("attr:city");
    expect(selectValueFor("attr:other", ["city"])).toBe(OTHER_ATTRIBUTE);
  });
  it("resets the test when it no longer fits the field", () => {
    expect(changeField({ field: "tag", op: "has", value: "vip" }, "name")).toEqual({ field: "name", op: "is", value: "" });
    expect(changeField({ field: "name", op: "contains", value: "a" }, "optInSource")).toEqual({ field: "optInSource", op: "contains", value: "a" });
    expect(changeOp({ field: "name", op: "is", value: "a" }, "exists")).toEqual({ field: "name", op: "exists", value: undefined });
  });
  it("summarises a filter and a preview in plain language", () => {
    expect(summarizeFilter(null)).toBe("Everyone who opted in");
    expect(summarizeFilter({ all: [{ field: "tag", op: "has", value: "vip" }, { field: "country", op: "is", value: "IN" }] })).toBe("Tag is tagged vip and Country is IN");
    expect(previewSentence({ count: 1, eligible: 1, sample: [], truncated: false }, "segment")).toBe("1 person match these rules. 1 of them can receive marketing messages.");
    expect(previewSentence({ count: 0, sample: [], truncated: false }, "broadcast")).toBe("No one matches yet.");
    expect(previewSentence({ count: 2500, sample: [], truncated: true }, "broadcast")).toContain("2,500 people will get this message (counted from your most recent contacts)");
  });
});

describe("value mapping form", () => {
  const slots = templateSlots(components);

  it("offers a file upload or a link for a media header", () => {
    expect(choicesFor(slots[0])).toEqual(["upload", "static", "attribute"]);
    expect(choicesFor(slots[1])).toContain("field:first_name");
  });
  it("starts with the name for the first placeholder and everything else open", () => {
    const map = defaultMap(slots);
    expect(map["1"]).toEqual({ source: "field", key: "name" });
    expect(map.header).toEqual({ source: "upload", value: "" });
    expect(map["2"]).toEqual({ source: "attribute", key: "" });
    expect(Object.keys(mappingProblems(slots, map, "skip")).sort()).toEqual(["2", "button:0", "header"]);
  });
  it("tells the person what to fix first", () => {
    expect(firstMappingProblem(slots, defaultMap(slots), "skip")).toBe("Header image: Upload the file to send.");
    const map = {
      ...defaultMap(slots),
      header: { source: "static" as const, value: "http://insecure.example/a.png" },
    };
    expect(mappingProblems(slots, map, "skip").header).toMatch(/https/);
  });
  it("asks for a fallback on every non-fixed value only under the fallback policy", () => {
    const map = {
      header: { source: "static" as const, value: "https://cdn.example/a.png" },
      "1": { source: "field" as const, key: "first_name" },
      "2": { source: "attribute" as const, key: "code" },
      "button:0": { source: "attribute" as const, key: "slug" },
    };
    expect(mappingProblems(slots, map, "skip")).toEqual({});
    expect(Object.keys(mappingProblems(slots, map, "fallback")).sort()).toEqual(["1", "2", "button:0"]);
    expect(firstMappingProblem(slots, { ...map, "1": { ...map["1"], fallback: "there" }, "2": { ...map["2"], fallback: "x" }, "button:0": { ...map["button:0"], fallback: "home" } }, "fallback")).toBeNull();
  });
  it("keeps a fallback when the source type changes and sends only trimmed, filled parts", () => {
    expect(fromChoice("static", { source: "attribute", key: "city", fallback: "there" })).toEqual({ source: "static", value: "", fallback: "there" });
    expect(choiceOf({ source: "field", key: "first_name" })).toBe("field:first_name");
    expect(cleanMap(slots, { "1": { source: "attribute", key: " city ", fallback: " " }, "2": { source: "static", value: " x " } })).toEqual({
      "1": { source: "attribute", key: "city" },
      "2": { source: "static", value: "x" },
    });
  });
  it("describes the three missing-value choices and the effect on people", () => {
    expect(POLICY_CHOICES.map((p) => p.value)).toEqual(["skip", "fallback", "fail"]);
    expect(policyNote("skip", 1)).toBe("1 person has no value for a placeholder and will be skipped.");
    expect(policyNote("fail", 3)).toContain("will not start");
  });
});

describe("rate card editor body", () => {
  it("builds the API body from the rows, skipping empty cells and rows", () => {
    expect(
      formToBody({
        currency: " inr ",
        note: "from Meta",
        rows: [
          { country: " in ", MARKETING: "88", UTILITY: "", AUTHENTICATION: "12" },
          { country: "", MARKETING: "5", UTILITY: "", AUTHENTICATION: "" },
          { country: "*", MARKETING: "500", UTILITY: "", AUTHENTICATION: "" },
        ],
      }),
    ).toEqual({ currency: "INR", note: "from Meta", rates: { IN: { MARKETING: "88", AUTHENTICATION: "12" }, "*": { MARKETING: "500" } } });
  });
});
