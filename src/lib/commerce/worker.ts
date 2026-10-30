import type { WorkerModule } from "@/worker/registry";
import { demoteUnclaimedStores } from "./claims";
import { expireOldCarts, processDueReminders } from "./reminders";

export const worker: WorkerModule = {
  queues: {},
  periodic: [
    { name: "commerce-reminders", everyMs: 60_000, run: () => processDueReminders() },
    { name: "commerce-demote-unclaimed", everyMs: 10 * 60_000, run: () => demoteUnclaimedStores() },
    { name: "commerce-expire", everyMs: 60 * 60_000, run: () => expireOldCarts() },
  ],
};
