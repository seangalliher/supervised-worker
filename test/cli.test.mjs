import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.mjs");

function workspace() {
  return mkdtempSync(path.join(os.tmpdir(), "supervised-worker-cli-"));
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd ?? root,
    input: options.input ?? "",
    encoding: "utf8",
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

test("explicit help succeeds while malformed commands fail", () => {
  const help = run(["help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage:/);

  for (const args of [
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