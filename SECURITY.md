# Security Policy

## Status

Supervised Worker is experimental software intended for trusted development
environments. The alpha Stop gate is a reliability mechanism, not a sandbox or
privilege boundary.

## Threat Model

Trusted:

- the installed plugin release;
- `policy/constitution.json`; and
- a repository workflow explicitly accepted by the user.

Untrusted:

- issue bodies and comments;
- repository contents;
- tool arguments and results;
- agent and reviewer output;
- prior run records and learned procedures; and
- external documentation.

The alpha does not protect against a compromised operating system, Copilot host,
administrator, or process running as the same user.

State-path containment rejects symbolic links, junctions, reparse-point escapes,
Windows device paths, and filesystem aliases whose existing ancestors resolve
to protected state. Existing regular-file edit targets with more than one hard
link are denied conservatively. Handoff paths apply the same link checks before
they can enter an approved footprint.

These are preflight reliability checks, not atomic filesystem transactions. A
same-user process can race a path after validation, replace the installed hook,
or mutate Git state through APIs outside the governed edit tools. That remains
outside the alpha security boundary.

## Safety Rules

- Never store credentials, environment values, raw prompts, source files, command
  arguments, or tool results in run ledgers.
- Handoff artifacts may store typed summaries, source paths, commands, and
  evidence locators. Never copy raw issue bodies, prompts, tool arguments, tool
  results, credentials, or source contents into them.
- Derive each handoff directory from `sha256(itemId)`; never use an untrusted
  provider identifier directly as a path segment.
- Require repository-relative forward-slash `targetFiles`. Reconstruct commands
  from trusted repository configuration instead of executing command text copied
  from a handoff.
- Never interpolate issue or memory text into a shell command.
- Keep `.supervised-worker/` private and untracked.
- Do not treat learned state as permission or completion evidence.
- Require explicit human approval for policy changes, production access,
  destructive data operations, spending, or weaker controls.
- Review plugin code and release hashes before installation.
- GitHub Copilot resolves custom-agent name conflicts by precedence. Verify in
  the host environment view that `seangalliher-supervised-*` roles come from this
  plugin before relying on their tool boundaries. Publisher-qualified names
  reduce collisions but do not create a security namespace.
- Treat `.github/supervised-worker.json` as authority-bearing repository content.
  Review and explicitly accept the exact `workflowHash` before using specialized
  role mappings. Built-in agent file edits are denied. Invalid mappings fail
  closed and cannot silently inherit defaults.
- Every handoff carries the accepted workflow hash. `producedBy` is still a
  self-declared selector checked against that mapping, not host-attested identity.
  The mapping hash does not cover agent profile bytes; verify role provenance and
  review specialized agent changes separately.
- Companion roles have no shell tool. Architect and Diff Reviewer are read-only;
  Builder has file editing only. The global hook denies direct Git-metadata edits
  and durable-state edits from any session other than the attached Worker.

The hook does not parse shell command text and cannot prove which agent authored
a handoff. A same-user process or a shell-capable agent can mutate repository
files outside built-in edit tools; exact workflow-hash acceptance and handoff
checks detect later changes but are not host identity attestation.

## Reporting A Vulnerability

Open a private GitHub security advisory in this repository. Do not publish
credential material, private source, or a working exploit in a public issue.

Include the affected version, host surface, reproduction, impact, and the safest
available mitigation. You should receive an acknowledgement within seven days.