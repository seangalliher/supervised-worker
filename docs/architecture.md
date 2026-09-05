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

- `SessionStart`: inject bounded counts and checkpoint/orphan references only
        for an already owned durable plan; fresh sessions remain inert.
- `PreToolUse`: create a generation-bound provisional claim for the first plan
        writer, deny conflicting writers, and durably observe every owned invocation.
- `PostToolUse` and, on supporting hosts, `PostToolUseFailure`: append
        metadata-only events and reconcile provisional plan claims.
- `PreCompact`: record metadata about a context transition without checkpointing
        or rotating sessions.
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
checkout command has a five-second timeout. Generated immutable-install hooks
retain that timeout on Unix; Windows installs use fifteen seconds so their nested
trusted PowerShell launcher can complete on a cold host.
Control responses carry Copilot CLI's top-level fields and VS Code's nested
`hookSpecificOutput` fields. PascalCase `Edit` payloads are inspected for both
ordinary path arguments and `apply_patch` headers before plan ownership is
decided.

All packaged and generated `PreToolUse` entries use the shared `.*` matcher.
`PLAN_WRITER_MATCHER` and `PLAN_WRITER_TOOLS` govern file-write permissions only.
Non-writer arguments never select a repository or acquire a plan claim. A
read-only ownership check leaves unrelated non-writers inert before creating
locks or state. Owned non-writers use the same durable start path as writers.
VS Code versions that omit matcher filtering therefore have the same semantics
as hosts that honor the all-tool matcher.

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
and admit at most three distinct drive letters per operation so the checkout
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

The same helper exposes a read-only `local-campaign-receipt` v1 surface. Export
reads the canonical current workspace and trusted plugin root, writes only to
stdout, and has no clock, random, host, or network input. The checkout source
identity reuses the installer's sorted, length-framed
`supervised-worker-file-tree-v1` hash. Installed execution validates the
format-v5 immutable install record and installed tree before returning the
recorded original source hash. Completion audit records and campaign export
likewise share one canonical plan hash implementation.

Plan observations reveal only a domain-separated hash of each item ID and its
status. Ledger observation is closed to eleven event variants: the original
eight plus `tool_started`, `checkpoint_persisted`, and `checkpoint_resumed`.
The parser rejects unsafe or unstable files and is bounded by file count, file
bytes, aggregate bytes, and record bytes. Only event names, counts, UTC bounds,
and a length-framed ledger hash leave the parser; record details and session
hashes do not. An existing empty `runs` directory is observed as an empty
ledger. A missing directory or invalid observation remains unavailable with
null dependent metrics.

Every repository, queue, remote, pull-request, CI, reviewer, and closure field
is fixed to unavailable with a null value and explicit reason. Markdown is
derived only from a runtime-validated local receipt and visibly states
`Local-only, not Provider-Verified Completion`. Saved-receipt validation is
bounded to a single-link regular file inside the current workspace and compares
canonical receipt values with newly observed local state. This surface neither
writes durable state nor participates in completion or Stop.

The Stop bound measures consecutive attempts against the same canonical,
schema-valid plan state, not total session length. After two blocked Stops at
that state, the following Stop releases visibly so a stuck agent cannot loop
forever. Object-key insertion order is normalized, and all invalid plans share
one stable marker until repaired. A changed canonical valid-plan state resets
the consecutive counter; the monotonic total remains ledger metadata. Runtime
state version 2 identifies this hash algorithm. Version 1 raw hashes are
translated when they match the current plan representation, preserving existing
consecutive counters across an upgrade. Completion audit hashes use the same
canonical representation.

## State And Trust

The state directory belongs to the repository being worked on, not the plugin:

```text
.supervised-worker/
|-- plan.json       # current objective and queue items
|-- workflow-acceptance.json # exact accepted repository role-map hash
|-- handoffs/       # typed summaries below sha256(itemId), never raw provider ids
|-- runs/*.jsonl    # append-only metadata events by hashed session id
|-- checkpoints/*.json # immutable receipts named by exact file-byte SHA-256
|-- locks/lifecycle/ # shared repository lifecycle exclusion
|-- attachment.json # v3 claim/route identity; provisional, active, or checkpointed
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
Route and attachment transitions and ledger mutations are serialized by the
workspace-scoped session lock when available, followed by repository lifecycle
locks in canonical-root order. A repository lock is also required for sessions
without transcript routing. No path acquires a session lock while holding a
repository lock. Old-root reconciliation when rebinding and explicit release
use the same repository exclusion. Explicit release captures its attachment
before waiting and revalidates that exact byte hash and filesystem identity
under the lock, so a delayed release cannot remove a successor.
Potentially blocking drive-locality checks for the hook cwd, qualified
targets, transcript anchor, and a read-only locator-root hint complete before
locking; authoritative route and attachment bytes are reread under the lock,
where an uncached drive fails closed without spawning another check. A contender
uses a 250 ms monotonic retry deadline for a concurrently completing hook,
without deleting, renaming, or replacing its owner. A delayed scheduler wake
may return later but cannot retry acquisition after the deadline. A lock that
remains authoritative then fails visibly and requires explicit snapshot-bound
recovery. A new session has a different hashed session lock but cannot bypass
the repository's shared lifecycle lock. Each lock writes one UUID-named owner file and
holds that file open so copied contents cannot impersonate its filesystem
identity. The owner must remain the sole entry in the same stable, nonzero
device/inode directory identity. Release atomically renames the canonical lock
to a token-specific retired path while the owner is still verified, then
revalidates and removes only that retired object. A concurrent acquisition uses
the canonical path and cannot be deleted by retired cleanup. Ambiguous or
replacement state detected before cleanup is left for operator-confirmed
recovery. Retired-path rename and unlink remain best-effort against same-user
races because Node has no portable no-replace directory rename or
handle-relative unlink; this is outside the alpha threat model. An interrupted
`.retired` directory requires operator inspection. Locking does not depend on
birth or change timestamps; a filesystem with no stable nonzero device/inode
identity fails closed. Individual writes are atomic, while the shared
generation and provisional state make a crash between files detectable and
recoverable. A persistent hashed binding marker distinguishes a deleted route
directory from a never-bound session; if an existing route loses its marker,
the hook restores the marker and fails visibly. Normal Stop release removes the
attachment and retains a released route tombstone for later reconciliation. If
writing the tombstone or removing the attachment fails, the hook reports that
cleanup failed and does not claim the ownership was released.

### Lifecycle Failure And Recovery

`inspectLifecycleLock(cwd, request)` and `recoverLifecycleLock(cwd, request)`
share closed, bounded shapes with [the lifecycle schema](../schemas/lifecycle.schema.json).
The `lifecycle inspect` and `lifecycle recover` CLI commands accept at most
8 KiB of duplicate-key-free JSON. Paths are derived from the canonical local
repository cwd and validated scope, UUID token and transcript/session anchor.
Inspection never acquires a lock, migrates an attachment or repairs a route
marker. An absent attachment, a legacy null generation, and unavailable state
are different observations; null is not a wildcard.

Diagnostics distinguish `LIFECYCLE_ACQUISITION_CONTENTION`,
`LIFECYCLE_OWNER_LIVE`, `LIFECYCLE_OWNER_DEAD`, `LIFECYCLE_OWNER_UNKNOWN`,
`LIFECYCLE_OWNER_MALFORMED`, `LIFECYCLE_IDENTITY_REJECTED`,
`LIFECYCLE_SYSCALL_FAILURE` and `LIFECYCLE_EVIDENCE_PERSISTENCE_FAILURE`.
They carry scope, operation, phase, allowlisted syscall/error code, attempt
count, verified token/PID when available, cause classification and next step.
No raw exception, tool argument or transcript content is included. The hook
uses existing reason/context/system-message fields, not new host control fields.
PreToolUse denies the invocation. A primary Stop block already recorded before
cleanup remains a block with the diagnostic; acquisition failure before a primary
Stop decision and other hook failures still fail open visibly. CLI lifecycle
failures retain a known primary result separately from cleanup diagnostics and
exit nonzero. Cleanup cannot establish rollback or verified queue completion.

Owned retirement retries only `EBUSY` from its pre-retirement rename: at most
three attempts in a 100 ms `performance.now()` budget, waiting at most 25 ms
or the remaining budget between attempts. This is a retry budget, not a hard
syscall deadline. Every retry revalidates root/parent and directory identities,
sole owner entry, exact token/PID and owner identity. Windows closes the held
owner before rename and reopens/verifies it after a failed rename. Changed
identity, permission failure, an occupied destination or ambiguous retirement
does not authorize another rename. Dead-owner recovery does not use this retry.

Recovery binds the complete inspected snapshot: owner byte hash and nonzero
device/inode, directory/root/parent identity, exact attachment bytes and identity,
session/status/route and claim generations, and matching route, marker and
repository identities. Routed recovery requires its validated transcript anchor.
Valid v1 owners and legacy attachments remain unchanged. Only signal-zero
`ESRCH` establishes death; a live PID or any other result prohibits recovery.
Completely unbound session locks cannot prove their associated repository.

Before retirement, the helper durably writes, flushes and reads back an immutable
metadata-only intent under `.supervised-worker/lifecycle-evidence/`. Full bindings
and PID death are rechecked before mutation. Canonical repository recovery uses
the occupied old lock as exclusion; session and old `.retired` recovery also hold
the associated repository guard without acquiring a session lock beneath it.
If both canonical locks are dead, repository recovery must complete first.

The rename destination `<canonical-lock>.<token>.recovered` remains permanently
nonempty. It is the competing-recoverer fence: a delayed recoverer cannot rename
a replacement into that occupied destination. It is never emptied, overwritten,
garbage-collected or restored over a current owner. Post-rename identity checks
retain unexpected objects and report unconfirmed state. Immutable outcome
evidence references the intent hash; failed evidence persistence is not success.
An interrupted request may confirm the exact already-retired object using its
original snapshot and matching intent, while leaving a new canonical owner alone.
Unprovable or empty remnants remain untouched when observed. This protocol
covers cooperating hook/recovery processes, not external cleanup or same-user
filesystem substitution. POSIX rename can replace an empty destination created
or emptied after the last check; Windows refuses an existing destination. The
retained nonempty fence is therefore mandatory on every platform, and no
general portable compare-and-rename guarantee is claimed.

### Checkpoint State Machine

`checkpointSession(cwd, request)`, `resumeSession(cwd, request)`, and
`validateCheckpoint(value)` live in the existing core. The CLI accepts strict,
duplicate-key-free UTF-8 JSON stdin up to 8 KiB. Checkpoint requests contain
exactly `session_id`, optional `transcript_path`, `planHash`, and
`attachmentHash`; resume replaces the latter with `checkpointHash` (digest or
explicit `null`). Authority is the canonical local process cwd and validated
existing routing, never a repository override inside the request. `status`
exposes the canonical plan hash and exact current attachment hash read-only.
Confirmed responses contain `status` (`checkpointed` or `resumed`),
`checkpointHash`, `planHash`, `attachmentHash`, and typed `context`.
Unconfirmed CLI responses contain `status: "unconfirmed"` and a concrete,
input-redacted error, with exit code `1`.

The source plan must be valid, active, unchanged canonically, and have
`completion: null`. Under uninterrupted lifecycle exclusion the helper:

1. reads and flushes the validated source ledger's complete-record prefix;
2. captures exact attachment identity and existing valid Stop counters;
3. persists, flushes, and verifies an immutable checkpoint receipt;
4. durably appends `checkpoint_persisted` binding receipt, plan, and source;
5. revalidates ownership and atomically publishes the checkpointed tombstone;
6. marks the matching source route released before reporting success.

Attachment version 3 carries an independent UUID `claimGeneration` for every
new claim and nullable `checkpointHash`. Only `active` and `provisional` are
ownership. `checkpointed` is a logical detachment with a receipt reference;
ordinary plan writes cannot consume it. Legacy v1/v2 ownership remains readable
and is bound to its exact original bytes, session, and available route identity.
It is not migrated before persistence succeeds; legacy receipt generations may
be null. A tombstone alone, or a receipt/persistence event without the matching
tombstone, does not authorize a new session.

The [checkpoint schema](../schemas/checkpoint.schema.json) closes every object.
Receipts are limited to 256 KiB, 4,096 item hashes, and 256 orphan references;
limits fail explicitly instead of truncating. Top-level fields are version,
kind, UUID checkpoint ID, canonical UTC creation time, plan/session/attachment
hashes, route and claim generations, `ledgerPosition`, and `context`.
`ledgerPosition` names only `runs/<source-session-hash>.jsonl`, its byte offset,
record count, and exact prefix SHA-256 before the persistence event. Context
contains typed status counts, `sha256(itemId)` handoff references, a valid Stop
snapshot or null, and bounded operation observations. Runtime validation also
checks relational constraints such as count totals, source filename, prefix
hash/count, and the persistence event at that exact watermark.

Explicit resume requires a fresh session different from the source. It validates
the receipt, tombstone, unchanged active plan, and source ledger binding,
restores the Stop snapshot before publishing active ownership with fresh claim
and route generations, promotes routing, and durably appends
`checkpoint_resumed`. The successor retains `checkpointHash`. Once published,
only that exact successor can idempotently finish an interrupted resume; a
competing session cannot roll it back or remove it. Retries never reset counters
already used by the successor. Before publication, failures retain the
resumable tombstone; an incomplete, generation-unconfirmed host route requires
manual inspection or a different fresh session, not opportunistic deletion.

`checkpointHash: null` is an explicit ownerless active-plan recovery only. It
rejects any current attachment, including tombstones, observes durable ledger
context without replay, and preserves unambiguous valid Stop counters. It does
not consume or alter review/model evidence under other runtime namespaces.
Ambiguous counters require inspection rather than choosing the newest by time.
An owner published during this recovery is not automatically removed if its
confirmation fails. A known-stale owner must be handled with the separately
authorized, snapshot-bound `release` operation. Neither SessionStart nor
PreCompact initiates this process.

Receipt, flush, or pre-detachment event failure leaves the original attachment
and route authoritative. After tombstone publication, a route-cleanup failure
is unconfirmed, not an active source or a completed release; the same source
request can retry cleanup. Temporary files are checked and flushed before
atomic publication and bounded read-back. Required ledger appends publish the
validated old prefix plus one new record atomically, so a failed terminal
temporary write cannot look like observed completion. Process-crash states
are detectable and recoverable, but directory-entry/power-loss guarantees are
not asserted across platforms. Locks require operator-confirmed stale-owner
recovery; age, wall-clock time, compaction, and model choice grant no authority.

### Operation Observations

Every allowed owned or newly claimed PreToolUse must durably record
`tool_started` before permission is returned. Failure denies the invocation
visibly. Records include a UUID `operationId`, bounded tool name, source session,
route/claim identity, and optional invocation hash. `tool_use_id` and `toolUseId`
are hints, not required host guarantees; only their domain-separated SHA-256 is
stored. Conflicting aliases are treated as absent. No arguments, prompts,
transcripts, outputs, or free-form continuation text enter these records.

A terminal `tool_completed` may name an operation only for exactly one matching
invocation hash within the same source claim. Repeated terminal observations
for that match are idempotent. Missing IDs, reused IDs, ambiguous matches,
legacy completion-only records, and failed persistence cannot resolve starts
by tool name, order, argument similarity, or counts. Reused IDs leave every
affected start unknown, including one with an earlier terminal record.
Success/failure metadata without an operation binding remains uncorrelated.

`context.operations` distinguishes observed prefixes from unavailable history;
orphans have `observationStatus: "outcome-unknown"`. Unavailable observations
carry null dependent values and a typed reason, which `checkpoint_resumed`
also preserves for later status and subsequent checkpoints. Legacy uncorrelated
completion counts are explicit. Operators must inspect real side effects;
recovery never executes recorded operations. The enclosing checkpoint tool can
remain an orphan because the source session is already detached when its
terminal hook arrives. Source references survive successor checkpoints.

None of these transitions edits the plan, changes item status or actionable
counts, creates `resumeWhen`, alters handoffs, or mutates Git/index/worktree
contents. Valid Stop v1/v2 snapshots retain the existing migration and bounded
continuation behavior. Checkpoint events never replace `completion_verified`
or `completion_unverified_release`, and cannot make a campaign receipt's
`localCompletionShape` true. Campaign export accepts the new closed vocabulary
but still emits aggregates only, with every provider fact unavailable.

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