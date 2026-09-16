import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";

import { canonicalPlanHash, releaseAttachment, sha256, summarizeRunLedger, validateSupervisorFailure } from "../src/core.mjs";
import { serializeRecovery } from "../src/recovery-state.mjs";
import { withReliabilityFixture } from "./reliability-fixture.mjs";
import { authorizeFixtureProposal } from "./recovery-action-fixture.mjs";

const recordsAt = (target) => fs.readFileSync(target, "utf8").trim().split("\n").map(JSON.parse);
const encodeRecords = (records) => Buffer.from(records.map((record) => `${JSON.stringify(record)}\n`).join(""));

function publishFixtureFrontier(fixture, changes) {
  const previous = fixture.frontier();
  const frontier = { ...previous.frontier, ...changes, sequence: previous.frontier.sequence + 1,
    previousHash: previous.frontierHash, transitionId: randomUUID(), cause: "tool-observation" };
  const bytes = serializeRecovery(frontier, "frontier");
  const frontierHash = sha256(bytes);
  const root = path.join(fixture.cwd, ".supervised-worker", "recovery");
  fs.writeFileSync(path.join(root, "frontiers", `${frontierHash}.json`), bytes, { flag: "wx" });
  fs.writeFileSync(path.join(root, "head.json"), serializeRecovery({ schemaVersion: 1, kind: "recovery-head",
    campaignId: frontier.campaignId, sequence: frontier.sequence, frontierHash }, "head"));
  assert.equal(fixture.frontier().frontierHash, frontierHash);
  return { frontier, frontierHash };
}

function recordedHistory(fixture, coverage = "complete") {
  fixture.tool("prefix-positive");
  const directory = path.join(fixture.cwd, ".supervised-worker", "runs");
  const historicalSession = sha256("prefix-historical-session");
  const historicalFile = path.join(directory, `${historicalSession}.jsonl`);
  fs.writeFileSync(historicalFile, encodeRecords([{ schemaVersion: 1, at: "2026-01-01T00:00:00.000Z",
    event: "pre_compact", session: historicalSession, trigger: "manual" }]), { flag: "wx" });
  const post = { tool_name: "read_file", tool_use_id: "prefix-unmatched-completion",
    tool_input: { filePath: path.join(fixture.cwd, "README.md") } };
  assert.match(fs.readFileSync(post.tool_input.filePath, "utf8"), /Benign/);
  assert.deepEqual(fixture.hook("PostToolUse", post), {});
  const stopped = fixture.hook("Stop");
  assert.equal(stopped.decision, "block", JSON.stringify(stopped));
  let selected = fixture.frontier();
  assert.equal(selected.frontier.operations.uncorrelatedCompletions.value, 1);
  assert.equal(selected.frontier.ledger.coverage, "complete");
  assert.equal(selected.frontier.ledger.segments.length, 2);
  if (coverage === "partial") selected = publishFixtureFrontier(fixture, {
    ledger: { ...selected.frontier.ledger, coverage },
    operations: { ...selected.frontier.operations, coverage },
  });
  const sourceSession = sha256(fixture.input.session_id);
  const sourceFile = path.join(directory, `${sourceSession}.jsonl`);
  const position = selected.frontier.ledger.segments.find((segment) => segment.sessionHash === sourceSession);
  const prefix = fs.readFileSync(sourceFile).subarray(0, position.byteOffset);
  assert.equal(sha256(prefix), position.prefixHash);
  assert.equal(prefix.toString("utf8").trim().split("\n").length, position.recordCount);
  assert.equal(recordsAt(sourceFile).filter((record) => record.event === "tool_completed" && record.operationId === null).length, 1);
  return { sourceFile, sourceSession, historicalFile, position, selected };
}

function rewriteCompletion(sourceFile) {
  const before = fs.readFileSync(sourceFile);
  let replaced = 0;
  const records = recordsAt(sourceFile).map((record) => {
    if (record.event !== "tool_completed" || record.operationId !== null) return record;
    replaced += 1;
    const replacement = { schemaVersion: 1, at: record.at, event: "pre_compact", session: record.session, trigger: "" };
    const padding = Buffer.byteLength(JSON.stringify(record)) - Buffer.byteLength(JSON.stringify(replacement));
    assert.ok(padding > 0);
    replacement.trigger = "x".repeat(padding);
    return replacement;
  });
  assert.equal(replaced, 1, "exactly the previously recorded uncorrelated completion must be replaced");
  const bytes = encodeRecords(records);
  assert.equal(bytes.length, before.length, "the valid rewrite must preserve size and record count");
  fs.writeFileSync(sourceFile, bytes);
  assert.equal(recordsAt(sourceFile).filter((record) => record.event === "tool_completed" && record.operationId === null).length, 0);
}

function journalSnapshot(fixture) {
  const directory = path.join(fixture.cwd, ".supervised-worker", "runs");
  return Object.fromEntries(fs.readdirSync(directory).sort().map((name) => [name, fs.readFileSync(path.join(directory, name))]));
}

function assertIntegrityFailure(output) {
  assert.equal(output.status, "unconfirmed", JSON.stringify(output));
  assert.equal(typeof output.error, "string", "retain the existing error field");
  assert.deepEqual(validateSupervisorFailure(output.failure), []);
  assert.equal(output.failure.code, "JOURNAL_INTEGRITY");
}

test("reliability: prepared-release recovery cannot advance a rewritten recorded journal prefix", () => withReliabilityFixture(fixture => {
  const { sourceFile } = recordedHistory(fixture);
  const attachmentPath = path.join(fixture.cwd, ".supervised-worker", "attachment.json");
  const originalRemove = fs.rmSync;
  let fired = false;
  fs.rmSync = (target, ...args) => {
    const result = originalRemove(target, ...args);
    if (target === attachmentPath && !fired) {
      fired = true;
      throw Object.assign(new Error("injected lost detach response"), { code: "EIO" });
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => releaseAttachment(fixture.cwd, fixture.observe(), fixture.input, fixture.authority()));
  } finally {
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
  }
  assert.equal(fired, true);
  assert.equal(fs.existsSync(attachmentPath), false);
  const selected = fixture.frontier();
  assert.equal(selected.frontier.phase, "detach-prepared");
  const valid = fixture.doctor({ operation: "diagnose" });
  const action = valid.candidates.find(value => value.kind === "finish-release");
  assert.ok(action, "unchanged recorded history must support finish-release");
  const proposed = fixture.doctor({ operation: "propose-recovery", expectedHash: valid.observationHash, action });
  const grant = authorizeFixtureProposal(fixture, proposed);
  rewriteCompletion(sourceFile);
  assert.equal(summarizeRunLedger(fixture.cwd).status, "available", "the corruption must be a structurally valid rewrite");
  const before = journalSnapshot(fixture);
  const invalid = fixture.doctor({ operation: "diagnose" });
  assert.equal(invalid.healthy, false);
  assert.equal(invalid.observation.status, "incomplete");
  assert.ok(invalid.observation.diagnostics.includes("JOURNAL_INTEGRITY"));
  assert.equal(invalid.candidates.some(value => value.kind === "finish-release"), false);
  const denied = fixture.doctor({ operation: "recover-authorized", authorizationHash: grant.authorizationHash }, 1);
  assert.equal(denied.status, "blocked");
  assert.deepEqual(validateSupervisorFailure(denied.failure), []);
  assert.equal(denied.failure.code, "JOURNAL_INTEGRITY");
  assert.equal(fixture.frontier().frontierHash, selected.frontierHash);
  assert.deepEqual(journalSnapshot(fixture), before);
  assert.equal(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "recovery", "actions", proposed.proposal.actionId)), false);
}));

for (const coverage of ["complete", "partial"]) {
  for (const mutation of ["remove-completion", "rewrite", "shorten", "missing-segment"]) {
    test(`reliability: recorded ${coverage} recovery prefix rejects ${mutation} between guarded Stop and checkpoint`, () => withReliabilityFixture((fixture) => {
      const { sourceFile, position, selected } = recordedHistory(fixture, coverage);
      if (mutation === "rewrite") rewriteCompletion(sourceFile);
      else if (mutation === "missing-segment") {
        fs.rmSync(sourceFile);
        assert.equal(fs.existsSync(sourceFile), false);
      } else {
        const records = recordsAt(sourceFile);
        const changed = mutation === "shorten" ? records.slice(0, 1)
          : records.filter((record) => !(record.event === "tool_completed" && record.operationId === null));
        assert.ok(changed.length < records.length);
        fs.writeFileSync(sourceFile, encodeRecords(changed));
      }
      if (mutation !== "missing-segment") {
        assert.notEqual(sha256(fs.readFileSync(sourceFile).subarray(0, position.byteOffset)), position.prefixHash);
      }
      assert.equal(summarizeRunLedger(fixture.cwd).status, "available", "the changed history is valid JSON, not an invalid-ledger proxy");
      const before = fixture.observe();
      const journals = journalSnapshot(fixture);
      const stopped = fixture.hook("Stop");
      assert.equal(stopped.decision, "allow", JSON.stringify(stopped));
      assert.equal(stopped.release, undefined);
      assert.deepEqual(validateSupervisorFailure(stopped.supervisorFailure), []);
      assert.equal(stopped.supervisorFailure.code, "JOURNAL_INTEGRITY");
      assert.equal(fixture.frontier().frontierHash, selected.frontierHash);
      assert.equal(fixture.frontier().frontier.operations.uncorrelatedCompletions.value, 1);
      const checkpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan),
        attachmentHash: before.attachmentHash }, 1);
      assertIntegrityFailure(checkpoint);
      const target = path.join(fixture.cwd, "must-not-execute.txt");
      const request = { tool_name: "Write", tool_use_id: "after-prefix-loss", tool_input: { file_path: target, content: "forbidden" } };
      const admission = fixture.hook("PreToolUse", request);
      if (admission.permissionDecision !== "deny") fs.writeFileSync(target, request.tool_input.content);
      assert.equal(admission.permissionDecision, "deny", JSON.stringify(admission));
      assert.deepEqual(validateSupervisorFailure(admission.supervisorFailure), []);
      assert.equal(fs.existsSync(target), false);
      assert.deepEqual(fixture.observe(), before);
      assert.deepEqual(journalSnapshot(fixture), journals);
      assert.equal(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "checkpoints")), false);
    }));
  }
}

for (const mismatch of ["record-count", "record-boundary", "session-binding"]) {
  test(`reliability: recorded recovery prefix validates its ${mismatch} as well as its byte hash`, () => withReliabilityFixture((fixture) => {
    const history = recordedHistory(fixture);
    const position = { ...history.position };
    if (mismatch === "record-count") position.recordCount += 1;
    else if (mismatch === "record-boundary") {
      position.byteOffset -= 1;
      position.prefixHash = sha256(fs.readFileSync(history.sourceFile).subarray(0, position.byteOffset));
    } else position.sessionHash = sha256("not-the-recorded-session");
    const selected = publishFixtureFrontier(fixture, { ledger: { ...history.selected.frontier.ledger,
      segments: history.selected.frontier.ledger.segments.map((segment) => segment.path === position.path ? position : segment) } });
    assert.equal(summarizeRunLedger(fixture.cwd).status, "available");
    const stopped = fixture.hook("Stop");
    assert.equal(stopped.decision, "allow", JSON.stringify(stopped));
    assert.equal(stopped.supervisorFailure.code, "JOURNAL_INTEGRITY");
    assert.equal(fixture.frontier().frontierHash, selected.frontierHash);
  }));
}

test("reliability: recorded recovery prefixes accept append-only tools Stop checkpoint and fresh resume", () => withReliabilityFixture((fixture) => {
  const { sourceFile, position } = recordedHistory(fixture, "partial");
  fixture.tool("append-only-after-prefix");
  assert.equal(fixture.hook("PreCompact", { trigger: "manual" }).additionalContext, undefined);
  const stopped = fixture.hook("Stop");
  assert.equal(stopped.decision, "block", JSON.stringify(stopped));
  assert.equal(fixture.frontier().frontier.operations.uncorrelatedCompletions.value, 1);
  assert.equal(sha256(fs.readFileSync(sourceFile).subarray(0, position.byteOffset)), position.prefixHash);
  const checkpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan),
    attachmentHash: fixture.observe().attachmentHash });
  assert.equal(checkpoint.context.operations.uncorrelatedCompletions.value, 1);
  fixture.select("prefix-successor");
  const resumed = fixture.native(["resume"], { ...fixture.input, ...checkpoint.resume });
  assert.equal(resumed.context.operations.uncorrelatedCompletions.value, 1);
  fixture.tool("append-only-successor");
  assert.equal(sha256(fs.readFileSync(sourceFile).subarray(0, position.byteOffset)), position.prefixHash);
}));

test("reliability: fresh resume rejects rollback in a recorded historical segment outside its checkpoint source", () => withReliabilityFixture((fixture) => {
  const { sourceFile, sourceSession } = recordedHistory(fixture);
  const checkpoint = () => fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan),
    attachmentHash: fixture.observe().attachmentHash });
  const first = checkpoint();
  fixture.select("prefix-middle");
  assert.equal(fixture.native(["resume"], { ...fixture.input, ...first.resume }).status, "resumed");
  fixture.tool("prefix-middle-positive");
  const second = checkpoint();
  const root = path.join(fixture.cwd, ".supervised-worker");
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "checkpoints", `${second.checkpointHash}.json`)));
  assert.notEqual(receipt.sessionHash, sourceSession, "the current receipt must point to a different, intact source journal");
  const currentSource = fs.readFileSync(path.join(root, ...receipt.ledgerPosition.path.split("/")));
  assert.equal(sha256(currentSource.subarray(0, receipt.ledgerPosition.byteOffset)), receipt.ledgerPosition.prefixHash);
  const selected = fixture.frontier();
  assert.ok(selected.frontier.ledger.segments.some((segment) => segment.sessionHash === sourceSession));
  const attachment = fs.readFileSync(path.join(root, "attachment.json"));
  rewriteCompletion(sourceFile);
  assert.equal(summarizeRunLedger(fixture.cwd).status, "available");
  const journals = journalSnapshot(fixture);
  fixture.select("prefix-final");
  const resumed = fixture.native(["resume"], { ...fixture.input, ...second.resume }, 1);
  assertIntegrityFailure(resumed);
  assert.equal(fixture.frontier().frontierHash, selected.frontierHash);
  assert.deepEqual(fs.readFileSync(path.join(root, "attachment.json")), attachment);
  assert.deepEqual(journalSnapshot(fixture), journals);
}));
