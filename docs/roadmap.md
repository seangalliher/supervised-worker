# Roadmap

## Accepted Host Split (2026-09-08)

Immediate: make the Agent Plugin usable with GitHub Copilot in VS Code through
explicitly accepted `local-scoped` assurance. Preserve immutable source, exact-byte
workflow acceptance, sole campaign ownership, independent review, durable evidence,
unknown-outcome handling and bounded checkpoint/resume. Local assurance does not
certify the entire host or promise to override its limits. See
[Host Profiles](host-profiles.md) for the supported contract.

Future: retain the original strong requirements in
[Supervised Worker #11](https://github.com/seangalliher/supervised-worker/issues/11)
and [ProbOS AD-1314/#1379](https://github.com/seangalliher/ProbOS/issues/1379).
AD-1315 through AD-1317 deliver protected host authority/witness, governed effects,
and immutable lifecycle recovery; AD-1318 optionally exposes that harness in VS Code
or alongside Copilot. No local gate counts as strong-host acceptance. The native
VS Code/CLI probes remain evidence of limitations, not a changed result.

## v0.1 - Portable Governance

### Implemented

- Agent Plugins 1.0 package
- Namespaced Architect, Builder, and Diff Reviewer companion agents
- Protected repository mapping to specialized companion agents
- Typed, hash-bound role handoff contract
- Dependency-free staged-tree and cross-artifact handoff verifier
- Cross-platform Copilot lifecycle hooks
- Durable plan and explicit incomplete-queue checkpoint/resume ([#1](https://github.com/seangalliher/supervised-worker/issues/1))
- Documented complete-enumeration and queue-completion contract
- Bounded Stop gate with visible fail-open
- Metadata-only run ledger
- Deterministic local campaign receipt export and current-workspace validation
- Authenticated read-only GitHub queue enumeration with cursor and truncation validation ([#3](https://github.com/seangalliher/supervised-worker/issues/3))
- Bounded lifecycle-lock retirement, typed diagnostics, and snapshot-bound inspect/recover ([#4](https://github.com/seangalliher/supervised-worker/issues/4))
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
before it reaches the Worker. The alpha verifies bounded GitHub issue pagination
as an unattested interval observation, but does not yet reconcile commit pushes,
CI, reviews, closures, or external gate receipts into completion authority. Its
`local-campaign-receipt` reports sanitized local plan and ledger observations
with provider facts fixed to unavailable; it is not Provider-Verified Completion
and has no completion or Stop authority.

## Reliability Architecture

The local delivery tracked by
[#5](https://github.com/seangalliher/supervised-worker/issues/5) completed on
2026-09-09. The [real canary](https://github.com/seangalliher/supervised-worker/issues/6#issuecomment-5609078703)
shipped two pre-existing ProbOS issues, verified both recovery variants, crossed
a checkpoint into a fresh session, and banked a validated completion receipt.
The broader queue remains unprocessed; provider attestation, strong host
activation and uninterrupted operation are not established by that result.
The target is a supervision layer that disappears during routine campaigns,
not a larger coding runtime. Preserve one durable-state owner, explicit
checkpoint/resume, bounded authority, role separation, exact-tree verification,
provider reconciliation, and honest completion. The delivered local foundations
are:

1. Metadata-only tool journaling off the repository campaign-transition lock,
   retaining narrow lossless append serialization
   ([#8](https://github.com/seangalliher/supervised-worker/issues/8)).
2. One generation-bound atomic transition API for plan, attachment, route,
   checkpoint, resume, release, Stop, and recovery mutations
   ([#7](https://github.com/seangalliher/supervised-worker/issues/7)).
3. Worker-invoked Doctor diagnosis and supported capability/snapshot-bound
   recovery through the native local control plane
   ([#10](https://github.com/seangalliher/supervised-worker/issues/10)).
4. A deterministic canonical campaign/release receipt linking validated
   subordinate evidence by hash and preserving unavailable provenance
   ([#9](https://github.com/seangalliher/supervised-worker/issues/9)).
5. A real two-issue checkpoint/resume campaign with zero operator lock recovery
   and measured costs, retaining the crash and one native Continue intervention
   ([#6](https://github.com/seangalliher/supervised-worker/issues/6)).

Routine transient failures should recover within a bounded,
identity-preserving path. Explicit snapshot-bound `lifecycle inspect` and
`lifecycle recover` remain the exceptional fallback, never the normal operator
workflow. Repeated lifecycle failures should simplify the ownership boundary,
not grow a larger fault-simulation framework.

The Worker invokes Doctor for failures in the supervision machinery itself.
Doctor is an on-demand incident responder, not a background daemon or another
durable-state owner. It may investigate novel failures, stabilize a campaign,
and orchestrate an isolated Architect/Builder/Reviewer repair without waiting
for a failure-specific deterministic rule. A small invariant kernel protects
user work, unknown external outcomes, append-only evidence, compare-and-set
ownership, immutable-install promotion, and rollback. Delegated workflow policy
may authorize Doctor to complete that bounded repair and continue the campaign
without an operator relaying rescue commands. Automatic host activation,
rollback and continuation require the stronger host integration retained in
[#11](https://github.com/seangalliher/supervised-worker/issues/11); the current
local upgrade path is a reviewed checkpoint-and-restart handoff.
Transient `LIFECYCLE_OWNER_LIVE` contention that clears without operator action
is bounded backpressure, not a failed canary. A correlated, proven
denied-before-execution invocation may be retried once through the existing
guarded path after ownership is revalidated. The
canary fails on persistent or progress-free contention, unknown side effects,
dead or unverified ownership, or any required operator recovery.

Missing host output does not by itself make a proven read-only deterministic
helper unsafe to retry. After reopening and hashing every unchanged input, the
Worker may rerun validation, inspection, rendering, or status exactly once and
correlate both attempts. Commands that can mutate state, provider data, Git, or
external systems remain non-replayable until their outcome is independently
classified.

Reliability work also follows these operating rules:

- Exactly one Worker and lifecycle-hook authority may be active for a campaign.
	Native setup must operationally check for agents and legacy Stop hooks
	that shadow the selected immutable plugin before ownership is claimed.
	Local admission does not establish a complete host inventory.
- Companion roles never read or write `.supervised-worker`. The Worker validates
	durable artifacts and supplies bounded contents plus hashes to the Architect,
	Builder, and Reviewer; a companion denial is role enforcement, not ownership
	failure.
- Doctor is an exceptional control-plane role, not a campaign companion. It
	receives an incident-scoped capability and returns typed diagnosis and repair
	evidence; deterministic rescue primitives perform durable mutations, and the
	Worker remains the sole durable campaign-state owner.
- Cross-platform tests assert observable identity and transition behavior, not
	incidental inode, link-count, timer, or scheduler representations. Cheap
	Windows, macOS, Linux, and Node-version probes run before extensive release
	evidence is assembled.
- Campaign evaluation reports productive Worker/model time separately from
	supervision overhead such as hook contention, recovery, evidence compilation,
	review, and broad gates.
- A checkpoint completes a host session handoff, never the campaign. Only a
	complete authenticated queue observation with no actionable remainder can
	satisfy campaign completion.

## v0.2 - Provider-Verified Completion

- Pull request, CI, review, and issue-state reconciliation
- Accepted-key Ed25519-sealed evidence receipts
- Host-attested append-only operation witness
- Host-attested reviewer identity and profile provenance
- Remote branch and pushed-commit reconciliation
- Provider campaign evidence/outcome receipt export with verified-versus-recorded provenance
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
- automatic policy, authority, completion-criteria, or active-install rewriting
- semantic vector store
- worktree fleet and dashboard
- production deployment automation

See [Launch Readiness](launch-readiness.md) for the named milestones, claim
ladder, authoritative dogfood gate, launch assets, and work that should not be
built before the provider-verified public announcement.