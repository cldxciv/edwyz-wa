import type { WorkerModule } from "@/worker/registry";
import { PUBLISH_QUEUE, claimAndEnqueue, processPost } from "./publish";

export const worker: WorkerModule = {
  queues: {
    [PUBLISH_QUEUE]: async (payload) => {
      const p = payload as { tenantId?: unknown; postId?: unknown } | null;
      if (typeof p?.tenantId !== "string" || typeof p.postId !== "string") return;
      await processPost(p.tenantId, p.postId);
    },
  },
  periodic: [{ name: "content.claim-due", everyMs: 30_000, run: () => claimAndEnqueue() }],
};
