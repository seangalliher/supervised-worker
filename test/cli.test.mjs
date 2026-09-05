import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { releaseAttachment } from "../src/core.mjs";
import { validateGitHubQueueObservation } from "../src/github-queue.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.mjs");
const hookLauncher = path.join(root, "src", "hook-launcher.mjs");

function workspace() {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "supervised-worker-cli-")));
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd ?? root,
    input: options.input ?? "",
    encoding: "utf8",
    timeout: options.timeout,
  });
}

function writeCampaignState(cwd) {
  const state = path.join(cwd, ".supervised-worker");
  mkdirSync(path.join(state, "runs"), { recursive: true });
  writeFileSync(
    path.join(state, "plan.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      mode: "active",
      goal: "SECRET CLI GOAL",
      items: [{ id: "secret-cli-id", title: "SECRET CLI TITLE", status: "pending" }],
      completion: null,
    }, null, 2)}\n`,
  );
  return state;
}

for (const command of ["doctor", "validate"]) {
  test(`${command} reports corrupt attachment state without an unhandled rejection`, () => {
    const cwd = workspace();
    try {
      const state = writeCampaignState(cwd);
      const healthy = run([command], { cwd });
      assert.equal(healthy.status, 0, healthy.stderr || healthy.stdout);
      assert.equal(JSON.parse(healthy.stdout).plan.valid, true);
      const attachmentPath = path.join(state, "attachment.json");
      const corruptBytes = '{"schemaVersion":3,"private":"PRIVATE_ATTACHMENT"}\n';
      writeFileSync(attachmentPath, corruptBytes);
      const result = run([command], { cwd });
      assert.equal(result.status, 1);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.equal(report.ok, false);
      assert.equal(report.plan.valid, false);
      assert.ok(report.errors.includes("Local state could not be verified."));
      assert.doesNotMatch(result.stdout, /PRIVATE_ATTACHMENT/);
      assert.equal(readFileSync(attachmentPath, "utf8"), corruptBytes);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("CLI status, checkpoint, fresh resume, and Stop cross real process boundaries", () => {
  const cwd = workspace();
  try {
    const state = writeCampaignState(cwd);
    const planFile = path.join(state, "plan.json");
    const input = { cwd, session_id: "cli-checkpoint-source", tool_name: "Write", tool_use_id: "cli-setup", tool_input: { file_path: planFile } };
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const result = run(["hook", event], { cwd, input: JSON.stringify(input) });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {});
    }
    const before = readFileSync(planFile);
    const status = run(["status"], { cwd });
    assert.equal(status.status, 0, status.stderr);
    const summary = JSON.parse(status.stdout);
    assert.equal(summary.attachment.status, "active");
    assert.match(summary.planHash, /^[0-9a-f]{64}$/);
    assert.match(summary.attachmentHash, /^[0-9a-f]{64}$/);
    const request = { session_id: input.session_id, planHash: summary.planHash, attachmentHash: summary.attachmentHash };
    const checkpoint = run(["checkpoint"], { cwd, input: JSON.stringify(request) });
    assert.equal(checkpoint.status, 0, checkpoint.stderr || checkpoint.stdout);
    const saved = JSON.parse(checkpoint.stdout);
    assert.equal(saved.status, "checkpointed");
    assert.doesNotMatch(checkpoint.stdout, /SECRET CLI|secret-cli-id/);
    const fresh = { cwd, session_id: "cli-checkpoint-successor" };
    assert.deepEqual(JSON.parse(run(["hook", "SessionStart"], { cwd, input: JSON.stringify(fresh) }).stdout), {});
    const resumed = run(["resume"], { cwd, input: JSON.stringify({ session_id: fresh.session_id, planHash: summary.planHash, checkpointHash: saved.checkpointHash }) });
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    assert.equal(JSON.parse(resumed.stdout).status, "resumed");
    assert.deepEqual(JSON.parse(resumed.stdout).context, saved.context);
    const stop = run(["hook", "Stop"], { cwd, input: JSON.stringify(fresh) });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).decision, "block");
    assert.deepEqual(readFileSync(planFile), before);
    assert.equal(JSON.parse(run(["status"], { cwd }).stdout).complete, false);
    const stale = run(["checkpoint"], { cwd, input: JSON.stringify(request) });
    assert.equal(stale.status, 1);
    assert.equal(JSON.parse(stale.stdout).status, "unconfirmed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const command of ["checkpoint", "resume"]) {
  test(`${command} rejects malformed, duplicate, oversized, and unknown request data privately`, () => {
    const cwd = workspace();
    try {
      const state = writeCampaignState(cwd);
      const planBytes = readFileSync(path.join(state, "plan.json"));
      for (const input of [
        "", "{PRIVATE_INPUT", "null", "[]", "{}",
        '{"session_id":"PRIVATE_INPUT","session_id":"other"}',
        JSON.stringify({ session_id: "PRIVATE_INPUT", planHash: "a".repeat(64), attachmentHash: "b".repeat(64), cwd: "PRIVATE_OVERRIDE" }),
        JSON.stringify({ session_id: "PRIVATE_INPUT", planHash: "a".repeat(64), checkpointHash: null, command: "PRIVATE_EXECUTION" }),
        `PRIVATE_INPUT${"x".repeat(8_192)}`, Buffer.from([0xff, 0x7b, 0x7d]),
      ]) {
        const result = run([command], { cwd, input });
        assert.equal(result.status, 1, result.stderr || result.stdout);
        assert.equal(result.stderr, "");
        assert.equal(JSON.parse(result.stdout).status, "unconfirmed");
        assert.doesNotMatch(result.stdout, /PRIVATE_/);
        assert.deepEqual(readFileSync(path.join(state, "plan.json")), planBytes);
        assert.equal(existsSync(path.join(state, "attachment.json")), false);
      }
      const arity = run([command, "extra"], { cwd, input: "PRIVATE_INPUT" });
      assert.equal(arity.status, 1);
      assert.match(arity.stdout, /^Usage:/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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

test("release API rejects a junction or symlink repository root without deleting ownership", () => {
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
  try {
    symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => releaseAttachment(alias), /canonical repository root/);
    assert.equal(existsSync(attachmentPath), true);
  } finally {
    rmSync(alias, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("release CLI rejects a Windows junction cwd without deleting ownership", {
  skip: process.platform !== "win32",
}, () => {
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
  try {
    symlinkSync(cwd, alias, "junction");
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

test("campaign export supports only deterministic JSON and Markdown stdout forms", () => {
  const cwd = workspace();
  try {
    const state = writeCampaignState(cwd);
    const before = readdirSync(state).sort();
    const defaultJson = run(["campaign", "export"], { cwd });
    const explicitJson = run(["campaign", "export", "--format", "json"], { cwd });
    const markdown = run(["campaign", "export", "--format", "markdown"], { cwd });

    assert.equal(defaultJson.status, 0, defaultJson.stderr);
    assert.equal(explicitJson.status, 0, explicitJson.stderr);
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.equal(defaultJson.stderr, "");
    assert.equal(explicitJson.stderr, "");
    assert.equal(markdown.stderr, "");
    assert.equal(defaultJson.stdout, explicitJson.stdout);
    const receipt = JSON.parse(defaultJson.stdout);
    assert.equal(receipt.kind, "local-campaign-receipt");
    assert.equal(receipt.localDataStatus, "available");
    assert.equal(receipt.providerFacts.ci.status, "unavailable");
    assert.equal(receipt.providerFacts.ci.value, null);
    assert.doesNotMatch(defaultJson.stdout, /SECRET CLI|secret-cli-id/);
    assert.match(markdown.stdout, /^# Local Campaign Receipt/);
    assert.match(markdown.stdout, /Local-only, not Provider-Verified Completion/);
    assert.doesNotMatch(markdown.stdout, /SECRET CLI|secret-cli-id/);
    assert.deepEqual(readdirSync(state).sort(), before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("campaign export renders partial receipts and exits one without creating state", () => {
  const cwd = workspace();
  try {
    const json = run(["campaign", "export"], { cwd });
    assert.equal(json.status, 1, json.stderr);
    assert.equal(json.stderr, "");
    const receipt = JSON.parse(json.stdout);
    assert.equal(receipt.localDataStatus, "partial");
    assert.equal(receipt.plan.reason, "plan-absent");
    assert.equal(receipt.plan.counts, null);
    assert.equal(receipt.runLedger.reason, "run-ledger-absent");
    assert.equal(receipt.runLedger.recordCount, null);
    assert.equal(existsSync(path.join(cwd, ".supervised-worker")), false);

    const markdown = run(["campaign", "export", "--format", "markdown"], { cwd });
    assert.equal(markdown.status, 1, markdown.stderr);
    assert.match(markdown.stdout, /Local-only, not Provider-Verified Completion/);
    assert.match(markdown.stdout, /Unavailable/);
    assert.equal(existsSync(path.join(cwd, ".supervised-worker")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("campaign validate reports exact current reconciliation without echoing paths", () => {
  const cwd = workspace();
  try {
    writeCampaignState(cwd);
    const exported = run(["campaign", "export"], { cwd });
    assert.equal(exported.status, 0, exported.stderr);
    const receiptPath = path.join(cwd, "TOPSECRET-receipt.json");
    writeFileSync(receiptPath, exported.stdout);

    const valid = run(["campaign", "validate", "TOPSECRET-receipt.json"], { cwd });
    assert.equal(valid.status, 0, valid.stderr);
    const report = JSON.parse(valid.stdout);
    assert.deepEqual(Object.keys(report), ["ok", "receiptHash", "matchesCurrentWorkspace", "errors"]);
    assert.equal(report.ok, true);
    assert.equal(report.matchesCurrentWorkspace, true);
    assert.match(report.receiptHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(report.errors, []);
    assert.doesNotMatch(valid.stdout, /TOPSECRET/);

    writeCampaignState(cwd);
    const planPath = path.join(cwd, ".supervised-worker", "plan.json");
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    plan.goal = "CHANGED SECRET GOAL";
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const stale = run(["campaign", "validate", receiptPath], { cwd });
    assert.equal(stale.status, 1, stale.stderr);
    assert.equal(JSON.parse(stale.stdout).matchesCurrentWorkspace, false);
    assert.doesNotMatch(stale.stdout, /TOPSECRET|CHANGED SECRET/);

    const missing = run(["campaign", "validate", "TOPSECRET-missing.json"], { cwd });
    assert.equal(missing.status, 1, missing.stderr);
    assert.deepEqual(
      JSON.parse(missing.stdout).errors,
      ["Receipt could not be inspected safely."],
    );
    assert.doesNotMatch(missing.stdout, /TOPSECRET/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("malformed campaign arities print usage before touching workspace state", () => {
  const cwd = workspace();
  try {
    const sentinel = path.join(cwd, ".supervised-worker");
    writeFileSync(sentinel, "SENTINEL\n");
    for (const args of [
      ["campaign"],
      ["campaign", "export", "extra"],
      ["campaign", "export", "--format"],
      ["campaign", "export", "--format", "yaml"],
      ["campaign", "export", "--format", "json", "extra"],
      ["campaign", "validate"],
      ["campaign", "validate", "one.json", "two.json"],
      ["campaign", "unknown"],
    ]) {
      const result = run(args, { cwd });
      assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr || result.stdout}`);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /^Usage:/);
      assert.equal(readFileSync(sentinel, "utf8"), "SENTINEL\n");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
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

const QUEUE_QUERY = `query QueueInspection($owner: String!, $name: String!, $states: [IssueState!]!, $cursor: String) {
  viewer { id }
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    issues(first: 100, after: $cursor, states: $states, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      nodes { id number state updatedAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

function queuePage(nodes = [], { totalCount = nodes.length, hasNextPage = false, endCursor = nodes.length ? "terminal:cursor" : null } = {}) {
  return { data: { viewer: { id: "viewer:1" }, repository: {
    id: "repository:1", nameWithOwner: "Example/Queue", issues: { totalCount, nodes, pageInfo: { hasNextPage, endCursor } },
  } } };
}

function queueIssue(number, state = "OPEN") {
  return { id: `issue:${number}`, number, state, updatedAt: "2026-09-04T12:00:00Z" };
}

function queueResponse(body, status = 0, stderr = "") {
  return { status, signal: null, stdout: Buffer.from(JSON.stringify(body)).toString("base64"), stderr: Buffer.from(stderr).toString("base64") };
}

function withQueueProcess(cwd, action) {
  const tools = workspace();
  const executable = path.join(tools, process.platform === "win32" ? "gh.exe" : "gh");
  const marker = path.join(tools, "interceptions.json");
  try {
    copyFileSync(process.execPath, executable);
    chmodSync(executable, 0o755);
    const inspect = (args, { responses = [queueResponse(queuePage())], states = ["OPEN", "CLOSED"], cursors = [null] } = {}) => {
      rmSync(marker, { force: true });
      const expected = responses.map((_, index) => ({ owner: "Example", name: "Queue", states, cursor: cursors[index] }));
      assert.equal(cursors.length, responses.length, "every intended invocation has explicit cursor evidence");
      const script = `
        import assert from "node:assert/strict";
        import childProcess from "node:child_process";
        import { writeFileSync } from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        const responses = ${JSON.stringify(responses)};
        const expected = ${JSON.stringify(expected)};
        const calls = [];
        for (const method of ["exec", "execFile", "execSync", "execFileSync", "fork", "spawn"]) {
          childProcess[method] = () => { throw new Error("Unexpected subprocess in isolated queue test"); };
        }
        childProcess.spawnSync = (executable, args, options) => {
          const index = calls.length;
          const request = JSON.parse(options.input);
          calls.push({ executable, args, request });
          assert.equal(executable, ${JSON.stringify(realpathSync(executable))});
          assert.deepEqual(args, ["api", "graphql", "--hostname", "github.com", "--method", "POST", "--input", "-"]);
          assert.deepEqual(request, { query: ${JSON.stringify(QUEUE_QUERY)}, variables: expected[index] });
          assert.equal(options.cwd, ${JSON.stringify(realpathSync(tools))});
          assert.equal(options.shell, false);
          assert.equal(options.killSignal, "SIGKILL");
          assert.equal(options.timeout, 10000);
          assert.equal(options.maxBuffer, 2097152);
          assert.equal(options.encoding, null);
          assert.equal(options.windowsHide, true);
          assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
          assert.equal(options.env.GH_TOKEN, "PRIVATE_QUEUE_GH_TOKEN");
          assert.equal(options.env.GITHUB_TOKEN, "PRIVATE_QUEUE_GITHUB_TOKEN");
          assert.equal(options.env.GH_PROMPT_DISABLED, "1");
          assert.equal(options.env.GH_NO_UPDATE_NOTIFIER, "1");
          assert.equal(options.env.GH_NO_EXTENSION_UPDATE_NOTIFIER, "1");
          for (const key of ["GH_HOST", "GH_REPO", "GH_DEBUG", "GH_HTTP_UNIX_SOCKET", "GITHUB_API_URL", "HTTPS_PROXY", "NODE_OPTIONS"]) {
            assert.equal(Object.hasOwn(options.env, key), false);
          }
          assert.ok(index < responses.length, "the real CLI reached an expected intercepted transport call");
          const response = responses[index];
          return { ...response, stdout: Buffer.from(response.stdout, "base64"), stderr: Buffer.from(response.stderr, "base64") };
        };
        syncBuiltinESMExports();
        process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}];
        await import(${JSON.stringify(pathToFileURL(cli).href)});
        assert.equal(calls.length, expected.length, "the interception premise and invocation count must hold");
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify(calls));
      `;
      const environment = { ...process.env };
      for (const key of Object.keys(environment)) {
        if (/^(?:GH_|GITHUB_)/i.test(key) || ["PATH", "NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase())) delete environment[key];
      }
      Object.assign(environment, {
        PATH: tools, NODE_OPTIONS: "", GH_TOKEN: "PRIVATE_QUEUE_GH_TOKEN", GITHUB_TOKEN: "PRIVATE_QUEUE_GITHUB_TOKEN",
        GH_HOST: "PRIVATE_QUEUE_HOST", GH_REPO: "PRIVATE_QUEUE_REPO", GH_DEBUG: "api",
        GH_HTTP_UNIX_SOCKET: "PRIVATE_QUEUE_SOCKET", GITHUB_API_URL: "PRIVATE_QUEUE_ENDPOINT", HTTPS_PROXY: "PRIVATE_QUEUE_PROXY",
      });
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd, env: environment, encoding: "utf8", timeout: 15_000,
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.stderr, "");
      assert.ok(existsSync(marker), "the child imported the actual CLI and completed its interception assertions");
      const calls = JSON.parse(readFileSync(marker, "utf8"));
      assert.deepEqual(calls, expected.map((variables) => ({
        executable: realpathSync(executable),
        args: ["api", "graphql", "--hostname", "github.com", "--method", "POST", "--input", "-"],
        request: { query: QUEUE_QUERY, variables },
      })));
      const observation = JSON.parse(result.stdout);
      assert.deepEqual(validateGitHubQueueObservation(observation), []);
      assert.doesNotMatch(result.stdout, /PRIVATE_QUEUE_|SECRET CLI|secret-cli-id/);
      return { ...result, observation, calls };
    };
    action(inspect);
  } finally {
    rmSync(tools, { recursive: true, force: true });
  }
}

function queueStateBytes(directory) {
  const entries = [];
  function visit(relative = "") {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        entries.push([name, null]);
        visit(name);
      } else entries.push([name, readFileSync(path.join(directory, name))]);
    }
  }
  visit();
  return entries;
}

test("queue CLI reaches the real adapter for explicit open, closed, and all observations with no network", () => {
  const cwd = workspace();
  try {
    withQueueProcess(cwd, (inspect) => {
      for (const [state, states] of [["open", ["OPEN"]], ["closed", ["CLOSED"]], ["all", ["OPEN", "CLOSED"]]]) {
        const before = Date.now();
        const observed = inspect(["queue", "inspect", "Example/Queue", "--state", state], {
          states, responses: [queueResponse(queuePage([queueIssue(3, states[0])]))],
        });
        assert.equal(observed.status, 0);
        assert.equal(observed.calls.length, 1);
        assert.equal(observed.observation.status, "complete");
        assert.equal(observed.observation.scope.state, state);
        assert.equal(observed.observation.totalCount, 1);
        assert.ok(Date.parse(observed.observation.startedAt) >= before);
        assert.ok(Date.parse(observed.observation.finishedAt) <= Date.now());
      }
      const empty = inspect(["queue", "inspect", "Example/Queue", "--state", "all"]);
      assert.equal(empty.status, 0);
      assert.equal(empty.calls.length, 1);
      assert.equal(empty.observation.pageCount, 1);
      assert.deepEqual(empty.observation.issues, []);
      assert.equal(existsSync(path.join(cwd, ".supervised-worker")), false);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("queue CLI rejects every unsupported arity, flag, and injection before transport", () => {
  const cwd = workspace();
  try {
    const sentinel = path.join(cwd, ".supervised-worker");
    writeFileSync(sentinel, "STATE SENTINEL");
    withQueueProcess(cwd, (inspect) => {
      const prefix = ["queue", "inspect", "Example/Queue"];
      for (const args of [
        ["queue"], ["queue", "other"], ["queue", "inspect"], prefix,
        [...prefix, "--state"], [...prefix, "--state", "OPEN"], [...prefix, "--state", "all", "extra"],
        [...prefix, "--state", "all", "--state", "open"], [...prefix, "--state=all"],
        ["queue", "inspect", "--state", "all", "Example/Queue"],
        ...["--host", "--hostname", "--endpoint", "--executable", "--output", "--query"].map((flag) => [...prefix, "--state", "all", flag, "PRIVATE_QUEUE_OPTION"]),
        ...["https://github.com/Example/Queue", "../Queue", "Example/..", " Example/Queue", "Example/Queue\n",
          "Example/Queue;PRIVATE_QUEUE_COMMAND", "Example/Queue$(PRIVATE_QUEUE_COMMAND)", "Example/Queue|PRIVATE_QUEUE_COMMAND",
          "Example/Queue&&PRIVATE_QUEUE_COMMAND", "Example/Queue\u0001"].map((repository) => ["queue", "inspect", repository, "--state", "all"]),
      ]) {
        const observed = inspect(args, { responses: [], cursors: [] });
        assert.equal(observed.status, 1);
        assert.equal(observed.calls.length, 0);
        assert.equal(observed.observation.status, "unavailable");
        assert.equal(observed.observation.reason, "invalid-input");
        assert.equal(observed.observation.scope, null);
        assert.equal(readFileSync(sentinel, "utf8"), "STATE SENTINEL");
      }
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("queue CLI failures emit only validated unavailable JSON and discard earlier pages", () => {
  const cwd = workspace();
  try {
    withQueueProcess(cwd, (inspect) => {
      const args = ["queue", "inspect", "Example/Queue", "--state", "all"];
      const first = queuePage([queueIssue(1)], { totalCount: 2, hasNextPage: true, endCursor: "opaque:next /?=+" });
      const last = queuePage([queueIssue(2, "CLOSED")], { totalCount: 2 });
      const cursors = [null, "opaque:next /?=+"];
      const valid = inspect(args, { responses: [queueResponse(first), queueResponse(last)], cursors });
      assert.equal(valid.status, 0);
      assert.equal(valid.calls.length, 2);
      const authentication = inspect(args, { responses: [queueResponse(null, 4, "PRIVATE_QUEUE_CREDENTIAL")] });
      assert.equal(authentication.status, 1);
      assert.equal(authentication.calls.length, 1);
      assert.equal(authentication.observation.reason, "authentication-unavailable");
      const partial = inspect(args, {
        responses: [queueResponse(first), queueResponse({ ...last, errors: [{ message: "PRIVATE_QUEUE_PAYLOAD" }] }, 1)], cursors,
      });
      assert.equal(partial.status, 1);
      assert.equal(partial.calls.length, 2);
      assert.equal(partial.observation.reason, "provider-error");
      for (const key of ["actor", "repository", "totalCount", "pageCount", "issues"]) assert.equal(partial.observation[key], null);
      assert.equal(existsSync(path.join(cwd, ".supervised-worker")), false);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("queue inspection preserves active state bytes, all seven campaign facts, reconciliation, and Stop authority", () => {
  const cwd = workspace();
  try {
    const state = writeCampaignState(cwd);
    const planFile = path.join(state, "plan.json");
    const input = { cwd, session_id: "queue-compatibility", tool_name: "Write", tool_use_id: "queue-setup", tool_input: { file_path: planFile } };
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const attached = run(["hook", event], { cwd, input: JSON.stringify(input) });
      assert.equal(attached.status, 0, attached.stderr);
      assert.deepEqual(JSON.parse(attached.stdout), {});
    }
    const status = run(["status"], { cwd });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).attachment.status, "active");
    const exported = run(["campaign", "export"], { cwd });
    assert.equal(exported.status, 0, exported.stderr);
    const original = JSON.parse(exported.stdout);
    assert.equal(original.localDataStatus, "available");
    assert.ok(original.runLedger.recordCount > 0, "actual hook producers populated the ledger");
    assert.equal(Object.keys(original.providerFacts).length, 7);
    for (const fact of Object.values(original.providerFacts)) {
      assert.equal(fact.status, "unavailable");
      assert.equal(fact.value, null);
      assert.equal(typeof fact.reason, "string");
      assert.ok(fact.reason.length > 0);
    }
    const receipt = path.join(cwd, "queue-baseline-receipt.json");
    writeFileSync(receipt, exported.stdout);
    const before = queueStateBytes(state);
    assert.ok(before.some(([name]) => name === "plan.json"));
    assert.ok(before.some(([name]) => name === "attachment.json"));
    withQueueProcess(cwd, (inspect) => {
      const observed = inspect(["queue", "inspect", "Example/Queue", "--state", "all"], {
        responses: [queueResponse(queuePage([queueIssue(3)]))],
      });
      assert.equal(observed.status, 0);
      assert.equal(observed.calls.length, 1);
      assert.deepEqual(observed.observation.issues, [queueIssue(3)]);
    });
    assert.deepEqual(queueStateBytes(state), before);
    const after = run(["campaign", "export"], { cwd });
    assert.equal(after.status, 0, after.stderr);
    assert.deepEqual(JSON.parse(after.stdout).providerFacts, original.providerFacts);
    assert.equal(after.stdout, exported.stdout);
    const reconciled = run(["campaign", "validate", receipt], { cwd });
    assert.equal(reconciled.status, 0, reconciled.stderr);
    assert.equal(JSON.parse(reconciled.stdout).matchesCurrentWorkspace, true);
    assert.deepEqual(queueStateBytes(state), before);
    const stop = run(["hook", "Stop"], { cwd, input: JSON.stringify({ cwd, session_id: input.session_id }) });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).decision, "block");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});