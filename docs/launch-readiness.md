# Launch Readiness

Supervised Worker should launch on a result, not on a list of governance
features.

## Product Wedge

> Give GitHub Copilot a backlog. Supervised Worker keeps the work resumable and
> makes the build and review evidence checkable before you trust a completion
> claim.

The product does not compete with coding agents on model quality or token
throughput. It makes long-running work inspectable through durable queue state,
bounded authority, role-separated context-isolated review, exact-tree
validation, and explicit completion records.

## Milestones

### Current: Untagged Local Alpha

Implemented, but not a release. Local plan-completion shape and explicit local
handoff verification are separate checks. The Worker must invoke the handoff
verifier; Stop does not yet require a verified handoff or provider receipt.

### First Tagged Prerelease

Requires a green public Windows, macOS, and Linux matrix on the exact tagged
commit, immutable installation instructions, a five-minute first-run path, and
the Local Alpha claims below. This gate is currently unmet.

### Provider-Verified Public Announcement

This is the announcement milestone for the **Provider-Verified Completion**
capability. It requires provider truth, receipt-to-completion integration, the
authoritative dogfood gate in this document, an external campaign, and the
launch assets. This is the main promotional milestone.

### Evidence-Gated Learning Wave

Requires the held-out learning evaluation. It is a separate announcement, not a
dependency for provider-verified completion.

## Claim Ladder

### Local Alpha

The current alpha may claim:

- durable queue state supports continuation from a fresh Copilot session after
   explicit release or completion of the prior owner;
- build and review artifacts are bound to exact bytes and the staged Git tree;
- the explicit handoff verifier rejects a non-clean role-separated review;
- pending or in-progress items cannot satisfy the local completion schema; and
- lifecycle failures release visibly rather than silently claiming completion.

It must not claim that Stop consumes verified handoff evidence or that the
plugin independently proves GitHub pagination, remote push state, CI success,
pull-request state, reviewer identity, or issue closure. Those facts remain
Worker-supplied claims until provider reconciliation and host attestation ship.

### Provider-Verified Completion

This claim requires:

- authenticated GitHub enumeration with pagination and truncation detection;
- remote branch and pushed-commit verification;
- pull-request, review, CI, and issue-state reconciliation;
- externally sealed receipts linking provider facts to the reviewed
   candidate;
- host-attested reviewer identity and profile provenance; and
- completion status and Stop consuming a verified campaign evidence receipt
   rather than accepting evidence-reference shape alone.

The intended promise is:

> GitHub Copilot cannot call the backlog done until GitHub, Git, CI, tests, and
> a host-attested reviewer agree.

### Evidence-Gated Learning

Learning is a later launch wave. It may advise only after held-out evaluation
shows less rework without more policy violations, intervention, or elapsed
time. Learned state never grants authority or satisfies a completion gate.

## Evidence Authorities

Three authorities remain distinct in the provider-verified design:

- The **host witness** is an append-only, host-attested stream outside Worker
   control. It records every Supervised Worker campaign-start attempt, hook
   invocation, governed tool request, and provider-operation request before
   dispatch, then records the observed result under the same witness identity.
- The **provider authority** supplies authenticated repository identity,
   pagination, actor, operation, ref-transition, issue-transition, CI, review,
   and final-state facts.
- The **external launch verifier** precommits evaluation policy, accepts the
   host/provider trust roots, reconciles their complete inventories with plugin
   records, and seals campaign and launch receipts.

The Worker and target repository control none of these signing keys. If the
host cannot attest the complete invocation stream, or the provider cannot expose
the required transition facts, Provider-Verified Completion is unavailable.
For public launch evidence, the external verifier key is controlled by an
evaluator who is neither the campaign operator nor a maintainer of the evaluated
repository; changing that evaluator or key requires a new pre-signed evaluation
plan before any eligible start.

## Dogfood Gate

This section is the authoritative launch gate. Other documents link here rather
than maintaining a second checklist.

Before the first eligible start, an external launch verifier must sign an
evaluation plan that fixes its start, end, repository-inclusion rule,
campaign-admission rule, verifier key, and public-projection policy. Admission
rules are deterministic functions of pre-outcome facts only: repository ID,
scheduled time, plugin/workflow hashes, queue-query hash, and declared test
variant. They cannot inspect campaign disposition, metrics, findings, or later
receipts.

The host witness records every eligible campaign-start attempt before
`startedAt` or any campaign event. The verifier records exactly one result:
`admitted`, `rejected`, or `failed`. Only an admitted result issues an admission
token, and it does so before work begins. Every result enters one contiguous,
hash-chained attempted-campaign ledger. A sealed launch-evidence index must cover
the plan's complete attempted sequence. A gate-critical value with
`worker-recorded` or `unavailable` provenance fails the gate, as does an empty
or unknown denominator except where explicitly allowed.

### Attempted-Campaign State Machine

Each eligible start produces exactly one attempt record with a canonical
`attemptId`, contiguous `attemptSequence`, previous-record hash, witness ID,
policy-input hash, policy-result hash, and one `admissionDisposition`:

| Admission disposition | Required evidence and allowed result |
| --- | --- |
| `admitted` | `attempt:witness`, `attempt:policy-input`, `attempt:policy-result`, `attempt:admission-token`, `attempt:no-pre-admission-work`, and `attempt:campaign-link`; policy result is true; token and new `campaignId` were issued before work; exactly one evidence receipt and one outcome receipt reference the attempt. |
| `rejected` | Policy result is false; typed rejection reason is sealed; no admission token, campaign ID, campaign event, or campaign receipt may exist. |
| `failed` | Policy evaluation or token issuance failed; typed error receipt is sealed; no admission token, campaign ID, campaign event, or campaign receipt may exist. |

Unknown dispositions, duplicate attempt IDs, sequence gaps, a campaign without
one admitted attempt, more than one campaign lineage for an admitted attempt,
or work before admission invalidate the launch index. `completed`, `blocked`,
`needs-input`, and `aborted` are final dispositions of an admitted campaign;
they are never admission dispositions.

Rejected attempts require `attempt:witness`, `attempt:policy-input`,
`attempt:policy-result`, `attempt:rejection-reason`, and
`attempt:no-token-or-work`. Failed attempts require `attempt:witness`,
`attempt:policy-input`, `attempt:error`, and `attempt:no-token-or-work`.
The launch verifier derives and verifies these subject-qualified obligations for
every attempt row before sealing the launch index.

### Launch Evidence Index

The externally sealed launch index is the authoritative attempted-campaign and
receipt-issuance inventory. It includes:

```text
schemaVersion, evaluationPlanHash, generatedAt
evaluationStartedAt, evaluationEndedAt
attemptLedgerStartRoot, attemptLedgerEndRoot
receiptIssuanceStartSequence, receiptIssuanceEndSequence
receiptIssuanceStartRoot, receiptIssuanceEndRoot
attempts[].attemptSequence, attempts[].previousHash, attempts[].attemptId
attempts[].witnessOperationId, attempts[].policyInputHash
attempts[].policyResultHash, attempts[].admissionDisposition
attempts[].admissionTokenId (admitted only)
attempts[].campaignId (admitted only)
attempts[].evidenceReceiptHash (admitted only)
attempts[].outcomeReceiptHash (admitted only)
attempts[].receipts.entries[].receiptId
attempts[].receipts.entries[].obligationId
attempts[].receipts.entries[].requirementKey
attempts[].receipts.entries[].subjectType
attempts[].receipts.entries[].subjectId
attempts[].receipts.entries[].kind
attempts[].receipts.entries[].contentHash
attempts[].verification.expectedObligationIds
attempts[].verification.validReceiptIds
attempts[].verification.verifiedObligationIds
attempts[].verification.receiptCompleteness
issuedReceipts[].issuanceSequence, issuedReceipts[].previousHash
issuedReceipts[].receiptHash, issuedReceipts[].receiptKind
issuedReceipts[].attemptId, issuedReceipts[].campaignId (campaign receipts only)
provenance, launchIndexSeal
```

The external verifier appends every separately signed attempt receipt, campaign
evidence receipt, and campaign outcome receipt to its issuance ledger before
releasing that signature. The one final launch index reconciles the complete
contiguous pre-index issuance range for the evaluation plan. An admitted attempt
must name exactly one issued evidence receipt and one issued outcome receipt,
each bound to that attempt and campaign. Rejected and failed attempts name
neither. An unreferenced, duplicate, or multiply referenced issued campaign
receipt, a missing issuance sequence, or a receipt signed under the evaluation
key but absent from the issuance ledger invalidates the launch index. The
index's own seal is validated externally and is not entered into the range it
seals or into its internal attempt-obligation set.

### Host-Witness Classification

The signed evaluation plan fixes a versioned classifier before the first
eligible start. Host records use only these `recordKind` values:
`campaign-start`, `hook-invocation`, `governed-tool`, and
`provider-operation`. Pre-dispatch and result records share one immutable
`witnessOperationId`; a missing result is represented by a typed timeout or
failure result, never by omission.

The verifier, not the Worker, assigns each operation exactly one classification:
`attempt-ledger`, one of the eight campaign event types in the receipt schema,
or `supporting-only`. `campaign-start` always maps to `attempt-ledger`.
Session ownership changes, declared fault injections, completion decisions,
release decisions, ownership mutations, pushes, issue closures, and issue
creations map to their matching campaign event type. All other hook and governed
tool operations map to `supporting-only`. Authenticated read-only provider
operations for queue enumeration, repository metadata, pull requests, CI,
reviews, issue state, and ref observation also map to `supporting-only`. They
remain in the witnessed inventory and root but create no campaign event. A
provider mutation other than push, issue closure, or issue creation is unknown
and fails verification; it never falls through to `supporting-only`. Unknown
record kinds, unknown classifications, producer-supplied classifications, or an
operation matching more than one classifier rule fail verification. Every
non-supporting operation maps to exactly one attempt record or campaign event,
and every attempt/event maps back to exactly one witnessed operation.

| Criterion | Counted event and denominator | Required evidence | Minimum provenance |
| --- | --- | --- | --- |
| At least 3 finalized campaigns | Distinct `campaignId`; denominator is every eligible start in the attempted-campaign ledger. Finalized means pre-work admission, complete ending snapshots, final disposition of `completed`, `blocked`, or `needs-input`, and a valid seal exist. Rejected and aborted attempts remain in the denominator but do not count toward the three. | Attempt witness, admission token, complete start/end snapshots, disposition receipt, campaign seal | Host-attested attempt and plugin-verified local facts plus externally verified provider facts |
| At least 1 completed provider campaign | One finalized campaign with a successful reviewed-candidate push, at least one campaign-attributed provider closure, and an accepted completion that consumed its verified campaign evidence receipt | Push, closure, final-state, evidence-receipt, outcome-receipt, and completion-decision receipts | Plugin-verified local facts and externally verified provider facts |
| At least 2 repositories, one not maintained by the author | Distinct immutable `providerRepositoryId` across finalized campaigns | Provider repository metadata and signed maintainer-status attestation | Externally verified |
| At least 25 banked pre-existing items | Distinct `(providerRepositoryId, itemId)` present in the starting queue snapshot and carrying a valid final local evidence chain | Starting queue membership plus contract, build, review, gate, and banking receipts | Externally verified membership and plugin-verified local chain |
| At least 10 fresh-session resumes | Distinct old-session/new-session transition; denominator is every attachment-owner transition | Prior release or completion, new attachment, unchanged campaign/plan identity, and existing actionable item | Plugin-verified |
| At least 1 deliberate crash recovery and 1 compaction recovery | Distinct declared injection; denominator is every declared injection | Pre-injection state, injection marker, post-restart or post-compaction attachment, and continued item identity | Plugin-verified |
| At least 1 genuine blocked or needs-input item | Distinct item final disposition | Item-state transition, reason code, and unresolved authority or dependency receipt | Plugin-verified |
| Zero premature completions | Accepted completion without a valid campaign evidence receipt; denominator is every completion attempt and must include at least one accepted attempt | Completion-decision receipt consuming the verified campaign evidence receipt | Plugin-verified |
| Zero duplicate closures | Repeated campaign-attributed provider closure side effect for one item; denominator is every closure attempt and must include at least one successful closure | Provider actor, operation identity, attribution, and final issue state | Externally verified |
| Zero wrong-commit pushes | Campaign-attributed remote push differing from the reviewed candidate; denominator is every push attempt and must include at least one successful push | Reviewed-tree receipt, provider actor and operation identity, attribution, and authenticated remote-ref observation | Plugin-verified tree and externally verified provider facts |
| Zero unbudgeted issue creations | Campaign-attributed provider issue creation without an admitted filing-policy disposition; denominator is the complete provider issue-creation event set. This is the only zero criterion whose denominator may be zero. | Provider actor, operation identity, attribution, creation event, and filing-policy receipt | Externally verified event set and plugin-verified policy disposition |
| Zero unresolved provider attribution | Provider mutation that cannot be classified as campaign-attributed or ambient; denominator is every provider push, closure, and issue-creation event and must include at least one push and closure | Complete provider event inventory and attribution receipts | Externally verified |
| Zero unverifiable release claims | Release or completion claim lacking its required receipt chain; denominator is every such claim and must be nonzero | Release-decision receipt and referenced evidence set | Plugin-verified |
| Zero manual ownership-state edits after admission | Ownership mutation absent from the plugin hash chain; denominator is every ownership-state mutation and must be nonzero | Complete mutation hash chain plus signed operator or host attestation | Plugin-verified chain and externally verified attestation |

The plugin is not a security boundary against a malicious same-user process.
The final criterion is therefore an explicit attested dogfood condition, not a
claim that arbitrary filesystem writes are impossible.

A fresh-session resume means the prior owner was explicitly released or
completed, then a different session attached to the already-valid durable plan
and continued existing actionable work. A denied takeover while another session
owns the plan does not count.

A banked item has complete local evidence. A provider-closed item is separately
confirmed closed by the authenticated tracker. Banking never implies closure.
An unbudgeted issue is one created outside the campaign's documented filing
policy or discovery allowance.

Report campaign-attributed operations and ambient repository movement
separately. A campaign with 20 attributed pre-existing closures and 3 attributed
new defects that remain open at the ending snapshot, and no ambient changes,
reports `20 attributed closures`, `3 attributed creations`,
`repositoryNetOpenChange = -17`, and `repositoryNetOpenReduction = 17`.

## Local Campaign Receipt

The v0.1 alpha implements a separate `local-campaign-receipt` v1 for local
inspection and screenshots. `campaign export` emits deterministic JSON to
stdout by default; `--format markdown` renders only the validated JSON facts,
and `campaign validate <path>` safely reconciles a saved JSON receipt against
the current workspace. A partial local observation is still rendered but exits
`1` and carries null dependent metrics rather than false zeros.

This artifact verifies only local plugin identity, plan structure and canonical
hash, hashed item statuses, and the bounded metadata-only run ledger. It omits
raw plan and execution content. Repository, queue, remote, pull-request, CI,
reviewer, and closure facts are schema-fixed to unavailable with null values and
explicit reasons. The Markdown warning is **Local-only, not Provider-Verified
Completion**.

The local receipt is not a partial instance of the provider receipt family
below. It does not implement provider reconciliation, a provider canonicalizer,
external verification, public/private projections, sealing, completion
acceptance, or Stop integration, and it cannot satisfy any launch criterion in
this document that requires provider or host authority.

## Campaign Receipt

The highest-leverage missing provider product surface is a deterministic,
versioned campaign evidence/outcome receipt family. A private canonical JSON
receipt is authoritative. A public JSON projection is derived from an explicit
allowlist and binds the private receipt hash. Markdown or static HTML renders
only that public JSON.

These are normative implementation requirements, not a claim that either
provider schema exists today. The checked-in local campaign receipt schema is a
distinct artifact and does not satisfy them. Provider-Verified Completion
remains unavailable until checked-in provider schemas, a provider canonicalizer,
an external verifier, sealing, and negative tests enforce the full family.

The private receipt family has two immutable phases. The external verifier first
seals a **campaign evidence receipt** containing everything available before a
completion decision. Stop consumes that exact evidence-receipt hash. The host
witness then records every completion attempt and result. The external verifier
reconciles those post-evidence events and seals a **campaign outcome receipt**
that references the evidence receipt and final decision. Neither artifact
contains or mutates its own decision.

The campaign evidence receipt includes:

```text
schemaVersion, attemptId, campaignId, generatedAt, startedAt, evidenceClosedAt
evidenceDisposition
plugin.version, plugin.sourceHash, workflow.acceptedHash
repository.provider, repository.providerRepositoryId
repository.canonicalUrl, repository.visibility, repository.remoteIdentityHash
source.branch, queue.canonicalQuery, queue.queryHash
queue.startObservedAt, queue.startingSnapshotHash, queue.startingOpenItemIds
queue.evidenceObservedAt, queue.evidenceSnapshotHash, queue.evidenceOpenItemIds
backlog.startObservedAt, backlog.startingSnapshotHash, backlog.startingOpenIssueIds
backlog.evidenceObservedAt, backlog.evidenceSnapshotHash
backlog.evidenceOpenIssueIds
inventory.attemptSequence, inventory.admissionSequence
inventory.pluginStartRoot, inventory.pluginEndRoot
inventory.hostWitnessStartRoot, inventory.hostWitnessEndRoot
inventory.providerEvidenceStartRoot, inventory.providerEvidenceEndRoot
inventory.providerEvidenceQueryHash, inventory.providerEvidencePagesHash
admissionTokenId, evaluationPlanHash
witnessOperations[].witnessOperationId, witnessOperations[].recordKind
witnessOperations[].requestWitnessId, witnessOperations[].resultWitnessId
witnessOperations[].classification, witnessOperations[].campaignEventId (optional)
items[].itemId, items[].startingMembership, items[].localDisposition
items[].providerDisposition, items[].receiptIds
events[].sequence, events[].previousHash, events[].eventId, events[].eventType
events[].observedAt, events[].authority, events[].hostWitnessEventId
events[].authorityEventId, events[].transitionAuthorityEventId
events[].actorIdentityHash, events[].operationId, events[].attribution
events[].attributionReceiptId, events[].itemId (optional)
events[].beforeStateHash, events[].afterStateHash
events[].disposition, events[].receiptIds
receipts.entries[].receiptId, receipts.entries[].obligationId
receipts.entries[].requirementKey, receipts.entries[].subjectType
receipts.entries[].subjectId, receipts.entries[].kind
receipts.entries[].contentHash
verification.expectedObligationIds, verification.validReceiptIds
verification.verifiedObligationIds, verification.receiptCompleteness
provenance, evidenceSeal
```

The campaign outcome receipt includes:

```text
schemaVersion, attemptId, campaignId, evidenceReceiptHash, generatedAt
startedAt, endedAt, campaignDisposition, finalDecisionEventIds
pluginEvidenceRoot, pluginOutcomeRoot
hostWitnessEvidenceRoot, hostWitnessOutcomeRoot
providerEvidenceRoot, providerOutcomeRoot
providerOutcomeQueryHash, providerOutcomePagesHash, providerInventoryClosedAt
queue.endObservedAt, queue.endingSnapshotHash, queue.endingOpenItemIds
backlog.endObservedAt, backlog.endingSnapshotHash, backlog.endingOpenIssueIds
postEvidenceEvents[] (same canonical event shape as evidence events[])
receipts.entries[].receiptId, receipts.entries[].obligationId
receipts.entries[].requirementKey, receipts.entries[].subjectType
receipts.entries[].subjectId, receipts.entries[].kind
receipts.entries[].contentHash
verification.expectedObligationIds, verification.validReceiptIds
verification.verifiedObligationIds, verification.receiptCompleteness
metrics.startingOpenCount, metrics.endingOpenCount
metrics.campaignAttributedPreExistingClosures
metrics.campaignAttributedNewIssuesOpened, metrics.ambientProviderMutations
metrics.unresolvedProviderMutations
metrics.repositoryNetOpenChange, metrics.repositoryNetOpenReduction
metrics.netQueueOpenChange
sessions.started, sessions.resumed, reviews.rounds, reviews.findingsCaught
incidents.prematureCompletions, incidents.duplicateClosures
incidents.wrongCommitPushes, incidents.unbudgetedIssueCreations
incidents.unverifiableReleaseClaims, incidents.manualStateInterventions
elapsedMilliseconds, modelCostDecimal (optional), provenance, outcomeSeal
```

### Normative Data Rules

| Value class | Required representation |
| --- | --- |
| Identity | Non-empty opaque string. Identity arrays are sorted and unique. |
| Evidence identity | Lowercase 64-character SHA-256 of the typed canonical evidence object. |
| Hash | Lowercase 64-character SHA-256. |
| Timestamp | UTC RFC 3339 string with a trailing `Z`. |
| Count or duration | Integer greater than or equal to zero. |
| Signed change | Integer; negative, zero, and positive values are valid. |
| Completeness ratio | Number from 0 through 1, or `null` when unavailable. |
| Monetary cost | Optional non-negative decimal string, never a binary float. |
| Measured or derived value | Object with exactly `value`, `provenance`, and sorted unique `evidenceReceiptIds`. `value` is `null` if and only if provenance is `unavailable`. |
| Admission disposition | One of `admitted`, `rejected`, or `failed`; governed by the attempted-campaign state machine. |
| Evidence disposition | One of `ready-for-completion`, `blocked`, `needs-input`, or `aborted`. |
| Campaign disposition | One of `completed`, `blocked`, `needs-input`, or `aborted`. |
| Starting membership | Exactly `initial`; `items[]` is a one-to-one representation of `queue.startingOpenItemIds`. Later discoveries are provider events, not silently admitted work. |
| Local item disposition | One of `banked`, `blocked`, `needs-input`, `not-started`, or `aborted`. |
| Provider item disposition | One of `open`, `closed-by-campaign`, `closed-ambient`, `transferred`, `deleted`, or `unresolved`. |
| Event type | One of `session-transition`, `fault-injection`, `completion-attempt`, `release-claim`, `ownership-mutation`, `push-attempt`, `provider-closure-attempt`, or `provider-issue-creation`. |
| Event disposition | Restricted by the event-obligation table below. Any other value is rejected. |
| Event attribution | One of `campaign`, `ambient`, or `unresolved`. Non-provider events use `campaign`. |

Subject IDs are verifier-derived and globally namespaced:

```text
campaignSubjectId = SHA256(JCS([
   "supervised-worker-subject-v1", "campaign", campaignId
]))

itemSubjectId = SHA256(JCS([
   "supervised-worker-subject-v1", "item",
   campaignId, repository.provider, repository.providerRepositoryId, itemId
]))

eventSubjectId = SHA256(JCS([
   "supervised-worker-subject-v1", "event", campaignId, eventId
]))

attemptSubjectId = SHA256(JCS([
   "supervised-worker-subject-v1", "attempt", evaluationPlanHash, attemptId
]))

obligationId = SHA256(JCS([
   "supervised-worker-obligation-v1",
   requirementKey,
   subjectType,
   subjectId
]))

evidenceExpectedObligationIds =
   evidenceCampaignObligations(campaignSubjectId, evidenceDisposition)
   union itemObligations(each canonical itemSubjectId and both dispositions)
   union eventObligations(each canonical pre-evidence eventSubjectId,
      event type, and event disposition)

outcomeExpectedObligationIds =
   outcomeCampaignObligations(campaignSubjectId, campaignDisposition,
      evidenceReceiptHash)
   union eventObligations(each canonical post-evidence eventSubjectId,
      event type, and event disposition)

attemptExpectedObligationIds =
   attemptObligations(attemptSubjectId, admissionDisposition)

validReceiptIds = receipt IDs whose schema, subject, content hash, authority,
   signature when required, time bounds, and dependency hashes all verify

phaseVerifiedObligationIds = obligation IDs carried by that phase's valid
   receipt entries intersect that phase's verifier-derived expected obligations
```

One receipt entry satisfies exactly one obligation ID; identical evidence used
for two subjects needs two subject-qualified entries. The verifier, never the
receipt producer, derives the expected set from the complete admitted-item and
witnessed-event inventories. Missing evidence cannot shrink that set.
Receipt entries with a noncanonical `subjectId`, a mismatched `subjectType`, or
an obligation ID that does not recompute exactly are rejected. Consequently,
the same local item ID in two repositories or campaigns and the same event ID
in two campaigns cannot share an obligation.

The evidence receipt derives obligations only from the campaign, items, and
events frozen at `evidenceClosedAt`; Stop accepts `ready-for-completion` only
when that phase has completeness 1 and a valid external evidence seal. The
outcome verifier independently re-derives the full set from the same frozen
inventories plus every host-witnessed post-evidence event and the final campaign
disposition. Outcome completeness must also equal 1. Producer-supplied expected
or verified arrays are compared with those derived sets, never trusted as input.

### Obligation Matrices

Every evidence disposition requires `evidence:attempt-witness`,
`evidence:admission`, `evidence:queue-start`, `evidence:queue-end`,
`evidence:backlog-start`, `evidence:backlog-end`, `evidence:plugin-ledger`,
`evidence:host-witness-ledger`, `evidence:provider-inventory`, and
`evidence:disposition`.

| Evidence disposition | Additional evidence-phase obligations |
| --- | --- |
| `ready-for-completion` | `evidence:all-items-ready`, `evidence:successful-reviewed-push`, `evidence:causal-provider-closure` |
| `blocked` | `evidence:blocked-reason`, `evidence:authority-or-dependency` |
| `needs-input` | `evidence:question`, `evidence:decision-boundary` |
| `aborted` | `evidence:abort-reason` |

The evidence receipt's own seal is not an internal obligation or receipt entry.
After internal completeness reaches 1, the external verifier signs the frozen
artifact; Stop independently validates that signature before consuming its hash.

Every outcome disposition requires `outcome:evidence-receipt`,
`outcome:plugin-ledger-continuation`,
`outcome:host-witness-ledger-continuation`,
`outcome:provider-inventory-continuation`, `outcome:queue-end`,
`outcome:backlog-end`, `outcome:final-metrics`, and
`outcome:final-disposition`.

| Campaign outcome disposition | Additional outcome-phase obligations |
| --- | --- |
| `completed` | `outcome:accepted-completion`, bound to the exact evidence-receipt hash |
| `blocked` | `outcome:blocked-reason` |
| `needs-input` | `outcome:question`, `outcome:decision-boundary` |
| `aborted` | `outcome:abort-reason` |

The outcome receipt's own seal is likewise validated externally after its
internal obligation set reaches completeness 1. Unknown evidence or outcome
dispositions are rejected.

For `completed`, the evidence disposition must be `ready-for-completion`,
`queue.evidenceOpenItemIds` must be empty, and every initially admitted item must
be locally `banked` and provider `closed-by-campaign`. The accepted completion
event must occur after the evidence seal, consume that exact evidence hash, and
appear in the outcome receipt. Other combinations cannot satisfy completed
outcome obligations.

| Local item disposition | Required subject-qualified obligations |
| --- | --- |
| `banked` | `item:membership`, `item:contract`, `item:build`, `item:review`, `item:gate`, `item:banking` |
| `blocked` | `item:membership`, `item:state-transition`, `item:blocked-reason`, `item:authority-or-dependency` |
| `needs-input` | `item:membership`, `item:state-transition`, `item:question`, `item:decision-boundary` |
| `not-started` | `item:membership`, `item:final-inventory`; invalid in a `completed` campaign |
| `aborted` | `item:membership`, `item:state-transition`, `item:abort-reason` |

| Provider item disposition | Required subject-qualified obligations and effect |
| --- | --- |
| `open` | `provider:final-open-state`; never closure credit |
| `closed-by-campaign` | `provider:pre-open-state`, `provider:operation-intent`, `provider:causal-close-transition`, `provider:final-closed-state`, `provider:campaign-attribution` |
| `closed-ambient` | `provider:pre-open-state`, `provider:causal-close-transition`, `provider:final-closed-state`, `provider:ambient-attribution`; never campaign credit |
| `transferred` | `provider:transfer-transition`; dependent closure and repository-net metrics unavailable |
| `deleted` | `provider:delete-transition`; dependent closure and repository-net metrics unavailable |
| `unresolved` | `provider:unresolved-state`; every dependent provider metric unavailable |

| Event type | Receipt phase | Allowed dispositions | Required subject-qualified obligations |
| --- | --- | --- | --- |
| `session-transition` | Evidence | `succeeded`, `failed` | `event:witness`, `event:prior-owner-state`, plus `event:new-attachment` on success or `event:failure` on failure |
| `fault-injection` | Evidence | `succeeded`, `failed` | `event:witness`, `event:declared-injection`, `event:pre-state`, plus `event:recovered-state` on success or `event:failure` on failure |
| `completion-attempt` | Outcome | `accepted`, `rejected`, `failed` | `event:witness`, `event:evidence-receipt`, `event:decision`; accepted requires `event:completed-state`, rejected requires `event:rejection-reason`, failed requires `event:failure` and must not produce completed state |
| `release-claim` | Evidence or outcome | `accepted`, `rejected`, `failed` | `event:witness`, `event:request`, `event:decision`; accepted requires `event:ownership-transition`, rejected requires `event:rejection-reason`, failed requires `event:failure` |
| `ownership-mutation` | Evidence or outcome | `succeeded`, `failed` | `event:witness`, `event:before-state`, plus `event:after-state` on success or `event:failure` on failure |
| `push-attempt` | Evidence or outcome | `succeeded`, `rejected`, `failed` | Always `event:witness`, `event:operation-intent`, `event:reviewed-tree`; succeeded adds `event:provider-operation`, `event:before-ref`, `event:after-ref`, `event:causal-ref-transition`; rejected adds `event:provider-rejection`, `event:rejection-reason`; failed adds `event:failure` |
| `provider-closure-attempt` | Evidence or outcome | `succeeded`, `rejected`, `failed` | Always `event:witness`, `event:operation-intent`; succeeded adds `event:provider-operation`, `event:before-issue-state`, `event:after-issue-state`, `event:causal-close-transition`; rejected adds `event:provider-rejection`, `event:rejection-reason`; failed adds `event:failure` |
| `provider-issue-creation` | Evidence or outcome | `succeeded`, `rejected`, `failed` | Always `event:witness`, `event:operation-intent`, `event:filing-policy`; succeeded adds `event:provider-operation`, `event:created-issue-state`; rejected adds `event:provider-rejection`, `event:rejection-reason`; failed adds `event:failure` |

For `completion-attempt`, `event:evidence-receipt` is the externally sealed
campaign evidence receipt presented to the decision. An accepted decision must
name that exact hash and prove the completed-state transition; a rejected or
failed attempt records the candidate hash and its reason but cannot satisfy
`outcome:accepted-completion`.

For every event type marked `Evidence or outcome`, the phase is derived from its
host-witnessed `observedAt`: events at or before `evidenceClosedAt` belong only
to the evidence receipt; events after `evidenceClosedAt` and at or before
`endedAt` belong only to the outcome receipt. Moving, duplicating, or omitting an
event across that boundary fails host-witness reconciliation.

No campaign event may be dispatched after `evidenceClosedAt` until the evidence
seal is issued. The host witness must prove that seal gap is empty. If an event
appears in the gap, the unsigned evidence candidate is discarded,
`evidenceClosedAt` advances past that event, and evidence reconciliation and
sealing restart; Stop never receives the invalid candidate.

`startedAt` and outcome `endedAt` define the closed campaign interval.
`evidenceClosedAt` freezes the provider/work evidence before Stop decides.
Provider event identities deduplicate events observed at a boundary. The queue
query fixes work membership at admission, but it does not define backlog size.
Backlog metrics use complete, authenticated, repository-wide open-issue ID sets
for one immutable `providerRepositoryId`:

```text
startingOpenCount = |evidence.backlog.startingOpenIssueIds|
endingOpenCount = |outcome.backlog.endingOpenIssueIds|
repositoryNetOpenChange = endingOpenCount - startingOpenCount
repositoryNetOpenReduction = startingOpenCount - endingOpenCount
netQueueOpenChange = |outcome.queue.endingOpenItemIds|
   - |evidence.queue.startingOpenItemIds|
phaseReceiptCompleteness =
   |phase.verification.verifiedObligationIds|
   / |phase.verification.expectedObligationIds|
```

Each phase's expected obligation set must be non-empty. Extra or duplicate
verification events cannot raise completeness above 1. A zero expected count
makes that phase's completeness `unavailable` and fails every completion or
launch gate that depends on it.

Repository-wide enumeration makes relabelling irrelevant to backlog arithmetic.
A starting item closed and then reopened before `endObservedAt` remains in the
ending open set and is not an attributed pre-existing closure. An item created
and closed during the interval counts as an attributed or ambient creation event
but is absent from both endpoint open sets. Deleted, transferred, or unresolved
provider states are separate dispositions and make the dependent attribution
and repository-net metrics unavailable. Query additions or removals affect only
`netQueueOpenChange`. Truncated or failed enumeration makes every dependent
count and metric unavailable.

`campaignAttributedPreExistingClosures` counts only IDs present in
`evidence.backlog.startingOpenIssueIds`, absent from
`outcome.backlog.endingOpenIssueIds`,
confirmed closed by the provider, carrying the required verified receipt chain,
and bound to the campaign-attributed operation that caused the open-to-closed
transition. Campaign-attributed, ambient, and unresolved provider mutations are
reported separately. Unresolved attribution makes campaign-credit metrics
unavailable; ambient activity can change repository-net metrics but never
becomes campaign credit.

`campaignAttributedNewIssuesOpened` counts unique campaign-attributed provider
creation operations within the closed interval whose filing-policy receipt is
valid, whether each issue is open or closed at the ending snapshot.
`ambientProviderMutations` and `unresolvedProviderMutations` are counts of unique
provider operation identities in their respective attribution classes.

Each campaign plugin event uses a contiguous sequence beginning at 1 and a
hash-linked `previousHash`; its admitted start root and final root are sealed.
That chain is not evidence of its own completeness. Every plugin event must
reference the pre-dispatch record of one host-witness operation. The verifier
replays the pre-signed classifier over every operation between the campaign's
host-witness roots. `attempt-ledger` operations map to exactly one attempt row,
each of the eight event classifications maps to exactly one matching plugin
event, and `supporting-only` maps to no plugin event while remaining covered by
the witness root. No witness operation is out of scope. The verifier rejects
missing request/result pairs, unknown or unclassified records, missing, extra,
reordered, or multiply mapped events, and classifications inconsistent with the
operation bytes. A producer-supplied count or recomputed final root cannot
replace this exhaustive reconciliation.

The evidence receipt's provider inventory records its authenticated query,
every page or cursor, and every provider event through `evidenceClosedAt`. The
outcome receipt repeats the exact evidence provider root and continues that
inventory through `endedAt`, including every continuation query page and
provider event. Event records are the denominator source for session
transitions, fault injections, completion attempts, release claims, ownership
mutations, provider closure attempts, issue creations, and push attempts.
Provider events also carry externally verified actor and operation identities.
Attribution is fixed by an operation-intent receipt witnessed before provider
dispatch; otherwise it is `ambient` when provider facts prove a different actor
and `unresolved` when they do not.

Outcome continuity is exact: `pluginEvidenceRoot`,
`hostWitnessEvidenceRoot`, and `providerEvidenceRoot` must equal the respective
final roots in the evidence receipt. The first post-evidence plugin event and
host operation continue from those roots and sequences; the provider
continuation covers `(evidenceClosedAt, endedAt]` with no gap or overlap. The
outcome's final queue and repository-wide backlog snapshots are authenticated
provider observations at the end of that continuation. Their bounds are:

```text
evidenceClosedAt < queue.endObservedAt <= endedAt
evidenceClosedAt < backlog.endObservedAt <= endedAt
endedAt = providerInventoryClosedAt
```

Each ending snapshot must include every provider transition affecting its set
through its own `endObservedAt`. The final provider inventory must contain no
such transition in `(queue.endObservedAt, endedAt]` for the queue snapshot or
in `(backlog.endObservedAt, endedAt]` for the backlog snapshot. If either stale
window is non-empty, the verifier must obtain a new affected snapshot and close
a later provider interval; it repeats until both stale windows are empty or
marks the dependent metrics unavailable. A snapshot observed after `endedAt` is
also invalid.

The external verifier recomputes all outcome metrics and incident denominators
from the merged evidence and outcome inventories only after these endpoint
rules pass. A continuation failure, late provider event not represented in the
final inventory, root or sequence mismatch, stale or unavailable final snapshot,
or inability to close a quiescent observation window makes every dependent
outcome metric unavailable and prevents a completed disposition.

A successful campaign closure requires one provider authority event proving the
same operation changed `before=open` to `after=closed`; a close against an
already closed issue is a no-op and receives no closure credit. A successful
reviewed push likewise requires the same provider operation to change the
authenticated target ref from a different `before` SHA to the reviewed
candidate SHA. Races, mismatched authority event IDs, and indeterminate
before/after states are `unresolved`, not campaign credit.

The external launch verifier precommits the evaluation interval and
pre-outcome-only admission rule, reconciles the complete attempted-campaign
ledger, host-witness inventory, plugin event chains, and provider inventories,
and then seals each campaign receipt and the launch index. Evidence observations
and events must satisfy `startedAt <= observedAt <= evidenceClosedAt`.
Post-evidence decision events must satisfy
`evidenceClosedAt < observedAt <= endedAt`; snapshot order is start before
evidence close. The launch index must cover every contiguous attempted sequence
between its sealed start and end roots. Work performed before the admission
token, an outcome-dependent admission rule, an omitted rejected attempt, or a
signature over a producer-selected subset fails the launch gate.

Every measured or derived field carries an envelope with `value`, `provenance`,
and sorted `evidenceReceiptIds`. Provenance is one of `plugin-verified`,
`externally-verified`, `worker-recorded`, or `unavailable`. Derived provenance
cannot be stronger than its weakest dependency. An unavailable or truncated
authority makes dependent metrics unavailable; it never becomes zero.

Both receipt phases are canonicalized with JSON Canonicalization Scheme (RFC
8785). `ed25519-sha256-jcs-v1` signs the SHA-256 digest of canonical bytes with
the artifact's own seal field omitted. Each seal records `keyId`, public-key
fingerprint, `signedAt`, and signature. The exact public-key fingerprint must be
accepted before evaluation admission, and the private key must be controlled by
the external launch verifier, not by the Worker, host coding session, or target
repository. Host receipts may establish `plugin-verified` facts but cannot
satisfy `externally-verified` criteria.

Verification reconstructs each artifact's canonical bytes, checks the accepted
fingerprint and signature, and confirms that the key was valid and unrevoked at
its `signedAt`. Time order must satisfy:

```text
startedAt <= evidenceClosedAt <= evidence.generatedAt <= evidence.signedAt
evidence.signedAt < each postEvidenceEvent.observedAt <= endedAt
evidenceClosedAt < queue.endObservedAt <= endedAt
evidenceClosedAt < backlog.endObservedAt <= endedAt
endedAt = providerInventoryClosedAt
endedAt <= outcome.generatedAt <= outcome.signedAt
```

Maximum clock skew and both seal delays are fixed in the signed evaluation plan
before campaign admission.

### Public Projection

Raw Git remotes are never serialized. Repository identity comes from
authenticated provider metadata as `https://github.com/{owner}/{repository}`;
userinfo, query, fragment, alternate hosts, and non-HTTPS schemes are rejected.
The private receipt may retain branch, canonical queue query, provider item IDs,
and item URLs. Branch and query text and their plain hashes never enter the
public projection.

Before campaign admission, the external verifier generates an independent
random 256-bit publication key and keeps it outside the Worker and repository.
Low-entropy commitments use HMAC-SHA-256 over length-framed values with domain
`supervised-worker-public-v1`, immutable repository ID, identifier type, and raw
identifier. `queue.definitionCommitment` is the keyed commitment of the
canonical query. Private item IDs and receipt IDs use separate identifier-type
domains. The key and its raw or hashed value are never published.

The public projection allowlist is exactly:

```text
schemaVersion, projectionVersion, projectionPolicyId, sourceReceiptHash
publicCampaignId, generatedAt, startedAt, endedAt, campaignDisposition
plugin.version, plugin.sourceHash
repository.provider, repository.visibility
repository.canonicalUrl (public repositories only)
repository.publicAlias (private repositories only)
queue.definitionCommitment
metrics.campaignAttributedPreExistingClosures
metrics.campaignAttributedNewIssuesOpened, metrics.ambientProviderMutations
metrics.unresolvedProviderMutations
metrics.repositoryNetOpenChange, metrics.repositoryNetOpenReduction
metrics.netQueueOpenChange
verification.evidenceReceiptCompleteness
verification.outcomeReceiptCompleteness
sessions.started, sessions.resumed, reviews.rounds, reviews.findingsCaught
incidents.prematureCompletions, incidents.duplicateClosures
incidents.wrongCommitPushes, incidents.unbudgetedIssueCreations
incidents.unverifiableReleaseClaims, incidents.manualStateInterventions
items[].publicItemId, items[].localDisposition
items[].providerDisposition
consentReceiptId (private repositories only), provenance, seal
```

Public provider item IDs may be used only when authenticated metadata confirms a
public repository. Private IDs become domain-separated HMAC values and all item
URLs are omitted. `publicCampaignId` is an independent random identifier issued
by the external verifier; it is never the private `campaignId` or its plain
hash. `sourceReceiptHash` is the final campaign outcome-receipt hash; that
outcome in turn binds the evidence-receipt hash. `repository.publicAlias` is the
domain-separated HMAC of the immutable repository ID.

Private-repository publication requires a maintainer-consent receipt bound to
the exact `sourceReceiptHash`, projection policy, repository ID, audience,
expiry, and the canonical projection-payload hash computed with
`consentReceiptId` and `seal` omitted. The resulting consent receipt ID is then
inserted, and the accepted external verifier seals the complete projection.
The verifier checks consent and derivation from the private receipt before
signing. The projection contains no raw issue bodies, prompts, tool payloads,
source, credentials, remote strings, actor identities, operation identities,
branch data, query data, or unconsented private metadata. Export fails when
visibility, consent, derivation, or external sealing is unavailable.

## Launch Assets

The provider-verified public announcement is blocked until these assets exist:

1. A 60-90 second demo showing queue admission, one implementation, a
    role-separated review rejection, repair, receipt verification, and resume in
    a fresh session.
2. One campaign receipt image whose numbers can be understood without reading
    the architecture.
3. A one-command install or update path and a five-minute first governed run.
4. A tagged prerelease with immutable installation instructions.
5. Three external install attempts completed without author intervention.
6. One external campaign receipt and maintainer quotation.
7. A green public Windows/macOS/Linux CI matrix on the exact release commit.

The participatory launch format is the **Backlog Proof Challenge**: select ten
labelled GitHub issues, run the Worker, and publish the resulting campaign
receipt whether the campaign completes, blocks, or discovers additional work.

## What Not To Build Before Launch

- a dashboard or worktree fleet;
- a background scheduling daemon;
- a general-purpose coding runtime;
- multi-provider LLM routing;
- automatic policy or agent rewriting;
- semantic memory or a vector store; or
- additional tracker integrations before GitHub reconciliation is proven.

These can increase surface area without improving the launch claim. A compact,
independently verifiable result is the priority.
