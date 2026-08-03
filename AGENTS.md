# Scout

These instructions apply only to this repository. Keep durable operator behavior here; keep credentials, production host values, local deploy notes, and one-off evidence out of tracked files.

## Sources Of Truth

- Product and operator overview: `README.md`.
- Agent skill source: `skills/scout-manual-workflow/SKILL.md`.
- Skill and command routing/provenance: `skills/README.md`.
- Active project command source: `.opencode/commands/scout.md`.
- Project-local OpenCode config: `.opencode/opencode.json`.
- API contract for clients and agent workflows: live `/api/docs/openapi.json`; do not copy endpoint payload schemas into docs or skills as canonical field lists.
- Development and verification commands: current `package.json`, `playwright.config.ts`, and repo scripts.
- Production/deploy examples and restrictions: `deploy/README.md`; KAFU-specific local notes are ignored operator files, not portable repo policy.

## Workflow

- Use `pnpm` scripts from the current `package.json`; do not invent parallel npm/yarn workflows.
- For `/scout` behavior, update the repo-owned skill and command. Verify or change an external projection only when the task explicitly includes maintaining it.
- Keep `/scout` as a thin entrypoint into `scout-manual-workflow`; lifecycle, status, endpoint, and evidence rules belong in the skill.
- Treat live OpenAPI as the only endpoint/method/body/response source. If docs or skills disagree with live OpenAPI, update the lower-level text instead of adding fallback clients.
- Production deploys require the documented GitHub Actions path from `master`; manual SSH deploy is not an automatic fallback.

## Verification

- For code changes, run the narrowest relevant check first, then the canonical repo check needed for the touched surface: `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, or `pnpm build`.
- For dashboard, widget, auth, route, or browser-state changes, verify with Playwright/browser evidence; API checks alone are not enough.
- For `/scout` workflow changes, verify frontmatter, trigger boundaries, command/skill sync, live OpenAPI assumptions, and the exact status/evidence path affected.

## Secrets

- Do not commit Scout API keys, JWTs, cookies, `.env` files with real values, screenshots/recordings with private data, production host secrets, or one-time codes.
- Use placeholders such as `<CHANGE-ME-*>` in tracked examples.
