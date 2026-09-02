# Supervised Worker

Evidence-gated queue execution for GitHub Copilot.

Supervised Worker is a small Agent Plugins 1.0 package that helps an existing
GitHub Copilot agent finish a bounded task or authenticated issue queue without
mistaking activity for completion. Copilot still plans, edits, runs tools, and
reasons. This plugin supplies durable state, queue semantics, review discipline,
metadata-only lifecycle records, and a bounded completion gate.

> Status: `0.1.1-alpha.1`. Suitable for local evaluation in trusted
> repositories. It is not yet a security boundary or an unattended production
> scheduler.

## Why It Exists

Long-running coding sessions commonly fail between otherwise-correct steps:

- one completed issue is reported as a completed backlog;
- a failed enumeration is mistaken for an empty queue;
- an architecture decision is needlessly returned to the user;
- a reviewer validates the changed component but not its consumer;
- passing test output disappears with a temporary worktree;
- the pushed commit differs from the reviewed commit;
- useful lessons remain trapped in one conversation.

Supervised Worker makes those transitions explicit and inspectable.

## What It Provides

- A preferred namespaced `seangalliher-supervised-worker` agent that owns queue
  and release state, plus the established `supervised-worker` compatibility selector.
- Namespaced `Supervised Architect`, `Supervised Builder`, and `Supervised Diff
  Reviewer` companion agents with non-overlapping authority.
- A `governed-queue` skill with a durable plan and banking contract.
- A typed, hash-bound contract for architecture, build, and review handoffs.
- Cross-platform lifecycle hooks for recovery, metadata-only run ledgers,
  compaction markers, plan ownership, and bounded Stop enforcement.
- A runtime-dependency-free Node helper with repository validation and plan status.
- Constitutional policy and schemas for future evidence-gated learning. The
  alpha does not yet capture outcome episodes or activate learned procedures.

## Product Boundary

Supervised Worker is a governance layer, not a coding runtime. It does not ship
an LLM client, execute an autonomous model loop, poll trackers in a daemon,
manage a worktree fleet, or replace GitHub Copilot.

The alpha helper records only lifecycle and tool-result metadata. It does not
store prompts, command arguments, source code, or tool output.

## Role-Separated Execution

The main worker remains the sole queue governor and durable-state owner:

```text
Supervised Worker
|-- Supervised Architect ----> verified build contract
|-- Supervised Builder ------> bounded changes + provisional build report
`-- Supervised Diff Reviewer -> frozen-tree consumer review
```

The Architect and Diff Reviewer are read-only. The Builder may edit only files
listed in an approved contract. Companion agents never edit `.supervised-worker`,
stage files, commit, push, close issues, or attest queue completion. Simple local
changes may stay in the main worker; it still creates compact contract and build
artifacts before independent review.

Delegated builds run in a clean isolated worktree. Final verification rejects
unstaged tracked changes, non-state untracked files, staged paths omitted from
the build report, and reported changes outside `targetFiles`. This is a release
evidence boundary, not a sandbox against a compromised same-user process.
Because companions have no shell tool, the main Worker runs executable checks.
It may return their evidence to the Builder or author the final build report
itself; a Builder without supplied results must report validation as pending.

Companion responses conform to the [role handoff
schema](schemas/role-handoff.schema.json). The main worker persists validated
summaries under a directory derived from `sha256(itemId)`, then binds the build
report to the contract hash and the review report to both artifact hashes plus
the frozen staged-tree hash. The agents do not pin model names. A different
reviewer model family is preferred when available, but context isolation is the
required independence boundary.

The preferred main ID is `seangalliher-supervised-worker`; the established
`supervised-worker` ID remains available for backward compatibility. Both enforce
the same policy, with selector-specific provenance and `producedBy` identity.
All new IDs use the `seangalliher-supervised-*` publisher prefix to reduce
accidental collisions. GitHub Copilot uses first-found-wins precedence, so a
project or user agent can still shadow any plugin agent with the same filename.
Before a governed run, inspect `/env` and verify the selected agent is sourced
from this plugin. This provenance check is operational hygiene, not a security
boundary against a malicious same-user repository.

## Local Evaluation

Requirements:

- GitHub Copilot CLI 1.0.74 or newer for Agent Plugins v1 manifest support,
  the custom agent, and lifecycle hooks
- An Agent Plugins 1.0 host can load the portable `governed-queue` skill
- Node.js 20 or newer for the alpha helper
- PowerShell 7 or newer (`pwsh`) when running Copilot CLI on Windows
- Git for normal coding workflows

Clone and validate:

```bash
git clone https://github.com/seangalliher/supervised-worker.git
cd supervised-worker
npm ci
npm test
npm run validate
```

Load the checkout directly in a supported Copilot CLI:

```bash
copilot --plugin-dir=/absolute/path/to/supervised-worker --agent=seangalliher-supervised-worker
```

Existing integrations may continue using `--agent=supervised-worker`.

From an interactive Copilot CLI session, a GitHub-hosted plugin can also be
installed with:

```text
/plugin install https://github.com/seangalliher/supervised-worker
```

The immutable release and marketplace installation path will be documented when
the first public alpha is tagged.

## Durable Plan

For a queue or multi-step task, the agent creates:

```text
.supervised-worker/
|-- plan.json
|-- handoffs/<sha256(itemId)>/
|-- runs/
`-- runtime/
```

Keep this directory untracked. `plan.json` is the durable source of current work
and completion evidence. Run ledgers contain hashes, event names, tool names,
success flags, and counters, but no raw tool payloads.

Handoff files contain typed summaries, source paths, commands, and evidence
locators. They must not contain raw issue bodies, prompts, tool payloads,
credentials, or source contents.

The session that creates or updates `plan.json` through a file-editing tool is
attached to the plan. Other Copilot sessions in the repository remain inert:
they are not logged and their Stop events are not blocked.

See [the active example](examples/plan.active.json), [the complete
example](examples/plan.complete.json), and [the plan schema](schemas/plan.schema.json).

## Commands

Run these from the plugin checkout during development:

```bash
npm run validate
npm test
npm run doctor
node src/cli.mjs status
```

`doctor` validates the package and reports durable plan state for the current
directory. The lifecycle host invokes `hook EVENT` automatically.

The installed helper validates role artifacts without npm runtime dependencies:

```bash
node /absolute/path/to/supervised-worker/src/cli.mjs handoff validate \
  .supervised-worker/handoffs/<item-hash>/build-contract.json
node /absolute/path/to/supervised-worker/src/cli.mjs handoff pre-review \
  .supervised-worker/handoffs/<item-hash>/build-contract.json \
  .supervised-worker/handoffs/<item-hash>/build-report.json
node /absolute/path/to/supervised-worker/src/cli.mjs handoff verify \
  .supervised-worker/handoffs/<item-hash>/build-contract.json \
  .supervised-worker/handoffs/<item-hash>/build-report.json \
  .supervised-worker/handoffs/<item-hash>/review-report.json
```

`validate` reports the SHA-256 of the exact artifact bytes. `pre-review` checks
the contract/report binding, approved file footprint, clean worktree, staged
paths, every contract-required check, and `testedTreeHash` against the current
staged tree before the read-only Reviewer receives a rendered diff. `verify`
adds the review artifact, item and consumer identity, and final clean verdict.

If a prior attached session is known to be stale, run the helper from the target
repository, not the plugin checkout:

```bash
node /absolute/path/to/supervised-worker/src/cli.mjs release
```

This is an explicit recovery operation. Do not release an attachment while its
owning session is still active.

## Completion Gate

The Stop hook is inert when no durable plan exists. For an active incomplete
plan it:

1. blocks the initial stop;
2. blocks one unchanged continuation and tells the agent it is the final bounded
  attempt before release;
3. then releases rather than looping forever and attempts to record
  `completion_unverified_release` before detaching.

Progress changes reset the stagnant-block count, subject to a total per-session
cap. A mechanically complete plan must contain a complete authenticated
enumeration with zero actionable entries and at least one evidence reference.
If the final ledger write fails, release still occurs because an unavailable
ledger must not turn a bounded reliability control into an infinite loop. The
preceding blocked continuation is the portable visible warning.

This is a reliability control, not a defense against a malicious process running
as the same operating-system user.

## Learning Direction

Recursive improvement is deliberately proposal-gated:

```text
typed episodes -> candidate lessons -> shadow procedures -> advisory procedures
                                      `-> policy patch proposals -> human approval
```

Learned procedures can recommend ordering and checks. They cannot grant tools,
widen scope, waive review, satisfy evidence gates, or rewrite installed policy.
Human corrections suspend conflicting advice. See [Architecture](docs/architecture.md)
and [Roadmap](docs/roadmap.md).

## Origins

This project is a standalone spin-off of the operating discipline developed
while building [ProbOS](https://github.com/seangalliher/ProbOS). It has no ProbOS
runtime dependency and does not copy ProbOS application code.

It also learns from the public patterns demonstrated by Planning with Files,
OpenAI Symphony, Ralph, Foreman, and Agent Orchestrator. Their product surfaces
remain distinct; this project focuses on evidence-gated queue governance.

## Security And Privacy

Read [SECURITY.md](SECURITY.md) before using the plugin on sensitive code. Issue
bodies, comments, repository files, tool output, and remembered episodes are
untrusted inputs. Do not enable raw content capture merely to improve learning.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).