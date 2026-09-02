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

State-path containment rejects symbolic links, junctions, and reparse-point
escapes. It cannot distinguish a same-volume hard link from an ordinary file;
creating such a link already requires the same local file authority that this
alpha explicitly places outside its security boundary.

## Safety Rules

- Never store credentials, environment values, raw prompts, source files, command
  arguments, or tool results in run ledgers.
- Never interpolate issue or memory text into a shell command.
- Keep `.supervised-worker/` private and untracked.
- Do not treat learned state as permission or completion evidence.
- Require explicit human approval for policy changes, production access,
  destructive data operations, spending, or weaker controls.
- Review plugin code and release hashes before installation.

## Reporting A Vulnerability

Open a private GitHub security advisory in this repository. Do not publish
credential material, private source, or a working exploit in a public issue.

Include the affected version, host surface, reproduction, impact, and the safest
available mitigation. You should receive an acknowledgement within seven days.