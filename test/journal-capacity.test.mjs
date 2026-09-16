import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { canonicalPlanHash, sha256, summarizeRunLedger } from "../src/core.mjs";
import { assessJournalCapacity, assessRecoveryCapacity, JournalOperationIndex, JOURNAL_EVENT_TRAFFIC, JOURNAL_LIMITS, projectJournalCapacity, RECOVERY_LIMITS } from "../src/journal-capacity.mjs";
import { failureFromError } from "../src/supervisor-diagnostics.mjs";
import { withReliabilityFixture } from "./reliability-fixture.mjs";

const H = "a".repeat(64);
const file = (bytes, index = 0, session = H) => ({ name: `${session}${index ? `.${String(index).padStart(6, "0")}` : ""}.jsonl`, bytes });

test("reliability: admission reserves two terminal records plus control bytes and rollover slots", () => {
  const result = assessJournalCapacity({ files: [file(JOURNAL_LIMITS.fileBytes - 100)], writes: [{ sessionHash: H, bytes: 100 }], newOperations: [H] });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.reserved, { terminalBytes: 32_768, terminalFiles: 1, controlBytes: 1_048_576, controlFiles: 4 });
  assert.equal(result.projected.files, 0);
  assert.equal(assessJournalCapacity({ files: [file(JOURNAL_LIMITS.fileBytes)], writes: [{ sessionHash: H, bytes: 1 }] }).projected.files, 1);
  assert.equal(assessJournalCapacity({ files: [], writes: [{ sessionHash: H, bytes: 100 }] }).projected.files, 1);
});

test("reliability: aggregate and physical-file limits deny new work but retain bounded terminal control headroom", () => {
  const files = Array.from({ length: 15 }, (_, index) => file(JOURNAL_LIMITS.fileBytes, index));
  const input = { files, writes: [{ sessionHash: H, bytes: 100 }] };
  assert.equal(assessJournalCapacity(input).allowed, false);
  assert.equal(assessJournalCapacity({ ...input, traffic: "control" }).allowed, true);
  const many = Array.from({ length: 252 }, (_, index) => file(1, index));
  assert.equal(assessJournalCapacity({ files: many, newOperations: ["b".repeat(64)] }).allowed, false);
  assert.equal(assessJournalCapacity({ files: many }).allowed, true);
  assert.equal(assessJournalCapacity({ files: [file(JOURNAL_LIMITS.fileBytes + 1)] }).reason, "physical-limit");
  assert.equal(assessJournalCapacity({ files: [file(10, 1)] }).reason, "physical-limit");
  assert.throws(() => assessJournalCapacity({ files: [file(10), file(10)] }));
  assert.throws(() => assessJournalCapacity({ files: [], traffic: "unclassified" }));
});

  test("reliability: every journal producer is classified and only proven terminals can consume a reservation", () => {
    const core = fs.readFileSync(new URL("../src/core.mjs", import.meta.url), "utf8");
    const inventory = core.slice(core.indexOf("const RUN_LEDGER_EVENT_FIELDS"), core.indexOf("export function sha256"));
    assert.deepEqual([...inventory.matchAll(/^\s*\["([a-z_]+)",/gm)].map((match) => match[1]).sort(), Object.keys(JOURNAL_EVENT_TRAFFIC).sort());
    const receiptSchema = JSON.parse(fs.readFileSync(new URL("../schemas/local-campaign-receipt.schema.json", import.meta.url)));
    assert.deepEqual(receiptSchema.$defs.eventCount.properties.event.enum, Object.keys(JOURNAL_EVENT_TRAFFIC).sort(),
      "the legacy campaign receipt consumer must recognize every classified producer, including frontier decisions");
    const started = { schemaVersion: 1, at: "2026-01-01T00:00:00.000Z", session: H, event: "tool_started",
      operationId: "11111111-1111-4111-8111-111111111111", invocationHash: H, routeGeneration: null, claimGeneration: null };
    const files = Array.from({ length: 15 }, (_, index) => file(JOURNAL_LIMITS.fileBytes, index));
    const completed = { ...started, event: "tool_completed" };
    const assessed = projectJournalCapacity({ files, records: [started], writes: [completed] });
    assert.equal(assessed.allowed, true);
    assert.equal(assessed.outstandingOperations, 0);
    assert.equal(projectJournalCapacity({ files, records: [], writes: [completed] }).allowed, false,
      "an uncorrelated or repeated completion is ordinary traffic, not an unlimited control-reserve producer");
    assert.equal(projectJournalCapacity({ files, records: [started], writes: [{ ...completed, invocationHash: "b".repeat(64) }] }).allowed, false);
    const helper = { ...started, event: "helper_attempt_reserved" };
    assert.equal(projectJournalCapacity({ files, records: [helper], writes: [{ ...helper, event: "helper_result" }] }).allowed, true);
    assert.equal(projectJournalCapacity({ files, records: [helper], writes: [{ ...helper, event: "helper_circuit_open" }] }).allowed, true);
    assert.equal(projectJournalCapacity({ files: [], records: [started, { ...started, event: "denied_retry_consumed" }] }).outstandingOperations, 1);
    assert.equal(projectJournalCapacity({ files: [], records: [], inherited: [{ ...started, sessionHash: H }] }).reserved.terminalBytes, 32768);
    assert.throws(() => projectJournalCapacity({ files: [], records: [{ ...started, event: "unclassified" }] }), /UNCLASSIFIED/);
    assert.throws(() => projectJournalCapacity({ files: [], records: null }));
    assert.throws(() => projectJournalCapacity({ files: [] }));
    assert.throws(() => projectJournalCapacity({ files: [], records: [], inherited: [{}] }));
    assert.throws(() => projectJournalCapacity({ files: [], records: [], controlWrites: [{ sessionHash: H, bytes: 16385 }] }));
  });

  function journalSnapshot(fixture) {
    const directory = path.join(fixture.cwd, ".supervised-worker", "runs");
    return Object.fromEntries(fs.readdirSync(directory).sort().map((name) => [name, fs.readFileSync(path.join(directory, name))]));
  }

  function paddedRecords(session, length, first = 0) {
    const result = [];
    let sequence = first;
    while (length > 0) {
      let size = Math.min(JOURNAL_LIMITS.recordBytes, length);
      if (length > size && length - size < 256) size -= 256;
      const record = JSON.stringify({ schemaVersion: 1, at: new Date(1_700_000_000_000 + sequence++).toISOString(),
        event: "pre_compact", session, trigger: "auto" });
      assert.ok(size > Buffer.byteLength(record));
      result.push(Buffer.from(`${record}${" ".repeat(size - Buffer.byteLength(record) - 1)}\n`));
      length -= size;
    }
    return { bytes: Buffer.concat(result), next: sequence };
  }

  function fillAggregate(fixture, target) {
    const directory = path.join(fixture.cwd, ".supervised-worker", "runs");
    const session = sha256("historical-capacity-fixture");
    let remaining = target - Object.values(journalSnapshot(fixture)).reduce((total, bytes) => total + bytes.length, 0);
    let sequence = 0;
    let segment = 0;
    while (remaining > 0) {
      const count = Math.min(JOURNAL_LIMITS.fileBytes, remaining);
      const padded = paddedRecords(session, count, sequence);
      sequence = padded.next;
      const name = `${session}${segment ? `.${String(segment).padStart(6, "0")}` : ""}.jsonl`;
      fs.writeFileSync(path.join(directory, name), padded.bytes);
      remaining -= count;
      segment += 1;
    }
    assert.equal(Object.values(journalSnapshot(fixture)).reduce((total, bytes) => total + bytes.length, 0), target);
    assert.equal(summarizeRunLedger(fixture.cwd).status, "available", "capacity injection must create valid, fully readable history");
  }

  function ordinary(fixture, id) {
    return { cwd: fixture.cwd, ...fixture.input, tool_name: "read_file", tool_use_id: id,
      tool_input: { filePath: path.join(fixture.cwd, "README.md") } };
  }

  test("reliability: live admission protects terminal and control reserves and repeated denials do not reset on resume", () => withReliabilityFixture((fixture) => {
    fixture.tool("capacity-live-positive");
    fillAggregate(fixture, JOURNAL_LIMITS.totalBytes - JOURNAL_LIMITS.controlBytes - 32768 - 768);
    const original = journalSnapshot(fixture);
    const request = ordinary(fixture, "admitted-terminal");
    assert.notEqual(fixture.hook("PreToolUse", request).permissionDecision, "deny");
    const measured = fixture.native(["recovery", "inspect"], fixture.input).capacity.journal;
    assert.equal(measured.outstandingOperations, 1);
    assert.equal(measured.reserved.terminalBytes, 32768);
    assert.equal(measured.reserved.controlBytes, JOURNAL_LIMITS.controlBytes);
    const admitted = journalSnapshot(fixture);
    for (let index = 0; index < 3; index += 1) {
      const denied = fixture.hook("PreToolUse", ordinary(fixture, `capacity-denied-${index}`));
      assert.equal(denied.permissionDecision, "deny", JSON.stringify(denied));
      assert.equal(denied.supervisorFailure.code, "JOURNAL_CAPACITY");
      assert.deepEqual(journalSnapshot(fixture), admitted, "capacity denials cannot spend protected journal headroom");
    }
    const completed = fixture.hook("PostToolUse", request);
    assert.equal(completed.additionalContext, undefined, JSON.stringify(completed));
    const diagnosis = fixture.native(["recovery", "inspect"], fixture.input);
    assert.equal(diagnosis.capacity.journal.outstandingOperations, 0);
    assert.ok(diagnosis.capacity.journal.measured.bytes > measured.measured.bytes);
    const checkpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), attachmentHash: fixture.observe().attachmentHash });
    fixture.select("capacity-successor");
    assert.equal(fixture.native(["resume"], { ...fixture.input, ...checkpoint.resume }).status, "resumed");
    const beforeDenial = journalSnapshot(fixture);
    const denied = fixture.hook("PreToolUse", ordinary(fixture, "successor-still-capacity-limited"));
    assert.equal(denied.permissionDecision, "deny");
    assert.equal(denied.supervisorFailure.code, "JOURNAL_CAPACITY");
    assert.deepEqual(journalSnapshot(fixture), beforeDenial, "a new session does not reset aggregate liability");
    for (const [name, bytes] of Object.entries(original)) assert.deepEqual(journalSnapshot(fixture)[name].subarray(0, bytes.length), bytes);
  }));

  test("reliability: live physical-file admission reserves rollover and successor control slots", () => withReliabilityFixture((fixture) => {
    fixture.tool("physical-files-positive");
    const directory = path.join(fixture.cwd, ".supervised-worker", "runs");
    const currentPath = path.join(directory, `${sha256(fixture.input.session_id)}.jsonl`);
    const before = fs.readFileSync(currentPath);
    fs.appendFileSync(currentPath, paddedRecords(sha256(fixture.input.session_id), JOURNAL_LIMITS.fileBytes - before.length).bytes);
    for (let index = 1; index < 252; index += 1) {
      const session = sha256(`historical-file-${index}`);
      fs.writeFileSync(path.join(directory, `${session}.jsonl`), paddedRecords(session, 256).bytes);
    }
    assert.equal(fs.readdirSync(directory).length, 252);
    assert.equal(summarizeRunLedger(fixture.cwd).status, "available");
    const original = journalSnapshot(fixture);
    const denied = fixture.hook("PreToolUse", ordinary(fixture, "rollover-denied"));
    assert.equal(denied.permissionDecision, "deny");
    assert.equal(denied.supervisorFailure.code, "JOURNAL_CAPACITY");
    assert.deepEqual(journalSnapshot(fixture), original);
    const checkpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), attachmentHash: fixture.observe().attachmentHash });
    assert.equal(fs.readdirSync(directory).length, 253, "checkpoint consumes its reserved rollover slot");
    fixture.select("file-capacity-successor");
    assert.equal(fixture.native(["resume"], { ...fixture.input, ...checkpoint.resume }).status, "resumed");
    assert.equal(fs.readdirSync(directory).length, 254, "the successor journal is explicitly charged");
    assert.equal(fixture.hook("PreToolUse", ordinary(fixture, "file-capacity-still-denied")).permissionDecision, "deny");
  }));

  function concurrentPreTool(fixture, id) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(fixture.installRoot, "src", "hook-launcher.mjs"), "PreToolUse"], {
        cwd: fixture.cwd, stdio: ["pipe", "pipe", "pipe"], timeout: fixture.hookTimeoutMs("PreToolUse"),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        try { assert.equal(signal, null, stderr); assert.equal(code, 0, stderr); resolve(JSON.parse(stdout)); }
        catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(ordinary(fixture, id)));
    });
  }

  test("reliability: competing native admissions cannot spend one remaining operation reservation twice", () => withReliabilityFixture(async (fixture) => {
    fixture.tool("concurrent-capacity-positive");
    fillAggregate(fixture, JOURNAL_LIMITS.totalBytes - JOURNAL_LIMITS.controlBytes - 32768 - 768);
    const outputs = await Promise.all([concurrentPreTool(fixture, "concurrent-one"), concurrentPreTool(fixture, "concurrent-two")]);
    assert.equal(outputs.filter((value) => value.permissionDecision !== "deny").length, 1, JSON.stringify(outputs));
    const diagnosis = fixture.native(["recovery", "inspect"], fixture.input);
    assert.equal(diagnosis.capacity.journal.outstandingOperations, 1);
    assert.equal(fixture.hook("PreToolUse", ordinary(fixture, "after-concurrent-capacity")).supervisorFailure.code, "JOURNAL_CAPACITY");
  }));
test("reliability: outstanding operations cannot spend their reserved terminal bytes twice", () => {
  const files = Array.from({ length: 15 }, (_, index) => file(index === 14 ? JOURNAL_LIMITS.fileBytes - 32_768 : JOURNAL_LIMITS.fileBytes, index));
  assert.equal(assessJournalCapacity({ files, outstanding: [H] }).allowed, true);
  assert.equal(assessJournalCapacity({ files, outstanding: [H], newOperations: [H] }).allowed, false);
  assert.equal(assessJournalCapacity({ files, outstanding: [H], writes: [{ sessionHash: H, bytes: 100 }], traffic: "terminal" }).allowed, true);
});

test("reliability: recovery store reserves finalization and rejects incomplete bundles before mutation", () => {
  const usage = { bytes: RECOVERY_LIMITS.bytes - RECOVERY_LIMITS.controlBytes, records: 100 };
  assert.equal(assessRecoveryCapacity(usage, [100]).allowed, false);
  assert.equal(assessRecoveryCapacity(usage, [100], "finalization").allowed, true);
  assert.equal(assessRecoveryCapacity({ bytes: 0, records: 1016 }, [1]).reason, "recovery-records");
  assert.equal(assessRecoveryCapacity({ bytes: 0, records: 1023 }, [1, 1], "finalization").allowed, false);
  assert.throws(() => assessRecoveryCapacity({ bytes: 0, records: 0 }, [262145]));
  assert.throws(() => assessRecoveryCapacity(null, []));
});

function capacityStart(index) {
  return { schemaVersion: 1, at: "2026-01-01T00:00:00.000Z", session: H, event: "tool_started", toolName: "read_file",
    operationId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, invocationHash: sha256(String(index)),
    requestHash: H, routeGeneration: null, claimGeneration: null };
}

function capacityOrphan(record) {
  return { operationId: record.operationId, sessionHash: record.session, invocationHash: record.invocationHash,
    routeGeneration: record.routeGeneration, claimGeneration: record.claimGeneration, toolName: record.toolName,
    observationStatus: "outcome-unknown" };
}

const isOperationLimit = (error) => failureFromError(error, "admission")?.code === "RECOVERY_OPERATION_LIMIT";

test("reliability: F3 projects inherited, helper and retry identities before their admission bundle", () => {
  const records = Array.from({ length: 256 }, (_, index) => capacityStart(index));
  const next = capacityStart(256);
  assert.equal(projectJournalCapacity({ files: [], records }).unresolvedOperations, 256);
  for (const event of ["tool_started", "helper_attempt_reserved", "denied_retry_consumed"]) {
    assert.throws(() => projectJournalCapacity({ files: [], records, writes: [{ ...next, event }] }), isOperationLimit);
  }
  assert.throws(() => projectJournalCapacity({ files: [], records: records.slice(1),
    inherited: [capacityOrphan(records[0])], writes: [next] }), isOperationLimit);
  assert.equal(projectJournalCapacity({ files: [], records: records.slice(1), writes: [
    { ...next, event: "denied_retry_consumed" }, next,
  ] }).unresolvedOperations, 256, "a retry consumption and its start reserve one identity, not two");
});

test("reliability: F3 an exact cancellation spends its reservation even after a partial over-limit start", () => {
  const records = Array.from({ length: 257 }, (_, index) => capacityStart(index));
  const started = records.at(-1);
  const denial = { ...started, event: "tool_denied", outcome: "not-executed" };
  const files = Array.from({ length: 8 }, (_, index) => file(JOURNAL_LIMITS.fileBytes - 1024, index));
  assert.throws(() => projectJournalCapacity({ files, records }), isOperationLimit);
  const projected = projectJournalCapacity({ files, records, writes: [denial] });
  assert.equal(projected.allowed, true);
  assert.equal(projected.unresolvedOperations, 256);
  assert.equal(projected.outstandingOperations, 256);
  assert.equal(projected.reserved.controlBytes, 0, "only this exactly correlated cancellation is terminal traffic");
  assert.throws(() => projectJournalCapacity({ files, records, writes: [{ ...denial, claimGeneration: "different" }] }), isOperationLimit);
  assert.throws(() => projectJournalCapacity({ files, records, writes: [{ ...denial, requestHash: "b".repeat(64) }] }), isOperationLimit);
});

test("reliability: F3 only unambiguous generation-bound evidence resolves inherited unknown operations", () => {
  const started = capacityStart(0);
  const inherited = [capacityOrphan(started)];
  for (const terminal of [{ ...started, event: "tool_completed" }, { ...started, event: "tool_denied", outcome: "not-executed" }]) {
    assert.equal(new JournalOperationIndex([terminal]).project([], inherited).orphans.length, 0);
    assert.equal(new JournalOperationIndex([{ ...terminal, routeGeneration: "different" }]).project([], inherited).orphans.length, 1);
    assert.equal(new JournalOperationIndex([started, terminal, { ...terminal, at: "2026-02-01T00:00:00.000Z" }]).project([], inherited).orphans.length, 1);
  }
  assert.throws(() => new JournalOperationIndex([started, started]), (error) =>
    failureFromError(error, "observation")?.code === "RECOVERY_OPERATION_CONFLICT");
  assert.throws(() => new JournalOperationIndex([started]).project([], [{ ...inherited[0], toolName: "different" }]),
    (error) => failureFromError(error, "observation")?.code === "RECOVERY_OPERATION_CONFLICT");
  assert.equal(new JournalOperationIndex().project().orphans.length, 0);
  assert.throws(() => new JournalOperationIndex(null));
});

test("reliability: F3 exact not-executed cancellations retain terminal capacity with absent host hints", () => {
  for (const absent of [{ requestHash: null }, { invocationHash: null }, { requestHash: null, invocationHash: null }]) {
    const started = { ...capacityStart(0), ...absent };
    const another = { ...capacityStart(1), invocationHash: started.invocationHash === null ? null : capacityStart(1).invocationHash };
    const denial = { ...started, event: "tool_denied", outcome: "not-executed" };
    const index = new JournalOperationIndex([started, another]);
    assert.equal(index.project().orphans.length, 2);
    const projected = index.project([denial]);
    assert.deepEqual(projected.orphans.map((orphan) => orphan.operationId), [another.operationId]);
    assert.deepEqual(projected.traffic, ["terminal"]);
    assert.equal(index.project([{ ...denial, claimGeneration: "different" }]).orphans.length, 2);
  }
});

test("reliability: F3 helper terminal reservations require every immutable evaluation binding", () => {
  const reserved = { ...capacityStart(0), event: "helper_attempt_reserved", helperId: "handoff.validate.v1",
    parentOperationId: capacityStart(1).operationId, namespaceHash: H, parametersHash: H, inputHash: H,
    implementationHash: H, planHash: H, planBytesHash: H, attachmentHash: H, ownershipHash: H,
    retryRoot: capacityStart(0).operationId, attempt: 0, delivery: "unconfirmed" };
  const result = { ...reserved, event: "helper_result" };
  const index = new JournalOperationIndex([reserved]);
  assert.equal(index.project([result]).outstanding.length, 0);
  assert.equal(index.project([result]).orphans.length, 1, "a saved helper result does not confirm its delivery");
  for (const changed of ["parentOperationId", "namespaceHash", "parametersHash", "inputHash", "implementationHash",
    "planHash", "planBytesHash", "attachmentHash", "ownershipHash", "retryRoot", "attempt", "delivery"]) {
    assert.equal(index.project([{ ...result, [changed]: "different" }]).outstanding.length, 1, changed);
  }
});
