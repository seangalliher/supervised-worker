import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PLAN_WRITER_TOOLS } from "../src/core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hooks = JSON.parse(
  readFileSync(path.join(root, "hooks.json"), "utf8"),
).hooks;

test("packaged PreTool matcher covers the runtime writer vocabulary", () => {
  const matcher = new Set(
    hooks.PreToolUse[0].matcher.split("|").map((name) => name.toLowerCase()),
  );
  assert.deepEqual(matcher, new Set([...PLAN_WRITER_TOOLS]));
});

function workspace() {
  return mkdtempSync(path.join(os.tmpdir(), "supervised-worker-hook-"));
}

function payload(cwd, eventName, active = false) {
  return {
    hook_event_name: eventName,
    session_id: "22222222-2222-4222-8222-222222222222",
    timestamp: new Date().toISOString(),
    cwd,
    stop_hook_active: active,
  };
}

function writeActivePlan(cwd) {
  const filePath = path.join(cwd, ".supervised-worker", "plan.json");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify({
      schemaVersion: 1,
      mode: "active",
      goal: "Exercise the packaged hook.",
      items: [{ id: "one", title: "One", status: "in_progress" }],
      completion: null,
    })}\n`,
  );
  return filePath;
}

function invokePowerShell(eventName, input, cwd) {
  const command = hooks[eventName][0].powershell;
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      cwd,
      env: { ...process.env, PLUGIN_ROOT: root },
      input: JSON.stringify(input),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim() || "{}");
}

function bashExecutable() {
  const candidates = [
    process.env.GIT_BASH,
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    "bash",
  ].filter(Boolean);
  return candidates.find((candidate) => {
    if (path.isAbsolute(candidate)) return existsSync(candidate);
    return spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0;
  });
}

function invokeBash(eventName, input, cwd) {
  const executable = bashExecutable();
  assert.ok(executable, "Git Bash or bash is required for this test");
  const result = spawnSync(executable, ["-lc", hooks[eventName][0].bash], {
    cwd,
    env: { ...process.env, PLUGIN_ROOT: root.replaceAll("\\", "/") },
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim() || "{}");
}

function attach(invoke, cwd, planFile) {
  invoke(
    "PostToolUse",
    {
      ...payload(cwd, "PostToolUse"),
      tool_name: "create_file",
      tool_input: { filePath: planFile },
    },
    cwd,
  );
}

function claim(invoke, cwd, planFile, session = payload(cwd, "PreToolUse")) {
  return invoke(
    "PreToolUse",
    {
      ...session,
      tool_name: "Write",
      tool_input: { file_path: planFile },
    },
    cwd,
  );
}

function exerciseStopLifecycle(invoke) {
  const cwd = workspace();
  try {
    const planFile = writeActivePlan(cwd);
    attach(invoke, cwd, planFile);
    const first = invoke("Stop", payload(cwd, "Stop"), cwd);
    const second = invoke("Stop", payload(cwd, "Stop", true), cwd);
    const third = invoke("Stop", payload(cwd, "Stop", true), cwd);
    assert.equal(first.decision, "block");
    assert.equal(first.hookSpecificOutput.decision, "block");
    assert.equal(second.decision, "block");
    assert.equal(second.hookSpecificOutput.decision, "block");
    assert.match(second.reason, /final bounded continuation/);
    assert.equal(third.decision, "allow");
    assert.equal(third.hookSpecificOutput.decision, "allow");
    assert.match(third.systemMessage, /bounded retry limit/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    assert.equal(existsSync(cwd), false);
  }
}

test("packaged PowerShell SessionStart is inert without a plan", {
  skip: process.platform !== "win32",
}, () => {
  const cwd = workspace();
  try {
    assert.deepEqual(invokePowerShell("SessionStart", payload(cwd, "SessionStart"), cwd), {});
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("packaged PowerShell hook runs the attached Stop lifecycle", {
  skip: process.platform !== "win32",
}, () => {
  exerciseStopLifecycle(invokePowerShell);
});

test("packaged Bash SessionStart is inert without a plan", {
  skip: !bashExecutable(),
}, () => {
  const cwd = workspace();
  try {
    assert.deepEqual(invokeBash("SessionStart", payload(cwd, "SessionStart"), cwd), {});
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("packaged Bash hook runs the attached Stop lifecycle", {
  skip: !bashExecutable(),
}, () => {
  exerciseStopLifecycle(invokeBash);
});

test("packaged PowerShell PreToolUse denies a second plan writer", {
  skip: process.platform !== "win32",
}, () => {
  const cwd = workspace();
  try {
    const planFile = writeActivePlan(cwd);
    claim(invokePowerShell, cwd, planFile, {
      ...payload(cwd, "PreToolUse"),
      session_id: "owner-session",
    });
    const denied = claim(invokePowerShell, cwd, planFile, {
      ...payload(cwd, "PreToolUse"),
      session_id: "other-session",
    });
    assert.equal(denied.permissionDecision, "deny");
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});