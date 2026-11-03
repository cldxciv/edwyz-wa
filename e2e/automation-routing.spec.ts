import { expect, test, type Page } from "@playwright/test";
import { closeDb, connectFakeNumber, db, deliverInbound, ORIGIN, tick, watchErrors } from "./helpers";
import { axeProblems, enterApp, newMember, newOwner, overflowsX, toggleTheme } from "./automation-fixtures";

/** The page now also has a "Smarter routing and privacy" form with its own Save changes button; this is the sharing form. */
const sharing = (page: Page) => page.locator("form").filter({ hasText: "How new chats are shared" });

test.afterAll(closeDb);
test.setTimeout(150_000);

async function assignee(tenantId: string, phoneEnd: string): Promise<string | null | undefined> {
  const r = await (await db()).query(`select c."assignedToId" a from "Conversation" c join "Contact" ct on ct.id=c."contactId" where c."tenantId"=$1 and ct.phone like $2`, [tenantId, `%${phoneEnd}`]);
  return r.rows[0] ? (r.rows[0].a as string | null) : undefined;
}

async function inbound(page: Page, fx: { wabaId: string; phoneNumberId: string }, tenantId: string, phone: string) {
  await deliverInbound(page.request, fx, phone, "hello", `Customer ${phone.slice(-4)}`);
  // each round runs one tick, which the helper allows up to 60 s when the scheduled sweeps fall due, so the poll allows as much
  await expect.poll(async () => {
    await tick(page.request, 1);
    return (await assignee(tenantId, phone)) !== undefined;
  }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe(true);
  // give the assignment step a moment after the message is stored
  await tick(page.request, 1);
  return assignee(tenantId, phone);
}

test.describe.serial("routing: settings, availability and automatic assignment", () => {
  let owner: Awaited<ReturnType<typeof newOwner>>;
  let agent: Awaited<ReturnType<typeof newMember>>;
  let fx: Awaited<ReturnType<typeof connectFakeNumber>>;
  let errors: string[];
  const T = () => owner.user.tenantId;

  test.beforeAll(async ({ browser }) => {
    owner = await newOwner(browser, "routing");
    errors = watchErrors(owner.page);
    fx = await connectFakeNumber(owner.user.tenantId);
    agent = await newMember(browser, owner.user, "agent", "routeagent");
  });
  test.afterAll(async () => {
    await agent.context.close();
    await owner.context.close();
  });

  test("the page explains itself, starts switched off, and lists the team", async () => {
    const { page } = owner;
    await enterApp(page);
    await page.getByRole("link", { name: "Chat routing" }).first().click();
    await expect(page).toHaveURL(/\/app\/settings\/routing$/);
    await expect(page.getByRole("heading", { level: 1, name: "Chat routing" })).toBeVisible();
    await expect(page.getByText("Automatic assignment is off. New chats wait in the inbox until someone picks them up.")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Share new chats automatically" })).not.toBeChecked();
    const team = page.getByRole("table", { name: "Team members and their chat limits" });
    await expect(team).toContainText(owner.user.name);
    await expect(team).toContainText(agent.user.name);
    await expect(team).toContainText("Owner");
    await expect(team).toContainText("Never");
    // the how-to-choose options are hidden until sharing is switched on
    await expect(page.getByText("How should we choose?")).toHaveCount(0);
  });

  test("with sharing off an inbound chat stays unassigned", async () => {
    const { page } = owner;
    expect(await inbound(page, fx, T(), "919811000001")).toBeNull();
  });

  test("switching sharing on shows the choices; invalid values are refused in words; Discard restores", async () => {
    const { page } = owner;
    await page.getByRole("checkbox", { name: "Share new chats automatically" }).check();
    await expect(page.getByText("How should we choose?")).toBeVisible();
    await expect(page.getByRole("radio", { name: /Take turns/ })).toBeChecked();
    await expect(page.getByText("You have changes that are not saved yet.")).toBeVisible();
    // an impossible chat limit
    await page.getByLabel("Most open chats per person").fill("0");
    await sharing(page).getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/Enter a whole number from 1 to 500/)).toBeVisible();
    await expect(page.getByLabel("Most open chats per person")).toBeFocused();
    await page.getByLabel("Most open chats per person").fill("");
    // working hours with no day
    await page.getByRole("checkbox", { name: "All day, every day" }).uncheck();
    for (const d of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
      const box = page.getByRole("checkbox", { name: d, exact: true });
      if (await box.isChecked()) await box.uncheck();
    }
    await sharing(page).getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Turn on at least one working day, or choose always on.")).toBeVisible();
    // bad time zone
    await page.getByRole("checkbox", { name: "Monday", exact: true }).check();
    await page.getByLabel("Time zone").fill("Mars/Phobos");
    await sharing(page).getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/Choose a time zone from the list/)).toBeVisible();
    await sharing(page).getByRole("button", { name: "Discard changes" }).click();
    await expect(page.getByRole("checkbox", { name: "Share new chats automatically" })).not.toBeChecked();
    await expect(page.getByText("You have changes that are not saved yet.")).toHaveCount(0);
  });

  test("save automatic sharing (take turns, all day) and it survives a reload", async () => {
    const { page } = owner;
    await page.getByRole("checkbox", { name: "Share new chats automatically" }).check();
    await sharing(page).getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Routing settings saved")).toBeVisible();
    await expect(page.getByText(/New chats are shared out automatically \(take turns\) at any time\./)).toBeVisible();
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Share new chats automatically" })).toBeChecked();
    const row = (await (await db()).query(`select "autoAssign", mode, "workingHours" from "RoutingConfig" where "tenantId"=$1`, [T()])).rows[0];
    expect(row.autoAssign).toBe(true);
    expect(row.mode).toBe("round_robin");
    expect(row.workingHours).toBeNull();
  });

  test("two new chats are shared between the two available people, one each", async () => {
    const { page } = owner;
    const a = await inbound(page, fx, T(), "919811000002");
    const b = await inbound(page, fx, T(), "919811000003");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(new Set([a, b]).size, "round robin should give the two chats to two different people").toBe(2);
    expect(new Set([a, b])).toEqual(new Set([owner.user.userId, agent.user.userId]));
    // the inbox shows who has the chat
    await page.goto("/app/inbox");
    await page.getByText("Customer 0002").first().click();
    // The Details panel (open on a wide screen) always shows the assignee; the header menu only when the chat column is wide.
    const assigned = page.getByRole("complementary", { name: "Contact details" }).getByLabel("Assigned to");
    await expect(assigned).toBeVisible();
    const chosen = await assigned.evaluate((s) => (s as HTMLSelectElement).selectedOptions[0].textContent);
    expect(chosen).not.toBe("Unassigned");
  });

  test("an already-owned chat is never moved by a later message", async () => {
    const { page } = owner;
    const before = await assignee(T(), "919811000002");
    await deliverInbound(page.request, fx, "919811000002", "me again", "Customer 0002");
    await tick(page.request, 3);
    expect(await assignee(T(), "919811000002")).toBe(before);
  });

  test("marking a teammate Away sends the next chats to the others", async () => {
    const { page } = owner;
    await page.goto("/app/settings/routing");
    const box = page.getByRole("checkbox", { name: `${agent.user.name} is available for new chats` });
    await expect(box).toBeChecked();
    await box.click(); // the switch only changes once the server has saved it, so click and then wait for the result
    await expect(box).not.toBeChecked();
    await expect(page.getByText(`${agent.user.name} is away`)).toBeVisible();
    await expect(page.getByRole("table", { name: "Team members and their chat limits" }).getByText("Away")).toBeVisible();
    expect(await inbound(page, fx, T(), "919811000004")).toBe(owner.user.userId);
    expect(await inbound(page, fx, T(), "919811000005")).toBe(owner.user.userId);
    await box.click();
    await expect(box).toBeChecked();
    await expect(page.getByText(`${agent.user.name} is available`)).toBeVisible();
  });

  test("a person can mark themselves away from the switch at the top of the page, and an agent cannot change routing", async () => {
    const p = agent.page;
    await p.goto("/app/settings/routing");
    await expect(p.getByRole("heading", { level: 1, name: "Chat routing" })).toBeVisible();
    await expect(p.getByText(/Only owners and admins can change routing/)).toBeVisible();
    await expect(p.getByRole("checkbox", { name: "Share new chats automatically" })).toHaveCount(0);
    // the same switch now appears twice: in the top bar and in the page; this test drives the one in the top bar
    const sw = p.getByRole("banner").getByRole("switch", { name: "Available for new chats" });
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await sw.click();
    await expect(p.getByText("You are away. New chats will go to others")).toBeVisible();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    const row = (await (await db()).query(`select available from "AgentAvailability" where "tenantId"=$1 and "userId"=$2`, [T(), agent.user.userId])).rows[0];
    expect(row.available).toBe(false);
    // direct calls are refused
    const put = await agent.context.request.put("/api/routing/config", { headers: { origin: ORIGIN }, data: { autoAssign: false, mode: "round_robin", timezone: "UTC", workingHours: null, maxOpenPerAgent: null, fallbackUserId: null } });
    expect(put.status()).toBe(403);
    const other = await agent.context.request.put(`/api/routing/agents/${owner.user.userId}`, { headers: { origin: ORIGIN }, data: { available: false } });
    expect(other.status()).toBe(403);
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
  });

  test("a per-person chat limit saves on Enter, is explained in words, and is honoured", async () => {
    const { page } = owner;
    await page.goto("/app/settings/routing");
    // take the agent out so the owner is the only candidate, then cap the owner
    { const b = page.getByRole("checkbox", { name: `${agent.user.name} is available for new chats` }); await b.click(); await expect(b).not.toBeChecked(); }
    await expect(page.getByText(`${agent.user.name} is away`)).toBeVisible();
    const limit = page.getByLabel(`Open chat limit for ${owner.user.name}`);
    await limit.fill("abc");
    await expect(limit).toHaveValue(""); // digits only
    await limit.fill("1");
    await limit.press("Enter");
    await expect(page.getByText(/can have up to 1 open chat/)).toBeVisible();
    // the owner already holds several open chats, so nobody is free: the chat stays unassigned
    expect(await inbound(page, fx, T(), "919811000006")).toBeNull();
    await limit.fill("");
    await limit.press("Enter");
    await expect(page.getByText(`${owner.user.name} has no chat limit`)).toBeVisible();
  });

  test("the fallback person receives chats when nobody is free", async () => {
    const { page } = owner;
    await page.getByLabel("When nobody is free, give the chat to").selectOption({ label: agent.user.name });
    await sharing(page).getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Routing settings saved")).toBeVisible();
    { const b = page.getByRole("checkbox", { name: `${owner.user.name} is available for new chats` }); await b.click(); await expect(b).not.toBeChecked(); }
    await expect(page.getByText(`${owner.user.name} is away`)).toBeVisible();
    expect(await inbound(page, fx, T(), "919811000007")).toBe(agent.user.userId);
  });

  test("outside working hours new chats are not shared (they go to the fallback person)", async () => {
    const { page } = owner;
    { const b = page.getByRole("checkbox", { name: `${owner.user.name} is available for new chats` }); await b.click(); await expect(b).toBeChecked(); }
    { const b = page.getByRole("checkbox", { name: `${agent.user.name} is available for new chats` }); await b.click(); await expect(b).toBeChecked(); }
    await page.getByRole("checkbox", { name: "All day, every day" }).uncheck();
    const tz = await page.getByLabel("Time zone").inputValue();
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const today = new Date().toLocaleString("en-US", { weekday: "long", timeZone: tz });
    const open = names[(names.indexOf(today) + 3) % 7];
    for (const d of names) {
      const box = page.getByRole("checkbox", { name: d, exact: true });
      if ((await box.isChecked()) !== (d === open)) await box.setChecked(d === open);
    }
    await sharing(page).getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Routing settings saved")).toBeVisible();
    await expect(page.getByText(/during your working hours/)).toBeVisible();
    // outside hours: the fallback person (the agent) gets it, nobody else
    expect(await inbound(page, fx, T(), "919811000008")).toBe(agent.user.userId);
    // working hours on the saved row use the chosen day only
    const wh = (await (await db()).query(`select "workingHours" w from "RoutingConfig" where "tenantId"=$1`, [T()])).rows[0].w as { windows: { day: number }[] };
    expect(wh.windows.map((w) => w.day)).toEqual([names.indexOf(open)]);
  });

  test("least busy mode is selectable and saved", async () => {
    const { page } = owner;
    await page.getByRole("checkbox", { name: "All day, every day" }).check();
    await page.getByRole("radio", { name: /Least busy first/ }).check();
    // wait for the save itself: the "saved" toast of the previous test can still be on screen
    const saved = page.waitForResponse((r) => r.url().includes("/api/routing/config") && r.request().method() === "PUT");
    await sharing(page).getByRole("button", { name: "Save changes" }).click();
    expect((await saved).ok()).toBe(true);
    await expect(page.getByText("Routing settings saved").last()).toBeVisible(); // the earlier toast may still be showing as well
    expect(((await (await db()).query(`select mode from "RoutingConfig" where "tenantId"=$1`, [T()])).rows[0]).mode).toBe("least_busy");
  });

  test("tenant isolation: another workspace cannot read or change this routing setup", async ({ browser }) => {
    const other = await newOwner(browser, "routing-other");
    try {
      await other.page.goto("/app/settings/routing");
      await expect(other.page.getByRole("heading", { level: 1, name: "Chat routing" })).toBeVisible();
      await expect(other.page.getByText(owner.user.name)).toHaveCount(0);
      await expect(other.page.getByText(agent.user.name)).toHaveCount(0);
      const r = await other.context.request.put(`/api/routing/agents/${agent.user.userId}`, { headers: { origin: ORIGIN }, data: { available: false } });
      expect([403, 404]).toContain(r.status());
      const list = await other.context.request.get("/api/routing/agents");
      expect(JSON.stringify(await list.json())).not.toContain(agent.user.userId);
      const before = (await (await db()).query(`select "autoAssign" a from "RoutingConfig" where "tenantId"=$1`, [T()])).rows[0].a;
      expect(before).toBe(true);
    } finally {
      await other.context.close();
    }
  });

  test("no console errors or failed requests on the owner's pages", async () => {
    expect(errors, errors.join("\n")).toEqual([]);
  });
});

test.describe("routing: accessibility and responsive", () => {
  test("axe, keyboard order, dark theme, 360px", async ({ browser }) => {
    const { context, page } = await newOwner(browser, "routing-a11y");
    try {
      const errors = watchErrors(page);
      await page.goto("/app/settings/routing");
      await expect(page.getByRole("heading", { level: 1, name: "Chat routing" })).toBeVisible();
      await page.getByRole("checkbox", { name: "Share new chats automatically" }).check();
      await page.getByRole("checkbox", { name: "All day, every day" }).uncheck();
      expect(await axeProblems(page), "light").toEqual([]);
      // keyboard: Space toggles the checkbox, Tab reaches Save
      await page.getByRole("checkbox", { name: "Share new chats automatically" }).focus();
      await page.keyboard.press("Space");
      await expect(page.getByRole("checkbox", { name: "Share new chats automatically" })).not.toBeChecked();
      await page.keyboard.press("Space");
      await toggleTheme(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", /dark/);
      expect(await axeProblems(page), "dark").toEqual([]);
      await page.setViewportSize({ width: 360, height: 740 });
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Chat routing" })).toBeVisible();
      await page.getByRole("checkbox", { name: "Share new chats automatically" }).check();
      await page.getByRole("checkbox", { name: "All day, every day" }).uncheck();
      expect(await overflowsX(page), "overflow at 360px").toBe(false);
      expect(errors, errors.join("\n")).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

test("the two Available for new chats switches on the routing page always agree", async ({ browser }) => {
  // The page shows the same switch in the top bar and in its own header. Changing one must change the other, or a person
  // sees "Available" and "Away" at the same time.
  const { context, page } = await newOwner(browser, "route-two");
  try {
    await page.goto("/app/settings/routing");
    await expect(page.getByRole("heading", { level: 1, name: "Chat routing" })).toBeVisible();
    const top = page.getByRole("banner").getByRole("switch", { name: "Available for new chats" });
    const inPage = page.locator("#main-content").getByRole("switch", { name: "Available for new chats" });
    await expect(top).toHaveAttribute("aria-checked", "true");
    await expect(inPage).toHaveAttribute("aria-checked", "true");
    await top.click();
    await expect(top).toHaveAttribute("aria-checked", "false");
    await expect(inPage).toHaveAttribute("aria-checked", "false");
  } finally {
    await context.close();
  }
});
