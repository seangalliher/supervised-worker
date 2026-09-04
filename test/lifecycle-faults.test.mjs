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
      fs.rmSync(base, { recursive: true, force: true });
    }
  `;
}

function checkpointFaultSetup() {
  return `
    const { canonicalPlanHash, checkpointSession, handleHook, planPath, releaseAttachment, resumeSession, sha256, summarizePlan, summarizeRunLedger } = await import(${JSON.stringify(coreUrl)});
    const input = { cwd: repositoryRoot, session_id: sessionId, transcript_path: transcriptPath,
      tool_name: "Write", tool_use_id: "setup-plan", tool_input: { file_path: planPath(repositoryRoot) } };
    assert.deepEqual(handleHook(input, "PreToolUse"), {});
    const plan = { schemaVersion: 1, mode: "active", goal: "PRIVATE_GOAL", items: [{ id: "item", title: "PRIVATE_TITLE", status: "pending" }], completion: null };
    fs.writeFileSync(planPath(repositoryRoot), JSON.stringify(plan));
    assert.deepEqual(handleHook(input, "PostToolUse"), {});
    assert.equal(handleHook({ ...input, stop_hook_active: false }, "Stop").decision, "block");
    const attachmentFile = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
    const attachmentBefore = originalReadFileSync(attachmentFile);
    assert.equal(JSON.parse(attachmentBefore).status, "active");
    const planBefore = originalReadFileSync(planPath(repositoryRoot));
    const routeFile = path.join(storageRoot, "supervised-worker", "session-roots", sha256(sessionId), "route.json");
    assert.equal(JSON.parse(originalReadFileSync(routeFile)).status, "active");
    const ledgerFile = path.join(repositoryRoot, ".supervised-worker", "runs", sha256(sessionId) + ".jsonl");
    const baseline = originalReadFileSync(ledgerFile, "utf8").trim().split("\\n").map(JSON.parse);
    assert.equal(baseline.filter((record) => record.event === "tool_started").length, 1);
    const request = { session_id: sessionId, transcript_path: transcriptPath, planHash: canonicalPlanHash(plan), attachmentHash: sha256(attachmentBefore) };
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
        ${checkpointFaultSetup()}
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
      assert.throws(() => releaseAttachment(repositoryRoot), /session attachment changed/);
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
      assert.throws(() => checkpointSession(repositoryRoot, request), /lifecycle/);
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
      assert.throws(() => releaseAttachment(repositoryRoot), /session attachment changed/);
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
      fs.lstatSync = (filePath, ...args) => {
        if (injected && path.resolve(String(filePath)) === path.resolve(ownerPath)) {
          return originalLstatSync(copiedOwnerPath, ...args);
        }
        return originalLstatSync(filePath, ...args);
      };
      syncBuiltinESMExports();
      assert.deepEqual(handleHook({
        cwd: repositoryRoot,
        session_id: sessionId,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse"), {});
      assert.equal(injected, true);
      assert.equal(originalExistsSync(lockDirectory), true);
      assert.equal(originalExistsSync(ownerPath), true);
      assert.equal(originalExistsSync(attachmentPath), true);
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
      assert.deepEqual(output, {});
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
      assert.deepEqual(output, {});
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
      assert.deepEqual(output, {});
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
      assert.deepEqual(output, {});
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
      assert.deepEqual(output, {});
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
      fs.readFileSync = (filePath, ...args) => {
        const bytes = originalReadFileSync(filePath, ...args);
        if (path.resolve(String(filePath)) === path.resolve(routePath)) {
          routeReads += 1;
          if (routeReads === 1) {
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

test("v1 migration restoration failure still leaves a recoverable released route", () => {
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
      assert.deepEqual(
        handleHook({ ...common, hook_event_name: "SessionStart" }, "SessionStart"),
        {},
      );
      assert.equal(fs.existsSync(attachmentPath), false);
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
