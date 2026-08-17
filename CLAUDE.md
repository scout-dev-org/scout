# Scout

Self-hosted bug tracker: Hono API, SQLite, React dashboard and embeddable widget, all served by one process on port 10009.

## Layout

- `server/` - API: `routes/`, `services/`, `middleware/`, `db/` (Drizzle schema, client, seed).
- `dashboard/` - React SPA served from `dashboard/dist`; UI strings in `dashboard/src/i18n` (ru/en/uz - every key goes into all three).
- `widget/` - vanilla TS widget with its own `src/i18n.ts`, served from `widget/dist` under `/widget/`.
- `test/` Vitest API tests, `e2e/` Playwright specs, `drizzle/` generated migrations, `deploy/` generic deploy examples only.

## Rules

- `pnpm` only, scripts from `package.json`.
- Live `/api/docs/openapi.json` is the only API contract for clients, docs and agent workflows. When any text disagrees with it, fix the text instead of adding a fallback client, and never copy payload schemas in as canonical field lists.
- Schema change: edit `server/db/schema.ts`, then `pnpm db:generate`. The local database is disposable - reseed instead of adding corrective migrations.
- Production deploys run only through the GitHub Actions deploy workflow from `master`; manual SSH deploy needs explicit approval for that incident.
- Keep `/scout` a thin entry into `.claude/skills/scout-manual-workflow`; scope, transition and evidence rules belong to the skill.
- Real hosts, compose files, credentials and one-off evidence stay out of tracked files.

## Verification

- `pnpm typecheck`, then `pnpm test` for server/API work and `pnpm test:e2e` for cross-surface flows.
- Dashboard, widget, auth, routing or browser-state changes need Playwright/browser evidence; API checks alone are not enough.
