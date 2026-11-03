import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WEBHOOK_EVENTS } from "@/lib/integrations/events";
import {
  broadcastTotals,
  contactOptedOutPayload,
  contactRef,
  EVENT_CATALOG,
  eventDoc,
  leadCreatedPayload,
  leafPaths,
  messageReceivedPayload,
  messageStatusPayload,
} from "@/lib/integrations/payloads";

const documentedLeaves = (names: string[]) => names.filter((n) => !names.some((o) => o.startsWith(`${n}.`))).sort();

describe("webhook event catalogue", () => {
  it("documents exactly the events that can be subscribed to", () => {
    expect(EVENT_CATALOG.map((e) => e.event).sort()).toEqual([...WEBHOOK_EVENTS].sort());
    for (const event of WEBHOOK_EVENTS) expect(eventDoc(event)?.when.length).toBeGreaterThan(10);
  });

  it("includes the two events added for conversations and leads", () => {
    expect(WEBHOOK_EVENTS).toEqual(expect.arrayContaining(["conversation.status_changed", "lead.created"]));
  });

  for (const doc of EVENT_CATALOG) {
    it(`${doc.event}: every field in the sample is documented and every documented field is in the sample`, () => {
      const sample = leafPaths(doc.sample).map((p) => (p.startsWith("fields.") ? "fields" : p));
      expect([...new Set(sample)].sort()).toEqual(documentedLeaves(doc.fields.map((f) => f.name)));
    });

    it(`${doc.event}: documents each field once, with a type and a description`, () => {
      const names = doc.fields.map((f) => f.name);
      expect(new Set(names).size).toBe(names.length);
      for (const f of doc.fields) {
        expect(f.type).toBeTruthy();
        expect(f.description.length).toBeGreaterThan(5);
      }
    });
  }

  it("every payload that names a contact carries the same identity fields", () => {
    for (const event of ["message.received", "message.status", "contact.opted_out", "lead.created"]) {
      const names = eventDoc(event)!.fields.map((f) => f.name);
      for (const key of ["id", "phone", "bsuid", "waId", "username", "name"]) expect(names, `${event} contact.${key}`).toContain(`contact.${key}`);
    }
  });

  it("the public docs page renders the catalogue", () => {
    const page = readFileSync(path.resolve(__dirname, "../src/app/(site)/docs/webhooks/page.tsx"), "utf8");
    expect(page).toContain("EVENT_CATALOG");
  });
});

describe("payload builders", () => {
  it("contactRef keeps every key and uses null for what is unknown, including a username-only contact", () => {
    expect(contactRef({ id: "c1", bsuid: "IN.1" })).toEqual({ id: "c1", phone: null, bsuid: "IN.1", waId: null, username: null, name: null });
  });

  it("message.received has a null referral when the chat did not start from an ad, and carries the assignee", () => {
    const p = messageReceivedPayload({
      conversationId: "v1",
      channel: null,
      assignedTo: "u1",
      contact: { id: "c1", phone: "+911", bsuid: "IN.1" },
      message: { id: "w1", type: "text", text: "hi", mediaId: null, mimeType: null, timestamp: new Date("2026-10-27T10:00:00Z") },
      referral: null,
    });
    expect(p.referral).toBeNull();
    expect(p.assignedTo).toBe("u1");
    expect(p.message.timestamp).toBe("2026-10-27T10:00:00.000Z");
  });

  it("message.status handles a status with no contact", () => {
    const p = messageStatusPayload({ messageId: "m", conversationId: "c", wamid: null, status: "failed", errorCode: "131049", timestamp: "2026-10-27T10:00:00Z", contact: null });
    expect(p.contact).toBeNull();
    expect(p.errorCode).toBe("131049");
  });

  it("broadcast totals count sent to include delivered and read, and delivered to include read", () => {
    expect(broadcastTotals({ pending: 1, sent: 2, delivered: 3, read: 4, failed: 5, skipped: 6 })).toEqual({ total: 21, sent: 9, delivered: 7, read: 4, failed: 5, skipped: 6 });
    expect(broadcastTotals({})).toEqual({ total: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 });
  });

  it("contact.opted_out keeps the older flat fields next to the contact object", () => {
    const p = contactOptedOutPayload({ contact: { id: "c1", phone: "+911" }, optedOutAt: "2026-10-27T10:00:00Z", source: "api" });
    expect(p).toMatchObject({ contactId: "c1", phone: "+911", source: "api", contact: { id: "c1" } });
  });

  it("lead.created tolerates a lead with no contact", () => {
    const p = leadCreatedPayload({ leadId: "l", status: "new", formId: null, campaignId: null, adId: null, createdAt: "2026-10-27T10:00:00Z", contact: null, fields: {} });
    expect(p.contact).toBeNull();
    expect(p.source).toBe("meta_lead_form");
  });

  it("lead.created carries where the lead came from, and the catalog explains both sources", () => {
    const p = leadCreatedPayload({ leadId: "l", status: "new", source: "ctwa", formId: null, campaignId: null, adId: "ad-77", createdAt: "2026-10-30T10:00:00Z", contact: null, fields: { source: "click_to_whatsapp" } });
    expect(p.source).toBe("ctwa");
    const doc = eventDoc("lead.created")!;
    expect(doc.when).toMatch(/click-to-WhatsApp ads/);
    expect(doc.fields.find((f) => f.name === "source")!.description).toBe("meta_lead_form for a Meta lead form, ctwa for a chat started from a click-to-WhatsApp ad.");
    expect(doc.fields.find((f) => f.name === "formId")!.description).toMatch(/Null for ctwa leads/);
  });
});
