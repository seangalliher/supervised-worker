# Issue 10: Native Copilot CLI Host Bridge

Status: historical Gate 0 contract from 2026-09-08, not the current build plan.
The CLI prerequisite was blocked; its original gates and constraints are retained
below as a dated design record. The later Captain-approved delivery split shipped
the VS Code Copilot-local workflow in
[PR #12](https://github.com/seangalliher/supervised-worker/pull/12).
See [Host Profiles](host-profiles.md) for current local assurance and
[issue #11](https://github.com/seangalliher/supervised-worker/issues/11) for the
still-open strong-host obligations. The local canary did not pass this stronger
CLI contract or erase its blocked observations.

Historical owner: [issue #10](https://github.com/seangalliher/supervised-worker/issues/10).
The original operational acceptance was shared with
[issue #6](https://github.com/seangalliher/supervised-worker/issues/6);
[epic #5](https://github.com/seangalliher/supervised-worker/issues/5), #6, and #10
subsequently closed against their explicitly revised local criteria. Issue #2
remains excluded. The sections below preserve the pre-split contract.

## Decision And Boundary

Target one native Copilot CLI host first. Use the public
`@github/copilot-sdk/extension` interface in a CLI-owned extension child process.
Copilot continues to own its model loop, tools, session lifecycle, and permission
handling. The bridge supplies host integration for the existing Supervised Worker;
it is not a replacement coding agent or a new runtime.

Do not build a daemon, scheduler, dashboard, LLM client, model router, or Agent
Factory. Do not patch installed Copilot internals or import its `internal` SDK
exports. Do not change the trust contract merely to make a probe pass. The native
extension lifecycle is session-scoped and must end with its owning host session.

The Captain has authorized a bounded host prerequisite, an isolated test host,
and a subsequent canary delivering two existing bounded ProbOS issues. That does
not authorize weaker authority, manual recovery counted as autonomy, new spending,
access to live product data, or an unbounded host replacement.

## Frozen Starting Point

- Supervised Worker commit: `a0ab03cead583e61c59a86f219cb0bd9ca7d5484`.
- Tree: `b5ebd3b33ccf94db9b3f77e2ea7654b369810558`.
- Source ref: `queue/ea17-issue9`; this is not a main-branch merge or activation.
- [CI run 34205047382, attempt 2](https://github.com/seangalliher/supervised-worker/actions/runs/34205047382/attempts/2):
  nine exact-SHA jobs and eighteen required npm steps independently verified green.
- Source development uses a separate worktree. Preserve the existing dirty primary
  checkout and the completed source session's worktree.
- Do not reuse this CI evidence for a changed bridge candidate.

Existing consumers to preserve:

- [Authority verification](https://github.com/seangalliher/supervised-worker/blob/a0ab03cead583e61c59a86f219cb0bd9ca7d5484/src/authority.mjs):
  immutable source, exact file hashes, repository/session/process identity,
  expiry, one Worker and hook source, and drift rejection.
- [Doctor request entry point](https://github.com/seangalliher/supervised-worker/blob/a0ab03cead583e61c59a86f219cb0bd9ca7d5484/src/doctor-rescue.mjs):
  production currently invokes `executeDoctorIntent` without a host adapter.
- [Host adapter contract](https://github.com/seangalliher/supervised-worker/blob/a0ab03cead583e61c59a86f219cb0bd9ca7d5484/src/doctor-promotion.mjs):
  `observe`, `observeMatrix`, `health`, `compareAndSet`, and `continueCampaign`.
- [Lifecycle contract](https://github.com/seangalliher/supervised-worker/blob/a0ab03cead583e61c59a86f219cb0bd9ca7d5484/docs/lifecycle-transitions.md):
  checkpoint/resume, generation checks, and sole campaign-state ownership.
- [Canonical release compiler](https://github.com/seangalliher/supervised-worker/blob/a0ab03cead583e61c59a86f219cb0bd9ca7d5484/docs/campaign-release.md):
  exact artifact bindings and honest recorded/unavailable provenance.

## Verified Host Surface And Unresolved Facts

The locally inspected standalone CLI is version `1.0.82`, build metadata
`123e53c`. Its shipped public SDK declares the following. These declarations are
not live-session validation, and the generated RPC surface is experimental.

- `joinSession()` joins the CLI's foreground session over its parent-process IPC.
  The host discovers native extensions through a subdirectory containing
  `extension.mjs`; the host injects the public SDK module resolver.
- `session.rpc.agent.getCurrent()` returns the selected agent or null.
  `AgentInfo` includes a stable `id`, optional `source`, and an optional absolute
  `path` for file-based agents. Missing path is not permission to infer one.
- `session.rpc.agent.list()` enumerates session agents. Requesting prompt text is
  unnecessary and forbidden for ordinary authority evidence.
- `session.rpc.plugins.list()` and `session.rpc.extensions.list()` expose loaded
  plugin/extension metadata. They are not by themselves a complete hook inventory.
- SDK hooks receive a host-correlated `sessionId`. `onPreToolUse` can deny a tool;
  `onAgentStop` can block a natural stop, subject to the native host's bounds.
- `onPostToolUse` covers success only. The separate failure hook covers `failure`,
  not every denied/rejected/timed-out result. Do not silently lose these outcomes.
- Plugin reload RPCs exist, but the inspected hook reload result is empty. A
  successful return or a hook count is not evidence of exact effective sources.

[Public native-extension documentation](https://github.com/github/copilot-sdk/blob/d5c9d06d8c4118530083848d9c3fa9d615c0a5c4/nodejs/docs/extensions.md)
and [agent selection tests](https://github.com/github/copilot-sdk/blob/d5c9d06d8c4118530083848d9c3fa9d615c0a5c4/nodejs/test/e2e/agent_and_compact_rpc.e2e.test.ts)
support this candidate route. The installed SDK must remain the compatibility
authority; newer upstream examples do not establish local capability.

Unresolved before Gate 0: complete effective hook provenance; extension readiness
before governed dispatch; SDK callback ordering/reentrancy; stale observation
invalidation; trusted transport to the existing kernel; and activation followed by
fresh-session continuation without authority drift or duplicate effects.

## Gate 0: Real Admission And Resume

This is the first implementation slice. Do not build the complete promotion
adapter, assemble a release narrative, or run repeated broad gates before this
slice discriminates.

Use a private, isolated CLI profile and disposable local repository. Preserve the
normal user profile. Predeclare the exact host binary, plugin source, allowed
extension, session identities, and benign test actions. No production credentials
or private product data enter the probe. Normal host login, initial trust, and
workflow acceptance happen before the operational evaluation clock starts.

1. Start the stock CLI with an inert file-based sentinel agent and a native
   extension. Prove that the extension was forked by that live host and joined
   its actual session. A copied `SESSION_ID`, path, or caller JSON is insufficient.
2. Query the selected agent and loaded configuration through supported host
   interfaces. Assert that the returned stable ID, source, and canonical path
   refer to the exact immutable Worker bytes. Exercise a same-named shadow agent,
   a missing selected agent, changed bytes, and an expired/replaced session.
3. Establish the complete effective hook source set and readiness before any
   governed action. Declare one dispatch path into the existing hook kernel.
   Do not enable shell-manifest hooks and SDK callbacks twice for the same event,
   or claim that an unexecuted manifest is the executing hook source.
4. Attempt a benign sentinel write that policy denies. Assert both that the
   expected native hook actually fired and that the write did not occur. Run a
   corresponding allowed action to prove this is not universal denial. Exercise
   a legacy/duplicate hook source and a disabled/missing hook source.
5. Only after those premises pass may the host integration issue the existing
   bounded authority record and invoke the immutable lifecycle helper. Create a
   real incomplete test plan, checkpoint it, and resume in a genuinely fresh
   session using the production helper. The old session must not regain ownership.
6. Correlate session, repository, source, hook, checkpoint, and generation hashes
   through the complete path. Missing or changed evidence must deny admission.

Gate 0 passes only on a real host, including the positive and negative controls.
Mocks, fixture-authored authority, selected-agent names, configured-file discovery,
or hook counts cannot pass it. Record unsupported/missing facts explicitly.

If a required observation or dispatch guarantee is unavailable, stop this slice
with the exact missing host contract and reproduction. Choose between upstream
support and an explicitly approved change to the product/trust contract. Do not
rename an agent-authored inventory as host attestation or proceed into Gate 1.

## Gate 1: Admission Bridge And Kernel Wiring

After Gate 0, write the bounded build contract for the production file set using
the demonstrated native transport and dispatch path. Candidate ownership is a
separate native extension entry point plus small authority/transport modules;
keep this optional host code out of the ordinary hook import path.

- The immutable extension validates host-originated session facts and supplies
  the existing authority verifier. Neither Worker nor Doctor may self-author or
  elevate that authority. Never expose an arbitrary command or path executor.
- The host bridge owns host integration and activation bookkeeping only. The
  existing Worker/lifecycle kernel remains the sole durable campaign-state owner.
- Route the production Doctor request to the in-process adapter only through a
  proven trusted host boundary. A JSON adapter object or monkey-patched private
  member cannot satisfy `createDoctorHostAdapter`.
- Preserve cooperative same-user threat-model limits. Local host observations
  are not externally sealed provider proof or an OS security sandbox.
- Preserve existing public CLI behavior, zero-dependency core runtime, Node 20+
  support, plugin layout, and byte-identical compatibility copies. Use the
  host-injected public SDK for the optional native extension; do not copy a SDK
  bundle from the editor installation into the repository.
- Reject unknown host versions/capabilities visibly. Do not silently fall back to
  ungoverned execution, another model, or a different workflow.

## Gate 2: Promotion, Rollback, And Continuation

Implement the existing five-method adapter against actual host operations:

| Method | Required behavior |
| --- | --- |
| `observe` | Reopen complete active host identity and source evidence; report the current immutable install and generation; reject drift. |
| `observeMatrix` | Obtain authenticated, complete, exact-commit CI job/step observations; reuse `validateDoctorMatrix`. Never turn an unsealed observation into provider-verified completion. |
| `health` | Verify installed bytes and compatibility, then exercise a real governed host action. A module import or JSON parse alone is insufficient. |
| `compareAndSet` | Activate only the expected-generation candidate using an incident/action key. Repeated calls inspect or return the original outcome; lost replies never authorize blind replay. |
| `continueCampaign` | Resume the same checkpointed campaign with host-correlated identity and receipt evidence. Queuing a prompt or opening a UI is not proof of resumed execution. |

The current adapter methods are synchronous. Native SDK RPCs are asynchronous.
Do not conceal this mismatch with blocking event-loop calls or stale snapshots.
Gate 0 must determine a bounded trusted transport or an explicitly tested,
backward-compatible async integration. No public signature changes are assumed by
this contract.

Promotion must not invalidate the current invocation's authority before its final
receipt is published. Prove a safe fresh-session handover or another supported
transaction boundary. A failed candidate health/history check leaves or restores
the previous independently verified immutable installation. Changed activation
generation or unknown rollback remains blocked. Never edit an active install.

Tests must cross the real caller/consumer path and cover response loss, duplicate
operation IDs, generation drift, host death, candidate failure, rollback, and
continuation. Retain snapshots proving staged, unstaged, and untracked human work
survives. Use deterministic boundary tests plus one real-host path, not timing
tolerance changes that hide defects.

## Gate 3: Release And Operational Closure

1. Run focused `node:test` regressions after each slice. Review the stable exact
   candidate independently with a different model family, repair findings, and
   then run `npm test` and `npm run validate` before commit.
2. Push the reviewed candidate and independently verify all nine Windows/macOS/
   Linux and Node 20/22/24 CI jobs, with both npm gates passing on its exact SHA.
   A later source or test change invalidates prior broad-gate evidence.
3. Install and verify that exact candidate in the isolated host. Preserve and
   verify the prior install and host configuration as the rollback target. This
   one-time setup is not a canary success and is recorded separately.
4. Preselect two existing bounded ProbOS issues and record a complete starting
   queue observation. Use isolated worktrees and all ProbOS review/canonical-gate
   requirements. Do not touch commercial files or live ProbOS data.
5. Execute #6's real checkpoint/resume campaign, including the declared recoverable
   and novel Doctor incident paths. Keep normal safe tool parallelism. No operator
   recovery, lock edits, command relay, workflow reconfiguration, or false
   completion claim is permitted during the canary.
6. Verify both shipped issue closures, exact commit/push state, a final fresh-session
   resume, and the canonical receipt. Report productive work separately from
   contention, recovery, Doctor activity, review, compilation, and broad gates.
7. Close #10 only after its operational acceptance passes; close #6 on its actual
   canary evidence. Reconcile every epic exit criterion before closing #5. Leave
   #2 untouched. A blocked or failed canary is recorded honestly, not counted as
   completion.

## Completion Report

Report the pinned host and SDK versions, source/install hashes, exact live Gate 0
controls, reviewed commits, test counts, CI run/attempt identities, host operation
and checkpoint correlations, rollback evidence, canary intervention count,
canonical receipt hash, and independently verified provider closures. Explicitly
label unavailable facts and residual risks. No raw prompts, tool payloads, secrets,
or private issue bodies belong in the public report.