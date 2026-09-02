# Changelog

## 0.1.1-alpha.1 - Unreleased

- Added namespaced Supervised Architect, Builder, and Diff Reviewer companions.
- Added typed, hash-bound build contract, build report, and review report handoffs.
- Added dependency-free individual, pre-review, and final chain verification
	against exact artifact bytes and the current Git index.
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

## 0.1.0-alpha.1 - 2026-09-02

- Initial Agent Plugins 1.0 package.
- Added Supervised Worker agent and governed queue skill.
- Added durable plan recovery, metadata-only event ledger, and bounded Stop gate.
- Added Copilot CLI and VS Code hook-response compatibility with default Copilot
  plugin discovery paths.
- Added constitutional policy and schemas for future evidence-gated learning.