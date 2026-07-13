# Audit And Batch Workflow

Use this reference only for an explicit audit of completed or human-accepted work, a broad route/role sweep, a large batch, or work that must survive session compaction or restart.

## Audit Boundary

- Auditing is not normal delivery. Do not disturb completed or accepted items unless the user explicitly selected audit, regression, rejection, or reopen scope.
- Evaluate each original acceptance condition independently. Existing notes, code reasoning, route smoke, API checks, and full browser acceptance are different evidence strengths.
- Leave passing work unchanged. Move only confirmed failures or genuinely unconfirmable items through the current live audit/review operation, with exact expected/actual behavior or blocker evidence.
- Do not claim that a batch received full acceptance unless every original scenario was replayed or covered by a documented equivalent.
- Human acceptance remains a human decision even during an audit.

## Durable Ledger

Before broad testing or batch mutations, create a resumable ledger outside the repository under a narrow operator-state path such as `~/.local/state/opencode/scout-ledgers/`.

Record only what is needed to resume safely: item identity, current decision, acceptance scenario, evidence strength, result, relevant change/deploy reference, next action, and mutation outcome. Never store credentials, cookies, raw private payloads, or large logs. Update the ledger after each item or small mutation batch and preserve command/exit/result summaries before cleaning up evidence-producing sessions.

Refresh live Scout state when resuming. Ledger rows are snapshots, not authority.

## Broad Browser Or Route Sweeps

1. Inventory current routes, roles, query-driven states, fixtures, destructive boundaries, and expected-negative cases from the live application and repository.
2. Prefer a controlled headless runner with bounded concurrency over many visible browser contexts.
3. Write incremental results outside the repository so interruption does not erase progress.
4. Stay below application rate limits. Slow and rerun affected cases rather than reporting rate-limit noise as product failures.
5. Classify expected negatives and third-party noise before reporting findings.
6. Reproduce every suspicious result with a small targeted check before mutating Scout.
7. Separate tool/runner failures from application failures and identify which evidence they invalidate.
8. Do not perform destructive or mass-write scenarios without explicit permission and disposable non-production fixtures.

## Batch Mutation Discipline

- Build a per-item readiness decision before any batch transition.
- Keep shared-root implementation and verification cohesive, but write item-specific evidence and apply item-specific mutations.
- Use small serial mutation batches unless the live contract and repository workflow establish another safe mechanism.
- Verify the resulting items and counts after each small batch rather than assuming every request succeeded.
- On rate limiting or transient failure, use bounded retry and re-read current state; do not switch to invented endpoint sequences.
- Continue unrelated safe audit work when one item is blocked.

## Audit Result

Report the selected population, coverage boundary, passes, confirmed failures, blockers, Scout mutations, fixtures left or cleaned up, and items not fully covered with the reason. Keep workflow state separate from test result language and derive all current state names and mutation operations from live OpenAPI.
