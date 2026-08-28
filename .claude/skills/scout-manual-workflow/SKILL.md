---
name: scout-manual-workflow
description: Use only when the user explicitly invokes `/scout` or asks to take, handle, fix, resume, continue, inspect, check status, triage, review, or audit work from Scout. Do not trigger for incidental Scout mentions or ordinary repository work.
---

# Scout Manual Workflow

One manual run over one selected Scout scope. Never poll Scout for new work, never start a background queue worker, never touch work outside the selected scope. Waiting for an operation this run already started is fine.

## Contract

- Fetch `$SCOUT_URL/api/docs/openapi.json` at the start of every run. It is the only source of paths, methods, request fields, allowed values, status names and responses. Never act on a remembered or copied API shape.
- Read `SCOUT_URL`, `SCOUT_API_KEY` and `SCOUT_PROJECT_SLUG` from the environment, then from the workspace `.env`.
- This session owns every Scout mutation and every implementation decision. Subagents may only read and verify.
- Refetch an item's current record before each mutation and after any wait on external activity.

## Scope

Resolve the project from the request, else `SCOUT_PROJECT_SLUG`, else live discovery when it returns exactly one project. Never guess between projects.

- Item id or item URL: that item. Add a second item only when evidence proves a shared root cause or a direct dependency.
- Bare `/scout`, `next`, `one`: one best actionable item or one shared-root cluster.
- `all`, `full queue`: the whole queue, frozen as described below.
- Project, branch, type or class filter: one best actionable item unless the user asks for all matching work.
- `inspect`, `status`, plain lookup: read-only, no mutation.
- `resume`, `continue`: the single active item owned by this operator; otherwise fall back to single-item selection.
- Completed or human-accepted work is out of scope unless the user explicitly asks for an audit, regression check, reopen or acceptance review.

Prioritize by user harm, data or security risk, blocked core journeys, regression risk, dependency impact, then age. Prefer finishing existing work over starting new work on the same surface. Do not take over another person's active item unless the user asks or the record proves it abandoned.

## Delivery

1. Reconstruct the report from its own evidence in the cheapest useful order: item and notes, debug context, screenshot or URL, recording summary, full replay only when timing or navigation demand it. For linked runtime errors, read the current error context; keep raw logs and payloads out of Scout.
2. Trace the real code path to root cause and fix it, covering the adjacent roles, inverse actions, empty states, permissions and downstream reads that the same defect touches.
3. Verify by replaying the reported journey under the repository's verification rules, then name every surface left unchecked.

## Note triage

A note is captured signal, not committed work. Convert it into a task only when the desired outcome, affected surface and acceptance path are clear from product and repository context. Otherwise leave one focused question naming the missing decision, re-type it to improvement when it asks the product to promise something new instead of reporting a broken promise, or cancel it with a recorded reason when it is duplicate or obsolete. Never guess product requirements through code changes to clear a note.

Link related items only on current evidence; similar wording is a lead, not proof. Cluster items only on a shared root cause, and still verify each one against its own reported condition.

## Transitions

Evidence is the gate: which environment and scenario were checked, what action ran, what was observed, why that covers this item, the change or deploy reference, and remaining risk. Derive the actual fields and values from live OpenAPI.

- Claim ownership only when implementation or active verification actually starts.
- Hand off for review only when the fix and local verification are done, the change reference exists, and acceptance cannot safely finish in this run.
- Complete AI/operator work only through the current completion operation, with inline passing acceptance evidence. Never transition an item merely to make completion legal.
- AI completion means ready for human acceptance. Human acceptance, rejection and reopen happen only on explicit user instruction, through the operations the contract provides for them.
- When the evidence cannot be produced, leave the state unchanged and record the exact blocker.

## Queue and batch runs

Offset pagination is not a snapshot: before the first mutation require two consecutive identical passes (same total, same IDs), freeze those IDs, and add only dependencies proven from their records. If the population never stabilizes within a few retries, do not claim a frozen queue and do not start batch mutation.

Mutate in small serial batches, verify the resulting items after each batch, and refresh state after meaningful changes rather than after every read. Every in-scope item ends the run in one honest outcome: completed, handed off, active with a named blocker, left as a focused question, or cancelled with a reason.

In an audit, judge each original acceptance condition on its own evidence, leave passing work untouched, and move only confirmed failures. For a run spanning sessions or a large mutation batch, keep a resumable ledger outside the repository (item, decision, evidence, result, next action); live Scout state always outranks the ledger.

## Output

Scout notes: Russian by default, or the item's working language. State the result, the strongest fresh evidence, the current outcome, the change or deploy reference, remaining risk and the next action. No step logs, raw payloads, schemas, stack traces, secrets or local paths.

Chat answer: shorter than the note - scope selected, what changed, what was freshly verified, Scout transitions made, deploy result, exact remaining blockers.
