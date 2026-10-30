import { test } from "@playwright/test";
import { ORIGIN, closeDb, signupUser } from "./helpers";
import { seedMeta } from "./growth-helpers";

test.afterAll(closeDb);

test("explore", async ({ context }) => {
  let t0 = Date.now(); const u = await signupUser(context, "explore"); console.log("SIGNUP ms", Date.now() - t0); t0 = Date.now();
  const m = await seedMeta(u, { ig: true, withDataset: true });
  const r = await context.request.post("/api/meta-connect/refresh", { headers: { origin: ORIGIN }, data: { connectionId: m.connId } });
  console.log("REFRESH ms", Date.now() - t0); console.log("REFRESH", r.status(), await r.text());
});
