# Changelog

## 0.1.2-alpha.1 - Unreleased

- Add an owner-bound native Doctor control-plane entry for local-scoped recovery
	when the ordinary session lock is dead. Admit only the exact immutable
	root-bound `--request-base64` command or a current hash-bound Doctor consultation; retain
	ordinary denial, independent incident transactions, capability checks and
	unknown-effect non-replay. Keep stdin and strict-host compatibility unchanged.
- Added `handoff record-model` for owner-checked model receipt publication.
	Keep runtime file edits denied, bind publication to the current staged build
	and issued review attempt, preserve superseded evidence, and retain the
	existing final handoff/model-policy checks and recorded-provenance ceiling.
- Scope routine CI to Windows on Node 20, 22 and 24 during the Windows-first
	Copilot-local canary. Keep the complete cross-platform matrix for tags and
	explicit `full` workflow dispatch; strict promotion and public release gates
	continue to require all nine jobs.
- Declare the Worker's native delegation tool set and verify tool/model
	prerequisites before admission; required model selectors must be explicit.
- Let local-scoped hooks share one bounded acquisition wait across lock scopes:
	ten seconds on Windows and one second elsewhere. The installed eight-way Windows
	probe is covered; larger bursts or slower hosts can still exhaust the budget.
	Preserve live-owner refusal, immutable authority revalidation and legacy bounds.
	- Use Node's native Windows canonicalizer in the repeated state-path guard,
	  retaining uncached per-segment link and containment validation while reducing
	  serialized hook work. Keep the eight-way timing probe opt-in; the ordinary
	  test gate exercises the acquisition threshold with a controlled monotonic clock.
- Added explicitly accepted `local-scoped` authority for the VS Code Agent
	Plugin, binding immutable source, workflow bytes and the real session locator.
	Existing workflows retain the strict host-inventory profile. Local admission,
	incomplete-plan Stop, checkpoint/resume and exact dead-lock Doctor recovery
	use the existing single-owner kernel; admitted calls fail closed after authority
	drift. Status distinguishes configured assurance from evidence not checked.
	Whole-host assurance and automatic host replacement remain separately planned.
- Centralized lifecycle writes behind one generation-bound compare-and-set
	owner while preserving #8's separate metadata journal boundary. Added typed
	plan observation/publication and capability-bound out-of-band rescue.
- Split plugin-wide protected mutation denial from owning-Worker lifecycle and
	Stop behavior. Ordinary and checkpointed chats are inert; production startup
	requires a single trusted host authority inventory and a verified immutable
	installation. Legacy state remains readable but does not confer that grant.
- Changed `npm test` to run every test file and report an aggregated list of
	failing files instead of stopping at the first one. A single early failure
	previously hid every later test file and skipped `npm run validate`, which
	made a partially executed run look like a passing one.
- Added deterministic, stdout-only `local-campaign-receipt` JSON and Markdown
	export plus safe current-workspace validation. The artifact exposes sanitized
	plan and bounded ledger observations, fixes all provider facts to unavailable,
	and is explicitly not Provider-Verified Completion or a Stop input.
- Added Agent Plugins v1 GitHub Copilot extension copies under
	`com.github.copilot/`, with byte-parity validation against the legacy root
	agent and hook locations.
- Added a content-addressed local installer with absolute trusted launch paths,
	fail-closed checkout manifests, and a workspace-scoped session locator so
	targetless VS Code lifecycle events reach the repository attachment selected
	by the first absolute protected edit.
- Length-framed installer file-tree hashes, bumped the installation format, and
	rejected tampered reuse even when a mutable installation record is resealed.
- Bound installed launch identity to Node, platform, and canonical system
  PowerShell; cleared `NODE_OPTIONS` before Node startup; and rejected linked
  install ancestors before creating child directories.
- Canonicalized each unique edit target once, routed junction and Windows
	trailing-dot aliases through the protected-path guards, and rejected target
	sets above 256 before filesystem inspection.
- Rejected UNC, network-mapped, and `subst` roots before synchronous Windows
	path inspection, keeping deny responses within the packaged hook deadline.
- Added generation-bound provisional claims, workspace-scoped session locks,
	successful-write promotion, interrupted-release reconciliation, and released
	route tombstones for detectable cross-file recovery.
- Added a 250 ms monotonic retry deadline for overlapping same-session lifecycle hooks so
	parallel tool completions do not emit false PostToolUse warnings; persistent
	locks remain authoritative and are never reclaimed automatically.
- Bound lock ownership to an open UUID-named owner file, atomically retired the
	canonical lock directory before cleanup, and confined deletion to the
	token-specific retired path. Concurrent acquisitions and ambiguous
	replacements are never deleted through the live lock name; same-user races on
	the retired path remain outside the alpha threat model.
- Moved potentially blocking Windows drive-locality checks before session lock
	acquisition and required stable nonzero device/inode identity, preventing a
	healthy hook from holding the lock beyond the overlap window.
- Accepted canonical-equivalent host cwd spellings such as macOS `/var` and
	`/private/var`, handled POSIX `ENOTDIR` during recoverable state setup, and
	kept protected target aliases denied.
- Raised generated Windows immutable-install hook timeouts to fifteen seconds so
	the nested trusted PowerShell launcher can complete on cold hosts, while
	retaining five seconds elsewhere. Shell integration tests enforce the host's
	native product deadline while compatibility launchers run inside independent
	process-tree-aware watchdogs.
- Disabled automatic stale-lock takeover, restored missing binding markers
	before visible failure, and restricted explicit release to canonical local
	repository roots.
- Reconciled absent plan files in `PostToolUse` because VS Code Copilot Chat
	0.64 does not dispatch `PostToolUseFailure`, preventing false promotion of a
	failed first plan write.
- Added state-free runtime filtering because VS Code 1.136 drops the packaged
  `PreToolUse` matcher, and made every release path report cleanup-write failure
  without claiming ownership was released.
- Replaced the six-Stop session ceiling with a canonical valid-plan state bound:
	a changed valid state resets the counter, invalid plans cannot churn it, and
	the Stop after two unchanged blocks still fails open visibly.
- Versioned the Stop-state hash algorithm, migrated matching legacy hashes
	without resetting counters, and made completion audit hashes canonical.
- Switched bundled CLI role defaults to `plugin-name:agent-id` selectors, allowed
	qualified specialized roles, and retained raw v1/v2 producer compatibility.
- Added hash-bound reviewer model requirements and host-evidenced model receipts;
	clean review now fails when an exact model falls back, required families match,
	or the Worker-owned receipt is absent, forged, or hash-mismatched.
- Added runtime-issued review attempts bound to the build report and staged tree;
	final verification rejects rotated, expired, future-dated, or replayed model
	evidence.
- Verified every supplied `modelResolution` receipt during the final handoff
  chain and rejected different-family-only policies without a required reviewer
  model and family.
- Added namespaced Supervised Architect, Builder, and Diff Reviewer companions.
- Made bundled companions reference implementations and added protected,
	hash-identified repository mapping to specialized role selectors.
- Added user-executed exact-byte workflow acceptance and bound every handoff to
	the accepted hash, including rejection before acceptance and after reconfiguration.
- Introduced handoff schema version 2 for workflow-hash binding while preserving
	version 1 artifacts as migration-readable under bundled reference roles; final
	verification requires a version 2 review bound to the current attempt.
- Rejected duplicate-key and invalid UTF-8 authority files, constrained mappings
	to raw or plugin-qualified filename-derived agent IDs, and documented
  `producedBy` as self-declared.
- Replaced acceptance records atomically after fsync, validated strict calendar
	timestamps, aligned Unicode length semantics, and made malformed CLI commands fail.
- Enforced exact CLI arity before lifecycle commands can mutate attachment state.
- Added typed, hash-bound build contract, build report, and review report handoffs.
- Added dependency-free individual, pre-review, and final chain verification
	against exact artifact bytes and the current Git index.
- Resolved Git to an absolute executable outside the target repository before
	handoff checks, preventing a workspace-planted `git.exe` from executing.
- Removed shell execution from companion roles and added owner-only durable-state
	and direct Git-metadata edit guards.
- Hardened protected paths against junctions, device namespaces, hard links,
	mapped-drive aliases, case-only renames, and dangling links.
- Compared resolved workspace prefixes by filesystem identity, accepting aliases
	that identify the same directory while rejecting distinct case-sensitive roots,
	redirected handoff roots, item directories, identity substitution, and
	hard-linked artifacts.
- Bound every contract-required check to the exact staged tree tested before
	review.
- Added the preferred `seangalliher-supervised-worker` selector while preserving
	the established `supervised-worker` compatibility selector, and enforced policy
	parity between them.
- Admitted both Worker selector identities as build-contract and build-report
	producers across the published schema, runtime validator, and all CLI gates.
- Added publisher-qualified companion IDs and a host-provenance preflight for
	first-found-wins agent resolution.
- Kept queue state, release actions, staging, and provider closure under the
	Supervised Worker's sole authority.
- Added positive, negative, and authority-boundary tests for the role pack.
- Serialized Node test files with a Node 20.0-compatible runner so process-heavy
	cross-platform hook checks retain their bounded startup assertions without
	contention-driven gate failures.

## 0.1.0-alpha.1 - 2026-09-02

- Initial Agent Plugins 1.0 package.
- Added Supervised Worker agent and governed queue skill.
- Added durable plan recovery, metadata-only event ledger, and bounded Stop gate.
- Added Copilot CLI and VS Code hook-response compatibility with default Copilot
  plugin discovery paths.
- Added constitutional policy and schemas for future evidence-gated learning.