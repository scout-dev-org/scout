# Scout Skills

## Source Of Truth

`skills/scout-manual-workflow/` in this repository is the only authored owner of the Scout operator skill. Its `SKILL.md` contains the compact execution contract; `references/` contains agent-specific workflows that the skill loads only for matching scopes.

The live contract at `$SCOUT_URL/api/docs/openapi.json` is the only source for API paths, methods, request fields, allowed values, and responses. Do not copy schemas, enum catalogs, or payload recipes into the skill, references, commands, or docs.

## Active Projections

| Surface | Source | Projection/update path |
|---|---|---|
| Project skill | `skills/scout-manual-workflow/` | `.opencode/opencode.json` loads the repo `skills` path directly |
| Project command | `.opencode/commands/scout.md` | Loaded directly from this checkout |
| Developer global skill | Repo skill directory | `~/.config/opencode/skills/scout-manual-workflow` is a symlink to the repo owner |
| Global command | Repo command file | `scripts/install-opencode-commands.sh` copies it one way into the configured global command directory |

There is no second authored or bidirectionally synchronized skill. A copied `scout-manual-workflow` installed by `npx skills` under `~/.agents/skills`, project agent-skill directories, or the OpenCode global skill directory is stale and unsupported; remove that copy before creating the developer symlink. Do not run `npx skills update` for this skill.

## Developer Projection

For OpenCode launched inside this repository, no projection or installation is needed.

For development use outside the checkout:

1. Remove any existing copied or vendor-installed `scout-manual-workflow` from OpenCode and external agent skill locations so it cannot compete with the repo owner.
2. Create `~/.config/opencode/skills/scout-manual-workflow` as a symlink to `<SCOUT_REPO>/skills/scout-manual-workflow`.
3. Install the global command copy from the checkout:

```bash
./scripts/install-opencode-commands.sh
```

Set `OPENCODE_COMMANDS_DIR=<COMMANDS_DIR>` only when the global command target differs from `~/.config/opencode/commands`.

The skill and command symlinks reflect repo edits immediately on the next OpenCode start. Never edit a global link target and sync it back into the repository; change the authored files in this checkout and let the runner installer verify the links.

Restart OpenCode after changing the skill, references, command, or `.opencode/opencode.json`; the running process retains already-loaded configuration and skill context.

## Runtime Configuration

Provide `SCOUT_URL`, `SCOUT_PROJECT_SLUG`, and `SCOUT_API_KEY` through the shell, an ignored local `.env`, or another private credential store. Keep real credentials out of this repository and durable Scout notes.

The skill fetches live OpenAPI at the start of each run. `/items/resolve` remains the canonical AI/operator completion path, while human acceptance remains a separate explicitly authorized action discovered from the live contract.
