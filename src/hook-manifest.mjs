import { ALL_TOOL_MATCHER } from "./core.mjs";

export const EXPECTED_HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "Stop",
];
const TOP_LEVEL_KEYS = new Set(["version", "hooks"]);
const COMMON_ENTRY_KEYS = new Set(["type", "bash", "powershell", "timeoutSec"]);
const PRE_TOOL_ENTRY_KEYS = new Set([...COMMON_ENTRY_KEYS, "matcher"]);

function expectedBashCommand(eventName) {
  return `plugin_root="\${PLUGIN_ROOT:-}"; if [ -z "$plugin_root" ]; then printf '%s\\n' 'Supervised Worker requires PLUGIN_ROOT; run node src/cli.mjs install for VS Code.' >&2; exit 1; fi; unset NODE_OPTIONS COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN; node "$plugin_root/src/hook-launcher.mjs" ${eventName}`;
}

function expectedPowerShellCommand(eventName) {
  return `$pluginRoot=$env:PLUGIN_ROOT; if ([string]::IsNullOrWhiteSpace($pluginRoot)) { Write-Error 'Supervised Worker requires PLUGIN_ROOT; run node src/cli.mjs install for VS Code.'; exit 1 }; $env:NODE_OPTIONS=$null; $env:COPILOT_GITHUB_TOKEN=$null; $env:GH_TOKEN=$null; $env:GITHUB_TOKEN=$null; node (Join-Path $pluginRoot 'src/hook-launcher.mjs') ${eventName}`;
}

export function validateHookManifest(hooks) {
  const errors = [];
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return ["hooks.json must contain an object"];
  }
  for (const key of Object.keys(hooks)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`hooks.json contains unknown property: ${key}`);
  }
  if (hooks.version !== 1) errors.push("hooks.json version must be 1");
  if (JSON.stringify(Object.keys(hooks.hooks ?? {})) !== JSON.stringify(EXPECTED_HOOK_EVENTS)) {
    errors.push("hooks.json event set or ordering is invalid");
  }
  for (const event of EXPECTED_HOOK_EVENTS) {
    const entries = hooks.hooks?.[event];
    if (!Array.isArray(entries) || entries.length !== 1) {
      errors.push(`${event} must contain exactly one hook command`);
      continue;
    }
    const [entry] = entries;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${event} hook command must be an object`);
      continue;
    }
    const allowedKeys = event === "PreToolUse" ? PRE_TOOL_ENTRY_KEYS : COMMON_ENTRY_KEYS;
    for (const key of Object.keys(entry)) {
      if (!allowedKeys.has(key)) {
        errors.push(`${event} hook command contains unknown property: ${key}`);
      }
    }
    if (entry.type !== "command") {
      errors.push(`${event} hook type must be command`);
    }
    if (entry.bash !== expectedBashCommand(event)) {
      errors.push(`${event} bash command differs from the required launcher`);
    }
    if (entry.powershell !== expectedPowerShellCommand(event)) {
      errors.push(`${event} PowerShell command differs from the required launcher`);
    }
    if (entry.timeoutSec !== 5) {
      errors.push(`${event} timeoutSec must be exactly 5 seconds`);
    }
    if (event === "PreToolUse") {
      if (entry.matcher !== ALL_TOOL_MATCHER) {
        errors.push("PreToolUse matcher must observe all tools");
      }
    } else if (Object.hasOwn(entry, "matcher")) {
      errors.push(`${event} must not define a matcher`);
    }
  }
  return errors;
}
