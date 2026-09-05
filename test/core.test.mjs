import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import test, { afterEach } from "node:test";
import { Worker } from "node:worker_threads";

import {
  canonicalPlanHash,
  checkpointSession,
  handleHook,
  MAX_CHECKPOINT_BYTES,
  MAX_TOOL_TARGETS,
  planPath,
  releaseAttachment,
  resumeSession,
  sha256,
  summarizePlan,
  summarizeRunLedger,
  validateCheckpoint,
  validatePlan,
} from "../src/core.mjs";

const temporaryWorkspaces = new Set();
const coreUrl = new URL("../src/core.mjs", import.meta.url).href;

function workspace() {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "supervised-worker-test-")));
  temporaryWorkspaces.add(cwd);
  return cwd;
}

afterEach(() => {
  for (const cwd of temporaryWorkspaces) rmSync(cwd, { recursive: true, force: true });
  temporaryWorkspaces.clear();
});

function writePlan(cwd, overrides = {}) {
  const value = {
    schemaVersion: 1,
    mode: "active",
    goal: "Complete the selected queue.",
    items: [{ id: "issue-1", title: "First issue", status: "pending" }],
    completion: null,
    ...overrides,
  };
  mkdirSync(path.dirname(planPath(cwd)), { recursive: true });
  writeFileSync(planPath(cwd), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

function stopInput(cwd, active = false) {
  return {
    hook_event_name: "Stop",
    session_id: "11111111-1111-4111-8111-111111111111",
    stop_hook_active: active,
    cwd,
  };
}

function vscodeTranscriptPath(storageRoot, sessionId) {
  const transcriptDirectory = path.join(storageRoot, "GitHub.copilot-chat", "transcripts");
  mkdirSync(transcriptDirectory, { recursive: true });
  writeFileSync(path.join(storageRoot, "workspace.json"), "{}\n");
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, "");
  return transcriptPath;
}

function sessionRoutePath(storageRoot, sessionId) {
  return path.join(
    storageRoot,
    "supervised-worker",
    "session-roots",
    sha256(sessionId),
    "route.json",
  );
}

function sessionMarkerPath(storageRoot, sessionId) {
  return path.join(
    storageRoot,
    "supervised-worker",
    "session-bindings",
    `${sha256(sessionId)}.json`,
  );
}

function attachPlan(cwd, sessionId = "11111111-1111-4111-8111-111111111111") {
  handleHook(
    {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      cwd,
      tool_name: "create_file",
      tool_input: { filePath: planPath(cwd) },
    },
    "PostToolUse",
  );
}

function checkpointFixture(routed = false, cwd = workspace()) {
  const sessionId = `checkpoint-source-${routed}`;
  const storageRoot = routed ? workspace() : null;
  const source = {
    cwd, session_id: sessionId,
    ...(routed ? { transcript_path: vscodeTranscriptPath(storageRoot, sessionId) } : {}),
    tool_name: "Write", tool_use_id: "setup-plan", tool_input: { file_path: planPath(cwd) },
  };
  assert.deepEqual(handleHook(source, "PreToolUse"), {});
  const plan = writePlan(cwd, {
    goal: "PRIVATE_CHECKPOINT_GOAL",
    items: [
      { id: "private-item-one", title: "PRIVATE_TITLE_ONE", status: "in_progress" },
      { id: "private-item-two", title: "PRIVATE_TITLE_TWO", status: "pending" },
    ],
  });
  assert.deepEqual(handleHook(source, "PostToolUse"), {});
  const attachmentFile = path.join(cwd, ".supervised-worker", "attachment.json");
  const attachmentBytes = readFileSync(attachmentFile);
  const attachment = JSON.parse(attachmentBytes);
  assert.equal(attachment.status, "active");
  assert.equal(attachment.sessionHash, sha256(sessionId));
  const request = {
    session_id: sessionId,
    ...(routed ? { transcript_path: source.transcript_path } : {}),
    planHash: canonicalPlanHash(plan), attachmentHash: sha256(attachmentBytes),
  };
  const ledgerFile = path.join(cwd, ".supervised-worker", "runs", `${sha256(sessionId)}.jsonl`);
  const records = readFileSync(ledgerFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(records.filter((record) => record.event === "tool_started").length, 1);
  assert.equal(records.at(-1).operationId, records[0].operationId);
  return { cwd, plan, source, storageRoot, request, attachment, attachmentFile, attachmentBytes, ledgerFile };
}

function writerPayloadCases() {
  return [
    ["create", (target) => ({ path: target })],
    ["edit", (target) => ({ path: target })],
    ["Write", (target) => ({ file_path: target })],
    ["create_file", (target) => ({ filePath: target })],
    ["str_replace_editor", (target) => ({ path: target })],
    ["insert", (target) => ({ path: target })],
    ["insert_edit_into_file", (target) => ({ filePath: target })],
    ["replace_string_in_file", (target) => ({ filePath: target })],
    ["multi_replace_string_in_file", (target) => ({ replacements: [{ filePath: target }] })],
    ["apply_patch", (target) => `*** Begin Patch\n*** Add File: ${target}\n+{}\n*** End Patch`],
    ["apply_patch", (target) => ({ patch: `*** Begin Patch\n*** Add File: ${target}\n+{}\n*** End Patch` })],
    ["apply_patch", (target) => ({ input: `*** Begin Patch\n*** Add File: ${target}\n+{}\n*** End Patch` })],
    ["apply_patch", (target) => ({ raw: `*** Begin Patch\n*** Add File: ${target}\n+{}\n*** End Patch` })],
    ["Edit", (target) => ({ input: `*** Begin Patch\n*** Add File: ${target}\n+{}\n*** End Patch` })],
  ];
}

test("plan validation rejects parked work without a resumption condition", () => {
  const errors = validatePlan({
    schemaVersion: 1,
    mode: "active",
    goal: "Drain queue",
    items: [{ id: "1", title: "Blocked item", status: "parked" }],
    completion: null,
  });
  assert.deepEqual(errors, ["items[0].resumeWhen is required when parked"]);
});

test("plan validation rejects conflicting records with the same provider id", () => {
  const errors = validatePlan({
    schemaVersion: 1,
    mode: "active",
    goal: "Drain queue",
    items: [
      { id: "issue-1", title: "Original", status: "banked" },
      { id: "issue-1", title: "Conflicting", status: "pending" },
    ],
    completion: null,
  });
  assert.deepEqual(errors, ["items[1].id duplicates an earlier item"]);
});

test("Stop hook is inert when no durable plan exists", () => {
  assert.deepEqual(handleHook(stopInput(workspace()), "Stop"), {});
});

test("Stop hook is inert for a session that did not write the active plan", () => {
  const cwd = workspace();
  writePlan(cwd);
  assert.deepEqual(handleHook(stopInput(cwd), "Stop"), {});
});

test("PreToolUse claims the first plan writer before the file exists", () => {
  const cwd = workspace();
  const input = {
    hook_event_name: "PreToolUse",
    session_id: "first-writer",
    cwd,
    tool_name: "Write",
    tool_input: { file_path: planPath(cwd) },
  };
  assert.deepEqual(handleHook(input, "PreToolUse"), {});
  writePlan(cwd);
  const stop = handleHook(
    { ...stopInput(cwd), session_id: "first-writer" },
    "Stop",
  );
  assert.equal(stop.decision, "block");
  assert.equal(stop.hookSpecificOutput.decision, "block");
});

test("an allowed ordinary Write durably starts before its side effect or terminal hook", () => {
  const cwd = workspace();
  const sessionId = "durable-start-owner";
  writePlan(cwd);
  attachPlan(cwd, sessionId);
  const attachment = JSON.parse(readFileSync(path.join(cwd, ".supervised-worker", "attachment.json")));
  assert.equal(attachment.status, "active");
  assert.equal(attachment.sessionHash, sha256(sessionId));
  const ledgerPath = path.join(cwd, ".supervised-worker", "runs", `${sha256(sessionId)}.jsonl`);
  const before = readFileSync(ledgerPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(before.some((record) => record.event === "tool_completed"));
  assert.equal(before.filter((record) => record.event === "tool_started").length, 0);
  const target = path.join(cwd, "ordinary.txt");
  const input = { cwd, session_id: sessionId, tool_name: "Write", tool_use_id: "host-invocation", tool_input: { file_path: target, content: "private-content-sentinel" } };
  assert.deepEqual(handleHook(input, "PreToolUse"), {});
  assert.equal(existsSync(target), false);
  const bytes = readFileSync(ledgerPath, "utf8");
  const starts = bytes.trim().split("\n").map(JSON.parse).filter((record) => record.event === "tool_started");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].claimGeneration, attachment.claimGeneration);
  assert.equal(starts[0].invocationHash, sha256("supervised-worker-tool-invocation-v1\0host-invocation"));
  assert.match(starts[0].operationId, /^[0-9a-f-]{36}$/);
  assert.equal(bytes.includes("private-content-sentinel"), false);
  assert.equal(bytes.includes("host-invocation"), false);
  assert.equal(summarizeRunLedger(cwd).status, "available");
});

test("terminal correlation is exact, duplicate-idempotent, and conservative for absent or reused IDs", () => {
  const cwd = workspace();
  const sessionId = "correlation-owner";
  writePlan(cwd);
  attachPlan(cwd, sessionId);
  const input = { cwd, session_id: sessionId, tool_name: "Read", toolUseId: "exact-host-id", tool_input: { path: "ignored" } };
  const ledgerPath = path.join(cwd, ".supervised-worker", "runs", `${sha256(sessionId)}.jsonl`);
  assert.deepEqual(handleHook(input, "PreToolUse"), {});
  assert.deepEqual(handleHook(input, "PostToolUse"), {});
  const firstBytes = readFileSync(ledgerPath);
  assert.deepEqual(handleHook(input, "PostToolUse"), {});
  assert.deepEqual(readFileSync(ledgerPath), firstBytes);
  const first = firstBytes.toString().trim().split("\n").map(JSON.parse);
  assert.equal(first.at(-1).operationId, first.find((record) => record.event === "tool_started").operationId);
  assert.deepEqual(handleHook(input, "PreToolUse"), {});
  assert.deepEqual(handleHook(input, "PostToolUseFailure"), {});
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8").trim().split("\n").at(-1)).operationId, null);
  const idless = { ...input, toolUseId: undefined };
  assert.deepEqual(handleHook(idless, "PreToolUse"), {});
  assert.deepEqual(handleHook(idless, "PostToolUse"), {});
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8").trim().split("\n").at(-1)).operationId, null);
  assert.equal(summarizeRunLedger(cwd).status, "available");
  const unrelated = workspace();
  assert.deepEqual(handleHook({ ...input, cwd: unrelated, session_id: "unrelated", tool_input: { path: planPath(cwd) } }, "PreToolUse"), {});
  assert.equal(existsSync(path.join(unrelated, ".supervised-worker")), false);
});

for (const routed of [false, true]) {
  test(`v3 claims preserve identity through promotion and renew it after release (routed=${routed})`, () => {
    const cwd = workspace();
    const sessionId = `claim-generation-${routed}`;
    const storageRoot = routed ? workspace() : null;
    const input = {
      cwd,
      session_id: sessionId,
      ...(routed ? { transcript_path: vscodeTranscriptPath(storageRoot, sessionId) } : {}),
      tool_name: "Write",
      tool_input: { file_path: planPath(cwd) },
    };
    const attachmentPath = path.join(cwd, ".supervised-worker", "attachment.json");
    assert.deepEqual(handleHook(input, "PreToolUse"), {});
    const provisional = JSON.parse(readFileSync(attachmentPath, "utf8"));
    assert.equal(provisional.schemaVersion, 3);
    assert.equal(provisional.status, "provisional");
    assert.match(provisional.claimGeneration, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.equal(provisional.checkpointHash, null);
    assert.equal(provisional.routeGeneration === null, !routed);

    writePlan(cwd);
    const planBytes = readFileSync(planPath(cwd));
    assert.deepEqual(handleHook(input, "PostToolUse"), {});
    const active = JSON.parse(readFileSync(attachmentPath, "utf8"));
    assert.equal(active.status, "active");
    assert.equal(active.claimGeneration, provisional.claimGeneration);
    assert.equal(active.routeGeneration, provisional.routeGeneration);
    assert.equal(releaseAttachment(realpathSync(cwd)).released, true);
    assert.deepEqual(handleHook(input, "PreToolUse"), {});
    const successor = JSON.parse(readFileSync(attachmentPath, "utf8"));
    assert.notEqual(successor.claimGeneration, active.claimGeneration);
    if (routed) assert.notEqual(successor.routeGeneration, active.routeGeneration);
    assert.deepEqual(readFileSync(planPath(cwd)), planBytes);
    assert.equal(handleHook({ ...input, stop_hook_active: false }, "Stop").decision, "block");
    assert.equal(JSON.parse(readFileSync(planPath(cwd), "utf8")).completion, null);
  });
}

for (const schemaVersion of [1, 2]) {
  test(`legacy v${schemaVersion} ownership remains readable without migration on SessionStart`, () => {
    const cwd = workspace();
    const sessionId = `legacy-owner-${schemaVersion}`;
    writePlan(cwd);
    const attachmentPath = path.join(cwd, ".supervised-worker", "attachment.json");
    const attachment = {
      schemaVersion,
      sessionHash: sha256(sessionId),
      attachedAt: "2026-09-04T00:00:00Z",
      ...(schemaVersion === 2 ? {
        status: "active",
        routeGeneration: null,
        updatedAt: "2026-09-04T00:00:00Z",
      } : {}),
    };
    const bytes = `${JSON.stringify(attachment)}\n`;
    writeFileSync(attachmentPath, bytes);
    const output = handleHook({ cwd, session_id: sessionId }, "SessionStart");
    assert.match(output.additionalContext, /"pending":1/);
    assert.equal(readFileSync(attachmentPath, "utf8"), bytes);
  });
}

test("a v3 checkpoint tombstone is neither ownership nor an ordinary plan-write claim", () => {
  const cwd = workspace();
  const sessionId = "checkpoint-source";
  writePlan(cwd);
  attachPlan(cwd, sessionId);
  const attachmentPath = path.join(cwd, ".supervised-worker", "attachment.json");
  const active = JSON.parse(readFileSync(attachmentPath, "utf8"));
  assert.equal(active.status, "active");
  const tombstone = { ...active, status: "checkpointed", checkpointHash: sha256("receipt") };
  const bytes = `${JSON.stringify(tombstone)}\n`;
  writeFileSync(attachmentPath, bytes);
  const planBytes = readFileSync(planPath(cwd));
  const ledgerBefore = summarizeRunLedger(cwd);

  for (const owner of [sessionId, "unrelated-fresh-session"]) {
    const input = { cwd, session_id: owner, tool_name: "Write" };
    assert.deepEqual(handleHook(input, "SessionStart"), {});
    assert.deepEqual(handleHook(input, "Stop"), {});
    const protectedEdit = handleHook({
      ...input,
      tool_input: { file_path: attachmentPath },
    }, "PreToolUse");
    assert.equal(protectedEdit.permissionDecision, "deny");
    const planEdit = handleHook({
      ...input,
      tool_input: { file_path: planPath(cwd) },
    }, "PreToolUse");
    assert.equal(planEdit.permissionDecision, "deny");
    assert.match(planEdit.permissionDecisionReason, /checkpointed/);
    const post = handleHook({
      ...input,
      tool_input: { file_path: planPath(cwd) },
    }, "PostToolUse");
    assert.ok(post.additionalContext);
  }
  assert.equal(readFileSync(attachmentPath, "utf8"), bytes);
  assert.deepEqual(readFileSync(planPath(cwd)), planBytes);
  assert.deepEqual(summarizeRunLedger(cwd), ledgerBefore);
});

test("invalid v3 claim and checkpoint bindings are denied without replacing attachment bytes", () => {
  const cwd = workspace();
  const sessionId = "invalid-v3-owner";
  writePlan(cwd);
  attachPlan(cwd, sessionId);
  const attachmentPath = path.join(cwd, ".supervised-worker", "attachment.json");
  const active = JSON.parse(readFileSync(attachmentPath, "utf8"));
  assert.equal(active.schemaVersion, 3);
  const variants = [
    { ...active, claimGeneration: null },
    { ...active, claimGeneration: "not-a-generation" },
    { ...active, checkpointHash: "not-a-hash" },
    { ...active, status: "checkpointed", checkpointHash: null },
    { ...active, unexpected: true },
  ];
  for (const value of variants) {
    const bytes = `${JSON.stringify(value)}\n`;
    writeFileSync(attachmentPath, bytes);
    const output = handleHook({
      cwd,
      session_id: sessionId,
      tool_name: "Write",
      tool_input: { file_path: planPath(cwd) },
    }, "PreToolUse");
    assert.equal(output.permissionDecision, "deny");
    assert.equal(readFileSync(attachmentPath, "utf8"), bytes);
  }
});

test("PreToolUse accepts a host cwd alias of the canonical target repository", () => {
  const repositoryRoot = workspace();
  const aliasParent = workspace();
  const alias = path.join(aliasParent, "repository-alias");
  symlinkSync(repositoryRoot, alias, process.platform === "win32" ? "junction" : "dir");
  const input = {
    hook_event_name: "PreToolUse",
    session_id: "host-cwd-alias",
    cwd: alias,
    tool_name: "Write",
    tool_input: { file_path: planPath(repositoryRoot) },
  };

  assert.deepEqual(handleHook(input, "PreToolUse"), {});
  assert.equal(existsSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json")), true);
});

test("VS Code plugin cwd routes targetless lifecycle hooks to the attached repository", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "vscode-routed-session";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const common = { session_id: sessionId, cwd: pluginRoot, transcript_path: transcriptPath };

  assert.deepEqual(
    handleHook(
      {
        ...common,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      },
      "PreToolUse",
    ),
    {},
  );
  assert.equal(existsSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json")), true);
  assert.equal(existsSync(path.join(pluginRoot, ".supervised-worker")), false);

  const locatorPath = sessionRoutePath(storageRoot, sessionId);
  const locatorText = readFileSync(locatorPath, "utf8");
  const locator = JSON.parse(locatorText);
  assert.equal(locator.repositoryRoot, realpathSync(repositoryRoot));
  assert.equal(locator.sessionHash, sha256(sessionId));
  assert.equal(locator.status, "provisional");
  assert.doesNotMatch(locatorText, new RegExp(sessionId));
  const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
  const provisionalAttachment = JSON.parse(readFileSync(attachmentPath, "utf8"));
  assert.equal(provisionalAttachment.status, "provisional");
  assert.equal(provisionalAttachment.routeGeneration, locator.generation);

  writePlan(repositoryRoot);
  handleHook(
    {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: planPath(repositoryRoot) },
    },
    "PostToolUse",
  );
  assert.equal(JSON.parse(readFileSync(locatorPath, "utf8")).status, "active");
  assert.equal(JSON.parse(readFileSync(attachmentPath, "utf8")).status, "active");
  const sessionStart = handleHook(
    { ...common, hook_event_name: "SessionStart" },
    "SessionStart",
  );
  assert.match(sessionStart.additionalContext, /"pending":1/);
  handleHook(
    {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "run_in_terminal",
      tool_input: { command: "not retained" },
    },
    "PostToolUse",
  );
  assert.equal(existsSync(path.join(repositoryRoot, ".supervised-worker", "runs")), true);
  assert.equal(handleHook({ ...common, hook_event_name: "Stop" }, "Stop").decision, "block");
  assert.equal(
    handleHook({ ...common, hook_event_name: "Stop", stop_hook_active: true }, "Stop").decision,
    "block",
  );
  assert.equal(
    handleHook({ ...common, hook_event_name: "Stop", stop_hook_active: true }, "Stop").decision,
    "allow",
  );
  const releasedRoute = JSON.parse(readFileSync(locatorPath, "utf8"));
  assert.equal(releasedRoute.status, "released");
  assert.equal(existsSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json")), false);
});

test("Stop visibly releases a provisional routed claim without a plan", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "provisional-stop-session";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const common = { session_id: sessionId, cwd: pluginRoot, transcript_path: transcriptPath };
  assert.deepEqual(
    handleHook(
      {
        ...common,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      },
      "PreToolUse",
    ),
    {},
  );

  const output = handleHook({ ...common, hook_event_name: "Stop" }, "Stop");
  assert.equal(output.decision, "allow");
  assert.match(output.systemMessage, /provisional claim/);
  assert.equal(
    JSON.parse(readFileSync(sessionRoutePath(storageRoot, sessionId), "utf8")).status,
    "released",
  );
  assert.equal(existsSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json")), false);
});

test("PostToolUseFailure releases a failed provisional plan claim", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "failed-plan-session";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const common = { session_id: sessionId, cwd: pluginRoot, transcript_path: transcriptPath };
  const tool = {
    tool_name: "Write",
    tool_input: { file_path: planPath(repositoryRoot) },
  };
  assert.deepEqual(
    handleHook({ ...common, ...tool, hook_event_name: "PreToolUse" }, "PreToolUse"),
    {},
  );
  assert.deepEqual(
    handleHook(
      { ...common, ...tool, hook_event_name: "PostToolUseFailure" },
      "PostToolUseFailure",
    ),
    {},
  );
  assert.equal(
    JSON.parse(readFileSync(sessionRoutePath(storageRoot, sessionId), "utf8")).status,
    "released",
  );
  assert.equal(existsSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json")), false);
});

test("PostToolUse without a materialized plan releases the provisional claim", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "missing-plan-post-tool";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const common = { session_id: sessionId, cwd: pluginRoot, transcript_path: transcriptPath };
  const tool = {
    tool_name: "Write",
    tool_input: { file_path: planPath(repositoryRoot) },
  };
  assert.deepEqual(
    handleHook({ ...common, ...tool, hook_event_name: "PreToolUse" }, "PreToolUse"),
    {},
  );
  const output = handleHook(
    { ...common, ...tool, hook_event_name: "PostToolUse" },
    "PostToolUse",
  );
  assert.match(output.additionalContext, /without materializing/);
  assert.equal(
    JSON.parse(readFileSync(sessionRoutePath(storageRoot, sessionId), "utf8")).status,
    "released",
  );
  assert.equal(existsSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json")), false);
  const runs = path.join(repositoryRoot, ".supervised-worker", "runs");
  const records = readdirSync(runs).flatMap((file) =>
    readFileSync(path.join(runs, file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
  const toolRecord = records.find((record) => record.event === "tool_completed");
  assert.equal(toolRecord.success, false);
  assert.equal(records.at(-1).event, "provisional_claim_released");
});

test("a released route reconciles its matching interrupted-release attachment", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "interrupted-release-session";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const common = { session_id: sessionId, cwd: pluginRoot, transcript_path: transcriptPath };
  const tool = {
    tool_name: "Write",
    tool_input: { file_path: planPath(repositoryRoot) },
  };
  assert.deepEqual(
    handleHook({ ...common, ...tool, hook_event_name: "PreToolUse" }, "PreToolUse"),
    {},
  );
  writePlan(repositoryRoot);
  handleHook({ ...common, ...tool, hook_event_name: "PostToolUse" }, "PostToolUse");
  const routePath = sessionRoutePath(storageRoot, sessionId);
  const route = JSON.parse(readFileSync(routePath, "utf8"));
  writeFileSync(
    routePath,
    `${JSON.stringify({ ...route, status: "released", updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  assert.deepEqual(handleHook({ ...common, hook_event_name: "SessionStart" }, "SessionStart"), {});
  assert.equal(existsSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json")), false);
  assert.equal(JSON.parse(readFileSync(routePath, "utf8")).status, "released");
});

test("a fresh session lock denies concurrent state mutation", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "busy-lock-session";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const lockDirectory = path.join(
    storageRoot,
    "supervised-worker",
    "session-locks",
    sha256(sessionId),
  );
  mkdirSync(lockDirectory, { recursive: true });
  writeFileSync(
    path.join(lockDirectory, "owner.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      token: "external-owner",
      processId: process.pid,
      acquiredAt: new Date().toISOString(),
    })}\n`,
  );
  const denied = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: pluginRoot,
      tool_name: "Write",
      tool_input: { file_path: planPath(repositoryRoot) },
    },
    "PreToolUse",
  );
  assert.equal(denied.permissionDecision, "deny");
  assert.equal(existsSync(path.join(repositoryRoot, ".supervised-worker")), false);
  assert.equal(existsSync(sessionRoutePath(storageRoot, sessionId)), false);
});

test("PostToolUse waits for a brief same-session lock overlap", async () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "brief-lock-overlap-session";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const common = { session_id: sessionId, cwd: pluginRoot, transcript_path: transcriptPath };
  const planTool = {
    tool_name: "Write",
    tool_input: { file_path: planPath(repositoryRoot) },
  };
  handleHook({ ...common, ...planTool, hook_event_name: "PreToolUse" }, "PreToolUse");
  writePlan(repositoryRoot);
  handleHook({ ...common, ...planTool, hook_event_name: "PostToolUse" }, "PostToolUse");

  const lockDirectory = path.join(
    storageRoot,
    "supervised-worker",
    "session-locks",
    sha256(sessionId),
  );
  mkdirSync(lockDirectory, { recursive: true });
  writeFileSync(
    path.join(lockDirectory, "owner.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      token: "brief-owner",
      processId: process.pid,
      acquiredAt: new Date().toISOString(),
    })}\n`,
  );
  const releaser = new Worker(
    `
      const { rmSync } = require("node:fs");
      const { parentPort, workerData } = require("node:worker_threads");
      parentPort.postMessage("ready");
      parentPort.once("message", () => {
        setTimeout(() => {
          rmSync(workerData, { recursive: true, force: true });
          parentPort.postMessage("released");
        }, 75);
      });
    `,
    { eval: true, workerData: lockDirectory },
  );
  await once(releaser, "message");
  releaser.postMessage("release");

  const started = performance.now();
  const output = handleHook(
    {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "read_file",
      tool_input: { filePath: path.join(repositoryRoot, "README.md") },
    },
    "PostToolUse",
  );
  const elapsed = performance.now() - started;
  assert.deepEqual(output, {});
  assert.ok(elapsed >= 40, `transient contention premise did not fire: ${elapsed}ms`);
  assert.ok(elapsed < 500, `transient contention exceeded its bound: ${elapsed}ms`);
  await once(releaser, "exit");
  assert.equal(existsSync(lockDirectory), false);

  const records = readFileSync(
    path.join(repositoryRoot, ".supervised-worker", "runs", `${sha256(sessionId)}.jsonl`),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.at(-1).event, "tool_completed");
  assert.equal(records.at(-1).toolName, "read_file");
  assert.equal(records.at(-1).success, true);
});

test("two PostToolUse contenders serialize after one brief owner", async () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "three-contender-session";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const common = { session_id: sessionId, cwd: pluginRoot, transcript_path: transcriptPath };
  const planTool = {
    tool_name: "Write",
    tool_input: { file_path: planPath(repositoryRoot) },
  };
  handleHook({ ...common, ...planTool, hook_event_name: "PreToolUse" }, "PreToolUse");
  writePlan(repositoryRoot);
  handleHook({ ...common, ...planTool, hook_event_name: "PostToolUse" }, "PostToolUse");

  const lockDirectory = path.join(
    storageRoot,
    "supervised-worker",
    "session-locks",
    sha256(sessionId),
  );
  mkdirSync(lockDirectory, { recursive: true });
  writeFileSync(path.join(lockDirectory, "brief-owner.json"), "{}\n");
  const input = {
    ...common,
    hook_event_name: "PostToolUse",
    tool_name: "read_file",
    tool_input: { filePath: path.join(repositoryRoot, "README.md") },
  };
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    parentPort.postMessage({ type: "ready" });
    parentPort.once("message", async () => {
      const { performance } = await import("node:perf_hooks");
      const { handleHook } = await import(workerData.coreUrl);
      const started = performance.now();
      const output = handleHook(workerData.input, "PostToolUse");
      parentPort.postMessage({ type: "result", output, elapsed: performance.now() - started });
      parentPort.close();
    });
  `;
  const contenders = [0, 1].map(() =>
    new Worker(workerSource, { eval: true, workerData: { coreUrl, input } }),
  );
  const exitPromises = contenders.map((worker) => once(worker, "exit"));
  try {
    await Promise.all(contenders.map(async (worker) => {
      const [message] = await once(worker, "message");
      assert.equal(message.type, "ready");
    }));
    const resultPromises = contenders.map(async (worker) => {
      const messagePromise = once(worker, "message");
      worker.postMessage("go");
      const [message] = await messagePromise;
      return message;
    });
    setTimeout(() => rmSync(lockDirectory, { recursive: true, force: true }), 75);
    const results = await Promise.all(resultPromises);
    for (const result of results) {
      assert.equal(result.type, "result");
      assert.deepEqual(result.output, {});
      assert.ok(result.elapsed >= 40, `contender did not observe the brief owner: ${result.elapsed}ms`);
      assert.ok(result.elapsed < 500, `contender exceeded the overlap bound: ${result.elapsed}ms`);
    }
    await Promise.all(exitPromises);
  } finally {
    await Promise.all(contenders.map((worker) => worker.terminate()));
  }
  assert.equal(existsSync(lockDirectory), false);
  const records = readFileSync(
    path.join(repositoryRoot, ".supervised-worker", "runs", `${sha256(sessionId)}.jsonl`),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    records.filter((record) => record.event === "tool_completed" && record.toolName === "read_file").length,
    2,
  );
});

for (const lockScope of ["session", "repository"]) {
  test(`a contended Stop cannot release active ownership without the ${lockScope} lock`, () => {
    const pluginRoot = workspace();
    const repositoryRoot = workspace();
    const storageRoot = workspace();
    const sessionId = `contended-stop-${lockScope}-session`;
    const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
    const common = { session_id: sessionId, cwd: pluginRoot, transcript_path: transcriptPath };
    const tool = {
      tool_name: "Write",
      tool_input: { file_path: planPath(repositoryRoot) },
    };
    handleHook({ ...common, ...tool, hook_event_name: "PreToolUse" }, "PreToolUse");
    writePlan(repositoryRoot);
    handleHook({ ...common, ...tool, hook_event_name: "PostToolUse" }, "PostToolUse");
    const routePath = sessionRoutePath(storageRoot, sessionId);
    const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
    const routeBefore = readFileSync(routePath, "utf8");
    const attachmentBefore = readFileSync(attachmentPath, "utf8");
    const lockDirectory = lockScope === "session"
      ? path.join(storageRoot, "supervised-worker", "session-locks", sha256(sessionId))
      : path.join(repositoryRoot, ".supervised-worker", "locks", "lifecycle");
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(
      path.join(lockDirectory, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        token: "external-owner",
        processId: process.pid,
        acquiredAt: new Date().toISOString(),
      })}\n`,
    );

    const output = handleHook({ ...common, hook_event_name: "Stop" }, "Stop");
    assert.equal(output.decision, "allow");
    assert.match(output.systemMessage, /LIFECYCLE_OWNER_MALFORMED/);
    assert.match(output.systemMessage, new RegExp(`"scope":"${lockScope}"`));
    assert.equal(readFileSync(routePath, "utf8"), routeBefore);
    assert.equal(readFileSync(attachmentPath, "utf8"), attachmentBefore);
    assert.equal(existsSync(lockDirectory), true);
  });
}

test("a routed attachment cannot mutate without its transcript context and lock", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "missing-context-session";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const common = { session_id: sessionId, cwd: pluginRoot, transcript_path: transcriptPath };
  const tool = {
    tool_name: "Write",
    tool_input: { file_path: planPath(repositoryRoot) },
  };
  handleHook({ ...common, ...tool, hook_event_name: "PreToolUse" }, "PreToolUse");
  writePlan(repositoryRoot);
  handleHook({ ...common, ...tool, hook_event_name: "PostToolUse" }, "PostToolUse");
  rmSync(planPath(repositoryRoot));
  const routePath = sessionRoutePath(storageRoot, sessionId);
  const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
  const routeBefore = readFileSync(routePath, "utf8");
  const attachmentBefore = readFileSync(attachmentPath, "utf8");

  const stop = handleHook(
    { hook_event_name: "Stop", session_id: sessionId, cwd: repositoryRoot },
    "Stop",
  );
  assert.equal(stop.decision, "allow");
  assert.match(stop.systemMessage, /could not verify its local state/);
  assert.equal(readFileSync(routePath, "utf8"), routeBefore);
  assert.equal(readFileSync(attachmentPath, "utf8"), attachmentBefore);

  const failure = handleHook(
    {
      hook_event_name: "PostToolUseFailure",
      session_id: sessionId,
      cwd: repositoryRoot,
      ...tool,
    },
    "PostToolUseFailure",
  );
  assert.match(failure.systemMessage, /could not verify its local state/);
  assert.equal(readFileSync(routePath, "utf8"), routeBefore);
  assert.equal(readFileSync(attachmentPath, "utf8"), attachmentBefore);
});

test("an expired session lock remains authoritative until explicit recovery", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "expired-lock-session";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const lockDirectory = path.join(
    storageRoot,
    "supervised-worker",
    "session-locks",
    sha256(sessionId),
  );
  mkdirSync(lockDirectory, { recursive: true });
  writeFileSync(
    path.join(lockDirectory, "owner.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      token: "expired-owner",
      processId: process.pid,
      acquiredAt: "2000-01-01T00:00:00Z",
    })}\n`,
  );
  const expired = new Date(Date.now() - 60_000);
  utimesSync(lockDirectory, expired, expired);

  const ownerBefore = readFileSync(path.join(lockDirectory, "owner.json"), "utf8");
  const output = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: pluginRoot,
      tool_name: "Write",
      tool_input: { file_path: planPath(repositoryRoot) },
    },
    "PreToolUse",
  );
  assert.equal(output.permissionDecision, "deny");
  assert.equal(readFileSync(path.join(lockDirectory, "owner.json"), "utf8"), ownerBefore);
  assert.equal(existsSync(sessionRoutePath(storageRoot, sessionId)), false);
  assert.equal(
    existsSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json")),
    false,
  );
});

test("plugin cwd routing rejects subst repository roots before claiming", {
  skip: process.platform !== "win32",
}, () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "subst-route-session";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const drive = [..."ZYXWVUTSRQPONMLKJIHGFED"].find((letter) => !existsSync(`${letter}:\\`));
  assert.ok(drive, "a free drive letter is required for the subst regression");
  execFileSync("subst.exe", [`${drive}:`, repositoryRoot]);
  try {
    const denied = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: `${drive}:\\.supervised-worker\\plan.json` },
      },
      "PreToolUse",
    );
    assert.equal(denied.permissionDecision, "deny");
    assert.equal(existsSync(path.join(repositoryRoot, ".supervised-worker")), false);
    assert.equal(existsSync(sessionRoutePath(storageRoot, sessionId)), false);
  } finally {
    execFileSync("subst.exe", [`${drive}:`, "/D"]);
  }
});

test("one VS Code session cannot bind durable plans in two repositories", () => {
  const pluginRoot = workspace();
  const firstRepository = workspace();
  const secondRepository = workspace();
  const storageRoot = workspace();
  const sessionId = "vscode-routing-conflict";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const input = {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    cwd: pluginRoot,
    transcript_path: transcriptPath,
    tool_name: "Write",
  };

  assert.deepEqual(
    handleHook({ ...input, tool_input: { file_path: planPath(firstRepository) } }, "PreToolUse"),
    {},
  );
  const denied = handleHook(
    { ...input, tool_input: { file_path: planPath(secondRepository) } },
    "PreToolUse",
  );
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /different repository/);
  assert.equal(existsSync(path.join(secondRepository, ".supervised-worker", "attachment.json")), false);
});

test("relative and cross-repository protected targets are denied as ambiguous", () => {
  const cwd = workspace();
  for (const target of [
    path.join(".supervised-worker", "plan.json"),
    path.join(".git", "config"),
    path.join(".github", "supervised-worker.json"),
  ]) {
    const denied = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "ambiguous-routing",
        cwd,
        tool_name: "Write",
        tool_input: { file_path: target },
      },
      "PreToolUse",
    );
    assert.equal(denied.permissionDecision, "deny", target);
  }

  const other = workspace();
  const denied = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "cross-repository-routing",
      cwd,
      tool_name: "multi_replace_string_in_file",
      tool_input: {
        replacements: [
          { filePath: planPath(cwd) },
          { filePath: planPath(other) },
        ],
      },
    },
    "PreToolUse",
  );
  assert.equal(denied.permissionDecision, "deny");
});

test("plugin cwd routing denies canonical and Windows-normalized protected aliases", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  mkdirSync(path.join(repositoryRoot, ".git"), { recursive: true });
  writeFileSync(path.join(repositoryRoot, ".git", "config"), "protected\n");
  writePlan(repositoryRoot);
  attachPlan(repositoryRoot, "owner-session");
  mkdirSync(path.join(repositoryRoot, ".github"), { recursive: true });
  writeFileSync(path.join(repositoryRoot, ".github", "supervised-worker.json"), "{}\n");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const gitAlias = path.join(repositoryRoot, "git-alias");
  const stateAlias = path.join(repositoryRoot, "state-alias");
  symlinkSync(path.join(repositoryRoot, ".git"), gitAlias, linkType);
  symlinkSync(path.join(repositoryRoot, ".supervised-worker"), stateAlias, linkType);
  const targets = [
    path.join(gitAlias, "config"),
    path.join(stateAlias, "plan.json"),
    ...(process.platform === "win32"
      ? [
          path.join(repositoryRoot, ".git.", "config"),
          path.join(repositoryRoot, ".supervised-worker.", "plan.json"),
          path.join(repositoryRoot, ".github.", "supervised-worker.json"),
        ]
      : []),
  ];

  for (const target of targets) {
    const denied = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "companion-session",
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: target },
      },
      "PreToolUse",
    );
    assert.equal(denied.permissionDecision, "deny", target);
  }
});

test("cross-directory plan claims require a regular transcript anchor", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "invalid-transcript-anchor";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const input = {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    cwd: pluginRoot,
    transcript_path: transcriptPath,
    tool_name: "Write",
    tool_input: { file_path: planPath(repositoryRoot) },
  };

  rmSync(transcriptPath);
  let denied = handleHook(input, "PreToolUse");
  assert.equal(denied.permissionDecision, "deny");
  assert.equal(existsSync(path.join(repositoryRoot, ".supervised-worker")), false);

  if (process.platform === "win32") {
    const transcriptDirectory = path.dirname(transcriptPath);
    const realTranscriptDirectory = path.join(storageRoot, "real-transcripts");
    rmSync(transcriptDirectory, { recursive: true });
    mkdirSync(realTranscriptDirectory);
    writeFileSync(path.join(realTranscriptDirectory, `${sessionId}.jsonl`), "");
    symlinkSync(realTranscriptDirectory, transcriptDirectory, "junction");
  } else {
    const realTranscript = path.join(storageRoot, "real-transcript.jsonl");
    writeFileSync(realTranscript, "");
    symlinkSync(realTranscript, transcriptPath, "file");
  }
  denied = handleHook(input, "PreToolUse");
  assert.equal(denied.permissionDecision, "deny");
  assert.equal(existsSync(path.join(repositoryRoot, ".supervised-worker")), false);
  assert.equal(existsSync(sessionRoutePath(storageRoot, sessionId)), false);
});

test("failed target-state initialization publishes no claim or route and permits reclaim", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "state-initialization-failure";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const statePath = path.join(repositoryRoot, ".supervised-worker");
  writeFileSync(statePath, "not a directory\n");
  const input = {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    cwd: pluginRoot,
    transcript_path: transcriptPath,
    tool_name: "Write",
    tool_input: { file_path: planPath(repositoryRoot) },
  };

  const denied = handleHook(input, "PreToolUse");
  assert.equal(denied.permissionDecision, "deny");
  assert.equal(existsSync(sessionRoutePath(storageRoot, sessionId)), false);
  assert.equal(existsSync(path.join(statePath, "attachment.json")), false);
  assert.equal(readFileSync(statePath, "utf8"), "not a directory\n");

  rmSync(statePath);
  assert.deepEqual(handleHook(input, "PreToolUse"), {});
  const reclaimed = JSON.parse(readFileSync(sessionRoutePath(storageRoot, sessionId), "utf8"));
  assert.equal(reclaimed.status, "provisional");
  assert.equal(reclaimed.sessionHash, sha256(sessionId));
  const attachment = JSON.parse(readFileSync(path.join(statePath, "attachment.json"), "utf8"));
  assert.equal(attachment.status, "provisional");
  assert.equal(attachment.sessionHash, reclaimed.sessionHash);
  assert.equal(attachment.routeGeneration, reclaimed.generation);
});

test("a routed plan claim migrates a matching v1 attachment", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "legacy-attachment-session";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  writePlan(repositoryRoot);
  writeFileSync(
    path.join(repositoryRoot, ".supervised-worker", "attachment.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      sessionHash: sha256(sessionId),
      attachedAt: "2026-09-01T00:00:00Z",
    }, null, 2)}\n`,
  );
  const common = { session_id: sessionId, cwd: pluginRoot, transcript_path: transcriptPath };
  const decision = handleHook(
    {
      ...common,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: planPath(repositoryRoot) },
    },
    "PreToolUse",
  );
  assert.deepEqual(decision, {});
  const route = JSON.parse(readFileSync(sessionRoutePath(storageRoot, sessionId), "utf8"));
  const attachment = JSON.parse(
    readFileSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json"), "utf8"),
  );
  assert.equal(route.status, "active");
  assert.equal(attachment.schemaVersion, 3);
  assert.equal(attachment.status, "active");
  assert.equal(attachment.sessionHash, sha256(sessionId));
  assert.equal(route.sessionHash, attachment.sessionHash);
  assert.equal(attachment.routeGeneration, route.generation);
  assert.match(attachment.claimGeneration, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(attachment.claimGeneration, route.generation);
  assert.equal(attachment.checkpointHash, null);
  assert.equal(handleHook({ ...common, hook_event_name: "Stop" }, "Stop").decision, "block");
});

test("a bound VS Code session with a missing locator fails visibly", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "stale-vscode-locator";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const common = { session_id: sessionId, cwd: pluginRoot, transcript_path: transcriptPath };
  assert.deepEqual(
    handleHook(
      {
        ...common,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      },
      "PreToolUse",
    ),
    {},
  );
  rmSync(sessionRoutePath(storageRoot, sessionId));

  const output = handleHook({ ...common, hook_event_name: "Stop" }, "Stop");
  assert.equal(output.decision, "allow");
  assert.match(output.systemMessage, /could not verify its local state/);
  assert.equal(existsSync(path.join(pluginRoot, ".supervised-worker")), false);
  assert.equal(existsSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json")), true);
});

test("a bound VS Code session with a missing route directory fails visibly", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "missing-route-directory";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const common = { session_id: sessionId, cwd: pluginRoot, transcript_path: transcriptPath };
  assert.deepEqual(
    handleHook(
      {
        ...common,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      },
      "PreToolUse",
    ),
    {},
  );
  assert.equal(existsSync(sessionMarkerPath(storageRoot, sessionId)), true);
  rmSync(path.dirname(sessionRoutePath(storageRoot, sessionId)), {
    recursive: true,
    force: true,
  });

  const output = handleHook({ ...common, hook_event_name: "Stop" }, "Stop");
  assert.equal(output.decision, "allow");
  assert.match(output.systemMessage, /could not verify its local state/);
  assert.equal(existsSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json")), true);
});

test("missing binding marker is restored before subsequent route loss", () => {
  const pluginRoot = workspace();
  const repositoryRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "missing-binding-marker";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const common = { session_id: sessionId, cwd: pluginRoot, transcript_path: transcriptPath };
  const tool = {
    tool_name: "Write",
    tool_input: { file_path: planPath(repositoryRoot) },
  };
  handleHook({ ...common, ...tool, hook_event_name: "PreToolUse" }, "PreToolUse");
  writePlan(repositoryRoot);
  handleHook({ ...common, ...tool, hook_event_name: "PostToolUse" }, "PostToolUse");
  const routePath = sessionRoutePath(storageRoot, sessionId);
  const markerPath = sessionMarkerPath(storageRoot, sessionId);
  const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
  const attachmentBefore = readFileSync(attachmentPath, "utf8");
  rmSync(markerPath);

  const markerLoss = handleHook(
    { ...common, hook_event_name: "Stop", cwd: repositoryRoot },
    "Stop",
  );
  assert.equal(markerLoss.decision, "allow");
  assert.match(markerLoss.systemMessage, /could not verify its local state/);
  assert.equal(existsSync(markerPath), true);
  assert.equal(readFileSync(attachmentPath, "utf8"), attachmentBefore);

  rmSync(path.dirname(routePath), { recursive: true, force: true });
  const routeLoss = handleHook({ ...common, hook_event_name: "Stop" }, "Stop");
  assert.equal(routeLoss.decision, "allow");
  assert.match(routeLoss.systemMessage, /could not verify its local state/);
  assert.equal(readFileSync(attachmentPath, "utf8"), attachmentBefore);
});

test("a never-bound VS Code session remains inert with a valid transcript context", () => {
  const pluginRoot = workspace();
  const storageRoot = workspace();
  const sessionId = "never-bound-vscode-session";
  const transcriptPath = vscodeTranscriptPath(storageRoot, sessionId);
  const output = handleHook(
    {
      hook_event_name: "Stop",
      session_id: sessionId,
      cwd: pluginRoot,
      transcript_path: transcriptPath,
    },
    "Stop",
  );
  assert.deepEqual(output, {});
  assert.equal(existsSync(sessionMarkerPath(storageRoot, sessionId)), false);
});

test("PreToolUse denies a plan write without a session identifier", () => {
  const cwd = workspace();
  const output = handleHook(
    {
      hook_event_name: "PreToolUse",
      cwd,
      tool_name: "Write",
      tool_input: { file_path: planPath(cwd) },
    },
    "PreToolUse",
  );
  assert.equal(output.permissionDecision, "deny");
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /no session identifier/);
  assert.equal(existsSync(path.join(cwd, ".supervised-worker", "attachment.json")), false);
});

test("only the attached session may edit durable handoff state", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd, "owner-session");
  const handoffPath = path.join(
    cwd,
    ".supervised-worker",
    "handoffs",
    "a".repeat(64),
    "build-contract.json",
  );

  assert.deepEqual(
    handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "owner-session",
        cwd,
        tool_name: "Write",
        tool_input: { file_path: handoffPath },
      },
      "PreToolUse",
    ),
    {},
  );
  const denied = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "companion-session",
      cwd,
      tool_name: "Write",
      tool_input: { file_path: handoffPath },
    },
    "PreToolUse",
  );
  assert.equal(denied.permissionDecision, "deny");
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /Only the session attached/);
});

test("PreToolUse denies direct edits to Git metadata", () => {
  const cwd = workspace();
  const output = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "writer-session",
      cwd,
      tool_name: "Edit",
      tool_input: {
        input: `*** Begin Patch\n*** Update File: ${path.join(cwd, ".git", "config")}\n-old\n+new\n*** End Patch`,
      },
    },
    "PreToolUse",
  );
  assert.equal(output.permissionDecision, "deny");
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /Git metadata/);
});

test("PreToolUse denies Windows-canonicalized Git metadata aliases", {
  skip: process.platform !== "win32",
}, () => {
  const cwd = workspace();
  const output = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "writer-session",
      cwd,
      tool_name: "Write",
      tool_input: { file_path: path.join(cwd, ".git.", "config") },
    },
    "PreToolUse",
  );
  assert.equal(output.permissionDecision, "deny");
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

test("PreToolUse denies junction aliases to Git metadata and durable state", () => {
  const cwd = workspace();
  mkdirSync(path.join(cwd, ".git"), { recursive: true });
  writePlan(cwd);
  attachPlan(cwd, "owner-session");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const gitAlias = path.join(cwd, "git-alias");
  const stateAlias = path.join(cwd, "state-alias");
  symlinkSync(path.join(cwd, ".git"), gitAlias, linkType);
  symlinkSync(path.join(cwd, ".supervised-worker"), stateAlias, linkType);

  const gitDenied = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "companion-session",
      cwd,
      tool_name: "Write",
      tool_input: { file_path: path.join(gitAlias, "config") },
    },
    "PreToolUse",
  );
  assert.equal(gitDenied.permissionDecision, "deny");
  assert.match(gitDenied.permissionDecisionReason, /resolved safely|Git metadata/);

  const stateDenied = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "companion-session",
      cwd,
      tool_name: "Write",
      tool_input: { file_path: path.join(stateAlias, "handoffs", "x.json") },
    },
    "PreToolUse",
  );
  assert.equal(stateDenied.permissionDecision, "deny");
  assert.match(stateDenied.permissionDecisionReason, /resolved safely|Only the session attached/);
});

test("PreToolUse denies Windows device-namespace edit targets", {
  skip: process.platform !== "win32",
}, () => {
  const cwd = workspace();
  const namespacedPath = `\\\\?\\${path.join(cwd, ".git", "config")}`;
  const output = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "writer-session",
      cwd,
      tool_name: "Write",
      tool_input: { file_path: namespacedPath },
    },
    "PreToolUse",
  );
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /could not be resolved safely/);
});

test("PreToolUse denies hard-link aliases across every writer payload", () => {
  const cwd = workspace();
  const gitDirectory = path.join(cwd, ".git");
  mkdirSync(gitDirectory, { recursive: true });
  const protectedFile = path.join(gitDirectory, "config");
  writeFileSync(protectedFile, "protected\n");

  for (const [index, [toolName, makeInput]] of writerPayloadCases().entries()) {
    const alias = path.join(cwd, `hard-link-${index}.txt`);
    linkSync(protectedFile, alias);
    const output = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "companion-session",
        cwd,
        tool_name: toolName,
        tool_input: makeInput(alias),
      },
      "PreToolUse",
    );
    assert.equal(output.permissionDecision, "deny", toolName);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny", toolName);
    assert.match(output.permissionDecisionReason, /resolved safely/, toolName);
  }
});

test("PreToolUse denies a hard-link alias to durable plan state", () => {
  const cwd = workspace();
  writePlan(cwd);
  const alias = path.join(cwd, "plan-alias.json");
  linkSync(planPath(cwd), alias);
  const output = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "companion-session",
      cwd,
      tool_name: "Write",
      tool_input: { file_path: alias },
    },
    "PreToolUse",
  );
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /resolved safely/);
});

test("PreToolUse denies subst-drive aliases to protected roots", () => {
  if (process.platform !== "win32") return;
  const cwd = workspace();
  mkdirSync(path.join(cwd, ".git"), { recursive: true });
  writeFileSync(path.join(cwd, ".git", "config"), "protected\n");
  writePlan(cwd);
  const drive = [..."ZYXWVUTSRQPONMLKJIHGFED"].find((letter) => !existsSync(`${letter}:\\`));
  assert.ok(drive, "a free drive letter is required for the subst regression");
  execFileSync("subst.exe", [`${drive}:`, cwd]);
  try {
    for (const target of [`${drive}:\\.git\\config`, `${drive}:\\.supervised-worker\\plan.json`]) {
      const output = handleHook(
        {
          hook_event_name: "PreToolUse",
          session_id: "companion-session",
          cwd,
          tool_name: "Write",
          tool_input: { file_path: target },
        },
        "PreToolUse",
      );
      assert.equal(output.permissionDecision, "deny", target);
    }
  } finally {
    execFileSync("subst.exe", [`${drive}:`, "/D"]);
    assert.equal(existsSync(`${drive}:\\`), false);
  }
});

test("PreToolUse denies actual linked-worktree Git directories", () => {
  const repository = workspace();
  const worktree = workspace();
  rmSync(worktree, { recursive: true, force: true });
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
  temporaryWorkspaces.add(worktree);

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
    const output = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "companion-session",
        cwd: worktree,
        tool_name: "Write",
        tool_input: { file_path: target },
      },
      "PreToolUse",
    );
    assert.equal(output.permissionDecision, "deny", target);
    assert.match(output.permissionDecisionReason, /Git metadata/, target);
  }
});

test("PreToolUse remains inert for ordinary source edits", () => {
  const cwd = workspace();
  assert.deepEqual(
    handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "writer-session",
        cwd,
        tool_name: "Write",
        tool_input: { file_path: path.join(cwd, "src", "module.js") },
      },
      "PreToolUse",
    ),
    {},
  );
});

test("PostToolUse reports an ungoverned plan write without a session identifier", () => {
  const cwd = workspace();
  writePlan(cwd);
  const output = handleHook(
    {
      hook_event_name: "PostToolUse",
      cwd,
      tool_name: "Write",
      tool_input: { file_path: planPath(cwd) },
    },
    "PostToolUse",
  );
  assert.match(output.additionalContext, /could not attach/);
  assert.equal(output.additionalContext, output.hookSpecificOutput.additionalContext);
  assert.equal(existsSync(path.join(cwd, ".supervised-worker", "attachment.json")), false);
});

test("Stop hook blocks attached incomplete work twice then releases visibly", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd);

  const first = handleHook(stopInput(cwd), "Stop");
  const second = handleHook(stopInput(cwd, true), "Stop");
  const third = handleHook(stopInput(cwd, true), "Stop");

  assert.equal(first.decision, "block");
  assert.equal(first.hookSpecificOutput.decision, "block");
  assert.equal(second.decision, "block");
  assert.equal(second.hookSpecificOutput.decision, "block");
  assert.match(second.reason, /final bounded continuation/);
  assert.equal(second.reason, second.hookSpecificOutput.reason);
  assert.equal(third.decision, "allow");
  assert.equal(third.hookSpecificOutput.decision, "allow");
  assert.match(third.systemMessage, /bounded retry limit/);
  assert.equal(existsSync(path.join(cwd, ".supervised-worker", "attachment.json")), false);
  const records = readdirSync(path.join(cwd, ".supervised-worker", "runs"))
    .flatMap((file) =>
      readFileSync(path.join(cwd, ".supervised-worker", "runs", file), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  assert.equal(records.at(-1).event, "completion_unverified_release");
  assert.equal(records.at(-1).reason, "bounded_stop_limit");
});

test("Stop hook remains attached across more than six progressing continuations", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd);

  for (let index = 0; index < 8; index += 1) {
    if (index > 0) {
      writePlan(cwd, {
        items: [{ id: `issue-${index}`, title: `Issue ${index}`, status: "pending" }],
      });
    }
    const output = handleHook(stopInput(cwd, index > 0), "Stop");
    assert.equal(output.decision, "block", `progress epoch ${index}`);
    assert.equal(
      existsSync(path.join(cwd, ".supervised-worker", "attachment.json")),
      true,
      `progress epoch ${index}`,
    );
  }

  const runtime = JSON.parse(
    readFileSync(
      path.join(
        cwd,
        ".supervised-worker",
        "runtime",
        `${sha256("11111111-1111-4111-8111-111111111111")}.json`,
      ),
      "utf8",
    ),
  );
  assert.equal(runtime.schemaVersion, 2);
  assert.equal(runtime.totalBlocks, 8);
  assert.equal(runtime.sameProgressBlocks, 1);

  const finalBlock = handleHook(stopInput(cwd, true), "Stop");
  assert.equal(finalBlock.decision, "block");
  assert.match(finalBlock.reason, /final bounded continuation/);
  const released = handleHook(stopInput(cwd, true), "Stop");
  assert.equal(released.decision, "allow");
  assert.match(released.systemMessage, /bounded retry limit/);
});

test("Stop hook ignores valid plan object-key insertion order", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd);

  const first = handleHook(stopInput(cwd), "Stop");
  assert.equal(first.decision, "block");
  writeFileSync(
    planPath(cwd),
    `${JSON.stringify({
      completion: null,
      items: [{ status: "pending", title: "First issue", id: "issue-1" }],
      goal: "Complete the selected queue.",
      mode: "active",
      schemaVersion: 1,
    }, null, 2)}\n`,
  );
  const second = handleHook(stopInput(cwd, true), "Stop");
  assert.equal(second.decision, "block");
  assert.match(second.reason, /final bounded continuation/);
  writePlan(cwd);
  const third = handleHook(stopInput(cwd, true), "Stop");
  assert.equal(third.decision, "allow");
  assert.match(third.systemMessage, /bounded retry limit/);
});

test("Stop hook does not treat changing invalid plan bytes as progress", () => {
  const cwd = workspace();
  writePlan(cwd, { unexpectedNonce: 1 });
  attachPlan(cwd);

  const first = handleHook(stopInput(cwd), "Stop");
  assert.equal(first.decision, "block");
  writePlan(cwd, { unexpectedNonce: 2 });
  const second = handleHook(stopInput(cwd, true), "Stop");
  assert.equal(second.decision, "block");
  assert.match(second.reason, /final bounded continuation/);
  writePlan(cwd, { unexpectedNonce: 3 });
  const third = handleHook(stopInput(cwd, true), "Stop");
  assert.equal(third.decision, "allow");
  assert.match(third.systemMessage, /bounded retry limit/);
});

test("Stop hook preserves valid legacy counters while migrating the hash", () => {
  const cwd = workspace();
  const plan = writePlan(cwd);
  attachPlan(cwd);
  const runtime = path.join(
    cwd,
    ".supervised-worker",
    "runtime",
    `${sha256("11111111-1111-4111-8111-111111111111")}.json`,
  );
  mkdirSync(path.dirname(runtime), { recursive: true });
  writeFileSync(runtime, JSON.stringify({
    schemaVersion: 1,
    progressHash: sha256(JSON.stringify(plan)),
    sameProgressBlocks: 1,
    totalBlocks: 1,
  }));

  const migratedBlock = handleHook(stopInput(cwd, true), "Stop");
  assert.equal(migratedBlock.decision, "block");
  assert.match(migratedBlock.reason, /final bounded continuation/);
  const migrated = JSON.parse(readFileSync(runtime, "utf8"));
  assert.equal(migrated.schemaVersion, 2);
  assert.notEqual(migrated.progressHash, sha256(JSON.stringify(plan)));
  assert.equal(migrated.sameProgressBlocks, 2);
  assert.equal(migrated.totalBlocks, 2);
  const released = handleHook(stopInput(cwd, true), "Stop");
  assert.equal(released.decision, "allow");
  assert.match(released.systemMessage, /bounded retry limit/);
});

test("Stop hook preserves invalid legacy counters while migrating the hash", () => {
  const cwd = workspace();
  const plan = writePlan(cwd, { unexpectedNonce: 1 });
  attachPlan(cwd);
  const runtime = path.join(
    cwd,
    ".supervised-worker",
    "runtime",
    `${sha256("11111111-1111-4111-8111-111111111111")}.json`,
  );
  mkdirSync(path.dirname(runtime), { recursive: true });
  writeFileSync(runtime, JSON.stringify({
    schemaVersion: 1,
    progressHash: sha256(JSON.stringify(plan)),
    sameProgressBlocks: 1,
    totalBlocks: 1,
  }));

  const migratedBlock = handleHook(stopInput(cwd, true), "Stop");
  assert.equal(migratedBlock.decision, "block");
  assert.match(migratedBlock.reason, /final bounded continuation/);
  const migrated = JSON.parse(readFileSync(runtime, "utf8"));
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.progressHash, sha256("invalid-plan"));
  assert.equal(migrated.sameProgressBlocks, 2);
  assert.equal(migrated.totalBlocks, 2);
  const released = handleHook(stopInput(cwd, true), "Stop");
  assert.equal(released.decision, "allow");
  assert.match(released.systemMessage, /bounded retry limit/);
});

test("legacy hash mismatch resets counters even when it equals the canonical hash", () => {
  const cwd = workspace();
  const canonicalOrderPlan = {
    completion: null,
    goal: "Complete the selected queue.",
    items: [{ id: "issue-1", status: "pending", title: "First issue" }],
    mode: "active",
    schemaVersion: 1,
  };
  mkdirSync(path.dirname(planPath(cwd)), { recursive: true });
  writeFileSync(planPath(cwd), `${JSON.stringify(canonicalOrderPlan, null, 2)}\n`);
  attachPlan(cwd);
  const legacyHash = sha256(JSON.stringify(canonicalOrderPlan));

  const reorderedPlan = {
    schemaVersion: 1,
    mode: "active",
    goal: "Complete the selected queue.",
    items: [{ title: "First issue", status: "pending", id: "issue-1" }],
    completion: null,
  };
  assert.notEqual(sha256(JSON.stringify(reorderedPlan)), legacyHash);
  writeFileSync(planPath(cwd), `${JSON.stringify(reorderedPlan, null, 2)}\n`);
  const runtime = path.join(
    cwd,
    ".supervised-worker",
    "runtime",
    `${sha256("11111111-1111-4111-8111-111111111111")}.json`,
  );
  mkdirSync(path.dirname(runtime), { recursive: true });
  writeFileSync(runtime, JSON.stringify({
    schemaVersion: 1,
    progressHash: legacyHash,
    sameProgressBlocks: 2,
    totalBlocks: 2,
  }));

  const output = handleHook(stopInput(cwd, true), "Stop");
  assert.equal(output.decision, "block");
  assert.doesNotMatch(output.reason, /final bounded continuation/);
  const migrated = JSON.parse(readFileSync(runtime, "utf8"));
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.sameProgressBlocks, 1);
  assert.equal(migrated.totalBlocks, 3);
  assert.equal(migrated.progressHash, legacyHash);
});

test("Stop hook treats valid item-array reordering as a changed state", () => {
  const cwd = workspace();
  writePlan(cwd, {
    items: [
      { id: "issue-1", title: "First issue", status: "pending" },
      { id: "issue-2", title: "Second issue", status: "pending" },
    ],
  });
  attachPlan(cwd);
  assert.equal(handleHook(stopInput(cwd), "Stop").decision, "block");
  const runtime = path.join(
    cwd,
    ".supervised-worker",
    "runtime",
    `${sha256("11111111-1111-4111-8111-111111111111")}.json`,
  );
  const firstHash = JSON.parse(readFileSync(runtime, "utf8")).progressHash;

  writePlan(cwd, {
    items: [
      { id: "issue-2", title: "Second issue", status: "pending" },
      { id: "issue-1", title: "First issue", status: "pending" },
    ],
  });
  const output = handleHook(stopInput(cwd, true), "Stop");
  assert.equal(output.decision, "block");
  assert.doesNotMatch(output.reason, /final bounded continuation/);
  const migrated = JSON.parse(readFileSync(runtime, "utf8"));
  assert.notEqual(migrated.progressHash, firstHash);
  assert.equal(migrated.sameProgressBlocks, 1);
});

test("complete plan audit hashes ignore object-key insertion order", () => {
  const hashes = [];
  for (const reverseKeys of [false, true]) {
    const cwd = workspace();
    const completion = {
      enumeration: {
        status: "complete",
        source: "Authenticated provider",
        checkedAt: "2026-09-01T00:00:00Z",
        remainingActionable: 0,
      },
      evidence: [{ kind: "test", locator: "receipt.json" }],
    };
    const plan = reverseKeys
      ? {
          completion: {
            evidence: [{ locator: "receipt.json", kind: "test" }],
            enumeration: {
              remainingActionable: 0,
              checkedAt: "2026-09-01T00:00:00Z",
              source: "Authenticated provider",
              status: "complete",
            },
          },
          items: [{ status: "banked", title: "First issue", id: "issue-1" }],
          goal: "Complete the selected queue.",
          mode: "complete",
          schemaVersion: 1,
        }
      : {
          schemaVersion: 1,
          mode: "complete",
          goal: "Complete the selected queue.",
          items: [{ id: "issue-1", title: "First issue", status: "banked" }],
          completion,
        };
    mkdirSync(path.dirname(planPath(cwd)), { recursive: true });
    writeFileSync(planPath(cwd), `${JSON.stringify(plan, null, 2)}\n`);
    attachPlan(cwd);
    assert.deepEqual(handleHook(stopInput(cwd), "Stop"), {});
    const records = readdirSync(path.join(cwd, ".supervised-worker", "runs"))
      .flatMap((file) =>
        readFileSync(path.join(cwd, ".supervised-worker", "runs", file), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
    const emittedHash = records.find((record) => record.event === "completion_verified").planHash;
    assert.equal(emittedHash, canonicalPlanHash(plan));
    hashes.push(emittedHash);
  }
  assert.equal(hashes[0], hashes[1]);
});

for (const routed of [false, true]) {
  test(`checkpoint and explicit fresh resume preserve incomplete work and Stop governance (routed=${routed})`, () => {
    const fixture = checkpointFixture(routed);
    const { cwd, source, request, attachment, attachmentFile, storageRoot } = fixture;
    const planBytes = readFileSync(planPath(cwd));
    const handoffFile = path.join(cwd, ".supervised-worker", "handoffs", sha256("private-item-one"), "build-report.json");
    mkdirSync(path.dirname(handoffFile), { recursive: true });
    writeFileSync(handoffFile, "PRIVATE_EXISTING_HANDOFF\n");
    assert.equal(handleHook({ ...source, stop_hook_active: false }, "Stop").decision, "block");
    const enclosingTool = { ...source, tool_name: "Bash", tool_use_id: "checkpoint-command", tool_input: { command: "PRIVATE_COMMAND" } };
    assert.deepEqual(handleHook(enclosingTool, "PreToolUse"), {});
    const checkpoint = checkpointSession(cwd, request);
    assert.equal(checkpoint.status, "checkpointed");
    const receiptFile = path.join(cwd, ".supervised-worker", "checkpoints", `${checkpoint.checkpointHash}.json`);
    const receiptBytes = readFileSync(receiptFile);
    const receipt = JSON.parse(receiptBytes);
    assert.equal(sha256(receiptBytes), checkpoint.checkpointHash);
    assert.deepEqual(validateCheckpoint(receipt), []);
    assert.equal(receipt.attachmentHash, request.attachmentHash);
    assert.equal(receipt.claimGeneration, attachment.claimGeneration);
    assert.equal(receipt.context.stopState.sameProgressBlocks, 1);
    assert.deepEqual(receipt.context.itemHashes, fixture.plan.items.map((item) => sha256(item.id)));
    assert.equal(receipt.context.operations.orphans.length, 1);
    assert.equal(receipt.context.operations.orphans[0].observationStatus, "outcome-unknown");
    assert.equal(receipt.context.operations.orphans[0].toolName, "Bash");
    assert.doesNotMatch(receiptBytes.toString(), /PRIVATE_|private-item|checkpoint-command/);
    assert.equal(JSON.parse(readFileSync(attachmentFile)).status, "checkpointed");
    if (routed) assert.equal(JSON.parse(readFileSync(sessionRoutePath(storageRoot, source.session_id))).status, "released");
    assert.deepEqual(handleHook(source, "SessionStart"), {});
    assert.deepEqual(handleHook(source, "Stop"), {});
    assert.deepEqual(handleHook(enclosingTool, "PostToolUse"), {});
    const nextId = `checkpoint-successor-${routed}`;
    const next = { cwd, session_id: nextId, ...(routed ? { transcript_path: vscodeTranscriptPath(storageRoot, nextId) } : {}) };
    const tombstoneBytes = readFileSync(attachmentFile);
    assert.deepEqual(handleHook(next, "SessionStart"), {});
    assert.deepEqual(readFileSync(attachmentFile), tombstoneBytes);
    assert.equal(handleHook({ ...next, tool_name: "Write", tool_input: { file_path: planPath(cwd) } }, "PreToolUse").permissionDecision, "deny");
    const nextRequest = { session_id: nextId, ...(routed ? { transcript_path: next.transcript_path } : {}), planHash: request.planHash, checkpointHash: checkpoint.checkpointHash };
    const resumed = resumeSession(cwd, nextRequest);
    assert.equal(resumed.status, "resumed");
    assert.deepEqual(resumed.context, checkpoint.context);
    const successorBytes = readFileSync(attachmentFile);
    const successor = JSON.parse(successorBytes);
    assert.equal(successor.sessionHash, sha256(nextId));
    assert.notEqual(successor.claimGeneration, attachment.claimGeneration);
    assert.equal(successor.checkpointHash, checkpoint.checkpointHash);
    if (routed) assert.equal(JSON.parse(readFileSync(sessionRoutePath(storageRoot, nextId))).status, "active");
    assert.deepEqual(resumeSession(cwd, nextRequest), resumed);
    assert.deepEqual(readFileSync(attachmentFile), successorBytes);
    assert.throws(() => checkpointSession(cwd, request), /does not own/);
    assert.throws(() => resumeSession(cwd, { ...nextRequest, session_id: "another-successor", ...(routed ? { transcript_path: vscodeTranscriptPath(storageRoot, "another-successor") } : {}) }), /another session/);
    assert.equal(handleHook(source, "PreToolUse").permissionDecision, "deny");
    assert.deepEqual(readFileSync(attachmentFile), successorBytes);
    assert.deepEqual(readFileSync(planPath(cwd)), planBytes);
    assert.equal(readFileSync(handoffFile, "utf8"), "PRIVATE_EXISTING_HANDOFF\n");
    assert.equal(summarizePlan(cwd).complete, false);
    assert.equal(summarizePlan(cwd).counts.pending, 1);
    assert.equal(summarizePlan(cwd).counts.in_progress, 1);
    assert.equal(summarizePlan(cwd).operations.orphans.length, 1);
    const startContext = handleHook(next, "SessionStart").additionalContext;
    assert.ok(startContext.includes(checkpoint.checkpointHash));
    assert.match(startContext, /outcome-unknown/);
    assert.doesNotMatch(startContext, /PRIVATE_|private-item/);
    const events = summarizeRunLedger(cwd).eventCounts;
    assert.equal(events.find((entry) => entry.event === "checkpoint_persisted").count, 1);
    assert.equal(events.find((entry) => entry.event === "checkpoint_resumed").count, 1);
    assert.equal(events.some((entry) => entry.event.startsWith("completion_")), false);
    const stop = handleHook({ ...next, stop_hook_active: true }, "Stop");
    assert.equal(stop.decision, "block");
    assert.match(stop.reason, /final bounded continuation/);
    assert.deepEqual(readFileSync(planPath(cwd)), planBytes);
    assert.equal(JSON.parse(readFileSync(planPath(cwd))).completion, null);
  });
}

test("host invocation reuse across claim generations never resolves a late terminal by the current owner", () => {
  const { cwd, source, attachmentFile } = checkpointFixture();
  const tool = { ...source, tool_name: "Read", tool_use_id: "reused-across-claims", tool_input: {} };
  assert.deepEqual(handleHook(tool, "PreToolUse"), {});
  const oldGeneration = JSON.parse(readFileSync(attachmentFile)).claimGeneration;
  assert.equal(releaseAttachment(cwd).released, true);
  attachPlan(cwd, source.session_id);
  const newGeneration = JSON.parse(readFileSync(attachmentFile)).claimGeneration;
  assert.notEqual(newGeneration, oldGeneration);
  assert.deepEqual(handleHook(tool, "PreToolUse"), {});
  assert.deepEqual(handleHook(tool, "PostToolUse"), {});
  const observations = summarizePlan(cwd).operations;
  assert.equal(observations.status, "observed");
  assert.equal(observations.orphans.length, 2);
  assert.deepEqual(new Set(observations.orphans.map((operation) => operation.claimGeneration)), new Set([oldGeneration, newGeneration]));
});

test("successive checkpoints preserve unresolved source context instead of resetting observation", () => {
  const { cwd, source, request, attachmentFile } = checkpointFixture();
  const tool = { ...source, tool_name: "Bash", tool_use_id: "unobserved-source", tool_input: {} };
  assert.deepEqual(handleHook(tool, "PreToolUse"), {});
  const first = checkpointSession(cwd, request);
  const next = { session_id: "second-checkpoint-source", planHash: request.planHash, checkpointHash: first.checkpointHash };
  assert.equal(resumeSession(cwd, next).status, "resumed");
  const second = checkpointSession(cwd, { session_id: next.session_id, planHash: next.planHash, attachmentHash: sha256(readFileSync(attachmentFile)) });
  assert.equal(second.context.operations.status, "observed");
  assert.deepEqual(second.context.operations.orphans, first.context.operations.orphans);
  assert.notEqual(second.checkpointHash, first.checkpointHash);
  const resumed = resumeSession(cwd, { ...next, session_id: "third-checkpoint-session", checkpointHash: second.checkpointHash });
  assert.deepEqual(resumed.context.operations.orphans, first.context.operations.orphans);
  assert.equal(summarizePlan(cwd).complete, false);
});

test("PreCompact only records metadata and never creates a checkpoint or detaches ownership", () => {
  const { cwd, source, attachmentFile, attachmentBytes } = checkpointFixture();
  assert.deepEqual(handleHook({ ...source, trigger: "manual", transcript_size: Number.MAX_SAFE_INTEGER }, "PreCompact"), {});
  assert.deepEqual(readFileSync(attachmentFile), attachmentBytes);
  assert.equal(existsSync(path.join(cwd, ".supervised-worker", "checkpoints")), false);
  assert.equal(summarizeRunLedger(cwd).eventCounts.find((entry) => entry.event === "pre_compact").count, 1);
  assert.deepEqual(handleHook({ ...source, trigger: "PRIVATE_COMPACTION_PAYLOAD" }, "PreCompact"), {});
  const ledger = readFileSync(path.join(cwd, ".supervised-worker", "runs", `${sha256(source.session_id)}.jsonl`), "utf8");
  assert.doesNotMatch(ledger, /PRIVATE_COMPACTION_PAYLOAD/);
  assert.equal(JSON.parse(ledger.trim().split("\n").at(-1)).trigger, "unknown");
});

test("source partial or corrupt ledger tails block checkpoint without detachment or false empty observations", () => {
  const { cwd, request, ledgerFile, attachmentFile, attachmentBytes } = checkpointFixture();
  const original = readFileSync(ledgerFile);
  for (const tail of ['{"partial":', "not-json\n", "\n"]) {
    writeFileSync(ledgerFile, Buffer.concat([original, Buffer.from(tail)]));
    assert.throws(() => checkpointSession(cwd, request), /source ledger/);
    assert.deepEqual(readFileSync(attachmentFile), attachmentBytes);
    const observations = summarizePlan(cwd).operations;
    assert.equal(observations.status, "unavailable");
    assert.equal(observations.orphans, null);
  }
});

test("duplicate-key attachments and hard-linked receipts are rejected without modifying their peers", () => {
  const { cwd, request, attachmentFile, attachmentBytes } = checkpointFixture();
  const duplicated = attachmentBytes.toString().replace('"schemaVersion": 3', '"schemaVersion": 3, "schemaVersion": 3');
  assert.notEqual(duplicated, attachmentBytes.toString());
  writeFileSync(attachmentFile, duplicated);
  assert.throws(() => checkpointSession(cwd, { ...request, attachmentHash: sha256(duplicated) }));
  assert.equal(readFileSync(attachmentFile, "utf8"), duplicated);
  writeFileSync(attachmentFile, attachmentBytes);
  const checkpoint = checkpointSession(cwd, request);
  const receipt = path.join(cwd, ".supervised-worker", "checkpoints", `${checkpoint.checkpointHash}.json`);
  const bytes = readFileSync(receipt);
  const peer = path.join(workspace(), "receipt-peer.json");
  linkSync(receipt, peer);
  assert.equal(lstatSync(receipt).nlink, 2);
  assert.throws(() => resumeSession(cwd, { session_id: "linked-receipt-successor", planHash: request.planHash, checkpointHash: checkpoint.checkpointHash }), /receipt/);
  assert.deepEqual(readFileSync(receipt), bytes);
  assert.deepEqual(readFileSync(peer), bytes);
});

test("orphan reference bounds fail explicitly without truncating or detaching the active owner", () => {
  const { cwd, request, ledgerFile, attachmentFile, attachmentBytes } = checkpointFixture();
  const baseline = readFileSync(ledgerFile, "utf8").trim().split("\n").map(JSON.parse);
  const start = baseline.find((record) => record.event === "tool_started");
  assert.ok(start);
  const orphans = Array.from({ length: 257 }, (_, index) => ({
    ...start, toolName: "Bash", invocationHash: null,
    operationId: `${(index + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
  }));
  writeFileSync(ledgerFile, `${[...baseline, ...orphans].map((record) => JSON.stringify(record)).join("\n")}\n`);
  assert.equal(summarizeRunLedger(cwd).status, "available");
  assert.throws(() => checkpointSession(cwd, request), /orphan limit exceeded/);
  assert.deepEqual(readFileSync(attachmentFile), attachmentBytes);
  assert.equal(summarizePlan(cwd).operations.orphans, null);
});

test("unavailable ownerless observation stays unavailable with a corrupt prior session ledger", () => {
  const { cwd, request, ledgerFile, attachmentFile } = checkpointFixture();
  const corrupt = Buffer.concat([readFileSync(ledgerFile), Buffer.from("{PRIVATE_PARTIAL")]);
  writeFileSync(ledgerFile, corrupt);
  rmSync(attachmentFile);
  const resumed = resumeSession(cwd, { session_id: "corrupt-ledger-recovery", planHash: request.planHash, checkpointHash: null });
  assert.equal(resumed.context.operations.status, "unavailable");
  assert.equal(resumed.context.operations.reason, "ledger-invalid");
  assert.equal(resumed.context.operations.orphans, null);
  assert.deepEqual(readFileSync(ledgerFile), corrupt);
  assert.doesNotMatch(JSON.stringify(resumed), /PRIVATE_PARTIAL/);
});

test("checkpoint request failures leave the active attachment and queue bytes unchanged", () => {
  const { cwd, request, attachmentFile, attachmentBytes } = checkpointFixture();
  const planBytes = readFileSync(planPath(cwd));
  for (const invalid of [
    null, [], {}, { ...request, unexpected: "PRIVATE_REQUEST" }, { ...request, cwd: "PRIVATE_OVERRIDE" },
    { ...request, session_id: "wrong-owner" }, { ...request, session_id: "PRIVATE_REQUEST".repeat(900) },
    { ...request, planHash: "0".repeat(64) }, { ...request, attachmentHash: "0".repeat(64) },
    { ...request, attachmentHash: [request.attachmentHash] }, { ...request, planHash: null },
    { ...request, transcript_path: "PRIVATE_TRANSCRIPT" },
  ]) {
    assert.throws(() => checkpointSession(cwd, invalid), (error) => !error.message.includes("PRIVATE_"));
    assert.deepEqual(readFileSync(attachmentFile), attachmentBytes);
    assert.deepEqual(readFileSync(planPath(cwd)), planBytes);
  }
});

for (const schemaVersion of [1, 2]) {
  test(`legacy v${schemaVersion} checkpoint binds original bytes and restores legacy Stop migration`, () => {
    const { cwd, source, plan, attachmentFile } = checkpointFixture();
    const legacy = { schemaVersion, sessionHash: sha256(source.session_id), attachedAt: "2026-09-01T00:00:00Z",
      ...(schemaVersion === 2 ? { status: "active", routeGeneration: null, updatedAt: "2026-09-01T00:00:00Z" } : {}) };
    const bytes = Buffer.from(`${JSON.stringify(legacy)}\n`);
    writeFileSync(attachmentFile, bytes);
    const runtime = path.join(cwd, ".supervised-worker", "runtime", `${legacy.sessionHash}.json`);
    mkdirSync(path.dirname(runtime), { recursive: true });
    const stopState = { schemaVersion: 1, progressHash: sha256(JSON.stringify(plan)), sameProgressBlocks: 1, totalBlocks: 7 };
    writeFileSync(runtime, JSON.stringify(stopState));
    const checkpoint = checkpointSession(cwd, { session_id: source.session_id, planHash: canonicalPlanHash(plan), attachmentHash: sha256(bytes) });
    const receipt = JSON.parse(readFileSync(path.join(cwd, ".supervised-worker", "checkpoints", `${checkpoint.checkpointHash}.json`)));
    assert.equal(receipt.attachmentHash, sha256(bytes));
    assert.equal(receipt.claimGeneration, null);
    assert.equal(receipt.routeGeneration, null);
    assert.deepEqual(receipt.context.stopState, stopState);
    const next = { session_id: `legacy-resume-${schemaVersion}`, planHash: canonicalPlanHash(plan), checkpointHash: checkpoint.checkpointHash };
    assert.equal(resumeSession(cwd, next).status, "resumed");
    const output = handleHook({ cwd, session_id: next.session_id, stop_hook_active: true }, "Stop");
    assert.equal(output.decision, "block");
    const restored = JSON.parse(readFileSync(path.join(cwd, ".supervised-worker", "runtime", `${sha256(next.session_id)}.json`)));
    assert.equal(restored.schemaVersion, 2);
    assert.equal(restored.sameProgressBlocks, 2);
    assert.equal(restored.totalBlocks, 8);
  });
}

test("invalid Stop state blocks checkpoint without rewriting runtime counters", () => {
  const { cwd, source, request, attachmentFile, attachmentBytes } = checkpointFixture();
  const runtime = path.join(cwd, ".supervised-worker", "runtime", `${sha256(source.session_id)}.json`);
  mkdirSync(path.dirname(runtime), { recursive: true });
  for (const bytes of ["{PRIVATE_STATE", '{"schemaVersion":2,"sameProgressBlocks":"1"}', JSON.stringify({ schemaVersion: 2, progressHash: request.planHash, sameProgressBlocks: 1, totalBlocks: 1, raw: "PRIVATE_STATE" })]) {
    writeFileSync(runtime, bytes);
    assert.throws(() => checkpointSession(cwd, request), /Stop state/);
    assert.equal(readFileSync(runtime, "utf8"), bytes);
    assert.deepEqual(readFileSync(attachmentFile), attachmentBytes);
  }
});

for (const mode of ["absent", "inactive", "complete"]) {
  test(`checkpoint rejects a ${mode} plan without altering ownership`, () => {
    const { cwd, request, attachmentFile, attachmentBytes } = checkpointFixture();
    if (mode === "absent") rmSync(planPath(cwd));
    else {
      const plan = writePlan(cwd, mode === "inactive" ? { mode } : {
        mode, items: [{ id: "done", title: "Done", status: "banked" }],
        completion: { enumeration: { status: "complete", source: "fixture", checkedAt: "2026-09-01T00:00:00Z", remainingActionable: 0 }, evidence: [{ kind: "fixture", locator: "local:fixture" }] },
      });
      assert.deepEqual(validatePlan(plan), []);
      request.planHash = canonicalPlanHash(plan);
    }
    assert.throws(() => checkpointSession(cwd, request), /active/);
    assert.deepEqual(readFileSync(attachmentFile), attachmentBytes);
  });
}

test("receipt and ledger tampering cannot authorize resumption", () => {
  const { cwd, request, ledgerFile, attachmentFile } = checkpointFixture();
  const checkpoint = checkpointSession(cwd, request);
  const receiptFile = path.join(cwd, ".supervised-worker", "checkpoints", `${checkpoint.checkpointHash}.json`);
  const receiptBytes = readFileSync(receiptFile);
  const ledgerBytes = readFileSync(ledgerFile);
  const tombstone = readFileSync(attachmentFile);
  const resume = { session_id: "checked-resume", planHash: request.planHash, checkpointHash: checkpoint.checkpointHash };
  for (const bytes of [Buffer.from("{PRIVATE_RECEIPT"), Buffer.alloc(MAX_CHECKPOINT_BYTES + 1, 0x61)]) {
    writeFileSync(receiptFile, bytes);
    assert.throws(() => resumeSession(cwd, resume), /receipt/);
    assert.deepEqual(readFileSync(attachmentFile), tombstone);
  }
  writeFileSync(receiptFile, receiptBytes);
  for (const bytes of [
    Buffer.from(ledgerBytes.toString().replace('"success":true', '"success":false')),
    Buffer.concat([ledgerBytes, Buffer.from('{"partial":')]),
    Buffer.from(ledgerBytes.toString().replace('"event":"checkpoint_persisted"', '"event":"unknown_event"')),
  ]) {
    assert.notDeepEqual(bytes, ledgerBytes);
    writeFileSync(ledgerFile, bytes);
    assert.throws(() => resumeSession(cwd, resume), /ledger/);
    assert.deepEqual(readFileSync(attachmentFile), tombstone);
  }
  writeFileSync(ledgerFile, ledgerBytes);
  for (const bad of [
    { ...resume, checkpointHash: "0".repeat(64) }, { ...resume, checkpointHash: null },
    { ...resume, planHash: "0".repeat(64) }, { ...resume, session_id: request.session_id },
    { ...resume, raw: "PRIVATE_REQUEST" },
  ]) assert.throws(() => resumeSession(cwd, bad), (error) => !error.message.includes("PRIVATE_"));
  assert.deepEqual(readFileSync(attachmentFile), tombstone);
  assert.equal(resumeSession(cwd, resume).status, "resumed");
});

test("checkpoint rejects linked state and noncanonical roots without touching their targets", () => {
  const { cwd, request, attachmentFile, attachmentBytes } = checkpointFixture();
  const outside = workspace();
  const alias = path.join(outside, "alias");
  symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => checkpointSession(alias, request), /canonical/);
  const checkpoints = path.join(cwd, ".supervised-worker", "checkpoints");
  const externalReceipts = workspace();
  symlinkSync(externalReceipts, checkpoints, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => checkpointSession(cwd, request), /local lifecycle/);
  assert.deepEqual(readdirSync(externalReceipts), []);
  assert.deepEqual(readFileSync(attachmentFile), attachmentBytes);
});

test("ownerless recovery preserves unknown operations and never repeats a side effect", () => {
  const { cwd, source, request, attachmentFile } = checkpointFixture();
  assert.equal(handleHook({ ...source, stop_hook_active: false }, "Stop").decision, "block");
  const input = { ...source, tool_name: "Bash", tool_use_id: undefined, tool_input: { command: "PRIVATE_COMMAND" } };
  assert.deepEqual(handleHook(input, "PreToolUse"), {});
  const before = summarizePlan(cwd).operations;
  assert.equal(before.status, "observed");
  assert.equal(before.orphans.length, 1);
  const sideEffect = path.join(cwd, "side-effect.txt");
  writeFileSync(sideEffect, "performed-once\n");
  rmSync(attachmentFile);
  const next = { session_id: "ownerless-successor", planHash: request.planHash, checkpointHash: null };
  const resumed = resumeSession(cwd, next);
  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.context.operations.orphans[0].observationStatus, "outcome-unknown");
  assert.equal(readFileSync(sideEffect, "utf8"), "performed-once\n");
  assert.equal(handleHook({ cwd, session_id: next.session_id, stop_hook_active: true }, "Stop").decision, "block");
  assert.throws(() => resumeSession(cwd, { ...next, session_id: "stealing-owner" }), /no attachment/);
});

test("missing ledger observation is unavailable rather than a verified empty orphan list", () => {
  const cwd = workspace();
  const plan = writePlan(cwd);
  const recovered = resumeSession(cwd, { session_id: "unobserved-recovery", planHash: canonicalPlanHash(plan), checkpointHash: null });
  assert.equal(recovered.context.operations.status, "unavailable");
  assert.equal(recovered.context.operations.orphans, null);
  assert.equal(recovered.context.operations.uncorrelatedCompletions, null);
  assert.equal(summarizePlan(cwd).operations.status, "unavailable");
  assert.equal(summarizePlan(cwd).operations.orphans, null);
  assert.match(handleHook({ cwd, session_id: "unobserved-recovery" }, "SessionStart").additionalContext, /"status":"unavailable"/);
});

test("checkpoint and resume preserve staged, unstaged, untracked work and index identity", () => {
  const cwd = workspace();
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet");
  writeFileSync(path.join(cwd, ".gitignore"), ".supervised-worker/\n");
  writeFileSync(path.join(cwd, "tracked.txt"), "staged\n");
  git("add", ".gitignore", "tracked.txt");
  writeFileSync(path.join(cwd, "tracked.txt"), "unstaged\n");
  writeFileSync(path.join(cwd, "untracked.txt"), "untracked\n");
  const index = path.join(cwd, ".git", "index");
  const before = {
    bytes: readFileSync(index), identity: lstatSync(index, { bigint: true }),
    status: git("--no-optional-locks", "status", "--porcelain=v1", "-z"),
  };
  assert.match(before.status, /AM tracked\.txt/);
  assert.match(before.status, /\?\? untracked\.txt/);
  const { request } = checkpointFixture(false, cwd);
  assert.throws(() => checkpointSession(cwd, { ...request, attachmentHash: "0".repeat(64) }));
  const checkpoint = checkpointSession(cwd, request);
  const next = { session_id: "dirty-git-successor", planHash: request.planHash, checkpointHash: checkpoint.checkpointHash };
  assert.equal(resumeSession(cwd, next).status, "resumed");
  assert.throws(() => checkpointSession(cwd, request));
  assert.deepEqual(readFileSync(index), before.bytes);
  const afterIdentity = lstatSync(index, { bigint: true });
  assert.equal(afterIdentity.dev, before.identity.dev);
  assert.equal(afterIdentity.ino, before.identity.ino);
  assert.equal(git("--no-optional-locks", "status", "--porcelain=v1", "-z"), before.status);
  assert.equal(readFileSync(path.join(cwd, "tracked.txt"), "utf8"), "unstaged\n");
  assert.equal(readFileSync(path.join(cwd, "untracked.txt"), "utf8"), "untracked\n");
});

test("run ledger summary consumes appendLedger records without exposing detail", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd, "aggregate-session");
  handleHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "aggregate-session",
      cwd,
      tool_name: "SECRET_TOOL_NAME",
      tool_input: { command: "SECRET_ARGUMENT" },
      tool_result: { text: "SECRET_OUTPUT" },
    },
    "PostToolUse",
  );

  const summary = summarizeRunLedger(cwd);
  assert.equal(summary.status, "available");
  assert.equal(summary.sessionCount, 1);
  assert.equal(summary.recordCount, 2);
  assert.deepEqual(summary.eventCounts, [{ event: "tool_completed", count: 2 }]);
  assert.match(summary.hash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /SECRET_TOOL_NAME|SECRET_ARGUMENT|SECRET_OUTPUT|aggregate-session/,
  );
});

test("run ledger summary distinguishes absent and observed-empty ledgers", () => {
  const cwd = workspace();
  const absent = summarizeRunLedger(cwd);
  assert.equal(absent.status, "unavailable");
  assert.equal(absent.reason, "run-ledger-absent");
  assert.equal(absent.recordCount, null);

  mkdirSync(path.join(cwd, ".supervised-worker", "runs"), { recursive: true });
  const empty = summarizeRunLedger(cwd);
  assert.equal(empty.status, "available");
  assert.equal(empty.sessionCount, 0);
  assert.equal(empty.recordCount, 0);
  assert.deepEqual(empty.eventCounts, []);
  assert.equal(empty.firstObservedAt, null);
  assert.equal(empty.lastObservedAt, null);
  assert.match(empty.hash, /^[0-9a-f]{64}$/);
});

test("Stop releases after its final warning when the ledger is unavailable", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd);

  handleHook(stopInput(cwd), "Stop");
  const finalBlock = handleHook(stopInput(cwd, true), "Stop");
  const runs = path.join(cwd, ".supervised-worker", "runs");
  rmSync(runs, { recursive: true, force: true });
  writeFileSync(runs, "ledger unavailable\n");
  const released = handleHook(stopInput(cwd, true), "Stop");

  assert.match(finalBlock.reason, /final bounded continuation/);
  assert.equal(released.decision, "allow");
  assert.equal(released.hookSpecificOutput.decision, "allow");
  assert.equal(existsSync(path.join(cwd, ".supervised-worker", "attachment.json")), false);
});

test("Stop hook allows a mechanically complete plan", () => {
  const cwd = workspace();
  writePlan(cwd, {
    mode: "complete",
    items: [{ id: "issue-1", title: "First issue", status: "banked" }],
    completion: {
      enumeration: {
        status: "complete",
        source: "GitHub authenticated issue enumeration",
        checkedAt: "2026-09-01T00:00:00Z",
        remainingActionable: 0,
      },
      evidence: [{ kind: "test", locator: "logs/gates/receipt.json" }],
    },
  });
  attachPlan(cwd);
  assert.deepEqual(handleHook(stopInput(cwd), "Stop"), {});
});

test("completion evidence does not pass while plan mode remains active", () => {
  const cwd = workspace();
  writePlan(cwd, {
    items: [{ id: "issue-1", title: "First issue", status: "banked" }],
    completion: {
      enumeration: {
        status: "complete",
        source: "GitHub authenticated issue enumeration",
        checkedAt: "2026-09-01T00:00:00Z",
        remainingActionable: 0,
      },
      evidence: [{ kind: "test", locator: "logs/gates/receipt.json" }],
    },
  });
  attachPlan(cwd);
  assert.equal(handleHook(stopInput(cwd), "Stop").hookSpecificOutput.decision, "block");
});

test("SessionStart injects only bounded plan counts", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd, "s1");
  const output = handleHook(
    { hook_event_name: "SessionStart", session_id: "s1", cwd },
    "SessionStart",
  );
  assert.match(output.additionalContext, /"pending":1/);
  assert.match(output.hookSpecificOutput.additionalContext, /"pending":1/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /First issue/);
});

test("tool ledger stores metadata without arguments or results", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd, "s2");
  handleHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s2",
      cwd,
      tool_name: "run_in_terminal",
      tool_input: { command: "secret command" },
      tool_result: { text: "secret output" },
    },
    "PostToolUse",
  );
  const runs = path.join(cwd, ".supervised-worker", "runs");
  const [file] = readdirSync(runs);
  const text = readFileSync(path.join(runs, file), "utf8");
  assert.match(text, /run_in_terminal/);
  assert.doesNotMatch(text, /secret command|secret output/);
});

test("unattached sessions do not create tool ledgers", () => {
  const cwd = workspace();
  writePlan(cwd);
  handleHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "other-session",
      cwd,
      tool_name: "run_in_terminal",
      tool_input: { command: "echo hello" },
    },
    "PostToolUse",
  );
  assert.equal(existsSync(path.join(cwd, ".supervised-worker", "runs")), false);
});

test("apply_patch plan writes attach without retaining patch content", () => {
  const cwd = workspace();
  writePlan(cwd);
  const privatePatchMarker = "private-patch-content";
  handleHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "patch-session",
      cwd,
      tool_name: "apply_patch",
      tool_input: {
        input: `*** Begin Patch\n*** Update File: ${planPath(cwd)}\n+${privatePatchMarker}\n*** End Patch`,
      },
    },
    "PostToolUse",
  );
  const stop = handleHook(
    {
      hook_event_name: "Stop",
      session_id: "patch-session",
      stop_hook_active: false,
      cwd,
    },
    "Stop",
  );
  assert.equal(stop.hookSpecificOutput.decision, "block");
  const runs = path.join(cwd, ".supervised-worker", "runs");
  const text = readdirSync(runs)
    .map((file) => readFileSync(path.join(runs, file), "utf8"))
    .join("\n");
  assert.doesNotMatch(text, new RegExp(privatePatchMarker));
});

test("schema-invalid completion cannot release the Stop gate", () => {
  const cwd = workspace();
  writePlan(cwd, {
    mode: "complete",
    unexpected: true,
    items: [{ id: "issue-1", title: "First issue", status: "banked" }],
    completion: {
      enumeration: {
        status: "complete",
        source: "GitHub",
        checkedAt: "not-a-date",
        remainingActionable: 0,
      },
      evidence: [{ kind: "test", locator: "receipt", unexpected: true }],
    },
  });
  attachPlan(cwd);
  const errors = validatePlan(JSON.parse(readFileSync(planPath(cwd), "utf8")));
  assert.match(errors.join("\n"), /unknown property|RFC 3339/);
  assert.equal(handleHook(stopInput(cwd), "Stop").hookSpecificOutput.decision, "block");
});

test("a second session cannot take over an attached plan", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd, "session-one");
  const conflict = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "session-two",
      cwd,
      tool_name: "Edit",
      tool_input: { filePath: planPath(cwd) },
    },
    "PreToolUse",
  );
  assert.equal(conflict.hookSpecificOutput.permissionDecision, "deny");
  assert.match(conflict.hookSpecificOutput.permissionDecisionReason, /Another Copilot session owns/);
  assert.equal(
    handleHook({ ...stopInput(cwd), session_id: "session-one" }, "Stop")
      .hookSpecificOutput.decision,
    "block",
  );
  assert.deepEqual(
    handleHook({ ...stopInput(cwd), session_id: "session-two" }, "Stop"),
    {},
  );
});

test("apply_patch mentions outside target headers do not claim the plan", () => {
  const cwd = workspace();
  writePlan(cwd);
  handleHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "patch-mention",
      cwd,
      tool_name: "apply_patch",
      tool_input: {
        input: `*** Begin Patch\n*** Update File: README.md\n+*** Update File: ${planPath(cwd)}\n*** End Patch`,
      },
    },
    "PostToolUse",
  );
  assert.deepEqual(
    handleHook({ ...stopInput(cwd), session_id: "patch-mention" }, "Stop"),
    {},
  );
});

test("malformed runtime counters release a recursive Stop visibly", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd);
  const runtime = path.join(
    cwd,
    ".supervised-worker",
    "runtime",
    `${sha256("11111111-1111-4111-8111-111111111111")}.json`,
  );
  mkdirSync(path.dirname(runtime), { recursive: true });
  writeFileSync(runtime, JSON.stringify({
    schemaVersion: 1,
    progressHash: "a".repeat(64),
    sameProgressBlocks: "0",
    totalBlocks: "0",
  }));
  const output = handleHook(stopInput(cwd, true), "Stop");
  assert.match(output.systemMessage, /runtime state was invalid/);
  assert.deepEqual(handleHook(stopInput(cwd), "Stop"), {});
});

test("first recursive Stop without runtime counters releases visibly", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd);

  const output = handleHook(stopInput(cwd, true), "Stop");
  assert.equal(output.decision, "allow");
  assert.match(output.systemMessage, /bounded retry limit/);
  assert.equal(existsSync(path.join(cwd, ".supervised-worker", "attachment.json")), false);
});

test("persisted zero totalBlocks does not authorize recursive Stop release", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd);
  assert.equal(handleHook(stopInput(cwd), "Stop").decision, "block");
  const runtime = path.join(
    cwd,
    ".supervised-worker",
    "runtime",
    `${sha256("11111111-1111-4111-8111-111111111111")}.json`,
  );
  const state = JSON.parse(readFileSync(runtime, "utf8"));
  state.totalBlocks = 0;
  writeFileSync(runtime, `${JSON.stringify(state, null, 2)}\n`);

  const output = handleHook(stopInput(cwd, true), "Stop");
  assert.equal(output.decision, "block");
  assert.match(output.reason, /final bounded continuation/);
  assert.equal(existsSync(path.join(cwd, ".supervised-worker", "attachment.json")), true);
});

test("ledger failure cannot prevent bounded Stop release", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd);
  const runs = path.join(cwd, ".supervised-worker", "runs");
  rmSync(runs, { recursive: true, force: true });
  writeFileSync(runs, "not a directory");
  assert.equal(handleHook(stopInput(cwd), "Stop").hookSpecificOutput.decision, "block");
  assert.equal(handleHook(stopInput(cwd, true), "Stop").hookSpecificOutput.decision, "block");
  assert.match(handleHook(stopInput(cwd, true), "Stop").systemMessage, /bounded retry limit/);
});

test("malformed attached plan gives bounded SessionStart guidance", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd, "start-session");
  writeFileSync(planPath(cwd), "{TOPSECRET");
  const output = handleHook(
    { hook_event_name: "SessionStart", session_id: "start-session", cwd },
    "SessionStart",
  );
  assert.match(output.hookSpecificOutput.additionalContext, /plan is invalid/);
  assert.doesNotMatch(JSON.stringify(output), /TOPSECRET/);
});

test("malformed attachment state fails open visibly", () => {
  const cwd = workspace();
  writePlan(cwd);
  writeFileSync(path.join(cwd, ".supervised-worker", "attachment.json"), "{TOPSECRET");
  const output = handleHook(stopInput(cwd), "Stop");
  assert.match(output.systemMessage, /fail open visibly/);
  assert.doesNotMatch(JSON.stringify(output), /TOPSECRET/);
});

test("state junctions fail open without writing outside the workspace", () => {
  const cwd = workspace();
  const outside = workspace();
  const state = path.join(cwd, ".supervised-worker");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(outside, state, linkType);
  writeFileSync(
    path.join(outside, "plan.json"),
    JSON.stringify({
      schemaVersion: 1,
      mode: "active",
      goal: "Do not escape",
      items: [{ id: "one", title: "One", status: "pending" }],
      completion: null,
    }),
  );
  const before = readdirSync(outside).sort();
  const output = handleHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "junction-session",
      cwd,
      tool_name: "create_file",
      tool_input: { filePath: path.join(state, "plan.json") },
    },
    "PostToolUse",
  );
  assert.match(output.systemMessage, /fail open visibly/);
  assert.deepEqual(readdirSync(outside).sort(), before);
});

test("PreToolUse denies a plan write when state containment is unsafe", () => {
  const cwd = workspace();
  const outside = workspace();
  const state = path.join(cwd, ".supervised-worker");
  symlinkSync(outside, state, process.platform === "win32" ? "junction" : "dir");
  const output = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "unsafe-session",
      cwd,
      tool_name: "Write",
      tool_input: { file_path: path.join(state, "plan.json") },
    },
    "PreToolUse",
  );
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /resolved safely|could not verify/);
  assert.deepEqual(readdirSync(outside), []);
});

test("every supported writer payload claims the plan", () => {
  for (const [toolName, makeInput] of writerPayloadCases()) {
    const cwd = workspace();
    const plan = planPath(cwd);
    const session = `writer-${toolName}-${Math.random()}`;
    const decision = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: session,
        cwd,
        tool_name: toolName,
        tool_input: makeInput(plan),
      },
      "PreToolUse",
    );
    assert.deepEqual(decision, {}, toolName);
    writePlan(cwd);
    assert.equal(
      handleHook({ ...stopInput(cwd), session_id: session }, "Stop").decision,
      "block",
      toolName,
    );
  }
});

test("camelCase apply_patch claims the plan from toolArgs", () => {
  const cwd = workspace();
  const plan = planPath(cwd);
  const sessionId = "camel-patch-session";
  const decision = handleHook(
    {
      sessionId,
      cwd,
      toolName: "apply_patch",
      toolArgs: {
        input: `*** Begin Patch\n*** Add File: ${plan}\n+{}\n*** End Patch`,
      },
    },
    "PreToolUse",
  );
  assert.deepEqual(decision, {});
  writePlan(cwd);
  assert.equal(handleHook({ sessionId, cwd }, "Stop").decision, "block");
});

test("apply_patch delete and move-to headers respect plan ownership", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd, "owner-session");
  for (const patch of [
    `*** Begin Patch\n*** Delete File: ${planPath(cwd)}\n*** End Patch`,
    `*** Begin Patch\n*** Update File: other.json\n*** Move to: ${planPath(cwd)}\n*** End Patch`,
  ]) {
    const output = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "other-session",
        cwd,
        tool_name: "apply_patch",
        tool_input: { patch },
      },
      "PreToolUse",
    );
    assert.equal(output.permissionDecision, "deny");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  }
});

test("a link at the exact plan path is denied before attachment", () => {
  const cwd = workspace();
  const outside = workspace();
  mkdirSync(path.dirname(planPath(cwd)), { recursive: true });
  if (process.platform === "win32") {
    symlinkSync(outside, planPath(cwd), "junction");
  } else {
    const outsidePlan = path.join(outside, "plan.json");
    writeFileSync(outsidePlan, "{}\n");
    symlinkSync(outsidePlan, planPath(cwd), "file");
  }
  const before = readdirSync(outside).sort();
  const output = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "linked-plan-session",
      cwd,
      tool_name: "Write",
      tool_input: { file_path: planPath(cwd) },
    },
    "PreToolUse",
  );
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(readdirSync(outside).sort(), before);
  assert.equal(existsSync(path.join(cwd, ".supervised-worker", "attachment.json")), false);
});

test("PostTool conflict guidance uses the compatible additional-context envelope", () => {
  const cwd = workspace();
  writePlan(cwd);
  attachPlan(cwd, "owner-session");
  const output = handleHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "other-session",
      cwd,
      tool_name: "edit",
      tool_input: { path: planPath(cwd) },
    },
    "PostToolUse",
  );
  assert.match(output.hookSpecificOutput.additionalContext, /target repository/);
});

test("calendar-invalid completion dates are rejected", () => {
  for (const checkedAt of ["2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z"] ) {
    const plan = {
      schemaVersion: 1,
      mode: "complete",
      goal: "Complete queue",
      items: [{ id: "one", title: "One", status: "banked" }],
      completion: {
        enumeration: {
          status: "complete",
          source: "GitHub",
          checkedAt,
          remainingActionable: 0,
        },
        evidence: [{ kind: "test", locator: "receipt" }],
      },
    };
    assert.match(validatePlan(plan).join("\n"), /RFC 3339/);
  }
});

test("resumeWhen must match the schema type whenever present", () => {
  const errors = validatePlan({
    schemaVersion: 1,
    mode: "active",
    goal: "Complete queue",
    items: [{ id: "one", title: "One", status: "pending", resumeWhen: 42 }],
    completion: null,
  });
  assert.match(errors.join("\n"), /resumeWhen must be a non-empty string/);
});

test("maximum-size multi-replace payloads still find the plan target", () => {
  const cwd = workspace();
  const replacements = Array.from({ length: MAX_TOOL_TARGETS }, (_, index) => ({
    filePath: index === 0 ? planPath(cwd) : path.join(cwd, `other-${index}.txt`),
  }));
  const sessionId = "deep-writer-session";
  assert.deepEqual(
    handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        cwd,
        tool_name: "multi_replace_string_in_file",
        tool_input: { replacements },
      },
      "PreToolUse",
    ),
    {},
  );
  writePlan(cwd);
  assert.equal(handleHook({ ...stopInput(cwd), session_id: sessionId }, "Stop").decision, "block");
});

test("cyclic writer payload traversal terminates", () => {
  const script = `
    import { handleHook } from ${JSON.stringify(new URL("../src/core.mjs", import.meta.url).href)};
    const toolInput = { path: "unrelated.txt" };
    toolInput.self = toolInput;
    const output = handleHook({
      hook_event_name: "PreToolUse",
      session_id: "cyclic-session",
      cwd: process.cwd(),
      tool_name: "multi_replace_string_in_file",
      tool_input: toolInput,
    }, "PreToolUse");
    if (JSON.stringify(output) !== "{}") process.exit(2);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: workspace(),
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, "cyclic payload traversal timed out");
  assert.equal(result.status, 0, result.stderr);
});

test("agent file edits cannot modify human-managed role authority", () => {
  const cwd = workspace();
  const workflowPath = path.join(cwd, ".github", "supervised-worker.json");
  const denied = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "companion-session",
      cwd,
      tool_name: "Write",
      tool_input: { file_path: workflowPath },
    },
    "PreToolUse",
  );
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /role authority/);

  writePlan(cwd);
  attachPlan(cwd, "owner-session");
  const ownerDenied = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "owner-session",
      cwd,
      tool_name: "Write",
      tool_input: { file_path: workflowPath },
    },
    "PreToolUse",
  );
  assert.equal(ownerDenied.permissionDecision, "deny");
  assert.match(ownerDenied.permissionDecisionReason, /human-managed/);
});

test("over-limit target sets are denied before protected-path inspection", () => {
  const cwd = workspace();
  const replacements = Array.from({ length: MAX_TOOL_TARGETS + 1 }, (_, index) => ({
    filePath: path.join(cwd, `target-${index}.txt`),
  }));
  const denied = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "over-limit-session",
      cwd,
      tool_name: "multi_replace_string_in_file",
      tool_input: { replacements },
    },
    "PreToolUse",
  );
  assert.equal(denied.permissionDecision, "deny");
  assert.equal(existsSync(path.join(cwd, ".supervised-worker")), false);
});

test("duplicate targets consume one target-budget slot", () => {
  const cwd = workspace();
  const repeatedTarget = path.join(cwd, "ordinary.txt");
  const replacements = Array.from({ length: 4_000 }, () => ({
    filePath: repeatedTarget,
  }));
  assert.deepEqual(
    handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "duplicate-target-session",
        cwd,
        tool_name: "multi_replace_string_in_file",
        tool_input: { replacements },
      },
      "PreToolUse",
    ),
    {},
  );
});