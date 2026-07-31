---
name: scout-manual-workflow
description: Use only when the user explicitly invokes `/scout` or asks to take, handle, fix, resume, continue, inspect, check status, triage, review, or audit work from Scout. Do not trigger for incidental Scout mentions or ordinary repository work.
---

# Scout Manual Workflow

## Purpose

Own the selected Scout work end-to-end as one engineering operator: understand intent, inspect live evidence, diagnose the real behavior, make the smallest complete change, verify the acceptance path, and leave evidence-backed Scout state and a concise handoff.

This is a manual command workflow, not a daemon. Do not continuously poll Scout for new work, start a background queue worker, or touch unrelated Scout work. Bounded waiting for an operation already started is allowed.

## Non-Negotiable Contract

- Keep the `/scout` command session as the single owner of scope, implementation decisions, Scout mutations, transitions, and the final result. Delegate only independent read-only discovery or verification; subagents never mutate Scout state.
- Follow the target repository's current `AGENTS.md`, docs, scripts, branch policy, and safety rules. Preserve unrelated worktree changes.
- At the start of each run, fetch `$SCOUT_URL/api/docs/openapi.json`. It is the only contract for API paths, methods, request fields, allowed values, and responses. Never rely on remembered or copied API shapes.
- Read Scout access from the environment, then the current workspace's ignored `.env` when present. Keep credentials out of tracked files and durable Scout notes; follow the global private-session policy for local use and user-requested values.
- Build decisions from the full current item, related work, available artifacts, repository behavior, and fresh runtime evidence. Treat old notes and summaries as hints.
- Use scoped disposable non-production fixtures when ordinary missing data, content, uploads, roles, or state would otherwise block acceptance. Clean up or restore them when safe; otherwise record exactly what remains and why.
- Before every Scout transition, verify its current live-contract preconditions and attach item-specific evidence that proves the claimed outcome. If the evidence is insufficient, keep the honest current state and record the exact blocker.
- Discover the current AI/operator completion operation and required evidence from live OpenAPI; complete only with item-specific passing acceptance evidence and no preparatory transitions merely to make completion legal.
- AI/operator completion and human acceptance are separate. Never perform the human acceptance action unless the user explicitly grants that decision; use the live contract to discover its current operation.
- Use the target repository and global Git policy for routine commit/push. Apply the Hard Gates below to deploy, production, protected-target, live-money, irreversible provider, human-facing, and human-acceptance actions.

## Scope Selection

Choose scope without asking routine questions:

1. An item id or Scout item URL selects that item. Include another item only when current evidence proves a shared root cause or direct dependency.
2. Bare `/scout`, "next", "one", or equivalent wording selects one best actionable item or one cohesive shared-root cluster.
3. Only explicit "all", "full queue", or equivalent wording selects the full queue. Freeze the initial candidate population plus evidence-backed dependencies so newly arriving work cannot make the run unbounded.
4. A project, branch, target, queue, or item class filters candidates and selects one best actionable item unless the user explicitly requests all matching work.
5. Completed or human-accepted work is out of normal scope. Recheck it only when the user explicitly requests an audit, regression check, reopen, or acceptance review.
6. Explicit `inspect`, `status`, or lookup wording is read-only unless the user also asks to fix, handle, or transition the work.
7. Explicit `resume` or `continue` wording resumes the one unambiguous active item owned by this operator; otherwise apply the normal single-item selection rule instead of guessing among several active items.

## Reference Router

Read only the references needed for the selected scope:

- Read `references/queue-and-triage.md` for any queue-selected run, note triage, prioritization, duplicate search, dependency handling, or shared-root clustering.
- Read `references/delivery-and-evidence.md` for every item that may lead to code changes, verification, a Scout transition, review follow-up, runtime-error investigation, browser evidence, or a provider/deploy action.
- Read `references/audit-and-batch.md` only for explicit audits of completed work, broad route/role sweeps, large batches, or work that needs a resumable ledger.

For a single read-only item lookup, remain in this core unless the request expands into triage, delivery, transition, or audit work.

## Execution Loop

1. Resolve the requested project and scope through live OpenAPI, then fetch each candidate's current full record before acting.
2. Build an internal readiness view: intent, ownership, related work, affected repository, acceptance path, available evidence, safety gates, and furthest honest outcome.
3. Reproduce or gather the nearest practical evidence, trace the affected flow to its root cause, and inspect adjacent behavior only where shared code, safety, or acceptance requires it.
4. Implement the smallest complete solution in the correct layer. Avoid unrelated cleanup, dependency churn, and speculative product expansion.
5. Run the repository's narrow relevant checks and fresh runtime verification. User-visible work requires browser verification of the reported journey when feasible.
6. Record concise Scout notes and structured evidence at meaningful milestones, then perform only transitions supported by that evidence and the live contract.
7. In explicit full-queue scope, refresh after meaningful mutations or discoveries and continue through the frozen item IDs. Keep notes, evidence, and transitions item-specific even when one fix covers a cluster.

## Hard Gates

Ask the user only when progress requires:

- missing access that cannot be discovered or obtained through the available workspace and tools;
- a destructive or irreversible action involving user, business, production, or reporter data;
- a product decision with incompatible outcomes and no safe reversible default;
- a production release, protected/default branch update, release promotion, force operation, bypass, or other target requiring explicit approval;
- external communication to a named person, support channel, email, chat, or provider;
- live-money, irreversible provider, or production third-party action;
- external disclosure of a credential or the human acceptance decision.

Before declaring a non-production data or state blocker, attempt or rule out a scoped disposable fixture. Before any hard-to-undo third-party attempt, inspect current repository/provider prerequisites and prefer sandbox or read-only preflight. Never repeat stateful attempts when external evidence already identifies a provider-side blocker.

## Completion

Do not stop at a plan when safe executable work remains. Do not claim success while verification, an authorized deploy, a Scout mutation, or an in-scope follow-up is still running.

Before returning, reread every item changed in the run. For explicit full-queue scope, refetch every frozen item ID directly and reconcile unexpected remaining work. A confirmed empty queue is a normal successful outcome.

Return a short evidence-based result: selected scope, change or finding, fresh verification, Scout transitions made, authorized git/deploy actions performed, and exact remaining blockers. Do not paste queue dumps, schemas, raw payloads, secrets, or long command logs.
