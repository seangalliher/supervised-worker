import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { requireVerifiedWorkerAuthority, verifyWorkerAuthority } from "../src/authority.mjs";
import { applyCampaignPlan, canonicalPlanHash, checkpointSession, handlePluginHook, observeCampaignTransition, resumeSession, sha256 } from "../src/core.mjs";
import { detectDoctorIncident, executeDoctorIntent, grantDoctorAction, inspectDoctorIncident } from "../src/doctor.mjs";
import { doctorHash } from "../src/doctor-state.mjs";
import { routeDoctorConsultation } from "../src/doctor-routing.mjs";
import { installLocalPlugin } from "../src/install.mjs";
import { acceptWorkflowRoles, resolveWorkflowRoles } from "../src/workflow.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function withLocalFixture(action) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sw-local-authority-")));
  const cleanup = () => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  let pending = false;
  try {
    const cwd = path.join(base, "repo");
    const workflowPath = path.join(cwd, ".github", "supervised-worker.json");
    mkdirSync(path.dirname(workflowPath), { recursive: true });
    const workflow = JSON.parse(readFileSync(path.join(sourceRoot, "examples", "workflow.json")));
    workflow.authority.assurance = "local-scoped";
    writeFileSync(workflowPath, JSON.stringify(workflow));
    const storage = path.join(base, "storage");
    const transcripts = path.join(storage, "GitHub.copilot-chat", "transcripts");
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(path.join(storage, "workspace.json"), "{}\n");
    const input = { cwd, session_id: "local-worker", transcript_path: path.join(transcripts, "local-worker.jsonl") };
    writeFileSync(input.transcript_path, "");
    const { installRoot } = installLocalPlugin(sourceRoot, { baseDirectory: path.join(base, "install") });
    const accept = () => {
      const result = acceptWorkflowRoles(cwd, resolveWorkflowRoles(cwd).workflowHash);
      assert.equal(result.ok, true, result.errors?.join("\n"));
    };
    const result = action({ base, cwd, workflow, workflowPath, storage, input, installRoot, accept });
    if (result instanceof Promise) {
      pending = true;
      return result.finally(cleanup);
    }
    return result;
  } finally {
    if (!pending) cleanup();
  }
}

function localHookChild(fixture, mode, hostId) {
  const sessionLock = path.join(fixture.storage, "supervised-worker", "session-locks", sha256(fixture.input.session_id));
  const journalLock = path.join(fixture.cwd, ".supervised-worker", "locks", "journal");
  const input = { ...fixture.input, tool_name: "read_file", tool_use_id: hostId,
    tool_input: { filePath: path.join(fixture.cwd, "README.md"), startLine: 1, endLine: 1 } };
  const child = spawn(process.execPath, [fileURLToPath(new URL("./local-hook-child-fixture.mjs", import.meta.url)),
    JSON.stringify({ installRoot: fixture.installRoot, input, mode, event: "PreToolUse", sessionLock, journalLock })],
  { cwd: fixture.cwd, stdio: ["pipe", "ignore", "pipe", "ipc"] });
  const messages = [];
  let stderr = "";
  let failure = null;
  let closed = false;
  const waiters = [];
  const notify = () => { for (const waiter of waiters.splice(0)) waiter(); };
  const timer = setTimeout(() => { failure = new Error("Local hook child exceeded its 20-second test bound"); child.kill(); notify(); }, 20_000);
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  child.on("message", (message) => { messages.push(message); notify(); });
  child.once("error", (error) => { failure = error; notify(); });
  const exited = new Promise((resolve) => child.once("close", (code, signal) => {
    clearTimeout(timer);
    closed = true;
    resolve({ code, signal });
    notify();
  }));
  return {
    child, exited,
    async waitFor(type) {
      for (;;) {
        if (failure) throw failure;
        const result = messages.find((message) => message.type === type);
        if (result) return result;
        assert.equal(closed, false, `Local hook child exited before ${type}: ${stderr}`);
        await new Promise((resolve) => waiters.push(resolve));
      }
    },
    async finish() {
      const exit = await exited;
      assert.equal(failure, null);
      assert.equal(exit.signal, null, stderr);
      assert.equal(exit.code, 0, stderr);
      const results = messages.filter((message) => message.type === "result");
      assert.equal(results.length, 1);
      return results[0];
    },
  };
}

function admitLocalFixture(fixture) {
  fixture.accept();
  const request = { session_id: fixture.input.session_id, transcript_path: fixture.input.transcript_path };
  const authority = verifyWorkerAuthority(fixture.cwd, request, fixture.installRoot, "");
  const plan = { schemaVersion: 1, mode: "active", goal: "Verify local hook overlap.",
    items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
  assert.equal(applyCampaignPlan(fixture.cwd, { ...request, expected: observeCampaignTransition(fixture.cwd, request), plan }, authority).status, "applied");
}

test("local native Doctor requests recover a dead session lock while ordinary tools remain denied", () => {
  withLocalFixture((fixture) => {
    admitLocalFixture(fixture);
    const record = JSON.parse(readFileSync(path.join(fixture.installRoot, "install-record.json")));
    const hookNode = process.platform === "win32" ? record.nodePath.toUpperCase() : record.nodePath;
    if (process.platform === "win32") assert.notEqual(hookNode, record.nodePath, "Executable identity probe must use a different launch spelling");
    const quote = (value) => `'${process.platform === "win32" ? value.replaceAll("'", "''") : value.replaceAll("'", "'\\''")}'`;
    const helper = path.join(fixture.installRoot, "src", "doctor-rescue.mjs");
    const requestBase = { session_id: fixture.input.session_id, transcript_path: fixture.input.transcript_path, incidentId: randomUUID() };
    const hook = (command, overrides = {}, eventName = "PreToolUse", invocation = randomUUID()) => {
      const input = { ...fixture.input, hook_event_name: eventName, tool_name: "run_in_terminal", tool_use_id: invocation,
        tool_input: { command, mode: "sync" }, ...overrides };
      const result = spawnSync(hookNode, [path.join(fixture.installRoot, "src", "hook-launcher.mjs"), eventName], {
        cwd: fixture.cwd, input: JSON.stringify(input), encoding: "utf8", timeout: 30000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const commandFor = (request) => `${process.platform === "win32" ? "& " : ""}${quote(record.nodePath)} ${quote(helper)} --request-base64 ${quote(Buffer.from(JSON.stringify({ cwd: fixture.cwd, request })).toString("base64"))}`;
    const healthy = hook("git status --short");
    assert.notEqual(healthy.permissionDecision, "deny");
    const ledgerFile = path.join(fixture.cwd, ".supervised-worker", "runs", `${sha256(fixture.input.session_id)}.jsonl`);
    assert.ok(readFileSync(ledgerFile, "utf8").includes('"event":"tool_started"'), "Healthy premise must durably admit a tool");
    const planPath = path.join(fixture.cwd, ".supervised-worker", "plan.json");
    const attachmentPath = path.join(fixture.cwd, ".supervised-worker", "attachment.json");
    const before = [readFileSync(planPath), readFileSync(attachmentPath)];
    const child = spawnSync(record.nodePath, ["--eval", ""], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0);
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    const lock = path.join(fixture.storage, "supervised-worker", "session-locks", sha256(fixture.input.session_id));
    const token = randomUUID();
    mkdirSync(lock);
    const owner = JSON.stringify({ schemaVersion: 1, token, processId: child.pid, acquiredAt: new Date().toISOString() });
    writeFileSync(path.join(lock, `${token}.json`), owner);
    assert.equal(hook("git status --short").permissionDecision, "deny");
    const doctor = (operation, parameters = {}) => {
      const request = { ...requestBase, operation, ...parameters };
      const invocation = randomUUID();
      const permission = hook(commandFor(request), {}, "PreToolUse", invocation);
      assert.equal(permission.permissionDecision, "allow", JSON.stringify(permission));
      const shell = process.platform === "win32" ? path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe") : "/bin/sh";
      const args = process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", commandFor(request)] : ["-c", commandFor(request)];
      const result = spawnSync(shell, args, {
        cwd: fixture.base, encoding: "utf8", timeout: 30000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout || result.stderr);
      assert.deepEqual(hook(commandFor(request), { tool_result: { exitCode: result.status } }, "PostToolUse", invocation), {});
      return JSON.parse(result.stdout);
    };
    const detected = doctor("detect", { diagnosticHash: "a".repeat(64) });
    const consultation = { kind: "doctor-consultation", incident: detected.incident, incidentHash: detected.hash, evidence: [] };
    const consultationInput = { tool_name: "runSubagent", tool_input: { agentName: "Supervised Doctor",
      prompt: JSON.stringify(consultation), description: "Diagnose the bounded fixture incident" } };
    const consultationInvocation = randomUUID();
    assert.equal(hook(null, consultationInput, "PreToolUse", consultationInvocation).permissionDecision, "allow");
    assert.deepEqual(hook(null, consultationInput, "PostToolUse", consultationInvocation), {});
    const execute = (action, inputHashes = []) => {
      const current = doctor("inspect");
      const grant = doctor("grant", { grant: { action, actionId: randomUUID(), expectedHash: current.hash } });
      return doctor("execute", { intent: { schemaVersion: 1, kind: "doctor-repair-intent", binding: current.incident.binding,
        attemptId: current.incident.attemptId, actionId: grant.capability.actionId, action,
        capabilityHash: grant.hash, expectedHash: current.hash, inputHashes } });
    };
    const inspected = execute("inspect");
    assert.equal(inspected.status, "succeeded");
    assert.ok(inspected.values.some((value) => value.diagnostics.some((entry) => entry.scope === "session" && entry.code === "LIFECYCLE_OWNER_DEAD")));
    const recovered = execute("recover", inspected.outcome.outputHashes);
    assert.equal(recovered.status, "succeeded", JSON.stringify(recovered));
    assert.equal(existsSync(lock), false);
    assert.equal(readFileSync(path.join(`${lock}.${token}.recovered`, `${token}.json`), "utf8"), owner);
    assert.deepEqual([readFileSync(planPath), readFileSync(attachmentPath)], before);
    const startsBefore = readFileSync(ledgerFile, "utf8").split("\n").filter((line) => line.includes('"event":"tool_started"')).length;
    assert.notEqual(hook("git status --short").permissionDecision, "deny");
    const startsAfter = readFileSync(ledgerFile, "utf8").split("\n").filter((line) => line.includes('"event":"tool_started"')).length;
    assert.equal(startsAfter, startsBefore + 1, "Recovery must reach the next governed consumer");
    assert.equal(readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).map(JSON.parse)
      .filter((entry) => entry.event === "tool_completed" && entry.operationId === null).length, 0,
    "Unchanged Doctor Pre/Post payloads must not create unpaired ordinary completions");
  });
});

test("local Doctor consultation rejects unbound evidence, wrong agents, sessions and stale incident state", (context) => {
  withLocalFixture((fixture) => {
    admitLocalFixture(fixture);
    const authority = verifyWorkerAuthority(fixture.cwd, fixture.input, fixture.installRoot, "");
    const incidentId = randomUUID();
    const value = { detail: "Bounded diagnostic observation" };
    const detected = detectDoctorIncident(fixture.cwd, fixture.input, incidentId, doctorHash(value), authority);
    const request = { kind: "doctor-consultation", incident: detected.incident, incidentHash: detected.hash,
      evidence: [{ value, sha256: doctorHash(value) }] };
    const input = { ...fixture.input, hook_event_name: "PreToolUse", tool_name: "runSubagent",
      tool_input: { agentName: "Supervised Doctor", description: "Fixture diagnosis", prompt: JSON.stringify(request) } };
    const route = (candidate, event = "PreToolUse") => routeDoctorConsultation(candidate, event, fixture.installRoot);
    assert.equal(route(input).permissionDecision, "allow");
    assert.equal(route({ ...fixture.input, toolName: "RUNSUBAGENT", toolArgs: input.tool_input }).permissionDecision, "allow");
    assert.equal(route({ ...fixture.input, toolName: "functions.runSubagent", toolArgs: input.tool_input, toolInput: {} }).permissionDecision, "allow");
    let rejectedRootReads = 0;
    const originalRealpath = fs.realpathSync;
    const unsafeRoots = process.platform === "win32" ? ["relative", "\\\\unavailable.invalid\\share"] : ["relative"];
    const pathKey = (value) => path.resolve(String(value)).replace(/[\\/]+$/, "").toLowerCase();
    const unsafeKeys = unsafeRoots.map(pathKey);
    const inspectRealpath = (original) => (value, ...options) => {
      const candidate = pathKey(value);
      if (unsafeKeys.some((unsafe) => candidate === unsafe || candidate.startsWith(`${unsafe}${path.sep}`))) {
        rejectedRootReads += 1;
        throw new Error("Rejected root must not reach filesystem traversal");
      }
      return original(value, ...options);
    };
    if (typeof fs.realpathSync.native === "function") context.mock.method(fs.realpathSync, "native", inspectRealpath(fs.realpathSync.native));
    context.mock.method(fs, "realpathSync", inspectRealpath(originalRealpath));
    syncBuiltinESMExports();
    try {
      for (const cwd of unsafeRoots) assert.throws(() => fs.realpathSync(path.resolve(cwd)), /Rejected root/);
      assert.equal(rejectedRootReads, unsafeRoots.length, "Positive control must detect normalized unsafe-root traversal");
      if (typeof fs.realpathSync.native === "function") {
        assert.throws(() => fs.realpathSync.native(path.resolve(unsafeRoots[0])), /Rejected root/);
        assert.equal(rejectedRootReads, unsafeRoots.length + 1);
      }
      rejectedRootReads = 0;
      for (const cwd of unsafeRoots) assert.equal(route({ ...input, cwd }), null);
      assert.equal(rejectedRootReads, 0);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(route(input, "PostToolUse"), {});
    assert.equal(route(input, "Stop"), null);
    assert.equal(route({ ...input, tool_name: "run_in_terminal" }), null);
    assert.equal(route({ ...input, session_id: "another-worker" }), null);
    for (const parameters of [
      { ...input.tool_input, agentName: "Builder" }, { ...input.tool_input, tools: ["execute"] },
      { ...input.tool_input, prompt: "plain unbound text" }, { ...input.tool_input, prompt: " ".repeat(65537) },
      { ...input.tool_input, prompt: JSON.stringify({ ...request, incidentHash: "b".repeat(64) }) },
      { ...input.tool_input, prompt: JSON.stringify({ ...request, evidence: [{ value, sha256: "b".repeat(64) }] }) },
      { ...input.tool_input, prompt: JSON.stringify({ ...request, evidence: [{ value: { unrelated: true }, sha256: doctorHash({ unrelated: true }) }] }) },
      { ...input.tool_input, prompt: JSON.stringify({ ...request, evidence: new Array(17).fill(request.evidence[0]) }) },
      { ...input.tool_input, prompt: JSON.stringify({ ...request, arbitrary: true }) },
      { ...input.tool_input, prompt: JSON.stringify({ ...request, incident: {} }) },
    ]) assert.equal(route({ ...input, tool_input: parameters }), null);
    const grant = grantDoctorAction(fixture.cwd, fixture.input, incidentId, { action: "inspect", actionId: randomUUID(), expectedHash: detected.hash }, authority);
    assert.equal(executeDoctorIntent(fixture.cwd, fixture.input, { schemaVersion: 1, kind: "doctor-repair-intent",
      binding: detected.incident.binding, attemptId: detected.incident.attemptId, actionId: grant.capability.actionId,
      action: "inspect", capabilityHash: grant.hash, expectedHash: detected.hash, inputHashes: [] }, authority).status, "succeeded");
    assert.equal(route(input), null, "Old hash-bound consultation cannot represent the new incident revision");
  });
});

test("local hooks wait for a live peer beyond the legacy overlap window without losing starts", async () => {
  await withLocalFixture(async (fixture) => {
    admitLocalFixture(fixture);
    const attachmentPath = path.join(fixture.cwd, ".supervised-worker", "attachment.json");
    const before = readFileSync(attachmentPath);
    const holder = localHookChild(fixture, "holder", "held-local-hook");
    let contender;
    let release;
    try {
      await holder.waitFor("held");
      contender = localHookChild(fixture, "contender", "waiting-local-hook");
      const boundary = await contender.waitFor("contended");
      assert.equal(boundary.scope, "session");
      release = setTimeout(() => holder.child.stdin.end("g"), 400);
      const [held, waited] = await Promise.all([holder.finish(), contender.finish()]);
      assert.equal(held.held, true);
      assert.equal(waited.contended, true);
      assert.deepEqual(held.output, {});
      assert.deepEqual(waited.output, {});
      assert.deepEqual(readFileSync(attachmentPath), before);
      const records = readFileSync(path.join(fixture.cwd, ".supervised-worker", "runs", `${sha256(fixture.input.session_id)}.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
      const starts = records.filter((record) => record.event === "tool_started");
      assert.equal(starts.length, 2);
      assert.equal(new Set(starts.map((record) => record.operationId)).size, 2);
    } finally {
      clearTimeout(release);
      for (const actor of [holder, contender].filter(Boolean)) {
        if (actor.child.exitCode === null && actor.child.signalCode === null) actor.child.kill();
      }
      await Promise.all([holder, contender].filter(Boolean).map((actor) => actor.exited));
    }
  });
});

test("local hook lock scopes share one monotonic acquisition budget", async () => {
  await withLocalFixture(async (fixture) => {
    admitLocalFixture(fixture);
    const actor = localHookChild(fixture, "shared-budget", "bounded-local-hook");
    const result = await actor.finish();
    assert.equal(result.output.permissionDecision, "deny");
    assert.match(result.output.permissionDecisionReason, /LIFECYCLE_ACQUISITION_CONTENTION/);
    assert.deepEqual(result.attempts, { session: 2, journal: 1 });
  });
});

test("Windows local hooks allow seven-and-a-half seconds of acquisition contention", { skip: process.platform !== "win32" }, async () => {
  await withLocalFixture(async (fixture) => {
    admitLocalFixture(fixture);
    const actor = localHookChild(fixture, "extended-budget", "extended-local-hook");
    const result = await actor.finish();
    assert.deepEqual(result.output, {});
    assert.deepEqual(result.attempts, { session: 2, journal: 1 });
  });
});

test("Windows local hooks still deny contention past ten seconds", { skip: process.platform !== "win32" }, async () => {
  await withLocalFixture(async (fixture) => {
    admitLocalFixture(fixture);
    const actor = localHookChild(fixture, "extended-ceiling", "bounded-local-hook-ceiling");
    const result = await actor.finish();
    assert.equal(result.output.permissionDecision, "deny");
    assert.match(result.output.permissionDecisionReason, /LIFECYCLE_ACQUISITION_CONTENTION/);
    assert.deepEqual(result.attempts, { session: 1, journal: 0 });
  });
});

test("eight concurrent installed local hooks preserve one owner and distinct admitted starts", {
  skip: process.env.SW_NATIVE_PARALLEL_SOAK !== "1",
}, async () => {
  await withLocalFixture(async (fixture) => {
    admitLocalFixture(fixture);
    const attachmentPath = path.join(fixture.cwd, ".supervised-worker", "attachment.json");
    const before = readFileSync(attachmentPath);
    const actors = Array.from({ length: 8 }, (_, ordinal) => localHookChild(fixture, "ordinary", `native-batch-${ordinal}`));
    try {
      const results = await Promise.all(actors.map((actor) => actor.finish()));
      assert.ok(results.some((result) => result.contended), "The parallel test must reach real session-lock contention");
      for (const result of results) assert.deepEqual(result.output, {});
      assert.deepEqual(readFileSync(attachmentPath), before);
      const records = readFileSync(path.join(fixture.cwd, ".supervised-worker", "runs", `${sha256(fixture.input.session_id)}.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
      const starts = records.filter((record) => record.event === "tool_started");
      assert.equal(starts.length, actors.length);
      assert.equal(new Set(starts.map((record) => record.operationId)).size, actors.length);
      assert.equal(new Set(starts.map((record) => record.invocationHash)).size, actors.length);
    } finally {
      for (const actor of actors) {
        if (actor.child.exitCode === null && actor.child.signalCode === null) actor.child.kill();
      }
      await Promise.all(actors.map((actor) => actor.exited));
    }
  });
});

test("local hook exhausted overlap never reclaims or rewrites a live owner", async () => {
  await withLocalFixture(async (fixture) => {
    admitLocalFixture(fixture);
    const lock = path.join(fixture.storage, "supervised-worker", "session-locks", sha256(fixture.input.session_id));
    const token = randomUUID();
    mkdirSync(lock);
    const ownerPath = path.join(lock, `${token}.json`);
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, token, processId: process.pid, acquiredAt: new Date().toISOString() }));
    writeFileSync(ownerPath, bytes);
    const actor = localHookChild(fixture, "exhaust-live-owner", "unreclaimable-local-hook");
    const result = await actor.finish();
    assert.equal(result.output.permissionDecision, "deny");
    assert.match(result.output.permissionDecisionReason, /LIFECYCLE_OWNER_LIVE/);
    assert.equal(result.contended, true);
    assert.equal(result.attempts.session, 1);
    assert.deepEqual(readFileSync(ownerPath), bytes);
  });
});

test("local admission requires exact workflow acceptance and labels its limited provenance", () => {
  withLocalFixture(({ cwd, input, installRoot, accept }) => {
    assert.throws(() => verifyWorkerAuthority(cwd, input, installRoot, ""), /accepted workflow hash/);
    accept();
    const authority = verifyWorkerAuthority(cwd, input, installRoot, "");
    assert.equal(authority.assurance, "local-scoped");
    assert.equal(authority.provenance, "accepted-plugin-session");
    assert.equal(Object.hasOwn(authority, "complete"), false);
    assert.equal(Object.hasOwn(authority, "providerSealed"), false);
    assert.doesNotThrow(() => requireVerifiedWorkerAuthority(authority, cwd, input));
    assert.throws(() => requireVerifiedWorkerAuthority({ ...authority }, cwd, input), /verified/);
    assert.throws(() => requireVerifiedWorkerAuthority(authority, cwd, { ...input, session_id: "other" }), /session-bound/);
  });
});

test("local assurance is never selected by missing host evidence or a legacy workflow", () => {
  withLocalFixture(({ cwd, workflow, workflowPath, input, installRoot, accept }) => {
    delete workflow.authority.assurance;
    writeFileSync(workflowPath, JSON.stringify(workflow));
    accept();
    assert.equal(resolveWorkflowRoles(cwd).authorityAssurance, "host-attested");
    assert.throws(() => verifyWorkerAuthority(cwd, input, installRoot, ""), /trusted host authority inventory is unavailable/);
  });
});

test("local admission rejects checkout code and malformed or linked session locators", () => {
  withLocalFixture(({ base, cwd, input, installRoot, accept }) => {
    accept();
    assert.throws(() => verifyWorkerAuthority(cwd, input, sourceRoot, ""), /immutable/);
    for (const request of [
      { session_id: input.session_id },
      { ...input, session_id: "" },
      { ...input, session_id: "different" },
      { ...input, transcript_path: "relative.jsonl" },
      { ...input, transcript_path: path.join(base, "local-worker.jsonl") },
    ]) assert.throws(() => verifyWorkerAuthority(cwd, request, installRoot, ""));
    linkSync(input.transcript_path, path.join(base, "linked-transcript"));
    assert.throws(() => verifyWorkerAuthority(cwd, input, installRoot, ""), /single-link/);
  });
});

test("local authority survives transcript append but rejects workflow and workspace drift", () => {
  withLocalFixture(({ cwd, workflowPath, storage, input, installRoot, accept }) => {
    accept();
    const authority = verifyWorkerAuthority(cwd, input, installRoot, "");
    appendFileSync(input.transcript_path, '{"type":"tool.completed"}\n');
    assert.doesNotThrow(() => requireVerifiedWorkerAuthority(authority, cwd, input));
    writeFileSync(path.join(storage, "workspace.json"), '{"changed":true}');
    assert.throws(() => requireVerifiedWorkerAuthority(authority, cwd, input), /changed/);
    writeFileSync(path.join(storage, "workspace.json"), "{}\n");
    appendFileSync(workflowPath, "\n");
    assert.throws(() => requireVerifiedWorkerAuthority(authority, cwd, input), /accepted workflow hash/);
  });
});

test("local authority matches established Windows transcript casing rules", { skip: process.platform !== "win32" }, () => {
  withLocalFixture(({ cwd, input, installRoot, accept }) => {
    accept();
    const canonical = verifyWorkerAuthority(cwd, input, installRoot, "");
    const alias = { ...input, transcript_path: input.transcript_path.toUpperCase() };
    assert.equal(observeCampaignTransition(cwd, alias).state, "released");
    const aliased = verifyWorkerAuthority(cwd, alias, installRoot, "");
    assert.equal(aliased.grantHash, canonical.grantHash);
    assert.doesNotThrow(() => requireVerifiedWorkerAuthority(canonical, cwd, alias));
  });
});

test("installed local CLI publishes a plan and its real hook enforces Stop without a host inventory", () => {
  withLocalFixture(({ cwd, input, installRoot, accept }) => {
    accept();
    const env = { ...process.env };
    delete env.SUPERVISED_WORKER_HOST_AUTHORITY;
    const invoke = (args, request) => {
      const result = spawnSync(process.execPath, [path.join(installRoot, "src", "cli.mjs"), ...args], {
        cwd, input: JSON.stringify(request), encoding: "utf8", timeout: 20_000, env,
      });
      assert.equal(result.error, undefined);
      return { code: result.status, value: JSON.parse(result.stdout) };
    };
    const request = { session_id: input.session_id, transcript_path: input.transcript_path };
    const before = invoke(["lifecycle", "observe"], request);
    assert.equal(before.code, 0);
    const plan = { schemaVersion: 1, mode: "active", goal: "Complete the bounded local queue.",
      items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
    const applied = invoke(["lifecycle", "plan"], { ...request, expected: before.value, plan });
    assert.equal(applied.value.status, "applied", JSON.stringify(applied));
    assert.deepEqual(invoke(["status"], {}).value.assurance, {
      requested: "local-scoped", workflowAcceptance: "accepted",
      hostInventory: "not-checked", providerCompletion: "not-checked",
    });
    assert.equal(invoke(["hook", "Stop"], input).value.decision, "block");
    assert.deepEqual(invoke(["hook", "Stop"], { ...input, session_id: "ordinary" }).value, {});
    assert.equal(invoke(["lifecycle", "plan"], { ...request, expected: before.value, plan }).value.status, "conflict");
  });
});

test("status distinguishes unaccepted workflows and bundled defaults from failed verification", () => {
  withLocalFixture(({ cwd, workflowPath, installRoot }) => {
    const status = () => {
      const result = spawnSync(process.execPath, [path.join(installRoot, "src", "cli.mjs"), "status"], {
        cwd, encoding: "utf8", timeout: 20_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      return JSON.parse(result.stdout).assurance;
    };
    assert.deepEqual(status(), {
      requested: "local-scoped", workflowAcceptance: "required",
      hostInventory: "not-checked", providerCompletion: "not-checked",
    });
    rmSync(workflowPath);
    assert.deepEqual(status(), {
      requested: "host-attested", workflowAcceptance: "not-required",
      hostInventory: "not-checked", providerCompletion: "not-checked",
    });
    writeFileSync(workflowPath, "{");
    assert.equal(status().workflowAcceptance, "invalid");
  });
});

test("admitted local sessions cannot silently execute after workflow authority is revoked", () => {
  withLocalFixture(({ cwd, input, installRoot, workflowPath, accept }) => {
    accept();
    const authority = verifyWorkerAuthority(cwd, input, installRoot, "");
    const plan = { schemaVersion: 1, mode: "active", goal: "Keep governed execution.",
      items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
    const request = { session_id: input.session_id, transcript_path: input.transcript_path };
    applyCampaignPlan(cwd, { ...request, expected: observeCampaignTransition(cwd, request), plan }, authority);
    appendFileSync(workflowPath, "\n");
    const denied = handlePluginHook({ ...input, tool_name: "Read", tool_input: { file_path: path.join(cwd, "README.md") } }, "PreToolUse", installRoot);
    assert.equal(denied.permissionDecision, "deny");
    assert.match(denied.permissionDecisionReason, /unchanged accepted authority/);
    assert.match(handlePluginHook(input, "Stop", installRoot).systemMessage, /No campaign completion/);
  });
});

test("local checkpoint resumes in a fresh session and fences both competing and old sessions", () => {
  withLocalFixture(({ cwd, input, installRoot, accept }) => {
    accept();
    const authority = verifyWorkerAuthority(cwd, input, installRoot, "");
    const request = { session_id: input.session_id, transcript_path: input.transcript_path };
    const plan = { schemaVersion: 1, mode: "active", goal: "Continue the local campaign.",
      items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
    const admitted = applyCampaignPlan(cwd, { ...request, expected: observeCampaignTransition(cwd, request), plan }, authority);
    const next = { session_id: "local-successor", transcript_path: path.join(path.dirname(input.transcript_path), "local-successor.jsonl") };
    writeFileSync(next.transcript_path, "");
    const successorAuthority = verifyWorkerAuthority(cwd, next, installRoot, "");
    assert.throws(() => applyCampaignPlan(cwd, { ...next, expected: observeCampaignTransition(cwd, next), plan }, successorAuthority), /owning Worker/);
    const checkpointRequest = { ...request, planHash: canonicalPlanHash(plan), attachmentHash: admitted.observation.attachmentHash };
    const checkpoint = checkpointSession(cwd, checkpointRequest, authority);
    assert.equal(checkpoint.status, "checkpointed");
    assert.equal(JSON.parse(readFileSync(path.join(cwd, ".supervised-worker", "plan.json"))).mode, "active");
    const resumeRequest = { ...next, planHash: checkpoint.planHash, checkpointHash: checkpoint.checkpointHash };
    const resumed = resumeSession(cwd, resumeRequest, successorAuthority);
    assert.equal(resumed.status, "resumed");
    assert.notEqual(observeCampaignTransition(cwd, next).claimGeneration, admitted.observation.claimGeneration);
    assert.deepEqual(resumeSession(cwd, resumeRequest, successorAuthority), resumed);
    assert.throws(() => checkpointSession(cwd, checkpointRequest, authority), /does not own/);
    assert.throws(() => applyCampaignPlan(cwd, { ...request, expected: observeCampaignTransition(cwd, request), plan }, authority), /owning Worker/);
  });
});

test("local Doctor recovers an exact dead owner once and retains the original recovery evidence", () => {
  withLocalFixture(({ cwd, input, installRoot, accept }) => {
    accept();
    const authority = verifyWorkerAuthority(cwd, input, installRoot, "");
    const request = { session_id: input.session_id, transcript_path: input.transcript_path };
    const plan = { schemaVersion: 1, mode: "active", goal: "Recover the local campaign.",
      items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
    applyCampaignPlan(cwd, { ...request, expected: observeCampaignTransition(cwd, request), plan }, authority);
    const child = spawnSync(process.execPath, ["--eval", ""], { encoding: "utf8", timeout: 20_000 });
    assert.equal(child.status, 0);
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    const token = randomUUID();
    const lock = path.join(cwd, ".supervised-worker", "locks", "lifecycle");
    mkdirSync(lock);
    const ownerBytes = JSON.stringify({ schemaVersion: 1, token, processId: child.pid, acquiredAt: new Date().toISOString() });
    writeFileSync(path.join(lock, `${token}.json`), ownerBytes);
    const incidentId = randomUUID();
    const detected = detectDoctorIncident(cwd, request, incidentId, sha256("local-dead-owner"), authority);
    const intentFor = (incident, action, inputHashes = []) => {
      const grant = grantDoctorAction(cwd, request, incidentId, { action, actionId: randomUUID(), expectedHash: doctorHash(incident) }, authority);
      return { schemaVersion: 1, kind: "doctor-repair-intent", binding: incident.binding, attemptId: incident.attemptId,
        actionId: grant.capability.actionId, action, capabilityHash: grant.hash, expectedHash: doctorHash(incident), inputHashes };
    };
    const inspected = executeDoctorIntent(cwd, request, intentFor(detected.incident, "inspect"), authority);
    assert.equal(inspected.status, "succeeded");
    assert.equal(inspected.values[0].diagnostics[0].code, "LIFECYCLE_OWNER_DEAD");
    const current = inspectDoctorIncident(cwd, request, incidentId, authority).incident;
    const intent = intentFor(current, "recover", inspected.outcome.outputHashes);
    const recovered = executeDoctorIntent(cwd, request, intent, authority);
    assert.equal(recovered.status, "succeeded", JSON.stringify(recovered));
    assert.equal(existsSync(lock), false);
    assert.equal(readFileSync(path.join(`${lock}.${token}.recovered`, `${token}.json`), "utf8"), ownerBytes);
    assert.equal(executeDoctorIntent(cwd, request, intent, authority).status, "replayed");
    const observed = observeCampaignTransition(cwd, request);
    assert.equal(observed.state, "active");
    assert.equal(applyCampaignPlan(cwd, { ...request, expected: observed, plan }, authority).status, "applied");
  });
});