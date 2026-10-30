import { describe, expect, it } from "vitest";
import { canRequeue, eventLabel, eventStatusView, reasonText } from "@/components/conversions/helpers";
import { hasRole, navFor } from "@/components/app/nav";

describe("conversions screen helpers", () => {
  it("labels every status the API can return", () => {
    expect(eventStatusView("failed")).toEqual({ label: "Could not send", tone: "bad" });
    expect(eventStatusView("sent").tone).toBe("good");
    expect(eventStatusView("odd_state").label).toBe("Odd state");
  });

  it("only offers a re-send where the server accepts one", () => {
    expect(["pending", "sent", "failed", "skipped"].filter(canRequeue)).toEqual(["failed", "skipped"]);
  });

  it("explains known skip reasons and passes other text through", () => {
    expect(reasonText("no_dataset")).toMatch(/dataset/i);
    expect(reasonText("Meta rejected the token.")).toBe("Meta rejected the token.");
    expect(reasonText(null)).toBe("");
    expect(eventLabel("QualifiedLead")).toBe("Qualified lead");
    expect(eventLabel("Whatever")).toBe("Whatever");
  });

  it("is linked from the navigation for owners and admins only", () => {
    expect(navFor("admin").some((i) => i.href === "/app/conversions")).toBe(true);
    expect(navFor("agent").some((i) => i.href === "/app/conversions")).toBe(false);
    expect(hasRole("admin", "admin")).toBe(true);
  });
});
