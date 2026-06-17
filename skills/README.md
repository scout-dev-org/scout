# Scout Skills

This directory contains the canonical agent skills for working with Scout. Skills describe operator behavior. The only API contract is live OpenAPI at `$SCOUT_URL/api/docs/openapi.json`.

## `scout-manual-workflow`

Use this skill when an AI coding agent should take Scout work and handle it manually like a professional engineer: triage, reproduce, diagnose, inspect linked runtime error context and browser `debugContext`/`recordingSummary` when present, use rrweb session replay as DOM/event evidence when needed, fix, verify, commit/push/deploy through safe canonical non-production paths when allowed, update Scout notes/statuses, and handle related or duplicate items without asking for routine workflow choices.

## OpenCode Commands

Scout ships one OpenCode slash command in `.opencode/commands/`: `/scout`. It is a thin entrypoint into `scout-manual-workflow`; keep lifecycle rules in the skill and let the agent infer full active queue, single-item, single-next, needs-review follow-up, changes-requested follow-up, runtime-error follow-up, or done/verified audit scope from arguments and live queue state. Every invocation uses maintainer-level ownership; arguments choose scope, not a weaker behavior profile. With no arguments, `/scout` defaults to full active queue scope and solves every item that can honestly move further.

The workflow is schema-aware: `review` and `done` transitions require structured evidence with `environment`, `result`, `level`, `coverage`, `scenario`, `action`, `visibleResult`, and item-specific `acceptanceScope`. For `review`, put the real commit SHA in evidence; use `mrUrl` only for a real PR/MR URL. `done` means AI/operator work is ready for human acceptance via `/api/items/verify`.

Widget-created items may include `debugContext`, which stores the captured page, navigation, user actions, console warnings/errors, failed/slow network summaries, performance timing, and a compact rrweb `recordingSummary`. The `/scout` workflow should inspect those structured fields before downloading a full rrweb recording; open the dashboard player or parse the recording JSON only when the bug depends on path, timing, navigation, redirects, or missing context.

Human queue tabs are status groups, not separate states: `Open` = `new`, `In Progress` = `in_progress`, `Needs Review` = `review` + `changes_requested`, `Needs Acceptance` = `done`, `Accepted` = `verified`, and `Archived` = `cancelled`.

The command works without arguments and defaults to full active queue scope. Text after `/scout` is natural-language scope input: it may identify an item, project, branch, deploy target, single-next work, full-queue work, needs-review follow-up, changes-requested follow-up, runtime-error follow-up, or done/verified audit behavior. Arguments are not a structured subcommand API.

## Developer linked setup

Installed `/scout` works without a local Scout repository clone when the command, skill, and Scout API credentials (`SCOUT_URL`, `SCOUT_PROJECT_ID`, `SCOUT_API_KEY`) are present. The workflow must use live OpenAPI as its only API contract.

When running OpenCode from this repository, no skill installation is required. `.opencode/opencode.json` loads `skills/`, and `.opencode/commands/scout.md` provides `/scout` from the checkout.

If you develop Scout and need `/scout` outside this repository, link your global OpenCode paths to this checkout once instead of reinstalling after every edit:

```bash
repo=/path/to/scout
mkdir -p "$HOME/.config/opencode/commands" "$HOME/.config/opencode/skills"
ln -sf "$repo/.opencode/commands/scout.md" "$HOME/.config/opencode/commands/scout.md"
if [ -e "$HOME/.config/opencode/skills/scout-manual-workflow" ] || [ -L "$HOME/.config/opencode/skills/scout-manual-workflow" ]; then
  mv "$HOME/.config/opencode/skills/scout-manual-workflow" "$HOME/.config/opencode/scout-manual-workflow.backup-$(date +%Y%m%d%H%M%S)"
fi
ln -s "$repo/skills/scout-manual-workflow" "$HOME/.config/opencode/skills/scout-manual-workflow"
if [ -e "$HOME/.agents/skills/scout-manual-workflow" ] || [ -L "$HOME/.agents/skills/scout-manual-workflow" ]; then
  mv "$HOME/.agents/skills/scout-manual-workflow" "$HOME/.agents/scout-manual-workflow.backup-$(date +%Y%m%d%H%M%S)"
fi
```

Restart OpenCode after changing linked commands, skills, or OpenCode config. Do not run `npx skills update` as the local development sync mechanism.

## Released install/update

Normal users should install the released command globally from a Scout checkout:

```bash
./scripts/install-opencode-commands.sh
```

By default this copies commands to `~/.config/opencode/commands`. Override the target with `OPENCODE_COMMANDS_DIR=/path/to/commands` if needed. Restart OpenCode after installing or updating commands.

Install the released skill globally from GitHub:

```bash
npx skills add scout-dev-org/scout --skill scout-manual-workflow --full-depth -g -y
```

Install the released skill into the current project instead:

```bash
npx skills add scout-dev-org/scout --skill scout-manual-workflow --full-depth -p -y
```

Update a released global install later:

```bash
npx skills update scout-manual-workflow -g -y
```

If installed project-locally, update from that project:

```bash
npx skills update scout-manual-workflow -p -y
```

List released skills available from GitHub without installing:

```bash
npx skills add scout-dev-org/scout --list --full-depth
```

Required runtime configuration is intentionally not stored in this repository. Set it in your shell, local `.env`, or another private credential store.

Create the key from Scout: `Projects` → target project → `Manage integrations` → `Create agent key`. Scout shows the full key and a ready-to-copy env block once.

For a shell session, use `export`:

```bash
export SCOUT_URL="https://your-scout.example"
export SCOUT_API_KEY="<CHANGE-ME-sk_live-api-key>"
export SCOUT_PROJECT_ID="<CHANGE-ME-project-id>"
```

For a dotenv file, omit `export`:

```dotenv
SCOUT_URL=https://your-scout.example
SCOUT_API_KEY=<CHANGE-ME-sk_live-api-key>
SCOUT_PROJECT_ID=<CHANGE-ME-project-id>
```

If you load a dotenv file with plain shell `source`, export variables before launching the agent:

```bash
set -a
source .env
set +a
opencode
```

Do not commit Scout API keys, cookies, JWTs, or environment files with real credentials.

For runtime error group work, the agent key also needs the relevant `errors:*` scopes. Use `errors:read` for linked error inspection, `errors:triage` for ignore/unignore actions, and `errors:write` only for ingestion/upsert automation. The Alertmanager bridge shared secret is server-side integration material, not a normal manual-agent credential.
