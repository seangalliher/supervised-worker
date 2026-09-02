# Roadmap

## v0.1 - Portable Governance

- Agent Plugins 1.0 package
- Cross-platform Copilot lifecycle hooks
- Durable plan and session recovery
- Complete-enumeration and queue-completion contract
- Bounded Stop gate with visible fail-open
- Metadata-only run ledger
- Repository workflow and memory schemas
- Package doctor and cross-platform CI
- Dogfood evidence from real queue campaigns

The alpha in this repository implements the first executable slice. It does not
yet verify GitHub pagination, commit pushes, or external gate receipts itself.

## v0.2 - Operational Reliability

- Authenticated GitHub queue adapter
- Cursor and truncation detection
- Claim leases and concurrent-session protection
- Retry/backoff and stalled-run circuit breaker
- Time, token, and item budgets
- Pull request, CI, review, and issue-state reconciliation
- Independently sealed evidence receipts
- Structured blocked and needs-input states
- Candidate lesson extraction and shadow evaluation

## v0.3 - Evidence-Gated Learning

- Typed episode capture at item banking
- Contradiction and supersession handling
- Bayesian procedure confidence
- Shadow-to-advisory promotion
- Failure and human-correction suspension
- Decay, demotion, and archival
- Replay evaluator over held-out episodes
- Quarantined policy patch proposals
- Outcome-labelled evaluation export

## Deliberately Deferred

- background scheduling daemon
- general-purpose coding runtime
- multi-provider LLM client
- automatic policy or agent rewriting
- semantic vector store
- worktree fleet and dashboard
- production deployment automation