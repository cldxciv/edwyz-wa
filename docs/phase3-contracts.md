# Phase 3 and Growth Phase A/B contracts (read with docs/AGENT-BRIEF.md, docs/PLATFORM-PLAN.md, docs/PRODUCT-SPEC-GROWTH.md, docs/phase2-contracts.md)

Schema is migrated (0005_growth) and the client generated. New models: MetaConnection, MetaAsset, Brand, CreativeBrief, CreativeAngle, CreativeAsset, ApprovalRequest, AdCampaign, AdSet, Ad, InsightSnapshot, OptimizerProposal, LeadForm, Lead, LeadSequence, LeadSequenceRun, ScheduledPost, PostTarget, ConversionEvent, UsageLedger, AiAgent, AiKnowledgeSource, McpConnection, ShopifyStore, AbandonedCart; new columns Plan.aiCreditsMonthly, Plan.adAccountLimit, Conversation.referral. Do not edit the schema; append requests to `docs/schema-requests.md` and design around them.

## Rules for this wave (in addition to the brief)

1. **No network, no real Meta calls, no real vendor calls in tests or code paths you run.** Mock `graphFetchAs`, `fetch`, Prisma. Do not start servers. Do not run `npm install`; use Node built-ins and `fetch`.
2. **Meta tokens**: stored with `sealSecret(tenantId, token)` and read with `openSecret` from `@/lib/crypto/secrets`. Never return, log or put a token in an error. Calls with a non-WhatsApp token use `graphFetchAs(token, { path, method, query, body })` from `@/lib/graph`. Calls with the tenant's WhatsApp token keep using `graphFetch`. Always call through the helpers; the API version is pinned in `@/lib/config`.
3. **Cross-module dependencies use the stub contracts** below (already present as files; the owning agent replaces the stub body and keeps the exports). If you depend on a stub, mock it in tests.
4. **Money is real**: nothing that spends ad money runs without an explicit confirm action from an owner or admin; campaigns are created PAUSED and activated on a separate confirm; hard daily-budget caps are enforced in code (`MAX_DAILY_BUDGET_MINOR` env, default unset = refuse to launch until an owner sets a cap in workspace settings stored in `PlatformSetting` key `ads:caps:<tenantId>`); every change writes an AuditLog row.
5. **Consent and Meta policy**: WhatsApp marketing sends need opt-in (store lead-form consent on the Contact as optIn + optInSource "lead_form"); template category rules and the 24h window are enforced by the existing send functions.
6. **AI usage** is recorded with `recordUsage` and priced from `CREDIT_COST` in `@/lib/usage`. LLM calls go through `fetch` to `https://api.anthropic.com/v1/messages` with `ANTHROPIC_API_KEY` (env) and model from env `AI_MODEL` (default `claude-sonnet-5-5`), `anthropic-version: 2023-06-01`; with no key set, features degrade to a clear "AI is not configured" error. Never send secrets or other tenants' data in prompts; cap prompt size; log no message content.
7. **Tenant isolation, CSRF (`assertSameOrigin`), role checks (admin or owner for writes unless stated), size-limited bodies, no secrets in responses** exactly as in the brief and the wave 3 addendum.
8. Nav links, webhook wiring (`src/lib/webhooks/processor.ts`), worker registration (`src/worker/loop.ts`), billing limits and the Meta webhook routes' registration in `.env.example` are done by the coordinator. You export `worker: { queues, periodic }` from `src/lib/<area>/worker.ts` where you need background work and report env vars; append new env names to the END of `.env.example` only.
9. Run only your own tests: `npx vitest run tests/<yourfile> --pool=threads` (the default fork pool can crash in this environment), and filter tsc: `npx tsc --noEmit 2>&1 | grep -E "<your paths>"`. Other agents' files may be mid-edit.
10. UI must work at 360 px width, be keyboard operable, have labels on controls, and reuse `src/components/ui.tsx` primitives and the look of existing pages.

## Stub contracts (files already exist; replace the body, keep the exports)

| File | Owner agent | Exports |
|---|---|---|
| `src/lib/meta-connect/index.ts` | meta-connect | `getAssetAccess(tenantId, assetId)`, `listAssets(tenantId, type?)`, types `AssetType`, `AssetAccess`, `AssetSummary` |
| `src/lib/byo-mcp/index.ts` | byo-mcp | `listAllowedTools(tenantId)`, `callTool(tenantId, connectionId, toolName, args)`, type `McpToolInfo` |
| `src/lib/ads/actions.ts` | campaign-launcher | `pauseAd(tenantId, metaAdId)`, `setAdSetBudget(tenantId, metaAdSetId, dailyBudgetMinor)` both returning `{ revertPayload }` |
| `src/lib/conversions/index.ts` | conversions | `queueConversion(tenantId, { leadId?, contactId?, eventName, eventTime? })` |
| `src/lib/approvals/index.ts` | approvals | `createApproval`, `getApprovalByToken`, `decideApproval` and types |
| `src/lib/ai-agent/index.ts` | ai-agent | `handleInboundForAiAgent(input)` returns true when the AI consumed the message (the coordinator wires it after chatbots) |

Other hook points other agents rely on:
- `@/lib/chatbots`: `startChatbot`, `handleInboundForChatbots` (existing).
- `@/lib/inbox/service`: `sendText`, `sendTemplateMessage` (existing; they enforce the 24h window and opt-in).
- `@/lib/routing`: `assignConversation` (existing).
- `@/lib/integrations/events`: `emitEvent(tenantId, event, data)` (existing; add event names only by asking the coordinator).
- Lead status changes: lead-hub calls `queueConversion` when a lead becomes `qualified` or `won`.
- CTWA referral: the inbound webhook handler (coordinator) calls `captureReferral(tenantId, conversationId, referral)` exported by the conversions agent from `@/lib/conversions/referral`, which stores `Conversation.referral` once.

## Ownership (no overlaps; "UI" includes components and pages)

| Agent | Owns |
|---|---|
| ai-agent | `src/lib/ai-agent/**`, `src/app/api/ai-agent/**`, `src/components/ai-agent/**`, `src/app/(app)/app/automation/ai-agent/**`, `tests/ai-agent*.test.ts` |
| byo-mcp | `src/lib/byo-mcp/**`, `src/app/api/mcp-connections/**`, `src/components/byo-mcp/**`, `src/app/(app)/app/settings/ai-tools/**`, `tests/byo-mcp*.test.ts` |
| tenant-mcp | `src/lib/tenant-mcp/**`, `src/app/api/mcp/**`, `src/components/mcp/**`, `src/app/(app)/app/settings/mcp/**`, `tests/tenant-mcp*.test.ts` |
| api-compat | `src/lib/compat/**`, `src/app/api/ext/**`, `src/app/(site)/docs/**`, `tests/compat*.test.ts` |
| commerce | `src/lib/commerce/**`, `src/app/api/commerce/**`, `src/app/webhooks/shopify/**`, `src/components/commerce/**`, `src/app/(app)/app/commerce/**`, `tests/commerce*.test.ts` |
| meta-connect | `src/lib/meta-connect/**`, `src/app/api/meta-connect/**`, `src/components/meta-connect/**`, `src/app/(app)/app/settings/connections/**`, `tests/meta-connect*.test.ts` |
| campaign-launcher | `src/lib/ads/**` (except `src/lib/ads/insights*`), `src/app/api/ads/**` (except `src/app/api/ads/insights/**`), `src/components/ads/**` (except `src/components/ads/insights/**`), `src/app/(app)/app/ads/**` (except `src/app/(app)/app/ads/insights/**`), `tests/ads-*.test.ts` |
| lead-hub | `src/lib/leads/**`, `src/app/api/leads/**`, `src/app/webhooks/leads/**`, `src/components/leads/**`, `src/app/(app)/app/leads/**`, `tests/leads*.test.ts` |
| insights | `src/lib/ads/insights*`, `src/app/api/ads/insights/**`, `src/components/ads/insights/**`, `src/app/(app)/app/ads/insights/**`, `tests/insights*.test.ts` |
| optimizer | `src/lib/optimizer/**`, `src/app/api/optimizer/**`, `src/components/optimizer/**`, `src/app/(app)/app/ads/optimizer/**`, `tests/optimizer*.test.ts` |
| conversions | `src/lib/conversions/**`, `src/app/api/conversions/**`, `tests/conversions*.test.ts` |
| creative-studio | `src/lib/creative/**`, `src/app/api/creative/**`, `src/components/creative/**`, `src/app/(app)/app/creative/**`, `tests/creative*.test.ts` |
| content-calendar | `src/lib/content/**`, `src/app/api/content/**`, `src/components/content/**`, `src/app/(app)/app/content/**`, `tests/content*.test.ts` |
| approvals | `src/lib/approvals/**`, `src/app/api/approvals/**`, `src/app/approve/**`, `src/components/approvals/**`, `tests/approvals*.test.ts` |
| app-review-docs | `docs/app-review/**` only (documents, no code) |

Reports: files, endpoints and exports with shapes, env vars, tests and results, decisions, what is unfinished, and the nav entries wanted (path, title, minimum role).
