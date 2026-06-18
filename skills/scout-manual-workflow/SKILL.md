---
name: scout-manual-workflow
description: Use when the user asks to take a bug, note, defect, improvement, or task from Scout and handle it like a professional AI operator working from Scout. Also use for short commands like "do the next Scout task", "сделай следующую задачу из Скаута", or "возьми задачу из Scout".
---

# Scout Manual Workflow

## Role

Own the Scout item lifecycle end-to-end as an AI engineering operator: understand the reported intent, diagnose the real system behavior, make the smallest complete fix, verify acceptance, update Scout with structured evidence, and leave the item in the furthest honest status. Scout holds the report, discussion, evidence, status, and handoff; the local repository holds the engineering work.

This skill is an execution contract for AI agents, not a human runbook. Treat instructions as actions to perform with tools, API calls, browser checks, git commands, and Scout updates when the user asked to handle Scout work.

This is not a daemon workflow. Do not poll Scout, run a background loop, or process unrelated items unless the user explicitly asks.

## Agent Execution Contract

When this skill is active, OpenCode is the operator of the Scout item lifecycle.

1. Perform discovery, code changes, verification, commits, safe non-production pushes/deploys, Scout notes, evidence records, and status updates yourself when access exists.
2. Default to action, not clarification. Ask the user only after exhausting toolable discovery and only for hard gates: missing access, destructive approval, production release, external communication, live-money/provider action, secrets exposure, human acceptance, or a product decision with incompatible outcomes. Do not ask for routine status, verification, push, deploy, batching, or handoff choices that this skill defines.
3. Before every Scout status change, evaluate the status preconditions in `Status Transition Algorithm`. If a precondition is false, do not change the status; add a concise blocker or progress note instead.
4. When moving to `review` or `done`, send the `evidence` object inline in the status API call. Use `/api/items/add-evidence` only for supplemental records that are not a status transition.
5. Treat `note` items as AI-triage input, not as developer chores. Convert actionable notes to `task` yourself when the desired work is inferable from the note, evidence, and product context; otherwise link, cancel, or record one focused blocker question only when no safe inference exists.
6. Keep user-facing chat short. Durable operational detail belongs in Scout notes and structured evidence, not in chat.
7. Treat `/scout` as the only Scout execution command. Every invocation uses maintainer-level ownership; arguments and live queue state select only the work scope, not a weaker behavior profile.
8. For full-queue work, process one cohesive item or shared-root cluster at a time when evidence supports clustering. Status transitions, evidence, and notes still remain item-specific.
9. Do not use `/api/items/update-status` for `verified` or `changes_requested`. Human acceptance uses `/api/items/verify`; human rejection or explicit audit rejection uses `/api/items/request-changes`.

## Single Command Scope Selection

The slash command surface is intentionally one command: `/scout`. Optimize this workflow for AI-agent execution, not for human runbook readability. Scope selection decides which Scout work to handle; it never changes the agent's maintainer-level ownership.

1. If the user provides a Scout item id or item URL, use single-item scope: fetch that item, inspect related items, and handle the item end-to-end. Include related items only when evidence shows the same root cause or a direct blocker.
2. If the user explicitly asks for the next/one Scout task, use single-next scope: choose exactly one next actionable item or one evidence-backed shared-root cluster.
3. If the user invokes bare `/scout` with no narrowing text, or asks for all/full queue work, use full active queue scope. Continue through actionable `changes_requested`, `review`, `in_progress`, `new`, and triage-worthy `note` items until no item can honestly move further with the available access and safety constraints. Treat the UI `Needs Review` queue as `review` plus `changes_requested`, not as a separate status.
4. If natural-language scope names a project, branch, deploy target, status queue, or item class without saying `one`/`next`, use the broadest safe active scope matching that text and handle every item that can honestly move further.
5. Always build the readiness matrix internally; expose it only when it affects the final decision, a blocker, or the user's understanding.
6. Audit `done` or `verified` items only when the user's request explicitly asks to recheck completed/accepted/closed work. Normal Scout work does not disturb `done` awaiting human acceptance or `verified` human-accepted items.
7. For ambiguous natural-language requests without an id/URL, choose the broadest non-destructive active scope that matches the text instead of asking. Ask only if acting would disturb `done`/`verified` work, perform destructive actions, trigger a hard gate, or choose between conflicting product outcomes.

## Professional Ownership Mode

A short command to take Scout work means: infer the real intent from the item and evidence, find the affected surfaces, handle the work end-to-end, and leave the task in a reviewable or `done` state according to this workflow. `verified` is reserved for human acceptance.

- Treat the report as intent plus evidence, not necessarily a complete solution.
- Check adjacent workflows, inverse actions, roles, permissions, empty states, data propagation, deploy/runtime differences, monitoring and support impact before editing.
- Do extra work only when it is justified by shared root cause, acceptance coverage, safety, verification, or handoff quality.
- Do not expand product scope just to appear thorough.
- Do not leave implicit next steps, unverified assumptions, stale statuses, missing commits, or ambiguous handoff notes.

## Maintainer-Level Scope

When handling Scout work, treat the user's request as permission to lead the project like a responsible maintainer. This is the only execution behavior for `/scout`; scope selectors never reduce this responsibility. Make any professionally justified project changes needed to solve the item or the relevant class of problems, even when that means a large diff, many files, refactoring, API/UI/docs/tests/skills/commands changes, or removing stale code.

"Minimal fix" means no unnecessary work, not the smallest possible diff. Prefer the smallest complete correct solution, but do not ask for approval only because the complete solution is broad. Non-production-safe commits, branch pushes, staging deploys, staging verification, Scout evidence, and Scout status updates are normal completion work, not approval gates. Ask the user only for hard gates: production release, external communications, live-money/provider actions, destructive user-data deletion, secrets exposure, or human acceptance actions such as `verified`.

## Operating Principles

- Treat the Scout item as the contract, but verify the real behavior before changing code.
- Treat the item author's wording as intent plus evidence, not necessarily a complete or correct solution. Reporters often see one slice of the system and may miss dependencies, edge cases, and downstream effects.
- Own the item end-to-end: triage, reproduce, diagnose, fix, verify, communicate, and hand off.
- Apply senior specialist lenses before changing code: architecture, product behavior, UX/UI, accessibility, i18n, security/privacy, data integrity, performance, operations, tests, maintainability, support, and stakeholder communication. Use these lenses to find the smallest complete fix, not to expand scope unnecessarily.
- Treat the user as the reviewer/approver, not the workflow operator. Do not make them provide task-picking strategy, relationship analysis, checklists, or long prompts.
- Short user commands such as "сделай следующую задачу из Скаута" are complete instructions: choose the best next actionable Scout item and execute the full workflow autonomously. Bare `/scout` is also a complete instruction: process the full active queue and solve every item that can honestly move further.
- Do not require the user to spell out prioritization, verification, or Scout update rules; apply this skill's workflow by default.
- Keep scope disciplined. Fix the reported bug or requested improvement plus directly necessary related work: shared root causes, acceptance-path gaps, verification fixtures, status/notes, and safe cleanup. Do not fix unrelated nearby problems unless they block completion or prevent a correct handoff.
- Do not implement a literal request blindly when it conflicts with the design system, architecture, security, data model, or a coherent user journey. Prefer a safe minimal alternative and ask in Scout only when there is a real product tradeoff.
- Prefer evidence over assumptions: URL, screenshot, recording, selector, logs, API payloads, repo behavior, and tests.
- If the item is unclear, infer the safest professional acceptance path from evidence, existing behavior, product context, and related items. Ask a precise Scout question only when no safe reversible implementation or verification path exists, and continue other actionable items in scope.
- Keep Scout updated at meaningful milestones, not with noisy step logs.
- Preserve all existing local and repo-specific rules, especially `AGENTS.md`, test/build commands, design system rules, and deployment safety rules.

## Autonomy Boundary

Handle routine engineering decisions without asking the user:

- choose the next actionable item when no item id is provided;
- classify and prioritize the item;
- triage notes and convert them to tasks when they are actionable by safe inference;
- decide whether to claim it now or leave it with a question/blocker;
- search for duplicates, related items, blockers, conflicts, and shared root causes;
- infer likely stakeholder intent and acceptance criteria from the report, evidence, product context, and existing behavior;
- choose the professional amount of extra verification for the risk level, even if the user did not ask for it explicitly;
- create evidence-backed Scout links and notes;
- choose the minimal code path, tests, runtime checks, and browser checks;
- create focused commits and push non-production-safe branches when repo workflow allows;
- push all existing local ahead commits on the same safe branch when the branch must be pushed as a unit for handoff or staging;
- deploy or close items only when the repository and Scout workflow explicitly allow it and the required evidence exists;
- update Scout status when the Definition of Done supports it.

Ask the user only for real blockers:

- missing access or credentials;
- destructive or irreversible action;
- product decision with incompatible requirements;
- external dependency outside the available repo/services;
- production release/deploy, protected/default branch update, release branch fast-forward, or human acceptance decision.

## Configuration

Read Scout access from environment variables first. If required variables are missing, check the current workspace for a local `.env` file and source it inside the Scout command process. This is the default for repos where `.env` is intentionally local and gitignored; do not ask the user for Scout credentials until both exported env vars and the local `.env` fallback have been checked.

- `SCOUT_URL`: Scout base URL, for example `https://your-scout.example`.
- `SCOUT_API_KEY`: project-scoped API key in `sk_live_*` format. Prefer a key created from Scout via `Projects` → target project → `Manage integrations` → `Create agent key`.
- `SCOUT_PROJECT_SLUG`: Required default project slug.

Agent keys should have only the scopes needed for manual issue work, such as reading items, adding notes, workflow/triage actions, related-item links, and reading storage evidence. Never commit Scout credentials, cookies, JWTs, API keys, `.env.local`, or generated credential files. Do not paste real secrets into documentation, PR bodies, issue text, or durable notes.

For runtime error group work, include only the required `errors:*` scopes on the agent key: `errors:read` for inspection, `errors:triage` for ignore/unignore, and `errors:write` only for ingestion/upsert automation. The Alertmanager bridge shared secret is server-side integration material; do not use or expose it for normal manual Scout item work.

Recommended shell prefix for Scout API calls when working from a repo root:

```bash
set -a
[ ! -f ./.env ] || . ./.env
set +a
```

Use that prefix only inside the command process. Keep `SCOUT_API_KEY`, tokens, cookies, and `.env` contents out of durable artifacts, Scout notes, commits, docs, and routine progress updates. Do not narrate this handling; mention only missing/invalid access, a blocker, or a value the user explicitly asked to see in the private chat. It is fine to print `present`/`missing` for variable diagnostics.

## Intake

When the user asks to work from Scout:

1. Detect whether the prompt contains a Scout item id or item URL.
2. If an item id or URL is present, fetch that item first and use single-item scope.
3. If no item id or URL is present, resolve `SCOUT_PROJECT_SLUG` to the current project through live OpenAPI and choose full active queue scope by default unless the user explicitly requested next/one-item scope.
4. In single-next scope, inspect enough `changes_requested`, `review`, `in_progress`, `new`, and triage-worthy `note` items to choose the best next actionable item, then stop after that item or shared-root cluster reaches the furthest honest status.
5. In full active queue scope, inspect `changes_requested`, `review`, `in_progress`, `new`, and triage-worthy `note` items before choosing work. Do not stop after one item unless the remaining queue is honestly blocked, waiting on target verification, not actionable, or unsafe.
6. For every item that may move, fetch the full item before editing code or changing status.
7. Read the item type (`bug`, `note`, `task`), source, message, status, priority, labels, created date, URL, route, component hints, selector, element text/HTML, `debugContext`, `recordingSummary`, screenshot path, session recording path, existing notes, assignee, branch, PR link, evidence, and related items.
8. For widget/frontend/admin items, inspect evidence in this order before downloading large artifacts: item fields, `debugContext` (page, navigation, actions, console, network, performance), screenshot, `debugContext.recordingSummary`, then rrweb player or full rrweb JSON only when needed.
9. If the item is a `note`, run `AI Note Triage Algorithm` before any code work. Do not claim a note directly.
10. Decide whether the resulting item is actionable now and what the furthest honest next status can be.
11. If actionable, leave a concise Scout note that you are taking it and what local repo/branch you will use.
12. Claim the item or move it to `in_progress` only when you are actually starting active implementation or verification for that item or shared-root cluster.

## Scout Item Types

Scout has three intentionally simple work item types. Treat type as a workflow decision, not cosmetic metadata.

- `bug`: something is broken. Reproduce, diagnose, fix, verify, and move through workflow when evidence supports it.
- `task`: committed project work. Infer acceptance from the item and context, implement the smallest complete change, verify, and move through workflow when evidence supports it.
- `note`: a lightweight observation captured during testing. Do not claim, implement, or move it through engineering workflow as-is. Triage it first. If the desired work is safely inferable, convert it to `task` yourself and continue; if not, link it to related work, cancel it with a reason, or record a focused blocker question only when a hard missing decision remains.

When selecting the next actionable item, include `note` items in the candidate queue instead of ignoring them. Prefer critical/high `bug` and already-committed `task` work, but actively triage notes when they are old, high-signal, related to current work, or no higher-priority bug/task is available. If an API call rejects a note with `NOTE_REQUIRES_TRIAGE`, run note triage instead of forcing the workflow.

## AI Note Triage Algorithm

Notes exist to keep widget capture lightweight while moving triage effort from humans to the AI agent. The goal is to turn useful notes into work without making testers choose Jira-like fields in the widget.

When handling a `note`:

1. Read the full note context and nearby evidence: page URL, `debugContext`, `recordingSummary`, metadata, reporter, labels, existing comments, related items, and current project conventions.
2. Search for related open bugs/tasks/notes before deciding. Link obvious duplicates or shared-root items yourself.
3. Decide whether the note is actionable by using the note, evidence, related items, current product behavior, and the safest reversible professional default before treating it as a human product decision.
4. A note is actionable when it names a desired outcome or user problem, the affected surface is discoverable, acceptance can be inferred safely, and the likely change is within the current repo/project.
5. A note is not actionable when it is only a vague thought, conflicts with existing product behavior, lacks a discoverable affected surface, needs an unresolved business decision, or would require broad product design beyond the captured observation.

If actionable:

1. Add a concise Scout triage note explaining why it is being converted and the inferred acceptance criteria.
2. Convert it with `/api/items/update` using `itemType: "task"` before claiming or changing workflow status.
3. Normalize title/message only if the existing message is unclear and the API/update permission allows it. Preserve the reporter's original signal in the triage note.
4. Continue through the normal task workflow: claim, implement, verify, add evidence, and hand off.

If not actionable:

1. Add exactly one focused Scout question or blocker note that names the missing decision/evidence.
2. Link it to a related item if that helps the next triage pass.
3. Leave it as `note` and do not claim it.
4. Cancel it only when it is clearly duplicate, obsolete, outside scope, or not useful; always leave the reason in Scout.

Never use code changes as a way to guess through an unclear note. The AI agent can reduce developer workload by triaging and converting notes, but it must not silently invent product requirements.

## Queue Triage

When selecting work from a project rather than a specific item, first inspect the queue like a bug triage owner, not like a FIFO script.

Human queue tabs are status groups, not separate states:

| Queue | Scout statuses |
|-------|----------------|
| `Open` | `new` |
| `In Progress` | `in_progress` |
| `Needs Review` | `review`, `changes_requested` |
| `Needs Acceptance` | `done` |
| `Accepted` | `verified` |
| `Archived` | `cancelled` |

1. List active work across relevant statuses: `changes_requested`, `review`, `in_progress`, and `new` when appropriate. Prefer one `/api/items/list` call with `statuses` when Scout supports it; otherwise make separate status calls. Do not filter notes out; if the combined list cannot include all item types, run an additional note-specific list call so useful notes can be converted by AI triage instead of waiting for a developer.
2. Sort by severity and urgency first, then age:
   - `critical`: production outage, data loss/corruption, security/privacy issue, broken core workflow.
   - `high`: major user-visible failure, blocked important workflow, strong business impact.
   - `medium`: normal defect or improvement with clear value.
   - `low`: polish, minor inconsistency, non-blocking improvement.
3. Within the same priority, prefer older `createdAt` items unless a newer item is clearly a regression, duplicate of a hot issue, or blocks more users.
4. Do not starve old medium/low items forever. If many old items accumulate, call that out in Scout or in the user-facing summary.
5. Treat assigned `in_progress` items carefully: do not take over another person's work unless the user explicitly asks or the item is clearly abandoned.
6. Check `review` items before starting new work when they may already contain a fix for the same area.

Recommended selection order:

1. `changes_requested` items: read the rejection note, move to `in_progress` only when taking ownership, fix the exact expected/actual gap, and repeat verification.
2. `review` items: verify accepted target environment when available; otherwise leave with explicit blocker or keep ready for target verification. If target verification is active or assigned, record the owner/checks/blocker in Scout notes or evidence instead of changing status.
3. Active or abandoned `in_progress` items owned by this agent/user context: continue, fix, verify, and hand off or document blockers.
4. Critical items, oldest first, grouped by suspected root cause.
5. High priority regressions or blockers, oldest first.
6. Actionable notes related to critical/high work, converted to tasks before implementation.
7. Related clusters where one fix may resolve multiple open items.
8. Remaining oldest actionable bugs, tasks, or convertible notes within the requested scope.

## Related Items And Duplicate Work

Before implementing a fix, proactively look for related Scout items so one root-cause fix can close the whole cluster when appropriate. Do not wait for the user to ask for dependency analysis.

Search for related items by:

- same project and same route/page URL;
- same component file, selector, element text, or UI area;
- similar error text, labels, browser/device, status, or reproduction steps;
- same recent deployment/regression window;
- notes that mention a branch, PR, workaround, or previous investigation;
- screenshots/recordings that show the same visible failure.

Classify relationships explicitly:

- Duplicate: same symptom, same expected behavior, same root cause likely.
- Shared root cause: different symptoms caused by the same code path or data issue.
- Related but separate: same area, different cause or expected behavior.
- Blocks / blocked by: one item cannot be completed or verified until another item is handled.
- Caused by: the current item appears to be a regression or side effect of another tracked change.
- Conflicting: items request incompatible behavior and need a product decision.

Rules for handling clusters:

1. Do not blindly merge bugs by similar wording. Confirm with evidence.
2. Create Scout links yourself when evidence supports a relationship: `duplicate`, `related`, `blocks`, `blocked_by`, `caused_by`, or `conflicts`.
3. If one fix likely resolves multiple items, choose a primary item and mention related item ids in Scout notes.
4. Keep the code change cohesive. One PR may address a cluster only when the root cause and verification are shared.
5. If related items need different fixes, split the work and explain why.
6. After fixing, verify each related item's acceptance condition before moving it to `review` or `done`.
7. When closing/handing off multiple items, add a note to each item that links the shared branch/PR and explains why it is covered.
8. If items conflict, link them as `conflicts`, record the product/owner question in Scout instead of choosing arbitrarily, leave only the conflicting items blocked, and continue unrelated actionable work in scope.
9. If no related items are found, say that in the completion note so the absence of links is intentional.

## Full Queue Efficiency

When `/scout` uses full active queue scope, optimize for correct throughput, not mechanical item-by-item repetition.

1. Build the live queue once at the start of the batch, then refresh it after a status-changing batch or when new information could change priority. Do not refetch the whole queue after every read-only step.
2. Cluster items only with evidence: same route, component, root cause, deploy target, or acceptance path. Keep unrelated items separate even if they are close in the UI.
3. For a shared-root cluster, make one cohesive code change and one verification matrix, then write item-specific evidence/notes/statuses for each covered Scout item.
4. Avoid status noise: do not claim every candidate just because it was listed. Claim an item when implementation or active verification starts.
5. Keep the ledger as the durable progress source for batch state. Do not paste full queue snapshots or every API response into chat or Scout notes.
6. Continue until every active item in scope has an honest final state for this run: `done`, `review`, `changes_requested` with an exact blocker/failure, `in_progress` with an exact blocker/failure, `cancelled`, or non-actionable `note` with one focused question/blocker.

## Triage

Before implementing:

1. Classify the item: bug, regression, UX issue, feature request, copy/content, infra, test/build, data issue, or access/config issue.
2. Determine expected behavior and actual behavior from the Scout evidence.
3. Identify affected surface: frontend, backend, widget, database, integration, deploy, documentation, or unknown.
4. Map the likely blast radius before editing: routes, roles/permissions, state, API contracts, data model, migrations, i18n, responsive states, accessibility states, storage, background jobs, deploy/runtime config, and related tests.
5. Consider priority, created date, and whether related higher-priority or older items should be handled together.
6. Check if the issue is already fixed, duplicate, blocked, impossible to reproduce, or outside this repo.
7. If scope or expected behavior is ambiguous, infer the safest professional default from evidence and existing behavior. Ask in Scout only when incompatible product outcomes remain, leave that item blocked, and continue unrelated actionable work in scope.

## Reproduction And Diagnosis

For bugs, reproduce or collect the nearest practical evidence before fixing:

1. Use the reported URL, `debugContext`, screenshot, selector, recording, logs, API payload, or test failure.
2. For frontend/user-visible bugs, run or use the local app and verify in a browser when feasible.
3. Trace the code path to root cause. Do not patch symptoms blindly.
4. Compare with nearby working behavior or established patterns.
5. Add temporary probes only if they help find the cause; remove them before completion.

If reproduction is impossible but the evidence is strong, say so in Scout and make the smallest evidence-backed fix.

## Browser Debug Context And Session Replay

Scout widget items may include structured browser diagnostics in `debugContext`. Treat this as primary reproduction evidence for frontend, widget, dashboard, and admin bugs.

1. Read `debugContext.page` first to understand the exact captured URL, title, route, referrer, visibility state, viewport, screen, and timing context at report time.
2. Use `debugContext.navigation`, `debugContext.actions`, `debugContext.console`, and `debugContext.network` to reconstruct what the user did, where they navigated, which requests were sent, which responses/errors came back, and which console errors/warnings were visible before the report.
3. Prefer console/network/navigation/actions from `debugContext` over guessing reproduction steps from the message when the item came from the widget.
4. Read `debugContext.recordingSummary` before opening the full session recording. The summary should tell whether rrweb replay exists, duration, event count, first/last timestamps, full/incremental event counts, storage path availability, and important clicks/inputs/scrolls/mutations.
5. Treat rrweb session recording as reproducible DOM/event replay evidence, not as a passive attachment. It is especially important for multi-step bugs, timing or race-condition issues, redirects, navigation bugs, UI state bugs, and cases where the screenshot only shows the final state.
6. Open the dashboard item detail and use the rrweb player when `debugContext`, screenshot, and `recordingSummary` do not explain the bug, or when the bug depends on user path, timing, navigation, redirects, transient UI state, or visual ordering.
7. Download and inspect the full rrweb JSON from `sessionRecordingPath` only for targeted analysis: search specific strings, timestamps, event types, DOM mutations, or user actions. Do not paste the whole recording into chat or Scout notes.
8. If `debugContext` is absent or malformed, continue with the older evidence flow: item fields, screenshot, selector/HTML, metadata, notes, dashboard player, and targeted recording download when needed.

## Runtime Error Group Items

Scout may contain bug items created or linked by the runtime error workflow. Treat linked runtime errors as operational evidence, not as ordinary free-form reporter text.

1. When an item mentions runtime errors, error groups, Alertmanager, Grafana, Tempo, trace ids, request ids, fingerprints, or linked runtime errors, inspect the linked error context before changing code or status.
2. Use the Scout API/UI to read the error group summary when access exists: environment, service, fingerprint, route template, method, upstream service, error type, status code/class, occurrence count, first/last seen, sample request id, sample trace id and linked item id.
3. Follow Grafana/Tempo links or run equivalent log/metric/trace queries only when needed to verify root cause, recurrence, deploy impact, or acceptance. Do not copy raw logs, private payloads, tokens, cookies, headers or full secret-bearing URLs into Scout notes.
4. Preserve the workflow split: Grafana stack owns telemetry evidence; Scout owns triage/status/evidence; application code owns the fix. Do not turn Scout notes into a log store.
5. For completion, verify both the item acceptance and the relevant runtime signal when feasible: no recurrence after the fix/deploy, expected metric/trace/log behavior, or a clear reason why recurrence cannot be observed yet.
6. If the error group is ignored, resolved, reopened as regression, or linked to a different root cause, record that status explicitly in the Scout note/evidence before moving the item.

## External Provider And Stateful Preconditions

Before live-money, provider-callback, production-like, external-communication, or other hard-to-undo third-party actions, run a preflight that can stop bad attempts early.

1. Check project docs, repo-local skills, provider onboarding/support context, current env, live DNS/server state, and existing Scout notes for provider-side prerequisites before the first stateful attempt.
2. Confirm the current public URL, HTTP method, content type, domain/IP/port, whitelist/firewall status, provider service activation, credentials presence, sandbox availability, minimum amount, and rollback/cancel path when those facts matter.
3. Prefer sandbox, simulation, or direct provider API checks when they exercise the same state machine without real money or irreversible side effects.
4. If a public endpoint is reachable but provider attempts produce no inbound gateway/app logs, stop repeating live attempts. Treat provider delivery, whitelist, firewall, cabinet URL, or method mismatch as the blocker until provider-side evidence says otherwise.
5. Do not send Telegram, email, or provider/support messages without explicit user approval for the exact recipient and message. Draft the message first and wait.
6. Record the preflight result in Scout when it changes status, blocks verification, or prevents a risky live attempt.

## User Journey Verification

For user-visible Scout items, treat the user's reported journey as the acceptance path. Before presenting the item as ready or `done`, define and execute the shortest end-to-end path that matches the user's role, entry point, starting state, action sequence, navigation/redirects, and final visible outcome.

1. Prefer browser/UI evidence for UI bugs: click, fill, upload, submit, navigate, and inspect the screen as the user would. API, curl, database, and network evidence can support diagnosis, but do not replace the visible flow unless browser verification is infeasible or unsafe.
2. If the issue is about create, update, delete, search, filters, tabs, redirects, navigation, or browser state, verify the full lifecycle through the UI when feasible: starting state, mutation/action, automatic navigation or refresh behavior, and final screen without manual refreshes or workarounds.
3. If a narrower regression check proves the root cause, still run the original user path before declaring AI/operator completion or moving it to `done`.
4. Record the exact path and result in Scout. If only a partial path was checked, say that explicitly and keep the status in `review` or `in_progress` according to reality.

## Structured Evidence Gate

Scout supports structured evidence records. Treat them as the handoff contract, not as optional decoration. A free-form note can explain context, but it does not replace the evidence record required for status gates.

Before moving an item to `review` or `done`, create or submit evidence. The exact endpoint and payload contract comes only from live `$SCOUT_URL/api/docs/openapi.json`. The list below is the operator checklist, not a copied schema reference:

1. `environment`: local, staging, production, or another explicit runtime.
2. `result`: `pass`, `fail`, `blocked`, or `partial`.
3. `level`: the strongest evidence level, such as `browser_acceptance`, `local_acceptance`, `staging_acceptance`, `production_acceptance`, or `user_acceptance`.
4. `coverage`: `item` by default; use `shared_root_cluster`, `route_sweep`, or `audit_sample` only when that is the honest scope.
5. `url`: the exact checked URL when the item has a web surface.
6. `role`: the role/user context without secrets.
7. `scenario`: the acceptance path derived from the Scout item.
8. `action`: the actual browser/API/user action performed.
9. `visibleResult`: the observed user-visible result, or the runtime result for non-UI work.
10. `acceptanceScope`: what original Scout acceptance condition this evidence covers.
11. `consoleResult` and `networkResult` for frontend/admin/widget work.
12. `apiResult`, `dbResult`, or read-model evidence for backend/data/state-changing work.
13. `fixture` and `cleanupResult` when disposable staging data was used.
14. `commitSha`, `deploySha`, `risks`, `uncheckedRisks`, `source`, and `verifiedAt` when relevant.

Rules:

1. Do not move user-visible work to `review` or `done` with only `200 OK`, route-smoke, old notes, or code reasoning.
2. For mutation workflows, evidence must include the action and post-condition: UI state, list/detail/read path, network/API response, and DB/read-model/audit trail where relevant.
3. For `review`, the transition payload must include `result:"pass"` evidence with `commitSha`. Include top-level `mrUrl` only when a real PR/MR URL exists. Never enter placeholder refs in Scout evidence or status fields. Otherwise keep the item in `in_progress` with a blocker/progress note.
4. For `done`, evidence must be `result:"pass"` with target acceptance: `local_acceptance` only when the item/project/user explicitly accepts local as the target, otherwise `staging_acceptance`, `production_acceptance`, or `user_acceptance`.
5. Generic route sweeps, cluster checks, and API smoke can support a transition, but cannot replace item-specific acceptance unless `coverage:"shared_root_cluster"` names exactly how this item is covered.
6. For shared-root evidence, do not move a related item to `done` unless that item's original acceptance path or a documented equivalent was replayed. A root-cause/API check without the related user journey is at most `review` with explicit `uncheckedRisks`.
7. Before moving more than three items in one run, build a per-item readiness matrix: item id, original acceptance, evidence level, coverage, result, unchecked risks, and next honest status.
8. If acceptance cannot be safely checked, create `blocker` evidence or a blocker note and keep the item in the current honest status. Use `/api/items/request-changes` only when explicit audit/review rejection is justified; use `/api/items/reopen` only for an explicit reopen/regression workflow.
9. When using the API for `review` or `done`, include the `evidence` object in `/api/items/update-status` or `/api/items/resolve`.
10. Use only Scout schema evidence kinds: `handoff` for handoff/review evidence, `verification` for `/api/items/resolve`, `audit` for audits, and `blocker` for blocked evidence. Do not invent `kind` values such as `acceptance`.

## Compact Regression Matrix

For state-changing, moderation, workflow, status, permission, payment, publish/unpublish, or data-sync items, do not stop at the single reported happy path. Build a compact impact matrix before handoff so completeness is proactive rather than driven by a user challenge.

1. Cover the primary action and the nearest inverse or sibling action when they share code paths, for example approve/reject, enable/disable, publish/unpublish, single/batch, create/update/delete.
2. Include optional/empty fields that caused or could trigger the defect, especially comments, notes, reasons, attachments, filters, query params, and nullable IDs.
3. Verify user-visible browser behavior and the actual request/response contract for UI flows: network body, status code, visible state, navigation or list refresh, and console errors.
4. Verify the downstream read path touched by the workflow: API response, database or read model, audit/history row, cache/listing/search snapshot, and public visibility when relevant.
5. Limit destructive breadth. Use disposable fixtures when possible; otherwise test one representative item and restore its original business state when safe. Record unavoidable audit/history side effects.
6. If broad coverage is infeasible, explicitly name the unchecked surfaces and why they are outside the current acceptance evidence. Do not say "fully verified" without this boundary.

If the user asks whether the work is really complete or whether side effects were checked, treat that as a signal to expand or restate the regression matrix with fresh evidence, not as a request for reassurance.

## Large Browser Or Regression Items

When a Scout item asks for broad browser coverage, route sweeps, role matrices, query/params matrices, or "check everything", treat the runner as production tooling, not as ad hoc clicking.

1. Build inventory first: routes, query/params, roles/auth, fixtures, destructive boundaries, and expected-negative cases.
2. Do not run a long sweep through visible browser windows or many Playwright MCP contexts. Use a controlled headless runner when available, with one browser/page by default and explicit throttling.
3. Write progress and results incrementally to an artifact outside the repo, and surface periodic progress only when it changes the user's understanding.
4. Keep the runner below app rate limits. If a broad sweep creates `429` noise, slow down and rerun affected batches instead of treating the raw failures as findings.
5. Classify expected negatives before reporting: invalid-token `403`, missing required params, intentional redirects, allowed third-party/widget noise, navigation `ERR_ABORTED`, and known local-dev warnings are not automatically regressions.
6. For any suspicious failure, run a small targeted repro after the sweep. Report confirmed findings, not raw sweep counts.
7. Do not execute destructive or mass-write form actions without explicit permission and disposable local fixtures. Mark only those cases blocked; do not let them block read-only route coverage.
8. If browser tooling itself fails, diagnose the runner separately from the application and say which evidence is invalidated.

## Auditing Completed Items

When the user asks to recheck many `done` or `verified` items, treat this as an audit workflow, not as normal delivery work. This is the intended QA loop: items can first be marked `done` after AI/operator acceptance evidence, then human acceptance may mark them `verified`; a later audit may revisit them and return only failed or unconfirmable ones through `changes_requested`.

1. Build a durable ledger outside the repo, normally under `~/.local/state/opencode/scout-ledgers/`, with one row per item: item id, current status, page/route, role, scenario class, evidence checked, result `pass`/`fail`/`blocked`, and next action.
2. Distinguish evidence levels honestly. Scout notes, existing completion evidence, read-only route sweeps, API checks, and full browser mutation scenarios are not equivalent.
3. Do not treat rejection as undoing the whole completion batch. Passed items stay `done` or `verified`; only confirmed `fail` or unconfirmable `blocked` items move out through `changes_requested`.
4. Do not claim every item received full manual acceptance coverage unless each original scenario was actually replayed or a documented equivalent was executed.
5. For unsafe/destructive flows without disposable fixtures, mark only that item `blocked`; add the exact missing fixture/access/safety condition and leave it unaccepted unless explicit audit policy requires `changes_requested`.
6. For confirmed failures, use `/api/items/request-changes` with expected/actual behavior, URL, role, reproduction steps, and console/network/API evidence. Add a separate Russian QA note only when the structured request-changes note is not enough.
7. Move `changes_requested` items to `in_progress` only when the agent is immediately taking ownership. Do not use `update-status` for `done → in_progress`, `verified → in_progress`, `done → changes_requested`, or `verified → changes_requested`.
8. Use small batches with resume state for Scout notes/status updates. After each batch, verify counts from Scout rather than assuming all API calls succeeded.
9. The final audit report must include total audited, pass, fail, blocked, moved to `changes_requested`, reopened only when applicable, new items created, and any items not fully covered with the reason.

## Durable Ledgers

For batch work, audits, broad sweeps, or any run that must survive session compaction/restart, write a resume ledger before changing statuses.

1. Use a durable path outside the repo, normally `~/.local/state/opencode/scout-ledgers/<project-or-repo>-<UTC>.jsonl`.
2. Do not use OS temp paths such as `/tmp`, `/var/folders/...`, browser download folders, or tracked repository paths for ledgers.
3. Store item ids, statuses, decisions, evidence summaries, commit/deploy refs, and next actions. Do not store secrets, cookies, full tokens, raw private payloads, or huge logs.
4. Create the exact ledger directory directly, for example with `mkdir -p` or `fs.mkdirSync(..., { recursive: true })`. Do not list broad state or credential directories such as `~/.local/state/opencode`; file names there may reveal token or secret names.
5. Update the ledger after each item or small batch, before moving on to unrelated work.
6. Ledger rows are operational artifacts, not source edits. Use a safe JSON encoder and append outside the repo; avoid spending time forcing ledger updates through code-edit workflows.
7. If a PTY session, deploy log, browser sweep, or long command produced evidence, capture the command, exit status, and relevant result summary in Scout notes, the ledger, or the final report before cleaning up the session or deleting logs.

## Implementation

1. Work in the current local repository unless the user explicitly points elsewhere.
2. Check Git state before editing. Do not overwrite unrelated local changes.
3. Treat Scout fields, screenshots, previous notes, subagent summaries, and stale docs as hints. Rediscover exact files, routes, commands, and API endpoints in the current repo before `read`, `grep`, or `apply_patch`.
4. Create or use a focused branch when the workflow calls for commits/PRs.
5. Make the smallest complete correct change; broad changes are allowed when the correct maintainer-level solution requires them.
6. Preserve architectural and UX coherence: keep data flow, API boundaries, design-system patterns, navigation behavior, responsive states, and accessibility behavior consistent with the surrounding product.
7. Avoid unjustified broad refactors, dependency churn, formatting sweeps, or unrelated cleanup.
8. Preserve public/private boundaries and never add secrets to tracked files.
9. Follow existing project conventions over generic preferences.

## Commit And Handoff

For completed code changes from the Scout execution workflow, create a focused git commit after final verification unless the user explicitly says not to commit or the repository policy forbids commits. Invoking `/scout` or asking to handle Scout work counts as permission to create focused commits, push committed work, push existing local ahead commits on the same non-production-safe branch when that branch must be pushed as a unit, run canonical non-production staging deploys, and perform staging verification required for Scout handoff when the repo workflow allows those steps. Repo-local branch/deploy policy wins: production, protected/default branch pushes, release branch fast-forwards, force-pushes, CI/approval bypasses, and production deploys still require explicit user intent or approval.

1. Commit only the files that belong to the Scout item. Do not include unrelated local changes, generated secrets, local env files, private runbooks, or incidental reports.
2. Keep the commit message in the repository's required language.
3. Include a durable Scout reference in the commit body, for example `Scout-Item: <SCOUT_ITEM_URL_OR_ID>`. If a project uses issue-style refs, follow that existing convention.
4. Before pushing, inspect `git status`, `git diff`, and recent history. Stage only intended Scout-item files, never unrelated local changes. For already committed ahead history on the current safe branch, treat branch push as an all-or-nothing Git operation: inspect the ahead commits for obvious secrets, destructive changes, or branch-policy conflicts, then push the branch without asking which commits to include.
5. Push the committed branch when repo workflow allows and the remote target is non-production-safe. Do not stop to ask only because the branch contains earlier local ahead commits. If branch policy, credentials, protected branch rules, unrelated dirty state, obvious unrelated unsafe commits, or secret risk make pushing unsafe, record the blocker in Scout and continue only to the furthest honest local status.
6. Deploy only to staging or another explicit non-production target through the canonical repository path when available. Never treat production as staging, and never invent a manual deploy fallback when the canonical path is absent or failing.
7. After the commit, push, deploy, or verification step succeeds, update Scout with the branch name and commit SHA in evidence or a Scout note. Include a real PR/MR URL only when it exists. If the commit cannot be created, explain the exact blocker in Scout and do not mark the item ready for review.

Default completion flow with staging preference:

1. Run the repo-required local checks and the narrowest relevant runtime/browser checks.
2. Commit the fix with a Scout item reference when the Scout execution workflow or repo policy requires a commit.
3. Push the committed branch, including existing ahead commits on that branch, when push is authorized, repo workflow allows it, and branch safety is clear.
4. Discover and run the canonical staging deploy when deploy is authorized, a safe staging path exists, and the required access is available.
5. Verify the item-specific acceptance path on staging. For user-visible work, use browser evidence for the reported journey; API or health checks are supporting evidence only.
6. If staging acceptance passes, add structured staging evidence, write a Russian completion note with commit/deploy reference, and move the item to `done`.
7. If staging is not relevant, cannot be attempted, or cannot be completed safely, add structured evidence, write a Russian handoff/blocker note, and move the item only to the status supported by the exact evidence and blocker. Local-only `done` is allowed only for non-deploy work, explicit user acceptance, or another status-rule exception.

When updating Scout status after a local commit:

1. Fill `mrUrl` only with a real PR/MR URL.
2. If there is only a local commit SHA and no PR/MR, do not pass the SHA in `mrUrl`.
3. Put the commit SHA in the Scout note, then call `update-status` with `branchName` and without `mrUrl` only when making a real valid status transition, normally `in_progress` -> `review`.
4. Do not call `update-status` just to rewrite `branchName`, `mrUrl`, or evidence on an item that is already in the intended status. Use `/api/items/add-note` and `/api/items/add-evidence` for supplemental handoff details, and record that the visible branch field could not be changed without status churn.

## Batch Work And Staging

When `/scout` handles many items, keep local work atomic but do not stop at local handoff when safe staging verification can be completed.

1. Process one item or one evidence-backed shared-root cluster at a time: claim only active items, diagnose, fix, verify locally, commit with Scout reference, and add Russian notes/evidence for each covered item.
2. After a completed item, shared-root cluster, or small safe batch, push and deploy to staging when the canonical staging path exists and batching does not hide item-specific acceptance. Avoid one deploy per trivial item only when a short batch reduces churn without delaying critical work.
3. Maintain a clear `review` queue: every item in `review` must have a commit/branch/PR reference, local verification evidence, and a Russian handoff or staging blocker note. Active target-environment verification belongs in notes/evidence/assignee, not in a separate status.
4. If several items share one root cause, one cohesive commit may reference multiple Scout items. Add notes to each covered item and verify each item's acceptance condition locally and, when possible, on staging.
5. If a later local item reveals a regression in an earlier reviewed item before staging acceptance, move the earlier item back to `in_progress`, explain why in Scout, and update the fix before deploy.
6. After a staging deploy, verify the `review` items linked to the deployed branch/commit/PR, then move only individually passing items to `done`.
7. Different cases may need different checks. Choose item-specific staging verification from the item's evidence and changed surface instead of forcing one universal checklist.
8. Do not claim every queued item at batch start. Claim an item only when implementation or active verification for that item or shared-root cluster starts.
9. Before a batch status update, prepare a readiness matrix and update only rows whose individual evidence satisfies the status gate.
10. Do not add optional deploy dry-runs to a known clean staging path unless repo docs require them or the target/branch/image is ambiguous.

## Deploy Path Discovery

Before any push, deploy, or target-environment verification, discover the one canonical path for the current repository instead of trying ad hoc commands.

1. Read repo rules first: `AGENTS.md`, README/deploy docs, package scripts, CI workflow files, and existing release notes when present.
2. If the repo defines a branch order, workflow name, health check, environment, or approval gate, follow that exact path.
3. Treat staging and production as separate targets. If the repo exposes only a production deploy path, do not use it as the default staging path; require an explicit user request plus repo-policy approval.
4. For GitHub Actions deploys, use `gh` to inspect workflow definitions, dispatch or monitor the documented workflow, and wait for the relevant run/check conclusion before claiming deploy success.
5. Do not SSH, run server-side builds, restart services, or choose a manual docker/pm2/systemctl fallback unless repo docs explicitly say that is canonical or the user approves that fallback for the incident.
6. If the canonical staging path is missing, ambiguous, unavailable, or fails, stop deploy work, record the blocker in Scout, and leave items in `review` or `in_progress` according to the status rules.

## Deploy And Staging Verification

When completed work has a commit and the repository provides a canonical non-production staging path, `/scout` should push, deploy to staging, and verify there without waiting for a separate user prompt, subject to repo-local branch safety rules. Production deploys, protected/default branch pushes, and release branch fast-forwards still require explicit user intent and repo-policy approval.

1. Deploy only through the repository's canonical staging deploy path and wait for deploy health checks to pass. If the canonical path fails, stop and report the failed run, command, or check; do not invent a manual fallback unless the user explicitly approves it for that incident.
2. For long image build/push/cache-export phases, wait for the deploy process exit notification or its explicit timeout. Do not interrupt solely because output stalls; if the agent cancels the process, record it as operator cancellation, not as an external deploy blocker, and retry or verify before changing Scout status.
3. Discover the `review` items linked to the deployed branch/commit/PR. If the user says "all review tasks", inspect all `review` items for the relevant Scout project.
4. For each verification item, fetch the full item, notes, evidence, commit/branch/PR fields, related items, and acceptance hints before testing.
5. Verify on staging, not local: use the deployed staging URL, staging API, browser checks for user-visible work, and targeted API/runtime checks for backend work. For user-visible work, the staging browser check must cover the acceptance path from User Journey Verification; API/curl evidence is support only.
6. Keep checks item-specific. Do not replace targeted staging verification with a noisy full sweep unless the item itself requires broad coverage.
7. If staging verification passes, add structured staging evidence and a Russian staging note with environment, URL, commit/deploy SHA, exact checks, and result; then move the item to `done`.
8. If target verification starts but will continue beyond the current atomic check, keep the item in `review` and record what is being checked, by whom, and what evidence is still needed.
9. If staging verification fails, add a Russian failure note with repro steps, expected/actual behavior, console/network/API evidence, and suspected cause; move the item back to `in_progress` and fix it end-to-end.
10. After fixing a staging failure, repeat the normal lifecycle: local verification, commit referencing the same Scout item, Scout note, push, staging deploy, staging verification, then `done` only after staging passes.
11. If verification is blocked by access, missing data, unsafe destructive action, or ambiguous expected behavior, leave the item in `review` or `in_progress` according to reality and record the exact blocker in Scout.
12. Do not mark unrelated review items as `done` just because the deploy succeeded.

## Communication In Scout

Use Scout notes for durable, useful communication:

- Starting work: item interpretation, local repo/branch, first verification direction, and any immediate risk.
- Root cause found: cause, user-visible effect, and affected surface.
- Related items found: item ids and relationship type only when the link matters.
- Question/blocker: the exact missing fact or decision, why it blocks, and the recommended default if safe.
- Verification result: checks run and pass/fail result.
- Handoff: changed behavior, verification, commit/branch/PR/deploy, status, and remaining risk.
- Failure: why it cannot be completed, evidence, and the next owner/action.

Write Scout notes in Russian by default, unless the Scout item or project explicitly uses another language. Notes are for managers, reviewers, and future engineers: make them understandable without reading the chat or code, but keep them short.

Prefer 3-6 short lines or bullets. Start with the result, then the evidence, then status/next step. Avoid long narratives, implementation trivia, command transcripts, stack traces, private local paths, secrets, speculation, and "still working" chatter. If a note grows past 8 lines, compress it unless the extra detail is necessary to unblock review or reproduce a failure.

Default note structure:

1. Итог: what changed or what is blocked.
2. Проверка: the strongest fresh evidence, not every command.
3. Статус/следующий шаг: `in_progress`, `review`, `done`, `changes_requested`, exact blocker, commit/PR, or next action.

Use technical terms only when they help review or reproduce the issue. Explain consequence, not line-by-line implementation. Put raw logs, long matrices, or detailed command output in an artifact or PR comment only when Scout needs that level of evidence.

When adding long Scout notes through the API, build JSON with a safe encoder such as `jq -n --arg id "<CHANGE-ME-item-id>" --arg content "$NOTE" '{id:$id,content:$content}'` and pass that payload to `curl`. Avoid hand-escaped shell JSON for multi-line notes, backticks, quotes, or non-ASCII text.

Minimum useful Scout updates:

1. Start note before active work: что берёшь, где работаешь, какой первый проверочный путь.
2. Root-cause note when useful: причина, симптом, затронутая поверхность.
3. Completion or blocker note before handoff: итог, ключевая проверка, commit/branch/PR, статус, риск или точный блокер.

## Scout Evidence Scope

Use Scout evidence in the cheapest order that can answer the question:

1. Read the item fields, existing notes, environment metadata, selector, element text/HTML, screenshot path, and links first.
2. Open the screenshot or direct URL when visual context is needed.
3. Download or inspect session recordings only when the issue depends on interaction timing, multi-step behavior, or evidence not available from item fields/screenshot/notes.

Do not download large rrweb/session-recording files as a default first step. If you do fetch one, search it for targeted strings/events rather than pasting or reading the whole artifact.

Question note format:

```text
Вопрос: <конкретное решение или недостающий факт>
Почему важно: <влияние на реализацию или проверку>
Рекомендованный вариант: <безопасное предположение по умолчанию, если оно есть>
```

Completion note format:

```text
Итог: <что исправлено или что заблокировано>
Проверка: <самые важные checks и результат>
Статус: <new/in_progress/review/done/changes_requested/verified/cancelled>, <commit/PR/branch/deploy>, <риск или "рисков не вижу">
```

## Status Handling

Statuses are a state machine for the agent. Do not choose a status by sentiment. Choose it by the preconditions below.

Status meanings:

- `new`: not owned by the agent now, or reopened for later triage.
- `in_progress`: the agent owns the item and is actively working, investigating, fixing, or waiting on a direct blocker after taking ownership.
- `review`: local work is complete and needs target-environment or human review, or that review is already underway/assigned but not accepted yet: final local verification is fresh, a focused commit or PR reference exists, structured evidence exists, and a Russian handoff, active-review, or blocker note exists.
- `done`: AI/operator work is complete and ready for human acceptance: target-environment acceptance, staging/production/deployed verification, explicit user acceptance, or another valid acceptance level exists; structured evidence exists; and a Russian completion note exists. This is not human-accepted closure.
- `changes_requested`: a human reviewer or explicit audit rejected the current result with expected/actual context. Treat it as high-priority actionable work unless the rejection itself is unclear.
- `verified`: human acceptance is complete. Treat it as terminal unless the user explicitly asks for an audit, a regression reopens it, or a human requests changes.
- `cancelled`: the agent determined the item is duplicate, invalid, not applicable, intentionally abandoned, or outside scope, and recorded why in Scout.

Use the `Queue Triage` table for UI queue-to-status mapping. Do not invent queue-only workflow statuses.

Status transition algorithm for OpenCode:

1. `new` -> `in_progress`: If the item is actionable and the agent is starting now, call `/api/items/claim`. Add or keep a short start note. Do not claim items that are unclear, blocked before ownership, or owned by someone else unless instructed.
2. `changes_requested` -> `in_progress`: If the returned work is actionable and the agent is taking ownership now, add a short note naming the rejection being addressed and call `/api/items/update-status` with `status:"in_progress"`. Do not use `/api/items/claim` for this status.
3. `in_progress` -> `review`: Use only after the fix is implemented, final local checks passed, browser/runtime checks passed when relevant, final diff was reviewed, a commit exists, and staging deployment/verification cannot be completed safely in the same run. Add inline `evidence` with schema-required fields (`environment`, `scenario`, `action`, `visibleResult`), `result:"pass"`, an appropriate `level`, `coverage:"item"` or justified cluster coverage, item-specific `acceptanceScope`, and `commitSha` in `/api/items/update-status` with `status:"review"`. Include top-level `mrUrl` only when a real PR/MR URL exists, then add the Russian handoff or staging blocker note if not already added.
4. `review` -> `done`: Use only after canonical deploy or accepted target-environment verification passed. Add inline `evidence` in `/api/items/resolve` with schema-required fields (`environment`, `scenario`, `action`, `visibleResult`), `result:"pass"`, `level:"staging_acceptance"`, `"production_acceptance"`, `"user_acceptance"`, or explicit `"local_acceptance"`, item-specific `acceptanceScope`, URL when applicable, deploy/commit SHA when relevant, and the observed result. Add a Russian completion note with the target environment, remaining risks, and that human acceptance is next.
5. `in_progress` -> `done`: Use only for non-deploy work, explicit user acceptance, or work already pushed, deployed, and verified on the target environment in the same run. The same `done` evidence requirements apply. If local-only verification is the strongest evidence, move to `review`, not `done`.
6. `review` -> `in_progress`: If staging/user/reviewer verification fails or the handoff/verification evidence is incomplete and the agent will fix it now, add a failure note, then call `/api/items/update-status` with `status:"in_progress"`.
7. `done`/`verified` -> `changes_requested`: Use only in explicit audit/review scope or when a human asks to reject accepted work. Call `/api/items/request-changes` with concrete `summary`, `expected`, and `actual`; add `steps` and `url` when available. Do not use `/api/items/update-status`.
8. `done`/`verified`/`cancelled` -> `new`/`in_progress`: Use `/api/items/reopen` only for explicit reopen/audit/regression workflows where `changes_requested` is not the right model. Pass `status:"in_progress"` only when the agent is immediately taking ownership, otherwise omit `status` to reopen as `new`.
9. Any status -> `cancelled`: Use only when the item should not be implemented. Add a Russian note explaining duplicate/invalid/out-of-scope/not-reproducible rationale and link related items when relevant, then call `/api/items/cancel` if the API transition is valid.

Hard rules for the agent:

- Never mark `review` or `done` because code was edited, tests passed once, or deploy succeeded by itself.
- Never mark `done` from local evidence alone unless the task has no deployed/user-visible runtime or the user explicitly accepted the result.
- Never mark `verified` as normal AI completion. Use `/api/items/verify` only after explicit human acceptance or an explicit user instruction to perform that acceptance action.
- Do not stop at `review` solely out of habit when a safe canonical staging deploy and item-specific staging acceptance can be completed now.
- Never move an item to `review` or `done` without structured evidence that names schema-required fields (`environment`, `scenario`, `action`, `visibleResult`) plus `result`, `level`, `coverage`, and item-specific `acceptanceScope`. Prefer passing `evidence` in the same status API call.
- Never create `changes_requested` through `/api/items/update-status`. Use `/api/items/request-changes` with expected/actual context when explicit review/audit rejection is allowed.
- If a required precondition is missing, keep the item in the current honest status and add a blocker/progress note. Do not invent evidence to satisfy the gate.
- If multiple items are covered by one fix, transition each item independently only after its own acceptance condition and evidence are satisfied.

Do not add `blocked` as a Scout workflow status. In audits, `blocked` is a QA/ledger result meaning acceptance could not be safely confirmed; record the blocker in a note and keep the item in the current honest status or use `/api/items/request-changes` when explicit audit rejection is justified.

When reporting broad audit counts, separate Scout workflow statuses (`new`, `in_progress`, `review`, `done`, `changes_requested`, `verified`, `cancelled`) from QA result statuses (`pass`, `fail`, `blocked`). Do not mix these into one status list.

When a fix covers multiple Scout items:

1. Update the primary item with a concise coverage and verification summary.
2. Update each related item with a shorter note referencing the primary item and shared branch/PR.
3. Move each related item only after its own acceptance condition was checked.
4. Leave unrelated or only partially covered items open, with a note explaining what remains.

## Verification

Before handoff:

1. Run the narrowest relevant checks first.
2. Run repo-required checks from `AGENTS.md`, README, package scripts, or CI docs.
3. Re-run checks after the final code change, not only before or during the fix.
4. Inspect the final diff and confirm it is limited to the Scout item's scope.
5. For frontend/user-visible changes, verify in a browser against the local app when feasible, matching the reported user journey instead of only checking the inferred root cause.
6. For backend/API changes, verify with tests and a targeted runtime/API check when feasible.
7. For data/deploy changes, verify with fresh state evidence and safe backups when relevant.
8. After a completed commit, push and staging-verify when the canonical staging path is available and safe; if not, document the exact missing path, access, safety approval, or failure.
9. If a check cannot run, document why and what evidence was used instead.

## Definition Of Done

Do not present the item as complete until all of these are true:

1. The reported problem or requested improvement is addressed end-to-end, or a precise blocker/question is recorded in Scout.
2. The final diff was reviewed for unrelated changes, secrets, debug code, broad rewrites, and stale TODOs.
3. Fresh verification evidence exists after the final edit: commands, browser checks, API checks, or a documented reason why a check cannot run.
4. Frontend, dashboard, widget, or other user-visible changes have browser verification of the reported user journey or acceptance path when feasible; API/curl-only evidence is insufficient for UI bugs.
5. A focused commit exists for completed code changes and references the Scout item when the Scout execution workflow or repo policy requires a commit; otherwise the exact reason no commit was created is recorded.
6. Push, staging deploy, and staging acceptance were completed when they were authorized, repo-safe, and a canonical staging path existed; otherwise the exact blocker is recorded in Scout.
7. Scout has structured evidence plus Russian notes covering start, root cause when relevant, completion or blocker, verification, commit/branch/PR/deploy references, status change, and remaining risks.
8. The Scout status reflects reality: `changes_requested` when human/audit rejection is waiting to be addressed, `in_progress` while working or blocked on clarification, `review` when committed work needs target/human review or that review is underway, `done` only after AI/operator acceptance evidence and before human acceptance, `verified` only after human acceptance, and no silent "left for later" work.
9. Do not send the final user response while an authorized deploy, verification PTY, Scout status update, or queued follow-up step is still running and the next step is available. Continue until it exits and complete the remaining Scout handoff, or record a concrete blocker only when progress is technically blocked or unsafe.

Final user response must be short and evidence-based:

- Item chosen and why.
- What changed.
- Verification run after the final change.
- Scout updates made.
- Commit created and Scout item reference used, or exact reason no commit was created.
- Push, deploy, and staging verification performed, or exact reason each was not possible.
- Anything not completed, with the exact blocker. If nothing remains, say so explicitly.

## Scout API Use Patterns

Authenticate with `Authorization: Bearer $SCOUT_API_KEY`. Use the `Configuration` prefix above only inside the command process. Live OpenAPI is the only source for endpoint method, runtime URL, request body, and response shape.

Build Scout API URLs exactly once from OpenAPI before any project or item call. OpenAPI path keys are relative to `servers[0].url`; the current server path is normally `/api`, so the documented path `/projects/list` becomes runtime URL `$SCOUT_URL/api/projects/list`. Do not first try `$SCOUT_URL/projects/list` and then retry with `/api`; that 404 is avoidable.

Recommended Node helper shape:

```js
const scoutBase = process.env.SCOUT_URL.replace(/\/$/, '');
const spec = await (await fetch(`${scoutBase}/api/docs/openapi.json`, { headers })).json();
const apiBasePath = (spec.servers?.[0]?.url || '/api').replace(/\/$/, '');
const apiUrl = (openApiPath) => `${scoutBase}${apiBasePath}${openApiPath.startsWith('/') ? openApiPath : `/${openApiPath}`}`;

async function post(openApiPath, body) {
  const res = await fetch(apiUrl(openApiPath), { method: 'POST', headers, body: JSON.stringify(body) });
  // handle .data / errors according to this section
}
```

Pass documented OpenAPI paths such as `/projects/list`, `/items/list`, and `/items/get` into this helper. Do not pass runtime paths such as `/api/projects/list` into a helper that already prefixes `servers[0].url`.

Rules:

- At the start of every Scout run, fetch `$SCOUT_URL/api/docs/openapi.json`, compute the API base from `servers[0].url`, and reuse that helper for all calls.
- Use the method and JSON body shown by live OpenAPI. Do not infer REST-style paths, query-string item lookups, or payload fields from endpoint names.
- Read successful JSON payloads from `.data`. For lists, read `.data.items` and `.data.pagination`.
- If a Scout API call returns `text/html`, a dashboard page, or `API_ENDPOINT_NOT_FOUND`, stop. Re-read live OpenAPI and retry only with the documented endpoint/method/body.
- Resolve `SCOUT_PROJECT_SLUG` once at the start of the run through the documented `/projects/list` endpoint: find a project whose `slug` equals `SCOUT_PROJECT_SLUG`, then use that project's `id` as the internal `projectId` for item listing and counting. If no listed project matches the slug, stop with a precise missing-access or wrong-slug blocker.
- Fetch the full item with the documented `/items/get` endpoint before code edits or status changes.
- Use `/api/items/claim`, `/api/items/add-note`, `/api/items/link`, `/api/items/add-evidence`, `/api/items/update-status`, `/api/items/resolve`, `/api/items/request-changes`, and `/api/items/reopen` only when the status/evidence rules above allow that action. `/api/items/verify` is for explicit human acceptance, not normal AI completion.
- Scout API schemas use optional string fields, not nullable string fields. Omit absent optional strings instead of sending `null`, especially refs, URL/result fields, risks, branch, PR/MR, commit and deploy fields.
- Use one atomic `/api/items/update-status` or `/api/items/resolve` call with an inline `evidence` object when moving to `review` or `done`.
- For `/api/items/resolve`, use evidence `kind:"verification"`.
- Include `mrUrl` only as a real PR/MR URL. Put local commit SHAs in Scout notes/evidence, not in `mrUrl`.
- Build payloads with `jq -n`, delete empty/null fields before sending, and keep secrets/cookies/raw private payloads out of notes and evidence.

## Boundaries

- Do not run polling or background automation in this manual workflow.
- Do not mutate unrelated Scout items.
- Do not delete user/reporter Scout data, screenshots, recordings, production volumes, or business data.
- Remove agent-created disposable verification artifacts before completion when they were created only to test the workflow: record the exact ids and evidence first, then delete the narrowest synthetic Scout item/error group/bridge job or fixture through the safest available path.
- Do not use destructive Git or deploy commands unless explicitly requested and safe.
- Do not bypass repo safety rules, checks, or browser verification requirements.
