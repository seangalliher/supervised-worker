const ALLOWED_EVENTS = new Set([
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "Stop",
]);

for (const name of ["NODE_OPTIONS", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
  delete process.env[name];
}

const eventName = process.argv.length === 3 ? process.argv[2] : undefined;
if (!ALLOWED_EVENTS.has(eventName)) {
  process.stderr.write("Supervised Worker received an unsupported hook event.\n");
  process.exitCode = 1;
} else {
  process.argv = [process.execPath, "cli.mjs", "hook", eventName];
  await import("./cli.mjs");
}
