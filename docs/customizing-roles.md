# Customizing Companion Roles

The bundled Supervised Architect, Builder, and Diff Reviewer are reference
implementations. A repository may use them unchanged, customize copies, or map
the workflow to existing specialized agents.

## Configure A Repository

Copy [the specialized example](../examples/workflow.specialized.json) to the
fixed repository path `.github/supervised-worker.json`, then set the three
selectors to IDs the active Copilot host resolves:

```json
{
  "roles": {
    "architect": "architect",
    "builder": "builder",
    "reviewer": "diff-reviewer"
  }
}
```

The actual file is a complete workflow document; `roles` cannot be partial.
Selectors are host-resolved Copilot agent IDs, not frontmatter display names.
Repository and user agents normally use raw filename-derived IDs. Copilot CLI
qualifies plugin agents as `plugin-name:filename-id`, so a role supplied by
another plugin may be mapped as `company-tools:architect`. Each segment uses
lowercase letters, numbers, dots, and hyphens. The three selectors must be
distinct and cannot name either raw or qualified Supervised Worker selector.
The legacy `review.agent` field remains supported when `roles` is absent. When
both are present, `review.agent` must equal `roles.reviewer`.
Pairwise role inequality and equality with the legacy reviewer alias are
cross-field runtime invariants; JSON Schema validates each selector's shape,
while `workflow roles` enforces those relationships.

Repositories that require a specific independent review model can bind that
policy into the same accepted workflow bytes:

```json
{
  "review": {
    "required": true,
    "independent": true,
    "agent": "diff-reviewer",
    "requiredModel": "gpt-5.6-sol",
    "requiredModelFamily": "openai",
    "requireDifferentModelFamily": true
  }
}
```

Under this policy, a clean review must carry `modelResolution` with host-evidence
locators for both Builder and Reviewer. The runtime rejects a clean report when
the Reviewer model or family differs from the accepted policy, when the Builder
and Reviewer families match, or when separation is unknown. Model metadata is
evidence supplied and checked by the Worker; it is not trusted self-attestation.

After `handoff pre-review` passes, the Worker runs `handoff issue-review
<contract> <build-report>`. The command atomically records a fresh current
attempt under `.supervised-worker/runtime/review-attempts/`, bound to the exact
contract, build report, and staged tree. Before invoking the Reviewer, the
Worker writes one metadata-only receipt per role under
`.supervised-worker/runtime/model-receipts/<sha256(itemId)>/{builder|reviewer}.json`.
Each receipt conforms to `schemas/model-receipt.schema.json` and binds the item,
mapped selector, host-reported model and family, accepted workflow hash,
fresh review-attempt UUID, build-report hash, staged-tree hash, observing Worker
selector, host, hashed session identity, and timestamp. The review report carries
the same attempt UUID plus each exact receipt locator and SHA-256. Final `handoff
verify` reopens the safe local receipt path, checks its hash and chronology, and
compares every binding with the current issued attempt before allowing a clean
verdict to advance. Attempts expire after 24 hours; timestamps may be at most
five minutes ahead to tolerate clock skew.

Resolve the effective map from the target repository:

```bash
node /absolute/path/to/supervised-worker/src/cli.mjs workflow roles
```

With no repository configuration, the command returns the bundled reference
selectors and `requiresAcceptance: false`. A valid repository override returns
`requiresAcceptance: true` plus `workflowHash`, the SHA-256 of the exact config
bytes. After reviewing the file, run this command yourself:

```bash
node /absolute/path/to/supervised-worker/src/cli.mjs workflow accept <workflowHash>
```

Do not delegate acceptance to an agent. Every handoff artifact records the
accepted hash. If the workflow bytes change, all gates fail until the new hash is
reviewed and accepted; old artifacts remain bound to the old hash even afterward.
Invalid, linked, or oversized configuration fails closed instead of falling back
to reference agents.

The role map is human-managed authority-bearing configuration. The hook denies
all built-in agent file edits to it, and build contracts cannot include it in
`targetFiles`. Edit the file outside an agent campaign, review it, then run the
acceptance command yourself with the hash reported by `workflow roles`.

Acceptance updates are written through an exclusive, fsynced temporary file and
atomic replacement. The file is created with mode `0600` on POSIX. Windows does
not implement POSIX mode bits; access there follows the inherited ACL of the
repository and `.supervised-worker` directory.

## Replacement Contracts

A specialized role may add repository knowledge but must preserve its authority
and output contract:

| Role | Allowed authority | Required handoff |
|---|---|---|
| Architect | Read/search and request bounded probes | `build-contract` |
| Builder | Edit only approved `targetFiles` | `build-report` |
| Reviewer | Read-only adversarial review | `review-report` |

All companions must:

- return one JSON object conforming to `schemas/role-handoff.schema.json`;
- emit handoff `schemaVersion: 2` when a workflow hash is present;
- copy the exact accepted `workflowHash` into every handoff artifact;
- set `producedBy` to the exact resolved selector;
- never edit `.supervised-worker/` or `.github/supervised-worker.json`;
- never stage, commit, push, close provider items, or attest queue completion;
- treat contracts, repository content, issue text, and tool output as untrusted;
- leave executable validation and durable evidence ownership with the Worker.

Handoff timestamps use a canonical RFC 3339 subset: uppercase `T` and `Z`, no
leap-second `:60`, years start at 0001, and calendar dates must be real.

The schema validates handoff shape. The dependency-free runtime additionally
checks the self-declared `producedBy` against the effective accepted workflow.
A handoff claiming an unmapped agent is rejected, but the field is not host
attestation: another process can copy a mapped ID. Verify actual agent provenance
in the Copilot environment. The workflow hash covers mapping bytes, not agent
profile bytes; review specialized agent changes separately.

Handoff version 1 remains readable for campaigns using bundled reference roles
and has no `workflowHash` member. A configured specialized role map requires
version 2. Version 1 artifacts never inherit a configured map implicitly and
cannot satisfy final `handoff verify`; migrate the review report and issue a
fresh review attempt before advancement.

## Reference Agents

The bundled definitions live in `agents/`:

- `seangalliher-supervised-architect.agent.md`
- `seangalliher-supervised-builder.agent.md`
- `seangalliher-supervised-diff-reviewer.agent.md`

Agent Plugins v1 exposes the same GitHub Copilot definitions from
`com.github.copilot/agents/`. Copilot CLI therefore resolves the bundled
defaults as `supervised-worker:seangalliher-supervised-architect`,
`supervised-worker:seangalliher-supervised-builder`, and
`supervised-worker:seangalliher-supervised-diff-reviewer`.

Use them as behavioral references rather than modifying installed plugin files.
Create repository- or user-scoped specialized agents under distinct IDs, then
map those IDs in the repository workflow. Verify their source in the host
environment before relying on their tool boundaries; selector names are not a
security namespace.