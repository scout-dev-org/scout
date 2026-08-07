<p align="center">
  <img src="https://img.icons8.com/fluency/96/bug.png" alt="Scout" width="80" />
</p>

<h1 align="center">Scout</h1>

<p align="center">
  <strong>Self-hosted bug tracking for AI-assisted product teams</strong><br/>
  Embeddable widget &middot; Screenshots and session replay &middot; Multi-language dashboard
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> &middot;
  <a href="#widget">Widget</a> &middot;
  <a href="#dashboard">Dashboard</a> &middot;
  <a href="#agent-skill">Agent Skill</a> &middot;
  <a href="#deployment">Deployment</a> &middot;
  <a href="#api">API</a>
</p>

---

## What is Scout?

Scout is a self-hosted tracker for teams that want high-quality bug reports and a clean handoff to humans or coding agents. Testers report bugs via an embeddable widget that captures element context, browser debug context, screenshots, and rrweb session recordings. While testing, they can also save lightweight notes without turning them into committed work. Runtime integrations can group operational errors and link them to normal Scout items. AI agents can triage actionable notes, inspect linked runtime error context, link related items, add comments, and move bugs/tasks through the workflow with evidence.

```
Tester clicks element  →  Widget creates bug with context + screenshot + recording
Tester saves note     →  Widget stores page-level observation without workflow work
                                ↓
                        API creates item (new): bug / note / task
                                ↓
                        AI triage converts useful notes → tasks
                                ↓
                        new → in_progress → review → done → verified
                                 ↑                       │
                                 └── changes_requested ←─┘
```

## Features

| Area | Details |
|------|---------|
| **Widget** | Bug-first reporting, optional non-bug notes, Shadow DOM isolation, element picker with instruction banner, html2canvas-pro screenshot with element highlight, structured browser debug context (60s rolling buffer), rrweb session recording (60s buffer), cross-domain SSO |
| **Dashboard** | React SPA, bug/note/task items, runtime error groups, manual creation, note-to-task triage, debug context viewer, rrweb session player with recording summary, items/projects/users/webhooks management, locale switcher |
| **i18n** | Russian, English, Uzbek (Latin). Dashboard + widget. Server error codes translated on client |
| **Agent workflows** | Manual agent skill for autonomous bug/task work, including AI triage that converts actionable notes into tasks, runtime error context handling, evidence-backed status updates, and safe non-production push/staging completion without background automation |
| **Notifications** | Daily per-user email digest over SMTP with concise counts for created items, status transitions, assignments, type changes, affected projects, and current statuses |
| **Auth** | JWT + API keys (`sk_live_*`), system roles (admin/member), project roles (owner/manager/developer/reporter/viewer), cross-domain SSO |
| **Infra** | Single process (API + SPA + widget on one port), SQLite, Docker, publishable GHCR image |

## Quickstart

### Docker

```bash
docker run -d \
  --name scout \
  -p 10009:10009 \
  -e SCOUT_JWT_SECRET=$(openssl rand -hex 32) \
  -e SCOUT_ADMIN_EMAIL=admin@example.com \
  -e SCOUT_ADMIN_PASSWORD='<CHANGE-ME-admin-password>' \
  -v scout-data:/app/data \
  -v scout-storage:/app/storage \
  ghcr.io/<your-org>/scout:master
```

Open http://localhost:10009 and sign in with the admin credentials from `SCOUT_ADMIN_EMAIL` / `SCOUT_ADMIN_PASSWORD`.

Local development auto-seeds `admin@scout.local` / `admin` and a demo project when the database is empty. **Never use default credentials outside local development.**

### From source

```bash
git clone https://github.com/scout-dev-org/scout.git && cd scout
pnpm install
pnpm db:seed     # create DB with test data
pnpm dev:all     # API + dashboard + widget (hot reload)
```

## Widget

```html
<script>
  window.__SCOUT_CONFIG__ = {
    apiUrl: 'https://your-scout.example',
    projectSlug: 'my-project',
  };
</script>
<script src="https://your-scout.example/widget/scout-widget.js" async></script>
```

The dashboard shows a ready-to-copy snippet for each project under **Projects** → **Manage integrations**.

**Bug reports capture:** CSS selector, element text/HTML, page URL, viewport size, browser/OS metadata, structured debug context (current page, navigation, user actions, console warnings/errors, fetch/XHR request summaries, performance timing), screenshot (with element highlight), rrweb session recording (last 60 seconds), and a compact rrweb recording summary for agents.

**Notes:** The widget stays bug-first, but the picker banner and panel include a secondary “not a bug” note flow. Notes save the current page context and structured debug context without requiring an element, priority, screenshot, or session recording. In the dashboard, humans or the Scout AI workflow can convert an actionable note into a task when the expected work is clear.

**SSO:** Users log in once — session shared across all sites via cookie (subdomains) or popup (cross-domain).

**Language:** Auto-detected from `navigator.language`. Supports `ru`, `en`, `uz`.

**Config options:**

| Option | Default | Description |
|--------|---------|-------------|
| `apiUrl` | — | Scout server URL (required) |
| `projectSlug` | — | Project slug (required) |
| `enabled` | `true` | Set `false` to hide. `?scout=1` in URL overrides |

## Dashboard

Responsive React SPA served from the same port as the API.

- **Items** — Bug/note/task list with human queue tabs (`Open`, `In Progress`, `Needs Review`, `Needs Acceptance`, `Accepted`, `Archived`), type/priority filters, search, pagination, manual creation, and note-to-task triage for humans or AI agents. Detail view with debug context, screenshot lightbox, rrweb session player plus recording summary, notes timeline, related items, linked runtime errors, resolve modal, and simple human verify/request-changes actions
- **Errors** — Runtime error groups with environment/service/fingerprint, route template, status/error classification, occurrence counts, auto-accepted `verified` linked Scout system item, and Grafana/Tempo context links when provided by integrations
- **Projects** — CRUD with allowed origins for CORS/SSO and links to per-project integrations
- **Users** — CRUD with system roles and per-project role assignment
- **Webhooks** — Per-project event notifications (Slack-compatible)
- **Language** — Switcher in sidebar (RU / EN / UZ)

## Roles And Permissions

Scout has two layers of access control:

| Layer | Values | Purpose |
|-------|--------|---------|
| System role | `admin`, `member` | Account type and global administration |
| Project role | `owner`, `manager`, `developer`, `reporter`, `viewer` | Per-project permissions |

System `admin` can access everything. Non-admin users get access through `projectRoles` on each project.

| Project role | Main permissions |
|--------------|------------------|
| `owner` | Full project management: project settings, members, integrations, item workflow/triage |
| `manager` | Triage items: update, cancel, reopen, delete, assign, verify, request changes, workflow |
| `developer` | Claim, update workflow status, resolve to `done`, comment, link related items |
| `reporter` | Create items, comment, view, cancel own `new` items |
| `viewer` | Read-only project access |

User APIs use `projectRoles` for per-project access assignment.

## Agent Skill

Scout ships the `scout-manual-workflow` agent skill and one thin command, `/scout`. The repository skill is the only authored owner; it selects single-item, queue, delivery, and explicit audit workflows from the user's arguments and live Scout state.

Both live in `.claude/` and load automatically for any agent session started inside this checkout. There is no projection, installer, or copied global copy to keep in sync: edit `.claude/skills/scout-manual-workflow/SKILL.md` and `.claude/commands/scout.md` in place.

Create an agent API key from the dashboard and store it in a password manager, shell environment, or local ignored `.env`, not in the repository.

## API

The live API contract at `/api/docs/openapi.json` is the single source of truth for clients, agent skills, and operator workflows. Use it for every endpoint method, URL, request body, allowed value, and response shape; do not preserve copied schema or payload details in documentation.

AI/operator completion requires inline acceptance evidence. Human acceptance is a separate explicitly authorized action. Discover both operations from the live contract rather than relying on cached paths or payload rules.

Interactive docs: `https://your-scout.example/api/docs`

## Deployment

### Docker Compose with HTTPS

Generic, non-production examples are available in `deploy/`. Keep real production compose files, `.env`, hostnames, SSH aliases, and server paths local and untracked.

```yaml
services:
  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data

  scout:
    image: ghcr.io/<your-org>/scout:master
    environment:
      - SCOUT_JWT_SECRET=${SCOUT_JWT_SECRET}
      - SCOUT_ADMIN_EMAIL=${SCOUT_ADMIN_EMAIL}
      - SCOUT_ADMIN_PASSWORD=${SCOUT_ADMIN_PASSWORD}
    volumes:
      - scout-data:/app/data
      - scout-storage:/app/storage

volumes:
  caddy_data:
  scout-data:
  scout-storage:
```

```
# Caddyfile
scout.example.com {
    reverse_proxy scout:10009
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SCOUT_JWT_SECRET` | dev secret | **Required in production** |
| `SCOUT_ADMIN_EMAIL` | — | Initial admin email when a production database has no users |
| `SCOUT_ADMIN_PASSWORD` | generated if omitted | Initial admin password when `SCOUT_ADMIN_EMAIL` is set |
| `SCOUT_PORT` | `10009` | Server port |
| `SCOUT_DB_PATH` | `data/scout.db` | SQLite database path |
| `SCOUT_CORS_ORIGINS` | — | Comma-separated allowed origins |
| `SCOUT_DASHBOARD_WIDGET_PROJECT_SLUG` | — | Optional project slug for dashboard-embedded widget config |
| `SCOUT_ERROR_BRIDGE_SECRET` | — | Shared secret required to enable the Alertmanager error bridge |
| `SCOUT_ERROR_BRIDGE_WORKER_ENABLED` | `true` | Set `false` to disable background processing of queued error bridge jobs |
| `SCOUT_ERROR_BRIDGE_WORKER_INTERVAL_MS` | `30000` | Error bridge worker interval |
| `SCOUT_ERROR_BRIDGE_BATCH_SIZE` | `20` | Error bridge jobs processed per worker tick |
| `SCOUT_ERROR_BRIDGE_MAX_ATTEMPTS` | `10` | Max delivery attempts before a bridge job is marked dead |
| `SCOUT_ERROR_SAMPLE_MAX_JSON_LENGTH` | `20000` | Max stored JSON length for error group sample payloads and trace diagnostics |
| `SCOUT_ERROR_REGRESSION_COOLDOWN_MS` | `1800000` | Minimum elapsed time before a recurring linked runtime error updates `lastRegressionAt`; it does not reopen or activate the linked Scout item |
| `SCOUT_GRAFANA_URL` | — | Viewer-accessible Grafana URL used to rewrite Alertmanager Prometheus generator links for dashboard users. If users should open links without a second login, configure Grafana/proxy anonymous Viewer access for that public URL; Scout does not embed Grafana credentials in links. |
| `SCOUT_GRAFANA_TEMPO_DATASOURCE` | `Tempo` | Grafana Tempo datasource name/UID used when Scout builds trace links |
| `SCOUT_TEMPO_URL` | — | Optional internal Tempo API base URL. When set, Alertmanager bridge jobs search matching traces by service/env/method/route/status and store trace diagnostics in error groups. |
| `SCOUT_TEMPO_SEARCH_WINDOW_MS` | `900000` | Time window around alert `startsAt` used for Tempo trace lookup |
| `SCOUT_TEMPO_TIMEOUT_MS` | `2000` | Per-request timeout for Tempo enrichment |
| `SCOUT_GRAFANA_PROXY_TARGET` | — | Optional internal Grafana upstream for same-origin `/grafana/...` links. Requests require a valid Scout session cookie and should point to an internal/protected Grafana URL, not a public credential-bearing URL. |
| `SCOUT_GRAFANA_PROXY_STRIP_PREFIX` | `false` | Set `true` only when the Grafana upstream is not configured with `/grafana` as its subpath. |
| `SMTP_HOST` | — | SMTP server for email notifications |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |
| `SMTP_FROM` | — | Sender email address |
| `SMTP_SECURE` | `true` for port `465`, otherwise `false` | Use implicit TLS for SMTP |
| `SCOUT_PUBLIC_URL` | — | Public Scout URL included in notification emails |
| `SCOUT_DAILY_DIGEST_ENABLED` | `true` when SMTP is configured | Set `false` to disable daily email digests |
| `SCOUT_DAILY_DIGEST_TIME` | `18:00` | Local send time for daily digests, `HH:mm` |
| `SCOUT_DAILY_DIGEST_TIMEZONE` | `Asia/Almaty` | Time zone used for "today" and send time |
| `LOG_LEVEL` | `info` | Pino log level |

### CI/CD

Push to `dev` → typecheck + tests.

Push to `master` → typecheck + tests → Docker build + publish to GHCR → Deploy workflow when production Environment variables/secrets are configured.

The repository also includes a generic GitHub Actions deploy workflow. It is safe for forks because all production-specific hosts, paths, SSH keys, and health URLs come from GitHub Environment secrets/variables, not from tracked files. Operators may also deploy the published image manually using the examples in `deploy/`.

### Backup

```bash
docker cp scout:/app/data/scout.db ./backup/scout-$(date +%Y%m%d).db
```

## Development

```bash
pnpm dev          # API server (port 10009)
pnpm dev:all      # API + dashboard + widget (hot reload)
pnpm test         # unit tests (Vitest)
pnpm test:e2e     # E2E tests (Playwright — chromium/firefox/webkit)
pnpm typecheck    # TypeScript check
pnpm build        # production build
pnpm db:seed      # seed database with test data
pnpm db:generate  # generate DB migration after schema change
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| API | Hono, Drizzle ORM, better-sqlite3, Zod |
| Dashboard | React 19, Tailwind CSS 4, Vite 6 |
| Widget | Vanilla TS, html2canvas-pro, rrweb, fflate |
| Auth | JWT, bcrypt, API keys |
| Tests | Vitest (unit), Playwright (E2E) |
| Deploy | Docker, GHCR, Caddy |

## License

MIT
