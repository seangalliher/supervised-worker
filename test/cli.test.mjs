import assert from "node:assert/strict";
import {
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
import { fileURLToPath } from "node:url";

import { releaseAttachment } from "../src/core.mjs";

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