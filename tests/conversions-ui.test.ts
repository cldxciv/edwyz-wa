import { describe, expect, it } from "vitest";
import { canRequeue, emptyStatusTitle, eventCountsText, eventLabel, eventStatusView, reasonText } from "@/components/conversions/helpers";
import { hasRole, navFor } from "@/components/app/nav";
import { REPORTED_EVENTS } from "@/components/conversions/ConversionsView";

describe("conversions screen helpers", () => {
  it("labels every status the API can return", () => {
    expect(eventStatusView("failed")).toEqual({ label: "Could not send", tone: "bad" });
    expect(eventStatusView("sent").tone).toBe("good");
    expect(eventStatusView("odd_state").label).toBe("Odd state");
  });

  it("writes counts and empty filters as plain sentences, with Meta capitalised", () => {
    expect(eventCountsText({ sent: 1, pending: 2 })).toBe("2 waiting to send, 1 sent to Meta, 0 could not be sent, 0 skipped");
    expect(emptyStatusTitle("sent")).toBe("Nothing has been sent to Meta yet");
    expect(emptyStatusTitle("failed")).toBe("Nothing failed to send");
    expect(emptyStatusTitle("pending")).toBe("Nothing is waiting to send");
    expect(emptyStatusTitle("odd_state")).toBe("No odd state events");
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

describe("what the conversions page says is reported", () => {
  it("names the three events and when each is sent, including chats from ads", () => {
    expect(REPORTED_EVENTS.map((e) => e.name)).toEqual(["New lead", "Qualified lead", "Purchase"]);
    expect(REPORTED_EVENTS[0].when).toMatch(/lead form/);
    expect(REPORTED_EVENTS[0].when).toMatch(/WhatsApp chat from your ad/);
    expect(REPORTED_EVENTS[1].when).toMatch(/qualified on the Leads page/);
    expect(REPORTED_EVENTS[2].when).toMatch(/won on the Leads page/);
  });
});
