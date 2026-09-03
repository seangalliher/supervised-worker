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

Windows lifecycle state is limited to local drive-letter storage. UNC,
network-mapped, and `subst` roots are denied before synchronous path inspection;
locality checks share a 1.5-second deadline and three-drive limit. The alpha does
not govern repositories on remote filesystems.

The explicit `release` command also requires the repository's canonical local
path. Junction, symbolic-link, `subst`, mapped, and UNC roots are rejected before
ownership state is removed.

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
- Register the content-addressed path returned by `npm run install:local` in VS
  Code. Checkout manifests fail closed without trusted `PLUGIN_ROOT`; they never
  execute helper code discovered from a task workspace cwd. Installed launchers
  clear `NODE_OPTIONS` and GitHub credential variables before Node starts.
- Verify in the host environment view that the raw or Copilot CLI-qualified
  `supervised-worker:seangalliher-supervised-*` roles come from this plugin before
  relying on their tool boundaries. Qualified selectors reduce ambiguity but do
  not create a security namespace.
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

Handoff Git checks resolve an absolute executable from absolute `PATH` entries
outside the target workspace, invoke it from its own directory, and pass the
repository with `git -C`. A repository-local `git.exe` or relative `PATH` entry
is never used; external diff, text conversion, and filesystem monitoring are
disabled for the read-only index checks.

An attachment or lifecycle ledger is likewise not proof that the host invoked a
hook: a same-user process can call the helper directly and produce equivalent
records. Host-backed evaluations must correlate those records with successful
host hook logs for the same session.

The VS Code session-root locator is routing metadata, not authority or host
attestation. It is accepted only with the matching repository attachment, stores
no transcript content, and carries the same random generation as the attachment.
Normal Stop release retains it as a released tombstone after removing the
attachment. An explicit manual release can leave an active locator without an
attachment; that mismatch fails visibly and cannot select repository state.
Start a new Copilot session after manual release; an existing session is not
rebound to a different repository.

Workspace session locks are not automatically expired or replaced. This favors
exclusive ownership over unattended stale-lock recovery; operator-confirmed
cleanup is required after an interrupted lock holder. Release paths report
cleanup failure explicitly if route or attachment state cannot be updated.

## Reporting A Vulnerability

Open a private GitHub security advisory in this repository. Do not publish
credential material, private source, or a working exploit in a public issue.

Include the affected version, host surface, reproduction, impact, and the safest
available mitigation. You should receive an acknowledgement within seven days.