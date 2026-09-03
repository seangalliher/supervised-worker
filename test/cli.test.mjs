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
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.mjs");
const hookLauncher = path.join(root, "src", "hook-launcher.mjs");

function workspace() {
  return mkdtempSync(path.join(os.tmpdir(), "supervised-worker-cli-"));
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd ?? root,
    input: options.input ?? "",
    encoding: "utf8",
    timeout: options.timeout,
  });
}

test("malformed hook JSON fails open without echoing its content", () => {
  const result = run(["hook", "Stop"], { input: "{TOPSECRET" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ignored malformed hook input/);
  assert.doesNotMatch(result.stdout, /TOPSECRET/);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, "allow");
  assert.equal(output.hookSpecificOutput.decision, "allow");
});

test("oversized hook input fails open without echoing its content", () => {
  const result = run(["hook", "Stop"], { input: `TOPSECRET${"x".repeat(1_048_576)}` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ignored oversized hook input/);
  assert.doesNotMatch(result.stdout, /TOPSECRET/);
});

test("malformed PreToolUse input is denied without echoing content", () => {
  const result = run(["hook", "PreToolUse"], { input: "{TOPSECRET" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.permissionDecision, "deny");
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.doesNotMatch(result.stdout, /TOPSECRET/);
});

test("oversized PreToolUse input is denied without echoing content", () => {
  const result = run(["hook", "PreToolUse"], {
    input: `TOPSECRET${"x".repeat(1_048_576)}`,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.permissionDecision, "deny");
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.doesNotMatch(result.stdout, /TOPSECRET/);
});

const invalidRepositoryCwds = [
  ["missing", undefined],
  ["blank", ""],
  ["relative", "."],
  ...(process.platform === "win32"
    ? [
        ["root-relative slash", "/"],
        ["root-relative backslash", "\\repo"],
        ["drive-relative", "C:repo"],
        ["device namespace", "\\\\?\\C:\\repo"],
      ]
    : []),
];

for (const [name, cwdValue] of invalidRepositoryCwds) {
  test(`${name} repository cwd denies PreToolUse before state handling`, () => {
    const target = workspace();
    try {
      const input = {
        hook_event_name: "PreToolUse",
        session_id: "invalid-cwd-session",
        tool_name: "Write",
        tool_input: { file_path: path.join(target, ".supervised-worker", "plan.json") },
        ...(cwdValue === undefined ? {} : { cwd: cwdValue }),
      };
      const result = run(["hook", "PreToolUse"], { input: JSON.stringify(input) });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.permissionDecision, "deny");
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      assert.match(output.permissionDecisionReason, /absolute repository cwd/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
}

test("Windows accepts local drive roots and rejects UNC repository roots", {
  skip: process.platform !== "win32",
}, () => {
  const localCwd = path.resolve(root);
  const local = run(["hook", "Probe"], {
    input: JSON.stringify({ hook_event_name: "Probe", session_id: "qualified-cwd", cwd: localCwd }),
  });
  assert.equal(local.status, 0, local.stderr);
  assert.deepEqual(JSON.parse(local.stdout), {});

  const unc = run(["hook", "Probe"], {
    input: JSON.stringify({
      hook_event_name: "Probe",
      session_id: "qualified-cwd",
      cwd: "\\\\server\\share\\repository",
    }),
  });
  assert.equal(unc.status, 0, unc.stderr);
  assert.match(JSON.parse(unc.stdout).systemMessage, /could not verify local state/);
});

test("invalid repository cwd fails open visibly for non-edit lifecycle events", () => {
  for (const eventName of ["SessionStart", "PostToolUse", "PostToolUseFailure", "PreCompact", "Stop"]) {
    const result = run(["hook", eventName], {
      input: JSON.stringify({
        hook_event_name: eventName,
        session_id: "invalid-cwd-session",
        cwd: ".",
      }),
    });
    assert.equal(result.status, 0, `${eventName}: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.match(output.systemMessage, /absolute repository cwd/, eventName);
    if (eventName === "Stop") {
      assert.equal(output.decision, "allow");
      assert.equal(output.hookSpecificOutput.decision, "allow");
    } else {
      assert.match(output.additionalContext, /absolute repository cwd/);
    }
  }
});

for (const value of [null, [], "text", 42]) {
  test(`non-object PreToolUse input ${JSON.stringify(value)} is denied safely`, () => {
    const result = run(["hook", "PreToolUse"], { input: JSON.stringify(value) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.permissionDecision, "deny");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  });

  test(`non-object Stop input ${JSON.stringify(value)} fails open visibly`, () => {
    const result = run(["hook", "Stop"], { input: JSON.stringify(value) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "allow");
    assert.equal(output.hookSpecificOutput.decision, "allow");
    assert.match(output.systemMessage, /non-object hook input/);
  });
}

test("release removes an explicitly stale attachment", () => {
  const cwd = workspace();
  try {
    const state = path.join(cwd, ".supervised-worker");
    mkdirSync(state, { recursive: true });
    writeFileSync(
      path.join(state, "attachment.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        sessionHash: "a".repeat(64),
        attachedAt: "2026-09-01T00:00:00Z",
      })}\n`,
    );
    const result = run(["release"], { cwd });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).released, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("release with trailing arguments leaves attachment ownership untouched", () => {
  const cwd = workspace();
  try {
    const attachmentPath = path.join(cwd, ".supervised-worker", "attachment.json");
    mkdirSync(path.dirname(attachmentPath), { recursive: true });
    const attachment = `${JSON.stringify({
      schemaVersion: 1,
      sessionHash: "a".repeat(64),
      attachedAt: "2026-09-01T00:00:00Z",
    })}\n`;
    writeFileSync(attachmentPath, attachment);

    const result = run(["release", "unexpected"], { cwd });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^Usage:/);
    assert.equal(readFileSync(attachmentPath, "utf8"), attachment);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("release rejects a subst repository root without deleting ownership", {
  skip: process.platform !== "win32",
}, () => {
  const cwd = workspace();
  const state = path.join(cwd, ".supervised-worker");
  mkdirSync(state, { recursive: true });
  const attachmentPath = path.join(state, "attachment.json");
  writeFileSync(
    attachmentPath,
    `${JSON.stringify({
      schemaVersion: 1,
      sessionHash: "a".repeat(64),
      attachedAt: "2026-09-01T00:00:00Z",
    })}\n`,
  );
  const drive = [..."ZYXWVUTSRQPONMLKJIHGFED"].find((letter) => !existsSync(`${letter}:\\`));
  assert.ok(drive, "a free drive letter is required for the release regression");
  execFileSync("subst.exe", [`${drive}:`, cwd]);
  try {
    const result = run(["release"], { cwd: `${drive}:\\` });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).released, false);
    assert.equal(existsSync(attachmentPath), true);
  } finally {
    execFileSync("subst.exe", [`${drive}:`, "/D"]);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("release rejects a junction or symlink repository root without deleting ownership", () => {
  const cwd = workspace();
  const alias = workspace();
  rmSync(alias, { recursive: true, force: true });
  const state = path.join(cwd, ".supervised-worker");
  mkdirSync(state, { recursive: true });
  const attachmentPath = path.join(state, "attachment.json");
  writeFileSync(
    attachmentPath,
    `${JSON.stringify({
      schemaVersion: 1,
      sessionHash: "a".repeat(64),
      attachedAt: "2026-09-01T00:00:00Z",
    })}\n`,
  );
  symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
  try {
    const result = run(["release"], { cwd: alias });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).released, false);
    assert.equal(existsSync(attachmentPath), true);
  } finally {
    rmSync(alias, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("explicit help succeeds while malformed commands fail", () => {
  const help = run(["help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage:/);

  for (const args of [
    ["help", "extra"],
    ["install", "extra"],
    ["status", "extra"],
    ["validate", "extra"],
    ["doctor", "extra"],
    ["workflow", "accept"],
    ["workflow", "accept", "abc", "extra"],
    ["workflow", "roles", "extra"],
    ["unknown-command"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr || result.stdout}`);
    assert.match(result.stdout, /^Usage:/);
  }
});

test("large target sets return a deny envelope before the hook deadline", () => {
  const cwd = workspace();
  try {
    const replacements = Array.from({ length: 4_000 }, (_, index) => ({
      filePath: path.join(cwd, `target-${index}.txt`),
    }));
    const result = run(["hook", "PreToolUse"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "large-target-session",
        cwd,
        tool_name: "multi_replace_string_in_file",
        tool_input: { replacements },
      }),
      timeout: 4_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.permissionDecision, "deny");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hook with trailing arguments leaves attachment ownership untouched", () => {
  const cwd = workspace();
  try {
    const sessionId = "malformed-hook-session";
    const attachmentPath = path.join(cwd, ".supervised-worker", "attachment.json");
    mkdirSync(path.dirname(attachmentPath), { recursive: true });
    const attachment = `${JSON.stringify({
      schemaVersion: 1,
      sessionHash: createHash("sha256").update(sessionId).digest("hex"),
      attachedAt: "2026-09-01T00:00:00Z",
    })}\n`;
    writeFileSync(attachmentPath, attachment);

    const result = run(["hook", "Stop", "unexpected"], {
      cwd,
      input: JSON.stringify({
        hook_event_name: "Stop",
        session_id: sessionId,
        cwd,
      }),
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^Usage:/);
    assert.equal(readFileSync(attachmentPath, "utf8"), attachment);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hook launcher with trailing arguments leaves attachment ownership untouched", () => {
  const cwd = workspace();
  try {
    const sessionId = "malformed-launcher-session";
    const attachmentPath = path.join(cwd, ".supervised-worker", "attachment.json");
    mkdirSync(path.dirname(attachmentPath), { recursive: true });
    const attachment = `${JSON.stringify({
      schemaVersion: 1,
      sessionHash: createHash("sha256").update(sessionId).digest("hex"),
      attachedAt: "2026-09-01T00:00:00Z",
    })}\n`;
    writeFileSync(attachmentPath, attachment);

    const result = spawnSync(process.execPath, [hookLauncher, "Stop", "unexpected"], {
      cwd,
      input: JSON.stringify({
        hook_event_name: "Stop",
        session_id: sessionId,
        cwd,
      }),
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /unsupported hook event/);
    assert.equal(readFileSync(attachmentPath, "utf8"), attachment);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});