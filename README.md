# Supervised Worker

Evidence-checking backlog workflows for GitHub Copilot.

Give GitHub Copilot a backlog. Supervised Worker keeps the work resumable and
makes its build and review evidence checkable before you trust "done."

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

The current alpha separately validates local completion-record shape and
explicitly invoked build/review/Git-tree handoffs. Stop does not yet consume a
verified handoff receipt. The plugin also does not independently verify GitHub
pagination, remote pushes, CI, pull requests, reviewer identity, or issue
closure as completion evidence. The standalone queue command below returns
unattested interval observations only. See [Launch Readiness](docs/launch-readiness.md) for the evidence
required before broader claims.

The alpha can export a deterministic `local-campaign-receipt` from the current
workspace's plan and metadata-only run ledger. That artifact reports every
provider fact as unavailable and is explicitly **local-only, not
Provider-Verified Completion**.

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
- A runtime-dependency-free Node helper with repository validation, plan status,
  explicit checkpoint/resume, and deterministic local campaign receipt export
  and reconciliation.
- A standalone authenticated, read-only GitHub issue inspection command with
  bounded pagination and metadata-only interval observations.
- Constitutional policy and schemas for future evidence-gated learning. The
  alpha does not yet capture outcome episodes or activate learned procedures.

## Product Boundary

Supervised Worker is a governance layer, not a coding runtime. It does not ship
an LLM client, execute an autonomous model loop, poll trackers in a daemon,
manage a worktree fleet, or replace GitHub Copilot.

The alpha helper records only lifecycle and tool-observation metadata. It does not
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
artifacts before role-separated review.

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
required role-separation boundary.

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
|-- attachment.json
|-- checkpoints/<receipt-byte-sha256>.json
|-- handoffs/<sha256(itemId)>/
|-- locks/lifecycle/
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
route generation match the repository's own attachment. Version 3 attachments
also carry a separate UUID claim generation, including repository-local sessions
without transcript routing. The claim starts provisional,
is promoted after a successful plan write, and leaves a released routing
tombstone when detached. No transcript content is read or retained.
Because VS Code Copilot Chat 0.64 drops `PostToolUseFailure`, the supported
`PostToolUse` hook verifies that a plan-targeting edit actually created
`plan.json`; a missing plan is recorded as failure and releases the provisional
claim. If ownership-state cleanup fails, the hook says so and leaves the claim
recoverable instead of reporting release.
The packaged and installed `PreToolUse` matcher is now `.*`. Every owned tool
invocation, including non-writers, must persist a start before proceeding.
File-write permissions still use only the existing writer vocabulary. A
non-writer follows existing ownership only, never repository paths in its
arguments; an unrelated non-writer creates no state or locks. Hosts that drop
the matcher therefore have the same observation behavior.
Hook path inspection accepts at most 256 unique targets per invocation and
deduplicates repeats before touching the filesystem.
Windows evaluation is limited to local drive-letter storage; UNC,
network-mapped, and `subst` repository roots fail closed before filesystem
inspection. Locality checks share a 1.5-second budget and allow at most three
distinct drive letters per operation.

Session and repository lifecycle locks are never reclaimed automatically.
Owned release retries only a verified `EBUSY` retirement failure, at most three
attempts within a 100 ms monotonic retry budget. Exhausted or ambiguous cleanup
is reported with a typed lifecycle code, even if the preceding operation already
changed state. A denied read-only tool is described as an invocation, not a plan
write. Do not replay side effects on the assumption that cleanup failure rolled
them back.
An already-recorded Stop block remains a block with the cleanup diagnostic;
failure before a primary Stop decision still fails open visibly.

### Recovering A Stranded Lock

Use the installed helper from the affected canonical repository directory, not
from the plugin directory. Recovery is distinct from `release`: it does not
detach, checkpoint, resume, or change the plan, attachment, route, claim, ledger,
Git index, or working files.

1. Run `node <plugin-root>/src/cli.mjs lifecycle inspect` with JSON stdin
  containing `{"scope":"repository"}`. For a routed attachment, also supply
  its exact `session_id` and absolute `transcript_path`. Inspection is read-only
  and does not need the stranded lock. A session lock requires those two anchor
  fields and `"scope":"session"`. Inspect an old token-specific `.retired`
  directory with `"location":"retired"` and its UUID `token`.
2. Require `status: "inspected"` and diagnostic `LIFECYCLE_OWNER_DEAD`. Only an
  `ESRCH` PID observation permits recovery. Live, unknown, malformed, linked,
  or identity-unconfirmed owners must remain untouched. A dead PID alone does
  not identify the historical syscall failure.
3. Run `node <plugin-root>/src/cli.mjs lifecycle recover` with JSON stdin
  containing `expected` set to the complete inspection snapshot and the same
  session anchor fields, when supplied. Do not edit the snapshot. Requests are
  limited to 8 KiB, reject duplicate/unknown keys, and have no force option.
  Any changed binding requires fresh inspection. If both scopes are blocked,
  recover the repository lock first, then inspect the session lock again.
4. Require `status: "recovered"` or `"already-recovered"`, exit code zero, and
  both evidence hashes. Keep `.supervised-worker/lifecycle-evidence/` and the
  permanent nonempty `<lock>.<token>.recovered` directory. Never delete or reuse
  that directory: it prevents a delayed recoverer from moving a new owner.
  External cleanup that empties or replaces a fence is outside this protocol;
  on POSIX an empty destination appearing between the check and rename can be
  replaced, unlike a nonempty retained fence.

After interruption, retain the original request and retry with its returned
`intentHash` when available. Only matching evidence and unchanged bindings can
confirm an already-retired object. `status: "unconfirmed"` and exit code one
are not recovery receipts. Empty or unprovable remnants require investigation,
not manual deletion. Valid legacy owners and explicitly absent attachments are
supported without manufacturing new ownership. Time, transcript size,
compaction, and model selection never authorize reclamation.

See [the active example](examples/plan.active.json), [the complete
example](examples/plan.complete.json), and [the plan schema](schemas/plan.schema.json).

## Commands

Run these from the plugin checkout during development:

```bash
npm run validate
npm test
npm run doctor
node src/cli.mjs status
node src/cli.mjs checkpoint < checkpoint-request.json
node src/cli.mjs resume < resume-request.json
node src/cli.mjs workflow roles
node src/cli.mjs workflow accept <workflowHash>
node src/cli.mjs campaign export
node src/cli.mjs campaign export --format json
node src/cli.mjs campaign export --format markdown
node src/cli.mjs campaign validate <receipt.json>
node src/cli.mjs queue inspect OWNER/REPO --state all
```

`doctor` validates the package and reports durable plan state for the current
directory. The lifecycle host invokes `hook EVENT` automatically.

### Read-Only GitHub Queue Inspection

Queue inspection requires a separately installed native GitHub CLI (`gh.exe`
on Windows, `gh` on macOS/Linux) and existing authentication for `github.com`,
including for public repositories. The operator installs and authenticates gh;
this adapter never installs it, logs in, prompts, or acquires credentials:

```bash
gh auth login --hostname github.com
node src/cli.mjs queue inspect OWNER/REPO --state open
node src/cli.mjs queue inspect OWNER/REPO --state closed
node src/cli.mjs queue inspect OWNER/REPO --state all
```

Run from the target workspace's root. The native executable must resolve from
an absolute PATH entry outside both that workspace and the plugin checkout.
Workspace executables, links resolving into those directories, relative PATH
entries, and batch/shell wrappers are rejected. Existing host authentication
(including `GH_TOKEN` or `GITHUB_TOKEN`) is passed only to gh in a restricted
environment. Host/endpoint overrides, debug output, pagers, prompts, and update
notifications are disabled. Requests use a fixed `github.com` GraphQL query,
JSON variables, and `shell: false`; no query text comes from the command line.

The command accepts exactly `queue inspect OWNER/REPO --state open|closed|all`.
State is mandatory. URLs, traversal, whitespace/control characters, duplicate
or additional arguments, and host/executable/query/output-path options are not
accepted. It enumerates issues, not pull requests, and performs no provider
mutations or local state writes. Only the CLI writes stdout.

Stdout is one validated, two-space JSON `github-queue-observation` with
`schemaVersion: 1`. Exit `0` means `status: "complete"` and `reason: null`;
exit `1` means `status: "unavailable"` with a fixed reason code. Stderr is empty.
Every observation includes the requested `scope` (host, repository, state),
real UTC `startedAt` and `finishedAt`, `consistency: "interval-observation"`,
and `integrity: "unattested"`.

Complete observations contain only authenticated `actor: {id}`, immutable
`repository: {id, nameWithOwner}`, `totalCount`, `pageCount`, and number-sorted
`issues: [{id, number, state, updatedAt}]`. Issue states are `OPEN` or `CLOSED`.
No titles, bodies, comments, credentials, raw errors, or provider payloads are
returned or persisted. Empty success still requires one authenticated terminal
page: `totalCount: 0`, `pageCount: 1`, and `issues: []`.

Unavailable observations discard **all** partial results: `actor`, `repository`,
`totalCount`, `pageCount`, and `issues` are `null`, not empty arrays or zero
counts. Invalid input also has `scope: null`; an internal failure before scope
is established can do so as well. Reasons are limited to `invalid-input`,
`gh-unavailable`, `authentication-unavailable`, `transport-failed`,
`response-invalid`, `provider-error`, `identity-invalid`, `pagination-invalid`,
`limit-exceeded`, `timeout`, and `internal-error`. Classification uses process
codes and validated structure, never error-message text.

The adapter requests 100 issues per page, ordered by creation time ascending.
Every page rechecks viewer and repository identity, total count, issue state,
unique IDs/numbers, and cursor progress. Strict UTF-8, duplicate-free JSON,
selected response shapes, safe integers, and timestamps are validated. Limits
are 100 pages, 10,000 issues, 1 MiB for each subprocess stdout/stderr stream,
8 MiB aggregate stdout, 10 seconds per request, and 60 seconds overall using a
monotonic deadline. The synchronous subprocess has a 2 MiB combined buffering
ceiling; each individual stream must still pass its 1 MiB bound. Opaque IDs
are limited to 512 characters and cursors to 4,096 characters, without assuming
a base64 encoding or lexical ordering. Timed-out children are killed; truncated
output and any cap reached without validated termination are unavailable.
There are no retries.

`inspectGitHubQueue({repository, state}, {transport, clock})` is synchronous.
Tests may supply a transport taking `{query, variables, timeout}` and returning
the buffered `spawnSync` result shape, plus a clock with numeric-millisecond
`wall()` and nondecreasing `monotonic()` readings. Defaults use the real clocks
and native gh. `validateGitHubQueueObservation(value)` returns an empty array
for valid observations or fixed validation-code strings; unknown keys and
versions are rejected. The CLI validates before serialization.

**Complete means validated pagination during an observation interval, not an
atomic snapshot of queue truth.** Concurrent issue changes can escape detection
even when all observed identities and counts agree. This is not signed evidence,
Provider-Verified Completion, queue selection, or the whole v0.2 roadmap.
Inspection does not update plans or receipts, reconcile remote evidence, or
change Stop behavior. All seven campaign provider facts and their unavailable
reasons remain unchanged; launch-verification requirements still apply.

### Explicit Checkpoint And Resume

Invoke these operations from the target repository's canonical local cwd,
using the trusted helper's absolute path when it is installed elsewhere. The
Worker, not a companion role, requests them explicitly. `SessionStart`, Stop,
PreCompact, elapsed time, and context size never initiate checkpointing,
resumption, or automatic session creation.

`status` is read-only. It returns `planHash` (canonical plan content),
`attachmentHash` (exact attachment or tombstone bytes), bounded attachment
identity, and `operations` with explicit orphan-observation status. Use the
current hashes and actual host session ID; these request examples show shapes
with illustrative hashes, not reusable authorization:

```json
{
  "session_id": "source-session",
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "attachmentHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

Send that JSON on stdin to `checkpoint`. For transcript-routed ownership, also
supply the matching host `transcript_path`. It is an anchor, not transcript
content; the helper never reads the transcript. No request-supplied `cwd` or
repository override is accepted. Requests are strict UTF-8 JSON, reject
duplicate and unknown keys, and are limited to 8 KiB. Invalid, stale, or
unconfirmed operations exit `1` without echoing input.

A successful response has `status: "checkpointed"`, `checkpointHash`,
`planHash`, `attachmentHash`, and typed `context`. It is returned only after
the receipt and persistence event are verified, a matching **checkpointed
tombstone** replaces the active attachment, and source route cleanup is
confirmed. The old session is logically detached, although `attachment.json`
still exists. An ordinary plan write cannot consume this tombstone.

Start a fresh host session, then explicitly send this shape to `resume`:

```json
{
  "session_id": "fresh-session",
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "checkpointHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}
```

Use the returned receipt hash and the fresh session's transcript anchor when
available. A successful response has `status: "resumed"` and the same response
fields with the successor attachment hash. A receipt or ledger event alone is
insufficient: resume requires its matching tombstone or that exact session's
already-published successor, an unchanged canonical active plan, and intact
ledger bindings. Retrying the same published successor is idempotent and does
not reset its Stop counters; another session conflicts. After a pre-publication
failure, the tombstone remains resumable. If an interrupted route is incomplete,
use another fresh session or inspect it manually, never delete a replacement
owner to make the request succeed.

For an ownerless active-plan crash recovery only, `checkpointHash: null` reads
the current durable context. It is rejected while any attachment or tombstone
exists; it never releases an owner automatically. If this recovery publishes
ownership but cannot confirm its final event, inspect that owner and its ledger
before further recovery. A known-stale owner requires the explicit `release`
procedure below, not an inferred timeout.

Checkpoint receipts follow the [checkpoint schema](schemas/checkpoint.schema.json)
and contain counts, handoff item hashes, valid Stop counters, source identities,
and bounded operation references. They do not copy goals, titles, prompts,
transcripts, tool arguments/results, or continuation instructions. The queue,
handoffs, staged/unstaged/untracked work, and Git index are not rewritten.
Checkpointing never parks an item, changes `completion: null`, or substitutes
for completion evidence. Stop still enforces the existing incomplete-plan bound.

`tool_started` records a UUID operation and optional domain-separated hash of
the host's `tool_use_id` or `toolUseId`. A terminal observation resolves a start
only when that ID and claim identity identify exactly one invocation. Missing,
reused, or ambiguous IDs, legacy completion-only records, and failed terminal
persistence are not proof of completion. Inspect every `outcome-unknown`
reference against the actual side effect before continuing; recovery never
replays recorded operations. The checkpoint command's enclosing tool can itself
remain unknown because its old-session terminal hook occurs after detachment.
Unavailable observations stay unavailable, never a verified empty orphan list.

Writes use file flushes, atomic publication, and bounded read-back. Interrupted
processes can leave unreferenced receipts, incomplete routes, a resumable
tombstone, or an identifiable successor. These are process-crash recovery
semantics, not a claim of portable power-loss durability or provider verification.

`campaign export` writes only to stdout and defaults to deterministic,
two-space JSON; `--format json` is the explicit equivalent and `--format
markdown` renders the same validated facts. Redirect stdout when a saved copy
is needed. Export exits `0` only when both the plan and run ledger are locally
available. It still renders a partial receipt and exits `1` when either source
is absent, invalid, over limit, or changes during inspection. The command does
not create or mutate `.supervised-worker` state.

The local receipt contains the plugin source identity, canonical plan hash,
hashed item IDs and statuses, and bounded ledger aggregates. It excludes raw
goals, titles, IDs, resume conditions, evidence locators, session identifiers,
transcript paths, tool details, repository paths, prompts, arguments, payloads,
outputs, source, and credentials. `campaign validate` accepts one bounded JSON
file inside the canonical current workspace, validates it, and reconciles it
against exact current local state without echoing the supplied path or content.
See the [schema](schemas/local-campaign-receipt.schema.json) and
[example](examples/local-campaign-receipt.json).

This local artifact is not either phase of the future provider campaign receipt
family. It has no provider canonicalizer, external verifier, public/private
projection, cryptographic seal, provider attestation, completion authority, or
Stop integration.

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

The public launch is evidence-gated too: see the measurable dogfood, provider
verification, campaign-receipt, and demo gates in
[Launch Readiness](docs/launch-readiness.md).

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