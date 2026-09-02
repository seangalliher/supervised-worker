# Evaluation Plan

Supervised Worker should make no reliability claim based only on prompt review or
one successful repository. Claims require reproducible campaigns and negative
tests that would fail against the unprotected behavior.

## Deterministic Tests

- Queue pagination at 0, 1, 99, 100, 101, and 501 issues.
- Authentication, cursor, truncation, and rate-limit failures never report empty.
- Crash and compaction injection at every item-state transition.
- No duplicate banking, push, side effect, or closure after recovery.
- Stale, wrong-HEAD, wrong-remote, missing-review, changed-gate, and reopened-issue
  receipts are rejected.
- Stop state never loops indefinitely; bounded release attempts a durable record,
  and the final blocked continuation carries an explicit unverified-completion
  warning even when the ledger is unavailable.
- Concurrent sessions cannot decrease checked progress or claim one item twice.
- Windows, macOS, and Linux hooks produce equivalent decisions.
- Only the Supervised Worker writes durable plan and handoff state.
- Architect and Diff Reviewer cannot edit; Builder cannot exceed `targetFiles`.
- Invalid contracts, skipped implemented checks, contradictory clean reviews,
  and malformed staged-tree hashes are rejected by the handoff schema.
- Exact-byte hash drift, cross-item reports, consumer drift, out-of-footprint
  files, hidden unstaged/untracked edits, and non-clean final verdicts are
  rejected by the dependency-free runtime verifier.
- Role-pack agents contain no repository-specific terminology or model pins.

## Dogfood Threshold Before v0.1

- three complete queue campaigns;
- at least two repositories;
- at least 25 banked pre-existing items;
- net backlog reduction reported honestly;
- zero premature queue completions;
- zero duplicate closures;
- zero wrong-commit pushes;
- zero unbudgeted issue creation; and
- zero unverifiable release claims.

## Learning Evaluation

Learning remains disabled for behavior changes until a held-out A/B evaluation
has at least 50 matched opportunities. Promotion requires evidence that advisory
procedures reduce rework without increasing policy violations, regressions, user
interventions, or time to validated completion.

Record confidence intervals and all exclusions. A skipped, unavailable, or
non-discriminating evaluation is not a pass.