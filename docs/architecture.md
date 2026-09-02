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
durable plan <-> Supervised Worker agent -> normal Copilot tools/subagents
        |                                      |
        v                                      v
local verifier <------------------------- evidence references
        |
        +-> bounded Stop decision
        +-> metadata-only lifecycle ledger
        `-> future episode and lesson consolidation
```

### Agent

The agent carries the operating doctrine: queue completion, premise verification,
bounded decision authority, role-separated review, evidence banking, and honest
absence claims. It writes durable plan state but cannot decide whether malformed
state passes the helper's structural checks.

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

On Windows, Copilot CLI runs the `powershell` hook field through PowerShell 7
(`pwsh`). The packaged lifecycle test invokes that same host shell.

Copilot CLI discovers the custom agent from `agents/` and lifecycle hooks from
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
|-- runs/*.jsonl    # append-only metadata events by hashed session id
|-- attachment.json # hash of the session currently governing the plan
`-- runtime/*.json  # bounded Stop counters
```

The pre-tool hook atomically claims the session that first writes `plan.json`.
The post-tool hook records successful writes and releases a failed first claim
when no plan exists. Plan recovery, event logging, and Stop enforcement apply
only to the attached session. This prevents an active queue campaign from
interfering with unrelated Copilot sessions sharing the repository.

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