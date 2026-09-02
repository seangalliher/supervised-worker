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
`null`; a configured workflow never grants old artifacts new authority.

The preferred main ID is `seangalliher-supervised-worker`; the established
`supervised-worker` ID remains as a compatibility selector. A parity test permits
only selector-specific provenance and `producedBy` identity to differ between
them. Every new role uses the `seangalliher-supervised-*` publisher prefix. This
reduces accidental collisions but cannot prevent GitHub's higher-precedence
project or user agents from shadowing a plugin file with the same ID. The Worker
therefore requires a supported-host provenance check before creating state.

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

### Governed Queue Skill

The skill defines the repository-neutral item lifecycle and plan shape. It is
separate from the agent so other Copilot agents can adopt the same queue contract.

### Lifecycle Hooks

The plugin uses PascalCase event names so Copilot CLI emits the VS Code-compatible
snake_case payload. Current events are:

- `SessionStart`: inject bounded counts from an active durable plan.
- `PreToolUse`: atomically claim the first plan writer and deny later sessions.
- `PostToolUse` and `PostToolUseFailure`: append metadata-only events.
- `PreCompact`: record that a context transition is beginning.
- `Stop`: check plan structure and bounded completion conditions.

Every hook resolves code through `PLUGIN_ROOT` and has a five-second timeout.
Control responses carry Copilot CLI's top-level fields and VS Code's nested
`hookSpecificOutput` fields. PascalCase `Edit` payloads are inspected for both
ordinary path arguments and `apply_patch` headers before plan ownership is
decided.

Edit targets are checked lexically and by filesystem identity. The hook denies
device-namespace paths, unresolved link aliases, aliases whose existing
ancestors identify `.git` or `.supervised-worker`, and existing regular files
with multiple hard links. Repository handoff paths use exact case-sensitive Git
identifiers, include both sides of renames, and reject link-bearing footprints.

On Windows, Copilot CLI runs the `powershell` hook field through PowerShell 7
(`pwsh`). The packaged lifecycle test invokes that same host shell.

Copilot CLI discovers the custom agents from `agents/` and lifecycle hooks from
root `hooks.json`. The Agent Plugins v1 portable surface remains the closed root
manifest plus `skills/`; Copilot's agent and hook loading is additive client
behavior. Copilot CLI 1.0.74 or newer is required because that release added
Agent Plugins v1 manifest support.

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
|-- attachment.json # hash of the session currently governing the plan
`-- runtime/*.json  # bounded Stop counters
```

The pre-tool hook atomically claims the session that first writes `plan.json`.
The post-tool hook records successful writes and releases a failed first claim
when no plan exists. Plan recovery, event logging, and Stop enforcement apply
only to the attached session. This prevents an active queue campaign from
interfering with unrelated Copilot sessions sharing the repository.

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