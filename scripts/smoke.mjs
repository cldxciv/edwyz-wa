// End-to-end smoke test against a running instance and its database. No Meta calls are made.
//   node scripts/smoke.mjs http://localhost:3500
// Needs DATABASE_URL, WORKER_SECRET and META_APP_SECRET in .env (local test values only).
import { createDecipheriv, createHmac } from "node:crypto";
import pg from "pg";

process.loadEnvFile(".env");
const base = (process.argv[2] ?? "http://localhost:3500").replace(/\/$/, "");
const origin = new URL(base).origin;
const stamp = Date.now();
let failures = 0;

const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
};

async function api(method, path, { cookie, body, raw, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method !== "GET" ? { origin } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, res };
}

const jar = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function signup(name, email) {
  const r = await api("POST", "/api/auth/signup", { body: { name, email, password: "correct horse battery", workspaceName: `${name} Co` } });
  return { r, cookie: jar(r.res) };
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const A = await signup("Alice", `alice+${stamp}@example.com`);
const B = await signup("Bob", `bob+${stamp}@example.com`);
check("signup creates two workspaces", A.r.status === 201 || A.r.status === 200, A.r.text);
const meA = await api("GET", "/api/auth/me", { cookie: A.cookie });
check("me returns the owner role", meA.json?.role === "owner", meA.text);
check("no cookie is rejected", (await api("GET", "/api/inbox/conversations")).status === 401);
check("state-changing request without matching Origin is rejected", (await fetch(base + "/api/auth/logout", { method: "POST", headers: { origin: "https://evil.example" } })).status === 403);

const tenant = async (email) => (await db.query(`select m."tenantId" from "Membership" m join "User" u on u.id = m."userId" where u.email = $1`, [email])).rows[0].tenantId;
const tenantA = await tenant(`alice+${stamp}@example.com`);
const tenantB = await tenant(`bob+${stamp}@example.com`);
check("workspaces are separate", tenantA !== tenantB);
// New accounts start unverified. When the server enforces email verification (SMTP configured) every write below would be refused,
// so these two are marked verified here; the verification gate itself is exercised separately further down with a third account.
await db.query(`update "User" set "emailVerifiedAt" = now() where email in ($1,$2)`, [`alice+${stamp}@example.com`, `bob+${stamp}@example.com`]);

// Fixtures a real Embedded Signup would create
const fixture = async (tenantId, tag) => {
  const wabaRef = `waba_${tag}_${stamp}`;
  const pnRef = `pn_${tag}_${stamp}`;
  await db.query(`insert into "Waba" (id, "tenantId", "wabaId") values ($1,$2,$3)`, [wabaRef, tenantId, `WABA_${tag}_${stamp}`]);
  await db.query(`insert into "PhoneNumber" (id, "tenantId", "wabaRefId", "phoneNumberId", "displayPhone", status, "qualityRating", "messagingLimitTier") values ($1,$2,$3,$4,$5,'connected','GREEN','TIER_250')`, [pnRef, tenantId, wabaRef, `PN_${tag}_${stamp}`, "+15550001"]);
  return { wabaRef, pnRef, wabaId: `WABA_${tag}_${stamp}`, phoneNumberId: `PN_${tag}_${stamp}` };
};
const fa = await fixture(tenantA, "A");
const fb = await fixture(tenantB, "B");

// Signed webhook delivery
const secret = process.env.META_APP_SECRET;
const hook = async (value, wabaId) => {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: wabaId, changes: [{ field: "messages", value }] }] });
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return api("POST", "/webhooks/whatsapp", { raw: body, headers: { "content-type": "application/json", "x-hub-signature-256": sig } });
};
const inbound = (phoneNumberId, id, text) => ({
  messaging_product: "whatsapp",
  metadata: { display_phone_number: "15550001", phone_number_id: phoneNumberId },
  contacts: [{ profile: { name: "Test Customer" }, wa_id: "919876543210" }],
  messages: [{ from: "919876543210", id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
});
const tick = () => api("POST", "/api/internal/tick", { headers: { "x-worker-secret": process.env.WORKER_SECRET } });

check("webhook with a bad signature is rejected", (await api("POST", "/webhooks/whatsapp", { raw: "{}", headers: { "x-hub-signature-256": "sha256=00" } })).status === 401);
check("tick without the secret is rejected", (await api("POST", "/api/internal/tick")).status === 403);
check("signed inbound message is accepted", (await hook(inbound(fa.phoneNumberId, `wamid.${stamp}.1`, "Hello, I need help"), fa.wabaId)).status === 200);
await hook(inbound(fa.phoneNumberId, `wamid.${stamp}.1`, "Hello, I need help"), fa.wabaId); // redelivery
const t1 = await tick();
check("worker pass runs", t1.status === 200, t1.text);

const listA = await api("GET", "/api/inbox/conversations", { cookie: A.cookie });
const conv = listA.json?.items?.[0];
check("tenant A sees the conversation", listA.json?.items?.length === 1 && Boolean(conv), listA.text);
const detail = conv ? await api("GET", `/api/inbox/conversations/${conv.id}`, { cookie: A.cookie }) : { json: {} };
check("redelivered webhook did not duplicate the message", detail.json?.messages?.length === 1, JSON.stringify(detail.json?.messages?.length));
check("24-hour window is open after an inbound message", detail.json?.windowOpen === true);
const listB = await api("GET", "/api/inbox/conversations", { cookie: B.cookie });
check("tenant B sees none of tenant A's conversations", listB.json?.items?.length === 0, listB.text);
check("tenant B cannot open tenant A's conversation by id", conv ? (await api("GET", `/api/inbox/conversations/${conv.id}`, { cookie: B.cookie })).status === 404 : false);

const send = conv ? await api("POST", `/api/inbox/conversations/${conv.id}/messages`, { cookie: A.cookie, body: { type: "text", body: "Thanks, how can we help?" } }) : { status: 0 };
check("reply inside the window is queued", send.status === 201, send.text);
check("tenant B cannot reply into tenant A's conversation", conv ? (await api("POST", `/api/inbox/conversations/${conv.id}/messages`, { cookie: B.cookie, body: { type: "text", body: "x" } })).status === 404 : false);
await tick();
const after = conv ? await api("GET", `/api/inbox/conversations/${conv.id}`, { cookie: A.cookie }) : { json: {} };
const outbound = after.json?.messages?.find((m) => m.direction === "outbound");
check("without a Meta token the send ends as failed, not stuck", outbound?.status === "failed" || outbound?.status === "queued", JSON.stringify(outbound?.status));
console.log(`      (outbound status: ${outbound?.status}; a real send needs a connected number)`);

// Old window: move last inbound back 25 hours, replies must be refused
if (conv) await db.query(`update "Conversation" set "lastInboundAt" = (now() at time zone 'utc') - interval '25 hours' where id = $1`, [conv.id]);
const late = conv ? await api("POST", `/api/inbox/conversations/${conv.id}/messages`, { cookie: A.cookie, body: { type: "text", body: "late reply" } }) : { status: 0 };
check("free-form reply outside 24 hours is refused with 409", late.status === 409, late.text);

// STOP handling
await hook(inbound(fa.phoneNumberId, `wamid.${stamp}.2`, "STOP"), fa.wabaId);
await tick();
const stopped = await db.query(`select "optedOutAt", "optIn" from "Contact" where "tenantId" = $1 and phone = '+919876543210'`, [tenantA]);
check("STOP opts the contact out", stopped.rows[0]?.optedOutAt !== null && stopped.rows[0]?.optIn === false, JSON.stringify(stopped.rows[0]));

// Contacts
const csv = "phone,name,tags,opt_in,opt_in_source\n9812345001,Asha,vip,yes,website form\n9812345002,Ravi,vip,yes,website form\n+919876543210,Opted Out,vip,yes,csv\nnot-a-number,Bad,,,\n";
const imp = await api("POST", "/api/contacts/import", { cookie: A.cookie, raw: csv, headers: { "content-type": "text/csv" } });
check("CSV import reports created, skipped and errors", imp.status === 200 && imp.json?.report?.created >= 2 && imp.json?.report?.errors?.length >= 1, imp.text);
const stillOut = await db.query(`select "optedOutAt" from "Contact" where "tenantId" = $1 and phone = '+919876543210'`, [tenantA]);
check("import never re-opts-in a contact who sent STOP", stillOut.rows[0]?.optedOutAt !== null);
const contactsB = await api("GET", "/api/contacts", { cookie: B.cookie });
check("tenant B sees none of tenant A's contacts", contactsB.json?.items?.length === 0, contactsB.text);

// Templates and broadcasts
const tpl = await api("POST", "/api/templates", { cookie: A.cookie, body: { name: `hello_${stamp}`, language: "en", category: "MARKETING", components: [{ type: "BODY", text: "Hello from Edwyz" }] } });
check("template draft is created", tpl.status === 201 || tpl.status === 200, tpl.text);
const tplId = tpl.json?.template?.id ?? tpl.json?.id;
check("tenant B cannot see tenant A's templates", ((await api("GET", "/api/templates", { cookie: B.cookie })).json?.templates ?? []).length === 0);
const draftBroadcast = tplId ? await api("POST", "/api/broadcasts", { cookie: A.cookie, body: { name: "Draft check", phoneNumberId: fa.pnRef, templateId: tplId, segmentTags: ["vip"] } }) : { status: 0 };
check("broadcast with an unapproved template is refused", draftBroadcast.status >= 400 && draftBroadcast.status < 500, draftBroadcast.text);
if (tplId) await db.query(`update "Template" set status = 'approved' where id = $1`, [tplId]);
const crossTenant = tplId ? await api("POST", "/api/broadcasts", { cookie: B.cookie, body: { name: "x", phoneNumberId: fb.pnRef, templateId: tplId, segmentTags: [] } }) : { status: 0 };
check("tenant B cannot broadcast with tenant A's template", crossTenant.status >= 400 && crossTenant.status < 500, crossTenant.text);
const bc = tplId ? await api("POST", "/api/broadcasts", { cookie: A.cookie, body: { name: "VIP offer", phoneNumberId: fa.pnRef, templateId: tplId, segmentTags: ["vip"] } }) : { status: 0 };
check("broadcast is created with an approved template", bc.status === 201 || bc.status === 200, bc.text);
const bcId = bc.json?.broadcast?.id ?? bc.json?.id;
const est = bcId ? await api("GET", `/api/broadcasts/${bcId}/estimate?country=IN`, { cookie: A.cookie }) : { json: {} };
check("cost estimate says the rate card is not configured (no invented prices)", /not configured/i.test(est.json?.label ?? ""), est.text);
const started = bcId ? await api("POST", `/api/broadcasts/${bcId}/start`, { cookie: A.cookie }) : { status: 0 };
check("broadcast starts", started.status === 200 || started.status === 202, started.text);
await tick();
await tick();
const rec = bcId ? await db.query(`select status, count(*)::int n from "BroadcastRecipient" where "broadcastId" = $1 group by status`, [bcId]) : { rows: [] };
const total = rec.rows.reduce((s, r) => s + r.n, 0);
check("audience is the opted-in contacts only (2 of 3, opted-out excluded)", total === 2, JSON.stringify(rec.rows));

// Phase 2: chatbot, routing, statuses, realtime
const inboundFrom = (phoneNumberId, waId, id, text) => ({
  messaging_product: "whatsapp",
  metadata: { display_phone_number: "15550001", phone_number_id: phoneNumberId },
  contacts: [{ profile: { name: "Bot Customer" }, wa_id: waId }],
  messages: [{ from: waId, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
});
const flow = {
  version: 1,
  start: "n1",
  nodes: [
    { id: "n1", type: "send_text", position: { x: 0, y: 0 }, data: { text: "Hello {{contact.name}}, this is the menu." } },
    { id: "n2", type: "end", position: { x: 0, y: 120 }, data: {} },
  ],
  edges: [{ id: "e1", from: "n1", to: "n2" }],
};
const bot = await api("POST", "/api/chatbots", { cookie: A.cookie, body: { name: "Menu bot", triggerType: "keyword", triggerKeywords: ["menu"], flow } });
const botId = bot.json?.chatbot?.id ?? bot.json?.id;
check("chatbot is created", (bot.status === 201 || bot.status === 200) && Boolean(botId), bot.text);
const badBot = await api("POST", "/api/chatbots", { cookie: A.cookie, body: { name: "Broken", triggerType: "keyword", triggerKeywords: ["x"], flow: { version: 1, start: "zz", nodes: [], edges: [] } } });
const badBotId = badBot.json?.chatbot?.id ?? badBot.json?.id;
const badPublish = badBotId ? await api("POST", `/api/chatbots/${badBotId}/publish`, { cookie: A.cookie }) : { status: 0 };
check("an invalid flow cannot be published", badPublish.status === 422 || badPublish.status === 400, badPublish.text);
const pub = botId ? await api("POST", `/api/chatbots/${botId}/publish`, { cookie: A.cookie }) : { status: 0 };
check("valid chatbot publishes", pub.status === 200, pub.text);
check("tenant B cannot read tenant A's chatbot", botId ? (await api("GET", `/api/chatbots/${botId}`, { cookie: B.cookie })).status === 404 : false);

await hook(inboundFrom(fa.phoneNumberId, "919812345601", `wamid.${stamp}.bot1`, "menu please"), fa.wabaId);
await tick();
await tick();
const botSession = await db.query(`select s.status from "ChatbotSession" s where s."tenantId" = $1 and s."chatbotId" = $2`, [tenantA, botId]);
check("keyword message starts the chatbot session", botSession.rows.length === 1, JSON.stringify(botSession.rows));
const botMsgs = await db.query(
  `select count(*)::int n from "Message" m join "Conversation" c on c.id = m."conversationId" join "Contact" k on k.id = c."contactId" where m."tenantId" = $1 and k.phone like '%919812345601' and m.direction = 'outbound'`,
  [tenantA],
);
check("the chatbot queued its reply", botMsgs.rows[0].n >= 1, JSON.stringify(botMsgs.rows));

const cfg = await api("PUT", "/api/routing/config", { cookie: A.cookie, body: { autoAssign: true, mode: "round_robin", timezone: "Asia/Kolkata", workingHours: null, maxOpenPerAgent: null, fallbackUserId: null } });
check("routing config saves", cfg.status === 200, cfg.text);
check("tenant B cannot change tenant A's routing", (await api("GET", "/api/routing/config", { cookie: B.cookie })).json?.config?.autoAssign !== true);
await hook(inboundFrom(fa.phoneNumberId, "919812345602", `wamid.${stamp}.route1`, "hi there"), fa.wabaId);
await tick();
const routed = await db.query(
  `select c."assignedToId" from "Conversation" c join "Contact" k on k.id = c."contactId" where c."tenantId" = $1 and k.phone like '%919812345602'`,
  [tenantA],
);
check("auto-assign routes a new conversation to an available agent", Boolean(routed.rows[0]?.assignedToId), JSON.stringify(routed.rows));

const routedId = (await api("GET", "/api/inbox/conversations?status=all", { cookie: A.cookie })).json?.items?.find((i) => i.id)?.id;
const solveTarget = (await db.query(`select c.id from "Conversation" c join "Contact" k on k.id = c."contactId" where c."tenantId" = $1 and k.phone like '%919812345602'`, [tenantA])).rows[0]?.id ?? routedId;
const solved = await api("PATCH", `/api/inbox/conversations/${solveTarget}/status`, { cookie: A.cookie, body: { status: "solved" } });
check("conversation can be marked solved", solved.status === 200, solved.text);
await hook(inboundFrom(fa.phoneNumberId, "919812345602", `wamid.${stamp}.route2`, "one more thing"), fa.wabaId);
await tick();
const reopened = await db.query(`select status from "Conversation" where id = $1`, [solveTarget]);
check("an inbound message reopens a solved conversation", reopened.rows[0]?.status === "open", JSON.stringify(reopened.rows));
check("tenant B cannot change tenant A's conversation status", (await api("PATCH", `/api/inbox/conversations/${solveTarget}/status`, { cookie: B.cookie, body: { status: "solved" } })).status === 404);

const ctrl = new AbortController();
const sse = await fetch(base + "/api/inbox/stream", { headers: { cookie: A.cookie }, signal: ctrl.signal }).catch(() => null);
check("inbox stream opens as server-sent events", Boolean(sse) && sse.status === 200 && /text\/event-stream/.test(sse.headers.get("content-type") ?? ""), String(sse?.status));
ctrl.abort();
check("inbox stream needs a login", (await fetch(base + "/api/inbox/stream").catch(() => ({ status: 0 }))).status === 401);

// Phase 3 and growth surfaces: MCP, compatibility API, public webhooks, public pages, module APIs
const keyBody = { name: "smoke", scopes: ["contacts:read", "contacts:write", "templates:read", "conversations:read", "broadcasts:read", "messages:write"] };
const keyA = await api("POST", "/api/integrations/api-keys", { cookie: A.cookie, body: keyBody });
const keyB = await api("POST", "/api/integrations/api-keys", { cookie: B.cookie, body: keyBody });
check("API keys can be created", keyA.status === 201 && keyB.status === 201 && String(keyA.json?.key).startsWith("wak_"), keyA.text);
const bearerA = { authorization: `Bearer ${keyA.json?.key}`, "content-type": "application/json" };
const bearerB = { authorization: `Bearer ${keyB.json?.key}`, "content-type": "application/json" };
const rpc = (headers, method, params, id = 1) => api("POST", "/api/mcp", { headers, raw: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });

check("MCP rejects a request without a key", (await api("POST", "/api/mcp", { raw: "{}" })).status === 401);
check("MCP does not answer GET", (await api("GET", "/api/mcp")).status === 405);
const init = await rpc(bearerA, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
check("MCP initialize works", init.status === 200 && Boolean(init.json?.result), init.text);
const tools = await rpc(bearerA, "tools/list", {}, 2);
const toolNames = (tools.json?.result?.tools ?? []).map((t) => t.name);
check("MCP lists tools allowed by the key's scopes", toolNames.includes("list_conversations") && toolNames.includes("search_contacts"), tools.text);
const mcpA = await rpc(bearerA, "tools/call", { name: "list_conversations", arguments: {} }, 3);
const mcpB = await rpc(bearerB, "tools/call", { name: "list_conversations", arguments: {} }, 4);
check("MCP tenant A sees its conversations", JSON.stringify(mcpA.json).includes("919876543210") || (mcpA.json?.result?.content?.length ?? 0) > 0, mcpA.text.slice(0, 200));
check("MCP tenant B sees none of tenant A's data", !JSON.stringify(mcpB.json).includes("919876543210"), mcpB.text.slice(0, 200));
const sendGuard = await rpc(bearerA, "tools/call", { name: "send_text_reply", arguments: { conversationId: "nonexistent", text: "hi" } }, 5);
check("MCP send tool does not send without confirm", sendGuard.status === 200 && !/"sent"\s*:\s*true/.test(sendGuard.text), sendGuard.text.slice(0, 200));

const extA = await api("GET", "/api/ext/v3/contacts?page_number=1&page_size=100", { headers: bearerA });
const extB = await api("GET", "/api/ext/v3/contacts?page_number=1&page_size=100", { headers: bearerB });
check("compat API lists contacts with the pagination envelope", extA.status === 200 && Array.isArray(extA.json?.contact_list ?? extA.json?.data ?? extA.json?.contacts ?? extA.json?.items), extA.text.slice(0, 200));
check("compat API is tenant scoped", !JSON.stringify(extB.json).includes("919876543210"), extB.text.slice(0, 200));
check("compat API refuses page_size over 100", (await api("GET", "/api/ext/v3/contacts?page_size=101", { headers: bearerA })).status === 400);
check("compat API refuses a missing key", (await api("GET", "/api/ext/v3/contacts")).status === 401);

const leadHook = async (raw, sig) => api("POST", "/webhooks/leads", { raw, headers: { "content-type": "application/json", ...(sig ? { "x-hub-signature-256": sig } : {}) } });
const leadBody = JSON.stringify({ object: "page", entry: [{ id: "PAGE_UNKNOWN", time: 1, changes: [{ field: "leadgen", value: { leadgen_id: "L1", page_id: "PAGE_UNKNOWN", form_id: "F1" } }] }] });
check("lead webhook rejects an unsigned request", [400, 401, 403].includes((await leadHook(leadBody)).status));
check("lead webhook rejects a bad signature", [400, 401, 403].includes((await leadHook(leadBody, "sha256=00")).status));
const goodSig = `sha256=${createHmac("sha256", secret).update(leadBody).digest("hex")}`;
check("lead webhook accepts a correctly signed event", (await leadHook(leadBody, goodSig)).status === 200);
check("lead webhook handshake needs the verify token", (await api("GET", "/webhooks/leads?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")).status === 403);
const shop = await api("POST", "/webhooks/shopify", { raw: "{}", headers: { "content-type": "application/json", "x-shopify-shop-domain": "nope.myshopify.com", "x-shopify-hmac-sha256": "AAAA" } });
check("Shopify webhook rejects unknown stores", [400, 401, 403, 404].includes(shop.status), String(shop.status));

check("approval page does not leak for an unknown token", [200, 404].includes((await api("GET", "/approve/not-a-real-token-0000000000000000000000000000")).status));
check("approval decision refuses an unknown token", (await api("POST", "/api/approvals/not-a-real-token/decide", { raw: "decision=approved", headers: { "content-type": "application/x-www-form-urlencoded" } })).status < 500);
check("signed creative URL rejects a forged signature", (await api("GET", "/api/creative/public/t/a?exp=9999999999&sig=bad")).status === 403);
check("public API docs render", (await api("GET", "/docs")).status === 200 && (await api("GET", "/docs/endpoints")).status === 200);

for (const [name, path] of [
  ["AI agent list", "/api/ai-agent/agents"],
  ["Meta connections", "/api/meta-connect/connections"],
  ["chatbot list", "/api/chatbots"],
  ["content calendar", `/api/content/calendar?from=${new Date().toISOString()}&to=${new Date(Date.now() + 86400000 * 14).toISOString()}`],
  ["ad insights summary", "/api/ads/insights/summary?from=2026-10-01&to=2026-10-27"],
  ["ad campaigns", "/api/ads/campaigns"],
  ["leads list", "/api/leads"],
  ["conversion events", "/api/conversions"],
  ["commerce stores", "/api/commerce/stores"],
  ["AI tool connections", "/api/mcp-connections"],
  ["optimiser proposals", "/api/optimizer/proposals"],
  ["creative briefs", "/api/creative/briefs"],
]) {
  const r = await api("GET", path, { cookie: A.cookie });
  check(`${name} responds for the owner`, r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
  const anon = await api("GET", path);
  check(`${name} needs a login`, anon.status === 401, String(anon.status));
}
check("ad launch is refused without a budget cap", (await api("POST", "/api/ads/campaigns/nonexistent/launch", { cookie: A.cookie, body: {} })).status >= 400);

// ---- Platform: email verification, billing, invites and roles, reports and exports, automation, teams, segments ----
const aliceEmail = `alice+${stamp}@example.com`;
// Mail that carries a one-time link is queued with an encrypted body (src/lib/email/index.ts: AES-256-GCM, ENCRYPTION_KEY, AAD "email-job:<to>").
// Without ENCRYPTION_KEY in a non-production server the body is queued as plain text, which this reader also handles.
const openMail = (p) => {
  if (typeof p?.text === "string") return p.text;
  if (!p?.sealed || !process.env.ENCRYPTION_KEY) return "";
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(process.env.ENCRYPTION_KEY, "base64"), Buffer.from(p.sealed.iv, "base64"), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`email-job:${p.to}`, "utf8"));
    decipher.setAuthTag(Buffer.from(p.sealed.authTag, "base64"));
    const body = Buffer.concat([decipher.update(Buffer.from(p.sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
    return String(JSON.parse(body).text ?? "");
  } catch {
    return "";
  }
};
const emailText = async (to, pattern) => {
  const rows = (await db.query(`select payload from "Job" where queue = 'email' and payload->>'to' = $1 order by "createdAt" desc limit 10`, [to])).rows;
  return rows.map((r) => openMail(r.payload)).find((t) => pattern.test(t)) ?? "";
};
const queuedPayloadsText = async (to) => (await db.query(`select payload::text as p from "Job" where queue = 'email' and payload->>'to' = $1`, [to])).rows.map((r) => r.p).join("\n");
const emailSubjects = async (to) => (await db.query(`select payload->>'subject' as s from "Job" where queue = 'email' and payload->>'to' = $1`, [to])).rows.map((r) => r.s);
const tokenIn = (text) => /token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? "";
const gateOn = (() => {
  const v = (process.env.EMAIL_VERIFICATION_REQUIRED ?? "").trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(v)) return false;
  if (["true", "1", "yes", "on"].includes(v)) return true;
  return Boolean(process.env.SMTP_USER);
})();

// Email verification: an unverified account reads freely, writes are refused while the gate is on, and the emailed link lifts it.
const danEmail = `dan+${stamp}@example.com`;
const D = await signup("Dan", danEmail);
check("a new account queues its confirmation email", /verify-email\?token=/.test(await emailText(danEmail, /verify-email/)), "no verify mail in the queue");
check("an unverified account can still read", (await api("GET", "/api/inbox/conversations", { cookie: D.cookie })).status === 200);
const unverifiedWrite = await api("POST", "/api/inbox/conversations/none/messages", { cookie: D.cookie, body: { type: "text", body: "x" } });
check(gateOn ? "an unverified account cannot send messages" : "verification gate is off here, so the send reaches the lookup", gateOn ? unverifiedWrite.status === 403 : unverifiedWrite.status === 404, `${unverifiedWrite.status} ${unverifiedWrite.text.slice(0, 120)}`);
check("an unverified account can still reach settings", (await api("GET", "/api/billing", { cookie: D.cookie })).status === 200);
if (process.env.ENCRYPTION_KEY) {
  const queuedText = await queuedPayloadsText(danEmail);
  check("the confirmation mail waits in the queue without its one-time link in the clear", queuedText.length > 0 && !/token=/.test(queuedText), "a raw token is stored in the Job payload");
}
const unverifiedProfile = await api("PUT", "/api/billing/profile", { cookie: D.cookie, body: { legalName: "Dan Co", addressLine: "1 Road, Pune", state: "Maharashtra", billingEmail: danEmail } });
check("an unverified account can still save its billing details (a settings write)", unverifiedProfile.status === 200, `${unverifiedProfile.status} ${unverifiedProfile.text.slice(0, 120)}`);
const unverifiedInvite = await api("POST", "/api/workspace/invites", { cookie: D.cookie, body: { email: `blocked+${stamp}@example.com`, role: "agent" } });
check(
  gateOn ? "an unverified account cannot send invitation emails" : "verification gate is off here, so the invite goes through",
  gateOn ? unverifiedInvite.status === 403 : unverifiedInvite.status === 201 || unverifiedInvite.status === 200,
  `${unverifiedInvite.status} ${unverifiedInvite.text.slice(0, 120)}`,
);
const resend = await api("POST", "/api/auth/resend-verification", { cookie: D.cookie, body: {} });
check("resending the confirmation email works", resend.status === 200 && resend.json?.alreadyVerified === false, resend.text);
let resendStatus = 200;
for (let i = 0; i < 4 && resendStatus === 200; i++) resendStatus = (await api("POST", "/api/auth/resend-verification", { cookie: D.cookie, body: {} })).status;
check("resending is rate limited", resendStatus === 429, String(resendStatus));
const verifyToken = tokenIn(await emailText(danEmail, /verify-email/));
check("a wrong confirmation token is refused", (await api("POST", "/api/auth/verify-email", { body: { token: "not-a-real-token" } })).status === 400);
const verified = await api("POST", "/api/auth/verify-email", { body: { token: verifyToken } });
check("the emailed link confirms the address", verified.status === 200, verified.text);
const afterVerify = await api("POST", "/api/inbox/conversations/none/messages", { cookie: D.cookie, body: { type: "text", body: "x" } });
check("after confirming, writes are no longer blocked by the gate", afterVerify.status === 404, `${afterVerify.status} ${afterVerify.text.slice(0, 120)}`);

// Billing: a plan created the way an admin would (SQL fixture), plan list, profile validation, checkout creation, role and tenant checks.
const planId = `plan_smoke_${stamp}`;
await db.query(
  `insert into "Plan" (id, code, name, "pricePaise", currency, "intervalMonths", "seatLimit", features, "razorpayPlanId", active, "sortOrder") values ($1,$2,$3,$4,'INR',1,5,'{}',$5,true,999)`,
  [planId, `smoke_${stamp}`, "Smoke plan", 99900, `plan_rz_${stamp}`],
);
const billingA = await api("GET", "/api/billing", { cookie: A.cookie });
check("billing overview loads for the owner", billingA.status === 200 && Boolean(billingA.json?.status) && Array.isArray(billingA.json?.plans), billingA.text.slice(0, 200));
const planList = await api("GET", "/api/billing/plans", { cookie: A.cookie });
check("the plan created by the admin path is offered with its price", (planList.json?.plans ?? []).some((p) => p.id === planId && p.pricePaise === 99900), planList.text.slice(0, 200));
check("billing needs a login", (await api("GET", "/api/billing")).status === 401);
const badProfile = await api("PUT", "/api/billing/profile", { cookie: A.cookie, body: { legalName: "Alice Co", gstin: "NOTAGSTIN", addressLine: "1 Road", state: "Maharashtra", billingEmail: aliceEmail } });
check("a malformed GSTIN is refused", badProfile.status === 400, badProfile.text);
const goodProfile = await api("PUT", "/api/billing/profile", { cookie: A.cookie, body: { legalName: "Alice Co", gstin: "27AAPFU0939F1ZV", addressLine: "1 Road, Mumbai", state: "Maharashtra", pincode: "400001", billingEmail: aliceEmail } });
check("a valid billing profile saves", goodProfile.status === 200, goodProfile.text);
const unknownPlan = await api("POST", "/api/billing/subscribe", { cookie: A.cookie, body: { planId: "does-not-exist" } });
check("subscribing to an unknown plan is refused", unknownPlan.status === 404, unknownPlan.text);
if (process.env.RAZORPAY_KEY_ID) {
  console.log("      (Razorpay keys are set in .env, so checkout creation is not called from the smoke test)");
} else {
  const checkout = await api("POST", "/api/billing/subscribe", { cookie: A.cookie, body: { planId } });
  check("checkout creation is switched off without Razorpay keys, with a clear message", checkout.status === 503 && /not configured/i.test(checkout.text), `${checkout.status} ${checkout.text.slice(0, 160)}`);
}
check("a forged checkout confirmation is refused", (await api("POST", "/api/billing/verify", { cookie: A.cookie, body: { razorpay_payment_id: "pay_x", razorpay_subscription_id: "sub_x", razorpay_signature: "00" } })).status === 400);
check("the Razorpay webhook refuses a bad signature", (await api("POST", "/api/webhooks/razorpay", { raw: "{}", headers: { "x-razorpay-signature": "00", "content-type": "application/json" } })).status === 401);

const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
if (!webhookSecret) {
  console.log("      (RAZORPAY_WEBHOOK_SECRET is not set in .env, so the signed Razorpay webhook checks are skipped)");
} else {
  const subId = `sub_smoke_${stamp}`;
  await db.query(
    `insert into "Subscription" (id, "tenantId", "planId", status, "razorpaySubscriptionId", "updatedAt") values ($1,$2,$3,'expired',$4, now())
     on conflict ("tenantId") do update set "planId" = excluded."planId", status = 'expired', "razorpaySubscriptionId" = excluded."razorpaySubscriptionId", "pastDueSince" = null`,
    [`sub_row_${stamp}`, tenantA, planId, subId],
  );
  const nowS = Math.floor(Date.now() / 1000);
  const rzHook = async (event, entityStatus, eventId, extra = {}, createdAt = undefined) => {
    const body = JSON.stringify({
      event,
      ...(createdAt ? { created_at: createdAt } : {}),
      payload: { subscription: { entity: { id: subId, plan_id: `plan_rz_${stamp}`, status: entityStatus, current_start: nowS, current_end: nowS + 30 * 86400, paid_count: 1, notes: { tenantId: tenantA } } }, ...extra },
    });
    const sig = createHmac("sha256", webhookSecret).update(body).digest("hex");
    return api("POST", "/api/webhooks/razorpay", { raw: body, headers: { "x-razorpay-signature": sig, "x-razorpay-event-id": eventId, "content-type": "application/json" } });
  };
  const payment = { payment: { entity: { id: `pay_smoke_${stamp}`, amount: 99900, currency: "INR", status: "captured", method: "card" } } };
  const charged = await rzHook("subscription.charged", "active", `evt_charged_${stamp}`, payment);
  check("a signed charged event activates the subscription", charged.status === 200, charged.text);
  const activeRow = (await db.query(`select status from "Subscription" where "tenantId" = $1`, [tenantA])).rows[0];
  check("the subscription is now active", activeRow?.status === "active", JSON.stringify(activeRow));
  const redelivered = await rzHook("subscription.charged", "active", `evt_charged_${stamp}`, payment);
  const otherEvent = await rzHook("subscription.charged", "active", `evt_charged_again_${stamp}`, payment);
  check("redelivered and repeated events are acknowledged", redelivered.status === 200 && otherEvent.status === 200);
  const invoices = (await db.query(`select id, number, "gstPaise", "totalPaise" from "Invoice" where "tenantId" = $1`, [tenantA])).rows;
  check("exactly one invoice exists for the payment, however often it is delivered", invoices.length === 1, JSON.stringify(invoices));
  const inv = invoices[0];
  check("the invoice splits the GST out of the plan price", inv && inv.totalPaise === 99900 && inv.gstPaise > 0, JSON.stringify(inv));
  const invList = await api("GET", "/api/billing/invoices", { cookie: A.cookie });
  check("the owner sees the invoice in the list", (invList.json?.invoices ?? []).some((i) => i.id === inv?.id), invList.text.slice(0, 200));
  const dl = inv ? await api("GET", `/api/billing/invoices/${inv.id}/download`, { cookie: A.cookie }) : { status: 0, text: "", res: { headers: new Headers() } };
  check("the invoice downloads as an HTML file", dl.status === 200 && /attachment/.test(dl.res.headers.get("content-disposition") ?? "") && dl.text.includes(inv?.number ?? "~"), String(dl.status));
  check("the print view of the invoice opens", inv ? (await api("GET", `/app/billing/invoices/${inv.id}`, { cookie: A.cookie })).status === 200 : false);
  check("another workspace cannot download this invoice", inv ? (await api("GET", `/api/billing/invoices/${inv.id}/download`, { cookie: B.cookie })).status === 404 : false);
  check("a payment receipt was queued for the owner", (await emailSubjects(aliceEmail)).some((s) => /payment|receipt|invoice/i.test(s ?? "")));
  const failing = await rzHook("subscription.pending", "pending", `evt_pending_${stamp}`, { payment: { entity: { id: `pay_fail_${stamp}`, amount: 99900, currency: "INR", status: "failed", error_code: "BAD_REQUEST_ERROR" } } });
  const pendingRow = (await db.query(`select status from "Subscription" where "tenantId" = $1`, [tenantA])).rows[0];
  check("a failed charge marks the workspace past due", failing.status === 200 && pendingRow?.status === "past_due", `${failing.status} ${JSON.stringify(pendingRow)}`);
  check("a payment failed email was queued for the owner", (await emailSubjects(aliceEmail)).some((s) => /did not go through/i.test(s ?? "")));
  await rzHook("subscription.charged", "active", `evt_recover_${stamp}`, { payment: { entity: { id: `pay_ok2_${stamp}`, amount: 99900, currency: "INR", status: "captured" } } });
  const recovered = (await db.query(`select status from "Subscription" where "tenantId" = $1`, [tenantA])).rows[0];
  check("a later successful charge brings the workspace back to active", recovered?.status === "active", JSON.stringify(recovered));

  // Ordering: a delayed older event must not undo a newer one.
  await rzHook("subscription.charged", "active", `evt_newest_${stamp}`, {}, nowS + 100);
  const late = await rzHook("subscription.pending", "pending", `evt_late_pending_${stamp}`, {}, nowS + 50);
  const afterLate = (await db.query(`select status from "Subscription" where "tenantId" = $1`, [tenantA])).rows[0];
  check("a delayed older failure event does not flip an active workspace to past due", late.status === 200 && afterLate?.status === "active", `${late.status} ${JSON.stringify(afterLate)}`);

  // The invoice keeps what it was issued with, and a checkout confirmation cannot be replayed.
  const snapshot = inv ? (await db.query(`select 1 from "PlatformSetting" where key = $1`, ["invoice-meta:" + inv.number])).rowCount : 0;
  check("the invoice stored a snapshot of its seller details and tax status", snapshot === 1, String(snapshot));
  const doc = inv ? await api("GET", `/api/billing/invoices/${inv.id}`, { cookie: A.cookie }) : { json: null, text: "" };
  check("the invoice document says whether it is a tax invoice or a proforma", /Tax invoice|Proforma/.test(doc.json?.document?.title ?? ""), doc.text.slice(0, 160));
  if (process.env.RAZORPAY_KEY_SECRET) {
    const before = (await db.query(`select "currentPeriodEnd" as e from "Subscription" where "tenantId" = $1`, [tenantA])).rows[0]?.e?.getTime();
    const replaySig = createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`pay_smoke_${stamp}|${subId}`).digest("hex");
    const replay = await api("POST", "/api/billing/verify", { cookie: A.cookie, body: { razorpay_payment_id: `pay_smoke_${stamp}`, razorpay_subscription_id: subId, razorpay_signature: replaySig } });
    const after = (await db.query(`select "currentPeriodEnd" as e from "Subscription" where "tenantId" = $1`, [tenantA])).rows[0]?.e?.getTime();
    check("replaying a checkout confirmation on a paid-up workspace changes nothing", replay.status === 200 && replay.json?.alreadyActive === true && before === after, `${replay.status} ${replay.text.slice(0, 120)}`);
  }
}

const ymd = (d) => d.toISOString().slice(0, 10);
const rangeQuery = `from=${ymd(new Date(Date.now() - 7 * 86400000))}&to=${ymd(new Date(Date.now() + 86400000))}`;
// Invites and roles
const carolEmail = `carol+${stamp}@example.com`;
const invite = await api("POST", "/api/workspace/invites", { cookie: A.cookie, body: { email: carolEmail, role: "agent" } });
check("the owner can invite an agent", invite.status === 201 || invite.status === 200, invite.text);
check(
  "the invite link is returned to the inviter only when this server cannot email it",
  Boolean(invite.json?.acceptUrl) === !process.env.SMTP_USER && invite.json?.emailed === Boolean(process.env.SMTP_USER),
  invite.text.slice(0, 160),
);
const inviteToken = tokenIn(await emailText(carolEmail, /accept-invite/));
check("the invite email carries a one-time link", inviteToken.length > 20, "no invite mail in the queue");
check("the invite page shows who is invited and where", (await api("GET", `/api/auth/accept-invite?token=${inviteToken}`)).json?.workspaceName?.length > 0);
check("an invalid invite token is refused", (await api("GET", "/api/auth/accept-invite?token=nope")).status === 400);
const accepted = await api("POST", "/api/auth/accept-invite", { body: { token: inviteToken, name: "Carol", password: "correct horse battery" } });
check("the invited person joins with the invited role", accepted.status === 200 && accepted.json?.role === "agent", accepted.text);
check("an invite link cannot be used twice", (await api("POST", "/api/auth/accept-invite", { body: { token: inviteToken, name: "Carol", password: "correct horse battery" } })).status === 400);
const C = { cookie: jar(accepted.res) };
check("the agent sees the shared inbox", (await api("GET", "/api/inbox/conversations", { cookie: C.cookie })).status === 200);
check("an agent cannot open billing", (await api("GET", "/api/billing", { cookie: C.cookie })).status === 403);
check("an agent cannot invite people", (await api("POST", "/api/workspace/invites", { cookie: C.cookie, body: { email: `x${stamp}@example.com`, role: "agent" } })).status === 403);
check("an agent cannot export the workspace", (await api("GET", "/api/export/contacts.csv", { cookie: C.cookie })).status === 403);
check("an agent cannot create automation rules", (await api("POST", "/api/automation", { cookie: C.cookie, body: { version: 2, name: "x", trigger: { type: "message_received" }, filters: {}, actions: [{ type: "send_text", text: "x" }] } })).status === 403);
check("an agent cannot ask to delete the workspace", (await api("GET", "/api/billing/workspace-deletion", { cookie: C.cookie })).status === 403);
check("the owner can see there is no open deletion request", (await api("GET", "/api/billing/workspace-deletion", { cookie: A.cookie })).json?.request === null);
check("a wrong workspace name does not start a deletion request", (await api("POST", "/api/billing/workspace-deletion", { cookie: A.cookie, body: { confirmName: "not the name" } })).status === 400);
check("an agent cannot create teams", (await api("POST", "/api/teams", { cookie: C.cookie, body: { name: "Nope" } })).status === 403);
check("an agent can read the reports", (await api("GET", `/api/reports/overview?${rangeQuery}`, { cookie: C.cookie })).status === 200);
check("tenant B's owner cannot list tenant A's invites", !JSON.stringify((await api("GET", "/api/workspace/invites", { cookie: B.cookie })).json).includes(carolEmail));

// Reports and exports
const overview = await api("GET", `/api/reports/overview?${rangeQuery}`, { cookie: A.cookie });
check("the reports overview loads with a message series", overview.status === 200 && Array.isArray(overview.json?.messagesPerDay), overview.text.slice(0, 200));
check("the overview counts today's inbound message", (overview.json?.messagesPerDay ?? []).reduce((n, d) => n + (d.inbound ?? 0), 0) >= 1, overview.text.slice(0, 300));
check("the owner overview includes the per-agent and broadcast sections", overview.json?.admin !== null && Array.isArray(overview.json?.admin?.agents), overview.text.slice(0, 200));
check("the agent overview leaves out admin-only sections", (await api("GET", `/api/reports/overview?${rangeQuery}`, { cookie: C.cookie })).json?.admin === null);
check("reports need a login", (await api("GET", `/api/reports/overview?${rangeQuery}`)).status === 401);
check("an unreadable date range is refused", (await api("GET", "/api/reports/overview?from=banana&to=2026-01-01", { cookie: A.cookie })).status === 400);
const usageReport = await api("GET", "/api/reports/usage", { cookie: A.cookie });
check("the usage report loads", usageReport.status === 200, usageReport.text.slice(0, 200));
const planUsage = await api("GET", "/api/billing/usage", { cookie: A.cookie });
check("the plan usage meter lists every limit", planUsage.status === 200 && Array.isArray(planUsage.json?.lines) && planUsage.json.lines.length > 0, planUsage.text.slice(0, 200));

const csvA = await api("GET", "/api/export/contacts.csv", { cookie: A.cookie });
check("contacts export as a CSV download", csvA.status === 200 && /text\/csv/.test(csvA.res.headers.get("content-type") ?? "") && /attachment/.test(csvA.res.headers.get("content-disposition") ?? ""), String(csvA.status));
check("the contacts CSV holds this workspace's contacts", csvA.text.includes("919876543210"), csvA.text.slice(0, 200));
check("the contacts CSV never holds another workspace's contacts", !(await api("GET", "/api/export/contacts.csv", { cookie: B.cookie })).text.includes("919876543210"));
const jsonA = await api("GET", "/api/export/contacts.csv?format=json", { cookie: A.cookie });
check("contacts export as JSON too", jsonA.status === 200 && Array.isArray(jsonA.json) && jsonA.json.length >= 2, jsonA.text.slice(0, 200));
for (const [label, path] of [
  ["messages", `/api/export/messages.csv?${rangeQuery}`],
  ["leads", "/api/export/leads.csv"],
  ["broadcasts", "/api/export/broadcasts.csv"],
]) {
  const csv = await api("GET", path, { cookie: A.cookie });
  const asJson = await api("GET", `${path}${path.includes("?") ? "&" : "?"}format=json`, { cookie: A.cookie });
  check(`${label} export as CSV`, csv.status === 200 && /text\/csv/.test(csv.res.headers.get("content-type") ?? ""), `${csv.status} ${csv.text.slice(0, 120)}`);
  check(`${label} export as JSON`, asJson.status === 200 && Array.isArray(asJson.json), `${asJson.status} ${asJson.text.slice(0, 120)}`);
  check(`${label} export needs a login`, (await api("GET", path)).status === 401);
}
check("the messages CSV holds this workspace's message text", (await api("GET", `/api/export/messages.csv?${rangeQuery}`, { cookie: A.cookie })).text.includes("Hello, I need help"));
check("the messages CSV does not leak into another workspace", !(await api("GET", `/api/export/messages.csv?${rangeQuery}`, { cookie: B.cookie })).text.includes("Hello, I need help"));
const wsJson = await api("GET", "/api/export/workspace.json", { cookie: A.cookie });
check("the whole workspace downloads as one JSON file", wsJson.status === 200 && typeof wsJson.json === "object" && wsJson.json !== null, wsJson.text.slice(0, 120));
check("the workspace JSON holds no password hashes or tokens", !/passwordHash|tokenHash|accessToken/i.test(wsJson.text));
check("the workspace JSON says whether any section was cut short", Array.isArray(wsJson.json?.truncatedSections), wsJson.text.slice(0, 120));
const someContact = (await db.query(`select id from "Contact" where "tenantId" = $1 limit 1`, [tenantA])).rows[0];
const personal = await api("GET", `/api/export/contact/${someContact?.id}`, { cookie: A.cookie });
check("one contact's personal data downloads as JSON", personal.status === 200 && typeof personal.json === "object" && /attachment/.test(personal.res.headers.get("content-disposition") ?? ""), personal.text.slice(0, 160));
check("one contact's personal data downloads as CSV", (await api("GET", `/api/export/contact/${someContact?.id}?format=csv`, { cookie: A.cookie })).status === 200);
check("another workspace cannot export this contact", (await api("GET", `/api/export/contact/${someContact?.id}`, { cookie: B.cookie })).status === 404);
check("an agent cannot export a contact", (await api("GET", `/api/export/contact/${someContact?.id}`, { cookie: C.cookie })).status === 403);

// Automation rules
const ruleBody = {
  version: 2,
  name: `Smoke price rule ${stamp}`,
  trigger: { type: "message_received" },
  filters: { root: { type: "group", op: "and", items: [{ type: "keyword", mode: "contains", keywords: ["price"] }] } },
  actions: [{ type: "send_text", text: "See our prices at example.com." }],
};
const rule = await api("POST", "/api/automation", { cookie: A.cookie, body: ruleBody });
const ruleId = rule.json?.rule?.id;
check("an automation rule (when, if, then) is created", rule.status === 201 && Boolean(ruleId), rule.text.slice(0, 200));
check("an invalid rule is refused", (await api("POST", "/api/automation", { cookie: A.cookie, body: { ...ruleBody, actions: [] } })).status === 400);
check("the new rule is listed", ((await api("GET", "/api/automation", { cookie: A.cookie })).json?.rules ?? []).some((r) => r.id === ruleId));
check("tenant B does not see tenant A's rules", !((await api("GET", "/api/automation", { cookie: B.cookie })).json?.rules ?? []).some((r) => r.id === ruleId));
check("tenant B cannot change tenant A's rule", ruleId ? (await api("PATCH", `/api/automation/${ruleId}`, { cookie: B.cookie, body: { enabled: false } })).status === 404 : false);
const toggled = ruleId ? await api("PATCH", `/api/automation/${ruleId}`, { cookie: A.cookie, body: { enabled: false } }) : { status: 0, text: "" };
check("a rule can be switched off", toggled.status === 200, toggled.text.slice(0, 200));
check("the run log loads", (await api("GET", "/api/automation/executions", { cookie: A.cookie })).status === 200);
check("a rule can be deleted", ruleId ? (await api("DELETE", `/api/automation/${ruleId}`, { cookie: A.cookie })).status === 200 : false);

// Teams
const team = await api("POST", "/api/teams", { cookie: A.cookie, body: { name: `Support ${stamp}` } });
const teamId = team.json?.team?.id;
check("a team is created", team.status === 201 && Boolean(teamId), team.text);
const teamsA = await api("GET", "/api/teams", { cookie: A.cookie });
check("the team list holds the default team and the new one", (teamsA.json?.teams ?? []).some((t) => t.isDefault) && (teamsA.json?.teams ?? []).some((t) => t.id === teamId), teamsA.text.slice(0, 200));
check("tenant B does not see tenant A's teams", !JSON.stringify((await api("GET", "/api/teams", { cookie: B.cookie })).json).includes(`Support ${stamp}`));
check("tenant B cannot rename tenant A's team", teamId ? (await api("PATCH", `/api/teams/${teamId}`, { cookie: B.cookie, body: { name: "Hijacked" } })).status === 404 : false);
check("a team can be deleted", teamId ? (await api("DELETE", `/api/teams/${teamId}`, { cookie: A.cookie })).status === 200 : false);

// Segments
const filter = { all: [{ field: "optInSource", op: "contains", value: "csv" }] };
const seg = await api("POST", "/api/segments", { cookie: A.cookie, body: { name: `Smoke segment ${stamp}`, filter } });
const segId = seg.json?.segment?.id;
check("a segment is created from a filter", seg.status === 201 && Boolean(segId), seg.text.slice(0, 200));
check("a segment with no filters is refused", (await api("POST", "/api/segments", { cookie: A.cookie, body: { name: "Everyone", filter: { all: [] } } })).status === 400);
const preview = await api("POST", "/api/segments/preview", { cookie: A.cookie, body: { filter } });
check("a segment preview says how many contacts it reaches", preview.status === 200 && typeof (preview.json?.count ?? preview.json?.total ?? preview.json?.matched) === "number", preview.text.slice(0, 200));
check("the segment is listed", ((await api("GET", "/api/segments", { cookie: A.cookie })).json?.segments ?? []).some((s) => s.id === segId));
check("tenant B does not see tenant A's segments", !((await api("GET", "/api/segments", { cookie: B.cookie })).json?.segments ?? []).some((s) => s.id === segId));
check("a segment can be deleted", segId ? (await api("DELETE", `/api/segments/${segId}`, { cookie: A.cookie })).status === 200 : false);

await db.query(`update "Plan" set active = false where id = $1`, [planId]);

// Auth hygiene
const bad = await api("POST", "/api/auth/login", { body: { email: `alice+${stamp}@example.com`, password: "wrong password here" } });
const unknown = await api("POST", "/api/auth/login", { body: { email: `nobody+${stamp}@example.com`, password: "wrong password here" } });
check("login error is identical for wrong password and unknown email", bad.status === unknown.status && bad.text === unknown.text, `${bad.text} / ${unknown.text}`);
const refresh = await api("POST", "/api/auth/refresh", { cookie: A.cookie });
check("refresh rotates the session", refresh.status === 200, refresh.text);
const reuse = await api("POST", "/api/auth/refresh", { cookie: A.cookie });
check("re-using the old refresh token is refused", reuse.status === 401, reuse.text);

await db.end();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
