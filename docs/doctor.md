# Supervised Doctor

Doctor is a Worker-invoked incident responder. It reasons about internal
supervisor failures and returns typed proposals. It does not own campaign state,
authorize itself, run a daemon, or replace the existing build and review roles.

## Authority And Routing

Production requires the immutable installation's accepted Worker authority and
the current repository/session owner. The explicit VS Code `local-scoped` profile
uses plugin-session binding; the default `host-attested` profile still requires
genuine host-provided evidence. Neither mode manufactures a host inventory.
An explicitly accepted workflow chooses `authority.mode` and `authority.assurance`.
Doctor cannot change either selection,
the accepted configuration, policy, review rules, or completion criteria.

The hook-to-Doctor route accepts an in-process typed kernel failure, not text
that looks like an error. It preserves the original hook decision and records
an incident before asking the Worker to invoke the isolated Doctor companion.
Missing authority leaves production fail-closed; fixture authority is never a
substitute for a live host inventory.

The separate `src/doctor-rescue.mjs` entry point accepts at most 65,536 bytes of
duplicate-key-free JSON on stdin. Its operations are `detect`, `inspect`,
`handoff`, `grant`, and `execute`. Requests carry the owning session, incident
identity, and typed record or hash. No arbitrary shell text or free-form target
path crosses that boundary. The Doctor agent has no direct durable-state or
shell tool; probes and mutations run through the Worker and dedicated executors.

### Native Recovery Entry

An ordinary terminal call is also subject to PreToolUse. A dead session lock
therefore blocks a plain stdin invocation before the Doctor executor can run.
The accepted `local-scoped` profile admits one narrowly formatted control-plane
command without acquiring that session lock. It still revalidates the exact
immutable source, workflow and owning session. The executor's existing independent
incident transaction owns action reservations, capabilities, audit outcomes and
exact dead-owner recovery; this path does not authorize ordinary tools or replay.

Use the installation record's exact absolute Node path and the immutable
`src/doctor-rescue.mjs` path, each single-quoted, followed by `--request-base64`
and one single-quoted canonical base64 argument. Decode that argument as UTF-8
JSON with exactly `cwd` (the absolute campaign root) and `request` (the usual
typed Doctor request). The hook requires that root to match its owning workspace;
the executor uses it independently of the terminal's current directory.
PowerShell requires the leading
`& `; POSIX shells do not. Escape an apostrophe inside a PowerShell argument as
`''`, or inside a POSIX argument as `'\''`. No prefix command, pipeline, wrapper,
redirection, environment override, extra argument or trailing command qualifies.
The decoded envelope is bounded to 65,536 UTF-8 bytes; a host terminal may impose
a smaller command-length limit. Requests use the same fields and operations as
stdin and must carry the native hook's exact session and transcript. Base64 avoids
JSON quote loss in Windows PowerShell 5.1 and is also accepted by PowerShell 7.
Do not include raw prompts, credentials or opaque rescue capabilities in it.

The named `Supervised Doctor` companion is reachable with a `runSubagent` prompt
containing only a `doctor-consultation` JSON object: `kind`, the current `incident`,
its canonical `incidentHash`, and `evidence`. Evidence is an array of at most 16
objects with `value` and its canonical `sha256`; every hash must be recorded in
the incident's inputs or committed history. The complete prompt is bounded to
65,536 bytes. The hook reopens
the current incident and requires the exact hash. This is a bounded diagnosis
request, not a grant for the companion to mutate state or call arbitrary tools.
Initial native setup must verify the intended installed Doctor has no shadow
selector; this cooperative local profile does not attest host-wide agent identity.

Doctor control-plane operations use their existing incident records instead of
the ordinary tool journal. A request that fails before entering the executor's
incident transaction has no plugin action receipt; retain the native host failure
or mark that observation unavailable. A native hook allow is not an action outcome:
reopen the Doctor result, retain recovery fences, and prove the next ordinary
governed action succeeds. Lost or unknown mutating results are not replayed.
Strict host-attested workflows and the stdin compatibility entry are unchanged.

## Incident State

`schemas/doctor.schema.json` defines versioned incident, capability, step,
repair-intent/outcome, handoff, repair-attempt, validation, review, promotion,
rollback, and continuation records. An incident distinguishes detected,
diagnosing, stabilizing, repairing, validating, reviewing, promoting, resuming,
resolved, and blocked states.

The Worker's existing generation-bound transition owner publishes incident
records under an independent incident-local lock. Exact dead incident locks use
the same snapshot-bound recovery kernel; live, changed, malformed, or unknown
owners are never adopted. Recovery preserves the old owner and its receipts.

Each reservation atomically advances the incident revision and fences its
predecessor. A second action cannot consume the same state. Final step, outcome,
and next state share one atomic commit record. Subordinate records are available
as hash-addressed artifacts; orphan preparation bytes are not committed history.

An already-recorded action returns its original outcome. A reserved action with
no committed outcome is unknown and is not replayed, even if a caller lost its
response. Inspection and cancellation remain separate from a completion claim.
Budgets bound attempts, steps, elapsed time, and repeated non-progress. Completed
steps are ordered by their committed hash chain, not filesystem enumeration.

A proven pre-effect CI precondition failure records `retryable`, retains the
current incident phase, and consumes the ordinary step/non-progress budget. A
new action may retry; replaying the original action returns its old receipt.
Unknown continuation stays `unknown` in both the subordinate record and durable
outcome. It is never reclassified as evidence that continuation did not occur.
If hook incident capture cannot run in the current authority/policy/state, its
original decision is preserved and an explicit capture-unavailable notice is
added. Incident capture currently requires active or resumed Worker ownership.

## Isolated Source Repair

An optional accepted workflow `doctor` object selects `sourceRepository`,
`repairDirectory`, and the exact `baseCommit`. The repair directory must be
separate from both the campaign and source repository. The source must contain
the Supervised Worker plugin. A separately approved Architect build contract
binds every attempt's target paths; protected policy and workflow paths remain
excluded, including case variants.

Attempts use detached worktrees with distinct incident/action identities.
Snapshot checks preserve staged, unstaged, and untracked source work. Cleanup
removes only an unchanged baseline worktree with no untracked or ignored files;
dirty or committed attempts are retained. There is no stash, reset, or force
cleanup path. Git evidence reads use a trusted executable, suppress repository
monitors and hooks, and disable external diff and text conversion.

The source and campaign may be the same repository or the campaign may be
nested in it; only repair worktrees must be disjoint. Source snapshots cover
Git-visible user changes, not ignored-file contents. This exclusion also keeps
the owner's ignored campaign evidence out of source-work comparisons. Cleanup
is stricter and refuses ignored files rather than removing them.

The campaign owner retains contracts, reports, model receipts, and issued review
attempts. The isolated source worktree does not receive another campaign-state
directory. The existing handoff verifier accepts an explicit source context and
binds its exact tree, base, and root to the review attempt. Build checks include
the contract's focused checks, `npm test`, and `npm run validate`; promotion also
requires all nine OS/Node CI jobs. Independent review reopens the exact model
receipts and requires different Builder and Reviewer families.

## Immutable Promotion And Rollback

Promotion reopens the selected repair/review chain and requires a clean committed
tree. It builds a new immutable install, verifies its source identity, replays
incident history using the candidate code, and checks candidate health. Prepared
promotion evidence is published before activation. The current install is not
modified in place.

A trusted embedding host may register an in-process adapter using
`createDoctorHostAdapter`. The adapter cannot arrive in JSON from Doctor. Its
implementation must supply complete active-authority observations, authenticated
exact-commit CI observations, health checks, durable idempotent compare-and-set
activation, and correlated campaign continuation. Every observation must report
one Worker, one hook authority, and no enabled legacy plugin. The host must keep
the current invocation's authority valid through receipt publication or provide
a fresh-session handover; changing the inventory beneath a running transaction
fails closed.

The host compare-and-set operation is keyed by incident and action. Lost replies
are inspected, not blindly replayed. A failed activated health check restores
the verified prior immutable install only if the active generation still matches.
Changed activation state or an unknown rollback outcome blocks continuation.

No stock VS Code or Copilot CLI activation adapter is bundled here. The CLI
therefore reports `DOCTOR_HOST_ACTIVATION_UNAVAILABLE` or
`DOCTOR_HOST_CONTINUATION_UNAVAILABLE` at that boundary. These are real blocked
dispositions, not permission to self-author an inventory, edit a live install,
run operator recovery scripts, or claim a resumed campaign. Source tests exercise
the adapter contract with explicitly temporary fixtures only.

## Operational Acceptance

Passing source tests and CI does not pass issue #6. The revised Copilot-local
canary requires a separately installed immutable candidate, explicitly accepted
local workflow, a fresh VS Code session, an operationally checked selected agent
and hooks, and exactly one campaign owner. It must demonstrate real queued work,
checkpoint/resume and supported Doctor recovery without operator command relay,
manual lock editing or ownership intervention. Host-forced stops remain visible
and cannot be called an uninterrupted pass.

Local dead-lock recovery does not need the promotion adapter: the Worker inspects
the committed result, revalidates the current owner, and verifies the next governed
action. It must not call a successful recovery alone a completed continuation or
resolved incident. A source upgrade requires an explicit checkpoint-and-restart
handoff; no automatic in-session plugin replacement is claimed. The original
strong host-activation/rollback/continuation acceptance is retained separately in
Supervised Worker #11 and the linked ProbOS-host program. See
[Host Profiles](host-profiles.md). Preserve unsuccessful evidence and leave the
corresponding criteria open; do not claim a real canary passed from source tests.