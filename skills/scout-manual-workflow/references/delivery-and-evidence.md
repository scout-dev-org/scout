# Delivery And Evidence Workflow

Use this reference for implementation, verification, review follow-up, Scout transitions, runtime investigation, or evidence handling.

## Intake And Diagnosis

1. Use the live OpenAPI loaded for this run and fetch the full current item before any mutation. Derive every operation and payload from that contract at execution time; refresh OpenAPI only when the contract may have changed.
2. Inspect evidence in the cheapest useful order: item and notes, structured browser/runtime context, screenshot or direct URL, compact recording summary, then full replay or large artifacts only when path, timing, navigation, or missing context requires them.
3. For user-visible reports, reconstruct the user's role, entry state, action sequence, navigation, and final visible outcome. Browser evidence is primary; API, logs, and database reads support diagnosis.
4. For linked runtime errors, inspect the current error context and targeted telemetry needed to confirm root cause or recurrence. Keep raw private logs and payloads out of Scout.
5. Trace the real code and data flow to root cause. Compare established nearby behavior and map only the adjacent roles, inverse actions, empty states, permissions, or downstream reads needed for a complete fix.

## Acceptance Verification

- Replay the original user journey for visible work. For mutations, verify the resulting UI and the downstream read or persisted state when relevant.
- Name any unchecked surface honestly; supporting smoke checks do not replace item-specific acceptance.

## Evidence And Transitions

Structured evidence is the transition gate. It must identify what environment and scenario were checked, what action occurred, what was observed, how that observation covers this item, and any relevant change/deploy reference or remaining risk. These are semantic requirements, not API field names; derive the current fields and allowed values from live OpenAPI.

Before a transition, ownership change, destructive update, or mutation after waiting/external activity, re-read the item's current state and choose the live documented operation that matches the intent. Consecutive note/evidence writes may reuse the current record while no concurrency signal exists:

- Start ownership only when active work begins and completion evidence does not already exist.
- Hand off for review only when implementation and local verification are complete, the repository's required change reference exists, and target acceptance cannot safely finish in this run. Attach fresh item-specific evidence in the transition operation.
- Complete AI/operator work only through the current live AI/operator completion operation with inline passing acceptance evidence. Never pre-claim or pre-transition an item solely to prepare completion.
- Treat AI completion as ready for human acceptance, not accepted closure. Perform human acceptance only after explicit user instruction, using the current operation from live OpenAPI.
- Use the live purpose-built rejection or reopen operations only for explicit human review, audit, or regression intent; do not synthesize those outcomes through a generic status update.
- Supplemental notes or evidence may clarify an existing state, but do not churn state merely to rewrite metadata.

If the required evidence does not exist and the core fixture norm cannot satisfy the acceptance precondition, record the precise blocker and leave the honest state unchanged.

## Handoff

Write concise Scout notes in the item's/project's working language, Russian by default. Record result, strongest fresh evidence, current outcome, relevant change/deploy reference, remaining risk, and exact next action. Avoid step logs, private paths, raw payloads, schemas, stack traces, and speculation.

The final chat response should be shorter than the durable Scout handoff and state only what changed, what was freshly verified, what Scout mutations occurred, the relevant change/deploy result, and what remains blocked.
