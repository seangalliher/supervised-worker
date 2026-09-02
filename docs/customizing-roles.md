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
Selectors are filename-derived Copilot agent IDs, not frontmatter display names.
They use lowercase letters, numbers, dots, and hyphens, must be distinct, and
cannot name either Supervised Worker selector.
The legacy `review.agent` field remains supported when `roles` is absent. When
both are present, `review.agent` must equal `roles.reviewer`.
Pairwise role inequality and equality with the legacy reviewer alias are
cross-field runtime invariants; JSON Schema validates each selector's shape,
while `workflow roles` enforces those relationships.

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
version 2. Version 1 artifacts never inherit a configured map implicitly.

## Reference Agents

The bundled definitions live in `agents/`:

- `seangalliher-supervised-architect.agent.md`
- `seangalliher-supervised-builder.agent.md`
- `seangalliher-supervised-diff-reviewer.agent.md`

Use them as behavioral references rather than modifying installed plugin files.
Create repository- or user-scoped specialized agents under distinct IDs, then
map those IDs in the repository workflow. Verify their source in the host
environment before relying on their tool boundaries; selector names are not a
security namespace.