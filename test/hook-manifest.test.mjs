import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PLAN_WRITER_MATCHER } from "../src/core.mjs";
import {
  EXPECTED_HOOK_EVENTS,
  validateHookManifest,
} from "../src/hook-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hooks = JSON.parse(readFileSync(path.join(root, "hooks.json"), "utf8"));

function cloneHooks() {
  return structuredClone(hooks);
}

test("published hook manifest passes the runtime-independent validator", () => {
  assert.deepEqual(validateHookManifest(hooks, PLAN_WRITER_MATCHER), []);
});

for (const eventName of EXPECTED_HOOK_EVENTS) {
  test(`hook manifest rejects an empty ${eventName} command list`, () => {
    const mutant = cloneHooks();
    mutant.hooks[eventName] = [];
    assert.match(
      validateHookManifest(mutant, PLAN_WRITER_MATCHER).join("\n"),
      new RegExp(`${eventName} must contain exactly one hook command`),
    );
  });
}

test("hook manifest rejects timeout drift on every event", () => {
  for (const eventName of EXPECTED_HOOK_EVENTS) {
    const mutant = cloneHooks();
    mutant.hooks[eventName][0].timeoutSec = 6;
    assert.match(
      validateHookManifest(mutant, PLAN_WRITER_MATCHER).join("\n"),
      new RegExp(`${eventName} timeoutSec must be exactly 5 seconds`),
    );
  }
});

test("hook manifest rejects invalid command types on every event", () => {
  for (const eventName of EXPECTED_HOOK_EVENTS) {
    const mutant = cloneHooks();
    mutant.hooks[eventName][0].type = "not-command";
    assert.match(
      validateHookManifest(mutant, PLAN_WRITER_MATCHER).join("\n"),
      new RegExp(`${eventName} hook type must be command`),
    );
  }
});

test("hook manifest rejects wrong event launchers on every event", () => {
  for (const eventName of EXPECTED_HOOK_EVENTS) {
    const mutant = cloneHooks();
    mutant.hooks[eventName][0].bash =
      `${mutant.hooks[eventName][0].bash.slice(0, -eventName.length)}WrongEvent`;
    mutant.hooks[eventName][0].powershell =
      `${mutant.hooks[eventName][0].powershell.slice(0, -eventName.length)}WrongEvent`;
    assert.match(
      validateHookManifest(mutant, PLAN_WRITER_MATCHER).join("\n"),
      new RegExp(`${eventName} (?:bash|PowerShell) command differs`),
    );
  }
});

test("hook manifest rejects no-op launchers containing expected substrings", () => {
  for (const eventName of EXPECTED_HOOK_EVENTS) {
    const mutant = cloneHooks();
    mutant.hooks[eventName][0].bash =
      `printf '%s' '\${PLUGIN_ROOT:-$PWD} src/cli.mjs hook ${eventName} unset COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN'`;
    mutant.hooks[eventName][0].powershell =
      `Write-Output '$pluginRoot=(Get-Location).Path src/cli.mjs hook ${eventName} COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN'`;
    assert.match(
      validateHookManifest(mutant, PLAN_WRITER_MATCHER).join("\n"),
      new RegExp(`${eventName} (?:bash|PowerShell) command differs`),
    );
  }
});

test("hook manifest rejects host-precedence and unknown fields", () => {
  for (const topLevelKey of ["disableAllHooks", "commands", "cwd"]) {
    const mutant = cloneHooks();
    mutant[topLevelKey] = true;
    assert.match(
      validateHookManifest(mutant, PLAN_WRITER_MATCHER).join("\n"),
      new RegExp(`unknown property: ${topLevelKey}`),
    );
  }
  for (const entryKey of ["windows", "linux", "osx", "timeout", "cwd", "env", "hooks"]) {
    const mutant = cloneHooks();
    mutant.hooks.Stop[0][entryKey] = "override";
    assert.match(
      validateHookManifest(mutant, PLAN_WRITER_MATCHER).join("\n"),
      new RegExp(`Stop hook command contains unknown property: ${entryKey}`),
    );
  }
});

test("CLI validation rejects a host-precedence launcher override", () => {
  const target = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-cli-manifest-"));
  const entries = [
    ".github",
    ".gitignore",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "NOTICE",
    "README.md",
    "agents",
    "com.github.copilot",
    "docs",
    "examples",
    "hooks.json",
    "package-lock.json",
    "package.json",
    "plugin.json",
    "policy",
    "schemas",
    "skills",
    "src",
  ];
  try {
    for (const entry of entries) {
      cpSync(path.join(root, entry), path.join(target, entry), { recursive: true });
    }
    symlinkSync(
      path.join(root, "node_modules"),
      path.join(target, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const relativePath of [
      "hooks.json",
      path.join("com.github.copilot", "hooks", "hooks.json"),
    ]) {
      const filePath = path.join(target, relativePath);
      const mutant = JSON.parse(readFileSync(filePath, "utf8"));
      mutant.hooks.Stop[0].windows = "echo bypass";
      writeFileSync(filePath, `${JSON.stringify(mutant, null, 2)}\n`);
    }
    const result = spawnSync(process.execPath, [path.join(target, "src", "cli.mjs"), "validate"], {
      cwd: target,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.match(report.errors.join("\n"), /unknown property: windows/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
