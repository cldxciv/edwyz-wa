/**
 * The two Eddy hooks in src/lib/lifecycle/erasure.ts (docs/EDDY-SPEC.md 7.6, 8.3, EDDY-16 acceptance 6 and 8):
 * - deleteContactData clears what Eddy holds about the contact in the SAME transaction: every Eddy conversation that mentions
 *   the contact loses all its messages and is marked erased, a turn still running there is aborted, and the action records and
 *   notices about the contact or its chats are deleted;
 * - anonymiseUser makes Eddy forget the user in every workspace (kept sole-owner ones included), also in its transaction:
 *   afterwards no Eddy row holds their userId except a running or unknown ActionRecord (left to the reconcile job), and the
 *   EddyTurn and ActionInvocation rows stay with userId NULL.
 * The real erasure code and the real Eddy helpers run on the in-memory store (tests/helpers/fake-notices-db.ts). The store is
 * wrapped so that $transaction hands out its own client and rolls every table back when the callback throws, like Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeNoticesDb, type Row } from "./helpers/fake-notices-db";

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("./helpers/fake-notices-db").createFakeNoticesDb>,
  /** "<client>:<model>" for every model reached, so a test can prove the Eddy rows went through the transaction client. */
  access: [] as string[],
  inTx: false,
  revoke: vi.fn(async () => 0),
  removeMedia: vi.fn(async () => 0),
}));

const EDDY_MODELS = new Set(["eddyConversation", "eddyMessage", "eddyTurn", "eddyUserPref", "actionRecord", "actionInvocation", "notice", "noticeReceipt"]);

/** One client view of the fake store; adds the single-row delete the erasure code uses. */
function view(label: "app" | "tx"): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_t, name) {
        if (typeof name !== "string" || name === "then" || !h.fake) return undefined;
        if (name === "$transaction") return transaction;
        const d = h.fake.client[name] as Record<string, (a: Row) => Promise<unknown>>;
        if (!d || name.startsWith("$")) return d;
        h.access.push(`${label}:${name}`);
        return {
          ...d,
          async delete(a: { where: Row }) {
            const rows = h.fake.rows(name);
            const i = rows.findIndex((r) => Object.entries(a.where).every(([k, v]) => r[k] === v));
            if (i < 0) throw Object.assign(new Error("Record not found"), { code: "P2025" });
            return rows.splice(i, 1)[0];
          },
        };
      },
    },
  );
}

async function transaction(fn: unknown) {
  if (typeof fn !== "function") return Promise.all(fn as Promise<unknown>[]);
  const snapshot = structuredClone(h.fake.tables);
  h.inTx = true;
  try {
    return await (fn as (tx: unknown) => Promise<unknown>)(view("tx"));
  } catch (error) {
    for (const k of Object.keys(h.fake.tables)) delete h.fake.tables[k];
    Object.assign(h.fake.tables, snapshot);
    throw error;
  } finally {
    h.inTx = false;
  }
}

vi.mock("@/lib/db", () => ({ prisma: view("app") }));
vi.mock("@/lib/integrations/apikeys", () => ({ revokeKeysBestEffort: h.revoke }));
vi.mock("@/lib/inbox/media", () => ({ removeInboundMediaFiles: h.removeMedia }));

import { anonymiseUser, deleteContactData } from "@/lib/lifecycle/erasure";
import { buildContactExport, eddyRecordsLine } from "@/lib/lifecycle/export-contact";

const NOW = new Date("2026-10-29T06:00:00Z");
h.fake = createFakeNoticesDb(() => NOW);
const fake = h.fake;
const rows = (model: string) => fake.rows(model);
const ids = (model: string) => rows(model).map((r) => String(r.id));
const eddyAccess = () => h.access.filter((a) => EDDY_MODELS.has(a.split(":")[1]));

beforeEach(() => {
  fake.reset();
  h.access.length = 0;
  h.revoke.mockClear();
  h.removeMedia.mockClear();
});

describe("deleteContactData reaches Eddy in the same transaction (EDDY-16 acceptance 6)", () => {
  function seedContact() {
    fake.seed("contact", { id: "c1", tenantId: "t1", phone: "+911" }, { id: "c2", tenantId: "t1", phone: "+912" });
    fake.seed("conversation", { id: "v1", tenantId: "t1", contactId: "c1" }, { id: "v2", tenantId: "t1", contactId: "c2" });
    fake.seed("message", { id: "m1", tenantId: "t1", conversationId: "v1" }, { id: "m2", tenantId: "t1", conversationId: "v2" });
    // Eddy: e1 mentions c1 in one message only; e2 mentions only c2; e3 is another workspace naming the same id.
    fake.seed("eddyConversation", { id: "e1", tenantId: "t1", userId: "u1" }, { id: "e2", tenantId: "t1", userId: "u1" }, { id: "e3", tenantId: "t2", userId: "u9" });
    fake.seed(
      "eddyMessage",
      { id: "em1", tenantId: "t1", conversationId: "e1", contactIds: ["c1"] },
      { id: "em2", tenantId: "t1", conversationId: "e1", contactIds: [] },
      { id: "em3", tenantId: "t1", conversationId: "e2", contactIds: ["c2"] },
      { id: "em4", tenantId: "t2", conversationId: "e3", contactIds: ["c1"] },
    );
    fake.seed("eddyTurn", { id: "tu1", tenantId: "t1", conversationId: "e1", userId: "u1", status: "running" }, { id: "tu2", tenantId: "t1", conversationId: "e2", userId: "u1", status: "running" });
    fake.seed("actionRecord", { id: "ar1", tenantId: "t1", userId: "u1", status: "pending", contactIds: ["c1"] }, { id: "ar2", tenantId: "t1", userId: "u1", status: "pending", contactIds: ["c2"] });
    fake.seed(
      "notice",
      { id: "n1", tenantId: "t1", dedupeKey: "k1", kind: "send_failures", subjectType: "contact", subjectId: "c1" },
      { id: "n2", tenantId: "t1", dedupeKey: "k2", kind: "send_failures", subjectType: "conversation", subjectId: "v1" },
      { id: "n3", tenantId: "t1", dedupeKey: "k3", kind: "send_failures", subjectType: "conversation", subjectId: "v2" },
      { id: "n4", tenantId: "t2", dedupeKey: "k1", kind: "send_failures", subjectType: "contact", subjectId: "c1" },
    );
    fake.seed("noticeReceipt", { tenantId: "t1", noticeId: "n1", userId: "u1" }, { tenantId: "t1", noticeId: "n3", userId: "u1" });
  }

  it("erases the Eddy conversations that mention the contact, its action records and notices, and nothing else", async () => {
    seedContact();
    expect(await deleteContactData("t1", "+911")).toEqual({ deleted: true });

    expect(ids("contact")).toEqual(["c2"]);
    expect(ids("message")).toEqual(["m2"]);
    // e1 mentioned the contact once: ALL its messages go (no thread with a hole) and it is marked erased.
    expect(ids("eddyMessage")).toEqual(["em3", "em4"]);
    expect(rows("eddyConversation").find((r) => r.id === "e1")).toMatchObject({ status: "erased", closedReason: "contact_erased" });
    expect(rows("eddyConversation").find((r) => r.id === "e2")).toMatchObject({ status: "active" });
    expect(rows("eddyConversation").find((r) => r.id === "e3")).toMatchObject({ status: "active" });
    expect(rows("eddyTurn").find((r) => r.id === "tu1")).toMatchObject({ status: "aborted", errorCode: "erased" });
    expect(rows("eddyTurn").find((r) => r.id === "tu2")).toMatchObject({ status: "running" });
    expect(ids("actionRecord")).toEqual(["ar2"]);
    // The notice about the contact and the one about its chat go with their receipts; the other workspace is untouched.
    expect(ids("notice")).toEqual(["n3", "n4"]);
    expect(rows("noticeReceipt").map((r) => r.noticeId)).toEqual(["n3"]);
  });

  it("goes through the transaction client only, so the Eddy rows and the contact go together", async () => {
    seedContact();
    await deleteContactData("t1", "+911");
    const eddy = eddyAccess();
    expect(eddy.length).toBeGreaterThan(0);
    expect(eddy.filter((a) => a.startsWith("app:"))).toEqual([]);
  });

  it("a failure while clearing Eddy rolls the whole erasure back, so it can simply be run again", async () => {
    seedContact();
    fake.failNext("eddyConversation", "updateMany", new Error("db down"));
    await expect(deleteContactData("t1", "+911")).rejects.toThrow("db down");
    expect(ids("contact")).toEqual(["c1", "c2"]);
    expect(ids("message")).toEqual(["m1", "m2"]);
    expect(ids("eddyMessage")).toEqual(["em1", "em2", "em3", "em4"]);
    expect(h.removeMedia).not.toHaveBeenCalled();

    expect(await deleteContactData("t1", "+911")).toEqual({ deleted: true });
    expect(ids("eddyMessage")).toEqual(["em3", "em4"]);
  });

  it("an unknown contact touches no Eddy row", async () => {
    seedContact();
    expect(await deleteContactData("t1", "+999")).toEqual({ deleted: false });
    expect(eddyAccess()).toEqual([]);
    expect(ids("eddyMessage")).toEqual(["em1", "em2", "em3", "em4"]);
  });
});

describe("anonymiseUser makes Eddy forget the user everywhere (EDDY-16 acceptance 8, 7.6, 8.3)", () => {
  function seedUser() {
    fake.seed("user", { id: "u1", name: "Priya", email: "priya@example.com" }, { id: "u2", name: "Ravi", email: "ravi@example.com" });
    // t1: u1 is the only owner (kept); t2: u1 is an agent (removed); t3: u1 left earlier but Eddy still holds rows there.
    fake.seed("membership", { id: "m1", tenantId: "t1", userId: "u1", role: "owner" }, { id: "m2", tenantId: "t2", userId: "u1", role: "agent" }, { id: "m3", tenantId: "t2", userId: "u2", role: "owner" });
    for (const t of ["t1", "t2", "t3"]) {
      fake.seed("eddyConversation", { id: `ec_${t}`, tenantId: t, userId: "u1" });
      fake.seed("eddyMessage", { id: `em_${t}`, tenantId: t, conversationId: `ec_${t}` });
      fake.seed("eddyUserPref", { tenantId: t, userId: "u1" });
      fake.seed("eddyTurn", { id: `tu_${t}`, tenantId: t, conversationId: `ec_${t}`, userId: "u1", status: t === "t1" ? "running" : "done" });
      fake.seed("actionInvocation", { id: `ai_${t}`, tenantId: t, userId: "u1" });
      fake.seed("notice", { id: `own_${t}`, tenantId: t, dedupeKey: `own_${t}`, kind: "approvals_waiting", audienceUserId: "u1" });
      fake.seed("noticeReceipt", { tenantId: t, noticeId: `own_${t}`, userId: "u1" });
    }
    fake.seed(
      "actionRecord",
      { id: "ar_pending", tenantId: "t1", userId: "u1", status: "pending" },
      { id: "ar_done", tenantId: "t2", userId: "u1", status: "succeeded" },
      { id: "ar_running", tenantId: "t3", userId: "u1", status: "running" },
      { id: "ar_unknown", tenantId: "t1", userId: "u1", status: "unknown" },
    );
    // A teammate's rows stay exactly as they are.
    fake.seed("eddyConversation", { id: "ec_u2", tenantId: "t2", userId: "u2" });
    fake.seed("eddyMessage", { id: "em_u2", tenantId: "t2", conversationId: "ec_u2" });
    fake.seed("eddyUserPref", { tenantId: "t2", userId: "u2" });
    fake.seed("notice", { id: "team_t2", tenantId: "t2", dedupeKey: "team_t2", kind: "template_approved", audienceUserId: null });
    fake.seed("noticeReceipt", { tenantId: "t2", noticeId: "team_t2", userId: "u2" });
  }

  const holding = (userId: string) =>
    [...EDDY_MODELS].flatMap((model) => rows(model).filter((r) => r.userId === userId || r.audienceUserId === userId).map((r) => `${model}:${String(r.id ?? r.noticeId ?? r.tenantId)}`));

  it("leaves no Eddy row with their userId except a running or unknown ActionRecord; usage and audit rows stay without them", async () => {
    seedUser();
    expect(await anonymiseUser("u1")).toEqual({ found: true, retainedWorkspaceIds: ["t1"] });

    expect(holding("u1").sort()).toEqual(["actionRecord:ar_running", "actionRecord:ar_unknown"]);
    expect(rows("eddyTurn").map((r) => [r.id, r.userId])).toEqual([["tu_t1", null], ["tu_t2", null], ["tu_t3", null]]);
    expect(rows("eddyTurn").find((r) => r.id === "tu_t1")).toMatchObject({ status: "aborted", errorCode: "member_left" });
    expect(rows("actionInvocation").map((r) => [r.id, r.userId])).toEqual([["ai_t1", null], ["ai_t2", null], ["ai_t3", null]]);
    expect(ids("eddyMessage")).toEqual(["em_u2"]);
    // The teammate keeps everything.
    expect(holding("u2").sort()).toEqual(["eddyConversation:ec_u2", "eddyUserPref:t2", "noticeReceipt:team_t2"]);
    expect(ids("notice")).toEqual(["team_t2"]);
    // The account itself is anonymised as before, and its keys are revoked after the commit.
    expect(rows("user").find((r) => r.id === "u1")).toMatchObject({ name: "Deleted user", email: "deleted-u1@deleted.invalid" });
    expect(ids("membership")).toEqual(["m1", "m3"]);
    expect(h.revoke).toHaveBeenCalledWith("u1", undefined, "user_anonymised");
  });

  it("goes through the transaction client only", async () => {
    seedUser();
    await anonymiseUser("u1");
    expect(eddyAccess().length).toBeGreaterThan(0);
    expect(eddyAccess().filter((a) => a.startsWith("app:"))).toEqual([]);
  });

  it("a failure while forgetting rolls the anonymisation back and revokes nothing, so it can be run again", async () => {
    seedUser();
    fake.failNext("actionRecord", "updateMany", new Error("db down"));
    await expect(anonymiseUser("u1")).rejects.toThrow("db down");
    expect(rows("user").find((r) => r.id === "u1")).toMatchObject({ name: "Priya", email: "priya@example.com" });
    expect(ids("membership")).toEqual(["m1", "m2", "m3"]);
    expect(holding("u1").length).toBeGreaterThan(10);
    expect(h.revoke).not.toHaveBeenCalled();

    await anonymiseUser("u1");
    expect(holding("u1").sort()).toEqual(["actionRecord:ar_running", "actionRecord:ar_unknown"]);
  });

  it("an unknown user touches no Eddy row", async () => {
    seedUser();
    expect(await anonymiseUser("ghost")).toEqual({ found: false, retainedWorkspaceIds: [] });
    expect(eddyAccess()).toEqual([]);
  });
});

describe("an anonymised member with nothing in flight (7.6; brief acceptance 5)", () => {
  it("leaves no Eddy row with their userId: only the nulled EddyTurn and ActionInvocation rows remain", async () => {
    fake.seed("user", { id: "u1", name: "Priya", email: "priya@example.com" });
    fake.seed("membership", { id: "m1", tenantId: "t1", userId: "u1", role: "agent" }, { id: "m2", tenantId: "t1", userId: "u2", role: "owner" });
    fake.seed("eddyConversation", { id: "ec1", tenantId: "t1", userId: "u1" });
    fake.seed("eddyMessage", { id: "em1", tenantId: "t1", conversationId: "ec1" });
    fake.seed("eddyUserPref", { tenantId: "t1", userId: "u1" });
    fake.seed("eddyTurn", { id: "tu1", tenantId: "t1", conversationId: "ec1", userId: "u1", status: "done" });
    fake.seed("actionInvocation", { id: "ai1", tenantId: "t1", userId: "u1" });
    fake.seed("actionRecord", { id: "ar1", tenantId: "t1", userId: "u1", status: "pending" }, { id: "ar2", tenantId: "t1", userId: "u1", status: "done" });
    fake.seed("notice", { id: "own", tenantId: "t1", dedupeKey: "own", kind: "approvals_waiting", audienceUserId: "u1" });
    fake.seed("noticeReceipt", { tenantId: "t1", noticeId: "own", userId: "u1" });

    expect(await anonymiseUser("u1")).toEqual({ found: true, retainedWorkspaceIds: [] });
    const left = [...EDDY_MODELS].flatMap((model) => rows(model).filter((r) => r.userId === "u1" || r.audienceUserId === "u1").map((r) => model));
    expect(left).toEqual([]);
    expect(rows("eddyTurn")).toEqual([expect.objectContaining({ id: "tu1", userId: null })]);
    expect(rows("actionInvocation")).toEqual([expect.objectContaining({ id: "ai1", userId: null })]);
    expect(ids("eddyConversation")).toEqual([]);
    expect(ids("eddyMessage")).toEqual([]);
  });
});

describe("the contact export counts the Eddy records about the contact (7.6)", () => {
  it("says how many Eddy assistant records mention the contact and when they go", async () => {
    fake.seed("contact", { id: "c1", tenantId: "t1", phone: "+911" });
    fake.seed("eddyConversation", { id: "e1", tenantId: "t1", userId: "u1" }, { id: "e2", tenantId: "t1", userId: "u1" }, { id: "e3", tenantId: "t2", userId: "u9" });
    fake.seed(
      "eddyMessage",
      { id: "em1", tenantId: "t1", conversationId: "e1", contactIds: ["c1"] },
      { id: "em2", tenantId: "t1", conversationId: "e1", contactIds: ["c1"] },
      { id: "em3", tenantId: "t1", conversationId: "e2", contactIds: ["c1", "c2"] },
      { id: "em4", tenantId: "t1", conversationId: "e2", contactIds: [] },
      { id: "em5", tenantId: "t2", conversationId: "e3", contactIds: ["c1"] },
    );
    fake.seed("actionRecord", { id: "ar1", tenantId: "t1", userId: "u1", status: "done", contactIds: ["c1"] }, { id: "ar2", tenantId: "t1", userId: "u1", status: "done", contactIds: ["c2"] });
    const out = await buildContactExport({ tenantId: "t1", userId: "u_admin" }, "c1", NOW);
    // Two conversations (e1, e2) and one action record; the other workspace's rows do not count.
    expect(out.eddyAssistantRecords).toEqual({ count: 3, note: "Eddy assistant records that mention this contact: 3 (deleted after 90 days)" });
    expect(eddyRecordsLine(0, 30)).toBe("Eddy assistant records that mention this contact: 0 (deleted after 30 days)");
  });
});
