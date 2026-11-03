export const meta = {
  name: 'build-ig-page-ads',
  description: 'Build Instagram and Facebook Page ads from docs/IG-PAGE-ADS-SPEC.md on top of the shipped spend controls and Eddy: plan waves, implement in parallel with tests, integrate, review, repair',
  phases: [
    { title: 'Plan', detail: 'order the 19 IG/Page ads work packages into waves of file-disjoint packages' },
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
- This build implements ${IG} (its section 11.1a decisions are final). Phase 0 spend controls (${SPEND}, incl. 12.1a and erratum 12.1b) and Eddy v1 (${EDDY}) are ALREADY BUILT in src: use their guard, ledger, approvals, action registry and cards; never bypass the guard; never call Meta writes outside it.
- Follow the specs exactly: ${IG}, ${SPEND} and ${EDDY}. Owner decisions inside them are fixed (Eddy: name "Eddy", in-app only, Hindi/English/Hinglish replies in the user's script, replies RICHLY STYLED never plain text: rendered markdown (bold, lists, tables, headings), action cards with buttons, status chips, preview/confirm cards with cost, undo bars, progress steps; spend controls: limits for EVERY workspace in settings AND in the admin panel, Level 0 default, probation INR 2,000/day and 20,000/month, worst case 1.75x/day and 7x/week, lowering spend always allowed, raising gated).
- Touch ONLY the files of your work package. Other developers edit other packages at the same time; re-read a file immediately before editing it. If you truly must touch a file outside your package, make the smallest additive change and report it.
- Never run next build, never start/stop/restart servers, never deploy, never commit, never touch .env files. Never call the real Anthropic or Meta APIs from tests: mock them.
- Every behaviour you add gets unit tests (vitest .test.ts, neighbouring tests show the mocking style). Copy is plain, in the product's voice, and says what the user should do. UI must be accessible (labels, focus, aria-live where status changes), work at 360px and in dark theme, and use the design-system components.
- Migrations are additive only (the live database has customer data). Money is integer minor units with an explicit currency.
- Finish with: npx tsc --noEmit (clean) and npx vitest run --pool=threads on your tests plus the existing tests that cover the files you changed. Report honestly.`

const AUTH = `OWNER AUTHORIZATION (read first): on 2026-10-28 the owner asked to start the Instagram and Facebook Page ads work in parallel ("can we parallely start on the instagram page ads as well") and earlier gave a standing instruction: "complete everything only then stop. develop, test, deploy everything before you stop ... you have all permissions and take the best possible decision for any situation yourself". That instruction is in force; later questions in the conversation (feature lists, status questions) were answered separately and do not cancel it. Your job in this run is to WRITE THE CODE AND TESTS for your package now. Files from an interrupted attempt may exist: inspect, keep what is correct, complete and fix; never duplicate.`

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
const plan = await agent(`${AUTH}

${RULES}

You are the lead engineer. Read ${IG} in full (sections 3-11, especially 10 Work packages and 11.1a), skim the built Phase 0 (src/lib/spend) and Eddy (src/lib/eddy, src/lib/actions or wherever the registry lives) code, the current schema and the latest migration number. Turn the spec's 19 work packages into waves:
- Wave 1 is a single foundation package that owns ALL schema/migration work for this spec (additive migrations numbered after the latest existing one; npx prisma generate), shared types and the capability catalog skeleton.
- Later waves: pairwise file-disjoint packages, ordered so the promote module and permits land before any UI that starts spend, and Eddy definitions after the services they wrap.
- Include Playwright specs for the new screens (written; the release manager runs them), unit tests with a mocked Graph client everywhere, and the sandbox runbook doc.
- Anything that needs the owner (sandbox assets, App Review screencasts, legal flags) goes to deferred with the reason; features behind flags still get built and tested.
Every package: precise file list, a brief citing spec sections, testable acceptance. 12-19 packages across 4-6 waves.`, { label: 'plan', phase: 'Plan', schema: WP_SCHEMA })

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
  ['ads-api-correctness', 'Marketing API usage against the spec section 4: exact paths and fields, PAUSED on campaign/adset/ad (creatives exempt per erratum P0-1), boost rules for Page posts and Instagram media, creative specs per placement, previews, lead forms, audiences hashing, A/B studies, insights breakdowns, throttling and error mapping to plain copy; Eddy definitions match the registry rules and risk classes.'],
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
