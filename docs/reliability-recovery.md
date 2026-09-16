# Bounded Local Reliability And Recovery

Wave A supports local failure → diagnosis → authorized recovery → explicit
resume → governed work. It does not promise uninterrupted execution, a real
ten-issue canary, provider-sealed banking, automatic installation replacement,
or unlimited campaign retention. Host approvals, quotas, shutdown, and stronger
host-attested approval remain separate boundaries.

## Authority And Read-Only Diagnosis

Use the verified immutable installation and the accepted workflow assurance.
Default `host-attested` authority never falls back to `local-scoped`.
Local-scoped diagnosis verifies the real matching VS Code session and accepted
source/workflow without requiring an owning attachment.

```text
node <immutable-plugin-root>/src/cli.mjs recovery inspect
node <immutable-plugin-root>/src/cli.mjs recovery propose
node <immutable-plugin-root>/src/cli.mjs recovery authorize <proposal-path> <proposalHash>
node <immutable-plugin-root>/src/cli.mjs recovery apply
```

`inspect` accepts JSON stdin with `session_id` and any required
`transcript_path`. `propose` adds the exact `expectedHash` returned by inspection
and one typed `action`. Both are bounded, zero-write observations: no locks,
directories, routes, markers, incidents, grants, or journal entries are created.
Incomplete, racy, or unavailable evidence is not an empty successful observation.

Actions are closed variants:

- `legacy-reconcile`, with `resolution` of `use-proven-state` and its inspected
  `evidenceHash`, or `preserve-uncertainty`.
- `finish-release`, bound to the inspected `frontierHash`.
- `recover-lock`, bound to one `scope` and `snapshotHash`.
- `quarantine-journal-entry`, bound to one inspected `entryHash`.
- `confirm-completed-action`, bound to an original quarantine action ID and
  its exact intent-byte hash. It can confirm an already-proved move, not run one.

The direct operator reviews the complete proposal, target, uncertainty and
prospective session. `authorize` reads the bounded proposal file and requires
interactive confirmation of exactly `AUTHORIZE <proposalHash>`. There is no
`--yes`, approval boolean, environment flag, stdin confirmation, or Worker/Doctor
grant equivalent. A fresh observation after confirmation must still match.

The resulting one-action authorization binds the complete snapshot, repository,
source, workflow, session, action and single-use identity. Its fixed lifetime is
ten minutes, with no renewal. `apply` accepts the session fields and
`authorizationHash`; it reopens that exact stored grant under the existing
exclusion/CAS machinery. Repeated completed requests return the original receipt,
not a second effect. Operator reconciliation publishes a frontier, not a Worker
attachment. A separate, explicit `resume` acquires ownership.

Interactive local confirmation is cooperative operator authorization, not
protected human-identity proof against arbitrary same-user processes. A missing
strong-host approver remains blocked. Source implementation approval is never a
campaign-reconciliation grant. No recovery action can seize an unrelated active
attachment, fabricate lineage, replay an unknown external effect, or admit an
ordinary tool while admission remains blocked.

## Authoritative Frontier And Counters

The helper owns:

```text
.supervised-worker/recovery/head.json
.supervised-worker/recovery/frontiers/<exact-file-sha256>.json
.supervised-worker/recovery/authorizations/<exact-file-sha256>.json
.supervised-worker/recovery/actions/<action-uuid>/...
```

The head selects a causally linked immutable frontier; sequence is checked
against predecessors, not used to choose the largest file. Directory order,
mtime, maximum/majority counters and the only surviving runtime cache never
select authority. Frontiers retain campaign, source, workflow, plan and owner
bindings, Stop state, journal-prefix coverage and identified unknown operations.
Version 3 runtime files are bound caches/history and are not deleted on release.

Ordinary tool starts, completions and denials update the journal, not the frontier
or runtime cache. Current operations combine that validated journal evidence with
the stable frontier's retained identities. Current-owner hooks and publication
CAS use exact canonical head/tip and owner/plan/generation checks; this bounded
tip verification is not an ancestry proof. Checkpoint, resume, ownerless recovery
and predecessor-dependent decisions retain full-chain verification.

Exact counters retain their integer values. A lost current tail remains
`certainty: "unknown", value: null`, with a proven `lastObservation` when one
exists. `knownAfter` counts only new durable decisions after reconciliation.
Unknown same-progress history gives no additional Stop-block allowance: the
host may stop honestly. An actual governed plan-progress change can start a new
bounded same-progress epoch, without making historical totals exact.

Stop and explicit release publish and read back `detach-prepared` and its head
before releasing the exact source route/attachment. They then publish `detached`.
Journal mirroring is a separate observation. If required persistence fails, the
host may stop, but evidence is retained and detach is not claimed. A prepared
release can be completed only from exact proven pre/post-state; a lost outcome
does not imply that its mutation did or did not happen.

Checkpoint v3 references a prepared source frontier; the terminal frontier
references the checkpoint, avoiding a hash cycle. Resume persists successor
generation IDs before publishing the new route/claim and reuses those IDs on
an interrupted retry. Success requires confirmed context, attachment, route,
journal observation and final frontier.

The resume request contains `session_id`, any `transcript_path`, `planHash`,
`checkpointHash` (possibly null), and `frontierHash`. Ownerless resume requires
the explicit frontier hash. A current checkpoint may omit it only when the
matching frontier is uniquely verified under guards. Historical v1/v2 checkpoints
remain readable evidence; an older plan binding is not current admission authority.

## Canonical Doctor Requests And Ordered Locks

Trusted hook failures carry an already-generated `recoveryInvocation`. Execute
that exact command, not another formatter tool first. `doctor request` is the
bounded formatter for healthy/direct use. The formatter and strict recognizer
share quoting and operation-specific validation:

- `diagnose`: session fields only.
- `propose-recovery`: session fields, `expectedHash`, and `action`.
- `recover-authorized`: session fields and `authorizationHash`.
- Existing `detect`, `inspect`, `grant`, `handoff`, and `execute` retain their
  actual required incident/record/hash fields.

Malformed envelopes, `action` in place of `operation`, wrappers, alternate
executable path spellings, extra commands, and oversized native requests do not
qualify. Generated commands over 8,000 UTF-8 bytes return
`DOCTOR_NATIVE_REQUEST_TOO_LARGE` with `command: null`. Direct operator stdin is
not an ordinary-tool bypass. Hook allowance is not an execution receipt.

Recover repository, then applicable session, then journal scope. Later scopes
are deferred while a prerequisite blocks inspection. One action binds one
selected `snapshotHash`, also present in its evidence hashes. The kernel
revalidates that selected snapshot before minting capability. Reinspect and
obtain fresh authorization before another scope; no internal multi-scope retry
loop exists. Live/unknown owners remain untouched and permanent fences remain.

## Publication And Single-Entry Quarantine

`campaign publish` accepts session fields plus the existing release `manifest`.
It requires current owning Worker authority, compiles and serializes through the
unchanged compiler, revalidates the candidate/inputs, publishes atomically, and
reopens exact bytes before success. The helper selects:

```text
.supervised-worker/releases/<receipt-byte-sha256>.json
```

Identical bytes are idempotent. Conflicting bytes, replaced ownership/ancestors,
unsafe paths and unconfirmed fsync/readback never become successful publication.
There is no destination, overwrite or append option. Direct-edit targets in the
publication subtree are protected. `campaign compile` remains read-only stdout.
The obsolete `logs/gates/supervised-worker/releases/` destination violates the
unchanged compiler/handoff untracked-source rule; do not add ignore exceptions.
Publication does not bank an item or satisfy Stop, and does not expand release
input locator admission.

One explicitly authorized quarantine may move one inspected foreign regular
file from `runs/`: non-journal name, single link, at most 4 MiB, exact parent,
file identity, length and byte hash. Journals, directories, links and unknown
partial kernel publications are ineligible. The fixed destination is:

```text
.supervised-worker/recovery/quarantine/<action-uuid>/<source-byte-sha256>.quarantined
```

Only `.`, `.supervised-worker`, `.supervised-worker/recovery`,
`.supervised-worker/recovery/quarantine`, and its exact action UUID directory
are quarantine ancestors. Persisted intent precedes one same-filesystem rename;
there is no copy/truncate/delete fallback or destination overwrite. Confirmation
requires exact destination identity/bytes and unchanged original journal
inventory/bytes. An exact completed move may be confirmed after a lost response;
otherwise the unknown outcome stays fenced. Fresh diagnosis, compilation and a
governed tool, then checkpoint/fresh resume, prove restored local progress.

### Lost Outcome After Authorization Expiry

The ten-minute grant is never extended or reused after expiry. Diagnosis retains
an incomplete action and may offer `confirm-completed-action` only when the
original authorization/proposal/intent/metadata cross-links, absent source,
exact destination identity/bytes and ancestor identities prove a completed
quarantine. Later journal writes must preserve every recorded original prefix
and leave valid current journals; an old journal inode is not required after
legitimate atomic appends.

Other foreign entries captured in the original inventory remain separate from
canonical journal segments. They must either retain their exact identity and
bytes or be accounted for by another exact, authorized quarantine bundle with
its payload preserved. Confirming one completed move does not declare the
remaining foreign entries healthy or admit ordinary work while journal
integrity is still unavailable. Extra payload members or orphan quarantine
directories are incomplete evidence, not a healthy empty observation.

Obtain a fresh operator authorization for that exact current snapshot. The
helper writes only:

```text
.supervised-worker/recovery/actions/<original-action-id>/confirmation.json
```

This immutable `recovery-action-confirmation` is both the receipt and the new
authorization's consumption record. Its `postStateHash` names the fresh
proposal's observed state, not a backdated original outcome. The helper never
calls the quarantine mover, copies/deletes/rewrites payloads, or creates a second
pending generic action. Existing outcomes are preserved, exact repeats are
idempotent, and conflicting confirmations are rejected.

Release inventory retains the confirmation, both authorization chains and the
original payload hash. The new confirmation invalidates an older inventory
manifest. A missing, reappeared or replaced source/destination cannot be
confirmed; it remains an explicit recovery boundary.

## Capacity And Qualification

Hard journal bounds remain 256 files, 1 MiB/file, 16 MiB aggregate and
16 KiB/record. Admission reserves 1 MiB plus four file slots for control and two
maximum terminal records for each identified in-flight tool/helper operation.
Every producer is classified; uncorrelated/repeated terminals cannot use another
operation's reservation. Projected admission writes, rollover and successor
files are charged under exclusion before admission.

The unresolved-operation limit remains 256, including inherited identities,
helper reservations and partially consumed retry bundles. Admission projects the
actual union before execution; `RECOVERY_OPERATION_LIMIT` and identity conflicts
cannot degrade into a truncated successful observation. Only exactly correlated
positive evidence resolves a retained unknown.

Capacity denials before admission do not append a denial stream. If a start was
already durably published before an admission failure, its exactly correlated
`not-executed` cancellation may consume its reserved terminal capacity. Failure
to persist that cancellation retains the exact unknown identity; checkpoint
fails while the unresolved set cannot be represented. Already-admitted terminals and
bounded checkpoint/release/recovery control remain possible within headroom.
Starting another session never resets usage or outstanding liabilities. Status
and diagnosis expose measured usage, terminal/control reservation and remaining
ordinary/control headroom. At exhaustion, checkpoint/resume may work while tools
remain capacity-denied: that is a fail-safe, not restored throughput.

The recovery store remains 16 MiB / 1,024 records, with 2 MiB / eight records
reserved for finalization. Control records are at most 256 KiB; canonical
quarantined payloads retain their separate 4 MiB artifact bound, with all bytes
charged and complete bundles reserved before mutation. Reservations are logical,
not disk preallocation: ENOSPC/EIO can still leave explicit uncertainty.
Wave A never prunes, archives, truncates, or raises caps.

Within one held journal guard, hooks capture bounded journal segments once,
build linear correlation indexes, and advance only verified own appends and
affected tail metadata. Inventory, identity and authority rechecks remain
mandatory. Unexpected changes invalidate the capture; there is no persistent
cache, cross-guard reuse or mtime-only authority. Recovery-store capacity uses
bounded regular-file metadata rather than rereading historical payloads. The
installed launcher budgets remain 15 seconds on Windows and 5 seconds on POSIX.

Preserve legacy bytes through migration. Before new-format state, an ordinary
source rollback in an engineering fixture is possible. After migration or new
effects, do not downgrade in place or restore an earlier campaign snapshot:
preserve evidence and use a compatible corrected build. Installation activation,
Windows/macOS/Linux Node 20/22/24 qualification, independent frozen review/gates,
and a real ten-issue/five-handoff canary require their own observed evidence.
