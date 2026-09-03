# Changelog

## 0.1.2-alpha.1 - Unreleased

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
- Disabled automatic stale-lock takeover, restored missing binding markers
	before visible failure, and restricted explicit release to canonical local
	repository roots.
- Reconciled absent plan files in `PostToolUse` because VS Code Copilot Chat
	0.64 does not dispatch `PostToolUseFailure`, preventing false promotion of a
	failed first plan write.
- Added state-free runtime filtering because VS Code 1.136 drops the packaged
  `PreToolUse` matcher, and made every release path report cleanup-write failure
  without claiming ownership was released.
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