# Contributing

Contributions are welcome while the project is in alpha.

## Development

Requirements: Node.js 20 or newer and Git.

```bash
npm ci
npm test
npm run validate
```

The hook runtime has no npm dependencies. Development-only validators use Ajv
and YAML to enforce the published schemas and Agent Skills frontmatter. Keep the
helper deterministic and the plugin small.

## Design Rules

- GitHub Copilot remains the coding runtime.
- Deterministic enforcement belongs in the helper or hook, not only in prose.
- Hooks must support Windows, macOS, and Linux.
- Hook output is one valid JSON object on stdout; diagnostics go to stderr.
- Raw prompts, tool arguments, and tool results are not stored by default.
- Learned procedures are advisory and cannot modify constitutional policy.
- New public behavior requires focused tests and a cross-platform lifecycle test.
- A claim that something is absent requires an enumerating check.

## Pull Requests

Keep pull requests bounded. Explain the failure mode, the smallest chosen design,
the test that fails without the change, and any remaining risk. Security and
compatibility findings block merge until repaired or explicitly rejected with
evidence.

Contributions are accepted under Apache License 2.0.