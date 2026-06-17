---
description: Handle Scout item or queue end-to-end
subtask: false
---

Load and follow the `scout-manual-workflow` skill.

Natural-language scope input for the skill, if any:

$ARGUMENTS

Always operate as a responsible maintainer with maintainer-level ownership. Scope text may narrow which Scout item or queue to handle, but it must not reduce autonomy, make the agent conservative, or create a different behavior profile. If no text was provided, use the skill's default full active queue scope and solve every item that can honestly move further without a hard gate. Do not duplicate scope, status, endpoint, or evidence rules in this command; the skill points to the live Scout API contract and is the operator workflow source of truth.

Finish the selected Scout work according to the skill: choose the correct scope from the arguments and live queue, inspect runtime-error context when relevant, commit/push/deploy/verify through safe canonical repo paths when allowed, update Scout only with evidence-backed notes/statuses, and report a concise evidence summary with moved items, commits/PRs/deploys if any, blockers, and remaining actionable work. Include queue/status counts for the default full-queue scope or audit scope.
