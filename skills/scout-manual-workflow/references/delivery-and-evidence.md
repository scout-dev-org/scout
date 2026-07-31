# Delivery And Evidence Workflow

Use this reference for implementation, verification, review follow-up, Scout transitions, browser/runtime investigation, or provider/deploy work.

## Intake And Diagnosis

1. Use the live OpenAPI loaded for this run and fetch the full current item before any mutation. Derive every operation and payload from that contract at execution time; refresh OpenAPI only when the contract may have changed.
2. Inspect evidence in the cheapest useful order: item and notes, structured browser/runtime context, screenshot or direct URL, compact recording summary, then full replay or large artifacts only when path, timing, navigation, or missing context requires them.
3. For user-visible reports, reconstruct the user's role, entry state, action sequence, navigation, and final visible outcome. Browser evidence is primary; API, logs, and database reads support diagnosis.
4. For linked runtime errors, inspect the current error context and targeted telemetry needed to confirm root cause or recurrence. Keep raw private logs and payloads out of Scout.
5. Trace the real code and data flow to root cause. Compare established nearby behavior and map only the adjacent roles, inverse actions, empty states, permissions, or downstream reads needed for a complete fix.

## Implementation And Verification

- Work in the current target repository and preserve unrelated local changes.
- Follow its canonical branch, package, test, browser, and deployment workflows.
- Fix the relevant class of problem in the correct layer without broad unrelated refactoring.
- Run narrow static checks, then the strongest practical runtime acceptance after the final edit.
- Replay the original user journey for visible work. For mutations, verify the resulting UI and the downstream read or persisted state when relevant.
- Cover the nearest inverse or sibling action only when it shares the changed path or materially reduces regression risk.
- If acceptance needs ordinary non-production data or state, create a scoped disposable fixture, record its identity, verify the flow, and clean up or restore it when safe.
- Name any unchecked surface honestly; supporting smoke checks do not replace item-specific acceptance.

## Evidence And Transitions

Structured evidence is the transition gate. It must identify what environment and scenario were checked, what action occurred, what was observed, how that observation covers this item, and any relevant change/deploy reference or remaining risk. These are semantic requirements, not API field names; derive the current fields and allowed values from live OpenAPI.

Before every mutation, re-read the item's current state and choose the live documented operation that matches the intent:

- Start ownership only when active work begins and completion evidence does not already exist.
- Hand off for review only when implementation and local verification are complete, the repository's required change reference exists, and target acceptance cannot safely finish in this run. Attach fresh item-specific evidence in the transition operation.
- Complete AI/operator work only through the current live AI/operator completion operation with inline passing acceptance evidence. Never pre-claim or pre-transition an item solely to prepare completion.
- Treat AI completion as ready for human acceptance, not accepted closure. Perform human acceptance only after explicit user instruction, using the current operation from live OpenAPI.
- Use the live purpose-built rejection or reopen operations only for explicit human review, audit, or regression intent; do not synthesize those outcomes through a generic status update.
- Supplemental notes or evidence may clarify an existing state, but do not churn state merely to rewrite metadata.

If the required evidence does not exist, satisfy the acceptance precondition yourself when a safe fixture or non-production setup can do so. Otherwise record the precise hard blocker and leave the honest state unchanged.

## Git, Push, And Deploy

Apply the core skill's Hard Gates. This section defines the canonical mechanics after the requested engineering work and repository policy authorize an action.

1. Discover the target repository's current rules before branch, commit, push, or deploy actions.
2. Create and push a focused commit under the target repository and global Git completion policy. Include the Scout reference using the repository's established convention, inspect outgoing history, and never include unrelated changes.
3. Deploy only after the core Hard Gates are satisfied, through the one canonical path for that target.
4. Never invent SSH or another manual fallback when the canonical deploy path is absent or failing.
5. Wait for authorized deploy and verification work to finish, then record the actual result. A successful deploy alone is not item acceptance.

## External Providers And Communication

Before live-money, provider callback, production-like, or other hard-to-undo third-party actions, inspect current onboarding/support context, environment, public endpoint/DNS/network state, sandbox availability, provider prerequisites, and rollback path. Prefer read-only checks, simulation, or sandbox. If the provider never reaches the controlled system, stop repeating stateful attempts and record the provider-side blocker.

Do not send email, chat, support, or provider messages without explicit approval for the exact recipient and substance. Draft first when communication is needed.

## Handoff

Write concise Scout notes in the item's/project's working language, Russian by default. Record result, strongest fresh evidence, current outcome, relevant change/deploy reference, remaining risk, and exact next action. Avoid step logs, private paths, raw payloads, schemas, stack traces, and speculation.

The final chat response should be shorter than the durable Scout handoff and state only what changed, what was freshly verified, what Scout mutations occurred, which authorized git/deploy actions ran, and what remains blocked.
