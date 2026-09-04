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
- Specialized role maps fail before exact-hash acceptance and after any byte
  change; re-acceptance does not make old handoffs current.
- Duplicate keys, invalid UTF-8, linked authority files, role collisions, Worker
  impersonation, and unmapped producer claims are rejected.
- `producedBy` is treated as an unauthenticated claim until a supported host
  exposes attested subagent identity and profile provenance.
- Version 1 handoffs remain readable only under bundled defaults but cannot pass
  final verification; configured
  workflows require version 2 and an exact accepted hash.

## Dogfood Evaluation

Local exploratory campaigns may run before provider reconciliation ships, but
they cannot satisfy the public-announcement gate with Worker-recorded facts.
The sole authoritative gate, including counted-event denominators, admissible
provenance, campaign receipt rules, and the claim ladder, lives in [Launch
Readiness](launch-readiness.md).

## Learning Evaluation

Learning remains disabled for behavior changes until a held-out A/B evaluation
has at least 50 matched opportunities. Promotion requires evidence that advisory
procedures reduce rework without increasing policy violations, regressions, user
interventions, or time to validated completion.

Record confidence intervals and all exclusions. A skipped, unavailable, or
non-discriminating evaluation is not a pass.