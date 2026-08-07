# Scout Agent Skill

`scout-manual-workflow` is authored here and nowhere else. It loads automatically
in any agent session started inside this checkout, together with the thin
`/scout` command in `.claude/commands/scout.md`.

- Change behavior in `scout-manual-workflow/SKILL.md` and its `references/`.
- Keep `/scout` a thin entrypoint: lifecycle, status, endpoint, and evidence
  rules belong in the skill.
- Restart the agent session after changing the skill or the command; a running
  session keeps the already-loaded copy.
