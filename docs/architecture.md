# Architecture

## Thesis

GitHub Copilot is the executor. Supervised Worker is the governance and memory
layer around it. The plugin should remain useful precisely because it does not
own model inference, editing tools, or a scheduler daemon.

## Components

```text
GitHub issue authority
        |
        v
durable plan <-> Supervised Worker
        |             |-- Architect -> build contract
        |             |-- Builder -> changes + build report
        |             `-- Diff Reviewer -> review report
        |                            |
        v                            v
local verifier <-------------- hash-bound evidence
        |
        +-> bounded Stop decision
        +-> metadata-only lifecycle ledger
        `-> future episode and lesson consolidation
```

### Role Pack

The Supervised Worker carries the operating doctrine: queue completion, bounded
decision authority, evidence banking, and honest absence claims. It is the sole
writer of durable plan and handoff state. It may implement simple local changes
directly, but still records compact build and review artifacts.

Three namespaced reference companions provide context-isolated roles:

- **Supervised Architect:** read-only premise verification and structural design;
  returns an approved or escalation-required build contract.
- **Supervised Builder:** implements one hash-bound approved contract inside its
        exact `targetFiles` footprint and returns a provisional build report. The
        Worker owns executable checks and finalizes the evidence-bearing report.
- **Supervised Diff Reviewer:** read-only adversarial review of the exact staged
  tree through named production consumers.

The companions return JSON conforming to `role-handoff.schema.json`; they do not
write durable state, stage, commit, push, close provider items, or claim queue
completion. Agent files do not pin models. A different reviewer model family is
preferred when available, while context isolation remains mandatory.

The dependency-free workflow resolver reads the optional protected repository
file `.github/supervised-worker.json`. Its complete `roles` map may replace any
reference selector with a specialized agent while preserving the three fixed
authority classes. `workflow roles` returns a SHA-256 over the exact configured
bytes; the user persists acceptance with `workflow accept <workflowHash>`. Every
handoff records that hash, so configuration changes invalidate acceptance and
re-acceptance does not relabel old artifacts. Handoff shape remains schema-defined;
runtime validation checks each self-declared `producedBy` against the effective
accepted role map. That check rejects unmapped claims but is not host provenance
attestation.

Handoff schema version 2 carries `workflowHash`. The compatibility reader accepts
version 1 artifacts only under bundled defaults, where the absent hash means
`null`; a configured workflow never grants old artifacts new authority. Version
1 remains inspectable for migration, but final `handoff verify` requires a
version 2 review report bound to the current issued review attempt.

The preferred filename ID is `seangalliher-supervised-worker`; the established
`supervised-worker` ID remains as a compatibility definition. Copilot CLI
qualifies these as `supervised-worker:seangalliher-supervised-worker` and
`supervised-worker:supervised-worker`. A parity test permits only
selector-specific provenance and `producedBy` identity to differ between them.
Every new role uses the `seangalliher-supervised-*` publisher prefix. The Worker
requires a supported-host provenance check before creating state because
selector text is not identity attestation.

The handoff chain is bound as follows:

```text
build-contract --sha256--> build-report --sha256--+
        |                                         |
        +-----------------------> review-report <-+-- staged-tree hash
```

Persisted artifact reads resolve only the workspace prefix first and compare its
filesystem identity. The helper then inspects `.supervised-worker`, `handoffs`,
the item-hash directory, and the file without following links. Only after those
components are known to be ordinary local paths does it resolve the requested
artifact and compare canonical containment plus exact requested item/file
identity. This accepts operating-system and case-only aliases that identify the
same directory while rejecting distinct case-sensitive roots, redirected handoff
roots, and redirected item directories.

This alpha defines and tests the artifact contract. The dependency-free helper
validates individual persisted responses and verifies cross-artifact hashes,
item and consumer identity, approved versus changed files, and the current Git
index. It also rejects unstaged tracked changes and non-state untracked files in
the clean delegated worktree. Before review it requires every contract-defined
focused check and broad gate to be reported as passed against `testedTreeHash`,
which must equal the current Git index. The Supervised Worker invokes that helper
after persistence; automatic host-level rejection before a subagent response
reaches the Worker is not yet implemented.

Git index checks resolve an absolute Git executable from an absolute `PATH`
entry outside the workspace, run it from that executable's directory, and use
`git -C <workspace>` with external diff, text conversion, and filesystem
monitoring disabled. This keeps repository-local executable lookup out of the
handoff trust boundary.

### Governed Queue Skill

The skill defines the repository-neutral item lifecycle and plan shape. It is
separate from the agent so other Copilot agents can adopt the same queue contract.

### Lifecycle Hooks

The plugin uses PascalCase event names so Copilot CLI emits the VS Code-compatible
snake_case payload. Current events are:

- `SessionStart`: inject bounded counts from an active durable plan.
- `PreToolUse`: create a generation-bound provisional claim for the first plan
        writer and deny later sessions.
- `PostToolUse` and, on supporting hosts, `PostToolUseFailure`: append
        metadata-only events and reconcile provisional plan claims.
- `PreCompact`: record that a context transition is beginning.
- `Stop`: check plan structure and bounded completion conditions.

Checkout hooks resolve code only through a host-provided `PLUGIN_ROOT` and fail
visibly when it is absent; process cwd is never helper authority. VS Code 1.136
local evaluation uses `node src/cli.mjs install` to copy the trusted runtime to a
content-addressed user-data directory and generate commands with absolute Node
and launcher paths. The generated shell clears `NODE_OPTIONS` and GitHub
credential variables before Node starts. The Windows installer validates the
canonical system PowerShell executable and creates each install-base component
only after verifying that its existing parent is not a link. Repository
authority comes from a fully qualified protected edit target, a previously
verified session locator, or the hook payload cwd only when neither is present.
Helper discovery and durable-state ownership therefore remain separate. Each
command has a five-second timeout.
Control responses carry Copilot CLI's top-level fields and VS Code's nested
`hookSpecificOutput` fields. PascalCase `Edit` payloads are inspected for both
ordinary path arguments and `apply_patch` headers before plan ownership is
decided.

VS Code 1.136 does not retain the manifest's `PreToolUse.matcher`, so it invokes
the command for non-writer tools too. The runtime checks the tool name before
locality checks, session-context parsing, or lock acquisition and returns `{}`
without creating state. Hosts that honor the matcher avoid that process launch.

Edit targets are checked lexically and by filesystem identity. The hook denies
device-namespace paths, unresolved link aliases, aliases whose existing
ancestors identify `.git` or `.supervised-worker`, and existing regular files
with multiple hard links. Repository handoff paths use exact case-sensitive Git
identifiers, include both sides of renames, and reject link-bearing footprints.
One invocation may name at most 256 unique edit targets; duplicates are folded
before filesystem inspection, and larger sets fail closed before path traversal.
On Windows, repository and transcript paths must be on local drive-letter
storage. UNC, network-mapped, and `subst` roots are rejected before synchronous
filesystem inspection. Locality checks share a 1.5-second aggregate deadline
and admit at most three distinct drive letters per operation so the five-second
hook deadline remains enforceable.

On Windows, Copilot CLI runs the `powershell` hook field through PowerShell 7
(`pwsh`). The packaged lifecycle test invokes that same host shell.

Under the Agent Plugins v1 manifest, Copilot CLI discovers custom agents from
`com.github.copilot/agents/` and lifecycle hooks from
`com.github.copilot/hooks/hooks.json`. Byte-identical `agents/` and root
`hooks.json` copies preserve compatibility with hosts using the older native
layout, and package validation rejects drift between the two surfaces. The
portable surface remains the closed root manifest plus `skills/`; Copilot's
agent and hook loading is additive client behavior. Copilot CLI 1.0.74 or newer
is required because that release added Agent Plugins v1 manifest support.

### Helper

The runtime-dependency-free Node helper owns deterministic parsing, hashing,
atomic state writes, and bounded Stop state. Development validation uses Ajv and
YAML to check the published Draft 2020-12 schemas, examples, plugin manifest, and
Agent Skills frontmatter. Those development dependencies are not loaded by hook
commands. Node is an alpha prerequisite. Release builds will replace this
dependency with signed platform executables without changing schemas or hook
behavior.

## State And Trust

The state directory belongs to the repository being worked on, not the plugin:

```text
.supervised-worker/
|-- plan.json       # current objective and queue items
|-- workflow-acceptance.json # exact accepted repository role-map hash
|-- handoffs/       # typed summaries below sha256(itemId), never raw provider ids
|-- runs/*.jsonl    # append-only metadata events by hashed session id
|-- attachment.json # session hash, claim generation, and provisional/active status
`-- runtime/*.json  # bounded Stop counters
```

When a review supplies resolved model evidence, runtime state contains
metadata-only model receipts below
`runtime/model-receipts/<sha256(itemId)>/`. The Worker records host-observed
Builder and Reviewer model identities there before review. The final handoff
gate verifies exact receipt hashes and item, role, selector, workflow, review
attempt, build-report, staged-tree, model, family, and chronology bindings
whether the workflow requires a model policy or the review voluntarily supplies
`modelResolution`; copied model strings in an agent response are insufficient.
Immediately before review, `handoff issue-review` also writes the one current
attempt for the item below `runtime/review-attempts/`. It is atomically bound to
the validated contract, build report, and staged tree. Issuing another attempt
rotates the current UUID, and final verification rejects non-current, expired,
or future-dated bundles with a five-minute clock-skew allowance.

The pre-tool hook starts a provisional claim before the first `plan.json` write.
A successful post-tool hook promotes the matching attachment and route
generation to active; a failed write that leaves no materialized plan, or Stop
without one, marks the route released and removes the attachment. Plan recovery,
event logging, and Stop enforcement apply only to the attached session. This
prevents an active queue campaign from interfering with unrelated Copilot
sessions sharing the repository.

VS Code Copilot Chat 0.64 does not dispatch the declared
`PostToolUseFailure` event. Its supported `PostToolUse` path therefore checks
that a plan-targeting tool actually materialized `plan.json` before promotion.
When no plan exists, the hook records failure metadata and releases the
provisional claim. Hosts that dispatch `PostToolUseFailure` use the same release
path directly.

VS Code may assign a plugin or workspace directory as the hook process and
payload cwd. Neither is used to discover executable code. For a fully qualified
protected edit, the helper derives the target repository and stores a small routing record at
`workspaceStorage/<workspace>/supervised-worker/session-roots/<session-hash>/route.json`.
The record contains the session hash, repository root and hash, random claim
generation, lifecycle status, and timestamps; it contains no transcript
content. Targetless events accept an active or provisional route only while the
repository's `attachment.json` carries the same session hash and generation.
Route and attachment transitions are serialized by a workspace-scoped session
lock. An existing lock is never replaced automatically; an abandoned lock fails
visibly and requires operator-confirmed cleanup, while a new session uses a
different hashed lock path. Individual writes are atomic, while the shared
generation and provisional state make a crash between files detectable and
recoverable. A persistent hashed binding marker distinguishes a deleted route
directory from a never-bound session; if an existing route loses its marker,
the hook restores the marker and fails visibly. Normal Stop release removes the
attachment and retains a released route tombstone for later reconciliation. If
writing the tombstone or removing the attachment fails, the hook reports that
cleanup failed and does not claim the ownership was released.

The main worker derives each item handoff directory from `sha256(itemId)`. This
keeps untrusted provider identifiers out of filesystem paths. Handoffs may carry
typed source paths, commands, and evidence locators, but not raw prompts, issue
bodies, tool payloads, credentials, or source contents.

Repository role configuration is strict UTF-8 JSON with duplicate keys rejected.
The user accepts its exact byte hash in `workflow-acceptance.json`; every handoff
copies that hash. The acceptance record attests a reviewed mapping, not the
runtime identity or profile bytes of whichever process later claims a selector.

The working directory, issue data, tool output, plan content, and learned memory
are untrusted. The installed plugin, constitutional policy, and an explicitly
accepted repository workflow are trusted inputs. The alpha cannot defend against
a compromised host or same-user process.

## Memory Model

Memory is layered so observed history never silently becomes authority.

1. **Constitution:** immutable safety and completion rules.
2. **Episodes:** typed outcomes with provenance, raw Beta parameters, evidence,
   contradictions, and hash-chain linkage.
3. **Candidate procedures:** patterns extracted from multiple episodes.
4. **Shadow procedures:** evaluated without changing behavior.
5. **Advisory procedures:** bounded suggestions injected only on matching scope.
6. **Policy proposals:** quarantined typed diffs requiring replay, independent
   review, and explicit human approval.

Raw issue or tool text is never promoted as an instruction. Procedure actions
must come from a defined action vocabulary. A human correction suspends a
conflicting procedure immediately. Confidence means are derived; alpha and beta
parameters remain stored.

## Promotion Defaults

The initial research target for advisory promotion is:

- at least five verified successes;
- at least three queue items and two sessions;
- at least three clean shadow opportunities;
- no unresolved contradiction;
- independent evaluation; and
- a lower 95 percent confidence bound above 0.70.

These thresholds are hypotheses until the evaluation program measures them.

## Non-Goals

- LLM or provider abstraction
- autonomous model loop
- continuous tracker daemon
- distributed scheduler
- worktree fleet or container platform
- vector database
- dashboard
- autonomous issue generation
- silent self-modification