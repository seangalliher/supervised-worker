# Supervised Worker

Evidence-gated queue execution for GitHub Copilot.

Supervised Worker is a small Agent Plugins 1.0 package that helps an existing
GitHub Copilot agent finish a bounded task or authenticated issue queue without
mistaking activity for completion. Copilot still plans, edits, runs tools, and
reasons. This plugin supplies durable state, queue semantics, review discipline,
metadata-only lifecycle records, and a bounded completion gate.

> Status: `0.1.2-alpha.1`. Suitable for local evaluation in trusted
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

- A preferred `seangalliher-supervised-worker` agent that owns queue and release
  state, selected as `supervised-worker:seangalliher-supervised-worker` in
  Copilot CLI, plus the established `supervised-worker` compatibility definition.
- Namespaced `Supervised Architect`, `Supervised Builder`, and `Supervised Diff
  Reviewer` reference agents with non-overlapping authority and repository-level
  mapping to specialized replacements.
- A `governed-queue` skill with a durable plan and banking contract.
- A typed, hash-bound contract for architecture, build, and review handoffs.
- Cross-platform lifecycle hooks for recovery, metadata-only run ledgers,
  compaction markers, plan ownership, and progress-sensitive Stop enforcement.
  After two blocked Stops at the same canonical valid-plan state, the following
  Stop fails open visibly. A changed canonical valid-plan state resets that
  bound; invalid plans share one stable state until repaired.
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

The preferred filename ID is `seangalliher-supervised-worker`; the established
`supervised-worker` ID remains available for backward compatibility. Copilot CLI
qualifies plugin agents with the plugin name, yielding
`supervised-worker:seangalliher-supervised-worker` and
`supervised-worker:supervised-worker`. Both definitions enforce the same policy,
with selector-specific provenance and `producedBy` identity. Other hosts may
expose raw filename IDs and apply project or user precedence. Before a governed
run, inspect `/env` and verify the selected agent is sourced from this plugin.
This provenance check is operational hygiene, not a security boundary against a
malicious same-user repository.

### Specialized Roles

Repositories can map the three companion roles in the protected workflow file
`.github/supervised-worker.json`:

```json
{
  "roles": {
    "architect": "architect",
    "builder": "builder",
    "reviewer": "diff-reviewer"
  }
}
```

The file is a complete workflow document, not only this fragment. Start from
[the specialized example](examples/workflow.specialized.json), then inspect the
effective mapping from the target repository. Repository agents normally use a
raw filename-derived selector such as `architect`; plugin agents use a qualified
selector such as `company-tools:architect` in Copilot CLI.

```bash
node /absolute/path/to/supervised-worker/src/cli.mjs workflow roles
```

Repository overrides fail closed when invalid and return a `workflowHash` that
must be explicitly accepted by the user before use:

```bash
node /absolute/path/to/supervised-worker/src/cli.mjs workflow accept <workflowHash>
```

Every handoff records that hash, so old artifacts cannot be replayed under a
newly accepted mapping. Specialized agents must preserve the
reference role's authority and typed handoff contract. See
[Customizing Companion Roles](docs/customizing-roles.md).

## Local Evaluation

Requirements:

- GitHub Copilot CLI 1.0.74 or newer, or a current VS Code build with Agent
  Plugins enabled
- An Agent Plugins 1.0 host that can load the portable `governed-queue` skill
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

Install a content-addressed local copy for VS Code:

```bash
npm run install:local
```

The command returns `installRoot`. Register that exact path in VS Code user
settings:

```json
{
  "chat.plugins.enabled": true,
  "chat.pluginLocations": {
    "/absolute/installRoot/from-the-command": true
  }
}
```

Reload the VS Code window, select the plugin-provided preferred Supervised
Worker agent, and inspect the Agent Debug Log to verify its agents, skill, and
hooks came from `installRoot`. VS Code reads the Copilot-specific components
from `com.github.copilot/`. The generated Windows commands carry absolute paths
to the installed launcher and the Node executable, and execute correctly when
the host uses either PowerShell or `cmd.exe`. They never discover helper code
from the task workspace. The shell clears `NODE_OPTIONS` and GitHub credential
variables before Node starts.

The checkout manifests require a host-provided `PLUGIN_ROOT` and fail visibly
when it is absent. Do not register the checkout directly in VS Code 1.136,
which does not provide that trusted root. Re-run `npm run install:local` after
changing plugin source and update `chat.pluginLocations` to the newly returned
content-addressed path.

Load the checkout directly in a supported Copilot CLI:

```bash
copilot --plugin-dir=/absolute/path/to/supervised-worker --agent=supervised-worker:seangalliher-supervised-worker
```

Use `/env` after startup to verify the Worker, companion agents,
`governed-queue` skill, and lifecycle hooks came from this plugin. Hosts that
expose unqualified plugin IDs may continue using `--agent=supervised-worker`.

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

Protected edit targets must be fully qualified. When VS Code reports the plugin
root as the hook cwd, the first absolute plan edit writes a metadata-only
session locator beneath that window's `workspaceStorage` directory. Later
targetless hooks use the locator only when its session hash and random claim
generation match the repository's own attachment. The claim starts provisional,
is promoted after a successful plan write, and leaves a released routing
tombstone when detached. No transcript content is read or retained.
Because VS Code Copilot Chat 0.64 drops `PostToolUseFailure`, the supported
`PostToolUse` hook verifies that a plan-targeting edit actually created
`plan.json`; a missing plan is recorded as failure and releases the provisional
claim. If ownership-state cleanup fails, the hook says so and leaves the claim
recoverable instead of reporting release.
VS Code 1.136 also drops the packaged `PreToolUse` matcher. Non-writer
invocations therefore return immediately in the helper before locality checks,
workspace routing, or lock creation.
Hook path inspection accepts at most 256 unique targets per invocation and
deduplicates repeats before touching the filesystem.
Windows evaluation is limited to local drive-letter storage; UNC,
network-mapped, and `subst` repository roots fail closed before filesystem
inspection. Locality checks share a 1.5-second budget and allow at most three
distinct drive letters per operation.

Session locks are never reclaimed automatically. If a hook process terminates
while holding one, the same session fails visibly until an operator confirms
the owner is stale and removes that hashed workspace-storage lock; unrelated
new sessions use different lock paths.

See [the active example](examples/plan.active.json), [the complete
example](examples/plan.complete.json), and [the plan schema](schemas/plan.schema.json).

## Commands

Run these from the plugin checkout during development:

```bash
npm run validate
npm test
npm run doctor
node src/cli.mjs status
node src/cli.mjs workflow roles
node src/cli.mjs workflow accept <workflowHash>
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
node /absolute/path/to/supervised-worker/src/cli.mjs handoff issue-review \
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
staged tree. `issue-review` atomically establishes a fresh, 24-hour current
attempt for those exact hashes before the read-only Reviewer receives a rendered
diff. `verify` adds the review artifact, item and consumer identity, bounded
timestamp checks, and final clean verdict.
When the accepted workflow requires a reviewer model, `verify` requires
Worker-owned receipts under `.supervised-worker/runtime/model-receipts/` and
rejects fallback, same-family, missing, forged, hash-mismatched, replayed, or
postdated evidence. Receipts bind the review attempt, build report, and staged
tree in addition to the accepted workflow and host-observed model identity.
Any review that supplies `modelResolution` is held to the same receipt check,
even when the workflow does not require a model policy.

If a prior attached session is known to be stale, run the helper from the target
repository's canonical local path, not the plugin checkout or a filesystem
alias:

```bash
node /absolute/path/to/supervised-worker/src/cli.mjs release
```

This is an explicit recovery operation. Do not release an attachment while its
owning session is still active. After release, start a new Copilot session before
attaching this or another repository; the released session route is not rebound.

## Completion Gate

The Stop hook is inert when no durable plan exists. For an active incomplete
plan it:

1. blocks the initial stop;
2. blocks one unchanged continuation and tells the agent it is the final bounded
  attempt before release;
3. then releases rather than looping forever, detaches ownership, and only
  afterward records `completion_unverified_release`.

Canonical valid-plan state changes reset the stagnant-block count; there is no
total per-session ceiling, and the hook does not judge whether a valid state
change is productive. A mechanically complete plan must contain a complete
authenticated enumeration with zero actionable entries and at least one evidence reference.
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