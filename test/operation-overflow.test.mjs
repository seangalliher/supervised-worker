import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { canonicalPlanHash, sha256, summarizeRunLedger, validateCheckpoint, validateRecovery, validateSupervisorFailure } from "../src/core.mjs";
import { exactCounter, serializeRecovery, unknownCounter } from "../src/recovery-state.mjs";
import { withReliabilityFixture } from "./reliability-fixture.mjs";

const LIMIT = 256;
const invocationHash = (id) => sha256(`supervised-worker-tool-invocation-v1\0${id}`);
const operationIds = (operations) => operations.orphans.map((operation) => operation.operationId).sort();
const recordsAt = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);

function seedOperations(fixture, count, coverage = "complete") {
  const observation = fixture.observe();
  const session = sha256(fixture.input.session_id);
  const journalPath = path.join(fixture.cwd, ".supervised-worker", "runs", `${session}.jsonl`);
  const starts = Array.from({ length: count }, (_, index) => ({
    schemaVersion: 1, at: new Date(1_700_000_000_000 + index).toISOString(),
    event: "tool_started", session, toolName: "run_in_terminal", operationId: randomUUID(),
    invocationHash: invocationHash(`F3-seeded-${index}`), requestHash: sha256(`F3-request-${index}`),
    routeGeneration: observation.routeGeneration, claimGeneration: observation.claimGeneration,
  }));
  const inherited = coverage === "partial" ? [{
    schemaVersion: 1, at: "2023-01-01T00:00:00.000Z", event: "checkpoint_resumed", session,
    checkpointHash: null, planHash: canonicalPlanHash(fixture.plan), sourceSessionHash: sha256("F3-prior-history"),
    routeGeneration: observation.routeGeneration, claimGeneration: observation.claimGeneration,
    observationStatus: "unavailable", observationReason: "inherited-observation-unavailable",
  }] : [];
  fs.appendFileSync(journalPath, [...inherited, ...starts].map((record) => `${JSON.stringify(record)}\n`).join(""));
  const journalBytes = fs.readFileSync(journalPath);
  const selected = fixture.frontier();
  const frontier = {
    ...selected.frontier, sequence: selected.frontier.sequence + 1, previousHash: selected.frontierHash,
    transitionId: randomUUID(), cause: "tool-observation",
    operations: {
      coverage,
      orphans: starts.map((record) => ({
        operationId: record.operationId, sessionHash: session, invocationHash: record.invocationHash,
        routeGeneration: record.routeGeneration, claimGeneration: record.claimGeneration,
        toolName: record.toolName, observationStatus: "outcome-unknown",
      })),
      uncorrelatedCompletions: coverage === "complete" ? exactCounter(0) : unknownCounter(),
    },
    ledger: {
      coverage, segments: [{
        sessionHash: session, path: `runs/${session}.jsonl`, byteOffset: journalBytes.length,
        recordCount: recordsAt(journalPath).length, prefixHash: sha256(journalBytes),
      }],
    },
  };
  const bytes = serializeRecovery(frontier, "frontier");
  const frontierHash = sha256(bytes);
  fs.writeFileSync(path.join(fixture.cwd, ".supervised-worker", "recovery", "frontiers", `${frontierHash}.json`), bytes, { flag: "wx" });
  fs.writeFileSync(path.join(fixture.cwd, ".supervised-worker", "recovery", "head.json"),
    serializeRecovery({ schemaVersion: 1, kind: "recovery-head", campaignId: frontier.campaignId,
      sequence: frontier.sequence, frontierHash }, "head"));
  assert.deepEqual(validateRecovery(fixture.frontier().frontier, "frontier"), []);
  assert.equal(summarizeRunLedger(fixture.cwd).status, "available", "the seed must be a valid ledger, not a setup failure");
  return { journalPath, starts };
}

function fullBoundary(fixture, coverage = "complete", count = LIMIT) {
  const seeded = seedOperations(fixture, count - 1, coverage);
  const positive = { tool_name: "read_file", tool_use_id: "F3-positive-256",
    tool_input: { filePath: path.join(fixture.cwd, "README.md") } };
  const output = fixture.hook("PreToolUse", positive);
  assert.notEqual(output.permissionDecision, "deny", JSON.stringify(output));
  assert.match(fs.readFileSync(positive.tool_input.filePath, "utf8"), /Benign/);
  // The read occurred; withhold its completion until a test explicitly delivers it.
  // A stable frontier is not the current operation set after an ordinary hook.
  const operations = fixture.operations();
  assert.equal(operations.orphans.length, count, "the actual installed admission must reach the effective operation state");
  assert.equal(operations.coverage, coverage);
  assert.equal(summarizeRunLedger(fixture.cwd).status, "available");
  const positiveStart = recordsAt(seeded.journalPath).find((record) =>
    record.event === "tool_started" && record.invocationHash === invocationHash(positive.tool_use_id));
  assert.ok(positiveStart);
  return { ...seeded, positive, positiveStart, ids: operationIds(operations) };
}

function effectRequest(fixture, id) {
  return { tool_name: "Write", tool_use_id: id,
    tool_input: { file_path: path.join(fixture.cwd, `${id}.txt`), content: "must not execute" } };
}

function executeIfAllowed(request, output) {
  if (output.permissionDecision !== "deny") fs.writeFileSync(request.tool_input.file_path, request.tool_input.content, { flag: "wx" });
}

function matchingDenials(records, start) {
  return records.filter((record) => record.event === "tool_denied" && record.outcome === "not-executed" &&
    ["operationId", "session", "invocationHash", "requestHash", "routeGeneration", "claimGeneration"].every((key) => record[key] === start[key]));
}

function assertConserved(records, operations) {
  const unknown = new Set(operationIds(operations));
  for (const start of records.filter((record) => record.event === "tool_started")) {
    const completed = records.filter((record) => record.event === "tool_completed" &&
      ["operationId", "session", "invocationHash", "routeGeneration", "claimGeneration"].every((key) => record[key] === start[key]));
    assert.ok(unknown.has(start.operationId) || completed.length === 1 || matchingDenials(records, start).length === 1,
      `operation ${start.operationId} needs a retained unknown identity or a correlated durable terminal`);
  }
}

function checkpointAndResume(fixture, journalPath, ids) {
  const checkpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan),
    attachmentHash: fixture.observe().attachmentHash });
  assert.equal(checkpoint.status, "checkpointed");
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.cwd, ".supervised-worker", "checkpoints", `${checkpoint.checkpointHash}.json`)));
  assert.equal(receipt.schemaVersion, 3);
  assert.deepEqual(validateCheckpoint(receipt), []);
  assert.deepEqual(operationIds(receipt.context.operations), ids);
  const prefix = fs.readFileSync(journalPath).subarray(0, receipt.ledgerPosition.byteOffset);
  assert.equal(sha256(prefix), receipt.ledgerPosition.prefixHash);
  const records = prefix.toString("utf8").trim().split("\n").map(JSON.parse);
  assertConserved(records, receipt.context.operations);
  const originalJournal = fs.readFileSync(journalPath);
  fixture.select("F3-fresh-successor");
  const resumed = fixture.native(["resume"], { ...fixture.input, ...checkpoint.resume });
  assert.equal(resumed.status, "resumed");
  assert.deepEqual(operationIds(resumed.context.operations), ids);
  assertConserved(records, resumed.context.operations);
  assert.deepEqual(fs.readFileSync(journalPath), originalJournal);
  return resumed;
}

function faultedInstalledHook(fixture, request, fault, journalPath) {
  const cliPath = path.join(fixture.installRoot, "src", "cli.mjs");
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const originals = { appendFileSync: fs.appendFileSync, renameSync: fs.renameSync,
      openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync };
    const journal = ${JSON.stringify(journalPath)};
    const fault = ${JSON.stringify(fault)};
    const descriptors = new Map();
    let fired = 0;
    let publishedStart = false;
    let denialFired = 0;
    fs.openSync = (target, ...args) => {
      const fd = originals.openSync(target, ...args);
      descriptors.set(fd, target);
      return fd;
    };
    fs.closeSync = (fd) => { descriptors.delete(fd); return originals.closeSync(fd); };
    fs.renameSync = (from, to) => {
      const result = originals.renameSync(from, to);
      if (to === journal) publishedStart = true;
      return result;
    };
    fs.readSync = (fd, ...args) => {
      if (publishedStart && fired === 0 && descriptors.get(fd) === journal) {
        fired += 1;
        throw Object.assign(new Error("injected F3 operation observation failure"), { code: "EIO" });
      }
      return originals.readSync(fd, ...args);
    };
    fs.appendFileSync = (target, bytes, ...args) => {
      if (fault === "denial" && String(target).startsWith(journal + ".") && JSON.parse(String(bytes)).event === "tool_denied") {
        denialFired += 1;
        throw Object.assign(new Error("injected F3 denial persistence failure"), { code: "EIO" });
      }
      return originals.appendFileSync(target, bytes, ...args);
    };
    syncBuiltinESMExports();
    try {
      process.argv = [process.execPath, ${JSON.stringify(cliPath)}, "hook", "PreToolUse"];
      await import(${JSON.stringify(pathToFileURL(cliPath).href)});
    } finally {
      Object.assign(fs, originals);
      syncBuiltinESMExports();
    }
    assert.equal(fired, 1, "the exact F3 fault must fire once");
    assert.equal(denialFired, fault === "denial" ? 1 : 0, "the cancellation persistence fault must discriminate");
    process.stderr.write("F3 fault fired once\\n");
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: fixture.cwd, encoding: "utf8", input: JSON.stringify({ cwd: fixture.cwd, ...fixture.input, ...request }),
    timeout: fixture.hookTimeoutMs("PreToolUse"),
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stderr, /F3 fault fired once/);
  return JSON.parse(child.stdout);
}

for (const coverage of ["complete", "partial"]) {
  test(`reliability: F3 installed ${coverage} history denies operation 257 and conserves identities through handoff`, () => withReliabilityFixture((fixture) => {
    const { journalPath, ids } = fullBoundary(fixture, coverage);
    const request = effectRequest(fixture, "F3-overflow-257");
    const output = fixture.hook("PreToolUse", request);
    executeIfAllowed(request, output);
    assert.equal(output.permissionDecision, "deny", JSON.stringify(output));
    assert.equal(fs.existsSync(request.tool_input.file_path), false);
    assert.equal(output.supervisorFailure.code, "RECOVERY_OPERATION_LIMIT");
    const records = recordsAt(journalPath);
    const starts = records.filter((record) => record.event === "tool_started");
    // Admission used to publish an unrepresentable 257th start, then lose it.
    assert.equal(starts.length, LIMIT, "project the unresolved union before publishing the admission");
    assert.equal(records.some((record) => record.invocationHash === invocationHash(request.tool_use_id)), false);
    assert.deepEqual(operationIds(fixture.operations()), ids);
    assertConserved(records, fixture.operations());
    const resumed = checkpointAndResume(fixture, journalPath, ids);
    assert.equal(resumed.context.operations.coverage, coverage);
    assert.equal(fs.existsSync(request.tool_input.file_path), false);
  }));
}

test("reliability: F3 failed denial persistence retains the exact unknown and fences an unrepresentable checkpoint", () => withReliabilityFixture((fixture) => {
  const { journalPath, positive, positiveStart, ids } = fullBoundary(fixture, "complete", LIMIT - 1);
  const request = effectRequest(fixture, "F3-denial-write-failure");
  const before = fixture.observe();
  const output = faultedInstalledHook(fixture, request, "denial", journalPath);
  executeIfAllowed(request, output);
  assert.equal(output.permissionDecision, "deny", JSON.stringify(output));
  assert.equal(fs.existsSync(request.tool_input.file_path), false);
  let records = recordsAt(journalPath);
  const current = records.find((record) => record.event === "tool_started" && record.invocationHash === invocationHash(request.tool_use_id));
  assert.ok(current);
  assert.equal(records.filter((record) => record.event === "tool_started").length, LIMIT);
  assert.equal(matchingDenials(records, current).length, 0);
  assert.match(output.permissionDecisionReason, /outcome-unknown/);
  assert.ok(output.permissionDecisionReason.includes(current.operationId));
  assert.ok(operationIds(fixture.operations()).includes(current.operationId));
  // A pre-repair partial admission may also survive in history. Its exact ID
  // must make checkpoint fail, not be truncated to the latest 256 identities.
  const historical = { ...current, operationId: randomUUID(), invocationHash: invocationHash("F3-legacy-partial") };
  fs.appendFileSync(journalPath, `${JSON.stringify(historical)}\n`);
  records = recordsAt(journalPath);
  assert.equal(records.filter((record) => record.event === "tool_started").length, LIMIT + 1);
  assert.equal(summarizeRunLedger(fixture.cwd).status, "available", "the over-limit history remains structurally valid");
  const failed = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), attachmentHash: before.attachmentHash }, 1);
  assert.equal(failed.status, "unconfirmed");
  assert.match(failed.error, /orphan limit exceeded/);
  assert.deepEqual(validateSupervisorFailure(failed.failure), []);
  assert.equal(failed.failure.code, "RECOVERY_OPERATION_LIMIT");
  assert.deepEqual(fixture.observe(), before);
  assert.equal(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "checkpoints")), false);
  assert.deepEqual(recordsAt(journalPath), records);
  // Deliver the real earlier read's delayed completion, not a fabricated outcome
  // for the denied effect. Only that proven resolution frees an identity slot.
  assert.deepEqual(fixture.hook("PostToolUse", positive), {});
  const retained = ids.filter((id) => id !== positiveStart.operationId).concat(current.operationId, historical.operationId).sort();
  assert.deepEqual(operationIds(fixture.operations()), retained);
  assert.equal(fixture.operations().orphans.find((value) => value.operationId === current.operationId).observationStatus, "outcome-unknown");
  checkpointAndResume(fixture, journalPath, retained);
  assert.equal(fs.existsSync(request.tool_input.file_path), false);
}));

test("reliability: F3 preexisting over-bound history cannot checkpoint or retire its source", () => withReliabilityFixture((fixture) => {
  const { journalPath } = fullBoundary(fixture);
  const extra = { ...recordsAt(journalPath).find((record) => record.event === "tool_started"),
    operationId: randomUUID(), invocationHash: invocationHash("F3-preexisting-extra") };
  fs.appendFileSync(journalPath, `${JSON.stringify(extra)}\n`);
  assert.equal(recordsAt(journalPath).filter((record) => record.event === "tool_started").length, LIMIT + 1);
  assert.equal(summarizeRunLedger(fixture.cwd).status, "available", "over-bound operation history is structurally valid, not corruption");
  const before = fixture.observe();
  const bytes = fs.readFileSync(journalPath);
  const output = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), attachmentHash: before.attachmentHash }, 1);
  assert.equal(output.status, "unconfirmed");
  assert.match(output.error, /orphan limit exceeded/);
  assert.deepEqual(validateSupervisorFailure(output.failure), []);
  assert.equal(output.failure.code, "RECOVERY_OPERATION_LIMIT");
  assert.deepEqual(fixture.observe(), before);
  const stopped = fixture.hook("Stop");
  assert.equal(stopped.decision, "allow");
  assert.equal(stopped.release, undefined);
  assert.equal(stopped.supervisorFailure.code, "RECOVERY_OPERATION_LIMIT");
  assert.deepEqual(fixture.observe(), before);
  assert.deepEqual(fs.readFileSync(journalPath), bytes);
  assert.equal(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "checkpoints")), false);
}));

test("reliability: F3 retained and observed identity union cannot evade the 256 cap", () => withReliabilityFixture((fixture) => {
  const { journalPath, starts, ids } = fullBoundary(fixture, "partial");
  const original = fs.readFileSync(journalPath);
  const selected = fixture.frontier();
  const lost = starts[0].operationId;
  const records = recordsAt(journalPath).filter((record) => record.operationId !== lost);
  fs.writeFileSync(journalPath, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  assert.equal(recordsAt(journalPath).some((record) => record.operationId === lost), false, "the missing-record fault must fire");
  assert.ok(ids.includes(lost), "the authoritative frontier still retains the missing identity");
  assert.equal(summarizeRunLedger(fixture.cwd).status, "available");
  const request = effectRequest(fixture, "F3-union-overflow");
  const output = fixture.hook("PreToolUse", request);
  executeIfAllowed(request, output);
  assert.equal(output.permissionDecision, "deny", JSON.stringify(output));
  // This used to accept a rewritten prefix and only enforce the inherited union.
  // Recorded-byte integrity now fails before that projection can claim current evidence.
  assert.deepEqual(validateSupervisorFailure(output.supervisorFailure), []);
  assert.equal(fixture.operations().status, "unavailable");
  const after = recordsAt(journalPath);
  const start = after.find((record) => record.invocationHash === invocationHash(request.tool_use_id) && record.event === "tool_started");
  assert.equal(start, undefined, "missing old journal evidence cannot make room for a new admission");
  assert.equal(fixture.frontier().frontierHash, selected.frontierHash);
  assert.ok(operationIds(fixture.frontier().frontier.operations).includes(lost));
  assert.equal(fs.existsSync(request.tool_input.file_path), false);
  fs.writeFileSync(journalPath, original);
  assert.deepEqual(operationIds(fixture.operations()), ids);
  const restored = fixture.hook("PreToolUse", request);
  assert.equal(restored.permissionDecision, "deny");
  assert.equal(restored.supervisorFailure.code, "RECOVERY_OPERATION_LIMIT");
}));

test("reliability: F3 observation I/O fallback cannot admit a start whose identity was not retained", () => withReliabilityFixture((fixture) => {
  const { journalPath } = seedOperations(fixture, 2);
  const ids = operationIds(fixture.operations());
  const request = effectRequest(fixture, "F3-observation-failure");
  const output = faultedInstalledHook(fixture, request, "observation", journalPath);
  executeIfAllowed(request, output);
  assert.equal(output.permissionDecision, "deny", JSON.stringify(output));
  const records = recordsAt(journalPath);
  const start = records.find((record) => record.event === "tool_started" && record.invocationHash === invocationHash(request.tool_use_id));
  assert.ok(start);
  assert.equal(matchingDenials(records, start).length, 1);
  assert.deepEqual(operationIds(fixture.operations()), ids);
  assertConserved(records, fixture.operations());
  assert.equal(fs.existsSync(request.tool_input.file_path), false);
}));

test("reliability: F3 honest corruption fallback preserves inherited references without claiming fresh observation", () => withReliabilityFixture((fixture) => {
  const { journalPath } = seedOperations(fixture, 2);
  const ids = operationIds(fixture.operations());
  const before = fs.readFileSync(journalPath);
  const foreign = path.join(path.dirname(journalPath), "foreign.json");
  fs.writeFileSync(foreign, "{}\n");
  assert.equal(summarizeRunLedger(fixture.cwd).status, "unavailable", "the corruption fault must fire");
  const output = fixture.hook("Stop");
  assert.equal(output.decision, "block");
  assert.equal(output.supervisorFailure.code, "JOURNAL_OBSERVATION_UNCONFIRMED");
  assert.equal(fixture.frontier().frontier.operations.coverage, "partial");
  assert.deepEqual(operationIds(fixture.frontier().frontier.operations), ids);
  assert.deepEqual(fs.readFileSync(journalPath), before);
  assert.equal(fs.readFileSync(foreign, "utf8"), "{}\n");
}));

test("reliability: F3 a partially published start with absent host hints is cancelled without losing its reservation", () => withReliabilityFixture((fixture) => {
  fixture.tool("positive-before-absent-hints");
  const { journalPath } = seedOperations(fixture, 2);
  const ids = operationIds(fixture.operations());
  const output = faultedInstalledHook(fixture, { tool_name: "read_file" }, "observation", journalPath);
  assert.equal(output.permissionDecision, "deny", JSON.stringify(output));
  const records = recordsAt(journalPath);
  const started = records.find((record) => record.event === "tool_started" && record.invocationHash === null);
  assert.ok(started, "the partial start with absent hints must really have been published");
  assert.equal(started.requestHash, null);
  assert.equal(matchingDenials(records, started).length, 1);
  assert.deepEqual(operationIds(fixture.operations()), ids);
  assertConserved(records, fixture.operations());
}));

for (const conflict of ["duplicate", "inherited"]) {
  test(`reliability: F3 ${conflict} operation identity conflicts cannot fall back to a partial successful checkpoint`, () => withReliabilityFixture((fixture) => {
    fixture.tool(`positive-before-${conflict}-identity`);
    const { journalPath, starts } = seedOperations(fixture, 2);
    let head = fixture.frontier().frontierHash;
    if (conflict === "duplicate") {
      fs.appendFileSync(journalPath, `${JSON.stringify({ ...starts[0], at: "2026-01-01T00:00:00.000Z" })}\n`);
      assert.equal(recordsAt(journalPath).filter((record) => record.operationId === starts[0].operationId).length, 2);
    } else {
      const selected = fixture.frontier();
      // Change retained metadata, not committed journal bytes: prefix rollback
      // is now an earlier integrity failure, separate from identity conflict.
      const frontier = { ...selected.frontier, sequence: selected.frontier.sequence + 1,
        previousHash: selected.frontierHash, transitionId: randomUUID(),
        operations: { ...selected.frontier.operations, orphans: selected.frontier.operations.orphans.map((orphan) =>
          orphan.operationId === starts[0].operationId ? { ...orphan, toolName: "different_tool" } : orphan) } };
      const bytes = serializeRecovery(frontier, "frontier");
      head = sha256(bytes);
      const root = path.join(fixture.cwd, ".supervised-worker", "recovery");
      fs.writeFileSync(path.join(root, "frontiers", `${head}.json`), bytes, { flag: "wx" });
      fs.writeFileSync(path.join(root, "head.json"), serializeRecovery({ schemaVersion: 1, kind: "recovery-head",
        campaignId: frontier.campaignId, sequence: frontier.sequence, frontierHash: head }, "head"));
      assert.equal(fixture.frontier().frontier.operations.orphans.find((orphan) => orphan.operationId === starts[0].operationId).toolName, "different_tool");
    }
    const before = fixture.observe();
    assert.equal(summarizeRunLedger(fixture.cwd).status, "available", "the conflict is identity evidence, not malformed JSON");
    const bytes = fs.readFileSync(journalPath);
    const checkpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan),
      attachmentHash: before.attachmentHash }, 1);
    assert.equal(checkpoint.status, "unconfirmed");
    assert.match(checkpoint.error, /RECOVERY_OPERATION_CONFLICT/);
    assert.deepEqual(validateSupervisorFailure(checkpoint.failure), []);
    assert.equal(checkpoint.failure.code, "RECOVERY_OPERATION_CONFLICT");
    const stopped = fixture.hook("Stop");
    assert.equal(stopped.decision, "allow");
    assert.equal(stopped.release, undefined);
    assert.equal(stopped.supervisorFailure.code, "RECOVERY_OPERATION_CONFLICT");
    assert.equal(fixture.frontier().frontierHash, head);
    assert.deepEqual(fixture.observe(), before);
    assert.deepEqual(fs.readFileSync(journalPath), bytes);
  }));
}

for (const conflict of [false, true]) {
  test(`reliability: resume CLI retains typed operation ${conflict ? "conflict" : "limit"} failures`, () => withReliabilityFixture((fixture) => {
    const { journalPath } = fullBoundary(fixture, "complete", conflict ? 2 : LIMIT);
    const checkpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan),
      attachmentHash: fixture.observe().attachmentHash });
    assert.equal(checkpoint.status, "checkpointed");
    const original = recordsAt(journalPath).find((record) => record.event === "tool_started");
    const record = conflict ? { ...original, at: "2026-01-01T00:00:00.000Z" }
      : { ...original, operationId: randomUUID(), invocationHash: invocationHash("resume-overflow") };
    fs.appendFileSync(journalPath, `${JSON.stringify(record)}\n`);
    assert.equal(summarizeRunLedger(fixture.cwd).status, "available", "the added identity evidence must remain structurally valid");
    const bytes = fs.readFileSync(journalPath);
    const root = path.join(fixture.cwd, ".supervised-worker");
    const attachment = fs.readFileSync(path.join(root, "attachment.json"));
    const head = fixture.frontier().frontierHash;
    fixture.select(`typed-resume-${conflict ? "conflict" : "limit"}`);
    const result = fixture.native(["resume"], { ...fixture.input, ...checkpoint.resume }, 1);
    assert.equal(result.status, "unconfirmed");
    assert.equal(typeof result.error, "string");
    assert.deepEqual(validateSupervisorFailure(result.failure), []);
    assert.equal(result.failure.code, conflict ? "RECOVERY_OPERATION_CONFLICT" : "RECOVERY_OPERATION_LIMIT");
    assert.deepEqual(fs.readFileSync(journalPath), bytes);
    assert.deepEqual(fs.readFileSync(path.join(root, "attachment.json")), attachment);
    assert.equal(fixture.frontier().frontierHash, head);
  }));
}
