# Host Assurance Profiles

The Copilot-local profile is the immediate product. The strong ProbOS-hosted
profile is a separately planned integration, not a claim made by the local plugin.
This split was explicitly approved on 2026-09-08. It changes the scope of the
local assurance promise, not the evidence needed for independent review, exact
source gates, queue reconciliation, or safe recovery.

## Copilot In VS Code

Set `authority.assurance` to `local-scoped` in the complete repository workflow
and explicitly accept its exact byte hash before admission. The
[VS Code example](../examples/workflow.vscode-local.json) is a template; replace
its repository scope and test commands. `workflow roles` reports the requested
assurance and acceptance status. `status` reports configuration, not proof that
the host loaded the plugin or that external provider facts were verified.

Local admission validates:

- a verified immutable plugin installation and its source bytes;
- the current schema-valid, explicitly accepted workflow hash;
- the supplied VS Code session ID and its matching canonical, single-link
  transcript locator outside the campaign repository;
- the existing campaign attachment, session route, and generation-bound
  transition through the sole lifecycle owner.

The transcript's content is not read for admission. Appending normal host events
does not invalidate the grant. Changed workflow/acceptance, session location,
workspace identity, or immutable source invalidates it. Lifecycle requests from
other sessions cannot replace an active campaign attachment. Unadmitted chats
remain inert except for the existing protection of workflow and lifecycle files.

Local hooks share one monotonic lock-acquisition wait budget across session,
repository and journal scopes: five seconds on Windows and one second elsewhere.
This accommodates short peer-hook overlap; it does not reclaim a live owner,
reset the budget at each lock, replay an invocation, or bound total hook execution.
Exhausted or unverifiable ownership still denies the operation. Other lifecycle
callers retain their existing acquisition budget.

The local grant is a cooperative binding, not independent verification of the
caller's selected role or host process. Another program using the same OS account
can supply the same files and IDs; this is not an OS sandbox. A matching locator
does not attest all host agents, hooks, policies, or model internals. Never create
a pretend host inventory to fill that gap. Initial setup must separately verify
the selected installed agent and actual hooks in VS Code, including an allowed
and denied benign action. Configure legacy/shadow copies out of that workspace
before starting; do not claim the runtime enumerates them exhaustively.

Use the real session locator for each `lifecycle plan`, `checkpoint`, `resume`,
rescue, or receipt-compilation request. Companions do not own campaign state and
must not call those commands. Only the owning Worker receives the corresponding
tool authority under the accepted role configuration.

## Recovery And Continuation

The existing Doctor helper can diagnose and recover an exact dead repository or
session lock under local authority. The action/capability/expected-snapshot checks,
retained recovery fence, and replay receipts remain enforced. A live, changed,
malformed, unrelated, or unconfirmed owner remains unrecoverable. Revalidation of
the campaign and a subsequent governed result establish forward progress; a
successful recovery receipt alone does not prove resumed execution.

Source repair remains isolated and independently reviewed. The Copilot-local
plugin does not claim to atomically activate a new plugin or restart VS Code.
Installation changes use an explicit checkpoint-and-restart handoff with verified
old/new source and a rollback target. While automatic native activation is
unavailable, record that boundary honestly; do not loop on the missing adapter or
edit an active immutable install. Prepared repairs and unresolved Doctor incidents
remain visible in the canonical evidence and are not recorded as resolved.

The intended normal workflow is one accepted queue campaign that continues
between banked items and self-recovers supported internal faults. A plugin cannot
override Copilot's quotas, approvals, continuation/compaction limits, cancellation,
network access, or editor shutdown. A host-forced interruption is not a successful
uninterrupted canary: preserve a checkpoint and distinguish it from completion.
Do not introduce a daemon or disable host safeguards to change that result.

## Strict Host Profile

An omitted assurance retains `host-attested`; existing workflow bytes do not opt
into the local profile. That path still requires the trusted external host inventory
and exact source/session bindings. The strict verifier is not a means for an agent
to certify its own environment. Missing evidence does not fall back to local mode.

The planned [ProbOS host program](https://github.com/seangalliher/ProbOS/issues/1379)
will supply stronger guarantees at the actual execution boundary. The retained
cross-repository obligations are tracked in
[Supervised Worker #11](https://github.com/seangalliher/supervised-worker/issues/11):

| Slice | Owner | Deliverable |
| --- | --- | --- |
| AD-1315 | [ProbOS #1381](https://github.com/seangalliher/ProbOS/issues/1381) | Protected authority, complete enforcement manifest, durable admission witness. |
| AD-1316 | [ProbOS #1383](https://github.com/seangalliher/ProbOS/issues/1383) | Brokered effects, durable operation IDs, outcome reconciliation and bypass tests. |
| AD-1317 | [ProbOS #1380](https://github.com/seangalliher/ProbOS/issues/1380) | Narrow host adapter, immutable promotion/rollback, fresh-session recovery and strong canary. |
| AD-1318 | [ProbOS #1382](https://github.com/seangalliher/ProbOS/issues/1382) | Optional VS Code session surface or equivalently governed Copilot-assisted integration. |

ProbOS runtime code belongs in its OSS repository. This plugin keeps its portable
campaign kernel, protocol and compatibility tests; do not copy it into ProbOS or
add a second campaign owner. ProbOS must own or equivalently govern actual effects,
not merely spawn an opaque Copilot process. Protect the issuer/witness and immutable
host from the Worker/Doctor. Preserve independent provider and external-launch
verification rather than treating local host facts as provider seals.

## Evidence And Release

Local and strict admission are separate from receipt trust. The canonical receipt
continues to grant no permissions or Stop authority; provider/model observations
remain recorded/unavailable as specified. A verified local plan or accepted workflow
does not prove host-wide attestation, a completed GitHub queue, or uninterrupted
operation. Report the selected assurance alongside actual canary results.

The immediate #10/#6/#5 criteria are explicitly revised for the Copilot-local
profile. Their original stronger requirements are retained in #11 and AD-1314
through AD-1318, not marked satisfied by the narrower release. Local completion
still requires exact-source tests and review plus a real bounded VS Code campaign.