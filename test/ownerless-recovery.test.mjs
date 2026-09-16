import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { canonicalPlanHash, publishRecoveryAuthorization, sha256, summarizeRunLedger, validateCheckpoint } from "../src/core.mjs";
import { inspectRecovery, proposeRecovery } from "../src/recovery.mjs";
import { recoveryValueHash, serializeRecovery } from "../src/recovery-state.mjs";
import { verifyRecoveryAuthorization } from "../src/recovery-authority.mjs";
import { withReliabilityFixture } from "./reliability-fixture.mjs";
import { authorizeFixtureProposal } from "./recovery-action-fixture.mjs";

const H = "a".repeat(64);
const I = "11111111-1111-4111-8111-111111111111";
const J = "22222222-2222-4222-8222-222222222222";
const time = "2026-01-01T00:00:00.000Z";

export function createLegacyLineage(fixture, { loseTail = true } = {}) {
  const state = path.join(fixture.cwd, ".supervised-worker");
  fs.mkdirSync(path.join(state, "runs"), { recursive: true });
  fs.mkdirSync(path.join(state, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(state, "checkpoints"), { recursive: true });
  fs.writeFileSync(path.join(state, "plan.json"), JSON.stringify(fixture.plan));
  const planHash = canonicalPlanHash(fixture.plan);
  const source = sha256("legacy-source");
  const tip = sha256("legacy-tip");
  const record = (session, event, detail) => ({ schemaVersion: 1, at: time, session, event, ...detail });
  const bytes = (records) => Buffer.from(records.map((value) => `${JSON.stringify(value)}\n`).join(""));
  const sourceRecords = [
    record(source, "plan_transitioned", { planHash, priorPlanHash: null, authorityHash: H, routeGeneration: I, claimGeneration: I }),
    record(source, "stop_blocked", { progressHash: planHash, sameProgressBlocks: 2, totalBlocks: 4 }),
  ];
  const sourcePrefix = bytes(sourceRecords);
  const receipt = { schemaVersion: 1, kind: "session-checkpoint", checkpointId: I, createdAt: time, planHash,
    sessionHash: source, routeGeneration: I, claimGeneration: I, attachmentHash: H,
    ledgerPosition: { path: `runs/${source}.jsonl`, byteOffset: sourcePrefix.length, recordCount: sourceRecords.length, prefixHash: sha256(sourcePrefix) },
    context: { counts: { pending: 0, in_progress: 1, banked: 0, parked: 0 }, itemHashes: [sha256("one")],
      stopState: { schemaVersion: 2, progressHash: planHash, sameProgressBlocks: 2, totalBlocks: 4 },
      operations: { status: "observed", reason: null, orphans: [], uncorrelatedCompletions: 0 } } };
  assert.deepEqual(validateCheckpoint(receipt), [], "legacy checkpoint baseline must be valid");
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const checkpointHash = sha256(receiptBytes);
  fs.writeFileSync(path.join(state, "checkpoints", `${checkpointHash}.json`), receiptBytes);
  sourceRecords.push(record(source, "checkpoint_persisted", { checkpointHash, planHash, attachmentHash: H, routeGeneration: I, claimGeneration: I }));
  fs.writeFileSync(path.join(state, "runs", `${source}.jsonl`), bytes(sourceRecords));
  const tipRecords = [
    record(tip, "checkpoint_resumed", { checkpointHash, planHash, sourceSessionHash: source, routeGeneration: J, claimGeneration: J, observationStatus: "observed", observationReason: null }),
    record(tip, "tool_started", { operationId: J, invocationHash: H, toolName: "external_effect", requestHash: H, routeGeneration: J, claimGeneration: J }),
    record(tip, "tool_completed", { operationId: J, invocationHash: H, toolName: "external_effect", success: true, observationId: J, routeGeneration: J, claimGeneration: J }),
    record(tip, "stop_blocked", { progressHash: planHash, sameProgressBlocks: 1, totalBlocks: 8 }),
  ];
  const tipJournal = path.join(state, "runs", `${tip}.jsonl`);
  fs.writeFileSync(tipJournal, bytes(tipRecords));
  const sentinel = path.join(fixture.cwd, "external-effect-sentinel.json");
  const executed = spawnSync(process.execPath, ["--eval",
    "const fs=require('node:fs');const p=process.argv[1];const n=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)).executions:0;fs.writeFileSync(p,JSON.stringify({executions:n+1}));",
    sentinel], { cwd: fixture.cwd, encoding: "utf8", timeout: 10_000 });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(sentinel)).executions, 1);
  const staleRuntime = path.join(state, "runtime", `${source}.json`);
  const latestRuntime = path.join(state, "runtime", `${tip}.json`);
  fs.writeFileSync(staleRuntime, JSON.stringify(receipt.context.stopState));
  fs.writeFileSync(latestRuntime, JSON.stringify({ schemaVersion: 2, progressHash: planHash, sameProgressBlocks: 1, totalBlocks: 8 }));
  assert.equal(summarizeRunLedger(fixture.cwd).status, "available", "healthy legacy journal baseline must precede injected faults");
  const baseline = inspectRecovery(fixture.cwd, fixture.input, fixture.authority());
  assert.equal(baseline.lineage.status, "unique");
  assert.deepEqual(baseline.lineage.operations.orphans, []);
  if (loseTail) {
    fs.rmSync(latestRuntime);
    fs.writeFileSync(tipJournal, bytes(tipRecords.filter((entry) => entry.event !== "tool_completed")));
    assert.equal(fs.existsSync(latestRuntime), false, "the lost-counter fault must fire");
    assert.equal(fs.readFileSync(tipJournal, "utf8").includes('"tool_completed"'), false, "the lost-completion fault must fire");
  }
  return { planHash, tip, source, staleRuntime, latestRuntime, tipJournal, checkpointHash };
}

function treeIdentity(root) {
  const values = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const stats = fs.lstatSync(target, { bigint: true });
      values.push([path.relative(root, target), String(stats.dev), String(stats.ino), String(stats.mtimeNs), String(stats.ctimeNs),
        stats.isFile() ? sha256(fs.readFileSync(target)) : null]);
      if (stats.isDirectory()) visit(target);
    }
  };
  visit(root);
  return values;
}

function uncertainProposal(fixture) {
  const inspection = fixture.native(["recovery", "inspect"], fixture.input);
  assert.equal(inspection.observation.status, "complete", JSON.stringify(inspection));
  return fixture.native(["recovery", "propose"], { ...fixture.input, expectedHash: inspection.observationHash,
    action: { kind: "legacy-reconcile", resolution: { kind: "preserve-uncertainty" } } });
}

test("reliability: ownerless diagnosis and proposal are bounded zero-write observations of lost counters", () => withReliabilityFixture((fixture) => {
  createLegacyLineage(fixture);
  const before = [treeIdentity(fixture.cwd), treeIdentity(fixture.storage)];
  const first = fixture.native(["recovery", "inspect"], fixture.input);
  const second = fixture.native(["recovery", "inspect"], fixture.input);
  assert.equal(first.observationHash, second.observationHash);
  assert.equal(first.healthy, false);
  assert.equal(first.lineage.stopState.totalBlocks.value, null);
  assert.equal(first.lineage.stopState.totalBlocks.lastObservation.value, 8);
  assert.equal(first.lineage.operations.orphans.length, 1);
  const proposed = proposeRecovery(fixture.cwd, { ...fixture.input, expectedHash: first.observationHash,
    action: { kind: "legacy-reconcile", resolution: { kind: "preserve-uncertainty" } } }, fixture.authority());
  assert.equal(proposed.status, "proposed");
  assert.deepEqual([treeIdentity(fixture.cwd), treeIdentity(fixture.storage)], before);
  assert.equal(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "recovery")), false);
}, { admit: false }));

test("reliability: direct operator confirmation authorizes one exact reconciliation and requires explicit resume", () => withReliabilityFixture((fixture) => {
  createLegacyLineage(fixture);
  const proposed = uncertainProposal(fixture);
  const grant = authorizeFixtureProposal(fixture, proposed);
  assert.equal(grant.status, "authorized");
  const receipt = fixture.native(["recovery", "apply"], { ...fixture.input, authorizationHash: grant.authorizationHash });
  assert.equal(receipt.status, "applied");
  assert.equal(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "attachment.json")), false);
  assert.equal(fixture.frontier().frontier.stopState.totalBlocks.value, null);
  const replayed = fixture.native(["recovery", "apply"], { ...fixture.input, authorizationHash: grant.authorizationHash });
  assert.deepEqual(replayed, receipt);
  const resumed = fixture.native(["resume"], { ...fixture.input, frontierHash: receipt.frontierHash, checkpointHash: null, planHash: canonicalPlanHash(fixture.plan) });
  assert.equal(resumed.status, "resumed");
  fixture.tool("after-legacy-reconciliation");
  const checkpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), attachmentHash: fixture.observe().attachmentHash });
  fixture.select("second-successor");
  const fresh = fixture.native(["resume"], { ...fixture.input, ...checkpoint.resume });
  assert.equal(fresh.context.stopState.totalBlocks.value, null);
  assert.equal(fresh.context.stopState.totalBlocks.lastObservation.value, 8);
  assert.equal(fresh.context.operations.orphans.length, 1);
  assert.equal(fresh.context.operations.orphans[0].operationId, J);
  fixture.tool("after-second-legacy-handoff");
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.cwd, "external-effect-sentinel.json"))).executions, 1);
  const stopped = fixture.hook("Stop");
  assert.equal(stopped.decision, "allow", "an unprovable same-progress tail grants no additional Stop attempt");
  assert.equal(fixture.frontier().frontier.stopState.totalBlocks.knownAfter, 0);
  const frontierHash = fixture.frontier().frontierHash;
  fixture.select("third-successor");
  assert.equal(fixture.native(["resume"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), checkpointHash: null, frontierHash }).status, "resumed");
  fixture.plan.items[0].status = "banked";
  fixture.plan.items.push({ id: "two", title: "Actual next governed item", status: "in_progress" });
  assert.equal(fixture.native(["lifecycle", "plan"], { ...fixture.input, expected: fixture.observe(), plan: fixture.plan }).status, "applied");
  assert.equal(fixture.hook("Stop").decision, "block");
  assert.deepEqual(fixture.frontier().frontier.stopState.sameProgressBlocks, { certainty: "exact", value: 1 });
  const afterProgress = fixture.frontier().frontier.stopState.totalBlocks;
  assert.equal(afterProgress.value, null);
  assert.equal(afterProgress.lastObservation.value, 8);
  assert.equal(afterProgress.knownAfter, 1);
  const nextCheckpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), attachmentHash: fixture.observe().attachmentHash });
  fixture.select("fourth-successor");
  const last = fixture.native(["resume"], { ...fixture.input, ...nextCheckpoint.resume });
  assert.deepEqual(last.context.stopState.totalBlocks, afterProgress);
  assert.equal(last.context.operations.orphans[0].operationId, J);
  fixture.tool("after-uncertain-progress-handoff");
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.cwd, "external-effect-sentinel.json"))).executions, 1);
}, { admit: false }));

for (const [name, options] of [
  ["wrong phrase", { answer: "yes", expectedExit: 1 }],
  ["replacement during confirmation", { mutation: "replace-plan", expectedExit: 1 }],
]) {
  test(`reliability: operator authorization rejects ${name} without issuing a grant`, () => withReliabilityFixture((fixture) => {
    createLegacyLineage(fixture);
    const proposed = uncertainProposal(fixture);
    assert.equal(authorizeFixtureProposal(fixture, proposed, options).status, "blocked");
    assert.equal(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "recovery", "authorizations")), false);
  }, { admit: false }));
}

test("reliability: Worker code and ordinary native tools cannot manufacture operator authorization", () => withReliabilityFixture((fixture) => {
  createLegacyLineage(fixture);
  const proposed = uncertainProposal(fixture);
  const now = Date.now();
  const fabricated = { schemaVersion: 1, kind: "recovery-authorization", authorizationId: I, proposalHash: proposed.proposalHash,
    proposal: proposed.proposal, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(), maxUses: 1, assurance: "cooperative-local-operator" };
  assert.throws(() => publishRecoveryAuthorization(fixture.cwd, fixture.input, fabricated, fixture.authority()), /RECOVERY_AUTHORIZATION_REQUIRED/);
  const output = fixture.hook("PreToolUse", { tool_name: "run_in_terminal", tool_input: { command: `node 'helper/src/cli.mjs' recovery authorize proposal.json ${proposed.proposalHash}` } });
  assert.equal(output.permissionDecision, "deny");
  assert.equal(output.supervisorFailure.code, "RECOVERY_AUTHORIZATION_REQUIRED");
  const invalid = fixture.native(["recovery", "authorize", "--yes", proposed.proposalHash], {}, 1);
  assert.equal(invalid.status, "blocked");
  assert.equal(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "recovery")), false);
}, { admit: false }));

test("reliability: authorization binds expiry, source, workflow, repository, session and the complete snapshot", () => withReliabilityFixture((fixture) => {
  createLegacyLineage(fixture);
  const proposed = uncertainProposal(fixture);
  const grant = authorizeFixtureProposal(fixture, proposed);
  const directory = path.join(fixture.cwd, ".supervised-worker", "recovery", "authorizations");
  const original = JSON.parse(fs.readFileSync(path.join(directory, `${grant.authorizationHash}.json`)));
  assert.equal(verifyRecoveryAuthorization(original, fixture.cwd, fixture.input, fixture.authority()), original);
  for (const [name, mutate] of [
    ["expired", (value) => { value.issuedAt = new Date(Date.now() - 600_100).toISOString(); value.expiresAt = new Date(Date.now() - 100).toISOString(); }],
    ["future", (value) => { const now = Date.now() + 60_000; value.issuedAt = new Date(now).toISOString(); value.expiresAt = new Date(now + 600_000).toISOString(); }],
    ["renewed", (value) => { value.expiresAt = new Date(Date.parse(value.issuedAt) + 1_200_000).toISOString(); }],
    ["source", (value) => { value.proposal.expected.sourceHash = H; }],
    ["workflow", (value) => { value.proposal.expected.workflowHash = H; }],
    ["repository", (value) => { value.proposal.expected.repositoryHash = H; }],
    ["session", (value) => { value.proposal.session.session_id = "another-real-session"; }],
    ["snapshot", (value) => { value.proposal.expected.planBytesHash = H; }],
  ]) {
    const value = structuredClone(original);
    mutate(value);
    value.proposal.expectedHash = recoveryValueHash(value.proposal.expected);
    value.proposalHash = recoveryValueHash(value.proposal);
    const bytes = serializeRecovery(value, "authorization");
    const hash = sha256(bytes);
    fs.writeFileSync(path.join(directory, `${hash}.json`), bytes);
    if (["expired", "future", "renewed", "source", "session"].includes(name)) {
      assert.throws(() => verifyRecoveryAuthorization(value, fixture.cwd, fixture.input, fixture.authority()), undefined, name);
    }
    const output = fixture.native(["recovery", "apply"], { ...fixture.input, authorizationHash: hash }, 1);
    assert.equal(output.status, "blocked", name);
    assert.equal(fixture.frontier(), null, name);
  }
  assert.equal(fixture.native(["recovery", "apply"], { ...fixture.input, authorizationHash: grant.authorizationHash }).status, "applied",
    "the genuine unmodified authorization must still succeed after discriminating rejections");
}, { admit: false }));

for (const fault of ["same-byte-plan-replacement", "appearing-owner"]) {
  test(`reliability: exact snapshot apply rejects ${fault} and preserves the new evidence`, () => withReliabilityFixture((fixture) => {
    createLegacyLineage(fixture);
    const proposed = uncertainProposal(fixture);
    const grant = authorizeFixtureProposal(fixture, proposed);
    const planPath = path.join(fixture.cwd, ".supervised-worker", "plan.json");
    const before = fs.readFileSync(planPath);
    if (fault === "same-byte-plan-replacement") {
      const inode = fs.lstatSync(planPath, { bigint: true }).ino;
      fs.writeFileSync(`${planPath}.replacement`, before);
      fs.renameSync(`${planPath}.replacement`, planPath);
      assert.notEqual(fs.lstatSync(planPath, { bigint: true }).ino, inode, "inode replacement fault must fire");
    } else {
      fs.writeFileSync(path.join(fixture.cwd, ".supervised-worker", "attachment.json"), JSON.stringify({
        schemaVersion: 3, sessionHash: sha256(fixture.input.session_id), status: "active", routeGeneration: null,
        claimGeneration: I, checkpointHash: null, workerAuthorityHash: fixture.authority().grantHash, attachedAt: time, updatedAt: time,
      }));
      assert.ok(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "attachment.json")));
    }
    const output = fixture.native(["recovery", "apply"], { ...fixture.input, authorizationHash: grant.authorizationHash }, 1);
    assert.equal(output.failure.code, "RECOVERY_LINEAGE_AMBIGUOUS");
    assert.equal(fixture.frontier(), null);
    assert.deepEqual(fs.readFileSync(planPath), before);
  }, { admit: false }));
}

test("reliability: two real apply processes cannot reconcile twice with one authorization", () => withReliabilityFixture(async (fixture) => {
  createLegacyLineage(fixture);
  const proposed = uncertainProposal(fixture);
  const grant = authorizeFixtureProposal(fixture, proposed);
  const request = { ...fixture.input, authorizationHash: grant.authorizationHash };
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(fixture.installRoot, "src", "cli.mjs"), "recovery", "apply"],
      { cwd: fixture.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("bounded concurrent apply timed out")); }, 30_000);
    child.stdout.on("data", (bytes) => { stdout += bytes; });
    child.stderr.on("data", (bytes) => { stderr += bytes; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(signal, null, stderr);
        assert.ok([0, 1].includes(code), stderr);
        resolve(JSON.parse(stdout));
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
  const results = await Promise.all([run(), run()]);
  const applied = results.filter((value) => value.status === "applied");
  assert.ok(applied.length >= 1, JSON.stringify(results));
  for (const value of applied) assert.deepEqual(value, applied[0]);
  assert.equal(fs.readdirSync(path.join(fixture.cwd, ".supervised-worker", "recovery", "frontiers")).length, 1);
  assert.equal(fixture.frontier().frontier.sequence, 0);
  assert.deepEqual(fixture.native(["recovery", "apply"], request), applied[0]);
}, { admit: false }));
