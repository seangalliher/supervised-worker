# Canonical Campaign Release Evidence

The release compiler links already-recorded evidence. It does not run a
campaign, issue authority, repair state, contact a provider, sign receipts, or
satisfy Stop. `campaign export` and its existing local-only receipt remain
unchanged and readable.

## Input Capture

The production entry point requires the verified owning Worker and a schema-valid
`campaign-release-input` from `schemas/campaign-release.schema.json`. The Worker
opens bounded files, validates their exact SHA-256 and filesystem paths, and
holds an opaque in-process capture token. Copied tokens, JSON pretending to be a
token, linked paths, hard-linked files, changed input bytes, and changed ownership
are rejected. Captured parsed data is immutable. Companion roles and Doctor
receive only bounded contents and hashes from the Worker; they never compile
or write the canonical receipt and receive no durable-state authority.

The input names the exact `commit`, `tree`, local branch `ref`, and campaign
`baseCommit`. The compiler checks HEAD, index, worktree cleanliness, branch target,
and ancestry. A supplied item's contract/report/review and model receipts are
reopened through the existing handoff verifier. Its changed-file scope is the
candidate commit's first-parent diff, not the entire multi-item campaign range.
The campaign base remains an ancestry anchor. Existing review-attempt freshness,
model policy, source binding, and evidence requirements are not relaxed.

Compile item handoff evidence within 24 hours of its issued review attempt
(the existing verifier allows only its five-minute clock-skew margin). An expired
attempt invalidates the entire handoff-bearing compilation with
`RELEASE_HANDOFF_VERIFICATION_FAILED`; it is not silently dropped or downgraded.
Re-verifying an older item requires a fresh independently reviewed attempt through
the existing review flow. Omitting its artifacts produces no item-completion
evidence and must not be used to represent that item as complete. A root commit
without a first parent cannot carry this item-diff handoff evidence.

Each supplied artifact has a role, locator, and SHA-256. The plan uses its fixed
location; handoffs, checkpoints, and model receipts use their existing canonical
locations. Metadata observations live at
`.supervised-worker/release-inputs/<sha256>.json`. The compiler only reads these
files. A complete Doctor/recovery inventory hash is obtained separately from
`campaign inventory` and included in the input. The inventory scans recovery
evidence even when there is no Doctor directory. Missing or changed captured
files invalidate compilation; the compiler rechecks its input set before return.

## Provenance

Every fact records one of four statuses:

- `verified`: local bytes, schema, and associated local consistency checks passed.
  This does not authenticate the original author of a file or its external facts.
- `recorded`: an observation or claim is retained by hash without external sealing.
- `unavailable`: evidence is absent, incomplete, or lacks a required trust source.
- `inapplicable`: the relevant surface is absent from the enumerated local inputs.

Local Git refs and recorded remote refs are separate facts. Queue observations
must be supplied as a start/final pair. When both are complete, actor, repository,
scope, and time ordering must agree; an unavailable member remains unavailable
and cannot prove reconciliation. Provider observations bind the candidate and
any supplied complete queue identities. With no complete queue, the provider
actor/repository hashes remain uncorroborated recorded claims. The compiler does
not equate a provider repository ID with a local filesystem identity and does
not independently bind either to a Git remote; that requires external provider
reconciliation. CI records require all nine supported OS/Node jobs and both required
npm steps; closure hashes must name plan items. These observations still remain
`unattested-provider-observation`, not verified provider truth.

Model receipts remain Worker-recorded host observations, even when their local
handoff consistency checks pass. Provider verification is always unavailable in
this version. `grantsPermissions`, `satisfiesStop`, and `providerSealed` are always
false. A parsed receipt that changes these ceilings or mislabels provenance is
rejected by the JSON and Markdown serializers.

Item completion, session checkpoint, campaign completion, Doctor resolution,
and provider verification are distinct dispositions. Recorded completion is not
permission to close an issue or claim the operational canary passed.

## Doctor Evidence

Doctor records are `worker-recorded`, not externally attested. The compiler
checks the revision chain, legal reservations, capability bindings, completed
outcomes, and continuation records before accepting a recorded state. A fabricated
hash-consistent jump from detection to resolution is rejected.

The receipt links incident/capability records, diagnosis and repair handoffs,
repair contracts and model evidence, lifecycle rescue records, promotion and
rollback records, and continuation results. Referenced files that have canonical
stored locations must still exist with their exact hashes. General lifecycle
recovery without a Doctor incident is a separate recorded fact, not a resolved
Doctor incident.

Some older Doctor records contain CI, health, diagnostic, or history-replay
hashes whose preimages were never retained. This version reports those exact
hashes as `unavailable` dependencies, with partial coverage. It does not invent
preimages, label them verified, or report complete Doctor resolution from them.
The recorded incident state remains visible for audit. A previously captured
artifact that disappears is a compilation failure, not a downgrade to unavailable.
Unsealed local records cannot prove that historical evidence was never deleted
before capture; the receipt does not claim such external completeness.

## Timing And Projections

Timing comes from explicit measured activity observations bound to the plan and
candidate. Productive Worker/model durations are separate from hook contention,
retries, recovery, Doctor activity, compilation, review, and broad-gate durations.
They are not added into a wall-clock estimate or used to claim model quality.
Incomplete coverage, including omitted applicable Doctor time, produces unavailable
timing rather than inferred values.

Identical validated inputs produce byte-identical canonical JSON. Markdown uses
fixed ordering and embeds the JSON receipt hash plus input, plan, item, workflow,
commit, and tree identities. Rendering parsed canonical JSON produces the same
Markdown as rendering the in-memory object. Neither projection copies prompts,
source blobs, tool payloads, credentials, private titles, or issue bodies.

## Read-Only CLI

The installed helper accepts bounded JSON stdin:

```text
node <immutable-plugin-root>/src/cli.mjs campaign inventory
node <immutable-plugin-root>/src/cli.mjs campaign compile --format json
node <immutable-plugin-root>/src/cli.mjs campaign compile --format markdown
```

Omitting `--format` defaults to JSON. The request carries `session_id`, optional `transcript_path`, and, for compilation,
`manifest`. An unavailable authority fails closed. The helper prints the result;
only the owning Worker may bank it. These commands do not admit, resume, release,
or create campaign state. Foreground source development and temporary test
fixtures are separate from that production authority boundary.

Read-only here means no campaign-state writes. Git validation may refresh its
index stat cache or materialize tree objects through `write-tree`; it does not
change file content, the staged tree, commits, or refs.