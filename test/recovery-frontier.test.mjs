import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

import { applyCampaignPlan, canonicalPlanHash, checkpointSession, handlePluginHook, observeCampaignTransition, readRecoveryFrontier, readRecoveryTip, releaseAttachment, resumeSession, sha256, validateCheckpoint, validateRecovery } from "../src/core.mjs";
import { decideStop, exactCounter, freshStopState, mergeOperationCoverage, recoveryValueHash, serializeRecovery, uncertainStopState, unknownCounter, verifyFrontierChain, verifyFrontierTip } from "../src/recovery-state.mjs";
import { associateSupervisorFailure, failureFromError, renderSupervisorFailure, supervisorFailure, trustedSupervisorFailure } from "../src/supervisor-diagnostics.mjs";
import { reliabilitySourceRoot, withReliabilityFixture } from "./reliability-fixture.mjs";
import { authorizeFixtureProposal } from "./recovery-action-fixture.mjs";

const H = "a".repeat(64);
const I = "11111111-1111-4111-8111-111111111111";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function frontier(overrides = {}) {
  return { schemaVersion: 1, kind: "recovery-frontier", campaignId: I, sequence: 0, previousHash: null,
    transitionId: I, phase: "active", repositoryHash: H, sourceHash: H, workflowHash: null, planHash: H, planBytesHash: H,
    owner: null, successor: null, stopState: freshStopState(H),
    operations: { coverage: "complete", orphans: [], uncorrelatedCompletions: exactCounter(0) },
    ledger: { coverage: "complete", segments: [] }, checkpointHash: null, authorizationHash: null, cause: "fresh-plan", ...overrides };
}

test("reliability: uncertain counters retain the recorded 8 without inventing its missing tail or a Stop allowance", () => {
  const state = uncertainStopState(H, { sameProgressBlocks: 1, totalBlocks: 8 }, H);
  const decision = decideStop(state, H);
  assert.equal(decision.decision, "allow");
  assert.equal(decision.stopState.totalBlocks.value, null);
  assert.deepEqual(decision.stopState.totalBlocks.lastObservation, { value: 8, evidenceHash: H });
  assert.equal(decision.stopState.totalBlocks.knownAfter, 0);
  const next = decideStop(state, "b".repeat(64));
  assert.equal(next.decision, "block");
  assert.equal(next.stopState.sameProgressBlocks.value, 1);
  assert.equal(next.stopState.totalBlocks.value, null);
  assert.equal(next.stopState.totalBlocks.knownAfter, 1);
});

test("reliability: exact Stop epochs increment, exhaust, and only reset the same-progress budget on real progress", () => {
  let state = freshStopState(H);
  for (let index = 1; index <= 2; index += 1) {
    const result = decideStop(state, H);
    assert.equal(result.decision, "block");
    assert.equal(result.stopState.totalBlocks.value, index);
    state = result.stopState;
  }
  assert.equal(decideStop(state, H).decision, "allow");
  assert.equal(decideStop(state, "b".repeat(64), true).decision, "allow");
  assert.equal(decideStop(state, "b".repeat(64)).stopState.totalBlocks.value, 3);
  assert.throws(() => decideStop(state, H, false, 3));
  assert.throws(() => exactCounter(-1));
  assert.throws(() => exactCounter(Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => unknownCounter({ value: 8, evidenceHash: null }));
  assert.ok(validateRecovery({ ...state, extra: true }, "stopState").length);
  assert.ok(validateRecovery({ certainty: "unknown", value: 0, lastObservation: null, knownAfter: 0 }, "counter").length);
});

test("reliability: exact-byte head lineage ignores five historical values and rejects missing or forked predecessors", () => {
  const bytes = serializeRecovery(frontier(), "frontier");
  const firstHash = digest(bytes);
  const second = serializeRecovery(frontier({ sequence: 1, previousHash: firstHash, cause: "stop-block",
    stopState: { ...freshStopState(H), totalBlocks: exactCounter(4) } }), "frontier");
  const secondHash = digest(second);
  const store = new Map([[firstHash, bytes], [secondHash, second]]);
  for (const value of [2, 3, 5, 7, 8]) {
    const stale = serializeRecovery(frontier({ stopState: { ...freshStopState(H), totalBlocks: exactCounter(value) } }), "frontier");
    store.set(digest(stale), stale);
  }
  const head = { schemaVersion: 1, kind: "recovery-head", campaignId: I, sequence: 1, frontierHash: secondHash };
  assert.equal(verifyFrontierChain(head, (selected) => store.get(selected)).frontier.stopState.totalBlocks.value, 4);
  assert.throws(() => verifyFrontierChain({ ...head, sequence: 2 }, (selected) => store.get(selected)));
  store.delete(firstHash);
  assert.throws(() => verifyFrontierChain(head, (selected) => store.get(selected)));
  assert.equal(recoveryValueHash({ a: 1, b: 2 }), recoveryValueHash({ b: 2, a: 1 }));
  assert.notEqual(recoveryValueHash(frontier()), firstHash);
});

test("reliability: unknown operation identity survives partial and unavailable coverage", () => {
  const operation = { operationId: I, sessionHash: H, routeGeneration: null, claimGeneration: null,
    invocationHash: H, toolName: "external_effect", observationStatus: "outcome-unknown" };
  const previous = { coverage: "partial", orphans: [operation], uncorrelatedCompletions: unknownCounter() };
  const next = mergeOperationCoverage(previous, { coverage: "complete", orphans: [], uncorrelatedCompletions: exactCounter(0) });
  assert.deepEqual(next, previous);
  assert.throws(() => mergeOperationCoverage(previous, { ...previous, orphans: [{ ...operation, toolName: "different" }] }));
});

test("reliability: F2 a canonical tip is bounded evidence, never an ancestry proof", () => {
  const value = frontier({ sequence: 12, previousHash: H, cause: "stop-block" });
  const bytes = serializeRecovery(value, "frontier");
  const head = { schemaVersion: 1, kind: "recovery-head", campaignId: I, sequence: 12, frontierHash: digest(bytes) };
  const reads = [];
  const selected = verifyFrontierTip(head, (hash) => { reads.push(hash); return bytes; });
  assert.deepEqual(reads, [head.frontierHash]);
  assert.equal(Object.hasOwn(selected, "hashes"), false);
  assert.deepEqual(selected.frontier, value);
  assert.throws(() => verifyFrontierChain(head, (hash) => hash === head.frontierHash ? bytes : null));
  assert.throws(() => verifyFrontierTip(null, () => bytes));
  assert.throws(() => verifyFrontierTip(head, null));
  assert.throws(() => verifyFrontierTip(head, () => null));
  assert.throws(() => verifyFrontierTip({ ...head, sequence: 13 }, () => bytes));
  assert.throws(() => verifyFrontierTip({ ...head, sequence: 1024 }, () => bytes));
  assert.throws(() => verifyFrontierTip({ ...head, campaignId: "22222222-2222-4222-8222-222222222222" }, () => bytes));
  assert.throws(() => verifyFrontierTip(head, () => Buffer.concat([bytes, Buffer.from(" ")])));
  const noncanonical = Buffer.from(JSON.stringify(value));
  assert.throws(() => verifyFrontierTip({ ...head, frontierHash: digest(noncanonical) }, () => noncanonical));
});

test("reliability: F2 current-tip readback rejects a same-byte head identity replacement", () => withReliabilityFixture((fixture) => {
  const selected = readRecoveryTip(fixture.cwd);
  assert.ok(selected.frontierHash);
  const head = path.join(fixture.cwd, ".supervised-worker", "recovery", "head.json");
  const originalBytes = fs.readFileSync(head);
  const originals = { openSync: fs.openSync, closeSync: fs.closeSync };
  const descriptors = new Map();
  let fired = false;
  fs.openSync = (target, ...args) => {
    const fd = originals.openSync(target, ...args);
    descriptors.set(fd, target);
    return fd;
  };
  fs.closeSync = (fd) => {
    const target = descriptors.get(fd);
    descriptors.delete(fd);
    const result = originals.closeSync(fd);
    if (target === head && !fired) {
      fired = true;
      const before = fs.statSync(head, { bigint: true });
      fs.writeFileSync(head + ".replacement", originalBytes, { flag: "wx" });
      fs.renameSync(head + ".replacement", head);
      assert.notEqual(fs.statSync(head, { bigint: true }).ino, before.ino);
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => readRecoveryTip(fixture.cwd), (error) =>
      failureFromError(error, "observation")?.code === "RECOVERY_LINEAGE_AMBIGUOUS");
    assert.equal(fired, true, "the identity replacement must occur between the head reads");
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
  assert.deepEqual(fs.readFileSync(head), originalBytes);
  assert.equal(readRecoveryTip(fixture.cwd).frontierHash, selected.frontierHash);
}));

test("reliability: typed failures have trusted association, not serialized text authority", () => {
  const failure = supervisorFailure("JOURNAL_INTEGRITY", "admission", [H]);
  const output = associateSupervisorFailure({}, failure);
  assert.equal(trustedSupervisorFailure(output), failure);
  assert.equal(trustedSupervisorFailure(JSON.parse(JSON.stringify(output))), null);
  assert.equal(trustedSupervisorFailure({ failure }), null);
  assert.equal(failureFromError({ runLedgerReason: "run-ledger-limit-exceeded" }, "admission").code, "JOURNAL_CAPACITY");
  assert.equal(failureFromError(new Error("JOURNAL_INTEGRITY"), "admission"), null);
  for (const code of ["RECOVERY_OPERATION_LIMIT", "RECOVERY_OPERATION_CONFLICT"]) {
    assert.equal(failureFromError(new Error(code), "resume"), null, "diagnostic prose is not typed failure authority");
  }
  assert.match(renderSupervisorFailure(failure), /admission.*unconfirmed/);
  assert.throws(() => supervisorFailure("invented", "admission"));
});

test("reliability: native tool, durable Stop counters, checkpoint v3, fresh resume and another native tool cross the frontier", () => withReliabilityFixture((fixture) => {
  fixture.tool("healthy-before-handoff");
  const first = fixture.hook("Stop");
  assert.equal(first.decision, "block", JSON.stringify(first));
  const selected = fixture.frontier();
  assert.equal(selected.frontier.stopState.totalBlocks.value, 1);
  const checkpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), attachmentHash: fixture.observe().attachmentHash });
  assert.equal(checkpoint.status, "checkpointed");
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.cwd, ".supervised-worker", "checkpoints", `${checkpoint.checkpointHash}.json`)));
  assert.equal(receipt.schemaVersion, 3);
  assert.deepEqual(validateCheckpoint(receipt), []);
  fixture.select("fresh-worker");
  const resumed = fixture.native(["resume"], { ...fixture.input, ...checkpoint.resume });
  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.context.stopState.totalBlocks.value, 1);
  fixture.tool("healthy-after-handoff");
  assert.deepEqual(fixture.operations().orphans, []);
}));

test("reliability: journal fault cannot erase the current 2 during Stop release and stale history never selects authority", () => withReliabilityFixture((fixture) => {
  fixture.tool("positive-before-journal-fault");
  assert.equal(fixture.hook("Stop").decision, "block");
  const journal = path.join(fixture.cwd, ".supervised-worker", "runs", `${sha256(fixture.input.session_id)}.jsonl`);
  const recordedOne = fs.readFileSync(journal);
  assert.equal(fixture.hook("Stop").decision, "block");
  fs.writeFileSync(journal, recordedOne);
  const foreign = path.join(path.dirname(journal), "report.json");
  fs.writeFileSync(foreign, "{}\n");
  assert.ok(fs.existsSync(foreign));
  const before = fs.readFileSync(journal);
  const output = fixture.hook("Stop");
  assert.equal(output.release?.status, "detached", JSON.stringify(output));
  assert.equal(output.release.journalRecorded, false);
  assert.equal(fixture.frontier().frontier.stopState.totalBlocks.value, 2);
  assert.ok(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "runtime", `${sha256(fixture.input.session_id)}.json`)));
  assert.deepEqual(fs.readFileSync(journal), before);
  for (const value of [1, 3, 4, 8, 10]) fs.writeFileSync(path.join(fixture.cwd, ".supervised-worker", "runtime", `${sha256(`old-${value}`)}.json`),
    JSON.stringify({ schemaVersion: 2, progressHash: H, sameProgressBlocks: 1, totalBlocks: value }));
  assert.equal(fixture.frontier().frontier.stopState.totalBlocks.value, 2);
}));

for (const [boundary, after] of [["frontier", false], ["head", false], ["head", true], ["route", false], ["attachment", false]]) {
  test(`reliability: Stop ${boundary} ${after ? "post-rename" : "pre-publication"} fault preserves a recoverable source`, () => withReliabilityFixture((fixture) => {
    assert.equal(fixture.hook("Stop").decision, "block");
    assert.equal(fixture.hook("Stop").decision, "block");
    const runtime = path.join(fixture.cwd, ".supervised-worker", "runtime", `${sha256(fixture.input.session_id)}.json`);
    const originalRename = fs.renameSync;
    const originalRm = fs.rmSync;
    let fired = false;
    const matches = (target) => boundary === "frontier" ? String(target).includes(`${path.sep}frontiers${path.sep}`)
      : boundary === "head" ? String(target).endsWith(`${path.sep}head.json`)
        : boundary === "route" ? String(target).endsWith(`${path.sep}route.json`) : String(target).endsWith(`${path.sep}attachment.json`);
    fs.renameSync = (source, target) => {
      if (!fired && matches(target) && boundary !== "attachment") {
        fired = true;
        if (after) originalRename(source, target);
        throw Object.assign(new Error("injected frontier storage failure"), { code: "EIO" });
      }
      return originalRename(source, target);
    };
    fs.rmSync = (target, options) => {
      if (!fired && boundary === "attachment" && matches(target)) {
        fired = true;
        throw Object.assign(new Error("injected detach failure"), { code: "ENOSPC" });
      }
      return originalRm(target, options);
    };
    syncBuiltinESMExports();
    try {
      const output = handlePluginHook({ cwd: fixture.cwd, ...fixture.input }, "Stop", fixture.installRoot);
      assert.equal(fired, true, "the intended fault boundary must execute");
      assert.notEqual(output.decision, "block");
      assert.equal(output.release, undefined);
      assert.equal(output.supervisorFailure.code, "RECOVERY_PERSISTENCE_UNCONFIRMED");
    } finally {
      fs.renameSync = originalRename;
      fs.rmSync = originalRm;
      syncBuiltinESMExports();
    }
    assert.ok(fs.existsSync(runtime));
    assert.equal(readRecoveryFrontier(fixture.cwd).frontier.stopState.totalBlocks.value, 2);
    assert.ok(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "attachment.json")));
  }));
}

test("reliability: explicit release preserves frontier counters and forbids authority-optional retirement of a migrated owner", () => withReliabilityFixture((fixture) => {
  assert.equal(fixture.hook("Stop").decision, "block");
  assert.throws(() => releaseAttachment(fixture.cwd), /RECOVERY_AUTHORIZATION_REQUIRED/);
  const result = releaseAttachment(fixture.cwd, fixture.observe(), fixture.input, fixture.authority());
  assert.equal(result.released, true);
  assert.equal(fixture.frontier().frontier.stopState.totalBlocks.value, 1);
  const selected = fixture.frontier();
  fixture.select("ownerless-successor");
  const request = { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), checkpointHash: null };
  assert.throws(() => resumeSession(fixture.cwd, request, fixture.authority()), /explicit frontierHash/);
  assert.equal(resumeSession(fixture.cwd, { ...request, frontierHash: selected.frontierHash }, fixture.authority()).status, "resumed");
}));

test("reliability: native frontier Stop retains its final bounded warning without adding an allowance", () => withReliabilityFixture((fixture) => {
  assert.equal(fixture.hook("Stop").decision, "block");
  const last = fixture.hook("Stop");
  assert.equal(last.decision, "block");
  assert.match(last.reason, /final bounded continuation/);
  assert.equal(fixture.frontier().frontier.stopState.totalBlocks.value, 2);
  assert.equal(fixture.hook("Stop").decision, "allow");
  assert.equal(fixture.frontier().frontier.stopState.totalBlocks.value, 2);
}));

test("reliability: multi-generation 4 never regresses to stale 2 and unknown native effects execute only once", () => withReliabilityFixture((fixture) => {
  fixture.tool("multi-generation-positive");
  assert.equal(fixture.hook("Stop").decision, "block");
  assert.equal(fixture.hook("Stop").decision, "block");
  const handoff = (session) => {
    const checkpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), attachmentHash: fixture.observe().attachmentHash });
    fixture.select(session);
    const result = fixture.native(["resume"], { ...fixture.input, ...checkpoint.resume });
    assert.equal(result.status, "resumed");
    fixture.tool(`${session}-positive`);
    return result;
  };
  assert.equal(handoff("generation-two").context.stopState.totalBlocks.value, 2);
  const progress = (id) => {
    for (const item of fixture.plan.items) item.status = "banked";
    fixture.plan.items.push({ id, title: `Next bounded item ${id}`, status: "in_progress" });
    assert.equal(fixture.native(["lifecycle", "plan"], { ...fixture.input, expected: fixture.observe(), plan: fixture.plan }).status, "applied");
  };
  progress("two");
  assert.equal(fixture.hook("Stop").decision, "block");
  assert.equal(fixture.hook("Stop").decision, "block");
  assert.equal(fixture.frontier().frontier.stopState.totalBlocks.value, 4);
  const sentinel = path.join(fixture.base, "native-effect-once.txt");
  const code = "require('node:fs').appendFileSync(process.argv[1], 'one effect\\n')";
  const effect = { tool_name: "run_in_terminal", tool_use_id: "unknown-native-effect",
    tool_input: { command: `${JSON.stringify(process.execPath)} --eval ${JSON.stringify(code)} ${JSON.stringify(sentinel)}` } };
  assert.notEqual(fixture.hook("PreToolUse", effect).permissionDecision, "deny");
  const executed = spawnSync(process.execPath, ["--eval", code, sentinel], { cwd: fixture.cwd, encoding: "utf8", timeout: 10_000 });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "one effect\n");
  // Ordinary tool starts are journaled without publishing another frontier.
  const unknown = fixture.operations().orphans;
  assert.equal(unknown.length, 1, "the intentionally omitted native completion must leave a durable unknown operation");
  for (const [index, value] of [2, 5, 5, 5, 5].entries()) {
    fs.writeFileSync(path.join(fixture.cwd, ".supervised-worker", "runtime", `${sha256(`stale-generation-${index}`)}.json`),
      JSON.stringify({ schemaVersion: 2, progressHash: canonicalPlanHash(fixture.plan), sameProgressBlocks: 1, totalBlocks: value }));
  }
  assert.equal(handoff("generation-three").context.stopState.totalBlocks.value, 4);
  assert.deepEqual(fixture.frontier().frontier.operations.orphans, unknown);
  const exhausted = fixture.hook("Stop");
  assert.equal(exhausted.decision, "allow", "a fresh session cannot mint a new same-progress Stop allowance");
  assert.equal(exhausted.release.status, "detached");
  assert.equal(fixture.frontier().frontier.stopState.totalBlocks.value, 4);
  const selected = fixture.frontier();
  fixture.select("generation-four");
  assert.equal(fixture.native(["resume"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), checkpointHash: null, frontierHash: selected.frontierHash }).status, "resumed");
  progress("three");
  assert.equal(fixture.hook("Stop").decision, "block");
  assert.equal(fixture.frontier().frontier.stopState.totalBlocks.value, 5, "only actual governed progress permits 4 -> 5");
  const last = handoff("generation-five");
  assert.equal(last.context.stopState.totalBlocks.value, 5);
  assert.deepEqual(last.context.operations.orphans, unknown);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "one effect\n", "no recovery or handoff may replay the unknown external effect");
}));

for (const fault of ["missing", "corrupt"]) {
  test(`reliability: ${fault} runtime cache is rebuilt only from the authoritative frontier and never from zero`, () => withReliabilityFixture((fixture) => {
    assert.equal(fixture.hook("Stop").decision, "block");
    const runtime = path.join(fixture.cwd, ".supervised-worker", "runtime", `${sha256(fixture.input.session_id)}.json`);
    if (fault === "missing") fs.rmSync(runtime);
    else fs.writeFileSync(runtime, "{invalid");
    assert.ok(fault === "missing" ? !fs.existsSync(runtime) : fs.readFileSync(runtime, "utf8") === "{invalid");
    assert.equal(fixture.hook("Stop").decision, "block");
    assert.equal(fixture.frontier().frontier.stopState.totalBlocks.value, 2);
    assert.equal(JSON.parse(fs.readFileSync(runtime)).stopState.totalBlocks.value, 2);
    const bytes = fs.readFileSync(runtime);
    const head = path.join(fixture.cwd, ".supervised-worker", "recovery", "head.json");
    if (fault === "missing") fs.rmSync(head);
    else fs.writeFileSync(head, "{invalid");
    const stopped = fixture.hook("Stop");
    assert.equal(stopped.decision, "allow");
    assert.equal(stopped.release, undefined);
    assert.deepEqual(fs.readFileSync(runtime), bytes, "an unprovable frontier must not erase or zero the retained cache");
    assert.ok(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "attachment.json")));
  }));
}

test("reliability: actual baseline readers fail closed on migrated attachments runtime and checkpoint v3", () => withReliabilityFixture(async (fixture) => {
  fixture.tool("downgrade-positive");
  assert.equal(fixture.hook("Stop").decision, "block");
  const snapshot = fixture.observe();
  const state = path.join(fixture.cwd, ".supervised-worker");
  const runtime = path.join(state, "runtime", `${sha256(fixture.input.session_id)}.json`);
  const cache = fs.readFileSync(runtime);
  const attachment = fs.readFileSync(path.join(state, "attachment.json"));
  const root = path.join(fixture.base, "baseline-readers");
  fs.cpSync(fixture.installRoot, root, { recursive: true });
  const baseline = "d11a2070fdd40d6e8b44a286087c3dfe9b102e10";
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", baseline, "--", "src", "schemas"], { cwd: reliabilitySourceRoot, encoding: "utf8" }).trim().split("\n");
  for (const file of files) {
    fs.writeFileSync(path.join(root, file), execFileSync("git", ["show", `${baseline}:${file}`], { cwd: reliabilitySourceRoot, maxBuffer: 4_194_304 }));
  }
  const old = await import(pathToFileURL(path.join(root, "src", "core.mjs")).href);
  const denied = old.handleHook({ cwd: fixture.cwd, ...fixture.input, tool_name: "read_file",
    tool_use_id: "old-reader-must-not-adopt", tool_input: { filePath: path.join(fixture.cwd, "README.md") } }, "PreToolUse");
  assert.equal(denied.permissionDecision, "deny", JSON.stringify(denied));
  assert.deepEqual(fs.readFileSync(runtime), cache);
  assert.deepEqual(fs.readFileSync(path.join(state, "attachment.json")), attachment);
  assert.deepEqual(fixture.observe(), snapshot);
  const checkpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), attachmentHash: snapshot.attachmentHash });
  const receipt = JSON.parse(fs.readFileSync(path.join(state, "checkpoints", `${checkpoint.checkpointHash}.json`)));
  assert.equal(receipt.schemaVersion, 3);
  assert.ok(old.validateCheckpoint(receipt).length > 0);
  const before = fixture.observe();
  assert.throws(() => old.resumeSession(fixture.cwd, { session_id: "old-successor", ...checkpoint.resume }));
  assert.deepEqual(fixture.observe(), before);
}));

for (const mode of ["route-after-rename", "attachment-after-remove", "terminal-head-before-rename", "terminal-head-after-rename"]) {
  test(`reliability: interrupted release ${mode} completes from exact evidence and resumes useful work`, () => withReliabilityFixture((fixture) => {
    fixture.tool("interrupted-release-positive");
    assert.equal(fixture.hook("Stop").decision, "block");
    const originalRename = fs.renameSync;
    const originalRm = fs.rmSync;
    let headWrites = 0;
    let fired = false;
    fs.renameSync = (from, to) => {
      if (String(to).endsWith(`${path.sep}head.json`)) headWrites += 1;
      const target = mode === "route-after-rename" && String(to).endsWith(`${path.sep}route.json`) ||
        mode.startsWith("terminal-head-") && headWrites === 2 && String(to).endsWith(`${path.sep}head.json`);
      if (!fired && target) {
        fired = true;
        if (!mode.endsWith("before-rename")) originalRename(from, to);
        throw Object.assign(new Error("injected interrupted release"), { code: "EIO" });
      }
      return originalRename(from, to);
    };
    fs.rmSync = (target, ...args) => {
      const result = originalRm(target, ...args);
      if (!fired && mode === "attachment-after-remove" && String(target).endsWith(`${path.sep}attachment.json`)) {
        fired = true;
        throw Object.assign(new Error("injected lost detach response"), { code: "ENOSPC" });
      }
      return result;
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => releaseAttachment(fixture.cwd, fixture.observe(), fixture.input, fixture.authority()));
    } finally {
      fs.renameSync = originalRename;
      fs.rmSync = originalRm;
      syncBuiltinESMExports();
    }
    assert.equal(fired, true, `${mode} must reach its exact boundary`);
    assert.equal(fixture.frontier().frontier.stopState.totalBlocks.value, 1);
    const diagnosis = fixture.doctor({ operation: "diagnose" });
    assert.equal(diagnosis.observation.status, "complete");
    const action = diagnosis.candidates.find((value) => value.kind === "finish-release");
    if (mode === "terminal-head-after-rename") {
      assert.equal(fixture.frontier().frontier.phase, "detached");
      assert.equal(action, undefined);
    } else {
      assert.ok(action, JSON.stringify(diagnosis));
      const proposal = fixture.doctor({ operation: "propose-recovery", expectedHash: diagnosis.observationHash, action });
      const grant = authorizeFixtureProposal(fixture, proposal);
      const result = fixture.doctor({ operation: "recover-authorized", authorizationHash: grant.authorizationHash });
      assert.equal(result.status, "applied", JSON.stringify(result));
      assert.deepEqual(fixture.doctor({ operation: "recover-authorized", authorizationHash: grant.authorizationHash }), result);
    }
    assert.equal(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "attachment.json")), false);
    const frontierHash = fixture.frontier().frontierHash;
    fixture.select(`after-${mode}`);
    const resumed = fixture.native(["resume"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), checkpointHash: null, frontierHash });
    assert.equal(resumed.status, "resumed");
    assert.equal(resumed.context.stopState.totalBlocks.value, 1);
    fixture.tool(`recovered-${mode}`);
    const checkpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), attachmentHash: fixture.observe().attachmentHash });
    fixture.select(`fresh-${mode}`);
    assert.equal(fixture.native(["resume"], { ...fixture.input, ...checkpoint.resume }).status, "resumed");
    fixture.tool(`fresh-tool-${mode}`);
  }));
}
