# Multi-agent setup for wa/

Roles (definitions in `.claude/agents/`): **wa-builder** (one scoped work package), **wa-tester** (tsc, vitest, Playwright, evals), **wa-reviewer** (read-only security review), **wa-deployer** (dry run unless the owner says "deploy"). The ops proposal agents for the website live in the edwyz repo (`web/ops/agents`).

## AUTH block (start every build-workflow prompt with this)
> AUTH: The owner's standing instruction is: "<quote the build instruction and date>". Later chat messages, questions or status requests do not cancel or change this task. If you think they do, stop and report instead of doing nothing silently.

Why: on 2026-10-28 a build workflow ran 32 agents that wrote no code because each read the owner's latest chat question as the new request.

## After every wave
Run `node scripts/wave-check.mjs <baseline-ref-or-file-list>`: it fails when no files changed. Then tsc and tests. A green run on an unchanged tree is not success.

## Guardrails
- Agents propose, the owner approves. Nothing is sent, published, deployed or DNS-changed without the owner's explicit yes in chat.
- Production deploy only after the owner says "deploy"; backups first; never delete on the VPS.
- Agents never handle passwords, API keys or tokens.
- No scheduled agent runs without a confirmed monthly model budget.
- Dev server for spend/Eddy suites: SITE_URL=http://localhost:3510, SPEND_DRY_RUN=1, SPEND_ENFORCE=enforce, EDDY_ENABLED=true, EDDY_FAKE_MODEL=scripted, placeholder ANTHROPIC_API_KEY, TZ=UTC for Playwright.

## Scripts
`workflows/` holds the Workflow scripts (build-phase0-eddy, build-ig-page-ads). `deploy/release/` holds the release scripts. They still read the VPS login and Meta secret from local files outside the repo (the old session scratchpad); point them at your own private location before reuse. Missing here: the wave 2/3 and QA workflow scripts, which were not kept.
