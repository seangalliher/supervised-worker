import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PLAN_WRITER_MATCHER, PLAN_WRITER_TOOLS, sha256 } from "../src/core.mjs";
import { spawnProcessTreeSync } from "./process-tree.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootHooksBytes = readFileSync(path.join(root, "hooks.json"));
const copilotHooksBytes = readFileSync(
  path.join(root, "com.github.copilot", "hooks", "hooks.json"),
);
assert.deepEqual(copilotHooksBytes, rootHooksBytes);
const hooks = JSON.parse(copilotHooksBytes.toString("utf8")).hooks;
const EXPECTED_HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "Stop",
];

test("packaged PreTool matcher covers the runtime writer vocabulary", () => {
  const expected = [
    "Write",
    "Edit",
    "create",
    "edit",
    "apply_patch",
    "create_file",
    "str_replace_editor",
    "insert",
    "insert_edit_into_file",
    "replace_string_in_file",
    "multi_replace_string_in_file",
  ];
  assert.equal(hooks.PreToolUse[0].matcher, PLAN_WRITER_MATCHER);
  assert.deepEqual(hooks.PreToolUse[0].matcher.split("|"), expected);
  assert.deepEqual(
    new Set(expected.map((name) => name.toLowerCase())),
    new Set([...PLAN_WRITER_TOOLS]),
  );
  assert.deepEqual(Object.keys(hooks), EXPECTED_HOOK_EVENTS);
  for (const eventName of EXPECTED_HOOK_EVENTS) {
    assert.equal(hooks[eventName].length, 1, eventName);
    assert.equal(hooks[eventName][0].timeoutSec, 5, eventName);
  }
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

function vscodeTranscriptPath(storageRoot, sessionId) {
  const transcriptDirectory = path.join(storageRoot, "GitHub.copilot-chat", "transcripts");
  mkdirSync(transcriptDirectory, { recursive: true });
  writeFileSync(path.join(storageRoot, "workspace.json"), "{}\n");
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, "");
  return transcriptPath;
}

function assertWithinHookDeadline(shellName, eventName, elapsedMs) {
  const deadlineMs = hooks[eventName][0].timeoutSec * 1_000;
  assert.ok(
    elapsedMs < deadlineMs,
    `${shellName} ${eventName} exceeded the hook timeout: ${elapsedMs}ms`,
  );
}

function invokePowerShell(
  eventName,
  input,
  cwd,
  extraEnv = {},
  pluginRoot = root,
) {
  assert.notEqual(path.resolve(cwd), root, "repository cwd must differ from plugin cwd");
  const command = hooks[eventName][0].powershell;
  const result = spawnProcessTreeSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      cwd,
      env: { ...process.env, ...extraEnv, PLUGIN_ROOT: pluginRoot },
      input: JSON.stringify(input),
      timeout: 10_000,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assertWithinHookDeadline("PowerShell", eventName, result.elapsedMs);
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

function invokeBash(
  eventName,
  input,
  cwd,
  extraEnv = {},
  pluginRoot = root.replaceAll("\\", "/"),
) {
  assert.notEqual(path.resolve(cwd), root, "repository cwd must differ from plugin cwd");
  const executable = bashExecutable();
  assert.ok(executable, "Git Bash or bash is required for this test");
  const result = spawnProcessTreeSync(executable, ["-lc", hooks[eventName][0].bash], {
    cwd,
    env: { ...process.env, ...extraEnv, PLUGIN_ROOT: pluginRoot },
    input: JSON.stringify(input),
    timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assertWithinHookDeadline("Bash", eventName, result.elapsedMs);
  return JSON.parse(result.stdout.trim() || "{}");
}

test("checkout harness binds elapsed checks to the manifest timeout", () => {
  const deadlineMs = hooks.SessionStart[0].timeoutSec * 1_000;
  assert.doesNotThrow(() => assertWithinHookDeadline("PowerShell", "SessionStart", deadlineMs - 1));
  assert.throws(
    () => assertWithinHookDeadline("PowerShell", "SessionStart", deadlineMs),
    new RegExp(`PowerShell SessionStart exceeded the hook timeout: ${deadlineMs}ms`),
  );
});

test("every checkout hook uses the trusted root and blocks Node startup injection", () => {
  const cwd = workspace();
  try {
    const preloadMarker = path.join(cwd, "preload-ran.txt");
    const preloadPath = path.join(cwd, "untrusted-preload.cjs");
    writeFileSync(
      preloadPath,
      `require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'ran');\n`,
    );
    for (const [name, invoke, suppliedRoot] of [
      ["powershell", invokePowerShell, root],
      ["bash", invokeBash, root.replaceAll("\\", "/")],
    ]) {
      for (const eventName of EXPECTED_HOOK_EVENTS) {
        rmSync(preloadMarker, { force: true });
        invoke(eventName, payload(cwd, eventName), cwd, {
          COPILOT_GITHUB_TOKEN: "copilot-secret",
          GH_TOKEN: "gh-secret",
          GITHUB_TOKEN: "github-secret",
          NODE_OPTIONS: `--require=${preloadPath}`,
        }, suppliedRoot);
        assert.equal(existsSync(preloadMarker), false, `${name} ${eventName}`);
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

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

function exerciseProgressingStopLifecycle(invoke) {
  const cwd = workspace();
  try {
    const planFile = writeActivePlan(cwd);
    attach(invoke, cwd, planFile);
    for (let index = 0; index < 8; index += 1) {
      if (index > 0) {
        const plan = JSON.parse(readFileSync(planFile, "utf8"));
        plan.items = [{ id: `issue-${index}`, title: `Issue ${index}`, status: "pending" }];
        writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
      }
      const output = invoke("Stop", payload(cwd, "Stop", index > 0), cwd);
      assert.equal(output.decision, "block", `progress epoch ${index}`);
      assert.equal(
        existsSync(path.join(cwd, ".supervised-worker", "attachment.json")),
        true,
        `progress epoch ${index}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    assert.equal(existsSync(cwd), false);
  }
}

function exerciseInvalidStopLifecycle(invoke) {
  const cwd = workspace();
  try {
    const planFile = writeActivePlan(cwd);
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    plan.unexpectedNonce = 1;
    writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    attach(invoke, cwd, planFile);

    const first = invoke("Stop", payload(cwd, "Stop"), cwd);
    assert.equal(first.decision, "block");
    plan.unexpectedNonce = 2;
    writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    const second = invoke("Stop", payload(cwd, "Stop", true), cwd);
    assert.equal(second.decision, "block");
    assert.match(second.reason, /final bounded continuation/);
    plan.unexpectedNonce = 3;
    writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    const third = invoke("Stop", payload(cwd, "Stop", true), cwd);
    assert.equal(third.decision, "allow");
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

test("packaged non-writer PreToolUse is inert before workspace state", {
  skip: process.platform !== "win32",
}, () => {
  const repository = workspace();
  const storageRoot = workspace();
  try {
    const sessionId = "packaged-non-writer";
    const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
    const output = invokePowerShell(
      "PreToolUse",
      {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: root,
        tool_name: "read_file",
        tool_input: { filePath: path.join(repository, "README.md") },
      },
      repository,
    );
    assert.deepEqual(output, {});
    assert.equal(existsSync(path.join(storageRoot, "supervised-worker")), false);
    assert.equal(existsSync(path.join(repository, ".supervised-worker")), false);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("packaged PowerShell denies an unreachable UNC target before its deadline", {
  skip: process.platform !== "win32",
}, () => {
  const cwd = workspace();
  try {
    const output = invokePowerShell(
      "PreToolUse",
      {
        ...payload(cwd, "PreToolUse"),
        tool_name: "Write",
        tool_input: {
          file_path: "\\\\192.0.2.1\\missing-share\\repository\\.git\\config",
        },
      },
      cwd,
    );
    assert.equal(output.permissionDecision, "deny");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("packaged PowerShell denies a multi-drive target set before its deadline", {
  skip: process.platform !== "win32",
}, () => {
  const cwd = workspace();
  try {
    const replacements = [..."EFGHIJKLMNOPQ"].map((drive, index) => ({
      filePath: `${drive}:\\repository-${index}\\.git\\config`,
    }));
    const output = invokePowerShell(
      "PreToolUse",
      {
        ...payload(cwd, "PreToolUse"),
        tool_name: "multi_replace_string_in_file",
        tool_input: { replacements },
      },
      cwd,
    );
    assert.equal(output.permissionDecision, "deny");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("packaged PowerShell hook runs the attached Stop lifecycle", {
  skip: process.platform !== "win32",
}, () => {
  exerciseStopLifecycle(invokePowerShell);
});

test("packaged PowerShell Stop remains attached while the plan progresses", {
  skip: process.platform !== "win32",
}, () => {
  exerciseProgressingStopLifecycle(invokePowerShell);
});

test("packaged PowerShell Stop bounds changing invalid plans", {
  skip: process.platform !== "win32",
}, () => {
  exerciseInvalidStopLifecycle(invokePowerShell);
});

test("packaged PowerShell Stop resets an ambiguous legacy hash mismatch", {
  skip: process.platform !== "win32",
}, () => {
  const cwd = workspace();
  try {
    const planFile = writeActivePlan(cwd);
    const canonicalOrderPlan = {
      completion: null,
      goal: "Exercise the packaged hook.",
      items: [{ id: "one", status: "in_progress", title: "One" }],
      mode: "active",
      schemaVersion: 1,
    };
    const legacyHash = sha256(JSON.stringify(canonicalOrderPlan));
    const reorderedPlan = {
      schemaVersion: 1,
      mode: "active",
      goal: "Exercise the packaged hook.",
      items: [{ title: "One", status: "in_progress", id: "one" }],
      completion: null,
    };
    assert.notEqual(sha256(JSON.stringify(reorderedPlan)), legacyHash);
    writeFileSync(planFile, `${JSON.stringify(reorderedPlan, null, 2)}\n`);
    attach(invokePowerShell, cwd, planFile);
    const runtime = path.join(
      cwd,
      ".supervised-worker",
      "runtime",
      `${sha256("22222222-2222-4222-8222-222222222222")}.json`,
    );
    mkdirSync(path.dirname(runtime), { recursive: true });
    writeFileSync(runtime, JSON.stringify({
      schemaVersion: 1,
      progressHash: legacyHash,
      sameProgressBlocks: 2,
      totalBlocks: 2,
    }));

    const output = invokePowerShell("Stop", payload(cwd, "Stop", true), cwd);
    assert.equal(output.decision, "block");
    assert.doesNotMatch(output.reason, /final bounded continuation/);
    const migrated = JSON.parse(readFileSync(runtime, "utf8"));
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.sameProgressBlocks, 1);
    assert.equal(migrated.totalBlocks, 3);
    assert.equal(migrated.progressHash, legacyHash);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    assert.equal(existsSync(cwd), false);
  }
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

test("packaged PowerShell routes aliases and reports a missing bound route", {
  skip: process.platform !== "win32",
}, () => {
  const repository = workspace();
  const storageRoot = workspace();
  try {
    const sessionId = "packaged-vscode-routing";
    const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
    const planFile = writeActivePlan(repository);
    const common = {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: root,
    };
    const claimed = invokePowerShell(
      "PreToolUse",
      {
        ...common,
        tool_name: "Write",
        tool_input: { file_path: planFile },
      },
      repository,
    );
    assert.deepEqual(claimed, {});

    mkdirSync(path.join(repository, ".git"));
    writeFileSync(path.join(repository, ".git", "config"), "protected\n");
    const gitAlias = path.join(repository, "git-alias");
    symlinkSync(path.join(repository, ".git"), gitAlias, "junction");
    const denied = invokePowerShell(
      "PreToolUse",
      {
        ...common,
        tool_name: "Write",
        tool_input: { file_path: path.join(gitAlias, "config") },
      },
      repository,
    );
    assert.equal(denied.permissionDecision, "deny");

    const firstStop = invokePowerShell(
      "Stop",
      { ...common, hook_event_name: "Stop" },
      repository,
    );
    assert.equal(firstStop.decision, "block");
    const routePath = path.join(
      storageRoot,
      "supervised-worker",
      "session-roots",
      sha256(sessionId),
      "route.json",
    );
    rmSync(routePath);
    const missingRoute = invokePowerShell(
      "Stop",
      { ...common, hook_event_name: "Stop" },
      repository,
    );
    assert.equal(missingRoute.decision, "allow");
    assert.match(missingRoute.systemMessage, /could not verify its local state/);
    assert.equal(
      existsSync(path.join(repository, ".supervised-worker", "attachment.json")),
      true,
    );
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("packaged PostToolUseFailure releases a provisional routed claim", {
  skip: process.platform !== "win32",
}, () => {
  const repository = workspace();
  const storageRoot = workspace();
  try {
    const sessionId = "packaged-failed-plan";
    const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
    const planFile = path.join(repository, ".supervised-worker", "plan.json");
    const common = {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: root,
      tool_name: "Write",
      tool_input: { file_path: planFile },
    };
    assert.deepEqual(
      invokePowerShell(
        "PreToolUse",
        { ...common, hook_event_name: "PreToolUse" },
        repository,
      ),
      {},
    );
    assert.deepEqual(
      invokePowerShell(
        "PostToolUseFailure",
        { ...common, hook_event_name: "PostToolUseFailure" },
        repository,
      ),
      {},
    );
    const routePath = path.join(
      storageRoot,
      "supervised-worker",
      "session-roots",
      sha256(sessionId),
      "route.json",
    );
    assert.equal(JSON.parse(readFileSync(routePath, "utf8")).status, "released");
    assert.equal(
      existsSync(path.join(repository, ".supervised-worker", "attachment.json")),
      false,
    );
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("packaged PostToolUse reconciles a missing plan as a failed write", {
  skip: process.platform !== "win32",
}, () => {
  const repository = workspace();
  const storageRoot = workspace();
  try {
    const sessionId = "packaged-missing-plan";
    const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
    const planFile = path.join(repository, ".supervised-worker", "plan.json");
    const common = {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: root,
      tool_name: "Write",
      tool_input: { file_path: planFile },
    };
    assert.deepEqual(
      invokePowerShell(
        "PreToolUse",
        { ...common, hook_event_name: "PreToolUse" },
        repository,
      ),
      {},
    );
    const output = invokePowerShell(
      "PostToolUse",
      { ...common, hook_event_name: "PostToolUse" },
      repository,
    );
    assert.match(output.additionalContext, /without materializing/);
    const routePath = path.join(
      storageRoot,
      "supervised-worker",
      "session-roots",
      sha256(sessionId),
      "route.json",
    );
    assert.equal(JSON.parse(readFileSync(routePath, "utf8")).status, "released");
    assert.equal(
      existsSync(path.join(repository, ".supervised-worker", "attachment.json")),
      false,
    );
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("packaged PowerShell PreToolUse denies linked-worktree Git roots", {
  skip: process.platform !== "win32",
}, () => {
  const repository = workspace();
  const worktree = workspace();
  rmSync(worktree, { recursive: true, force: true });
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    writeFileSync(path.join(repository, "tracked.txt"), "baseline\n");
    execFileSync("git", ["add", "--", "tracked.txt"], { cwd: repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test User",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "baseline",
      ],
      { cwd: repository },
    );
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", worktree], {
      cwd: repository,
    });
    const gitDirectory = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      { cwd: worktree, encoding: "utf8" },
    ).trim();
    const commonDirectory = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: worktree, encoding: "utf8" },
    ).trim();
    for (const target of [path.join(gitDirectory, "HEAD"), path.join(commonDirectory, "config")]) {
      const denied = invokePowerShell(
        "PreToolUse",
        {
          ...payload(worktree, "PreToolUse"),
          tool_name: "Write",
          tool_input: { file_path: target },
        },
        worktree,
      );
      assert.equal(denied.permissionDecision, "deny", target);
    }
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("checkout PowerShell hook fails closed without PLUGIN_ROOT", {
  skip: process.platform !== "win32",
}, () => {
  const cwd = workspace();
  try {
    const plantedDirectory = path.join(cwd, "src");
    const markerPath = path.join(cwd, "planted-ran.txt");
    mkdirSync(plantedDirectory);
    writeFileSync(
      path.join(plantedDirectory, "hook-launcher.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "ran");\n`,
    );
    const result = spawnProcessTreeSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-Command", hooks.SessionStart[0].powershell],
      {
        cwd,
        env: { ...process.env, PLUGIN_ROOT: "" },
        input: JSON.stringify(payload(cwd, "SessionStart")),
        timeout: 10_000,
      },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.ok(
      result.elapsedMs < hooks.SessionStart[0].timeoutSec * 1_000,
      `PowerShell SessionStart exceeded the hook timeout: ${result.elapsedMs}ms`,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires PLUGIN_ROOT/);
    assert.equal(existsSync(markerPath), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});