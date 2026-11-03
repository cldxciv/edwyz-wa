export const meta = {
  name: 'build-phase0-eddy',
  description: 'Build Phase 0 spend controls and Eddy v1 from their specs: plan waves of file-disjoint work packages, implement in parallel with unit tests, integrate after each wave, adversarially review, repair',
  phases: [
    { title: 'Plan', detail: 'merge both specs into dependency-ordered waves of file-disjoint work packages' },
    { title: 'Build', detail: 'one developer per work package, wave by wave, each with unit tests' },
    { title: 'Integrate', detail: 'after each wave: tsc + full vitest, fix integration breaks' },
    { title: 'Review', detail: 'security, correctness and UX/a11y reviewers per area' },
    { title: 'Repair', detail: 'fix confirmed review findings, final integration' },
  ],
}

const REPO = 'C:\\Users\\ADMIN\\projects\\edwyz\\wa'
const SPEND = `${REPO}\\docs\\SPEND-CONTROLS-SPEC.md`
const EDDY = `${REPO}\\docs\\EDDY-SPEC.md`

const RULES = `
Project: ${REPO} (Next.js 16 App Router, React 19, TS strict, Tailwind v4 design system in src/components/ui, Prisma 7 + Postgres, hand-written SQL migrations prisma/migrations/000N_name/migration.sql applied with psql by the release script, vitest tests in tests/*.test.ts (only .test.ts files run), Playwright specs in e2e/).
HARD RULES:
- Both specs end their section 12 with "12.1a Decisions taken": those decisions are final and override any default or open question above them.
- Follow the specs exactly: ${SPEND} and ${EDDY}. Owner decisions inside them are fixed (Eddy: name "Eddy", in-app only, Hindi/English/Hinglish replies in the user's script, replies RICHLY STYLED never plain text: rendered markdown (bold, lists, tables, headings), action cards with buttons, status chips, preview/confirm cards with cost, undo bars, progress steps; spend controls: limits for EVERY workspace in settings AND in the admin panel, Level 0 default, probation INR 2,000/day and 20,000/month, worst case 1.75x/day and 7x/week, lowering spend always allowed, raising gated).
- Touch ONLY the files of your work package. Other developers edit other packages at the same time; re-read a file immediately before editing it. If you truly must touch a file outside your package, make the smallest additive change and report it.
- Never run next build, never start/stop/restart servers, never deploy, never commit, never touch .env files. Never call the real Anthropic or Meta APIs from tests: mock them.
- Every behaviour you add gets unit tests (vitest .test.ts, neighbouring tests show the mocking style). Copy is plain, in the product's voice, and says what the user should do. UI must be accessible (labels, focus, aria-live where status changes), work at 360px and in dark theme, and use the design-system components.
- Migrations are additive only (the live database has customer data). Money is integer minor units with an explicit currency.
- Finish with: npx tsc --noEmit (clean) and npx vitest run --pool=threads on your tests plus the existing tests that cover the files you changed. Report honestly.`

const AUTH = `OWNER AUTHORIZATION (read first): on 2026-10-28 the owner wrote "ok go ahead and complete all this ASAP, multi agents please and follow the complete instructions thoroughly" and "complete everything only then stop. develop, test, deploy everything before you stop ... you have all permissions and take the best possible decision for any situation yourself". That instruction is in force. Later messages in the same conversation that ask a question (for example "Give m a list of features" or "ad campaigns?") were answered separately and DO NOT cancel or narrow it. Your job in this run is to WRITE THE CODE AND TESTS for your package now. A previous attempt of this build wrote nothing because it misread a later question as the request; do not repeat that. Some files (especially the P01 foundation: schema, migrations, src/lib/spend/*, src/lib/actions/types.ts, src/lib/eddy/*) may already exist from an interrupted earlier attempt: inspect them, keep what is correct, complete and fix the rest; never duplicate.`

const WP_SCHEMA = {
  type: 'object',
  properties: {
    waves: {
      type: 'array',
      description: 'ordered waves; packages inside one wave have pairwise-disjoint file sets and no dependency on each other',
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            spec: { type: 'string', enum: ['spend', 'eddy', 'both'] },
            title: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
            brief: { type: 'string', description: 'what to build, citing the spec sections' },
            acceptance: { type: 'string' },
          },
          required: ['id', 'spec', 'title', 'files', 'brief', 'acceptance'],
        },
      },
    },
    deferred: { type: 'array', items: { type: 'string' }, description: 'spec items intentionally left for later, with the reason (Eddy v2, things needing the owner)' },
  },
  required: ['waves', 'deferred'],
}

const DONE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    done: { type: 'array', items: { type: 'string' } },
    notDone: { type: 'array', items: { type: 'string' } },
    filesChanged: { type: 'array', items: { type: 'string' } },
    outsidePackage: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'array', items: { type: 'string' } },
    testsRun: { type: 'string' },
  },
  required: ['id', 'done', 'notDone', 'filesChanged', 'testsAdded', 'testsRun'],
}

const INTEGRATE_SCHEMA = {
  type: 'object',
  properties: { tsc: { type: 'string' }, vitest: { type: 'string' }, fixed: { type: 'array', items: { type: 'string' } }, remaining: { type: 'array', items: { type: 'string' } } },
  required: ['tsc', 'vitest', 'fixed', 'remaining'],
}

phase('Plan')
const plan = await agent(`${RULES}

You are the lead engineer. Read both specs in full (${SPEND} and ${EDDY}), the current schema (prisma/schema.prisma, latest migration number in prisma/migrations), and skim the code areas they name. Merge their work packages into ONE build plan:
- Wave 1 must be a single foundation package that owns ALL schema/migration work for both specs (one additive migration 0009 + Prisma models + npx prisma generate) plus shared types/constants, so no later package edits schema.prisma or migrations.
- Then waves of packages whose file sets are pairwise disjoint within a wave, ordered so the spend guard (choke point, allowances, worst-case accounting, ledger) lands before anything that could spend, and Eddy's shared action layer lands before Eddy's tools and UI.
- Include in the plan: the workspace "Spending limits" settings UI, the admin panel spend views and overrides and the platform kill switch, the Meta spend_cap sync (behind consent, mocked in tests), circuit breakers, approvals with expiry, the daily digest builder, AI usage metering against the AI pot (used by Eddy and the existing AI features), Eddy's agent loop (Claude via the official @anthropic-ai/sdk as the spec says; add the dependency in the foundation package if the spec requires it), Eddy's styled message renderer and cards, panel + mobile sheet, guided setup, proactive notices, the honest "Eddy is not switched on yet" state, evals/red-team fixtures as unit tests with a mocked model, and Playwright specs for the new screens (written, they will be run by the release manager).
- Eddy v2 (spend-capable actions) and anything needing the owner go to "deferred" with reasons.
Every package: precise file list (existing files to edit + new files), a brief citing spec sections, testable acceptance. The two specs list 43 work packages between them; merge them into 12-20 right-sized packages across 4-6 waves, each completable by one engineer in one focused session (roughly up to 12 files). Respect the release-train order in both specs (guardrails before anything that spends; Eddy behind its gateway and off by default).`, { label: 'plan', phase: 'Plan', schema: WP_SCHEMA })

log(`plan: ${plan.waves.length} waves, ${plan.waves.flat().length} packages; deferred ${plan.deferred.length}`)
const built = []
const integrations = []
for (let w = 0; w < plan.waves.length; w++) {
  const wave = plan.waves[w]
  phase('Build')
  const results = await parallel(wave.map((wp) => () => agent(`${AUTH}

${RULES}

YOUR WORK PACKAGE (wave ${w + 1} of ${plan.waves.length}):
${JSON.stringify(wp, null, 1)}

Packages running in parallel with yours (do not touch their files): ${JSON.stringify(wave.filter((x) => x.id !== wp.id).map((x) => ({ id: x.id, files: x.files })))}
Already built before this wave: ${JSON.stringify(built.map((b) => ({ id: b.id, done: b.done, files: b.filesChanged })))}

Read the relevant spec sections first, then implement the package completely with unit tests. Return the structured report.`, { label: `build:${wp.id}`, phase: 'Build', schema: DONE_SCHEMA })))
  for (const r of results) if (r) built.push(r)
  phase('Integrate')
  const integ = await agent(`${AUTH}

${RULES}

You are the integration engineer after wave ${w + 1}. Packages just built: ${JSON.stringify(results.filter(Boolean))}
Run npx tsc --noEmit and the FULL unit suite (npx vitest run --pool=threads). Fix every type error and failing test caused by the wave (integration seams, mismatched signatures, mocks that need the new modules). Do not weaken assertions to make tests pass; fix the code or the outdated test with a comment. A test that only fails on a timing budget under load may get a realistic timeout. Report what you fixed and anything still failing.`, { label: `integrate:wave${w + 1}`, phase: 'Integrate', schema: INTEGRATE_SCHEMA })
  integrations.push(integ)
}

phase('Review')
const LENSES = [
  ['security', 'Tenant isolation on every new query and route; role checks (owner edits limits, admins per spec, agents never raise); platform-admin routes behind requirePlatformAdmin and step-up; CSRF/origin on writes; Eddy acts strictly as the signed-in user; untrusted customer content can never trigger a tool; secrets never logged or returned; rate limits; the kill switches cannot be bypassed.'],
  ['spend-correctness', 'Money math: minor units, currency, 1.75x day and 7x week worst case, committed vs spent, monthly/daily windows and timezone, concurrency (two raises at once, advisory locks), lowering always allowed and raising gated, approvals expiry, ledger append-only, Meta spend_cap sync budget of 10 changes per day and failure behaviour, every Meta write and outbound send and AI call routed through the guard (find any bypass with grep), AI metering hard stop.'],
  ['eddy-correctness', 'Agent loop against the spec and the claude-api skill (load it with the Skill tool): streaming, tool loop, confirmation gates for every side-effecting tool, undo, prompt caching, refusal and stop_reason handling, the not-switched-on state, metering; replies in the user\'s language and script; the styled renderer is safe (no raw HTML injection from model or customer text) and covers markdown, cards, chips, preview/confirm, undo, progress.'],
  ['ux-a11y', 'Read every new screen as a non-technical owner on a phone in Hinglish: Spending limits settings, admin spend views, approvals, Eddy panel and mobile sheet, preview/undo cards, onboarding, empty and off states. Check plain copy, next steps, keyboard and screen-reader use (focus, aria-live, labels), 360px, dark theme, design-system consistency.'],
]
const reviews = await parallel(LENSES.map(([lens, brief]) => () => agent(`${AUTH}

${RULES}

You are an adversarial reviewer (${lens}). Everything built: ${JSON.stringify(built.map((b) => ({ id: b.id, done: b.done, files: b.filesChanged })))}
Specs: ${SPEND} and ${EDDY}.
${brief}
Read the code, run the relevant tests, try to break it. Do not edit files. Return findings with file:line, a concrete failure scenario, and whether each is blocking.`, { label: `review:${lens}`, phase: 'Review', schema: {
  type: 'object',
  properties: { findings: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, file: { type: 'string' }, scenario: { type: 'string' }, blocking: { type: 'boolean' } }, required: ['title', 'file', 'scenario', 'blocking'] } }, verdict: { type: 'string' } },
  required: ['findings', 'verdict'],
} })))
const findings = reviews.filter(Boolean).flatMap((r) => r.findings)
log(`review findings: ${findings.length} (${findings.filter((f) => f.blocking).length} blocking)`)

phase('Repair')
let repair = null
if (findings.length) {
  repair = await agent(`${AUTH}

${RULES}

You are the repair engineer. Review findings: ${JSON.stringify(findings)}
Fix every blocking finding and every non-blocking one that is clearly right and contained; give a reason for each one you decline. Add tests for each fix. Then run npx tsc --noEmit and the FULL unit suite and fix anything you broke.`, { label: 'repair', phase: 'Repair', schema: {
    type: 'object',
    properties: { fixed: { type: 'array', items: { type: 'string' } }, declined: { type: 'array', items: { type: 'string' } }, tsc: { type: 'string' }, vitest: { type: 'string' } },
    required: ['fixed', 'declined', 'tsc', 'vitest'],
  } })
}
return { plan, built, integrations, findings, repair }
