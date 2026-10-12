# Scout

Self-hosted bug tracker: Hono API, SQLite, React dashboard and embeddable widget, all served by one process. The project owns ports 10020-10029: 10020 serves API, SPA and widget; 10021 is the dashboard dev server.

## Layout

- `server/` - API: `routes/`, `services/`, `middleware/`, `db/` (Drizzle schema, client, seed).
- `dashboard/` - React SPA served from `dashboard/dist`; UI strings in `dashboard/src/i18n` (ru/en/uz - every key goes into all three).
- `widget/` - vanilla TS widget with its own `src/i18n.ts`, served from `widget/dist` under `/widget/`.
- `test/` Vitest API tests, `e2e/` Playwright specs, `drizzle/` generated migrations, `deploy/` example configs only.

## Rules

- `pnpm` only.
- Live `/api/docs/openapi.json` is the only API contract for clients, docs and agent workflows. When any text disagrees with it, fix the text instead of adding a fallback client, and never copy payload schemas in as canonical field lists.
- Schema change: edit `server/db/schema.ts`, then `pnpm db:generate`. Production runs every migration on `master` at startup, so a migration that reached `master` is never edited.
- A push to `master` builds the image (Docker workflow) and deploys it to production (Deploy workflow); that is the only production deploy path, and a manual SSH deploy needs explicit approval for that incident.
- Keep `/scout` a thin entry into `.claude/skills/scout-manual-workflow`; scope, transition and evidence rules belong to the skill.
- Real hosts and compose files stay out of tracked files: `deploy/` keeps `*.example.*` only.

## Verification

- `pnpm typecheck`, then `pnpm test` for server/API work and `pnpm test:e2e` for cross-surface flows.
- Dashboard, widget, auth, routing or browser-state changes need browser evidence; API checks alone are not enough.
