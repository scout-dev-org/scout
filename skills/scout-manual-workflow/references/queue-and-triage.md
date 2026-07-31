# Queue And Triage Workflow

Use this reference only after the core skill selects queue, next-item, note-triage, relationship, or cluster work.

## Build The Live Queue

1. Discover the current project and active workflow through live OpenAPI. Do not use a cached status list or a copied queue mapping.
2. For a single-item run, fetch enough current candidates to compare the relevant work. For explicit full-queue scope, offset pagination is not an atomic snapshot: before the first mutation, require two consecutive complete passes with the same total and ID set, then freeze those IDs and add only dependencies proved from their records. Retry a changed pass only a bounded number of times; if the population never stabilizes, do not claim it is frozen or begin full-queue mutation.
3. Fetch the full current record before claiming, converting, linking, editing, or transitioning an item.
4. Do not take over clearly active work owned by another person unless the user asks or current evidence shows it is abandoned and the workflow permits takeover.

## Choose Work

Prioritize by user harm, security or data risk, blocked core journeys, regression risk, age, and dependency impact. Prefer finishing or correcting existing work over starting unrelated new work when both affect the same surface. Do not starve older useful work merely because newer items are easier.

For single-next scope, choose one item or one evidence-backed shared-root cluster and carry it to the furthest honest outcome. For full-queue scope, continue through every actionable candidate; do not stop after the first success while safe work remains.

## Triage Notes

A note is captured signal, not automatically committed engineering work.

1. Read its current evidence and search for related active work.
2. Infer a task only when the desired outcome, affected surface, and reversible acceptance path are sufficiently clear from product and repository context.
3. When actionable, record the inferred acceptance intent, convert it through the current live contract, and continue as normal work.
4. When not actionable, leave one focused question or blocker naming the missing decision. Link a useful related item when appropriate.
5. Cancel only when current evidence shows the note is duplicate, obsolete, irrelevant, or outside scope, and record why.

Do not guess product requirements through code changes merely to clear a note.

## Relationships And Clusters

Search by affected route or component, visible symptom, error text, environment, regression window, existing branch or change, and captured browser/runtime evidence.

- Treat similar wording as a lead, not proof of duplication.
- Link relationships only when current evidence supports them.
- Cluster work only when items share a root cause, change, deploy target, or acceptance path.
- Keep one cohesive implementation for a true shared root, but verify and update every item against its own reported acceptance condition.
- Keep separate causes as separate work even when they appear on the same screen.
- Escalate incompatible requested outcomes as a product hard gate; continue unrelated safe work.

## Queue Discipline

- Claim or mark active ownership only when implementation or active verification actually starts.
- Keep an internal readiness row for each item that may move: acceptance intent, strongest fresh evidence, unchecked risk, hard gate, and next honest outcome.
- Refresh the queue after meaningful transitions or discoveries, not after every read-only step.
- Do not paste full queue snapshots into Scout notes or chat.
- At the end, every in-scope item must have an honest outcome for this run: completed through the canonical AI path, handed off with evidence, still active with an exact blocker, left as a focused untriaged question, or cancelled for a recorded reason.
