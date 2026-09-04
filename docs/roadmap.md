# Roadmap

## v0.1 - Portable Governance

### Implemented

- Agent Plugins 1.0 package
- Namespaced Architect, Builder, and Diff Reviewer companion agents
- Protected repository mapping to specialized companion agents
- Typed, hash-bound role handoff contract
- Dependency-free staged-tree and cross-artifact handoff verifier
- Cross-platform Copilot lifecycle hooks
- Durable plan and session recovery
- Documented complete-enumeration and queue-completion contract
- Bounded Stop gate with visible fail-open
- Metadata-only run ledger
- Repository workflow and memory schemas
- Package doctor and public cross-platform CI definition
- One-command immutable local install

### Pending Before First Tagged Prerelease

- Green Windows, macOS, and Linux matrix on the exact release commit
- Frozen immutable-install instructions
- Five-minute first governed run

The alpha in this repository implements the first executable slice and the
role-separated companion pack. Persisted responses and their staged candidate
are verified by the helper; the host does not yet reject malformed subagent JSON
before it reaches the Worker. The alpha also does not yet verify GitHub
pagination, commit pushes, or external gate receipts itself.

## v0.2 - Provider-Verified Completion

- Authenticated GitHub queue adapter
- Cursor and truncation detection
- Pull request, CI, review, and issue-state reconciliation
- Accepted-key Ed25519-sealed evidence receipts
- Host-attested append-only operation witness
- Host-attested reviewer identity and profile provenance
- Remote branch and pushed-commit reconciliation
- Campaign receipt export with verified-versus-recorded provenance
- Precommitted evaluation and complete admission/event inventories
- Campaign attribution and public/private receipt projections
- Receipt-to-completion and Stop integration
- Retry/backoff and stalled-run circuit breaker
- Time, token, and item budgets
- Claim leases and concurrent-session protection
- Structured blocked and needs-input states
- Candidate lesson extraction and shadow evaluation

Provider truth, a complete host-witness stream, receipt-to-completion
integration, host-attested reviewer identity, sealed receipts, and a public
campaign report are the provider-verified announcement critical path.
Concurrency, budgets, and lesson extraction improve operation but must not
delay those proof surfaces.

**Provider-Verified Completion** is the capability name. The
**Provider-Verified Public Announcement** is the later milestone reached only
after that capability also passes the authoritative dogfood and launch-asset
gates in [Launch Readiness](launch-readiness.md).

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

See [Launch Readiness](launch-readiness.md) for the named milestones, claim
ladder, authoritative dogfood gate, launch assets, and work that should not be
built before the provider-verified public announcement.