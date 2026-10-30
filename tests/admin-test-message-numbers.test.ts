import { describe, expect, it } from "vitest";
import { CANNOT_SEND_NOTE, NEEDS_BROADCAST_NOTE, NEEDS_VALUES_NOTE, NO_TEMPLATES_HELP, testMessageNumbers, testTemplateLabel } from "@/components/admin/helpers";

const tenants = [
  { id: "demo", name: "Demo Workspace (sample data)", phoneNumbers: [{ id: "p-demo", wabaRefId: "w-demo", displayPhone: "+91 90000 00000", verifiedName: null }] },
  { id: "real", name: "edwyz-test", phoneNumbers: [{ id: "p-real", wabaRefId: "w-real", displayPhone: "+1 711-268-5789", verifiedName: "Edwyz" }] },
];

const templates = [
  { id: "t-hello", tenantId: "real", wabaRefId: "w-real", name: "hello_world", language: "en_US", variables: 0 },
  { id: "t-order", tenantId: "real", wabaRefId: "w-real", name: "order_update", language: "en", variables: 2 },
  { id: "t-other-waba", tenantId: "real", wabaRefId: "w-old", name: "old_account", language: "en", variables: 0 },
  { id: "t-demo", tenantId: "demo", wabaRefId: "w-demo", name: "welcome", language: "en", variables: 0 },
];

describe("testMessageNumbers", () => {
  it("lists numbers that can send first and marks the others plainly", () => {
    const out = testMessageNumbers(tenants, new Set(["real"]));
    expect(out.map((n) => n.id)).toEqual(["p-real", "p-demo"]);
    expect(out[0].label).toBe("+1 711-268-5789 (Edwyz) - edwyz-test");
    expect(out[1].label).toBe(`+91 90000 00000 - Demo Workspace (sample data) (${CANNOT_SEND_NOTE})`);
  });

  it("keeps the original order when every workspace can send, and never leaks extra fields", () => {
    const out = testMessageNumbers(tenants, new Set(["demo", "real"]));
    expect(out.map((n) => n.id)).toEqual(["p-demo", "p-real"]);
    expect(Object.keys(out[0])).toEqual(["id", "label", "templates"]);
    expect(out[0].templates).toEqual([]);
  });

  it("attaches only the approved templates of the number's own workspace and WhatsApp account, with the language in the label", () => {
    const out = testMessageNumbers(tenants, new Set(["real"]), templates);
    expect(out[0].templates).toEqual([
      { id: "t-hello", label: "hello_world (en_US)", variables: 0 },
      { id: "t-order", label: "order_update (en)", variables: 2 },
    ]);
    expect(out[1].templates.map((t) => t.id)).toEqual(["t-demo"]);
  });

  it("falls back to the whole workspace when the number has no account id", () => {
    const out = testMessageNumbers([{ id: "real", name: "x", phoneNumbers: [{ id: "p", displayPhone: "+1", verifiedName: null }] }], new Set(["real"]), templates);
    expect(out[0].templates.map((t) => t.id)).toEqual(["t-hello", "t-order", "t-other-waba"]);
  });

  it("labels templates that need values so the option can be disabled, pointing at the place that can actually send them", () => {
    expect(testTemplateLabel({ id: "a", label: "hello_world (en_US)", variables: 0 })).toBe("hello_world (en_US)");
    expect(testTemplateLabel({ id: "b", label: "order_update (en)", variables: 2 })).toBe(`order_update (en) - ${NEEDS_VALUES_NOTE}`);
    // A media header or button variable cannot be filled in the inbox either; those go through Broadcasts.
    expect(testTemplateLabel({ id: "c", label: "media (en)", variables: null })).toBe(`media (en) - ${NEEDS_BROADCAST_NOTE}`);
    expect(NEEDS_BROADCAST_NOTE).toMatch(/Broadcasts/);
    expect(NEEDS_BROADCAST_NOTE).not.toMatch(/inbox/);
  });

  it("tells an admin with an empty picker how to get a template listed, or how to unlock plain text instead", () => {
    expect(NO_TEMPLATES_HELP).toMatch(/Update from Meta/);
    expect(NO_TEMPLATES_HELP).toMatch(/send any message from the test phone/i);
  });

  it("returns nothing for no numbers", () => {
    expect(testMessageNumbers([], new Set())).toEqual([]);
  });
});
