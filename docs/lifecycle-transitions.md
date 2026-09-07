# Generation-Bound Lifecycle Transitions

## Production Admission

`handlePluginHook` separates the plugin-wide protected-mutation guard from the
Worker lifecycle kernel. A repository directory, plan, attachment, old route,
or checkpoint does not admit a chat. Ordinary reads, source edits, terminal
observations, SessionStart, PreCompact, and Stop return without creating session,
repository, or journal locks when there is no validated owning-session grant.
This also applies to a sibling Git worktree and to a checkpointed source session.
Protected edits still fail closed. Direct lifecycle-file edits are denied even
for an owner; bounded handoff artifacts retain their existing ownership guard.

The trusted host must supply `SUPERVISED_WORKER_HOST_AUTHORITY`, an absolute path
to a bounded, canonical inventory outside the target repository. Its closed
`worker-host-authority` record contains `schemaVersion: 1`, `host` (`vscode` or
`copilot-cli`), `complete: true`, `sessionHash`, canonical-path `repositoryHash`,
the live host `processId`, `issuedAt`, `expiresAt`, and exactly one entry in each
of `workers` and `hooks`. Entries contain the selected canonical `path` and its
exact byte `hash`. The lifetime is at most 24 hours. The selected files must
belong to the same verified immutable installation that executes the command.
The Worker grant binds the session, repository, immutable source, Worker bytes,
and hook bytes. Inventory drift during a transition invalidates the grant.

This inventory is a trusted host integration input, not an agent-authored
attestation or a discovery heuristic. Selector text, `/env` prose, repository
files, and tool output cannot substitute for it. Missing inventory, a checkout
runtime, competing Worker/Stop authorities, dead or unknown host ownership, or
changed immutable bytes prevent ownership. The helper does not generate an
inventory or claim to enumerate enabled host extensions. A host without this
integration remains unadmitted; installation alone does not enable governance.
This remains a cooperative same-user runtime, not an OS sandbox.

## Transition Protocol

The private `withCampaignTransition` owner and its `transitionMutation`,
`transitionWriteJson`, and `transitionWriteBytes` publication operations are the
only campaign lifecycle mutation boundary. Callers select the required existing
session/repository exclusion before entering it. The owner compares the full
expected observation before the action and before each publication, refreshes
only after its own successful mutation, and refuses to continue after uncertain
state changes. It never refreshes a stale external expectation to make it pass.

Observations contain canonical plan and exact plan-byte hashes, attachment hash,
claim and route generations, route and marker hashes, Stop-state hash, session
hash, repository identity hash, and source state. The closed wire shapes live in
[the transition schema](../schemas/transition.schema.json). Internal filesystem
identity checks remain inside the kernel; normal callers use these observations
and hashes, not inode values or lock-directory choreography.

From the target repository, use the selected immutable helper:

```text
node <immutable-plugin-root>/src/cli.mjs lifecycle observe
node <immutable-plugin-root>/src/cli.mjs lifecycle plan
node <immutable-plugin-root>/src/cli.mjs checkpoint
node <immutable-plugin-root>/src/cli.mjs resume
```

`observe` takes JSON stdin with `session_id` and, when routed, `transcript_path`.
It is read-only and acquires no lifecycle lock. `plan` takes the same session
fields plus the exact returned `expected` object and schema-valid `plan`.
There is no caller-selected destination path or arbitrary command. A stale
observation returns `CAMPAIGN_COMPARE_AND_SET_CONFLICT`; an uncertain failure
does not authorize replay. Checkpoint and resume retain their existing bounded
request formats, now with verified immutable host authority at the CLI boundary.
`release` takes the owning session fields and exact `expected` observation as
bounded JSON stdin. It has no unbound force mode. `lifecycle recover` accepts
the same capability-bound request as the standalone rescue executor, not a raw
caller-authored recovery snapshot. The read-only `lifecycle inspect` compatibility
command remains available, but does not confer mutation authority.

| Operation | Source | Result And Rejections |
| --- | --- | --- |
| First plan | Released, with no existing plan | Provisional claim and route, atomic plan publication, then active ownership. An existing ownerless plan requires explicit resume. |
| Plan update | Same provisional, active, or resumed owner | Publish only against the exact observation. Another owner, stale hash/generation, or checkpoint tombstone is rejected. |
| Checkpoint | Active or resumed | Persist receipt and journal watermark, then checkpointed attachment and released source route. The active incomplete plan is unchanged. |
| Checkpoint retry | Matching checkpointed source | Validate the original receipt/ledger binding and finish the same source-route release; never manufacture completion. |
| Resume | Matching checkpoint, fresh session | Restore bounded Stop/unknown-operation context, publish a new claim and route generation, then report resumed. A changed plan or competing successor is rejected. |
| Ownerless resume | Released, active incomplete plan | Explicitly adopt with observed or unavailable prior context. Unknown external mutations are not replayed. |
| Stop | Validated provisional, active, or resumed owner | Keep the bounded block, or release for verified completion, inactivity, absent provisional plan, or the existing bounded limit. Unverified release is not completion. |
| Explicit release | Exact observed attachment and verified owner grant | Remove only that attachment and optional counters, preserving the plan. Changed ownership wins. No implicit release is performed for an unrelated chat. |
| Recovery | Exact inspected dead lock owner | Retain a permanent recovery fence and append-only intent/outcome evidence. Campaign work state is unchanged. Live, unknown, malformed, changed, or unverifiable owners are not reclaimed. |

`resumed` is the active checkpoint successor view. `recovery-fenced` in a
campaign observation is a refusal state for unverifiable attachment content,
not proof of successful rescue. Only a confirmed recovery result and its
retained evidence establish that the inspected lock was fenced.

Each file publication is atomic. A multi-file transition is not represented as
a filesystem-wide transaction: provisional routes, checkpoint tombstones, and
retained recovery intents make interrupted states detectable. An ambiguous
partial transition remains unconfirmed; neither its caller nor a later hook may
silently treat it as completion or replay an unknown external mutation.

## Production Mutation Audit

The following `src/core.mjs` sites enter the same transition owner:

| State | Mutating Functions | Publication |
| --- | --- | --- |
| Plan | `applyCampaignPlan` | `transitionWriteBytes`, followed by a typed `plan_transitioned` event |
| Attachment | `claimSession`, `promoteAttachment`, `detachSession`, `releaseAttachment` | Owner-guarded exclusive create, atomic replace, or exact-snapshot removal |
| Route and binding marker | `ensureSessionMarker`, `bindSessionLocator`, `updateSessionLocatorStatus`, interrupted-claim cleanup | Owner-guarded create/replace; no unvalidated lifecycle-event repair |
| Checkpoint | `checkpointSession` | Immutable receipt, existing journal watermark, attachment tombstone, source-route release |
| Resume | `resumeSession`, `restoreStopSnapshot` | Preserved Stop context, new route/claim, successor confirmation |
| Stop | `handleStop`, `releaseStop` | Owner-guarded counters and exact attachment release |
| Recovery | `recoverLifecycleLock`, `issueRescueCapability` | Owner-guarded exact quarantine and immutable evidence/capability metadata |

Lock acquisition/retirement is exclusion machinery, not an independent campaign
owner. Human workflow acceptance and the existing handoff/review-attempt artifact
protocol retain their separate authority contracts; they do not write lifecycle
plan/attachment/route/checkpoint state. The internal `handleHook` is the trusted
kernel adapter used for fault injection and compatibility tests. Production
launchers call `handlePluginHook`, which admits only validated immutable grants.
There is no production flag that enables the test adapter or implicit plan edits.

## Journal Boundary Preserved From #8

`appendJournalRecord` and routine start/completion, denied-retry, helper-result,
and PreCompact observations stay outside `withCampaignTransition`. They retain
the journal mutex, session/route/claim/invocation/operation/observation identity,
atomic complete-file publication, limits, flush/read-back, and fail-closed start
behavior. They do not acquire the repository campaign lock. Checkpoint alone
coordinates the journal watermark with its stronger transition exclusion.
Missing completion remains outcome-unknown. The one hash-stable deterministic
read-only helper retry is unchanged; unknown mutations are never replayed.

## Rescue Entry Point

An admitted Worker may call `lifecycle rescue-authorize` with its session fields,
lock `scope`, optional existing recovery selector, UUID `incidentId`, and
`expiresAt` no more than fifteen minutes ahead. Issuance inspects and binds exact
dead ownership without entering the failing ordinary hook dispatcher. It stores
only a capability hash, typed snapshot, incident, authority hash, and expiry.
The returned opaque capability is secret control-plane material: retain it
outside model prompts, tool journals, and general evidence reports.

The dedicated `src/rescue.mjs` executor accepts bounded duplicate-key-free JSON
stdin containing `capability`, `incidentId`, `snapshotHash`, `action` (`inspect`
or `recover`), and the source session fields. It reopens the immutable capability,
campaign observation, and exact lock snapshot before mutation. A changed plan,
attachment, route, Stop state, capability, repository, incident, or expiry denies
the request. Recovery still calls the same transition owner and existing dead-PID
checks, retains the old lock as a permanent fence, and returns evidence hashes.
Replaying a confirmed exact request returns `already-recovered`, not another
ownership transition.

This is an out-of-band executor for a trusted host control-plane invocation, not
a special ordinary shell command exempted from hooks. Calling it through a tool
whose PreToolUse hook is blocked does not bypass that hook. It has no shell,
policy-edit, installation, promotion, or arbitrary-path action. Doctor reasoning,
host invocation integration, promotion, and autonomous continuation belong to #10
and are not implemented here. Canonical receipts (#9) and the canary (#6) are also
outside this change.