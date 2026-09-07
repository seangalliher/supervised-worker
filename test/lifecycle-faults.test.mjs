import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testModuleUrl = import.meta.url;
const coreUrl = new URL("../src/core.mjs", testModuleUrl).href;

function runIsolated(script, timeout = 10_000) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function filesystemPrelude(sessionId) {
  return `
    import assert from "node:assert/strict";
    import { createRequire, syncBuiltinESMExports } from "node:module";
    import os from "node:os";
    import path from "node:path";
    const require = createRequire(${JSON.stringify(testModuleUrl)});
    const fs = require("node:fs");
    const base = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "supervised-worker-fault-")),
    );
    const pluginRoot = path.join(base, "plugin");
    const repositoryRoot = path.join(base, "repository");
    const storageRoot = path.join(base, "storage");
    for (const directory of [pluginRoot, repositoryRoot, storageRoot]) {
      fs.mkdirSync(directory);
    }
    const sessionId = ${JSON.stringify(sessionId)};
    const transcriptDirectory = path.join(storageRoot, "GitHub.copilot-chat", "transcripts");
    fs.mkdirSync(transcriptDirectory, { recursive: true });
    fs.writeFileSync(path.join(storageRoot, "workspace.json"), "{}\\n");
    const transcriptPath = path.join(transcriptDirectory, sessionId + ".jsonl");
    fs.writeFileSync(transcriptPath, "");
    const originalRenameSync = fs.renameSync;
    const originalAppendFileSync = fs.appendFileSync;
    const originalRmSync = fs.rmSync;
    const originalMkdirSync = fs.mkdirSync;
    const originalExistsSync = fs.existsSync;
    const originalLstatSync = fs.lstatSync;
    const originalReadFileSync = fs.readFileSync;
    const originalReaddirSync = fs.readdirSync;
    const originalWriteFileSync = fs.writeFileSync;
    const originalRmdirSync = fs.rmdirSync;
    const originalOpenSync = fs.openSync;
    const originalCloseSync = fs.closeSync;
    const originalFsyncSync = fs.fsyncSync;
    const originalReadSync = fs.readSync;
  `;
}

function filesystemCleanup() {
  return `
    } finally {
      fs.renameSync = originalRenameSync;
      fs.appendFileSync = originalAppendFileSync;
      fs.rmSync = originalRmSync;
      fs.mkdirSync = originalMkdirSync;
      fs.existsSync = originalExistsSync;
      fs.lstatSync = originalLstatSync;
      fs.readFileSync = originalReadFileSync;
      fs.readdirSync = originalReaddirSync;
      fs.writeFileSync = originalWriteFileSync;
      fs.rmdirSync = originalRmdirSync;
      fs.openSync = originalOpenSync;
      fs.closeSync = originalCloseSync;
      fs.fsyncSync = originalFsyncSync;
      fs.readSync = originalReadSync;
      syncBuiltinESMExports();
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  `;
}

function checkpointFaultSetup(includeStop = true, routed = true) {
  return `
    const { canonicalPlanHash, checkpointSession, handleHook, planPath, releaseAttachment, resumeSession, sha256, summarizePlan, summarizeRunLedger } = await import(${JSON.stringify(coreUrl)});
    const input = { cwd: repositoryRoot, session_id: sessionId, ${routed ? "transcript_path: transcriptPath," : ""}
      tool_name: "Write", tool_use_id: "setup-plan", tool_input: { file_path: planPath(repositoryRoot) } };
    assert.deepEqual(handleHook(input, "PreToolUse"), {});
    const plan = { schemaVersion: 1, mode: "active", goal: "PRIVATE_GOAL", items: [{ id: "item", title: "PRIVATE_TITLE", status: "pending" }], completion: null };
    fs.writeFileSync(planPath(repositoryRoot), JSON.stringify(plan));
    assert.deepEqual(handleHook(input, "PostToolUse"), {});
    ${includeStop ? 'assert.equal(handleHook({ ...input, stop_hook_active: false }, "Stop").decision, "block");' : ""}
    const attachmentFile = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
    const attachmentBefore = originalReadFileSync(attachmentFile);
    assert.equal(JSON.parse(attachmentBefore).status, "active");
    const planBefore = originalReadFileSync(planPath(repositoryRoot));
    const routeFile = path.join(storageRoot, "supervised-worker", "session-roots", sha256(sessionId), "route.json");
    ${routed ? 'assert.equal(JSON.parse(originalReadFileSync(routeFile)).status, "active");' : ""}
    const ledgerFile = path.join(repositoryRoot, ".supervised-worker", "runs", sha256(sessionId) + ".jsonl");
    const baseline = originalReadFileSync(ledgerFile, "utf8").trim().split("\\n").map(JSON.parse);
    assert.equal(baseline.filter((record) => record.event === "tool_started").length, 1);
    const request = { session_id: sessionId, ${routed ? "transcript_path: transcriptPath," : ""} planHash: canonicalPlanHash(plan), attachmentHash: sha256(attachmentBefore) };
    const descriptorPaths = new Map();
    fs.openSync = (filePath, ...args) => {
      const descriptor = originalOpenSync(filePath, ...args);
      descriptorPaths.set(descriptor, path.resolve(String(filePath)));
      return descriptor;
    };
    fs.closeSync = (descriptor) => {
      descriptorPaths.delete(descriptor);
      return originalCloseSync(descriptor);
    };
    const inReceipts = (filePath) => String(filePath).includes(path.sep + "checkpoints" + path.sep);
    const inRuns = (filePath) => String(filePath).includes(path.sep + "runs" + path.sep);
    syncBuiltinESMExports();
  `;
}

test("routine observations avoid the repository lifecycle lock", () => {
  runIsolated(`
    ${filesystemPrelude("routine-journal-boundary")}
    try {
      ${checkpointFaultSetup(false)}
      const lifecycleDirectory = path.join(repositoryRoot, ".supervised-worker", "locks", "lifecycle");
      let repositoryLockAttempts = 0;
      fs.mkdirSync = (directory, ...options) => {
        if (path.resolve(String(directory)) === lifecycleDirectory) {
          repositoryLockAttempts += 1;
          throw Object.assign(new Error("fixture lifecycle unavailable"), { code: "EACCES", syscall: "mkdir" });
        }
        return originalMkdirSync(directory, ...options);
      };
      syncBuiltinESMExports();
      const observation = { ...input, tool_name: "read_file", tool_use_id: "routine-observation",
        tool_input: { filePath: path.join(repositoryRoot, "README.md") } };
      const started = handleHook(observation, "PreToolUse");
      assert.equal(repositoryLockAttempts, 0, "routine observation must not enter lifecycle acquisition");
      assert.deepEqual(started, {});
      assert.deepEqual(handleHook(observation, "PostToolUse"), {});
      const targetless = { cwd: repositoryRoot, session_id: sessionId, transcript_path: transcriptPath };
      assert.deepEqual(handleHook({ ...targetless, trigger: "manual" }, "PreCompact"), {});
      assert.match(JSON.stringify(handleHook(targetless, "SessionStart")), /durable Supervised Worker plan is active/);
      assert.equal(repositoryLockAttempts, 0);
      const records = originalReadFileSync(ledgerFile, "utf8").trim().split("\\n").map(JSON.parse);
      const start = records.find((record) => record.event === "tool_started" && record.toolName === "read_file");
      assert.ok(start);
      const completion = records.find((record) => record.event === "tool_completed" && record.operationId === start.operationId);
      assert.ok(completion);
      assert.equal(completion.invocationHash, start.invocationHash);
      assert.equal(completion.routeGeneration, start.routeGeneration);
      assert.equal(completion.claimGeneration, start.claimGeneration);
      assert.equal(completion.session, start.session);
      assert.equal(handleHook({ ...input, tool_use_id: "guarded-plan-write" }, "PreToolUse").permissionDecision, "deny");
      assert.equal(repositoryLockAttempts, 1, "plan mutation must still require its lifecycle guard");
      assert.deepEqual(originalReadFileSync(attachmentFile), attachmentBefore);
    ${filesystemCleanup()}
  `);
});

const journalHookChildProgram = String.raw`
  import assert from "node:assert/strict";
  import fs from "node:fs";
  import path from "node:path";
  import { syncBuiltinESMExports } from "node:module";
  import { performance } from "node:perf_hooks";

  const options = JSON.parse(process.argv[1]);
  const core = await import(options.coreUrl);
  const journalDirectory = path.join(options.input.cwd, ".supervised-worker", "locks", "journal");
  const ledgerFile = path.join(options.input.cwd, ".supervised-worker", "runs", core.sha256(options.input.session_id) + ".jsonl");
  const originalMkdir = fs.mkdirSync;
  const originalAppend = fs.appendFileSync;
  const originalRename = fs.renameSync;
  const publications = [];
  let contentionReported = false;
  let contentionReleased = false;
  let held = false;
  const emit = (message) => fs.writeSync(1, JSON.stringify(message) + "\n");
  if (options.holdContention) {
    let monotonicTime = 0;
    const originalWait = Atomics.wait;
    Object.defineProperty(performance, "now", { value: () => monotonicTime });
    Atomics.wait = (cell, index, expected, timeout) => {
      const result = originalWait(cell, index, expected, timeout);
      monotonicTime += Math.max(1, Number(timeout) || 0);
      return result;
    };
  }

  fs.mkdirSync = (directory, ...args) => {
    try {
      return originalMkdir(directory, ...args);
    } catch (error) {
      if (!contentionReported && error.code === "EEXIST" && path.resolve(String(directory)) === journalDirectory) {
        contentionReported = true;
        const entries = fs.readdirSync(journalDirectory);
        assert.equal(entries.length, 1);
        const owner = JSON.parse(fs.readFileSync(path.join(journalDirectory, entries[0]), "utf8"));
        emit({ type: "contended", scope: "journal", owner });
        if (options.holdContention) {
          const release = Buffer.alloc(1);
          assert.equal(fs.readSync(0, release, 0, 1, null), 1, "contender requires a parent pipe byte");
          assert.equal(release[0], 0x67);
          assert.equal(fs.existsSync(journalDirectory), false, "first owner must finish cleanup before contender release");
          contentionReleased = true;
        }
      }
      throw error;
    }
  };
  fs.appendFileSync = (filePath, bytes, ...args) => {
    if (!held && options.holdEvent !== null && path.dirname(String(filePath)) === path.dirname(ledgerFile)) {
      const record = JSON.parse(String(bytes));
      if (record.event === options.holdEvent) {
        held = true;
        assert.equal(fs.existsSync(journalDirectory), true);
        emit({ type: "held", record });
        const release = Buffer.alloc(1);
        assert.equal(fs.readSync(0, release, 0, 1, null), 1, "publication gate requires a parent pipe byte");
        assert.equal(release[0], 0x67, "publication gate requires its explicit release");
      }
    }
    return originalAppend(filePath, bytes, ...args);
  };
  fs.renameSync = (source, destination) => {
    if (path.resolve(String(destination)) !== ledgerFile) return originalRename(source, destination);
    const record = JSON.parse(fs.readFileSync(source, "utf8").trimEnd().split("\n").at(-1));
    const result = originalRename(source, destination);
    publications.push(record);
    return result;
  };
  syncBuiltinESMExports();
  const output = options.eventName === "checkpoint"
    ? core.checkpointSession(options.input.cwd, options.input.request)
    : options.eventName === "helper"
    ? core.observeHandoffValidation(options.input.cwd, options.input.filePath, options.input.request)
    : core.handleHook(options.input, options.eventName);
  emit({ type: "result", output, publications, held, contentionReleased });
`;

function journalHookChildrenSetup() {
  return `
    const { spawn } = await import("node:child_process");
    const children = [];
    const startHookChild = (hookInput, eventName, holdEvent = null, holdContention = false) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval",
        ${JSON.stringify(journalHookChildProgram)},
        JSON.stringify({ coreUrl: ${JSON.stringify(coreUrl)}, input: hookInput, eventName, holdEvent, holdContention })],
        { cwd: repositoryRoot, stdio: ["pipe", "pipe", "pipe"] });
      const messages = [];
      const waiters = [];
      let output = "";
      let stderr = "";
      let failure = null;
      let closed = false;
      let resolveExit;
      const exited = new Promise((resolve) => { resolveExit = resolve; });
      const notify = () => {
        for (const resolve of waiters.splice(0)) resolve();
      };
      const fail = (error) => {
        failure ??= error;
        notify();
      };
      const watchdog = setTimeout(() => {
        fail(new Error("hook child watchdog expired before its acknowledged exit"));
        child.kill();
      }, 30_000);
      child.once("error", fail);
      child.stdin.on("error", fail);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        let newline;
        while ((newline = output.indexOf("\\n")) !== -1) {
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          try {
            messages.push(JSON.parse(line));
          } catch (error) {
            fail(error);
          }
        }
        notify();
      });
      child.once("close", (code, signal) => {
        clearTimeout(watchdog);
        closed = true;
        resolveExit({ code, signal });
        notify();
      });
      const actor = {
        child, exited,
        async waitFor(type) {
          for (;;) {
            if (failure !== null) throw failure;
            const message = messages.find((entry) => entry.type === type);
            if (message !== undefined) return message;
            assert.equal(closed, false, "child exited before reaching " + type + ": " + stderr);
            await new Promise((resolve) => waiters.push(resolve));
          }
        },
        release() { child.stdin.write("g"); },
        async finish(expectedOutput = {}) {
          const exit = await exited;
          assert.equal(failure, null, failure?.message);
          assert.equal(exit.signal, null, stderr);
          assert.equal(exit.code, 0, stderr);
          assert.equal(output, "", "child output must end at a complete message boundary");
          const results = messages.filter((message) => message.type === "result");
          assert.equal(results.length, 1, "each child must acknowledge exactly one hook decision");
          if (expectedOutput !== null) assert.deepEqual(results[0].output, expectedOutput);
          assert.equal(results[0].held, holdEvent !== null, "requested publication boundary must be reached");
          assert.equal(results[0].contentionReleased, holdContention, "requested contender boundary must be released");
          return results[0];
        },
      };
      children.push(actor);
      return actor;
    };
    const stopHookChildren = async () => {
      for (const actor of children) {
        if (actor.child.exitCode === null && actor.child.signalCode === null) {
          actor.child.stdin.end();
          actor.child.kill();
        }
      }
      await Promise.all(children.map((actor) => actor.exited));
    };
    const readRecords = () => originalReadFileSync(ledgerFile, "utf8").trim().split("\\n").map(JSON.parse);
    const owner = JSON.parse(attachmentBefore);
    const observation = (hostId) => ({ ...input, tool_name: "read_file", tool_use_id: hostId,
      tool_input: { filePath: path.join(repositoryRoot, hostId + ".txt") } });
    const assertStart = (record, tool) => {
      assert.equal(record.event, "tool_started");
      assert.equal(record.session, sha256(tool.session_id));
      assert.equal(record.routeGeneration, owner.routeGeneration);
      assert.equal(record.claimGeneration, owner.claimGeneration);
      assert.notEqual(record.claimGeneration, null);
      assert.equal(record.invocationHash, sha256("supervised-worker-tool-invocation-v1\\0" + tool.tool_use_id));
      assert.equal(record.toolName, tool.tool_name);
      assert.match(record.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    };
    const assertCompletion = (record, start) => {
      assert.equal(record.event, "tool_completed");
      assert.equal(record.success, true);
      for (const key of ["operationId", "invocationHash", "session", "routeGeneration", "claimGeneration", "toolName"]) {
        assert.equal(record[key], start[key], key + " must match the acknowledged start");
      }
      assert.match(record.observationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    };
    const assertPublications = (before, publications) => {
      const suffix = Buffer.from(publications.map((record) => JSON.stringify(record) + "\\n").join(""));
      assert.deepEqual(originalReadFileSync(ledgerFile), Buffer.concat([before, suffix]),
        "all acknowledged publications and the original prefix must survive byte-for-byte");
    };
    const overlap = async (firstInput, firstEvent, heldEvent, secondInput, secondEvent) => {
      const first = startHookChild(firstInput, firstEvent, heldEvent);
      const boundary = await first.waitFor("held");
      assert.equal(boundary.record.event, heldEvent);
      const second = startHookChild(secondInput, secondEvent, null, true);
      const contention = await second.waitFor("contended");
      assert.equal(contention.scope, "journal", "the contender must reach the actual journal mkdir EEXIST");
      assert.equal(contention.owner.processId, first.child.pid, "contention must observe the first child owner");
      first.release();
      const firstResult = await first.finish();
      second.release();
      const secondResult = await second.finish();
      assert.deepEqual(firstResult.publications, [boundary.record]);
      return [firstResult, secondResult];
    };
  `;
}

test("multiprocess journal serial hook children acknowledge exact records", () => {
  runIsolated(`
    ${filesystemPrelude("multiprocess-journal-serial")}
    try {
      ${checkpointFaultSetup(false)}
      ${journalHookChildrenSetup()}
      try {
        assert.notEqual(owner.routeGeneration, null);
        const tool = observation("serial-operation");
        const before = originalReadFileSync(ledgerFile);
        const pre = startHookChild(tool, "PreToolUse", "tool_started");
        const startBoundary = await pre.waitFor("held");
        assertStart(startBoundary.record, tool);
        assert.deepEqual(originalReadFileSync(ledgerFile), before, "start is not acknowledged before publication");
        pre.release();
        const started = await pre.finish();
        assert.deepEqual(started.publications, [startBoundary.record]);
        assertPublications(before, started.publications);

        const admitted = originalReadFileSync(ledgerFile);
        const post = startHookChild(tool, "PostToolUse", "tool_completed");
        const completionBoundary = await post.waitFor("held");
        assertCompletion(completionBoundary.record, startBoundary.record);
        assert.deepEqual(originalReadFileSync(ledgerFile), admitted);
        post.release();
        const completed = await post.finish();
        assert.deepEqual(completed.publications, [completionBoundary.record]);
        assertPublications(before, [...started.publications, ...completed.publications]);
        const records = readRecords();
        assert.equal(records.filter((record) => record.event === "tool_started" &&
          record.invocationHash === startBoundary.record.invocationHash).length, 1);
        assert.equal(records.filter((record) => record.event === "tool_completed" &&
          record.operationId === startBoundary.record.operationId).length, 1);
      } finally {
        await stopHookChildren();
      }
    ${filesystemCleanup()}
  `, 60_000);
});

test("multiprocess journal forced overlap preserves starts and makes duplicate Posts idempotent", () => {
  runIsolated(`
    ${filesystemPrelude("multiprocess-journal-overlap")}
    try {
      ${checkpointFaultSetup(false, false)}
      ${journalHookChildrenSetup()}
      try {
        assert.equal(owner.routeGeneration, null);
        const firstTool = observation("parallel-first");
        const secondTool = observation("parallel-second");
        const before = originalReadFileSync(ledgerFile);
        const starts = await overlap(firstTool, "PreToolUse", "tool_started", secondTool, "PreToolUse");
        assert.equal(starts[1].publications.length, 1);
        const firstStart = starts[0].publications[0];
        const secondStart = starts[1].publications[0];
        assertStart(firstStart, firstTool);
        assertStart(secondStart, secondTool);
        assert.notEqual(firstStart.operationId, secondStart.operationId);
        assert.notEqual(firstStart.invocationHash, secondStart.invocationHash);
        assertPublications(before, [firstStart, secondStart]);

        const posts = await overlap(firstTool, "PostToolUse", "tool_completed", firstTool, "PostToolUse");
        assert.deepEqual(posts[1].publications, [], "the simultaneous duplicate Post must not publish another observation");
        const firstCompletion = posts[0].publications[0];
        assertCompletion(firstCompletion, firstStart);
        const last = await startHookChild(secondTool, "PostToolUse").finish();
        assert.equal(last.publications.length, 1);
        const secondCompletion = last.publications[0];
        assertCompletion(secondCompletion, secondStart);
        assert.notEqual(firstCompletion.observationId, secondCompletion.observationId);
        assertPublications(before, [firstStart, secondStart, firstCompletion, secondCompletion]);
        const records = readRecords();
        for (const start of [firstStart, secondStart]) {
          assert.equal(records.filter((record) => record.event === "tool_started" &&
            record.invocationHash === start.invocationHash).length, 1);
          assert.equal(records.filter((record) => record.event === "tool_completed" &&
            record.operationId === start.operationId).length, 1);
        }
      } finally {
        await stopHookChildren();
      }
    ${filesystemCleanup()}
  `, 60_000);
});

for (const legacyFirst of [true, false]) {
  test(`multiprocess journal serializes legacy and durable writers (legacyFirst=${legacyFirst})`, () => {
    runIsolated(`
      ${filesystemPrelude(`multiprocess-journal-legacy-${legacyFirst}`)}
      try {
        ${checkpointFaultSetup(false, false)}
        ${journalHookChildrenSetup()}
        try {
          const tool = observation("legacy-interleaved-operation");
          const compact = { ...input, trigger: "manual" };
          const before = originalReadFileSync(ledgerFile);
          const legacyFirst = ${legacyFirst};
          const results = legacyFirst
            ? await overlap(compact, "PreCompact", "pre_compact", tool, "PreToolUse")
            : await overlap(tool, "PreToolUse", "tool_started", compact, "PreCompact");
          assert.equal(results[1].publications.length, 1);
          const publications = results.flatMap((result) => result.publications);
          assert.deepEqual(publications.map((record) => record.event),
            legacyFirst ? ["pre_compact", "tool_started"] : ["tool_started", "pre_compact"]);
          const legacy = publications.find((record) => record.event === "pre_compact");
          assert.equal(legacy.session, owner.sessionHash);
          assert.equal(legacy.trigger, "manual");
          const start = publications.find((record) => record.event === "tool_started");
          assertStart(start, tool);
          assertPublications(before, publications);
          const completed = await startHookChild(tool, "PostToolUse").finish();
          assert.equal(completed.publications.length, 1);
          assertCompletion(completed.publications[0], start);
          assertPublications(before, [...publications, ...completed.publications]);
        } finally {
          await stopHookChildren();
        }
      ${filesystemCleanup()}
    `, 60_000);
  });
}

for (const checkpointFirst of [true, false]) {
  test(`multiprocess journal checkpoint reconciliation (checkpointFirst=${checkpointFirst})`, () => {
    runIsolated(`
      ${filesystemPrelude(`multiprocess-checkpoint-${checkpointFirst}`)}
      try {
        ${checkpointFaultSetup(false, false)}
        ${journalHookChildrenSetup()}
        try {
          const tool = observation("checkpoint-competing-operation");
          const started = await startHookChild(tool, "PreToolUse").finish();
          const start = started.publications[0];
          assertStart(start, tool);
          const before = originalReadFileSync(ledgerFile);
          const checkpointInput = { ...input, request };
          const first = startHookChild(${checkpointFirst} ? checkpointInput : tool,
            ${checkpointFirst} ? "checkpoint" : "PostToolUse",
            ${checkpointFirst} ? "checkpoint_persisted" : "tool_completed");
          const boundary = await first.waitFor("held");
          assert.equal(boundary.record.event, ${checkpointFirst} ? "checkpoint_persisted" : "tool_completed");
          const second = startHookChild(${checkpointFirst} ? tool : checkpointInput,
            ${checkpointFirst} ? "PostToolUse" : "checkpoint");
          assert.equal((await second.waitFor("contended")).scope, "journal");
          first.release();
          const firstResult = await first.finish(null);
          const secondResult = await second.finish(null);
          const checkpoint = (${checkpointFirst} ? firstResult : secondResult).output;
          assert.equal(checkpoint.status, "checkpointed");
          const receipt = JSON.parse(originalReadFileSync(path.join(repositoryRoot, ".supervised-worker",
            "checkpoints", checkpoint.checkpointHash + ".json")));
          const ledger = originalReadFileSync(ledgerFile);
          const records = readRecords();
          assert.equal(sha256(ledger.subarray(0, receipt.ledgerPosition.byteOffset)), receipt.ledgerPosition.prefixHash);
          assert.equal(records[receipt.ledgerPosition.recordCount].event, "checkpoint_persisted");
          assert.equal(records[receipt.ledgerPosition.recordCount].checkpointHash, checkpoint.checkpointHash);
          const terminals = records.filter((record) => record.event === "tool_completed" && record.operationId === start.operationId);
          assert.equal(terminals.length, ${checkpointFirst ? 0 : 1});
          const orphans = receipt.context.operations.orphans.filter((operation) => operation.operationId === start.operationId);
          assert.equal(orphans.length, ${checkpointFirst ? 1 : 0});
          if (${checkpointFirst}) {
            assert.equal(orphans[0].observationStatus, "outcome-unknown");
            assert.deepEqual(secondResult.publications, []);
            assert.deepEqual(ledger.subarray(0, receipt.ledgerPosition.byteOffset), before);
          } else {
            assertCompletion(terminals[0], start);
            assert.ok(records.indexOf(terminals[0]) < receipt.ledgerPosition.recordCount);
          }
          assert.equal(JSON.parse(originalReadFileSync(attachmentFile)).status, "checkpointed");
          assert.equal(summarizePlan(repositoryRoot).complete, false);
        } finally {
          await stopHookChildren();
        }
      ${filesystemCleanup()}
    `, 60_000);
  });
}

function observedHandoffFaultSetup(kind = "build-report", routed = true) {
  return `
    ${checkpointFaultSetup(false, routed)}
    const { observeHandoffValidation, requestDeniedToolRetry } = await import(${JSON.stringify(coreUrl)});
    const artifactKind = ${JSON.stringify(kind)};
    const itemId = "PRIVATE_HELPER_ITEM";
    const artifactDirectory = path.join(repositoryRoot, ".supervised-worker", "handoffs", sha256(itemId));
    fs.mkdirSync(artifactDirectory, { recursive: true });
    fs.mkdirSync(path.join(repositoryRoot, "src"));
    const inspectedPath = path.join(repositoryRoot, "src", "helper.js");
    fs.writeFileSync(inspectedPath, "PRIVATE_SOURCE_BYTES");
    const common = { schemaVersion: 2, kind: artifactKind, itemId, workflowHash: null,
      createdAt: "2026-09-06T00:00:00.000Z" };
    const artifact = artifactKind === "build-report" ? {
      ...common, producedBy: "supervised-worker:seangalliher-supervised-builder", status: "blocked",
      contractHash: "a".repeat(64), testedTreeHash: null, changedFiles: ["src/helper.js"],
      checks: [], evidence: [], deviations: [], blocker: "PRIVATE_HELPER_RESULT",
    } : {
      ...common, producedBy: "supervised-worker:seangalliher-supervised-architect", status: "approved",
      premise: { claim: "PRIVATE_PREMISE", evidence: [{ kind: "source", locator: "PRIVATE_LOCATOR" }] },
      objective: "PRIVATE_OBJECTIVE", authorityBoundaries: [],
      options: [{ id: "local", summary: "PRIVATE_APPROACH", rank: 1 }], selectedApproach: "local",
      targetFiles: ["src/helper.js"], consumers: ["PRIVATE_CONSUMER"], acceptanceCriteria: ["PRIVATE_CRITERION"],
      focusedChecks: ["PRIVATE_NEVER_EXECUTE"], broadGate: "PRIVATE_NEVER_EXECUTE", exclusions: [], blockedBy: null,
    };
    const artifactPath = path.join(artifactDirectory, artifactKind + ".json");
    fs.writeFileSync(artifactPath, JSON.stringify(artifact));
    const records = () => originalReadFileSync(ledgerFile, "utf8").trim().split("\\n").map(JSON.parse);
    const helperRequest = (hostId, retryOf = null) => ({ session_id: sessionId,
      ${routed ? "transcript_path: transcriptPath," : ""} tool_use_id: hostId, retryOf });
    const startHelper = (hostId) => {
      const parent = { ...input, tool_name: "run_in_terminal", tool_use_id: hostId,
        tool_input: { command: "PRIVATE_ARBITRARY_COMMAND", arguments: ["PRIVATE_ARGUMENT"] } };
      assert.deepEqual(handleHook(parent, "PreToolUse"), {});
      return records().at(-1);
    };
  `;
}

test("observed handoff validation retries once with unchanged inputs", () => {
  runIsolated(`
    ${filesystemPrelude("observed-handoff-once")}
    try {
      ${observedHandoffFaultSetup()}
      const parent = startHelper("PRIVATE_ORIGINAL_HOST");
      const lifecycleDirectory = path.join(repositoryRoot, ".supervised-worker", "locks", "lifecycle");
      let lifecycleAttempts = 0;
      fs.mkdirSync = (directory, ...options) => {
        if (path.resolve(String(directory)) === lifecycleDirectory) {
          lifecycleAttempts += 1;
          throw Object.assign(new Error("fixture lifecycle unavailable"), { code: "EACCES", syscall: "mkdir" });
        }
        return originalMkdirSync(directory, ...options);
      };
      let fired = false;
      fs.appendFileSync = (filePath, bytes, ...options) => {
        if (!fired && inRuns(filePath) && JSON.parse(String(bytes)).event === "helper_result") {
          fired = true;
          throw new Error("PRIVATE_HELPER_PUBLICATION_FAULT");
        }
        return originalAppendFileSync(filePath, bytes, ...options);
      };
      syncBuiltinESMExports();
      const first = observeHandoffValidation(repositoryRoot, artifactPath, helperRequest("PRIVATE_ORIGINAL_HOST"));
      assert.equal(fired, true, "the helper result publication fault must fire");
      assert.equal(first.status, "unconfirmed");
      assert.equal(first.outcome, "completion-unconfirmed");
      assert.equal(first.parentOperationId, parent.operationId);
      assert.equal(records().filter((record) => record.event === "helper_result").length, 0);
      fs.appendFileSync = originalAppendFileSync;
      syncBuiltinESMExports();
      const retryParent = startHelper("PRIVATE_RETRY_HOST");
      const retry = observeHandoffValidation(repositoryRoot, artifactPath, helperRequest("PRIVATE_RETRY_HOST", first.operationId));
      assert.equal(retry.status, "evaluated", JSON.stringify(retry));
      assert.equal(retry.ok, true, JSON.stringify(retry));
      assert.equal(retry.result.sha256, sha256(originalReadFileSync(artifactPath)));
      assert.equal(retry.delivery, "unconfirmed");
      assert.equal(retry.attempt, 1);
      assert.equal(retry.retryRoot, first.operationId);
      assert.notEqual(retry.operationId, first.operationId);
      assert.equal(retry.parentOperationId, retryParent.operationId);
      startHelper("PRIVATE_ALTERNATE_HOST");
      for (const retryOf of [null, first.operationId, retry.operationId]) {
        assert.equal(observeHandoffValidation(repositoryRoot, artifactPath,
          helperRequest("PRIVATE_ALTERNATE_HOST", retryOf)).status, "denied");
      }
      const attempts = records().filter((record) => record.event === "helper_attempt_reserved");
      assert.deepEqual(attempts.map((record) => record.attempt), [0, 1]);
      assert.equal(attempts[0].inputHash, attempts[1].inputHash);
      assert.equal(attempts[0].implementationHash, attempts[1].implementationHash);
      assert.equal(lifecycleAttempts, 0, "helper observation must not acquire the repository lifecycle lock");
      assert.equal(summarizeRunLedger(repositoryRoot).status, "available");
      assert.equal(records().some((record) => record.event === "tool_completed" &&
        [parent.operationId, retryParent.operationId].includes(record.operationId)), false);
      assert.doesNotMatch(originalReadFileSync(ledgerFile, "utf8"), /PRIVATE_/);
      fs.mkdirSync = originalMkdirSync;
      syncBuiltinESMExports();
      const checkpoint = checkpointSession(repositoryRoot, request);
      assert.equal(checkpoint.status, "checkpointed");
      for (const operationId of [parent.operationId, retryParent.operationId, first.operationId, retry.operationId]) {
        assert.ok(checkpoint.context.operations.orphans.some((operation) =>
          operation.operationId === operationId && operation.observationStatus === "outcome-unknown"));
      }
    ${filesystemCleanup()}
  `, 30_000);
});

test("observed handoff validation breaks the circuit after a second missing result", () => {
  runIsolated(`
    ${filesystemPrelude("observed-handoff-circuit")}
    try {
      ${observedHandoffFaultSetup()}
      startHelper("PRIVATE_FIRST_HOST");
      let fired = 0;
      fs.appendFileSync = (filePath, bytes, ...options) => {
        if (inRuns(filePath) && JSON.parse(String(bytes)).event === "helper_result") {
          fired += 1;
          throw new Error("PRIVATE_MISSING_RESULT");
        }
        return originalAppendFileSync(filePath, bytes, ...options);
      };
      syncBuiltinESMExports();
      const first = observeHandoffValidation(repositoryRoot, artifactPath, helperRequest("PRIVATE_FIRST_HOST"));
      assert.equal(first.outcome, "completion-unconfirmed");
      startHelper("PRIVATE_SECOND_HOST");
      const second = observeHandoffValidation(repositoryRoot, artifactPath, helperRequest("PRIVATE_SECOND_HOST", first.operationId));
      assert.equal(second.outcome, "completion-unconfirmed");
      assert.equal(second.attempt, 1);
      startHelper("PRIVATE_THIRD_HOST");
      for (const retryOf of [null, first.operationId, second.operationId]) {
        assert.equal(observeHandoffValidation(repositoryRoot, artifactPath,
          helperRequest("PRIVATE_THIRD_HOST", retryOf)).status, "denied");
      }
      assert.equal(fired, 2, "both result publication faults must fire, with no third evaluation");
      assert.deepEqual(records().filter((record) => record.event === "helper_attempt_reserved").map((record) => record.attempt), [0, 1]);
      assert.equal(records().filter((record) => record.event === "helper_result").length, 0);
      assert.doesNotMatch(originalReadFileSync(ledgerFile, "utf8"), /PRIVATE_/);
    ${filesystemCleanup()}
  `, 30_000);
});

for (const circuitWritable of [true, false]) {
  test(`observed handoff validation closes uncertain reservation circuit (writable=${circuitWritable})`, () => {
    runIsolated(`
      ${filesystemPrelude(`observed-reservation-${circuitWritable}`)}
      try {
        ${observedHandoffFaultSetup()}
        startHelper("PRIVATE_FIRST_HOST");
        const first = observeHandoffValidation(repositoryRoot, artifactPath, helperRequest("PRIVATE_FIRST_HOST"));
        assert.equal(first.status, "evaluated");
        startHelper("PRIVATE_RETRY_HOST");
        let fired = 0;
        fs.appendFileSync = (filePath, bytes, ...options) => {
          const event = inRuns(filePath) ? JSON.parse(String(bytes)).event : null;
          if (event === "helper_attempt_reserved" || (!${circuitWritable} && event === "helper_circuit_open")) {
            fired += 1;
            throw new Error("PRIVATE_RESERVATION_FAULT");
          }
          return originalAppendFileSync(filePath, bytes, ...options);
        };
        syncBuiltinESMExports();
        const retry = observeHandoffValidation(repositoryRoot, artifactPath, helperRequest("PRIVATE_RETRY_HOST", first.operationId));
        assert.equal(retry.status, "unconfirmed");
        assert.equal(retry.outcome, "reservation-unconfirmed");
        assert.equal(fired, ${circuitWritable ? 1 : 2});
        fs.appendFileSync = originalAppendFileSync;
        syncBuiltinESMExports();
        assert.equal(records().filter((record) => record.event === "helper_result").length, 1);
        assert.equal(records().filter((record) => record.event === "helper_circuit_open").length, ${circuitWritable ? 1 : 0});
        assert.equal(observeHandoffValidation(repositoryRoot, artifactPath,
          helperRequest("PRIVATE_RETRY_HOST", first.operationId)).status, "denied");
        if (!${circuitWritable}) {
          assert.equal(fs.existsSync(path.join(repositoryRoot, ".supervised-worker", "locks", "journal")), true);
        }
        assert.doesNotMatch(originalReadFileSync(ledgerFile, "utf8"), /PRIVATE_/);
      ${filesystemCleanup()}
    `, 30_000);
  });
}

for (const dependency of [
  "artifact", "workflow", "acceptance", "changedFiles", "targetFiles", "plan", "attachment", "route",
  "parameters", "cwd", "implementation", "runtime",
]) {
  test(`observed handoff validation denies a changed ${dependency} dependency`, () => {
    runIsolated(`
      ${filesystemPrelude(`observed-handoff-${dependency}`)}
      try {
        ${observedHandoffFaultSetup(dependency === "targetFiles" ? "build-contract" : "build-report")}
        const dependency = ${JSON.stringify(dependency)};
        startHelper("PRIVATE_FIRST_HOST");
        const first = observeHandoffValidation(repositoryRoot, artifactPath, helperRequest("PRIVATE_FIRST_HOST"));
        assert.equal(first.status, "evaluated", JSON.stringify(first));
        assert.equal(first.ok, true, JSON.stringify(first));
        startHelper("PRIVATE_RETRY_HOST");
        let retryPath = artifactPath;
        let retryCwd = repositoryRoot;
        let fired = false;
        if (dependency === "artifact") {
          fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, blocker: "PRIVATE_CHANGED_RESULT" }));
        } else if (dependency === "workflow") {
          fs.mkdirSync(path.join(repositoryRoot, ".github"));
          fs.writeFileSync(path.join(repositoryRoot, ".github", "supervised-worker.json"), "{}");
        } else if (dependency === "acceptance") {
          fs.writeFileSync(path.join(repositoryRoot, ".supervised-worker", "workflow-acceptance.json"), "{}");
        } else if (["changedFiles", "targetFiles"].includes(dependency)) {
          fs.renameSync(inspectedPath, inspectedPath + ".previous");
          fs.mkdirSync(inspectedPath);
        } else if (dependency === "plan") {
          fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({ ...plan, goal: "PRIVATE_CHANGED_PLAN" }));
        } else if (dependency === "attachment") {
          fs.writeFileSync(attachmentFile, JSON.stringify({ ...JSON.parse(attachmentBefore), updatedAt: "2026-09-06T01:00:00.000Z" }));
        } else if (dependency === "route") {
          fs.writeFileSync(routeFile, JSON.stringify({ ...JSON.parse(originalReadFileSync(routeFile)), updatedAt: "2026-09-06T01:00:00.000Z" }));
        } else if (dependency === "parameters") {
          retryPath = path.relative(repositoryRoot, artifactPath);
        } else if (dependency === "cwd") {
          retryCwd = path.join(repositoryRoot, "src");
        } else if (dependency === "implementation") {
          const implementationPath = ${JSON.stringify(fileURLToPath(coreUrl))};
          fs.readSync = (descriptor, buffer, offset, length, position) => {
            const count = originalReadSync(descriptor, buffer, offset, length, position);
            if (!fired && descriptorPaths.get(descriptor) === implementationPath && count > 0) {
              fired = true;
              buffer[offset] ^= 1;
            }
            return count;
          };
          syncBuiltinESMExports();
        } else if (dependency === "runtime") {
          process.execArgv.push("--PRIVATE_CHANGED_RUNTIME");
        }
        const retry = observeHandoffValidation(retryCwd, retryPath, helperRequest("PRIVATE_RETRY_HOST", first.operationId));
        assert.equal(retry.status, "denied", JSON.stringify(retry));
        if (dependency === "implementation") assert.equal(fired, true, "the implementation read fault must fire");
        assert.equal(records().filter((record) => record.event === "helper_attempt_reserved").length, 1);
        assert.equal(records().filter((record) => record.event === "helper_result").length, 1);
        assert.doesNotMatch(originalReadFileSync(ledgerFile, "utf8"), /PRIVATE_/);
      ${filesystemCleanup()}
    `, 30_000);
  });
}

test("observed handoff validation rejects forged effects and legacy retry authority", () => {
  runIsolated(`
    ${filesystemPrelude("observed-handoff-unproven")}
    try {
      ${observedHandoffFaultSetup()}
      const parent = startHelper("PRIVATE_UNKNOWN_HOST");
      for (const extra of [ { effect: "read-only" }, { command: "PRIVATE_COMMAND" },
        { toolUseId: "PRIVATE_ALIAS" }, { retryOf: parent.operationId } ]) {
        assert.equal(observeHandoffValidation(repositoryRoot, artifactPath,
          { ...helperRequest("PRIVATE_UNKNOWN_HOST"), ...extra }).status, "denied");
      }
      assert.equal(requestDeniedToolRetry(repositoryRoot,
        { ...request, sourceOperationId: parent.operationId }).status, "denied");
      const legacy = records().map((record) => {
        if (record.operationId !== parent.operationId) return record;
        const { requestHash, ...previous } = record;
        return previous;
      });
      fs.writeFileSync(ledgerFile, legacy.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
      assert.equal(summarizeRunLedger(repositoryRoot).status, "available");
      assert.equal(observeHandoffValidation(repositoryRoot, artifactPath, helperRequest("PRIVATE_UNKNOWN_HOST")).status, "denied");
      assert.equal(records().some((record) => record.helperId), false);
    ${filesystemCleanup()}
  `, 30_000);
});

test("observed handoff CLI accepts only the explicit bounded JSON interface", () => {
  runIsolated(`
    ${filesystemPrelude("observed-handoff-cli")}
    try {
      ${observedHandoffFaultSetup()}
      const { spawnSync } = await import("node:child_process");
      const { createWorkerAuthorityFixture } = await import(${JSON.stringify(new URL("./worker-authority-fixture.mjs", testModuleUrl).href)});
      assert.equal(handleHook({ ...input, stop_hook_active: true }, "Stop").decision, "allow");
      const runtime = createWorkerAuthorityFixture(repositoryRoot, { session_id: sessionId, transcript_path: transcriptPath },
        { baseDirectory: path.join(base, "trusted-authority") });
      runtime.admit();
      const cliPath = path.join(runtime.installRoot, "src", "cli.mjs");
      startHelper("PRIVATE_CLI_HOST");
      const invoke = (args, stdin = "") => {
        const result = spawnSync(process.execPath, [cliPath, "handoff", "validate", artifactPath, ...args],
          { cwd: repositoryRoot, input: stdin, encoding: "utf8", timeout: 30_000,
            env: { ...process.env, SUPERVISED_WORKER_HOST_AUTHORITY: runtime.inventoryPath } });
        assert.equal(result.error, undefined, result.error?.message);
        return { status: result.status, report: JSON.parse(result.stdout) };
      };
      assert.equal(invoke([]).report.ok, true);
      for (const stdin of [ '{"session_id":"first","session_id":"second"}', " ".repeat(8_193),
        JSON.stringify({ ...helperRequest("PRIVATE_CLI_HOST"), effect: "read-only" }) ]) {
        const rejected = invoke(["--observe"], stdin);
        assert.equal(rejected.status, 1);
        assert.equal(rejected.report.status, "denied");
        assert.equal(records().some((record) => record.helperId), false);
      }
      const observed = invoke(["--observe"], JSON.stringify(helperRequest("PRIVATE_CLI_HOST")));
      assert.equal(observed.status, 0, JSON.stringify(observed));
      assert.equal(observed.report.status, "evaluated");
      assert.equal(observed.report.delivery, "unconfirmed");
      assert.equal(records().filter((record) => record.event === "helper_result").length, 1);
    ${filesystemCleanup()}
  `, 30_000);
});

function deniedRetryFaultSetup(routed = true) {
  return `
    ${checkpointFaultSetup(false, routed)}
    const { requestDeniedToolRetry } = await import(${JSON.stringify(coreUrl)});
    const records = () => originalReadFileSync(ledgerFile, "utf8").trim().split("\\n").map(JSON.parse);
    const deniedTool = { ...input, tool_name: "run_in_terminal", tool_use_id: "PRIVATE_DENIED_HOST_ID",
      tool_input: { command: "PRIVATE_MUTATING_COMMAND", options: { flags: ["PRIVATE_FLAG"], mode: "PRIVATE_MODE" }, timeout: 500 } };
    const retryRequest = (denial) => ({ ...request, sourceOperationId: denial.operationId });
    const denyNextStart = (tool = deniedTool) => {
      let fired = false;
      fs.appendFileSync = (filePath, bytes, ...options) => {
        if (!fired && inRuns(filePath) && JSON.parse(String(bytes)).event === "tool_started") {
          fired = true;
          throw new Error("PRIVATE_START_FAULT");
        }
        return originalAppendFileSync(filePath, bytes, ...options);
      };
      syncBuiltinESMExports();
      let output;
      try {
        output = handleHook(tool, "PreToolUse");
      } finally {
        fs.appendFileSync = originalAppendFileSync;
        syncBuiltinESMExports();
      }
      assert.equal(fired, true, "the tool-start publication fault must fire");
      assert.equal(output.permissionDecision, "deny");
      const denial = records().at(-1);
      assert.equal(denial.event, "tool_denied");
      assert.equal(denial.outcome, "not-executed");
      return denial;
    };
  `;
}

test("multiprocess journal admits one denied retry consumer", () => {
  runIsolated(`
    ${filesystemPrelude("multiprocess-denied-consumers")}
    try {
      ${deniedRetryFaultSetup(false)}
      ${journalHookChildrenSetup()}
      try {
        const denial = denyNextStart();
        const reserved = requestDeniedToolRetry(repositoryRoot, retryRequest(denial));
        assert.equal(reserved.status, "reserved");
        const firstTool = { ...deniedTool, tool_use_id: "PRIVATE_RETRY_FIRST" };
        const secondTool = { ...deniedTool, tool_use_id: "PRIVATE_RETRY_SECOND" };
        const first = startHookChild(firstTool, "PreToolUse", "denied_retry_consumed");
        assert.equal((await first.waitFor("held")).record.event, "denied_retry_consumed");
        const second = startHookChild(secondTool, "PreToolUse");
        assert.equal((await second.waitFor("contended")).scope, "journal");
        first.release();
        const admitted = await first.finish();
        const denied = await second.finish(null);
        assert.equal(denied.output.permissionDecision, "deny");
        const consumed = readRecords().filter((record) => record.event === "denied_retry_consumed");
        assert.equal(consumed.length, 1);
        assert.equal(consumed[0].reservationId, reserved.reservationId);
        assert.equal(consumed[0].sourceOperationId, denial.operationId);
        assert.equal(consumed[0].invocationHash, sha256("supervised-worker-tool-invocation-v1\\0PRIVATE_RETRY_FIRST"));
        assert.deepEqual(admitted.publications.map((record) => record.event), ["denied_retry_consumed", "tool_started"]);
        assert.equal(readRecords().filter((record) => record.event === "tool_started" && record.requestHash === denial.requestHash).length, 1);
        assert.equal(requestDeniedToolRetry(repositoryRoot, retryRequest(denial)).status, "denied");
        assert.doesNotMatch(originalReadFileSync(ledgerFile, "utf8"), /PRIVATE_/);
      } finally {
        await stopHookChildren();
      }
    ${filesystemCleanup()}
  `, 60_000);
});

test("multiprocess journal admits one hash-stable helper retry", () => {
  runIsolated(`
    ${filesystemPrelude("multiprocess-helper-consumers")}
    try {
      ${observedHandoffFaultSetup("build-report", false)}
      ${journalHookChildrenSetup()}
      try {
        startHelper("PRIVATE_ORIGINAL_HOST");
        const originalInput = { ...input, filePath: artifactPath, request: helperRequest("PRIVATE_ORIGINAL_HOST") };
        const original = (await startHookChild(originalInput, "helper").finish(null)).output;
        assert.equal(original.status, "evaluated");
        startHelper("PRIVATE_RETRY_FIRST");
        startHelper("PRIVATE_RETRY_SECOND");
        const firstInput = { ...input, filePath: artifactPath, request: helperRequest("PRIVATE_RETRY_FIRST", original.operationId) };
        const secondInput = { ...input, filePath: artifactPath, request: helperRequest("PRIVATE_RETRY_SECOND", original.operationId) };
        const first = startHookChild(firstInput, "helper", "helper_attempt_reserved");
        assert.equal((await first.waitFor("held")).record.attempt, 1);
        const second = startHookChild(secondInput, "helper");
        assert.equal((await second.waitFor("contended")).scope, "journal");
        first.release();
        const admitted = await first.finish(null);
        const denied = await second.finish(null);
        assert.equal(admitted.output.status, "evaluated");
        assert.equal(denied.output.status, "denied");
        const attempts = readRecords().filter((record) => record.event === "helper_attempt_reserved");
        assert.deepEqual(attempts.map((record) => record.attempt), [0, 1]);
        assert.equal(attempts[1].retryRoot, original.operationId);
        assert.equal(attempts[0].inputHash, attempts[1].inputHash);
        assert.equal(readRecords().filter((record) => record.event === "helper_result").length, 2);
        assert.equal(readRecords().some((record) => record.event === "tool_completed" &&
          record.operationId === attempts[1].parentOperationId), false);
        assert.doesNotMatch(originalReadFileSync(ledgerFile, "utf8"), /PRIVATE_/);
      } finally {
        await stopHookChildren();
      }
    ${filesystemCleanup()}
  `, 60_000);
});

test("denied retry consumes one permit only for the complete normalized request hash", () => {
  runIsolated(`
    ${filesystemPrelude("denied-retry-normalized")}
    try {
      ${deniedRetryFaultSetup()}
      const denial = denyNextStart();
      const expectedHash = sha256("supervised-worker-tool-request-v1\\0" + JSON.stringify({
        arguments: { command: "PRIVATE_MUTATING_COMMAND", options: { flags: ["PRIVATE_FLAG"], mode: "PRIVATE_MODE" }, timeout: 500 },
        toolName: "run_in_terminal",
      }));
      assert.equal(denial.requestHash, expectedHash);
      const reserved = requestDeniedToolRetry(repositoryRoot, retryRequest(denial));
      assert.equal(reserved.status, "reserved");
      assert.equal(reserved.requestHash, expectedHash);
      assert.equal(requestDeniedToolRetry(repositoryRoot, retryRequest(denial)).status, "denied");
      const unrelated = { ...deniedTool, tool_use_id: "PRIVATE_UNRELATED_ID",
        tool_input: { ...deniedTool.tool_input, command: "PRIVATE_DIFFERENT_COMMAND" } };
      assert.deepEqual(handleHook(unrelated, "PreToolUse"), {});
      const unrelatedStart = records().at(-1);
      assert.notEqual(unrelatedStart.requestHash, expectedHash);
      assert.equal(records().filter((record) => record.event === "denied_retry_consumed").length, 0);
      const retry = { ...deniedTool, tool_name: undefined, toolName: "RUN_IN_TERMINAL",
        tool_use_id: "PRIVATE_RETRY_ID", tool_input: undefined,
        toolArgs: { timeout: 500, options: { mode: "PRIVATE_MODE", flags: ["PRIVATE_FLAG"] }, command: "PRIVATE_MUTATING_COMMAND" } };
      assert.deepEqual(handleHook(retry, "PreToolUse"), {});
      const after = records();
      const consumed = after.find((record) => record.event === "denied_retry_consumed");
      const start = after.find((record) => record.event === "tool_started" && record.operationId === consumed.operationId);
      assert.equal(consumed.sourceOperationId, denial.operationId);
      assert.equal(consumed.reservationId, reserved.reservationId);
      assert.equal(consumed.requestHash, expectedHash);
      assert.equal(consumed.invocationHash, sha256("supervised-worker-tool-invocation-v1\\0PRIVATE_RETRY_ID"));
      assert.notEqual(consumed.operationId, denial.operationId);
      assert.equal(start.requestHash, expectedHash);
      assert.equal(start.invocationHash, consumed.invocationHash);
      assert.ok(after.indexOf(consumed) < after.indexOf(start));
      assert.deepEqual(handleHook(retry, "PostToolUse"), {});
      assert.equal(handleHook({ ...deniedTool, tool_use_id: "PRIVATE_THIRD_ID" }, "PreToolUse").permissionDecision, "deny");
      assert.equal(records().at(-1).retryOf, denial.operationId);
      assert.equal(records().filter((record) => record.event === "denied_retry_consumed").length, 1);
      assert.equal(records().filter((record) => record.event === "denied_retry_reserved").length, 1);
      assert.equal(requestDeniedToolRetry(repositoryRoot, retryRequest(denial)).status, "denied");
      assert.equal(summarizeRunLedger(repositoryRoot).status, "available");
      const checkpoint = checkpointSession(repositoryRoot, request);
      assert.deepEqual(checkpoint.context.operations.orphans.map((operation) => operation.operationId), [unrelatedStart.operationId]);
      assert.doesNotMatch(originalReadFileSync(ledgerFile, "utf8"), /PRIVATE_/);
    ${filesystemCleanup()}
  `, 30_000);
});

test("denied retry keeps the circuit open after a second denied start", () => {
  runIsolated(`
    ${filesystemPrelude("denied-retry-second-denial")}
    try {
      ${deniedRetryFaultSetup()}
      const denial = denyNextStart();
      assert.equal(requestDeniedToolRetry(repositoryRoot, retryRequest(denial)).status, "reserved");
      const second = denyNextStart({ ...deniedTool, tool_use_id: "PRIVATE_SECOND_ID" });
      assert.equal(second.retryOf, denial.operationId);
      const consumed = records().filter((record) => record.event === "denied_retry_consumed");
      assert.equal(consumed.length, 1);
      assert.equal(consumed[0].operationId, second.operationId);
      assert.equal(records().some((record) => record.event === "tool_started" && record.operationId === second.operationId), false);
      for (const source of [denial, second]) {
        assert.equal(requestDeniedToolRetry(repositoryRoot, retryRequest(source)).status, "denied");
      }
      assert.equal(handleHook({ ...deniedTool, tool_use_id: "PRIVATE_THIRD_ID" }, "PreToolUse").permissionDecision, "deny");
      assert.equal(records().filter((record) => record.event === "denied_retry_consumed").length, 1);
      assert.doesNotMatch(originalReadFileSync(ledgerFile, "utf8"), /PRIVATE_/);
    ${filesystemCleanup()}
  `);
});

test("denied retry requires persisted denial evidence when journaling fails", () => {
  runIsolated(`
    ${filesystemPrelude("denied-retry-no-evidence")}
    try {
      ${deniedRetryFaultSetup()}
      const before = originalReadFileSync(ledgerFile);
      const fired = { tool_started: 0, tool_denied: 0 };
      fs.appendFileSync = (filePath, bytes, ...options) => {
        const event = inRuns(filePath) ? JSON.parse(String(bytes)).event : null;
        if (Object.hasOwn(fired, event)) {
          fired[event] += 1;
          throw new Error("PRIVATE_PERSISTENCE_FAULT");
        }
        return originalAppendFileSync(filePath, bytes, ...options);
      };
      syncBuiltinESMExports();
      const output = handleHook(deniedTool, "PreToolUse");
      fs.appendFileSync = originalAppendFileSync;
      syncBuiltinESMExports();
      assert.deepEqual(fired, { tool_started: 1, tool_denied: 1 });
      assert.equal(output.permissionDecision, "deny");
      assert.match(output.permissionDecisionReason, /journaling is unconfirmed; no retry permit/);
      assert.deepEqual(originalReadFileSync(ledgerFile), before);
      const result = requestDeniedToolRetry(repositoryRoot, { ...request, sourceOperationId: "11111111-1111-4111-8111-111111111111" });
      assert.equal(result.status, "denied");
      assert.equal(result.permit, null);
      assert.deepEqual(originalReadFileSync(ledgerFile), before);
    ${filesystemCleanup()}
  `);
});

test("denied retry correlates a denial after start publication without completing its retry", () => {
  runIsolated(`
    ${filesystemPrelude("denied-retry-start-readback")}
    try {
      ${deniedRetryFaultSetup()}
      let fired = false;
      fs.readSync = (descriptor, ...options) => {
        if (!fired && descriptorPaths.get(descriptor) === ledgerFile && records().at(-1).event === "tool_started") {
          fired = true;
          throw new Error("PRIVATE_START_READBACK_FAULT");
        }
        return originalReadSync(descriptor, ...options);
      };
      syncBuiltinESMExports();
      const output = handleHook(deniedTool, "PreToolUse");
      fs.readSync = originalReadSync;
      syncBuiltinESMExports();
      assert.equal(fired, true, "published start read-back must be reached");
      assert.equal(output.permissionDecision, "deny");
      const denial = records().at(-1);
      assert.equal(denial.event, "tool_denied");
      assert.equal(records().filter((record) => record.event === "tool_started" && record.operationId === denial.operationId).length, 1);
      assert.equal(requestDeniedToolRetry(repositoryRoot, retryRequest(denial)).status, "reserved");
      assert.deepEqual(handleHook({ ...deniedTool, tool_use_id: "PRIVATE_UNKNOWN_RETRY" }, "PreToolUse"), {});
      const retryStart = records().at(-1);
      const checkpoint = checkpointSession(repositoryRoot, request);
      assert.deepEqual(checkpoint.context.operations.orphans.map((operation) => operation.operationId), [retryStart.operationId]);
      assert.equal(checkpoint.context.operations.orphans[0].observationStatus, "outcome-unknown");
    ${filesystemCleanup()}
  `);
});

for (const drift of ["attachment", "route", "claim", "plan"]) {
  for (const phase of ["reservation", "consumption"]) {
    test(`denied retry rejects ${drift} drift before ${phase}`, () => {
      runIsolated(`
        ${filesystemPrelude(`denied-retry-${drift}-${phase}`)}
        try {
          ${deniedRetryFaultSetup()}
          const denial = denyNextStart();
          const phase = ${JSON.stringify(phase)};
          if (phase === "consumption") assert.equal(requestDeniedToolRetry(repositoryRoot, retryRequest(denial)).status, "reserved");
          const drift = ${JSON.stringify(drift)};
          if (drift === "attachment") originalWriteFileSync(attachmentFile, Buffer.concat([attachmentBefore, Buffer.from("\\n")]));
          if (drift === "route") {
            const route = JSON.parse(originalReadFileSync(routeFile));
            route.generation = "22222222-2222-4222-8222-222222222222";
            originalWriteFileSync(routeFile, JSON.stringify(route));
          }
          if (drift === "claim") {
            const attachment = JSON.parse(attachmentBefore);
            attachment.claimGeneration = "33333333-3333-4333-8333-333333333333";
            originalWriteFileSync(attachmentFile, JSON.stringify(attachment));
          }
          if (drift === "plan") originalWriteFileSync(planPath(repositoryRoot), JSON.stringify({ ...plan, goal: "PRIVATE_CHANGED_PLAN" }));
          if (phase === "reservation") {
            assert.equal(requestDeniedToolRetry(repositoryRoot, retryRequest(denial)).status, "denied");
            assert.equal(records().some((record) => record.event === "denied_retry_reserved"), false);
          } else {
            assert.equal(handleHook({ ...deniedTool, tool_use_id: "PRIVATE_DRIFT_RETRY" }, "PreToolUse").permissionDecision, "deny");
          }
          assert.equal(records().some((record) => record.event === "denied_retry_consumed"), false);
          assert.equal(records().some((record) => record.event === "tool_started" && record.requestHash === denial.requestHash), false);
        ${filesystemCleanup()}
      `);
    });
  }
}

for (const phase of ["reservation", "consumption"]) {
  test(`denied retry revalidates ownership at ${phase} publication`, () => {
    runIsolated(`
      ${filesystemPrelude(`denied-retry-publish-${phase}`)}
      try {
        ${deniedRetryFaultSetup()}
        const denial = denyNextStart();
        const phase = ${JSON.stringify(phase)};
        if (phase === "consumption") assert.equal(requestDeniedToolRetry(repositoryRoot, retryRequest(denial)).status, "reserved");
        let fired = false;
        fs.appendFileSync = (filePath, bytes, ...options) => {
          if (!fired && inRuns(filePath) && JSON.parse(String(bytes)).event ===
            (phase === "reservation" ? "denied_retry_reserved" : "denied_retry_consumed")) {
            fired = true;
            originalWriteFileSync(attachmentFile, Buffer.concat([attachmentBefore, Buffer.from("\\n")]));
          }
          return originalAppendFileSync(filePath, bytes, ...options);
        };
        syncBuiltinESMExports();
        const result = phase === "reservation" ? requestDeniedToolRetry(repositoryRoot, retryRequest(denial))
          : handleHook({ ...deniedTool, tool_use_id: "PRIVATE_PUBLISH_RETRY" }, "PreToolUse");
        fs.appendFileSync = originalAppendFileSync;
        syncBuiltinESMExports();
        assert.equal(fired, true, "the retry publication boundary must be reached");
        assert.equal(phase === "reservation" ? result.status : result.permissionDecision, phase === "reservation" ? "denied" : "deny");
        assert.equal(records().some((record) => record.event === "denied_retry_consumed"), false);
        if (phase === "reservation") assert.equal(records().some((record) => record.event === "denied_retry_reserved"), false);
      ${filesystemCleanup()}
    `);
  });
}

for (const identity of ["missing-id", "conflicting-id", "reused-id", "conflicting-name", "conflicting-arguments"]) {
  test(`denied retry rejects ${identity} evidence`, () => {
    runIsolated(`
      ${filesystemPrelude(`denied-retry-${identity}`)}
      try {
        ${deniedRetryFaultSetup()}
        const identity = ${JSON.stringify(identity)};
        const tool = { ...deniedTool };
        if (identity === "missing-id") delete tool.tool_use_id;
        if (identity === "conflicting-id") tool.toolUseId = "PRIVATE_CONFLICTING_ID";
        if (identity === "conflicting-name") tool.toolName = "read_file";
        if (identity === "conflicting-arguments") tool.toolArgs = { command: "PRIVATE_DIFFERENT_COMMAND" };
        if (identity === "reused-id") assert.deepEqual(handleHook(tool, "PreToolUse"), {});
        const denial = denyNextStart(tool);
        assert.equal(requestDeniedToolRetry(repositoryRoot, retryRequest(denial)).status, "denied");
        assert.equal(records().some((record) => record.event === "denied_retry_reserved"), false);
        assert.doesNotMatch(originalReadFileSync(ledgerFile, "utf8"), /PRIVATE_/);
      ${filesystemCleanup()}
    `);
  });
}

test("denied retry gives no replay authority to unknown or legacy operations", () => {
  runIsolated(`
    ${filesystemPrelude("denied-retry-unknown-legacy")}
    try {
      ${deniedRetryFaultSetup()}
      assert.deepEqual(handleHook(deniedTool, "PreToolUse"), {});
      const unknown = records().at(-1);
      originalAppendFileSync(ledgerFile, JSON.stringify({ schemaVersion: 1, at: "2026-09-01T00:00:00Z",
        session: sha256(sessionId), event: "tool_completed", toolName: "run_in_terminal", success: true }) + "\\n");
      const before = originalReadFileSync(ledgerFile);
      for (const candidate of [
        retryRequest(unknown),
        { ...retryRequest(unknown), command: "PRIVATE_REPLAY_COMMAND" },
        { ...retryRequest(unknown), effect: "read-only", outcome: "not-executed" },
        { ...request, sourceOperationId: "44444444-4444-4444-8444-444444444444" },
      ]) {
        const result = requestDeniedToolRetry(repositoryRoot, candidate);
        assert.equal(result.status, "denied");
        assert.equal(result.permit, null);
      }
      assert.deepEqual(originalReadFileSync(ledgerFile), before);
      assert.equal(summarizeRunLedger(repositoryRoot).status, "available");
      const checkpoint = checkpointSession(repositoryRoot, request);
      assert.deepEqual(checkpoint.context.operations.orphans.map((operation) => operation.operationId), [unknown.operationId]);
      assert.equal(checkpoint.context.operations.uncorrelatedCompletions, 1);
      assert.doesNotMatch(originalReadFileSync(ledgerFile, "utf8"), /PRIVATE_/);
    ${filesystemCleanup()}
  `);
});

for (const fault of [
  "receipt-temporary-write", "receipt-fsync", "receipt-publication", "receipt-temporary-readback", "receipt-readback",
  "source-ledger-flush", "ledger-append", "tombstone-temporary-write", "tombstone-publication", "tombstone-readback", "route-cleanup",
]) {
  test(`checkpoint ${fault} failure preserves source authority or its resumable tombstone`, () => {
    runIsolated(`
      ${filesystemPrelude(`checkpoint-${fault}`)}
      try {
        ${checkpointFaultSetup()}
        const fault = ${JSON.stringify(fault)};
        let fired = false;
        const fail = () => { fired = true; throw new Error("PRIVATE_FAULT_CONTENT"); };
        fs.writeFileSync = (filePath, ...args) => {
          const name = String(filePath);
          if (!fired && fault === "receipt-temporary-write" && inReceipts(name) && name.endsWith(".tmp")) fail();
          if (!fired && fault === "tombstone-temporary-write" && name.startsWith(attachmentFile + ".") && String(args[0]).includes('"checkpointed"')) fail();
          return originalWriteFileSync(filePath, ...args);
        };
        fs.fsyncSync = (descriptor) => {
          const name = descriptorPaths.get(descriptor);
          if (!fired && fault === "receipt-fsync" && inReceipts(name)) fail();
          if (!fired && fault === "source-ledger-flush" && name === ledgerFile) fail();
          return originalFsyncSync(descriptor);
        };
        fs.appendFileSync = (filePath, ...args) => {
          if (!fired && fault === "ledger-append" && inRuns(filePath)) fail();
          return originalAppendFileSync(filePath, ...args);
        };
        fs.renameSync = (source, destination) => {
          const name = path.resolve(String(destination));
          if (!fired && fault === "receipt-publication" && inReceipts(name)) fail();
          if (!fired && fault === "tombstone-publication" && name === attachmentFile) fail();
          if (!fired && fault === "route-cleanup" && name === routeFile && JSON.parse(originalReadFileSync(source)).status === "released") fail();
          return originalRenameSync(source, destination);
        };
        fs.readSync = (descriptor, ...args) => {
          const name = descriptorPaths.get(descriptor);
          if (!fired && fault === "receipt-temporary-readback" && inReceipts(name) && name.endsWith(".tmp")) fail();
          if (!fired && fault === "receipt-readback" && inReceipts(name) && name.endsWith(".json")) fail();
          if (!fired && fault === "tombstone-readback" && name === attachmentFile && JSON.parse(originalReadFileSync(name, "utf8")).status === "checkpointed") fail();
          return originalReadSync(descriptor, ...args);
        };
        syncBuiltinESMExports();
        assert.throws(() => checkpointSession(repositoryRoot, request), (error) => !error.message.includes("PRIVATE_"));
        assert.equal(fired, true, "the intended boundary must be reached");
        assert.deepEqual(originalReadFileSync(planPath(repositoryRoot)), planBefore);
        const attachment = JSON.parse(originalReadFileSync(attachmentFile));
        const logicallyDetached = ["tombstone-readback", "route-cleanup"].includes(fault);
        assert.equal(attachment.status, logicallyDetached ? "checkpointed" : "active");
        assert.equal(JSON.parse(originalReadFileSync(routeFile)).status, "active");
        if (logicallyDetached) {
          const resumedCleanup = checkpointSession(repositoryRoot, request);
          assert.equal(resumedCleanup.status, "checkpointed");
          assert.equal(resumedCleanup.checkpointHash, attachment.checkpointHash);
          assert.equal(JSON.parse(originalReadFileSync(routeFile)).status, "released");
          assert.equal(summarizeRunLedger(repositoryRoot).eventCounts.find((entry) => entry.event === "checkpoint_persisted").count, 1);
        } else {
          assert.deepEqual(originalReadFileSync(attachmentFile), attachmentBefore);
          const receiptsDirectory = path.join(repositoryRoot, ".supervised-worker", "checkpoints");
          const receipts = originalExistsSync(receiptsDirectory) ? originalReaddirSync(receiptsDirectory).filter((name) => /^[0-9a-f]{64}\\.json$/.test(name)) : [];
          for (const receipt of receipts) {
            assert.throws(() => resumeSession(repositoryRoot, { session_id: "not-an-owner", planHash: request.planHash, checkpointHash: receipt.slice(0, 64) }));
            assert.deepEqual(originalReadFileSync(attachmentFile), attachmentBefore);
          }
        }
      ${filesystemCleanup()}
    `);
  });
}

for (const fault of [
  "stop-state-write", "stop-state-fsync", "provisional-route-write", "successor-write", "successor-publication",
  "successor-readback", "route-promotion", "resume-event-append", "resume-event-fsync", "resume-event-publication", "resume-event-readback",
]) {
  test(`interrupted resume at ${fault} retains a tombstone or its exact recoverable successor`, () => {
    runIsolated(`
      ${filesystemPrelude(`resume-${fault}`)}
      try {
        ${checkpointFaultSetup()}
        const checkpoint = checkpointSession(repositoryRoot, request);
        const tombstone = originalReadFileSync(attachmentFile);
        let nextId = "resume-successor";
        let nextTranscript = path.join(transcriptDirectory, nextId + ".jsonl");
        fs.writeFileSync(nextTranscript, "");
        let nextRequest = { session_id: nextId, transcript_path: nextTranscript, planHash: request.planHash, checkpointHash: checkpoint.checkpointHash };
        const nextRoute = path.join(storageRoot, "supervised-worker", "session-roots", sha256(nextId), "route.json");
        const nextLedger = path.join(repositoryRoot, ".supervised-worker", "runs", sha256(nextId) + ".jsonl");
        const nextRuntime = path.join(repositoryRoot, ".supervised-worker", "runtime", sha256(nextId) + ".json");
        const fault = ${JSON.stringify(fault)};
        let fired = false;
        const fail = () => { fired = true; throw new Error("PRIVATE_RESUME_FAULT"); };
        fs.writeFileSync = (filePath, ...args) => {
          const name = path.resolve(String(filePath));
          if (!fired && fault === "stop-state-write" && name.startsWith(nextRuntime + ".")) fail();
          if (!fired && fault === "provisional-route-write" && name === nextRoute) fail();
          if (!fired && fault === "successor-write" && name.startsWith(attachmentFile + ".")) fail();
          return originalWriteFileSync(filePath, ...args);
        };
        fs.fsyncSync = (descriptor) => {
          const name = descriptorPaths.get(descriptor) ?? "";
          if (!fired && fault === "stop-state-fsync" && name.startsWith(nextRuntime + ".")) fail();
          if (!fired && fault === "resume-event-fsync" && name.startsWith(nextLedger + ".")) fail();
          return originalFsyncSync(descriptor);
        };
        fs.appendFileSync = (filePath, ...args) => {
          if (!fired && fault === "resume-event-append" && String(filePath).startsWith(nextLedger + ".")) fail();
          return originalAppendFileSync(filePath, ...args);
        };
        fs.renameSync = (source, destination) => {
          const name = path.resolve(String(destination));
          if (!fired && fault === "successor-publication" && name === attachmentFile) fail();
          if (!fired && fault === "route-promotion" && name === nextRoute && JSON.parse(originalReadFileSync(source)).status === "active") fail();
          if (!fired && fault === "resume-event-publication" && name === nextLedger) fail();
          return originalRenameSync(source, destination);
        };
        fs.readSync = (descriptor, ...args) => {
          const name = descriptorPaths.get(descriptor);
          if (!fired && fault === "successor-readback" && name === attachmentFile && JSON.parse(originalReadFileSync(name, "utf8")).sessionHash === sha256(nextId)) fail();
          if (!fired && fault === "resume-event-readback" && name === nextLedger) fail();
          return originalReadSync(descriptor, ...args);
        };
        syncBuiltinESMExports();
        assert.throws(() => resumeSession(repositoryRoot, nextRequest), (error) => !error.message.includes("PRIVATE_"));
        assert.equal(fired, true);
        const current = JSON.parse(originalReadFileSync(attachmentFile));
        const published = ["successor-readback", "route-promotion", "resume-event-append", "resume-event-fsync", "resume-event-publication", "resume-event-readback"].includes(fault);
        assert.equal(current.status, published ? "active" : "checkpointed");
        if (published) {
          assert.equal(current.sessionHash, sha256(nextId));
          assert.equal(current.checkpointHash, checkpoint.checkpointHash);
          const currentBytes = originalReadFileSync(attachmentFile);
          assert.throws(() => resumeSession(repositoryRoot, { session_id: "different-successor", planHash: request.planHash, checkpointHash: checkpoint.checkpointHash }), /another session/);
          assert.deepEqual(originalReadFileSync(attachmentFile), currentBytes);
        } else assert.deepEqual(originalReadFileSync(attachmentFile), tombstone);
        if (fault === "provisional-route-write") {
          nextId = "fresh-after-unpublished-route";
          nextTranscript = path.join(transcriptDirectory, nextId + ".jsonl");
          fs.writeFileSync(nextTranscript, "");
          nextRequest = { ...nextRequest, session_id: nextId, transcript_path: nextTranscript };
        }
        const resumed = resumeSession(repositoryRoot, nextRequest);
        assert.equal(resumed.status, "resumed");
        const confirmedBytes = originalReadFileSync(attachmentFile);
        assert.deepEqual(resumeSession(repositoryRoot, nextRequest), resumed);
        assert.deepEqual(originalReadFileSync(attachmentFile), confirmedBytes);
        assert.deepEqual(originalReadFileSync(planPath(repositoryRoot)), planBefore);
        assert.equal(summarizeRunLedger(repositoryRoot).eventCounts.find((entry) => entry.event === "checkpoint_resumed").count, 1);
        assert.equal(handleHook({ cwd: repositoryRoot, session_id: nextId, transcript_path: nextTranscript, stop_hook_active: true }, "Stop").decision, "block");
      ${filesystemCleanup()}
    `);
  });
}

for (const eventName of ["PostToolUse", "PostToolUseFailure"]) {
  test(`${eventName} missing-plan cleanup cannot select a same-session replacement generation`, () => {
    runIsolated(`
      ${filesystemPrelude(`terminal-replacement-${eventName}`)}
      try {
        ${checkpointFaultSetup()}
        const { randomUUID } = await import("node:crypto");
        fs.rmSync(planPath(repositoryRoot));
        let fired = false;
        let replacement;
        fs.appendFileSync = (filePath, ...args) => {
          const result = originalAppendFileSync(filePath, ...args);
          if (!fired && inRuns(filePath)) {
            fired = true;
            replacement = Buffer.from(JSON.stringify({ ...JSON.parse(attachmentBefore), claimGeneration: randomUUID() }));
            originalWriteFileSync(attachmentFile, replacement);
          }
          return result;
        };
        syncBuiltinESMExports();
        const output = handleHook({ ...input, tool_use_id: "different-terminal" }, ${JSON.stringify(eventName)});
        assert.equal(fired, true);
        assert.match(output.additionalContext, /cleanup.*failed/i);
        assert.deepEqual(originalReadFileSync(attachmentFile), replacement);
        assert.equal(JSON.parse(originalReadFileSync(routeFile)).status, "active");
        const records = originalReadFileSync(ledgerFile, "utf8").trim().split("\\n").map(JSON.parse);
        assert.equal(records.at(-1).event, "ownership_cleanup_failed");
        assert.equal(records.some((record) => record.event === "provisional_claim_released"), false);
      ${filesystemCleanup()}
    `);
  });
}

for (const event of ["tool_started", "tool_completed"]) {
  test(`failed durable ${event} persistence cannot authorize a start or resolve an orphan`, () => {
    runIsolated(`
      ${filesystemPrelude(`tool-persistence-${event}`)}
      try {
        ${checkpointFaultSetup(false, false)}
        const tool = { ...input, tool_name: "Bash", tool_use_id: "private-hint", tool_input: { command: "PRIVATE_COMMAND" } };
        const event = ${JSON.stringify(event)};
        if (event === "tool_completed") assert.deepEqual(handleHook(tool, "PreToolUse"), {});
        let fired = false;
        fs.appendFileSync = (filePath, ...args) => {
          if (!fired && inRuns(filePath) && String(args[0]).includes('"event":"' + event + '"')) {
            fired = true;
            throw new Error("PRIVATE_TERMINAL_FAILURE");
          }
          return originalAppendFileSync(filePath, ...args);
        };
        syncBuiltinESMExports();
        const output = handleHook(tool, event === "tool_started" ? "PreToolUse" : "PostToolUse");
        assert.equal(fired, true);
        if (event === "tool_started") assert.equal(output.permissionDecision, "deny");
        else {
          assert.match(output.additionalContext, /outcome remains unknown/);
          const observations = summarizePlan(repositoryRoot).operations;
          assert.equal(observations.status, "observed");
          assert.equal(observations.orphans.length, 1);
          assert.equal(observations.orphans[0].observationStatus, "outcome-unknown");
        }
        assert.deepEqual(originalReadFileSync(attachmentFile), attachmentBefore);
        assert.doesNotMatch(JSON.stringify(output), /PRIVATE_/);
      ${filesystemCleanup()}
    `);
  });
}

for (const bound of ["file-count", "aggregate-bytes"]) {
  test(`journal storage admission preserves acknowledged records at ${bound} limit`, () => {
    runIsolated(`
      ${filesystemPrelude(`journal-bound-${bound}`)}
      try {
        ${checkpointFaultSetup(false, false)}
        const before = originalReadFileSync(ledgerFile);
        const directory = path.dirname(ledgerFile);
        const fileCount = ${bound === "file-count" ? 256 : 17};
        const snapshots = [];
        for (let index = 0; index < fileCount; index += 1) {
          const hash = sha256("bounded-session-" + index);
          const filePath = path.join(directory, hash + ".jsonl");
          const records = [];
          const recordCount = ${bound === "file-count" ? 1 : 85};
          for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
            records.push(JSON.stringify({ schemaVersion: 1,
              at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, recordIndex)).toISOString(),
              event: "pre_compact", session: hash, trigger: "x".repeat(${bound === "file-count" ? 1 : 12_000}) }));
          }
          const bytes = Buffer.from(records.join("\\n") + "\\n");
          assert.ok(bytes.length <= 1_048_576);
          fs.writeFileSync(filePath, bytes);
          snapshots.push([filePath, sha256(bytes)]);
        }
        if (${bound === "aggregate-bytes"}) {
          assert.ok(snapshots.reduce((total, [filePath]) => total + originalReadFileSync(filePath).length, before.length) > 16_777_216);
        } else {
          assert.equal(fs.readdirSync(directory).length, 257);
        }
        const output = handleHook({ ...input, tool_name: "read_file", tool_use_id: "bounded-observation",
          tool_input: { filePath: path.join(repositoryRoot, "README.md") } }, "PreToolUse");
        assert.equal(output.permissionDecision, "deny");
        assert.deepEqual(originalReadFileSync(ledgerFile), before);
        for (const [filePath, hash] of snapshots) assert.equal(sha256(originalReadFileSync(filePath)), hash);
        assert.equal(fs.readdirSync(directory).length, fileCount + 1);
      ${filesystemCleanup()}
    `, 30_000);
  });
}

test("receipt publication excludes claim, resume, and explicit release until logical detach", () => {
  runIsolated(`
    ${filesystemPrelude("checkpoint-contention")}
    try {
      ${checkpointFaultSetup()}
      let fired = false;
      let claimReached = false;
      let resumeReached = false;
      let releaseReached = false;
      fs.renameSync = (source, destination) => {
        const result = originalRenameSync(source, destination);
        if (!fired && inReceipts(destination)) {
          fired = true;
          assert.deepEqual(originalReadFileSync(attachmentFile), attachmentBefore);
          claimReached = true;
          assert.equal(handleHook({ cwd: repositoryRoot, session_id: "competing-claim", tool_name: "Write", tool_input: { file_path: planPath(repositoryRoot) } }, "PreToolUse").permissionDecision, "deny");
          resumeReached = true;
          assert.throws(() => resumeSession(repositoryRoot, { session_id: "competing-resume", planHash: request.planHash, checkpointHash: path.basename(destination, ".json") }), /lifecycle/);
          releaseReached = true;
          assert.throws(() => releaseAttachment(repositoryRoot), /repository lifecycle lock is busy/);
          assert.deepEqual(originalReadFileSync(attachmentFile), attachmentBefore);
        }
        return result;
      };
      syncBuiltinESMExports();
      assert.equal(checkpointSession(repositoryRoot, request).status, "checkpointed");
      assert.equal(fired && claimReached && resumeReached && releaseReached, true);
      assert.equal(JSON.parse(originalReadFileSync(attachmentFile)).status, "checkpointed");
    ${filesystemCleanup()}
  `);
});

test("a copied lock owner at receipt publication cannot authorize detach or clean up its replacement", () => {
  runIsolated(`
    ${filesystemPrelude("checkpoint-copied-lock")}
    try {
      ${checkpointFaultSetup()}
      const lockDirectory = path.join(repositoryRoot, ".supervised-worker", "locks", "lifecycle");
      const copiedOwner = path.join(base, "copied-checkpoint-lock.json");
      let ownerPath;
      let fired = false;
      fs.renameSync = (source, destination) => {
        const result = originalRenameSync(source, destination);
        if (!fired && inReceipts(destination)) {
          fired = true;
          const entries = originalReaddirSync(lockDirectory);
          assert.equal(entries.length, 1);
          ownerPath = path.join(lockDirectory, entries[0]);
          originalWriteFileSync(copiedOwner, originalReadFileSync(ownerPath));
          assert.notEqual(originalLstatSync(ownerPath, { bigint: true }).ino, originalLstatSync(copiedOwner, { bigint: true }).ino);
        }
        return result;
      };
      fs.lstatSync = (filePath, ...args) => {
        if (fired && path.resolve(String(filePath)) === ownerPath) return originalLstatSync(copiedOwner, ...args);
        return originalLstatSync(filePath, ...args);
      };
      syncBuiltinESMExports();
      assert.throws(() => checkpointSession(repositoryRoot, request), /lock ownership changed/);
      assert.equal(fired, true);
      assert.deepEqual(originalReadFileSync(attachmentFile), attachmentBefore);
      assert.equal(originalExistsSync(lockDirectory), true);
      assert.equal(originalExistsSync(ownerPath), true);
      assert.equal(JSON.parse(originalReadFileSync(routeFile)).status, "active");
    ${filesystemCleanup()}
  `);
});

test("a delayed explicit release cannot delete the checkpoint successor", () => {
  runIsolated(`
    ${filesystemPrelude("checkpoint-delayed-release")}
    try {
      ${checkpointFaultSetup()}
      const lockDirectory = path.join(repositoryRoot, ".supervised-worker", "locks", "lifecycle");
      let fired = false;
      let successorBytes;
      fs.mkdirSync = (directory, ...args) => {
        if (!fired && path.resolve(String(directory)) === lockDirectory) {
          fired = true;
          const checkpoint = checkpointSession(repositoryRoot, request);
          assert.equal(resumeSession(repositoryRoot, { session_id: "release-proof-successor", planHash: request.planHash, checkpointHash: checkpoint.checkpointHash }).status, "resumed");
          successorBytes = originalReadFileSync(attachmentFile);
          assert.notEqual(JSON.parse(successorBytes).claimGeneration, JSON.parse(attachmentBefore).claimGeneration);
        }
        return originalMkdirSync(directory, ...args);
      };
      syncBuiltinESMExports();
      assert.throws(() => releaseAttachment(repositoryRoot), { transitionCode: "CAMPAIGN_COMPARE_AND_SET_CONFLICT" });
      assert.equal(fired, true);
      assert.deepEqual(originalReadFileSync(attachmentFile), successorBytes);
    ${filesystemCleanup()}
  `);
});

test("checkpoint publication cannot overwrite a replacement generation introduced at its temporary write", () => {
  runIsolated(`
    ${filesystemPrelude("checkpoint-replaced-generation")}
    try {
      ${checkpointFaultSetup()}
      const { randomUUID } = await import("node:crypto");
      let fired = false;
      let replacement;
      fs.writeFileSync = (filePath, ...args) => {
        const result = originalWriteFileSync(filePath, ...args);
        if (!fired && String(filePath).startsWith(attachmentFile + ".") && String(args[0]).includes('"checkpointed"')) {
          fired = true;
          replacement = Buffer.from(JSON.stringify({ ...JSON.parse(attachmentBefore), sessionHash: sha256("replacement-owner"), claimGeneration: randomUUID() }));
          originalWriteFileSync(attachmentFile, replacement);
        }
        return result;
      };
      syncBuiltinESMExports();
      assert.throws(() => checkpointSession(repositoryRoot, request), { transitionCode: "CAMPAIGN_COMPARE_AND_SET_CONFLICT" });
      assert.equal(fired, true);
      assert.deepEqual(originalReadFileSync(attachmentFile), replacement);
      assert.equal(JSON.parse(originalReadFileSync(routeFile)).status, "active");
    ${filesystemCleanup()}
  `);
});

for (const ownerless of [false, true]) {
  test(`a restarted process reports a real unobserved side effect without replay (ownerless=${ownerless})`, () => {
    const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "supervised-worker-restart-")));
    const sideEffect = path.join(cwd, "performed-once.txt");
    try {
      const first = spawnSync(process.execPath, ["--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        import { readFileSync, writeFileSync } from "node:fs";
        import path from "node:path";
        import { canonicalPlanHash, handleHook, planPath, sha256 } from ${JSON.stringify(coreUrl)};
        const cwd = ${JSON.stringify(cwd)};
        const input = { cwd, session_id: "crashed-session", tool_name: "Write", tool_use_id: "setup", tool_input: { file_path: planPath(cwd) } };
        assert.deepEqual(handleHook(input, "PreToolUse"), {});
        const plan = { schemaVersion: 1, mode: "active", goal: "Fixture", items: [{ id: "one", title: "One", status: "pending" }], completion: null };
        writeFileSync(planPath(cwd), JSON.stringify(plan));
        assert.deepEqual(handleHook(input, "PostToolUse"), {});
        assert.deepEqual(handleHook({ ...input, tool_name: "Bash", tool_use_id: "unobserved-effect", tool_input: { command: "PRIVATE_SIDE_EFFECT_ARGUMENT" } }, "PreToolUse"), {});
        const records = readFileSync(path.join(cwd, ".supervised-worker", "runs", sha256(input.session_id) + ".jsonl"), "utf8").trim().split("\\n").map(JSON.parse);
        const start = records.at(-1);
        assert.equal(start.event, "tool_started");
        assert.equal(records.some((record) => record.event === "tool_completed" && record.operationId === start.operationId), false);
        writeFileSync(${JSON.stringify(sideEffect)}, "performed-once\\n", { flag: "wx" });
        process.stdout.write(JSON.stringify({ operationId: start.operationId, request: { session_id: input.session_id, planHash: canonicalPlanHash(plan), attachmentHash: sha256(readFileSync(path.join(cwd, ".supervised-worker", "attachment.json"))) } }));
      `], { encoding: "utf8", timeout: 10_000 });
      assert.equal(first.error, undefined, first.error?.message);
      assert.equal(first.status, 0, first.stderr);
      const observed = JSON.parse(first.stdout);
      assert.match(observed.operationId, /^[0-9a-f-]{36}$/);
      assert.equal(readFileSync(sideEffect, "utf8"), "performed-once\n");
      if (ownerless) rmSync(path.join(cwd, ".supervised-worker", "attachment.json"));
      const second = spawnSync(process.execPath, ["--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        import { readFileSync } from "node:fs";
        import { checkpointSession, resumeSession } from ${JSON.stringify(coreUrl)};
        const cwd = ${JSON.stringify(cwd)};
        const observed = ${JSON.stringify(observed)};
        const checkpointHash = ${ownerless} ? null : checkpointSession(cwd, observed.request).checkpointHash;
        const resumed = resumeSession(cwd, { session_id: "fresh-process", planHash: observed.request.planHash, checkpointHash });
        assert.equal(resumed.status, "resumed");
        assert.equal(resumed.context.operations.status, "observed");
        assert.equal(resumed.context.operations.orphans.length, 1);
        assert.equal(resumed.context.operations.orphans[0].operationId, observed.operationId);
        assert.equal(resumed.context.operations.orphans[0].observationStatus, "outcome-unknown");
        assert.equal(readFileSync(${JSON.stringify(sideEffect)}, "utf8"), "performed-once\\n");
      `], { encoding: "utf8", timeout: 10_000 });
      assert.equal(second.error, undefined, second.error?.message);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(readFileSync(sideEffect, "utf8"), "performed-once\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("repository claim publication excludes another session and explicit release", () => {
  runIsolated(`
    ${filesystemPrelude("repository-claim-exclusion")}
    try {
      const { handleHook, planPath, releaseAttachment, sha256 } = await import(${JSON.stringify(coreUrl)});
      const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
      const input = {
        cwd: repositoryRoot,
        session_id: sessionId,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      };
      let injected = false;
      let competingClaimReached = false;
      let competingReleaseReached = false;
      fs.writeFileSync = (filePath, ...args) => {
        const result = originalWriteFileSync(filePath, ...args);
        if (!injected && path.resolve(String(filePath)) === path.resolve(attachmentPath)) {
          injected = true;
          assert.equal(JSON.parse(originalReadFileSync(attachmentPath, "utf8")).sessionHash, sha256(sessionId));
          competingClaimReached = true;
          assert.equal(handleHook({ ...input, session_id: "competing-owner" }, "PreToolUse").permissionDecision, "deny");
          competingReleaseReached = true;
          assert.throws(() => releaseAttachment(repositoryRoot), /repository lifecycle lock is busy/);
        }
        return result;
      };
      syncBuiltinESMExports();
      assert.deepEqual(handleHook(input, "PreToolUse"), {});
      assert.equal(injected, true);
      assert.equal(competingClaimReached, true);
      assert.equal(competingReleaseReached, true);
      assert.equal(JSON.parse(originalReadFileSync(attachmentPath, "utf8")).sessionHash, sha256(sessionId));
      assert.equal(originalExistsSync(path.join(repositoryRoot, ".supervised-worker", "locks", "lifecycle")), false);
    ${filesystemCleanup()}
  `);
});

test("release revalidates its pre-wait snapshot instead of removing a successor", () => {
  runIsolated(`
    ${filesystemPrelude("delayed-explicit-release")}
    try {
      const { handleHook, planPath, releaseAttachment, sha256 } = await import(${JSON.stringify(coreUrl)});
      const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
      const lockDirectory = path.join(repositoryRoot, ".supervised-worker", "locks", "lifecycle");
      const input = {
        cwd: repositoryRoot,
        session_id: sessionId,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      };
      assert.deepEqual(handleHook(input, "PreToolUse"), {});
      const originalAttachment = JSON.parse(originalReadFileSync(attachmentPath, "utf8"));
      let injected = false;
      let successorBytes = null;
      fs.mkdirSync = (directoryPath, ...args) => {
        if (!injected && path.resolve(String(directoryPath)) === path.resolve(lockDirectory)) {
          injected = true;
          assert.equal(releaseAttachment(repositoryRoot).released, true);
          assert.deepEqual(handleHook({ ...input, session_id: "release-successor" }, "PreToolUse"), {});
          successorBytes = originalReadFileSync(attachmentPath, "utf8");
          assert.notEqual(JSON.parse(successorBytes).claimGeneration, originalAttachment.claimGeneration);
        }
        return originalMkdirSync(directoryPath, ...args);
      };
      syncBuiltinESMExports();
      assert.throws(() => releaseAttachment(repositoryRoot), { transitionCode: "CAMPAIGN_COMPARE_AND_SET_CONFLICT" });
      assert.equal(injected, true);
      assert.equal(JSON.parse(successorBytes).sessionHash, sha256("release-successor"));
      assert.equal(originalReadFileSync(attachmentPath, "utf8"), successorBytes);
      assert.equal(originalExistsSync(lockDirectory), false);
    ${filesystemCleanup()}
  `);
});

test("repository contention remains bounded with a frozen wall clock and never steals the lock", () => {
  runIsolated(`
    ${filesystemPrelude("repository-frozen-clock")}
    const originalDateNow = Date.now;
    try {
      const { handleHook, planPath } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(repositoryRoot, ".supervised-worker", "locks", "lifecycle");
      fs.mkdirSync(lockDirectory, { recursive: true });
      const ownerPath = path.join(lockDirectory, "stale-owner.json");
      const ownerBytes = JSON.stringify({ token: "stale-owner", acquiredAt: "2000-01-01T00:00:00Z" });
      fs.writeFileSync(ownerPath, ownerBytes);
      let contentionReached = false;
      let renameAttempted = false;
      fs.mkdirSync = (directoryPath, ...args) => {
        if (path.resolve(String(directoryPath)) === path.resolve(lockDirectory)) contentionReached = true;
        return originalMkdirSync(directoryPath, ...args);
      };
      fs.renameSync = (source, destination) => {
        if (path.resolve(String(source)) === path.resolve(lockDirectory)) renameAttempted = true;
        return originalRenameSync(source, destination);
      };
      syncBuiltinESMExports();
      Date.now = () => 0;
      const started = performance.now();
      const output = handleHook({
        cwd: repositoryRoot,
        session_id: sessionId,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      const elapsed = performance.now() - started;
      assert.equal(contentionReached, true);
      assert.equal(output.permissionDecision, "deny");
      assert.ok(elapsed >= 200, "repository lock returned before its overlap window");
      assert.ok(elapsed < 1500, "repository lock depended on frozen wall time: " + elapsed);
      assert.equal(renameAttempted, false);
      assert.equal(originalReadFileSync(ownerPath, "utf8"), ownerBytes);
      assert.equal(originalExistsSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json")), false);
    } finally {
      Date.now = originalDateNow;
      fs.renameSync = originalRenameSync;
      fs.mkdirSync = originalMkdirSync;
      syncBuiltinESMExports();
      fs.rmSync(base, { recursive: true, force: true });
    }
  `);
});

test("repository lock cleanup cannot remove a copied replacement owner", () => {
  runIsolated(`
    ${filesystemPrelude("repository-copied-owner")}
    try {
      const { handleHook, planPath } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(repositoryRoot, ".supervised-worker", "locks", "lifecycle");
      const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
      const copiedOwnerPath = path.join(base, "copied-owner.json");
      let injected = false;
      let ownerPath = null;
      fs.writeFileSync = (filePath, ...args) => {
        const result = originalWriteFileSync(filePath, ...args);
        if (!injected && path.resolve(String(filePath)) === path.resolve(attachmentPath)) {
          injected = true;
          const entries = originalReaddirSync(lockDirectory);
          assert.equal(entries.length, 1);
          ownerPath = path.join(lockDirectory, entries[0]);
          originalWriteFileSync(copiedOwnerPath, originalReadFileSync(ownerPath));
        }
        return result;
      };
      fs.lstatSync = function injectedLstat(filePath, ...args) {
        if (fs.lstatSync === injectedLstat && injected && path.resolve(String(filePath)) === path.resolve(ownerPath)) {
          return originalLstatSync(copiedOwnerPath, ...args);
        }
        return originalLstatSync(filePath, ...args);
      };
      syncBuiltinESMExports();
      const output = handleHook({
        cwd: repositoryRoot,
        session_id: sessionId,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.equal(output.permissionDecision, "deny");
      assert.match(output.permissionDecisionReason, /LIFECYCLE_IDENTITY_REJECTED/);
      assert.equal(injected, true);
      assert.equal(originalExistsSync(lockDirectory), true);
      assert.equal(originalExistsSync(ownerPath), true);
      assert.equal(originalExistsSync(attachmentPath), true);
      const retainedLstat = fs.lstatSync;
      fs.lstatSync = originalLstatSync;
      syncBuiltinESMExports();
      originalRmSync(copiedOwnerPath);
      assert.equal(retainedLstat(ownerPath).isFile(), true, "restored fault injection must not affect retained filesystem consumers");
    ${filesystemCleanup()}
  `);
});

test("stale locks are never automatically renamed or replaced", () => {
  runIsolated(`
    ${filesystemPrelude("aba-lock-session")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      fs.mkdirSync(lockDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(lockDirectory, "owner.json"),
        JSON.stringify({
          schemaVersion: 1,
          token: "stale-owner",
          processId: 1,
          acquiredAt: "2000-01-01T00:00:00Z",
        }) + "\\n",
      );
      const expired = new Date(Date.now() - 60_000);
      fs.utimesSync(lockDirectory, expired, expired);
      let renameAttempted = false;
      fs.renameSync = (source, destination) => {
        if (path.resolve(source) === path.resolve(lockDirectory)) {
          renameAttempted = true;
        }
        return originalRenameSync(source, destination);
      };
      syncBuiltinESMExports();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.equal(output.permissionDecision, "deny");
      assert.equal(renameAttempted, false);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(lockDirectory, "owner.json"), "utf8")).token,
        "stale-owner",
      );
      assert.equal(
        fs.existsSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json")),
        false,
      );
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      assert.equal(fs.existsSync(routePath), false);
    ${filesystemCleanup()}
  `);
});

test("session lock overlap bound does not depend on wall-clock progress", () => {
  runIsolated(`
    ${filesystemPrelude("frozen-wall-clock-lock")}
    const originalDateNow = Date.now;
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      fs.mkdirSync(lockDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(lockDirectory, "owner.json"),
        JSON.stringify({
          schemaVersion: 1,
          token: "frozen-clock-owner",
          processId: process.pid,
          acquiredAt: "2026-09-04T00:00:00Z",
        }) + "\\n",
      );
      Date.now = () => 0;
      const started = performance.now();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      const elapsed = performance.now() - started;
      assert.equal(output.permissionDecision, "deny");
      assert.ok(elapsed >= 200, "lock wait returned before its overlap window");
      assert.ok(elapsed < 1_000, "lock wait depended on frozen wall time: " + elapsed);
      assert.equal(fs.existsSync(lockDirectory), true);
    ${filesystemCleanup()}
    Date.now = originalDateNow;
  `, 2_000);
});

test("concurrent cold-start parent creation is validated and reused", () => {
  runIsolated(`
    ${filesystemPrelude("cold-start-parent-race")}
    try {
      const { handleHook, planPath } = await import(${JSON.stringify(coreUrl)});
      const locksDirectory = path.join(storageRoot, "supervised-worker", "session-locks");
      let injected = false;
      fs.existsSync = (filePath) => {
        if (!injected && path.resolve(String(filePath)) === path.resolve(locksDirectory)) {
          return false;
        }
        return originalExistsSync(filePath);
      };
      fs.mkdirSync = (directoryPath, ...args) => {
        if (!injected && path.resolve(String(directoryPath)) === path.resolve(locksDirectory)) {
          injected = true;
          originalMkdirSync(directoryPath, ...args);
          const error = new Error("concurrent parent creation");
          error.code = "EEXIST";
          throw error;
        }
        return originalMkdirSync(directoryPath, ...args);
      };
      syncBuiltinESMExports();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.deepEqual(output, {});
      assert.equal(injected, true);
      assert.equal(originalExistsSync(locksDirectory), true);
      assert.equal(originalExistsSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json")), true);
    ${filesystemCleanup()}
  `);
});

test("state initialization failure is denied before any route claim", () => {
  runIsolated(`
    ${filesystemPrelude("posix-enotdir-state")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const statePath = path.join(repositoryRoot, ".supervised-worker");
      fs.writeFileSync(statePath, "not a directory\\n");
      const targetPlanPath = planPath(repositoryRoot);
      let injected = false;
      fs.lstatSync = (filePath, ...args) => {
        if (path.resolve(String(filePath)) === path.resolve(targetPlanPath)) {
          injected = true;
          const error = new Error("not a directory");
          error.code = "ENOTDIR";
          throw error;
        }
        return originalLstatSync(filePath, ...args);
      };
      syncBuiltinESMExports();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: targetPlanPath },
      }, "PreToolUse");
      assert.equal(output.permissionDecision, "deny");
      assert.equal(injected, true);
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      assert.equal(fs.existsSync(routePath), false);
      assert.equal(fs.readFileSync(statePath, "utf8"), "not a directory\\n");
    ${filesystemCleanup()}
  `);
});

test("acquisition rejects an empty replacement lock directory", () => {
  runIsolated(`
    ${filesystemPrelude("empty-replacement-aba")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      let injected = false;
      fs.readdirSync = (directoryPath, ...args) => {
        if (!injected && path.resolve(String(directoryPath)) === path.resolve(lockDirectory)) {
          injected = true;
          originalRmSync(lockDirectory, { recursive: true, force: true });
          originalMkdirSync(lockDirectory, { recursive: true });
        }
        return originalReaddirSync(directoryPath, ...args);
      };
      syncBuiltinESMExports();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.equal(output.permissionDecision, "deny");
      assert.equal(injected, true);
      assert.deepEqual(originalReaddirSync(lockDirectory), []);
      assert.equal(originalExistsSync(path.join(repositoryRoot, ".supervised-worker")), false);
    ${filesystemCleanup()}
  `);
});

test("acquisition rejects multiple owner entries", () => {
  runIsolated(`
    ${filesystemPrelude("multiple-owner-entries")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      let injected = false;
      fs.writeFileSync = (filePath, ...args) => {
        const result = originalWriteFileSync(filePath, ...args);
        if (!injected && path.dirname(String(filePath)) === lockDirectory) {
          injected = true;
          originalWriteFileSync(path.join(lockDirectory, "zz-foreign-owner.json"), "{}\\n");
        }
        return result;
      };
      syncBuiltinESMExports();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.equal(output.permissionDecision, "deny");
      assert.equal(injected, true);
      const entries = originalReaddirSync(lockDirectory);
      assert.equal(entries.length, 2);
      assert.equal(entries.at(-1), "zz-foreign-owner.json");
      assert.equal(originalExistsSync(path.join(repositoryRoot, ".supervised-worker")), false);
    ${filesystemCleanup()}
  `);
});

test("acquisition rejects copied owner identity at the canonical owner path", () => {
  runIsolated(`
    ${filesystemPrelude("copied-token-aba")}
    let replacementCompleted = false;
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      const copiedOwnerPath = path.join(storageRoot, "copied-owner.json");
      let ownerPath = null;
      fs.readdirSync = (directoryPath, ...args) => {
        const entries = originalReaddirSync(directoryPath, ...args);
        if (
          !replacementCompleted &&
          path.resolve(String(directoryPath)) === path.resolve(lockDirectory)
        ) {
          ownerPath = path.join(lockDirectory, entries[0]);
          originalWriteFileSync(copiedOwnerPath, originalReadFileSync(ownerPath));
          replacementCompleted = true;
        }
        return entries;
      };
      fs.lstatSync = (filePath, ...args) => {
        if (
          replacementCompleted &&
          path.resolve(String(filePath)) === path.resolve(ownerPath)
        ) {
          return originalLstatSync(copiedOwnerPath, ...args);
        }
        return originalLstatSync(filePath, ...args);
      };
      syncBuiltinESMExports();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.equal(output.permissionDecision, "deny");
      assert.equal(replacementCompleted, true);
      assert.notEqual(ownerPath, null);
      assert.notEqual(
        originalLstatSync(ownerPath, { bigint: true }).ino,
        originalLstatSync(copiedOwnerPath, { bigint: true }).ino,
      );
      assert.equal(originalExistsSync(lockDirectory), true);
      assert.equal(originalReaddirSync(lockDirectory).length, 1);
      assert.equal(originalExistsSync(path.join(repositoryRoot, ".supervised-worker")), false);
    ${filesystemCleanup()}
  `);
});

test("acquisition fails closed when an open owner blocks replacement", () => {
  runIsolated(`
    ${filesystemPrelude("copied-token-enotempty")}
    let replacementAttempted = false;
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      fs.readdirSync = (directoryPath, ...args) => {
        if (
          !replacementAttempted &&
          path.resolve(String(directoryPath)) === path.resolve(lockDirectory)
        ) {
          replacementAttempted = true;
          const error = new Error("open owner blocked recursive replacement");
          error.code = "ENOTEMPTY";
          throw error;
        }
        return originalReaddirSync(directoryPath, ...args);
      };
      syncBuiltinESMExports();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.equal(output.permissionDecision, "deny");
      assert.equal(replacementAttempted, true);
      assert.equal(originalExistsSync(lockDirectory), true);
      assert.equal(originalExistsSync(path.join(repositoryRoot, ".supervised-worker")), false);
    ${filesystemCleanup()}
  `);
});

test("acquisition fails closed when lock directory identity has zero inode", () => {
  runIsolated(`
    ${filesystemPrelude("zero-inode-acquire")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      fs.lstatSync = (filePath, ...args) => {
        const stats = originalLstatSync(filePath, ...args);
        if (path.resolve(String(filePath)) === path.resolve(lockDirectory)) {
          return new Proxy(stats, {
            get(target, property) {
              if (property === "ino") return 0n;
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }
        return stats;
      };
      syncBuiltinESMExports();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.equal(output.permissionDecision, "deny");
      assert.deepEqual(originalReaddirSync(lockDirectory), []);
      assert.equal(originalExistsSync(path.join(repositoryRoot, ".supervised-worker")), false);
    ${filesystemCleanup()}
  `);
});

test("acquisition fails closed when lock directory identity has zero device", () => {
  runIsolated(`
    ${filesystemPrelude("zero-device-acquire")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      fs.lstatSync = (filePath, ...args) => {
        const stats = originalLstatSync(filePath, ...args);
        if (path.resolve(String(filePath)) === path.resolve(lockDirectory)) {
          return new Proxy(stats, {
            get(target, property) {
              if (property === "dev") return 0n;
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }
        return stats;
      };
      syncBuiltinESMExports();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.equal(output.permissionDecision, "deny");
      assert.deepEqual(originalReaddirSync(lockDirectory), []);
      assert.equal(originalExistsSync(path.join(repositoryRoot, ".supervised-worker")), false);
    ${filesystemCleanup()}
  `);
});

test("lock lifecycle does not depend on birthtime or ctime identity", () => {
  runIsolated(`
    ${filesystemPrelude("timestamp-independent-lock")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      let ctimeOffset = 0n;
      fs.lstatSync = (filePath, ...args) => {
        const stats = originalLstatSync(filePath, ...args);
        if (path.resolve(String(filePath)) !== path.resolve(lockDirectory)) return stats;
        return new Proxy(stats, {
          get(target, property) {
            if (property === "birthtimeNs") return 0n;
            if (property === "ctimeNs") {
              ctimeOffset += 1n;
              return target.ctimeNs + ctimeOffset;
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
      syncBuiltinESMExports();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.deepEqual(output, {});
      assert.equal(originalExistsSync(lockDirectory), false);
      assert.equal(originalExistsSync(path.join(repositoryRoot, ".supervised-worker")), true);
    ${filesystemCleanup()}
  `);
});

test("partial owner write remains authoritative", () => {
  runIsolated(`
    ${filesystemPrelude("partial-owner-write")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      let injected = false;
      fs.writeFileSync = (filePath, ...args) => {
        if (!injected && path.dirname(String(filePath)) === lockDirectory) {
          injected = true;
          originalWriteFileSync(filePath, "{");
          const error = new Error("partial owner write");
          error.code = "EIO";
          throw error;
        }
        return originalWriteFileSync(filePath, ...args);
      };
      syncBuiltinESMExports();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.equal(output.permissionDecision, "deny");
      assert.equal(injected, true);
      const entries = originalReaddirSync(lockDirectory);
      assert.equal(entries.length, 1);
      assert.equal(originalReadFileSync(path.join(lockDirectory, entries[0]), "utf8"), "{");
      assert.equal(originalExistsSync(path.join(repositoryRoot, ".supervised-worker")), false);
    ${filesystemCleanup()}
  `);
});

test("owner creation failure cannot delete a replacement session lock", () => {
  runIsolated(`
    ${filesystemPrelude("owner-create-aba")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      const replacementPath = path.join(lockDirectory, "replacement-owner.json");
      const replacementBytes = JSON.stringify({
        schemaVersion: 1,
        token: "replacement-owner",
        processId: 42,
        acquiredAt: "2026-09-04T00:00:00Z",
      }) + "\\n";
      let injected = false;
      fs.writeFileSync = (filePath, ...args) => {
        if (!injected && path.dirname(String(filePath)) === lockDirectory) {
          injected = true;
          originalRmSync(lockDirectory, { recursive: true, force: true });
          originalMkdirSync(lockDirectory, { recursive: true });
          originalWriteFileSync(replacementPath, replacementBytes);
          const error = new Error("injected owner creation failure");
          error.code = "EACCES";
          throw error;
        }
        return originalWriteFileSync(filePath, ...args);
      };
      syncBuiltinESMExports();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.equal(output.permissionDecision, "deny");
      assert.equal(injected, true);
      assert.equal(originalReadFileSync(replacementPath, "utf8"), replacementBytes);
      assert.deepEqual(fs.readdirSync(lockDirectory), ["replacement-owner.json"]);
      assert.equal(fs.existsSync(path.join(repositoryRoot, ".supervised-worker")), false);
    ${filesystemCleanup()}
  `);
});

test("release rejects copied owner identity after reading the owner", () => {
  runIsolated(`
    ${filesystemPrelude("release-read-aba")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const common = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
      };
      const planTool = {
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      };
      handleHook({ ...common, ...planTool, hook_event_name: "PreToolUse" }, "PreToolUse");
      fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({
        schemaVersion: 1,
        mode: "active",
        goal: "Exercise release ABA protection.",
        items: [{ id: "one", title: "One", status: "pending" }],
        completion: null,
      }) + "\\n");
      handleHook({ ...common, ...planTool, hook_event_name: "PostToolUse" }, "PostToolUse");
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
      const routeBefore = fs.readFileSync(routePath, "utf8");
      const attachmentBefore = fs.readFileSync(attachmentPath, "utf8");
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      const copiedOwnerPath = path.join(storageRoot, "copied-release-owner.json");
      let replacementCompleted = false;
      let ownerPath = null;
      let retirementAttempted = false;
      fs.lstatSync = (filePath, ...args) => {
        if (
          replacementCompleted &&
          path.resolve(String(filePath)) === path.resolve(ownerPath)
        ) {
          return originalLstatSync(copiedOwnerPath, ...args);
        }
        return originalLstatSync(filePath, ...args);
      };
      fs.readFileSync = (filePath, ...args) => {
        const bytes = originalReadFileSync(filePath, ...args);
        if (!replacementCompleted && path.dirname(String(filePath)) === lockDirectory) {
          ownerPath = String(filePath);
          originalWriteFileSync(copiedOwnerPath, bytes);
          replacementCompleted = true;
        }
        return bytes;
      };
      fs.renameSync = (source, destination) => {
        if (path.resolve(String(source)) === path.resolve(lockDirectory)) {
          retirementAttempted = true;
        }
        return originalRenameSync(source, destination);
      };
      syncBuiltinESMExports();
      const output = handleHook({
        ...common,
        hook_event_name: "PostToolUse",
        tool_name: "read_file",
        tool_input: { filePath: path.join(repositoryRoot, "README.md") },
      }, "PostToolUse");
      assert.match(output.additionalContext, /LIFECYCLE_IDENTITY_REJECTED/);
      assert.equal(replacementCompleted, true);
      assert.notEqual(ownerPath, null);
      assert.notEqual(
        originalLstatSync(ownerPath, { bigint: true }).ino,
        originalLstatSync(copiedOwnerPath, { bigint: true }).ino,
      );
      assert.equal(retirementAttempted, false);
      assert.equal(originalExistsSync(lockDirectory), true);
      assert.equal(originalReaddirSync(lockDirectory).length, 1);
      assert.equal(originalReadFileSync(routePath, "utf8"), routeBefore);
      assert.equal(originalReadFileSync(attachmentPath, "utf8"), attachmentBefore);
    ${filesystemCleanup()}
  `);
});

test("release fails closed when an open owner blocks replacement", () => {
  runIsolated(`
    ${filesystemPrelude("release-read-enotempty")}
    let replacementAttempted = false;
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const common = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
      };
      const planTool = {
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      };
      handleHook({ ...common, ...planTool, hook_event_name: "PreToolUse" }, "PreToolUse");
      fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({
        schemaVersion: 1,
        mode: "active",
        goal: "Exercise blocked replacement during release.",
        items: [{ id: "one", title: "One", status: "pending" }],
        completion: null,
      }) + "\\n");
      handleHook({ ...common, ...planTool, hook_event_name: "PostToolUse" }, "PostToolUse");
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
      const routeBefore = fs.readFileSync(routePath, "utf8");
      const attachmentBefore = fs.readFileSync(attachmentPath, "utf8");
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      fs.readFileSync = (filePath, ...args) => {
        if (!replacementAttempted && path.dirname(String(filePath)) === lockDirectory) {
          replacementAttempted = true;
          const error = new Error("open owner blocked recursive replacement");
          error.code = "ENOTEMPTY";
          throw error;
        }
        return originalReadFileSync(filePath, ...args);
      };
      syncBuiltinESMExports();
      const output = handleHook({
        ...common,
        hook_event_name: "PostToolUse",
        tool_name: "read_file",
        tool_input: { filePath: path.join(repositoryRoot, "README.md") },
      }, "PostToolUse");
      assert.match(output.additionalContext, /LIFECYCLE_SYSCALL_FAILURE/);
      assert.equal(replacementAttempted, true);
      assert.equal(originalExistsSync(lockDirectory), true);
      assert.equal(originalReadFileSync(routePath, "utf8"), routeBefore);
      assert.equal(originalReadFileSync(attachmentPath, "utf8"), attachmentBefore);
    ${filesystemCleanup()}
  `);
});

test("release cleanup cannot delete a new live lock after atomic retirement", () => {
  runIsolated(`
    ${filesystemPrelude("release-retirement-aba")}
    let injected = false;
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const common = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
      };
      const planTool = {
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      };
      handleHook({ ...common, ...planTool, hook_event_name: "PreToolUse" }, "PreToolUse");
      fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({
        schemaVersion: 1,
        mode: "active",
        goal: "Exercise post-removal ABA protection.",
        items: [{ id: "one", title: "One", status: "pending" }],
        completion: null,
      }) + "\\n");
      handleHook({ ...common, ...planTool, hook_event_name: "PostToolUse" }, "PostToolUse");
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
      const routeBefore = fs.readFileSync(routePath, "utf8");
      const attachmentBefore = fs.readFileSync(attachmentPath, "utf8");
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      const replacementPath = path.join(lockDirectory, "replacement-owner.json");
      let retiredDirectory = null;
      fs.renameSync = (source, destination) => {
        const result = originalRenameSync(source, destination);
        if (!injected && path.resolve(String(source)) === path.resolve(lockDirectory)) {
          injected = true;
          retiredDirectory = String(destination);
          originalMkdirSync(lockDirectory, { recursive: true });
          originalWriteFileSync(replacementPath, "replacement\\n");
        }
        return result;
      };
      syncBuiltinESMExports();
      const output = handleHook({
        ...common,
        hook_event_name: "PostToolUse",
        tool_name: "read_file",
        tool_input: { filePath: path.join(repositoryRoot, "README.md") },
      }, "PostToolUse");
      assert.deepEqual(output, {});
      assert.equal(injected, true);
      assert.notEqual(retiredDirectory, null);
      assert.deepEqual(originalReaddirSync(lockDirectory), ["replacement-owner.json"]);
      assert.equal(originalReadFileSync(replacementPath, "utf8"), "replacement\\n");
      assert.equal(originalExistsSync(retiredDirectory), false);
      assert.equal(originalReadFileSync(routePath, "utf8"), routeBefore);
      assert.equal(originalReadFileSync(attachmentPath, "utf8"), attachmentBefore);
    ${filesystemCleanup()}
  `);
});

test("release cannot delete copied ownership swapped during atomic retirement", () => {
  runIsolated(`
    ${filesystemPrelude("release-rename-aba")}
    let injected = false;
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const common = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
      };
      const planTool = {
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      };
      handleHook({ ...common, ...planTool, hook_event_name: "PreToolUse" }, "PreToolUse");
      fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({
        schemaVersion: 1,
        mode: "active",
        goal: "Exercise retirement identity validation.",
        items: [{ id: "one", title: "One", status: "pending" }],
        completion: null,
      }) + "\\n");
      handleHook({ ...common, ...planTool, hook_event_name: "PostToolUse" }, "PostToolUse");
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      let retiredDirectory = null;
      let copiedOwnerPath = null;
      let copiedOwnerBytes = null;
      fs.renameSync = (source, destination) => {
        if (!injected && path.resolve(String(source)) === path.resolve(lockDirectory)) {
          injected = true;
          retiredDirectory = String(destination);
          const [ownerName] = originalReaddirSync(lockDirectory);
          const ownerPath = path.join(lockDirectory, ownerName);
          copiedOwnerBytes = originalReadFileSync(ownerPath, "utf8");
          originalRmSync(lockDirectory, { recursive: true, force: true });
          originalMkdirSync(lockDirectory, { recursive: true });
          copiedOwnerPath = path.join(lockDirectory, ownerName);
          originalWriteFileSync(copiedOwnerPath, copiedOwnerBytes);
        }
        return originalRenameSync(source, destination);
      };
      syncBuiltinESMExports();
      const output = handleHook({
        ...common,
        hook_event_name: "PostToolUse",
        tool_name: "read_file",
        tool_input: { filePath: path.join(repositoryRoot, "README.md") },
      }, "PostToolUse");
      assert.match(output.additionalContext, /LIFECYCLE_IDENTITY_REJECTED/);
      assert.equal(injected, true);
      assert.notEqual(retiredDirectory, null);
      const retiredOwnerPath = path.join(retiredDirectory, path.basename(copiedOwnerPath));
      assert.equal(originalReadFileSync(retiredOwnerPath, "utf8"), copiedOwnerBytes);
      assert.deepEqual(originalReaddirSync(retiredDirectory), [path.basename(copiedOwnerPath)]);
      assert.equal(originalExistsSync(lockDirectory), false);
    ${filesystemCleanup()}
  `);
});

test("release leaves its owner token when directory identity becomes zero", () => {
  runIsolated(`
    ${filesystemPrelude("zero-inode-release")}
    let zeroIdentity = false;
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const common = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
      };
      const planTool = {
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      };
      handleHook({ ...common, ...planTool, hook_event_name: "PreToolUse" }, "PreToolUse");
      fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({
        schemaVersion: 1,
        mode: "active",
        goal: "Exercise zero-inode release protection.",
        items: [{ id: "one", title: "One", status: "pending" }],
        completion: null,
      }) + "\\n");
      handleHook({ ...common, ...planTool, hook_event_name: "PostToolUse" }, "PostToolUse");
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
      const routeBefore = fs.readFileSync(routePath, "utf8");
      const attachmentBefore = fs.readFileSync(attachmentPath, "utf8");
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      fs.readFileSync = (filePath, ...args) => {
        const bytes = originalReadFileSync(filePath, ...args);
        if (path.dirname(String(filePath)) === lockDirectory) zeroIdentity = true;
        return bytes;
      };
      fs.lstatSync = (filePath, ...args) => {
        const stats = originalLstatSync(filePath, ...args);
        if (zeroIdentity && path.resolve(String(filePath)) === path.resolve(lockDirectory)) {
          return new Proxy(stats, {
            get(target, property) {
              if (property === "ino") return 0n;
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }
        return stats;
      };
      syncBuiltinESMExports();
      const output = handleHook({
        ...common,
        hook_event_name: "PostToolUse",
        tool_name: "read_file",
        tool_input: { filePath: path.join(repositoryRoot, "README.md") },
      }, "PostToolUse");
      assert.match(output.additionalContext, /LIFECYCLE_IDENTITY_REJECTED/);
      assert.equal(zeroIdentity, true);
      assert.equal(originalReaddirSync(lockDirectory).length, 1);
      assert.equal(originalReadFileSync(routePath, "utf8"), routeBefore);
      assert.equal(originalReadFileSync(attachmentPath, "utf8"), attachmentBefore);
    ${filesystemCleanup()}
  `);
});

test("release leaves its owner token when directory device becomes zero", () => {
  runIsolated(`
    ${filesystemPrelude("zero-device-release")}
    let zeroIdentity = false;
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const common = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
      };
      const planTool = {
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      };
      handleHook({ ...common, ...planTool, hook_event_name: "PreToolUse" }, "PreToolUse");
      fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({
        schemaVersion: 1,
        mode: "active",
        goal: "Exercise zero-device release protection.",
        items: [{ id: "one", title: "One", status: "pending" }],
        completion: null,
      }) + "\\n");
      handleHook({ ...common, ...planTool, hook_event_name: "PostToolUse" }, "PostToolUse");
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
      const routeBefore = fs.readFileSync(routePath, "utf8");
      const attachmentBefore = fs.readFileSync(attachmentPath, "utf8");
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      fs.readFileSync = (filePath, ...args) => {
        const bytes = originalReadFileSync(filePath, ...args);
        if (path.dirname(String(filePath)) === lockDirectory) zeroIdentity = true;
        return bytes;
      };
      fs.lstatSync = (filePath, ...args) => {
        const stats = originalLstatSync(filePath, ...args);
        if (zeroIdentity && path.resolve(String(filePath)) === path.resolve(lockDirectory)) {
          return new Proxy(stats, {
            get(target, property) {
              if (property === "dev") return 0n;
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }
        return stats;
      };
      syncBuiltinESMExports();
      const output = handleHook({
        ...common,
        hook_event_name: "PostToolUse",
        tool_name: "read_file",
        tool_input: { filePath: path.join(repositoryRoot, "README.md") },
      }, "PostToolUse");
      assert.match(output.additionalContext, /LIFECYCLE_IDENTITY_REJECTED/);
      assert.equal(zeroIdentity, true);
      assert.equal(originalReaddirSync(lockDirectory).length, 1);
      assert.equal(originalReadFileSync(routePath, "utf8"), routeBefore);
      assert.equal(originalReadFileSync(attachmentPath, "utf8"), attachmentBefore);
    ${filesystemCleanup()}
  `);
});

test("delayed lock poll cannot acquire after the overlap deadline", () => {
  runIsolated(`
    ${filesystemPrelude("delayed-lock-poll")}
    const originalAtomicsWait = Atomics.wait;
    let postDelayMkdirAttempts = 0;
    try {
      const { performance } = await import("node:perf_hooks");
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      fs.mkdirSync(lockDirectory, { recursive: true });
      fs.writeFileSync(path.join(lockDirectory, "owner.json"), "{}\\n");
      let delayed = false;
      Atomics.wait = () => {
        if (!delayed) {
          delayed = true;
          originalRmSync(lockDirectory, { recursive: true, force: true });
          const until = performance.now() + 300;
          while (performance.now() < until) {}
        }
        return "timed-out";
      };
      fs.mkdirSync = (directoryPath, ...args) => {
        if (delayed && path.resolve(String(directoryPath)) === path.resolve(lockDirectory)) {
          postDelayMkdirAttempts += 1;
        }
        return originalMkdirSync(directoryPath, ...args);
      };
      syncBuiltinESMExports();
      const started = performance.now();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      const elapsed = performance.now() - started;
      assert.equal(output.permissionDecision, "deny");
      assert.equal(delayed, true);
      assert.ok(elapsed >= 300, "delayed poll premise did not fire");
      assert.equal(postDelayMkdirAttempts, 0);
      assert.ok(elapsed < 4_000, "delayed poll exceeded its outer bound: " + elapsed);
      assert.equal(fs.existsSync(lockDirectory), false);
      assert.equal(fs.existsSync(path.join(repositoryRoot, ".supervised-worker")), false);
    } finally {
      Atomics.wait = originalAtomicsWait;
      fs.renameSync = originalRenameSync;
      fs.appendFileSync = originalAppendFileSync;
      fs.rmSync = originalRmSync;
      fs.mkdirSync = originalMkdirSync;
      fs.existsSync = originalExistsSync;
      fs.lstatSync = originalLstatSync;
      fs.readFileSync = originalReadFileSync;
      fs.readdirSync = originalReaddirSync;
      fs.writeFileSync = originalWriteFileSync;
      fs.rmdirSync = originalRmdirSync;
      syncBuiltinESMExports();
      fs.rmSync(base, { recursive: true, force: true });
    }
  `, 6_000);
});

test("slow routed-drive locality check completes before session locking", {
  skip: process.platform !== "win32",
}, (context) => {
  const tempDrive = path.parse(os.tmpdir()).root.toLowerCase();
  const checkoutDrive = path.parse(fileURLToPath(coreUrl)).root.toLowerCase();
  if (tempDrive === checkoutDrive) {
    context.skip("routed-drive ordering requires writable temp and checkout roots on different drives");
    return;
  }
  runIsolated(`
    import { createRequire, syncBuiltinESMExports } from "node:module";
    import { fileURLToPath } from "node:url";
    import os from "node:os";
    import path from "node:path";
    const require = createRequire(${JSON.stringify(testModuleUrl)});
    const fs = require("node:fs");
    const childProcess = require("node:child_process");
    const originalSpawnSync = childProcess.spawnSync;
    const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "supervised-worker-locality-plugin-"));
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "supervised-worker-locality-storage-"));
    const sourceDriveRoot = path.parse(fileURLToPath(${JSON.stringify(coreUrl)})).root;
    const repositoryRoot = fs.mkdtempSync(path.join(sourceDriveRoot, "supervised-worker-locality-repo-"));
    try {
      assert.notEqual(
        path.parse(pluginRoot).root.toLowerCase(),
        path.parse(repositoryRoot).root.toLowerCase(),
        "locality-order premise requires two drives",
      );
      const sessionId = "slow-routed-locality";
      const transcriptDirectory = path.join(storageRoot, "GitHub.copilot-chat", "transcripts");
      fs.mkdirSync(transcriptDirectory, { recursive: true });
      fs.writeFileSync(path.join(storageRoot, "workspace.json"), "{}\\n");
      const transcriptPath = path.join(transcriptDirectory, sessionId + ".jsonl");
      fs.writeFileSync(transcriptPath, "");
      childProcess.spawnSync = (executable, args, options) => {
        const name = path.basename(String(executable)).toLowerCase();
        if (name === "subst.exe") return { status: 0, stdout: "", stderr: "" };
        if (name === "net.exe" && args?.[0] === "use") {
          return { status: 2, stdout: "", stderr: "" };
        }
        return originalSpawnSync(executable, args, options);
      };
      syncBuiltinESMExports();
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const common = { session_id: sessionId, transcript_path: transcriptPath, cwd: pluginRoot };
      const planTool = { tool_name: "Write", tool_input: { file_path: planPath(repositoryRoot) } };
      assert.deepEqual(
        handleHook({ ...common, ...planTool, hook_event_name: "PreToolUse" }, "PreToolUse"),
        {},
      );
      fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({
        schemaVersion: 1,
        mode: "active",
        goal: "Exercise routed locality ordering.",
        items: [{ id: "one", title: "One", status: "pending" }],
        completion: null,
      }) + "\\n");
      assert.deepEqual(
        handleHook({ ...common, ...planTool, hook_event_name: "PostToolUse" }, "PostToolUse"),
        {},
      );
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      const routedDrive = path.parse(repositoryRoot).root.slice(0, 1).toUpperCase();
      let routedDriveProbeCount = 0;
      childProcess.spawnSync = (executable, args, options) => {
        const name = path.basename(String(executable)).toLowerCase();
        if (name === "subst.exe") return { status: 0, stdout: "", stderr: "" };
        if (
          name === "net.exe" &&
          args?.[0] === "use" &&
          args?.[1]?.toUpperCase() === routedDrive + ":"
        ) {
          routedDriveProbeCount += 1;
          assert.equal(fs.existsSync(lockDirectory), false, "slow locality check ran under lock");
          const until = performance.now() + 440;
          while (performance.now() < until) {}
          return { status: 2, stdout: "", stderr: "" };
        }
        if (name === "net.exe" && args?.[0] === "use") {
          return { status: 2, stdout: "", stderr: "" };
        }
        return originalSpawnSync(executable, args, options);
      };
      syncBuiltinESMExports();
      const started = performance.now();
      const output = handleHook({
        ...common,
        hook_event_name: "PostToolUse",
        tool_name: "read_file",
        tool_input: { filePath: path.join(repositoryRoot, "README.md") },
      }, "PostToolUse");
      const elapsed = performance.now() - started;
      assert.deepEqual(output, {});
      assert.equal(routedDriveProbeCount, 1);
      assert.ok(elapsed >= 400, "slow locality premise did not fire: " + elapsed);
      assert.ok(elapsed < 1_500, "routed locality preflight exceeded its bound: " + elapsed);
      assert.equal(fs.existsSync(lockDirectory), false);
      const records = fs.readFileSync(
        path.join(repositoryRoot, ".supervised-worker", "runs", sha256(sessionId) + ".jsonl"),
        "utf8",
      ).trim().split("\\n").map((line) => JSON.parse(line));
      assert.equal(records.at(-1).toolName, "read_file");
      assert.equal(records.at(-1).success, true);
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      syncBuiltinESMExports();
      fs.rmSync(pluginRoot, { recursive: true, force: true });
      fs.rmSync(storageRoot, { recursive: true, force: true });
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  `, 5_000);
});

test("locked route reread cannot spawn an uncached drive check", {
  skip: process.platform !== "win32",
}, () => {
  runIsolated(`
    import { createRequire, syncBuiltinESMExports } from "node:module";
    import os from "node:os";
    import path from "node:path";
    const require = createRequire(${JSON.stringify(testModuleUrl)});
    const fs = require("node:fs");
    const childProcess = require("node:child_process");
    const originalSpawnSync = childProcess.spawnSync;
    const originalReadFileSync = fs.readFileSync;
    const originalWriteFileSync = fs.writeFileSync;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "supervised-worker-route-drift-"));
    const pluginRoot = path.join(base, "plugin");
    const repositoryRoot = path.join(base, "repository");
    const storageRoot = path.join(base, "storage");
    for (const directory of [pluginRoot, repositoryRoot, storageRoot]) fs.mkdirSync(directory);
    try {
      const sessionId = "locked-route-reread";
      const transcriptDirectory = path.join(storageRoot, "GitHub.copilot-chat", "transcripts");
      fs.mkdirSync(transcriptDirectory, { recursive: true });
      fs.writeFileSync(path.join(storageRoot, "workspace.json"), "{}\\n");
      const transcriptPath = path.join(transcriptDirectory, sessionId + ".jsonl");
      fs.writeFileSync(transcriptPath, "");
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const common = { session_id: sessionId, transcript_path: transcriptPath, cwd: pluginRoot };
      const planTool = { tool_name: "Write", tool_input: { file_path: planPath(repositoryRoot) } };
      handleHook({ ...common, ...planTool, hook_event_name: "PreToolUse" }, "PreToolUse");
      fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({
        schemaVersion: 1,
        mode: "active",
        goal: "Exercise locked route reread.",
        items: [{ id: "one", title: "One", status: "pending" }],
        completion: null,
      }) + "\\n");
      handleHook({ ...common, ...planTool, hook_event_name: "PostToolUse" }, "PostToolUse");
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      const ledgerPath = path.join(
        repositoryRoot,
        ".supervised-worker",
        "runs",
        sha256(sessionId) + ".jsonl",
      );
      const ledgerBefore = fs.readFileSync(ledgerPath, "utf8");
      let routeReads = 0;
      let uncachedCalls = 0;
      let underLockCalls = 0;
      let injectedUnderLock = false;
      fs.readFileSync = (filePath, ...args) => {
        const bytes = originalReadFileSync(filePath, ...args);
        if (path.resolve(String(filePath)) === path.resolve(routePath)) {
          routeReads += 1;
          if (!injectedUnderLock && fs.existsSync(lockDirectory)) {
            injectedUnderLock = true;
            const route = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes);
            route.repositoryRoot = "Q:\\\\uncached-route";
            route.repositoryRootHash = sha256("q:\\\\uncached-route");
            originalWriteFileSync(routePath, JSON.stringify(route, null, 2) + "\\n");
          }
        }
        return bytes;
      };
      childProcess.spawnSync = (executable, args, options) => {
        if (path.basename(String(executable)).toLowerCase() === "net.exe" && args?.[1] === "Q:") {
          uncachedCalls += 1;
          if (fs.existsSync(lockDirectory)) underLockCalls += 1;
          return { status: 2, stdout: "", stderr: "" };
        }
        return originalSpawnSync(executable, args, options);
      };
      syncBuiltinESMExports();
      const output = handleHook({
        ...common,
        hook_event_name: "PostToolUse",
        tool_name: "read_file",
        tool_input: { filePath: path.join(repositoryRoot, "README.md") },
      }, "PostToolUse");
      assert.match(output.systemMessage, /could not verify its local state/);
      assert.equal(injectedUnderLock, true, "route drift must be injected while the lock is held");
      assert.equal(routeReads >= 2, true);
      assert.equal(uncachedCalls, 0);
      assert.equal(underLockCalls, 0);
      assert.equal(fs.existsSync(lockDirectory), false);
      assert.equal(originalReadFileSync(ledgerPath, "utf8"), ledgerBefore);
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      fs.readFileSync = originalReadFileSync;
      fs.writeFileSync = originalWriteFileSync;
      syncBuiltinESMExports();
      fs.rmSync(base, { recursive: true, force: true });
    }
  `, 5_000);
});

for (const failurePoint of ["attachment-migration", "route-promotion"]) {
  test(`v1 migration fault at ${failurePoint} releases the claimed route`, () => {
    runIsolated(`
      ${filesystemPrelude(`migration-${failurePoint}`)}
      try {
        const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
        const stateDirectory = path.join(repositoryRoot, ".supervised-worker");
        fs.mkdirSync(stateDirectory);
        fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({
          schemaVersion: 1,
          mode: "active",
          goal: "Exercise migration rollback.",
          items: [{ id: "one", title: "One", status: "in_progress" }],
          completion: null,
        }) + "\\n");
        const attachmentPath = path.join(stateDirectory, "attachment.json");
        const legacyAttachment = JSON.stringify({
          schemaVersion: 1,
          sessionHash: sha256(sessionId),
          attachedAt: "2026-09-01T00:00:00Z",
        }, null, 2) + "\\n";
        fs.writeFileSync(attachmentPath, legacyAttachment);
        const routePath = path.join(
          storageRoot,
          "supervised-worker",
          "session-roots",
          sha256(sessionId),
          "route.json",
        );
        let injected = false;
        fs.renameSync = (source, destination) => {
          const isAttachmentMigration = path.resolve(destination) === path.resolve(attachmentPath);
          const isRoutePromotion = path.resolve(destination) === path.resolve(routePath);
          if (!injected && (
            (${JSON.stringify(failurePoint)} === "attachment-migration" && isAttachmentMigration) ||
            (${JSON.stringify(failurePoint)} === "route-promotion" && isRoutePromotion)
          )) {
            injected = true;
            const error = new Error("injected rename failure");
            error.code = "EIO";
            throw error;
          }
          return originalRenameSync(source, destination);
        };
        syncBuiltinESMExports();
        const output = handleHook({
          hook_event_name: "PreToolUse",
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: pluginRoot,
          tool_name: "Write",
          tool_input: { file_path: planPath(repositoryRoot) },
        }, "PreToolUse");
        assert.equal(output.permissionDecision, "deny");
        assert.equal(injected, true);
        assert.equal(fs.readFileSync(attachmentPath, "utf8"), legacyAttachment);
        assert.equal(JSON.parse(fs.readFileSync(routePath, "utf8")).status, "released");
        assert.equal(
          fs.readdirSync(stateDirectory).some((name) => name.endsWith(".tmp")),
          false,
        );
      ${filesystemCleanup()}
    `);
  });
}

test("v1 migration restoration failure leaves released-route evidence for explicit recovery", () => {
  runIsolated(`
    ${filesystemPrelude("migration-restore-failure")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const stateDirectory = path.join(repositoryRoot, ".supervised-worker");
      fs.mkdirSync(stateDirectory);
      fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({
        schemaVersion: 1,
        mode: "active",
        goal: "Exercise restoration recovery.",
        items: [{ id: "one", title: "One", status: "in_progress" }],
        completion: null,
      }) + "\\n");
      const attachmentPath = path.join(stateDirectory, "attachment.json");
      fs.writeFileSync(attachmentPath, JSON.stringify({
        schemaVersion: 1,
        sessionHash: sha256(sessionId),
        attachedAt: "2026-09-01T00:00:00Z",
      }, null, 2) + "\\n");
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      let attachmentWrites = 0;
      let routeWrites = 0;
      fs.renameSync = (source, destination) => {
        if (path.resolve(destination) === path.resolve(attachmentPath)) {
          attachmentWrites += 1;
          if (attachmentWrites === 2) {
            const error = new Error("injected restoration failure");
            error.code = "EIO";
            throw error;
          }
        }
        if (path.resolve(destination) === path.resolve(routePath)) {
          routeWrites += 1;
          if (routeWrites === 1) {
            const error = new Error("injected route promotion failure");
            error.code = "EIO";
            throw error;
          }
        }
        return originalRenameSync(source, destination);
      };
      syncBuiltinESMExports();
      const common = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
      };
      const output = handleHook({
        ...common,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.equal(output.permissionDecision, "deny");
      assert.equal(attachmentWrites, 2);
      assert.equal(JSON.parse(fs.readFileSync(routePath, "utf8")).status, "released");
      fs.renameSync = originalRenameSync;
      syncBuiltinESMExports();
      const attachmentBefore = fs.readFileSync(attachmentPath);
      assert.deepEqual(
        handleHook({ ...common, hook_event_name: "SessionStart" }, "SessionStart"),
        {},
      );
      assert.deepEqual(fs.readFileSync(attachmentPath), attachmentBefore);
    ${filesystemCleanup()}
  `);
});

for (const eventName of ["PostToolUse", "PostToolUseFailure"]) {
  test(`${eventName} reports route-release failure without claiming cleanup`, () => {
    runIsolated(`
      ${filesystemPrelude(`detach-${eventName}`)}
      try {
        const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
        const common = {
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: pluginRoot,
          tool_name: "Write",
          tool_input: { file_path: planPath(repositoryRoot) },
        };
        assert.deepEqual(
          handleHook({ ...common, hook_event_name: "PreToolUse" }, "PreToolUse"),
          {},
        );
        const routePath = path.join(
          storageRoot,
          "supervised-worker",
          "session-roots",
          sha256(sessionId),
          "route.json",
        );
        const attachmentPath = path.join(
          repositoryRoot,
          ".supervised-worker",
          "attachment.json",
        );
        let injected = false;
        fs.renameSync = (source, destination) => {
          if (!injected && path.resolve(destination) === path.resolve(routePath)) {
            injected = true;
            const error = new Error("injected route release failure");
            error.code = "EIO";
            throw error;
          }
          return originalRenameSync(source, destination);
        };
        syncBuiltinESMExports();
        const output = handleHook(
          { ...common, hook_event_name: ${JSON.stringify(eventName)} },
          ${JSON.stringify(eventName)},
        );
        assert.equal(injected, true);
        assert.match(output.additionalContext, /cleanup.*failed/i);
        assert.doesNotMatch(output.additionalContext, /released its provisional claim/);
        assert.equal(JSON.parse(fs.readFileSync(routePath, "utf8")).status, "provisional");
        assert.equal(JSON.parse(fs.readFileSync(attachmentPath, "utf8")).status, "provisional");
        const runsDirectory = path.join(repositoryRoot, ".supervised-worker", "runs");
        const records = fs.readdirSync(runsDirectory).flatMap((name) =>
          fs.readFileSync(path.join(runsDirectory, name), "utf8")
            .trim()
            .split("\\n")
            .map((line) => JSON.parse(line)),
        );
        assert.equal(records.some((record) => record.event === "provisional_claim_released"), false);
        assert.equal(records.some((record) => record.event === "completion_unverified_release"), false);
        assert.equal(records.at(-1).event, "ownership_cleanup_failed");
      ${filesystemCleanup()}
    `);
  });
}

test("bounded Stop reports route-release failure without claiming cleanup", () => {
  runIsolated(`
    ${filesystemPrelude("detach-stop")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const common = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
      };
      const tool = {
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      };
      handleHook({ ...common, ...tool, hook_event_name: "PreToolUse" }, "PreToolUse");
      fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({
        schemaVersion: 1,
        mode: "active",
        goal: "Exercise Stop cleanup failure.",
        items: [{ id: "one", title: "One", status: "in_progress" }],
        completion: null,
      }) + "\\n");
      handleHook({ ...common, ...tool, hook_event_name: "PostToolUse" }, "PostToolUse");
      assert.equal(handleHook({ ...common, hook_event_name: "Stop" }, "Stop").decision, "block");
      assert.equal(
        handleHook({ ...common, hook_event_name: "Stop", stop_hook_active: true }, "Stop").decision,
        "block",
      );
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
      let injected = false;
      fs.renameSync = (source, destination) => {
        if (!injected && path.resolve(destination) === path.resolve(routePath)) {
          injected = true;
          const error = new Error("injected Stop release failure");
          error.code = "EIO";
          throw error;
        }
        return originalRenameSync(source, destination);
      };
      syncBuiltinESMExports();
      const output = handleHook(
        { ...common, hook_event_name: "Stop", stop_hook_active: true },
        "Stop",
      );
      assert.equal(injected, true);
      assert.equal(output.decision, "allow");
      assert.match(output.systemMessage, /cleanup failed/);
      assert.doesNotMatch(output.systemMessage, /released the Stop gate/);
      assert.equal(JSON.parse(fs.readFileSync(routePath, "utf8")).status, "active");
      assert.equal(JSON.parse(fs.readFileSync(attachmentPath, "utf8")).status, "active");
      const runsDirectory = path.join(repositoryRoot, ".supervised-worker", "runs");
      const records = fs.readdirSync(runsDirectory).flatMap((name) =>
        fs.readFileSync(path.join(runsDirectory, name), "utf8")
          .trim()
          .split("\\n")
          .map((line) => JSON.parse(line)),
      );
      assert.equal(records.some((record) => record.event === "completion_unverified_release"), false);
      assert.equal(records.at(-1).event, "ownership_cleanup_failed");
    ${filesystemCleanup()}
  `);
});

for (const eventName of ["PostToolUse", "PostToolUseFailure"]) {
  test(`${eventName} reports cleanup failure when its attachment disappears`, () => {
    runIsolated(`
      ${filesystemPrelude(`missing-attachment-${eventName}`)}
      try {
        const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
        const common = {
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: pluginRoot,
          tool_name: "Write",
          tool_input: { file_path: planPath(repositoryRoot) },
        };
        handleHook({ ...common, hook_event_name: "PreToolUse" }, "PreToolUse");
        const routePath = path.join(
          storageRoot,
          "supervised-worker",
          "session-roots",
          sha256(sessionId),
          "route.json",
        );
        const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
        let removed = false;
        fs.appendFileSync = (filePath, ...args) => {
          const result = originalAppendFileSync(filePath, ...args);
          if (!removed && String(filePath).includes(path.join(".supervised-worker", "runs"))) {
            removed = true;
            originalRmSync(attachmentPath, { force: true });
          }
          return result;
        };
        syncBuiltinESMExports();
        const output = handleHook(
          { ...common, hook_event_name: ${JSON.stringify(eventName)} },
          ${JSON.stringify(eventName)},
        );
        assert.equal(removed, true);
        assert.match(output.additionalContext, /cleanup.*failed/i);
        assert.equal(JSON.parse(fs.readFileSync(routePath, "utf8")).status, "provisional");
        assert.equal(fs.existsSync(attachmentPath), false);
        const runsDirectory = path.join(repositoryRoot, ".supervised-worker", "runs");
        const records = fs.readdirSync(runsDirectory).flatMap((name) =>
          fs.readFileSync(path.join(runsDirectory, name), "utf8")
            .trim()
            .split("\\n")
            .map((line) => JSON.parse(line)),
        );
        assert.equal(records.some((record) => record.event === "provisional_claim_released"), false);
        assert.equal(records.at(-1).event, "ownership_cleanup_failed");
      ${filesystemCleanup()}
    `);
  });
}

test("Stop reports cleanup failure when its attachment disappears", () => {
  runIsolated(`
    ${filesystemPrelude("missing-attachment-stop")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const common = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
      };
      handleHook({
        ...common,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
      let removed = false;
      fs.rmSync = (filePath, ...args) => {
        if (!removed && String(filePath).includes(path.join(".supervised-worker", "runtime"))) {
          removed = true;
          originalRmSync(attachmentPath, { force: true });
        }
        return originalRmSync(filePath, ...args);
      };
      syncBuiltinESMExports();
      const output = handleHook({ ...common, hook_event_name: "Stop" }, "Stop");
      assert.equal(removed, true);
      assert.equal(output.decision, "allow");
      assert.match(output.systemMessage, /cleanup failed/);
      assert.equal(JSON.parse(fs.readFileSync(routePath, "utf8")).status, "provisional");
      assert.equal(fs.existsSync(attachmentPath), false);
      const runsDirectory = path.join(repositoryRoot, ".supervised-worker", "runs");
      const records = fs.readdirSync(runsDirectory).flatMap((name) =>
        fs.readFileSync(path.join(runsDirectory, name), "utf8")
          .trim()
          .split("\\n")
          .map((line) => JSON.parse(line)),
      );
      assert.equal(records.some((record) => record.event === "provisional_claim_released"), false);
      assert.equal(records.at(-1).event, "ownership_cleanup_failed");
    ${filesystemCleanup()}
  `);
});

test("aggregate Windows drive checks remain bounded with slow child commands", {
  skip: process.platform !== "win32",
}, () => {
  runIsolated(`
    import assert from "node:assert/strict";
    import { createRequire, syncBuiltinESMExports } from "node:module";
    import path from "node:path";
    const require = createRequire(${JSON.stringify(testModuleUrl)});
    const childProcess = require("node:child_process");
    const originalSpawnSync = childProcess.spawnSync;
    let substCalls = 0;
    let netCalls = 0;
    try {
      childProcess.spawnSync = (executable, ...args) => {
        const name = path.basename(String(executable)).toLowerCase();
        if (name === "subst.exe") {
          substCalls += 1;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (name === "net.exe") {
          netCalls += 1;
          const end = Date.now() + 440;
          while (Date.now() < end) {}
          return { status: 2, stdout: "", stderr: "" };
        }
        return originalSpawnSync(executable, ...args);
      };
      syncBuiltinESMExports();
      const { handleHook } = await import(${JSON.stringify(coreUrl)});
      const replacements = [..."EFGHIJKLMNOPQ"].map((drive, index) => ({
        filePath: drive + ":\\\\repository-" + index + "\\\\.git\\\\config",
      }));
      const started = Date.now();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: "slow-drive-session",
        cwd: "D:\\\\supervised-worker",
        tool_name: "multi_replace_string_in_file",
        tool_input: { replacements },
      }, "PreToolUse");
      const elapsed = Date.now() - started;
      assert.equal(output.permissionDecision, "deny");
      assert.equal(substCalls, 1);
      assert.equal(netCalls, 3);
      assert.ok(elapsed < 2_200, "aggregate drive checks took " + elapsed + "ms");
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      syncBuiltinESMExports();
    }
  `, 5_000);
});
