---
name: scout-manual-workflow
description: Use only when the user explicitly invokes `/scout` or asks to take, handle, fix, resume, continue, inspect, check status, triage, review, or audit work from Scout, in any repository that reports to Scout. Do not trigger for incidental Scout mentions or ordinary repository work.
---

# Scout Manual Workflow

One manual run over one selected Scout scope. Never poll Scout for new work, never start a background queue worker, never touch work outside the selected scope. Waiting for an operation this run already started is fine.

## Contract

- Fetch `$SCOUT_URL/api/docs/openapi.json` at the start of every run. It is the only source of paths, methods, request fields, allowed values, status names and responses. Never act on a remembered or copied API shape.
- Read `SCOUT_URL`, `SCOUT_API_KEY` and `SCOUT_PROJECT_SLUG` from the environment, then from the workspace `.env`.
- Item queries take the project id, not the slug: resolve it once through the project listing.
- Unknown request keys are ignored silently, so a paging key borrowed from another API returns the first page and reads as a complete backlog. Page to the end of the reported total.
- The multi-value status filter answers a whole queue group in one call; passing the single-value form as well silently narrows the answer to one bucket.
- Every mutation carries the item's revision from the last read of that item. It is opaque: send it back byte for byte, without parsing, normalizing or reformatting. A stale or rewritten value is rejected as a conflict. Refetch the item before each mutation and after any wait on external activity.
- The API has no request cap: fetch details and mutate concurrently rather than one at a time. For more than a couple of items, drive it from a small scratchpad script wrapping one `call(path, body)` helper, and keep the id list in a file. That file is what makes a completeness audit possible.
- This session owns every Scout mutation and every implementation decision. Subagents may only read and verify.

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

## Reporter context

An item carries the state the reporter saw: the page and route, the selected element with its text and markup, the viewport, a screenshot, a session recording and structured debug context covering navigation, actions, console, network and performance. The list response carries none of it; the single-item read does.

**Read the reporter's own evidence before opening the page yourself.** A report answered from a fresh page load is answered about a different moment. Two fields settle most layout complaints on their own: the screenshot, a full-page capture with the reported element outlined, fetched with the API key; and the element's own markup as it stood, classes included, which answers "which rule produced this box" without guessing from the current build.

- Reproduce at the reported viewport under the reported account. Layout defects often exist only at one size or under one account's data.
- Navigation and actions are the path that produced the defect. One that needs a client-side transition does not reproduce on a direct load of the same URL.
- Empty console and network narrows it: no failed request, so look at state that never settled or a value rendered as it came.
- When the current page does not show what the screenshot shows, say so and name what you tried. A defect that will not reproduce is a question for the reporter, not a fix applied blind.

## Delivery

1. Reconstruct the report from its own evidence in the cheapest useful order: item and notes, debug context, screenshot or URL, recording summary, full replay only when timing or navigation demand it. For linked runtime errors, read the current error context; keep raw logs and payloads out of Scout.
2. Trace the real code path to root cause and fix it, covering the adjacent roles, inverse actions, empty states, permissions and downstream reads that the same defect touches.
3. Verify by replaying the reported journey under the repository's verification rules, then name every surface left unchecked.

## Triage

The item type says what an item is; the status says where it stands. Fix the type before deciding anything else.

- Bug: a gap between what the product already promises and what it does. "I click here, I expect this, I get that."
- Improvement: a request for the product to promise something new. "It would be good if", "we could add", "an improvement". However it is worded, it is not a bug, and it stays out of the working queues.
- Note: captured signal, not committed work. A question is a note.
- Task: work already agreed with the customer.

Re-type a request for new behaviour to improvement. Never cancel it: cancelling says the work will not happen and throws away the reason the request exists. One already cancelled as out of scope gets reopened and then re-typed.

A note becomes a task only when the desired outcome, affected surface and acceptance path are clear from product and repository context. Otherwise leave one focused question naming the missing decision, or cancel it with a recorded reason when it is duplicate or obsolete. Never guess product requirements through code changes to clear a note.

Link related items only on current evidence; similar wording is a lead, not proof. Cluster items only on a shared root cause, and still verify each one against its own reported condition.

## Transitions

Evidence is the gate: which environment and scenario were checked, what action ran, what was observed, why that covers this item, the change or deploy reference, and remaining risk. Derive the actual fields and values from live OpenAPI.

| Intent | Operation |
|---|---|
| Take a new item | claim |
| Move between working states | the generic status update, which accepts only the two working states |
| Finish it | resolve, the only path to completion |
| Hand it back to the reporter | request changes |
| Drop work that will not happen at all | cancel |
| Bring a closed item back | reopen |
| Comment | add note; there is no comment operation |

- Claim ownership only when implementation or active verification actually starts.
- Hand off for review only when the fix and local verification are done, the change reference exists, and acceptance cannot safely finish in this run.
- Completion evidence is stricter than evidence recorded along the way: its accepted result and levels are a narrower subset of the general ones. Read both from the live contract and build the whole object before the call, because a partial or off-enum object is rejected outright.
- Complete AI/operator work only through the current completion operation, with inline passing acceptance evidence. Never transition an item merely to make completion legal.
- AI completion means ready for human acceptance. Acceptance belongs to the reporter or the project owner: never accept another person's item and never accept an item as its own resolver. Human acceptance, rejection and reopen happen only on explicit user instruction.
- Leave a note explaining the decision before cancelling or requesting changes. An item parked in "changes requested" reads as unfinished work; if the product decision is final, cancel it.
- When the evidence cannot be produced, leave the state unchanged and record the exact blocker.

## Queue and batch runs

Offset pagination is not a snapshot: before the first mutation require two consecutive identical passes (same total, same IDs), freeze those IDs, and add only dependencies proven from their records. If the population never stabilizes within a few retries, do not claim a frozen queue and do not start batch mutation.

Mutate in small serial batches, verify the resulting items after each batch, and refresh state after meaningful changes rather than after every read. Reporters file while the work runs, so a sweep ends when a fresh query of the open statuses comes back empty, not when the first frozen list is done. Every in-scope item ends the run in one honest outcome: completed, handed off, active with a named blocker, left as a focused question, or cancelled with a reason.

In an audit, judge each original acceptance condition on its own evidence, leave passing work untouched, and move only confirmed failures. A period re-audit ("check the tasks of the last week") lists the completed and accepted items over the window, re-runs each item's acceptance scenario, and reopens what fails with a note. For a run spanning sessions or a large mutation batch, keep a resumable ledger outside the repository (item, decision, evidence, result, next action); live Scout state always outranks the ledger.

## Output

Scout notes: Russian by default, or the item's working language. State the result, the strongest fresh evidence, the current outcome, the change or deploy reference, remaining risk and the next action. No step logs, raw payloads, schemas, stack traces, secrets or local paths.

Chat answer: shorter than the note - scope selected, what changed, what was freshly verified, Scout transitions made, deploy result, exact remaining blockers.
