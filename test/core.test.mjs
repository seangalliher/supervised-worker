import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { afterEach } from "node:test";

import { handleHook, planPath, sha256, validatePlan } from "../src/core.mjs";

const temporaryWorkspaces = new Set();

function workspace() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-test-"));
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
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /could not verify/);
  assert.deepEqual(readdirSync(outside), []);
});

test("every supported writer payload claims the plan", () => {
  const cases = [
    ["create", (plan) => ({ path: plan })],
    ["edit", (plan) => ({ path: plan })],
    ["Write", (plan) => ({ file_path: plan })],
    ["create_file", (plan) => ({ filePath: plan })],
    ["str_replace_editor", (plan) => ({ path: plan })],
    ["insert", (plan) => ({ path: plan })],
    ["insert_edit_into_file", (plan) => ({ filePath: plan })],
    ["replace_string_in_file", (plan) => ({ filePath: plan })],
    ["multi_replace_string_in_file", (plan) => ({ replacements: [{ filePath: plan }] })],
    ["apply_patch", (plan) => `*** Begin Patch\n*** Add File: ${plan}\n+{}\n*** End Patch`],
    ["apply_patch", (plan) => ({ patch: `*** Begin Patch\n*** Add File: ${plan}\n+{}\n*** End Patch` })],
    ["apply_patch", (plan) => ({ input: `*** Begin Patch\n*** Add File: ${plan}\n+{}\n*** End Patch` })],
    ["apply_patch", (plan) => ({ raw: `*** Begin Patch\n*** Add File: ${plan}\n+{}\n*** End Patch` })],
    ["Edit", (plan) => ({ input: `*** Begin Patch\n*** Add File: ${plan}\n+{}\n*** End Patch` })],
  ];
  for (const [toolName, makeInput] of cases) {
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

test("deep multi-replace payloads still find the plan target", () => {
  const cwd = workspace();
  const replacements = Array.from({ length: 1_100 }, (_, index) => ({
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