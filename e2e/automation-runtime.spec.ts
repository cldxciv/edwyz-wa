import { expect, test, type Page } from "@playwright/test";
import { closeDb, connectFakeNumber, db, deliverInbound, tick, watchErrors } from "./helpers";
import { enterApp, newOwner } from "./automation-fixtures";

test.afterAll(closeDb);
test.setTimeout(150_000);

type Fx = Awaited<ReturnType<typeof connectFakeNumber>>;

async function conversationFor(tenantId: string, phone: string) {
  const d = await db();
  const r = await d.query(
    `select c.id, c.status, c."assignedToId", c.tags, ct.id as "contactId", ct.tags as "contactTags", ct."optedOutAt", ct.attributes
       from "Conversation" c join "Contact" ct on ct.id = c."contactId" where c."tenantId"=$1 and ct.phone like $2`,
    [tenantId, `%${phone}`],
  );
  return r.rows[0] as undefined | { id: string; status: string; assignedToId: string | null; tags: string[]; contactId: string; contactTags: string[]; optedOutAt: Date | null; attributes: Record<string, unknown> };
}

async function outboundBodies(tenantId: string, conversationId: string): Promise<string[]> {
  const r = await (await db()).query(`select body from "Message" where "tenantId"=$1 and "conversationId"=$2 and direction='outbound' order by "createdAt", id`, [tenantId, conversationId]);
  return r.rows.map((x) => x.body as string);
}

async function settle(request: Page["request"], fn: () => Promise<boolean>, what: string) {
  // each round runs one tick, which the helper allows up to 60 s when the scheduled sweeps fall due, so the poll allows as much
  await expect.poll(async () => {
    await tick(request, 1);
    return fn();
  }, { message: what, timeout: 60_000, intervals: [500, 1000, 2000] }).toBe(true);
}

test.describe.serial("a published chatbot answers a customer who writes a keyword", () => {
  let ctx: Awaited<ReturnType<typeof newOwner>>;
  let fx: Fx;
  let errors: string[];
  let botId = "";

  test.beforeAll(async ({ browser }) => {
    ctx = await newOwner(browser, "runtime");
    errors = watchErrors(ctx.page);
    fx = await connectFakeNumber(ctx.user.tenantId);
  });
  test.afterAll(async () => {
    await ctx.context.close();
  });

  test("build the bot from a template in the app and publish it", async () => {
    const { page } = ctx;
    await enterApp(page);
    await page.goto("/app/automation/chatbots/new");
    await page.getByRole("button", { name: "Use this template: Business hours reply" }).click();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Chatbot created as a draft. Publish it when you are ready.")).toBeVisible();
    // the address changes to the new chatbot's id a moment after the toast appears
    await expect(page).toHaveURL(/\/app\/automation\/chatbots\/(?!new$)[^/?#]+$/);
    botId = page.url().split("/").pop() as string;
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("Published. New matching conversations will use this version.")).toBeVisible();
  });

  test("a signed inbound message with the keyword starts the bot: sessions, outbound messages and the inbox agree", async () => {
    const { page, user } = ctx;
    await deliverInbound(page.request, fx, "919800000011", "What are your hours please?", "Keyword Customer");
    await settle(page.request, async () => Boolean(await conversationFor(user.tenantId, "919800000011")) && (await outboundBodies(user.tenantId, (await conversationFor(user.tenantId, "919800000011"))!.id)).length >= 2, "the bot's two messages are stored");
    const conv = (await conversationFor(user.tenantId, "919800000011"))!;
    const bodies = await outboundBodies(user.tenantId, conv.id);
    expect(bodies[0]).toContain("Our hours are Monday to Saturday, 9 am to 6 pm.");
    expect(bodies[1]).toContain("Is there anything else we can help with?");
    expect(bodies[1]).toMatch(/Talk to the team/);
    const sessions = (await (await db()).query(`select status, "waitingNodeId", "chatbotId" from "ChatbotSession" where "conversationId"=$1`, [conv.id])).rows;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].chatbotId).toBe(botId);
    expect(sessions[0].status).toBe("waiting");
    // the same conversation is visible to the team in the inbox with the bot's words
    await page.goto("/app/inbox");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await page.getByText("Keyword Customer").first().click();
    await expect(page.getByText(/Our hours are Monday to Saturday/).first()).toBeVisible();
    await expect(page.getByText(/Is there anything else we can help with\?/).first()).toBeVisible();
    // the bot's session list is visible through the API with a person-friendly contact name
    const r = await page.request.get(`/api/chatbots/${botId}/sessions`);
    expect(r.ok()).toBe(true);
    expect(JSON.stringify(await r.json())).toContain("Keyword Customer");
  });

  test("the customer's reply moves the bot on: choosing 'Talk to the team' hands the chat to people with a note", async () => {
    const { page, user } = ctx;
    const conv = (await conversationFor(user.tenantId, "919800000011"))!;
    await deliverInbound(page.request, fx, "919800000011", "1", "Keyword Customer");
    await settle(
      page.request,
      async () => ((await (await db()).query(`select status from "ChatbotSession" where "conversationId"=$1`, [conv.id])).rows[0]?.status as string) === "handed_off",
      "the session ends as handed over",
    );
    const bodies = await outboundBodies(user.tenantId, conv.id);
    expect(bodies.at(-1)).toContain("We have passed your message to the team");
    const notes = (await (await db()).query(`select body, "authorId" from "Note" where "conversationId"=$1`, [conv.id])).rows;
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].body).toMatch(/Chatbot hand-over/);
    const after = (await conversationFor(user.tenantId, "919800000011"))!;
    expect(after.status).toBe("open");
  });

  test("a second keyword message is answered again only once per conversation; an unrelated message does not start the bot", async () => {
    const { page, user } = ctx;
    await deliverInbound(page.request, fx, "919800000012", "good morning", "Other Customer");
    await tick(page.request, 3);
    const conv = (await conversationFor(user.tenantId, "919800000012"))!;
    expect(conv).toBeTruthy();
    const n = (await (await db()).query(`select count(*)::int c from "ChatbotSession" where "conversationId"=$1`, [conv.id])).rows[0].c;
    expect(n).toBe(0);
    expect(await outboundBodies(user.tenantId, conv.id)).toEqual([]);
  });

  test("an unpublished bot stops answering", async () => {
    const { page, user } = ctx;
    await page.goto("/app/automation/chatbots");
    await page.getByRole("button", { name: "Unpublish Business hours reply" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Unpublish chatbot" }).click();
    await expect(page.getByText('"Business hours reply" is unpublished.')).toBeVisible();
    await deliverInbound(page.request, fx, "919800000013", "what are your opening hours", "Late Customer");
    await tick(page.request, 3);
    const conv = (await conversationFor(user.tenantId, "919800000013"))!;
    expect(await outboundBodies(user.tenantId, conv.id)).toEqual([]);
  });

  test("STOP is honoured: the contact is opted out and no bot or auto-reply answers", async () => {
    const { page, user } = ctx;
    await page.goto("/app/automation/chatbots");
    await page.getByRole("button", { name: "Publish Business hours reply" }).click();
    await expect(page.getByText('"Business hours reply" is live.')).toBeVisible();
    // The whole message must be a STOP word (owner default 1): "STOP hours" would be an ordinary message now.
    await deliverInbound(page.request, fx, "919800000014", "STOP", "Stop Customer");
    await tick(page.request, 3);
    const conv = (await conversationFor(user.tenantId, "919800000014"))!;
    expect(conv.optedOutAt).not.toBeNull();
    // The only thing sent back is the workspace's standard opt-out confirmation: no bot answer and no auto-reply.
    const bodies = await outboundBodies(user.tenantId, conv.id);
    expect(bodies).toEqual(["You will not get marketing messages from us any more. Order updates and replies to your own messages can still arrive. Send START to get offers again."]);
    expect(bodies.join(" ")).not.toMatch(/Our hours are|Hello and welcome|anything else we can help/i);
    const sessions = (await (await db()).query(`select count(*)::int c from "ChatbotSession" where "conversationId"=$1`, [conv.id])).rows[0].c;
    expect(sessions, "no chatbot session starts for an opted-out contact").toBe(0);
  });

  test("no console errors or failed requests", async () => {
    expect(errors, errors.join("\n")).toEqual([]);
  });
});

test.describe.serial("auto-reply rules answer real inbound messages", () => {
  let ctx: Awaited<ReturnType<typeof newOwner>>;
  let fx: Fx;

  test.beforeAll(async ({ browser }) => {
    ctx = await newOwner(browser, "rulesrun");
    fx = await connectFakeNumber(ctx.user.tenantId);
    // created through the app so this also checks that what the form saves is what the engine reads
    const { page } = ctx;
    await enterApp(page);
    // Rules run in the order of the list and new ones go to the end. The keyword rule is made first and told to stop the
    // rules below it, so a first message that mentions the keyword gets the keyword answer instead of the welcome as well.
    await page.goto("/app/automation/rules/new?starter=keyword");
    await expect(page.getByRole("heading", { level: 1, name: "New rule" })).toBeVisible();
    await page.getByLabel(/^Rule name/).fill("Pricing");
    await page.getByRole("button", { name: "Remove the word cost" }).click();
    await page.getByLabel(/^Message\*?$/).fill("Prices start at 10 dollars.");
    await page.getByText("More options").click();
    await page.getByLabel(/Stop here/).check();
    await page.getByRole("button", { name: "Create rule" }).click();
    await expect(page.getByText('"Pricing" was created.')).toBeVisible();
    await page.goto("/app/automation/rules/new?starter=welcome");
    await expect(page.getByRole("heading", { level: 1, name: "New rule" })).toBeVisible();
    await page.getByLabel(/^Rule name/).fill("Greeting");
    await page.getByLabel(/^Message\*?$/).fill("Hello and welcome!");
    await page.getByRole("button", { name: "Create rule" }).click();
    await expect(page.getByText('"Greeting" was created.')).toBeVisible();
  });
  test.afterAll(async () => {
    await ctx.context.close();
  });

  test("a first message gets the welcome; a second message right after gets no second automatic reply", async () => {
    const { page, user } = ctx;
    await deliverInbound(page.request, fx, "919800000021", "hi there", "Rule Customer");
    await settle(page.request, async () => {
      const c = await conversationFor(user.tenantId, "919800000021");
      return Boolean(c) && (await outboundBodies(user.tenantId, c!.id)).length >= 1;
    }, "welcome stored");
    const c = (await conversationFor(user.tenantId, "919800000021"))!;
    expect(await outboundBodies(user.tenantId, c.id)).toEqual(["Hello and welcome!"]);
    await deliverInbound(page.request, fx, "919800000021", "ok thanks", "Rule Customer");
    await tick(page.request, 3);
    expect(await outboundBodies(user.tenantId, c.id), "the welcome is not repeated").toEqual(["Hello and welcome!"]);
  });

  test("a keyword reply is chosen before the welcome when the first message contains the keyword", async () => {
    const { page, user } = ctx;
    await deliverInbound(page.request, fx, "919800000023", "What is the PRICE?", "Rule Customer 3");
    await settle(page.request, async () => {
      const c = await conversationFor(user.tenantId, "919800000023");
      return Boolean(c) && (await outboundBodies(user.tenantId, c!.id)).length >= 1;
    }, "reply stored");
    const c = (await conversationFor(user.tenantId, "919800000023"))!;
    expect(await outboundBodies(user.tenantId, c.id)).toEqual(["Prices start at 10 dollars."]);
  });

  test("a switched-off rule does not answer", async () => {
    const { page, user } = ctx;
    await page.goto("/app/automation");
    await page.getByRole("switch", { name: "Pricing" }).click();
    await expect(page.getByText(/"Pricing" is off/)).toBeVisible();
    await deliverInbound(page.request, fx, "919800000022", "price?", "Rule Customer 2");
    await settle(page.request, async () => {
      const c = await conversationFor(user.tenantId, "919800000022");
      return Boolean(c) && (await outboundBodies(user.tenantId, c!.id)).length >= 1;
    }, "welcome stored");
    const c = (await conversationFor(user.tenantId, "919800000022"))!;
    expect(await outboundBodies(user.tenantId, c.id)).toEqual(["Hello and welcome!"]);
  });
});
