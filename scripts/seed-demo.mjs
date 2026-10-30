// Creates (or refreshes) a clearly labelled DEMO workspace with sample data in the database DATABASE_URL points to.
//   node scripts/seed-demo.mjs --base http://localhost:3500 [--email demo@edwyz-demo.example] [--out ./demo-credentials.txt] [--force]
// - The demo owner is created through the real POST /api/auth/signup (same hashing, session and trial setup as any signup),
//   then marked email-verified with SQL. The password is generated only when the user is created, written to --out (mode 600)
//   and never printed.
// - Everything else is inserted with SQL for that one tenant only. Rows have deterministic ids and use ON CONFLICT DO NOTHING,
//   so running it again adds nothing twice. Nothing in other tenants is read or written.
// - The workspace shows sample data only. It has no WhatsApp access token, so nothing in it can send real messages.
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pg from "pg";

if (existsSync(".env")) process.loadEnvFile(".env");

// ---------- arguments ----------
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
if (flag("help") || flag("h")) {
  console.log("Usage: node scripts/seed-demo.mjs --base <url> [--email <email>] [--out <file>] [--force]");
  process.exit(0);
}
const baseArg = opt("base");
if (!baseArg) {
  console.error("Missing --base <url>, for example --base http://localhost:3500");
  process.exit(1);
}
const base = baseArg.replace(/\/$/, "");
const origin = new URL(base).origin;
const email = opt("email", "demo@edwyz-demo.example").trim().toLowerCase();
const outFile = resolve(opt("out", "./demo-credentials.txt"));
const force = flag("force");
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (put it in .env or the environment).");
  process.exit(1);
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const q = (text, params = []) => db.query(text, params);
const WORKSPACE_NAME = "Demo Workspace (sample data)";

function generatePassword() {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789"];
  const all = sets.join("");
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < 20) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

try {
  // ---------- 1. the demo owner ----------
  let user = (await q(`SELECT id, name FROM "User" WHERE email = $1`, [email])).rows[0];
  let created = false;
  if (!user) {
    const password = generatePassword();
    mkdirSync(dirname(outFile), { recursive: true });
    // Written before signing up so the password can never be lost if the script stops halfway.
    writeFileSync(
      outFile,
      [
        "Edwyz WA demo workspace (sample data only, cannot send real WhatsApp messages)",
        `Email:      ${email}`,
        `Password:   ${password}`,
        `Login URL:  ${base}/login`,
        `Created:    ${new Date().toISOString()}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const res = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ name: "Demo Owner", email, password, workspaceName: WORKSPACE_NAME }),
    });
    if (res.status !== 201 && res.status !== 200) {
      unlinkSync(outFile);
      console.error(`Signup failed with HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      process.exitCode = 1;
      throw new Error("signup_failed");
    }
    created = true;
    user = (await q(`SELECT id, name FROM "User" WHERE email = $1`, [email])).rows[0];
  }
  await q(`UPDATE "User" SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", now()) WHERE id = $1`, [user.id]);

  // ---------- 2. the tenant, with safety checks ----------
  const membership = (
    await q(
      `SELECT m."tenantId", t.name FROM "Membership" m JOIN "Tenant" t ON t.id = m."tenantId"
       WHERE m."userId" = $1 AND m.role = 'owner' ORDER BY m."createdAt" ASC LIMIT 1`,
      [user.id],
    )
  ).rows[0];
  if (!membership) throw new Error(`User ${email} does not own a workspace.`);
  const tid = membership.tenantId;
  if (!force && !/^demo\b/i.test(membership.name)) {
    throw new Error(`Workspace "${membership.name}" is not named "Demo ..."; refusing to add sample data to what may be a real workspace. Use --force to override.`);
  }
  const convCount = Number((await q(`SELECT count(*) AS c FROM "Conversation" WHERE "tenantId" = $1`, [tid])).rows[0].c);
  if (convCount > 50 && !force) {
    throw new Error(`The workspace already has ${convCount} conversations; refusing to seed. Use --force to override.`);
  }

  // ---------- helpers ----------
  class J {
    constructor(v) {
      this.v = v;
    }
  }
  const id = (tag) => `dm_${tid}_${tag}`;
  const now = Date.now();
  const ago = (ms) => new Date(now - ms);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const ymd = (d) => d.toISOString().slice(0, 10);

  async function put(table, row) {
    const keys = Object.keys(row);
    const values = keys.map((k) => (row[k] instanceof J ? JSON.stringify(row[k].v) : row[k]));
    const slots = keys.map((k, i) => (row[k] instanceof J ? `$${i + 1}::jsonb` : `$${i + 1}`));
    const sql = `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${slots.join(", ")}) ON CONFLICT DO NOTHING`;
    const r = await q(sql, values);
    return r.rowCount ?? 0;
  }

  await q("BEGIN");

  // The demo workspace behaves like a connected workspace in the UI (a fake number, no token).
  await q(`UPDATE "Tenant" SET "onboardingStatus" = 'live' WHERE id = $1`, [tid]);

  // ---------- 3. WhatsApp number ----------
  await put("Waba", { id: id("waba"), tenantId: tid, wabaId: `demo-waba-${tid}`, name: "Demo Business Account", businessId: null });
  await put("PhoneNumber", {
    id: id("phone"),
    tenantId: tid,
    wabaRefId: id("waba"),
    phoneNumberId: `demo-phone-${tid}`,
    displayPhone: "+91 90000 00000",
    verifiedName: "Demo Boutique (sample)",
    qualityRating: "GREEN",
    messagingLimitTier: "TIER_1K",
    nameStatus: "APPROVED",
    status: "connected",
    registeredAt: ago(30 * DAY),
  });
  const phoneId = id("phone");

  // ---------- 4. contacts ----------
  const people = [
    ["Aarav Sharma", ["vip", "lead"], "in"],
    ["Priya Nair", ["lead"], "in"],
    ["Rohan Mehta", ["customer"], "in"],
    ["Ananya Iyer", ["lead"], "in"],
    ["Vikram Singh", ["vip", "customer"], "in"],
    ["Kavya Reddy", ["customer"], "in"],
    ["Arjun Patel", ["lead"], "in"],
    ["Sneha Gupta", ["vip"], "in"],
    ["Rahul Verma", ["customer"], "in"],
    ["Meera Joshi", ["lead"], "in"],
    ["Karthik Subramanian", [], "none"],
    ["Divya Kulkarni", ["customer"], "out"],
  ];
  const contact = (i) => id(`c${i + 1}`);
  for (const [i, [name, tags, optState]] of people.entries()) {
    const optIn = optState !== "none";
    await put("Contact", {
      id: contact(i),
      tenantId: tid,
      phone: `+9190000000${String(i + 1).padStart(2, "0")}`,
      name,
      // Looks like real CRM data; the workspace name already says it is a demo.
      attributes: new J({ city: ["Mumbai", "Bengaluru", "Delhi", "Chennai", "Pune", "Hyderabad"][i % 6], "last order": `#10${40 + i}` }),
      tags,
      optIn: optState === "in",
      optInSource: optIn ? "demo_seed" : null,
      optInAt: optIn ? ago((40 - i) * DAY) : null,
      optedOutAt: optState === "out" ? ago(3 * DAY) : null,
      createdAt: ago((40 - i) * DAY),
    });
  }

  // ---------- 5. conversations and messages ----------
  const owner = user.id;
  const convs = [
    // [tag, contact index, status, assigned, lastInbound ago, tags, unread, script]
    {
      tag: "v1", c: 0, status: "open", assigned: owner, tags: ["vip"], unread: 0,
      script: [
        ["in", "Hi, do you have the silk kurta in medium?", 5 * HOUR + 10 * MIN],
        ["out", "Hello Aarav! Yes, the silk kurta is available in medium. Would you like a link to order?", 5 * HOUR],
        ["in", "Yes please, and what is the delivery time to Mumbai?", 2 * HOUR + 5 * MIN],
        ["out", "Delivery to Mumbai takes 2 to 3 days. Here is the link: https://demo.example/shop/silk-kurta", 2 * HOUR],
        ["in", "Thanks, ordering now.", 40 * MIN],
      ],
    },
    {
      tag: "v2", c: 1, status: "open", assigned: null, tags: ["lead"], unread: 2,
      script: [
        ["in", "Hello, I saw your ad. Can you share the price list?", 35 * MIN],
        ["in", "Also do you ship to Kochi?", 30 * MIN],
      ],
    },
    {
      tag: "v3", c: 2, status: "solved", assigned: owner, tags: ["customer"], unread: 0,
      script: [
        ["in", "My order has not arrived yet.", 3 * DAY + 2 * HOUR],
        ["out", "Sorry about that Rohan. Let me check the tracking for you.", 3 * DAY + 90 * MIN],
        ["out", "It was held at the hub and is out for delivery today.", 3 * DAY + HOUR],
        ["in", "Received it, thank you!", 3 * DAY],
        ["out", "Glad to hear it. Marking this chat as solved.", 3 * DAY - 10 * MIN],
      ],
    },
    {
      tag: "v4", c: 3, status: "open", assigned: owner, tags: ["lead"], unread: 1,
      // Last message is from the customer more than 24 hours ago, so the window has expired.
      script: [
        ["out", "Hi Ananya, thanks for your enquiry. Would you like a callback?", 2 * DAY + 3 * HOUR],
        ["in", "Yes, call me tomorrow afternoon please.", 40 * HOUR],
      ],
    },
    {
      tag: "v5", c: 4, status: "pending", assigned: owner, tags: ["vip"], unread: 0,
      script: [
        ["in", "Can I change the delivery address for my last order?", 6 * HOUR],
        ["out", "Sure Vikram, please send the new address and pincode.", 5 * HOUR + 30 * MIN],
        ["in", "Flat 12, Green Park, Delhi 110016", 5 * HOUR],
        ["out", "Thanks. We are checking with the warehouse and will confirm shortly.", 4 * HOUR + 45 * MIN],
      ],
    },
  ];
  let msgN = 0;
  for (const cv of convs) {
    const times = cv.script.map((s) => s[2]);
    const lastAny = Math.min(...times);
    const inboundTimes = cv.script.filter((s) => s[0] === "in").map((s) => s[2]);
    const lastIn = inboundTimes.length ? Math.min(...inboundTimes) : null;
    const cid = id(`conv_${cv.tag}`);
    await put("Conversation", {
      id: cid,
      tenantId: tid,
      phoneNumberId: phoneId,
      contactId: contact(cv.c),
      assignedToId: cv.assigned,
      status: cv.status,
      tags: cv.tags,
      unreadCount: cv.unread,
      lastMessageAt: ago(lastAny),
      lastInboundAt: lastIn === null ? null : ago(lastIn),
      referral: cv.tag === "v2" ? new J({ sourceType: "ad", sourceId: "demo_ad_001", sourceUrl: "https://demo.example/ad", headline: "Demo festive collection", ctwaClid: "demo-click-id" }) : null,
      assignedAt: cv.assigned ? ago(lastAny + HOUR) : null,
      statusChangedAt: cv.status === "solved" ? ago(lastAny) : null,
      createdAt: ago(Math.max(...times) + 5 * MIN),
    });
    for (const [dir, body, t] of cv.script) {
      msgN++;
      const at = ago(t);
      const inbound = dir === "in";
      await put("Message", {
        id: id(`msg${msgN}`),
        tenantId: tid,
        conversationId: cid,
        wamid: `wamid.DEMO_${tid}_${msgN}`,
        direction: inbound ? "inbound" : "outbound",
        type: "text",
        body,
        status: inbound ? "received" : t > DAY ? "read" : "delivered",
        statusTimeline: new J(inbound ? [] : [{ status: "sent", at: at.toISOString() }, { status: "delivered", at: new Date(at.getTime() + 4000).toISOString() }]),
        sentByUserId: inbound ? null : owner,
        createdAt: at,
      });
    }
  }
  await put("Note", { id: id("note1"), tenantId: tid, conversationId: id("conv_v5"), authorId: owner, body: "Demo note: address change approved by the warehouse lead.", createdAt: ago(4 * HOUR) });
  await put("QuickReply", { id: id("qr1"), tenantId: tid, shortcut: "/hours", body: "We are open Monday to Saturday, 9 am to 6 pm. (Demo quick reply)" });

  // ---------- 6. templates ----------
  const tpl = (tag, name, category, status, components, extra = {}) =>
    put("Template", {
      id: id(tag), tenantId: tid, wabaRefId: id("waba"), name, language: "en", category, status,
      components: new J(components), metaTemplateId: status === "draft" ? null : `demo-meta-${tag}`,
      rejectionReason: null, createdAt: ago(20 * DAY), updatedAt: ago(15 * DAY), ...extra,
    });
  await tpl("tpl_utility", "demo_order_update", "UTILITY", "approved", [
    { type: "BODY", text: "Hi {{1}}, your order {{2}} is on its way. Track it here: https://demo.example/track", example: { body_text: [["Aarav", "#1042"]] } },
    { type: "FOOTER", text: "Demo template" },
  ]);
  await tpl("tpl_marketing", "demo_festive_offer", "MARKETING", "approved", [
    { type: "BODY", text: "Hello {{1}}, our festive sale is live with up to 30% off. Tap below to browse.", example: { body_text: [["Priya"]] } },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Shop now", url: "https://demo.example/sale" }, { type: "QUICK_REPLY", text: "Stop promotions" }] },
  ]);
  await tpl("tpl_pending", "demo_appointment_reminder", "UTILITY", "pending", [
    { type: "BODY", text: "Hi {{1}}, a reminder of your appointment on {{2}}.", example: { body_text: [["Rohan", "Friday 4 pm"]] } },
  ], { createdAt: ago(2 * HOUR), updatedAt: ago(2 * HOUR) });
  await tpl("tpl_rejected", "demo_flash_deal", "MARKETING", "rejected", [
    { type: "BODY", text: "{{1}} FLASH DEAL!!! Buy now or miss out forever. Limited stock." , example: { body_text: [["Arjun"]] } },
  ], { rejectionReason: "SCAM" }); // Meta's real rejected_reason codes; the app turns this into "Meta thinks the wording looks like a scam..."

  // ---------- 7. broadcasts ----------
  await put("Broadcast", {
    id: id("bc_done"), tenantId: tid, phoneNumberId: phoneId, templateId: id("tpl_marketing"), name: "Demo festive offer blast",
    status: "completed", segmentTags: [], scheduledAt: null, startedAt: ago(6 * DAY), completedAt: ago(6 * DAY - 12 * MIN),
    estimatedCostPaise: 8 * 78, retryDays: 0, createdByUserId: owner, createdAt: ago(6 * DAY + HOUR),
  });
  const recStates = ["read", "read", "read", "delivered", "delivered", "delivered", "sent", "failed"];
  for (const [i, st] of recStates.entries()) {
    const sentAt = ago(6 * DAY - i * 20_000);
    await put("BroadcastRecipient", {
      id: id(`br${i + 1}`), tenantId: tid, broadcastId: id("bc_done"), contactId: contact(i), status: st,
      wamid: st === "failed" ? null : `wamid.DEMO_${tid}_br${i + 1}`,
      errorCode: st === "failed" ? "131049" : null,
      sentAt: st === "failed" ? null : sentAt,
      deliveredAt: st === "delivered" || st === "read" ? new Date(sentAt.getTime() + 5000) : null,
      readAt: st === "read" ? new Date(sentAt.getTime() + 600_000) : null,
      attempts: 1,
    });
  }
  await put("Broadcast", {
    id: id("bc_draft"), tenantId: tid, phoneNumberId: phoneId, templateId: id("tpl_marketing"), name: "Demo weekend reminder (draft)",
    status: "draft", segmentTags: ["lead"], estimatedCostPaise: null, retryDays: 0, createdByUserId: owner, createdAt: ago(HOUR),
  });

  // ---------- 8. automations ----------
  const rule = (tag, type, name, replyText, extra = {}) =>
    put("AutomationRule", {
      id: id(tag), tenantId: tid, phoneNumberId: null, type, name, enabled: true, keywords: [], matchMode: "contains",
      replyText, schedule: null, cooldownMinutes: 720, createdAt: ago(25 * DAY), updatedAt: ago(25 * DAY), ...extra,
    });
  await rule("auto_welcome", "welcome", "Demo welcome message", "Hi, welcome to Demo Boutique! How can we help you today? (demo automation)");
  await rule("auto_away", "away", "Demo away message", "Thanks for writing. We are closed right now and will reply when we open at 9 am. (demo automation)", {
    schedule: new J({ timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "18:00" }),
  });
  await rule("auto_keyword", "keyword", "Demo price keyword", "Our price list is at https://demo.example/prices (demo automation)", { keywords: ["price", "rates", "cost"] });

  // ---------- 9. chatbot: the "Collect lead details" starter ----------
  const X = (i) => 40 + i * 320;
  const node = (n, type, data) => ({ id: `n${n}`, type, position: { x: X(n - 1), y: 40 }, data });
  const flow = {
    version: 1,
    start: "n1",
    nodes: [
      node(1, "send_text", { text: "Thanks for getting in touch. We just need a few details so we can help you properly." }),
      node(2, "ask", { text: "What is your name?", variable: "name", validate: "text", retryText: "", maxRetries: 2 }),
      node(3, "ask", { text: "Thanks {{name}}. What is your email address?", variable: "email", validate: "email", retryText: "That does not look like an email address. Please check it and send it again.", maxRetries: 2 }),
      node(4, "ask", { text: "And what do you need help with?", variable: "need", validate: "text", retryText: "", maxRetries: 2 }),
      node(5, "add_tag", { tag: "New lead" }),
      node(6, "send_text", { text: "Thank you, {{name}}. We have your details and will get back to you soon." }),
      node(7, "handoff", {}),
    ],
    edges: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `e${n}`, from: `n${n}`, to: `n${n + 1}` })),
  };
  await put("Chatbot", {
    id: id("bot1"), tenantId: tid, phoneNumberId: null, name: "Demo - Collect lead details", status: "published", triggerType: "keyword",
    triggerKeywords: ["quote", "enquiry", "interested"], flow: new J(flow), publishedFlow: new J(flow), version: 1,
    createdByUserId: owner, createdAt: ago(18 * DAY), updatedAt: ago(18 * DAY),
  });

  // ---------- 10. AI agent (disabled) with two knowledge sources ----------
  await put("AiAgent", {
    id: id("agent1"), tenantId: tid, name: "Demo support assistant", enabled: false, phoneNumberId: null,
    instructions: "You are the sample assistant for Demo Boutique. Answer questions about shipping and returns using only the knowledge sources. If unsure, hand over to a person.",
    tone: "friendly", language: "auto", activation: "outside_hours", handoffKeywords: ["human", "agent", "complaint"],
    maxRepliesPerConversation: 6, model: null, createdAt: ago(10 * DAY), updatedAt: ago(10 * DAY),
  });
  await put("AiKnowledgeSource", {
    id: id("ks1"), tenantId: tid, agentId: id("agent1"), kind: "faq", title: "Demo shipping FAQ", sourceUrl: null, status: "ready",
    content: "Q: How long does delivery take?\nA: 2 to 3 days in metros and 4 to 6 days elsewhere.\nQ: Do you ship across India?\nA: Yes, we ship to every pincode we can reach by courier.",
    createdAt: ago(10 * DAY),
  });
  await put("AiKnowledgeSource", {
    id: id("ks2"), tenantId: tid, agentId: id("agent1"), kind: "text", title: "Demo returns policy", sourceUrl: null, status: "ready",
    content: "Items can be returned within 7 days of delivery if unused and in original packaging. Refunds go back to the original payment method within 5 to 7 working days. (Sample text for the demo workspace.)",
    createdAt: ago(10 * DAY),
  });

  // ---------- 11. Meta connection (fake, no usable token) for the ads, leads and posts screens ----------
  // Looks healthy on the Connections page: every permission the app asks for (src/lib/meta-connect/scopes.ts), a numeric-looking
  // Meta user id instead of a raw tag, a token that is not expired, a recent health check and lead alerts on for the Page.
  const DEMO_META_SCOPES = [
    "public_profile", "email",
    "business_management", "ads_management", "ads_read", "pages_show_list", "pages_read_engagement", "pages_manage_ads",
    "pages_manage_metadata", "leads_retrieval", "pages_manage_posts", "instagram_basic", "instagram_content_publish",
  ];
  const demoMetaUserId = `1000${String([...tid].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1_000_000_007, 7)).padStart(11, "0")}`;
  await put("MetaConnection", {
    id: id("mconn"), tenantId: tid, metaUserId: demoMetaUserId, businessId: null,
    scopes: DEMO_META_SCOPES,
    tokenEnc: "demo-placeholder-not-a-real-token", tokenExpiresAt: ago(-55 * DAY), status: "active", connectedByUserId: owner,
    lastCheckedAt: ago(HOUR), createdAt: ago(12 * DAY), updatedAt: ago(12 * DAY),
  });
  await put("MetaAsset", {
    id: id("masset_ad"), tenantId: tid, connectionId: id("mconn"), type: "ad_account", externalId: "act_demo0000001", name: "Demo Ad Account",
    tokenEnc: null, status: "active", meta: new J({ currency: "INR", demo: true }), createdAt: ago(12 * DAY), updatedAt: ago(12 * DAY),
  });
  await put("MetaAsset", {
    id: id("masset_page"), tenantId: tid, connectionId: id("mconn"), type: "page", externalId: "demo_page_0001", name: "Demo Boutique Page",
    tokenEnc: null, status: "active",
    meta: new J({ demo: true, leadgenSubscription: { status: "subscribed", at: ago(12 * DAY).toISOString(), verifiedAt: ago(HOUR).toISOString() } }),
    createdAt: ago(12 * DAY), updatedAt: ago(12 * DAY),
  });

  // ---------- 12. Brand kit and creative brief ----------
  await put("Brand", {
    id: id("brand1"), tenantId: tid, name: "Demo Boutique", websiteUrl: "https://demo.example", logoUrl: null,
    colors: ["#0B6E4F", "#F4A259", "#1B1B1B"], fonts: ["Inter", "Playfair Display"], tone: "Warm, helpful and a little playful",
    bannedWords: ["cheap", "guaranteed"], industry: "Fashion retail", specialAdCategory: "none", createdAt: ago(14 * DAY), updatedAt: ago(14 * DAY),
  });
  await put("CreativeBrief", {
    id: id("brief1"), tenantId: tid, brandId: id("brand1"), goal: "leads", offer: "Demo festive collection: up to 30% off this week",
    status: "angles_ready", researchSummary: new J({ summary: "Sample research for the demo workspace.", audience: "Women 22-40 in metro cities" }),
    createdByUserId: owner, createdAt: ago(5 * DAY), updatedAt: ago(5 * DAY),
  });
  const angles = [
    ["Festive look in minutes", "Women 22-35, metros", "Chat with us on WhatsApp", "Speed and convenience resonate with busy shoppers.", true],
    ["Gift something they will love", "Gift buyers 28-45", "Get gift ideas", "Gifting intent peaks before festivals.", false],
    ["Up to 30% off, this week only", "Deal seekers 22-40", "See the offers", "Clear time-bound value.", false],
  ];
  for (const [i, [hook, audience, cta, rationale, selected]] of angles.entries()) {
    await put("CreativeAngle", { id: id(`angle${i + 1}`), tenantId: tid, briefId: id("brief1"), hook, audience, cta, rationale, selected });
  }
  const assets = [
    ["a1", "angle1", "image", "feed", "Festive look in minutes", "Placeholder image (no real file).", "ready"],
    ["a2", "angle1", "image", "story", "Festive look in minutes", "Placeholder story image (no real file).", "pending"],
    ["a3", "angle1", "copy", "none", "Chat with us on WhatsApp", "Sample primary text: find your festive outfit in minutes. Message us and we will help you pick.", "ready"],
  ];
  for (const [tag, angle, kind, placement, headline, body, status] of assets) {
    await put("CreativeAsset", {
      id: id(tag), tenantId: tid, briefId: id("brief1"), angleId: id(angle), kind, placement, headline, body, storageKey: null,
      provider: "demo", aiGenerated: false, creditCost: 0, status, policyCheck: status === "ready" ? new J({ result: "pass", findings: [] }) : null,
      createdAt: ago(4 * DAY),
    });
  }

  // ---------- 13. leads: form, two leads, one sequence ----------
  await put("LeadForm", {
    id: id("form1"), tenantId: tid, pageAssetId: id("masset_page"), metaFormId: `demo-form-${tid}`, name: "Demo festive enquiry form",
    consentText: "I agree to be contacted on WhatsApp about the Demo festive collection.", status: "active", createdAt: ago(9 * DAY),
  });
  await put("Lead", {
    id: id("lead1"), tenantId: tid, leadFormId: id("form1"), leadgenId: `demo-leadgen-1-${tid}`, contactId: contact(6),
    fields: new J({ full_name: "Arjun Patel", phone_number: "+919000000007", email: "arjun.demo@example.com" }),
    campaignMetaId: "demo_campaign_001", adMetaId: "demo_ad_001", consentText: "I agree to be contacted on WhatsApp.", consentAt: ago(2 * DAY),
    status: "new", assignedToId: null, firstResponseAt: null, createdAt: ago(2 * DAY),
  });
  await put("Lead", {
    id: id("lead2"), tenantId: tid, leadFormId: id("form1"), leadgenId: `demo-leadgen-2-${tid}`, contactId: contact(9),
    fields: new J({ full_name: "Meera Joshi", phone_number: "+919000000010", email: "meera.demo@example.com" }),
    campaignMetaId: "demo_campaign_001", adMetaId: "demo_ad_001", consentText: "I agree to be contacted on WhatsApp.", consentAt: ago(3 * DAY),
    status: "contacted", assignedToId: owner, firstResponseAt: ago(3 * DAY - 6 * MIN), createdAt: ago(3 * DAY),
  });
  await put("LeadSequence", {
    id: id("seq1"), tenantId: tid, name: "Demo lead follow-up", enabled: true,
    steps: new J([{ delayMinutes: 5, templateId: id("tpl_utility"), stopOnReply: true }, { delayMinutes: 1440, templateId: id("tpl_marketing"), stopOnReply: true }]),
    appliesTo: new J({ leadFormId: id("form1") }), createdAt: ago(8 * DAY),
  });

  // ---------- 14. scheduled post ----------
  await put("ScheduledPost", {
    id: id("post1"), tenantId: tid, body: "Demo post: our festive collection is here. Message us on WhatsApp to get styling help. #DemoBoutique",
    mediaKeys: [], scheduledAt: new Date(now + 2 * DAY), status: "scheduled", createdByUserId: owner, createdAt: ago(DAY),
  });
  await put("PostTarget", { id: id("pt1"), tenantId: tid, postId: id("post1"), assetId: id("masset_page"), channel: "facebook", status: "pending" });

  // ---------- 15. ads: insights for 14 days, a draft campaign, two Optimiser proposals ----------
  await put("AdCampaign", {
    id: id("camp_live"), tenantId: tid, adAccountAssetId: id("masset_ad"), metaCampaignId: "demo_campaign_001", name: "Demo Festive Leads",
    template: "lead_generation", objective: "OUTCOME_LEADS", status: "paused", dailyBudgetMinor: 50000, currency: "INR",
    specialAdCategory: "none", createdByUserId: owner, createdAt: ago(16 * DAY), updatedAt: ago(DAY),
  });
  await put("AdCampaign", {
    id: id("camp_draft"), tenantId: tid, adAccountAssetId: id("masset_ad"), metaCampaignId: null, name: "Demo Click to WhatsApp (draft)",
    template: "click_to_whatsapp", objective: "OUTCOME_ENGAGEMENT", status: "draft", dailyBudgetMinor: 30000, currency: "INR",
    specialAdCategory: "none", createdByUserId: owner, createdAt: ago(DAY), updatedAt: ago(DAY),
  });
  for (let d = 14; d >= 1; d--) {
    const wave = 1 + 0.25 * Math.sin(d / 2);
    const impressions = Math.round(9000 * wave + d * 40);
    const clicks = Math.round(impressions * (0.021 + 0.002 * Math.cos(d)));
    await put("InsightSnapshot", {
      id: id(`ins${d}`), tenantId: tid, entityType: "campaign", entityMetaId: "demo_campaign_001", date: ymd(ago(d * DAY)),
      spendMinor: Math.round(42000 * wave), impressions, clicks, results: Math.round(clicks * 0.09), frequency: Math.round((1.2 + (14 - d) * 0.05) * 100) / 100,
      qualityRanking: d > 5 ? "AVERAGE" : "ABOVE_AVERAGE", raw: new J({ demo: true }),
    });
  }
  // Plain-language rationale with formatted money (docs/SPEND-CONTROLS-SPEC.md 8.4): 3100 paise reads "₹31", never a raw figure.
  const OPT1_RATIONALE = "Spent ₹31 in 7 days with no results.";
  await put("OptimizerProposal", {
    id: id("opt1"), tenantId: tid, kind: "pause_ad", targetType: "ad", targetMetaId: "demo_ad_002",
    rationale: OPT1_RATIONALE,
    payload: new J({ spendMinor: 3100, results: 0, windowDays: 7, adName: "Demo ad - carousel B", reason: "zero_results" }), status: "proposed", createdAt: ago(6 * HOUR),
  });
  await put("OptimizerProposal", {
    id: id("opt2"), tenantId: tid, kind: "rotate_creative", targetType: "ad", targetMetaId: "demo_ad_001",
    rationale: "Frequency is rising and click-through rate has fallen. Try a fresh creative.",
    payload: new J({ adName: "Demo ad - video A", frequency: 2.4, ctrBefore: 2.3, ctrAfter: 1.6, ctrDropPct: 30, advisory: true }), status: "proposed", createdAt: ago(5 * HOUR),
  });

  // An earlier seed wrote a raw paise figure in this rationale; the copy check refuses that wording, so it is rewritten in place.
  await q(`UPDATE "OptimizerProposal" SET rationale = $1 WHERE id = $2 AND rationale LIKE '%minor%units%'`, [OPT1_RATIONALE, id("opt1")]);

  // ---------- 15b. spending limits (sample data, docs/SPEND-CONTROLS-SPEC.md 8.4) ----------
  // The demo workspace can never spend (every raise is refused with "This is a demo workspace, so nothing can be spent."), so
  // these figures only fill the Settings > Spending limits page, which labels them "Sample data". Ledger rows are marked sandbox.
  await put("SpendControl", { tenantId: tid, spendingAdAccountAssetId: id("masset_ad"), timezone: "Asia/Kolkata", updatedAt: new Date(now) });
  await put("SpendAllowance", { id: id("allow_ads"), tenantId: tid, pot: "ads", currency: "INR", dailyLimitMinor: 200000, monthlyLimitMinor: 2000000, updatedByUserId: owner, createdAt: ago(6 * DAY), updatedAt: ago(6 * DAY) });
  await put("SpendAllowance", { id: id("allow_wa"), tenantId: tid, pot: "messaging", currency: "INR", dailyLimitMinor: null, monthlyLimitMinor: 500000, updatedByUserId: owner, createdAt: ago(6 * DAY), updatedAt: ago(6 * DAY) });
  const ledger = [
    ["led1", "ads", "allowance.change", "requested", "user", owner, null, "Set the ads limits to ₹2,000 a day and ₹20,000 a month.", "c1", 6 * DAY],
    ["led2", "ads", "allowance.change", "applied", "user", owner, null, "Set the ads limits to ₹2,000 a day and ₹20,000 a month.", "c1", 6 * DAY - MIN],
    ["led3", "messaging", "allowance.change", "requested", "user", owner, null, "Set the WhatsApp limit to ₹5,000 a month.", "c2", 6 * DAY - 2 * MIN],
    ["led4", "messaging", "allowance.change", "applied", "user", owner, null, "Set the WhatsApp limit to ₹5,000 a month.", "c2", 6 * DAY - 3 * MIN],
    ["led5", "ads", "ads.ad.pause", "shadow", "assistant", null, "ads_optimizer", OPT1_RATIONALE, "c3", 6 * HOUR],
  ];
  for (const [tag, pot, action, phase, actorType, actorId, assistantKey, reason, corr, age] of ledger) {
    await put("SpendLedger", {
      id: id(tag), tenantId: tid, pot, action, phase, actorType, actorId, assistantKey, reason, correlationId: id(corr), currency: "INR", sandbox: true,
      reasonCodes: ["sample_data"], createdAt: ago(age),
    });
  }

  // ---------- 16. Shopify store (pending) with three abandoned carts ----------
  await put("ShopifyStore", {
    id: id("shop1"), tenantId: tid, shopDomain: "demo-boutique.myshopify.com", tokenEnc: "demo-placeholder-not-a-real-token",
    webhookSecretEnc: null, status: "pending_verification", createdAt: ago(4 * DAY),
  });
  const carts = [
    ["k1", 0, "Silk kurta (M)", 249900, "checkout", 2],
    ["k2", 2, "Cotton dupatta set", 129900, "cart", 5],
    ["k3", 4, "Festive lehenga", 899900, "checkout", 9],
  ];
  for (const [tag, ci, item, total, stage, hours] of carts) {
    await put("AbandonedCart", {
      id: id(tag), tenantId: tid, storeId: id("shop1"), externalId: `demo-cart-${tag}-${tid}`, contactId: contact(ci), phone: `+9190000000${String(ci + 1).padStart(2, "0")}`,
      items: new J([{ title: item, quantity: 1, priceMinor: total }]), totalMinor: total, currency: "INR", checkoutUrl: `https://demo-boutique.myshopify.com/checkout/demo-${tag}`,
      stage, status: "open", remindersSent: 0, nextReminderAt: null, createdAt: ago(hours * HOUR),
    });
  }

  // ---------- 17. daily metrics for the days the reports read from snapshots (older than 3 days) ----------
  for (let d = 4; d <= 14; d++) {
    const day = ymd(ago(d * DAY));
    const out = 28 + ((d * 7) % 17);
    const inn = 34 + ((d * 5) % 19);
    const sent = out - 1;
    const delivered = sent - 2;
    const metrics = { messages_in: inn, messages_out: out, sent, delivered, read: Math.round(delivered * 0.7), failed: 1, conversations_opened: 4 + (d % 5), broadcast_recipients_sent: 0, _done: 1, _final: 1 };
    for (const [key, value] of Object.entries(metrics)) {
      await put("DailyMetric", { id: id(`dm_${d}_${key}`), scope: `tenant:${tid}`, day, key, value });
    }
  }

  await q("COMMIT");

  console.log(created ? "Created the demo workspace and seeded sample data." : "Demo workspace already existed; sample data refreshed (existing rows left as they were).");
  console.log(`Email: ${email}`);
  console.log(created ? `Credentials file: ${outFile}` : "Credentials file: not rewritten (the user already existed, so no new password was generated).");
} catch (e) {
  await q("ROLLBACK").catch(() => undefined);
  if (e?.message !== "signup_failed") console.error(`seed-demo failed: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
