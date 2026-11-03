import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  POPUP_SCREENS,
  SETUP_STEPS,
  TROUBLE_TOPICS,
  activeStepTitle,
  classifyFailure,
  currentStage,
  describeCancelStep,
  failedStepTitle,
  liveAnnouncement,
  mergeSteps,
  setupProgress,
  stageState,
  stepPill,
  stepTitle,
  type FlowView,
} from "@/components/connect/helpers";
import { BusyButton } from "@/components/integrations/BusyButton";
import { CheckRow } from "@/components/integrations/CheckRow";
import {
  DEFAULT_SCOPES,
  DOC_SNIPPETS,
  SCOPES,
  SCOPE_INFO,
  deliveryDisplay,
  deliverySummary,
  endpointNotice,
  eventLabel,
  hasUnsettledDeliveries,
  keyNameError,
  scopeLabel,
  webhookUrlError,
} from "@/components/integrations/helpers";
import { AvailabilityToggle } from "@/components/routing/AvailabilityToggle";
import { RoleGate } from "@/components/team/RoleGate";
import { STATUS_TONE, statusTone as centralTone } from "@/components/ui/status";
import { MAX_OPEN, MODE_INFO, effectiveForm, isDirty, parseLimit, routingSummary, toBody, toForm, validateForm } from "@/components/routing/helpers";
import { DEFAULT_SETTINGS, MAX_OPEN_LIMIT } from "@/lib/routing/config";
import { canRemoveMember, describeExpiry, emailError, isOnlyOwner, noTransferNote, removeConfirm, roleChangeConfirm, roleLabel, shouldOpenInvite } from "@/components/team/helpers";

describe("team helpers", () => {
  it("opens the invite dialog only for an explicit ?invite=1", () => {
    expect(shouldOpenInvite("1")).toBe(true);
    expect(shouldOpenInvite("true")).toBe(true);
    expect(shouldOpenInvite(["1", "0"])).toBe(true);
    expect(shouldOpenInvite("0")).toBe(false);
    expect(shouldOpenInvite("")).toBe(false);
    expect(shouldOpenInvite(undefined)).toBe(false);
    expect(shouldOpenInvite(null)).toBe(false);
  });

  it("validates the invite email with a helpful message", () => {
    expect(emailError("")).toMatch(/Enter their email/);
    expect(emailError("priya@")).toMatch(/full email/);
    expect(emailError("priya@shop.in")).toBeNull();
    expect(emailError("  priya@shop.in ")).toBeNull();
  });

  it("decides who can remove whom", () => {
    const owner = { userId: "o", role: "owner" as const };
    const admin = { userId: "a", role: "admin" as const };
    const agent = { userId: "g", role: "agent" as const };
    expect(canRemoveMember(owner, admin)).toBe(true);
    expect(canRemoveMember(admin, agent)).toBe(true);
    expect(canRemoveMember(admin, owner)).toBe(false);
    expect(canRemoveMember(admin, admin)).toBe(true);
    expect(canRemoveMember(agent, agent)).toBe(false);
    expect(canRemoveMember(null, agent)).toBe(false);
  });

  it("never offers Leave workspace or a role change to the only owner (the server keeps one owner)", () => {
    const owner = { userId: "o", role: "owner" as const };
    const admin = { userId: "a", role: "admin" as const };
    expect(isOnlyOwner([owner], "o")).toBe(true);
    expect(isOnlyOwner([owner, admin], "o")).toBe(true);
    expect(isOnlyOwner([owner, admin], "a")).toBe(false);
    expect(isOnlyOwner([owner, { userId: "o2", role: "owner" }], "o")).toBe(false);
    expect(isOnlyOwner(null, "o")).toBe(false);
    expect(canRemoveMember(owner, owner, [owner, admin])).toBe(false);
    expect(canRemoveMember(owner, owner, [owner, { userId: "o2", role: "owner" }])).toBe(true);
    expect(canRemoveMember(owner, admin, [owner, admin])).toBe(true);
    expect(canRemoveMember(admin, admin, [owner, admin])).toBe(true);
    // The hand-over picker says why it is empty instead of showing a lone blank option.
    expect(noTransferNote([owner], "o")).toBe("Invite a teammate first. Once they join, you can make them the owner here.");
    expect(noTransferNote([owner, { userId: "o2", role: "owner" }], "o")).toBe("Everyone else here is already an owner.");
    expect(noTransferNote([owner, admin], "o")).toBeNull();
  });

  it("asks before risky role changes and stays quiet for ordinary ones", () => {
    const me = { userId: "a", role: "admin" as const };
    const bob = { userId: "b", role: "agent" as const, name: "Bob" };
    expect(roleChangeConfirm(me, bob, "owner")?.title).toBe("Make Bob an owner?");
    expect(roleChangeConfirm(me, bob, "admin")).toBeNull();
    expect(roleChangeConfirm(me, bob, "agent")).toBeNull();
    const self = { userId: "a", role: "owner" as const, name: "Asha" };
    const demote = roleChangeConfirm({ userId: "a", role: "owner" }, self, "agent");
    expect(demote?.tone).toBe("danger");
    expect(demote?.confirmLabel).toBe("Change to agent");
  });

  it("words removal differently for yourself", () => {
    const me = { userId: "a", role: "admin" as const };
    expect(removeConfirm(me, { userId: "a", role: "admin", name: "Asha" }).title).toBe("Leave this workspace?");
    const other = removeConfirm(me, { userId: "b", role: "agent", name: "Bob" });
    expect(other.title).toBe("Remove Bob?");
    expect(other.confirmLabel).toBe("Remove from team");
  });

  it("describes invite expiry in words", () => {
    const now = new Date("2026-10-27T10:00:00Z");
    expect(describeExpiry("2026-10-26T10:00:00Z", now)).toEqual({ expired: true, label: "Expired. Create a new invite." });
    expect(describeExpiry("2026-10-27T20:00:00Z", now).label).toBe("Expires in less than a day");
    expect(describeExpiry("2026-11-02T10:00:00Z", now).label).toBe("Expires in 6 days");
    expect(roleLabel("agent")).toBe("Agent");
    expect(roleLabel("mystery")).toBe("Member");
  });
});

describe("api and webhook helpers", () => {
  it("has plain-language text for every scope and never shows a raw one when known", () => {
    for (const s of SCOPES) {
      expect(SCOPE_INFO[s].label).not.toContain(":");
      expect(SCOPE_INFO[s].description.length).toBeGreaterThan(10);
      expect(scopeLabel(s)).toBe(SCOPE_INFO[s].label);
    }
    expect(scopeLabel("future:scope")).toBe("future:scope");
    expect(DEFAULT_SCOPES).toEqual(["messages:write"]);
  });

  it("names webhook events and deliveries without jargon", () => {
    expect(eventLabel("message.received")).toBe("A customer sends a message");
    expect(eventLabel("order.shipped")).toBe("Order shipped");
    expect(deliveryDisplay("retrying")).toEqual({ status: "retry", label: "Will retry" });
    expect(deliveryDisplay("pending")).toEqual({ status: "queued", label: "Waiting to send" });
    expect(deliveryDisplay("weird_state").label).toBe("Weird state");
  });

  it("colours deliveries through the central status map only", () => {
    for (const raw of ["delivered", "failed", "retrying", "pending", "weird_state"]) {
      expect(STATUS_TONE).toHaveProperty(deliveryDisplay(raw).status);
    }
    expect(centralTone(deliveryDisplay("delivered").status)).toBe("good");
    expect(centralTone(deliveryDisplay("retrying").status)).toBe("warn");
    expect(centralTone(deliveryDisplay("pending").status)).toBe("info");
    expect(centralTone(deliveryDisplay("failed").status)).toBe("bad");
  });

  it("keeps refreshing deliveries while any is waiting and summarises them for screen readers", () => {
    expect(hasUnsettledDeliveries([{ status: "delivered" }, { status: "pending" }])).toBe(true);
    expect(hasUnsettledDeliveries([{ status: "retrying" }])).toBe(true);
    expect(hasUnsettledDeliveries([{ status: "delivered" }, { status: "failed" }])).toBe(false);
    expect(hasUnsettledDeliveries(null)).toBe(false);
    expect(deliverySummary([])).toBe("No deliveries yet.");
    expect(deliverySummary([{ status: "delivered" }])).toBe("1 delivery, all finished.");
    expect(deliverySummary([{ status: "pending" }, { status: "delivered" }])).toBe("2 deliveries, 1 still waiting.");
  });

  it("explains an endpoint that switched itself off", () => {
    expect(endpointNotice({ enabled: false, failureCount: 20 })).toMatch(/Turned off automatically/);
    expect(endpointNotice({ enabled: false, failureCount: 0 })).toBeNull();
    expect(endpointNotice({ enabled: true, failureCount: 25 })).toBeNull();
  });

  it("validates the endpoint address and key name", () => {
    expect(webhookUrlError("")).toMatch(/Enter the address/);
    expect(webhookUrlError("example.com/hook")).toMatch(/full address/);
    expect(webhookUrlError("http://example.com/hook")).toMatch(/https/);
    expect(webhookUrlError("https://example.com:8080/hook")).toMatch(/port 443 or 8443/);
    expect(webhookUrlError("https://example.com/hook")).toBeNull();
    expect(webhookUrlError("https://example.com:8443/hook")).toBeNull();
    expect(keyNameError(" ")).toMatch(/name/);
    expect(keyNameError("x".repeat(61))).toMatch(/60/);
    expect(keyNameError("Website")).toBeNull();
  });

  it("keeps placeholders only in the examples", () => {
    expect(DOC_SNIPPETS.map((s) => s.code).join("\n")).not.toMatch(/wak_[A-Za-z0-9_-]{8,}/);
  });

  it("renders a labelled checkbox row with its help text linked", () => {
    const html = renderToStaticMarkup(createElement(CheckRow, { checked: true, onChange: () => {}, label: "Send messages", description: "Send WhatsApp messages." }));
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain("Send messages");
    expect(html).toMatch(/aria-describedby="[^"]+-d"/);
    expect(html).toContain("min-h-10");
  });

  it("keeps a busy checkbox enabled, shows saving, and names the row for screen readers", () => {
    const html = renderToStaticMarkup(createElement(CheckRow, { checked: false, onChange: () => {}, label: "Send events to this address", forWhat: "https://a.example/hook", busy: true }));
    expect(html).not.toContain(`disabled=""`);
    expect(html).toContain("aria-busy");
    expect(html).toContain("Saving");
    expect(html).toContain(" for https://a.example/hook");
  });

  it("uses aria-disabled, not disabled, for buttons that are working", () => {
    const busy = renderToStaticMarkup(createElement(BusyButton, { busy: true, type: "submit" }, "Save changes"));
    expect(busy).toContain("aria-disabled");
    expect(busy).toContain("aria-busy");
    expect(busy).not.toContain(`disabled=""`);
    expect(renderToStaticMarkup(createElement(BusyButton, {}, "Save changes"))).not.toContain(`aria-disabled="`);
  });
});

describe("routing helpers", () => {
  const base = toForm({ ...DEFAULT_SETTINGS, autoAssign: true });

  it("matches the server limit", () => {
    expect(MAX_OPEN).toBe(MAX_OPEN_LIMIT);
  });

  it("parses the per-person limit", () => {
    expect(parseLimit("")).toEqual({ ok: true, value: null });
    expect(parseLimit(" 12 ")).toEqual({ ok: true, value: 12 });
    expect(parseLimit("0")).toEqual({ ok: false });
    expect(parseLimit("2.5")).toEqual({ ok: false });
    expect(parseLimit("abc")).toEqual({ ok: false });
    expect(parseLimit(String(MAX_OPEN + 1))).toEqual({ ok: false });
  });

  it("reports field errors in plain words and passes a valid form", () => {
    expect(validateForm(base)).toEqual({});
    expect(validateForm({ ...base, maxOpenPerAgent: "0" }).maxOpenPerAgent).toMatch(/whole number/);
    expect(validateForm({ ...base, alwaysOn: false, days: base.days.map((d) => ({ ...d, enabled: false })) }).hours).toMatch(/at least one working day/);
    const open = { ...base, alwaysOn: false, days: base.days.map((d, i) => (i === 1 ? { ...d, enabled: true } : d)) };
    expect(validateForm(open)).toEqual({});
    expect(validateForm({ ...open, timezone: "Mars/Olympus" }).timezone).toMatch(/time zone/);
    expect(validateForm({ ...open, days: open.days.map((d, i) => (i === 1 ? { ...d, start: "" } : d)) }).hours).toMatch(/start and end/);
  });

  it("ignores hidden fields while automatic sharing is off", () => {
    const off = { ...base, autoAssign: false, maxOpenPerAgent: "999", alwaysOn: false, days: base.days.map((d) => ({ ...d, enabled: false })) };
    expect(validateForm(off)).toEqual({});
    expect(toBody(off)).toEqual({ body: { autoAssign: false, mode: "round_robin", timezone: "Asia/Kolkata", workingHours: null, maxOpenPerAgent: null, fallbackUserId: null } });
    expect("error" in toBody({ ...off, autoAssign: true })).toBe(true);
  });

  it("saves the last saved values for hidden fields when sharing is switched off", () => {
    const saved = { ...base, maxOpenPerAgent: "5", mode: "least_busy" as const };
    const edited = { ...saved, autoAssign: false, maxOpenPerAgent: "999", mode: "round_robin" as const };
    expect(effectiveForm(edited, saved)).toEqual({ ...saved, autoAssign: false });
    expect(effectiveForm({ ...saved, maxOpenPerAgent: "7" }, saved).maxOpenPerAgent).toBe("7");
    expect(isDirty(effectiveForm(edited, saved), saved)).toBe(true);
    const offSaved = { ...base, autoAssign: false };
    expect(isDirty(effectiveForm({ ...offSaved, mode: "least_busy" }, offSaved), offSaved)).toBe(false);
  });

  it("renders the availability switch with a name that never changes", () => {
    const html = renderToStaticMarkup(createElement(AvailabilityToggle));
    expect(html).toContain('role="switch"');
    expect(html).toContain("Available for new chats");
    expect(html).not.toContain("Away");
    expect(html).not.toContain(`disabled=""`);
  });

  it("does not ask for a time zone when the rules run all day", () => {
    expect(validateForm({ ...base, timezone: "nonsense" })).toEqual({});
  });

  it("tracks unsaved changes and keeps the request shape", () => {
    expect(isDirty(base, base)).toBe(false);
    expect(isDirty(base, { ...base, mode: "least_busy" })).toBe(true);
    const built = toBody({ ...base, maxOpenPerAgent: "5", fallbackUserId: "u1" });
    expect(built).toEqual({ body: { autoAssign: true, mode: "round_robin", timezone: "Asia/Kolkata", workingHours: null, maxOpenPerAgent: 5, fallbackUserId: "u1" } });
    expect("error" in toBody({ ...base, alwaysOn: false, days: base.days.map((d) => ({ ...d, enabled: false })) })).toBe(true);
  });

  it("summarises the saved rules in one sentence", () => {
    expect(routingSummary({ ...base, autoAssign: false })).toMatch(/off/);
    expect(routingSummary(base)).toBe("New chats are shared out automatically (take turns) at any time.");
    expect(routingSummary({ ...base, alwaysOn: false, mode: "least_busy" }, "Asha")).toBe("New chats are shared out automatically (least busy first) during your working hours and go to Asha when nobody is free.");
    expect(Object.values(MODE_INFO).every((m) => m.description.length > 20)).toBe(true);
  });
});

describe("connect flow helpers", () => {
  const views: Record<string, FlowView> = {
    idle: { name: "idle" },
    waiting: { name: "waiting" },
    cancelled: { name: "cancelled" },
    connecting: { name: "connecting" },
    failedPopup: { name: "error", stage: 2 },
    failedSetup: { name: "error", stage: 3 },
    connected: { name: "connected" },
  };

  it("maps each view to a stage of the stepper", () => {
    expect(currentStage(views.idle)).toBe(1);
    expect(currentStage({ name: "loading" })).toBe(1);
    expect(currentStage(views.waiting)).toBe(2);
    expect(currentStage(views.cancelled)).toBe(2);
    expect(currentStage(views.connecting)).toBe(3);
    expect(currentStage(views.failedSetup)).toBe(3);
    expect(currentStage(views.connected)).toBe(4);
  });

  it("marks earlier stages done, the current one current or failed, later ones upcoming", () => {
    expect([1, 2, 3, 4].map((n) => stageState(n as 1 | 2 | 3 | 4, views.connecting))).toEqual(["done", "done", "current", "upcoming"]);
    expect(stageState(3, views.failedSetup)).toBe("failed");
    expect(stageState(2, views.failedPopup)).toBe("failed");
    expect(stageState(1, views.failedPopup)).toBe("done");
    expect(stageState(4, views.connected)).toBe("current");
    expect(stageState(3, views.connected)).toBe("done");
  });

  it("always lists every setup step, filling in what the server has not reported", () => {
    const merged = mergeSteps([{ step: "verify_ids", status: "done" }, { step: "exchange_code", status: "done" }]);
    expect(merged.map((s) => s.step)).toEqual(SETUP_STEPS.map((s) => s.step));
    expect(merged[0].status).toBe("done");
    expect(merged[2].status).toBe("pending");
    expect(setupProgress(merged)).toBe(Math.round((2 / SETUP_STEPS.length) * 100));
    expect(setupProgress([])).toBe(0);
  });

  it("uses plain names for steps and statuses, never the internal id", () => {
    expect(stepTitle("register_number")).toBe("Register your number");
    expect(stepTitle("brand_new_step")).toBe("Brand new step");
    expect(stepPill("started")).toEqual({ status: "started", label: "In progress" });
    expect(stepPill("pending")).toEqual({ status: "not_started", label: "Waiting" });
    for (const st of ["pending", "started", "done", "failed"] as const) expect(STATUS_TONE).toHaveProperty(stepPill(st).status);
    expect(centralTone(stepPill("pending").status)).toBe("neutral");
    expect(failedStepTitle([{ step: "subscribe_app", status: "failed" }])).toBe("Turn on message delivery");
    expect(failedStepTitle([{ step: "subscribe_app", status: "done" }])).toBeNull();
  });

  it("explains known failures with the real causes", () => {
    expect(classifyFailure("This connection attempt has expired. Please start again.").kind).toBe("expired");
    expect(classifyFailure("This connection attempt has expired. Please start again.").causes.join(" ")).toMatch(/30 seconds/);
    expect(classifyFailure("This WhatsApp account is already connected to another workspace.").kind).toBe("taken");
    expect(classifyFailure("A connection attempt is already running. Wait a minute and try again.").kind).toBe("busy");
    expect(classifyFailure("WhatsApp connection is not configured yet.").kind).toBe("unavailable");
    expect(classifyFailure("Could not load the Facebook sign-in. Check your connection or ad blocker and try again.").kind).toBe("blocked");
    expect(classifyFailure("Meta did not return your WhatsApp account details. Please try again.").kind).toBe("no-details");
    expect(classifyFailure("Too many requests, try later").kind).toBe("limit");
    expect(classifyFailure("Meta said: (#200) Permission denied. Try again.").kind).toBe("permission");
    expect(classifyFailure("Meta said: Number is registered elsewhere. Try again.").kind).toBe("meta");
    expect(classifyFailure("boom").kind).toBe("generic");
    expect(classifyFailure("They generate and operate").kind).toBe("generic");
  });

  it("gives Meta window errors Meta causes instead of a generic message", () => {
    const raw = classifyFailure("Something went wrong", 2);
    expect(raw.kind).toBe("meta");
    expect(raw.resumes).toBe(false);
    expect(raw.causes.join(" ")).toMatch(/full control of the business portfolio/);
    expect(classifyFailure("Something went wrong").kind).toBe("generic");
  });

  it("names the step in progress and announces setup progress", () => {
    expect(activeStepTitle([])).toBe("Confirm your sign-in with Meta");
    expect(activeStepTitle([{ step: "exchange_code", status: "done" }, { step: "verify_ids", status: "started" }])).toBe("Check your account");
    expect(activeStepTitle(SETUP_STEPS.map((x) => ({ step: x.step, status: "done" as const })))).toBeNull();
    expect(liveAnnouncement({ name: "connecting" }, [{ step: "exchange_code", status: "done" }], false)).toBe("Step 3 of 4: We finish the setup. Now: Check your account.");
    expect(liveAnnouncement({ name: "connected" }, [], true)).toBe("Setup finished. Step 4 of 4: Add a payment method.");
    expect(liveAnnouncement({ name: "connected" }, [], false)).toBe("Step 4 of 4: Add a payment method.");
    expect(liveAnnouncement({ name: "idle" }, [], false)).toBe("Step 1 of 4: Get ready.");
  });

  it("only promises to resume when the server really resumes", () => {
    expect(classifyFailure("This step failed. Try again.").resumes).toBe(true);
    expect(classifyFailure("This connection attempt has expired.").resumes).toBe(false);
  });

  it("describes where a person stopped, or says nothing when unsure", () => {
    expect(describeCancelStep("PHONE_NUMBER_SETUP")).toBe("adding your phone number");
    expect(describeCancelStep("verification_code")).toBe("entering the verification code");
    expect(describeCancelStep("BUSINESS_INFO")).toBe("choosing your business");
    expect(describeCancelStep("SOMETHING_ELSE")).toBeNull();
    expect(describeCancelStep(null)).toBeNull();
  });

  it("ships guidance for each Facebook screen and common problem", () => {
    expect(POPUP_SCREENS.length).toBeGreaterThanOrEqual(4);
    expect(TROUBLE_TOPICS.length).toBeGreaterThanOrEqual(5);
    expect(TROUBLE_TOPICS.some((t) => /payment method/i.test(t.answer))).toBe(true);
    expect(TROUBLE_TOPICS.some((t) => /30 seconds/.test(t.answer))).toBe(true);
  });
});

describe("role gate", () => {
  it("shows a loading state, not a permission message, until the role is known", () => {
    const html = renderToStaticMarkup(createElement(RoleGate, { loadingLabel: "Loading team", denied: createElement("p", null, "Not allowed"), children: createElement("p", null, "Secret") }));
    expect(html).toContain("Loading team");
    expect(html).toContain("aria-busy");
    expect(html).not.toContain("Not allowed");
    expect(html).not.toContain("Secret");
  });
});
