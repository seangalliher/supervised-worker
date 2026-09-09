# Issue 10: Native Gate 0 Results

Date: 2026-09-08. Disposition: **blocked before Worker authority**.

This historical record covers the first part of the
[host bridge contract](issue-10-host-bridge-build-contract.md). It does not pass
Gate 0, admit a Worker, or count as an operational canary attempt. At the time,
issues #10, #6, and #5 remained open; #2 and the prospective ProbOS workload were
untouched. The later approved [host split](host-profiles.md) and
[completed local canary](https://github.com/seangalliher/supervised-worker/issues/6#issuecomment-5609078703)
closed those three issues against revised local criteria. These blocked CLI
results remain unchanged, and the stronger host work remains open under
[issue #11](https://github.com/seangalliher/supervised-worker/issues/11).

## Pinned Environment

- Source baseline: `a0ab03cead583e61c59a86f219cb0bd9ca7d5484`.
- Native Copilot CLI: `1.0.82`, build metadata `123e53c`.
- Executable SHA-256:
  `af47bd92079e989cb88bc3d5c1f4351a0bbe0cf3f423e600acd79d544a592d56`.
- Native extension used the host-injected public `joinSession()` API.
- Disposable Git repository, separate CLI profile, one-time folder trust and
  hook registration approvals. No changes to the normal user profile or to
  Supervised Worker's production source.
- Experimental mode was required for native extension discovery in this run.

## Measured Results

1. The native extension joined a genuine foreground session. Its parent process
   was independently checked against the live CLI. The selected sentinel agent
   was returned with stable ID, source metadata, and the expected canonical file
   path; the probe matched its exact file bytes.
2. Startup ordering matters: an earlier extension startup returned no selected
   agent before the CLI completed agent selection. That observation was retained
   as an unsatisfied premise, not turned into an authority grant.
3. A real model turn called two distinct inert fixture tools. The native pre-tool
   hook allowed the first and denied the second. Exactly one allowed marker was
   written; the denied marker and denied handler execution were absent from the
   explicitly enumerated run. Native `agent.getCurrent()` calls succeeded from
   inside both pre-tool callbacks before the decisions returned.
4. The hook and handler did not share a tool-call ID: the SDK's public
   `PreToolUseHookInput` has no such field, and the actual pre-tool records had
   null IDs while the allowed handler carried an ID. This run is correlated by
   its two distinct tool names, one session, and recorded sequence only. It does
   not prove general concurrent-call correlation.
5. The joined session's actual public RPC method names were enumerated. No direct
   effective-hook inventory method was exposed in that object. Native agent,
   plugin, extension, and session-metadata result shapes were recorded as field
   names/counts. None of those observations established complete effective hook
   provenance across all sources or its registration-ready generation.
6. A model-free alternative using public SDK `mode: "empty"` successfully created
   and cleaned up a controlled native session. Its in-memory selected agent had
   only `id` and `name`, not file provenance. Two file-plugin variants, using the
   Agent Plugins namespace layout and byte-identical root compatibility layout,
   both returned zero agents and zero plugins. The SDK was verified to forward
   `pluginDirectories`; the cause of the native loader's empty result remains
   unresolved. This is not proof that every file-backed SDK route is unsupported.

Requested configuration flags in the controlled-host experiment are not treated
as observed enforcement guarantees. A constructed session does not by itself
establish the existing complete authority contract.

## Model And Validation Scope

The isolated profile reported the requested `claude-sonnet-5` unavailable. Auto
was explicitly selected before submitting the single deterministic tool probe;
the native UI displayed a resolution to `gpt-5.6-luna` and 0.17 AI credits. This
is a host-UI observation, not a formal model-family receipt, provider billing
reconciliation, or permission to substitute Auto in the operational review flow.

- Twelve focused `node:test` regressions passed.
- The live allow/deny observation was verified against native callback records,
  actual marker files, and successful in-hook agent queries.
- The controlled in-memory construction check passed; both file-backed variants
  failed their explicit selected-agent premise and retained their reports.
- The final verifier reopened eighteen native observation records and three
  controlled-host reports. No authority was issued and no canary was started.
- All started probe hosts were requested to stop; the interactive CLI exited with
  code 0 and the controlled SDK runs reported zero cleanup errors.
- No broad repository gate was run: no production source changed, and the live
  prerequisite has not passed.

The metadata-only outcome is retained locally at
`logs/issue10-cli-gate0-1153c30f/outcome-1788886732135.json`, SHA-256
`c966e61dd0b61d5bc8ee672bac56c6bc263ee48b5c90f08447b16aaf0c89b78c`.
The probe retains no raw prompt/tool payloads in its observation files. The native
host's own session state remains confined to the isolated profiles and is excluded
from Git; it is not part of the canonical campaign evidence.

Local evidence checks:

```text
node --test logs/issue10-cli-gate0-1153c30f/probe-evidence.test.mjs
node logs/issue10-cli-gate0-1153c30f/verify-results.mjs
```

These scripts and reports are local preflight artifacts, not a deployed bridge.

## Required Next Boundary

The joined-session route needs a supported native host observation that binds the
actual session and process, selected immutable agent source, and complete effective
hook registrations to a ready generation before dispatch. Missing or changed
observations must prevent admission. A name, configured-file scan, hook count,
or operator-authored `complete: true` record cannot substitute.

The native host also needs reliable per-operation correlation for guarded parallel
actions, and an activation/continuation boundary that preserves current authority
until its final receipt is published. Missing pre-tool IDs identify an integration
requirement, not proof that correlation cannot be implemented through any API.

Until those facts are available, keep the existing authority verifier fail-closed.
Do not manufacture its inventory or invoke the production checkpoint/resume path
with fixture authority. The controlled-host route remains a candidate for a
separate bounded compatibility proof, not a passed fallback. No change to the
trust contract or canary criteria was approved or made here.