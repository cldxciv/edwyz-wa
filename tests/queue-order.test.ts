import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ $executeRaw: vi.fn(), $queryRaw: vi.fn(), job: { update: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: db }));

import { inQueueOrder, runDueJobs } from "@/lib/queue";

const at = (s: number) => new Date(Date.UTC(2026, 9, 30, 10, 0, s));
const job = (id: string, runAt: number, createdAt: number) => ({ id, payload: { id }, attempts: 1, maxAttempts: 5, runAt: at(runAt), createdAt: at(createdAt) });

beforeEach(() => {
  vi.clearAllMocks();
  db.$executeRaw.mockResolvedValue(0);
  db.job.update.mockResolvedValue({});
});

describe("job order", () => {
  it("sorts by run time, then by when the job was queued, then by id", () => {
    const jobs = [job("c", 5, 1), job("b", 1, 3), job("a", 1, 3), job("d", 1, 2)];
    expect(inQueueOrder(jobs).map((j) => j.id)).toEqual(["d", "a", "b", "c"]);
    expect(jobs.map((j) => j.id)).toEqual(["c", "b", "a", "d"]);
  });

  it("runs claimed jobs oldest first even when Postgres returns them in another order", async () => {
    // Two quick messages from one customer: STOP was queued before START, but RETURNING gave START first.
    db.$queryRaw.mockResolvedValue([
      { ...job("start", 0, 2), payload: "START" },
      { ...job("stop", 0, 1), payload: "STOP" },
    ]);
    const seen: unknown[] = [];
    expect(await runDueJobs("webhook", async (payload) => void seen.push(payload))).toBe(2);
    expect(seen).toEqual(["STOP", "START"]);
    const sql = (db.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toContain('ORDER BY "runAt", "createdAt", id');
    expect(sql).toContain('RETURNING id, payload, attempts, "maxAttempts", "runAt", "createdAt"');
  });

  it("still marks each job done or queued for a retry", async () => {
    db.$queryRaw.mockResolvedValue([job("ok", 0, 1), job("bad", 0, 2)]);
    await runDueJobs("webhook", async (payload) => {
      if ((payload as { id: string }).id === "bad") throw new Error("boom");
    });
    expect(db.job.update).toHaveBeenCalledWith({ where: { id: "ok" }, data: { status: "done", lockedAt: null } });
    expect(db.job.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "bad" }, data: expect.objectContaining({ status: "queued", lastError: "boom" }) }));
  });
});
