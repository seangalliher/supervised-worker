import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDoctorIncident, doctorHash } from "../src/doctor-state.mjs";
import { createDoctorHostAdapter, continueDoctorCampaign, promoteDoctorRepair, replayDoctorHistory, rollbackDoctorPromotion, validateDoctorMatrix } from "../src/doctor-promotion.mjs";
import { createWorkerAuthorityFixture } from "./worker-authority-fixture.mjs";
import { installLocalPlugin, resolvePluginSourceIdentity } from "../src/install.mjs";
import { sha256 } from "../src/core.mjs";

test("Doctor requires all nine exact-commit CI jobs and both required steps", () => {
  const commit = "a".repeat(40);
  const matrix = { complete: true, commit, runId: 1, conclusion: "success", jobs:
    ["ubuntu-latest", "macos-latest", "windows-latest"].flatMap((os) => [20, 22, 24].map((node) => ({ name: `test (${os}, ${node})`, commit,
      conclusion: "success", steps: ["npm test", "npm run validate"].map((command) => ({ name: `Run ${command}`, status: "completed", conclusion: "success" })) }))) };
  assert.equal(validateDoctorMatrix(matrix, commit).jobs.length, 9);
  for (const mutate of [
    (value) => { value.jobs.pop(); },
    (value) => { value.jobs[1] = value.jobs[0]; },
    (value) => { value.jobs[0].steps[1].conclusion = "skipped"; },
    (value) => { value.jobs[0].commit = "b".repeat(40); },
    (value) => { value.complete = false; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed);
    assert.throws(() => validateDoctorMatrix(changed, commit), /CI_UNCONFIRMED/);
  }
  assert.throws(() => validateDoctorMatrix(null, commit), /CI_UNCONFIRMED/);
});

test("Doctor history replay validates versioned contiguous state and refuses missing history", () => {
  const binding = { incidentId: randomUUID(), repositoryHash: "a".repeat(64), campaignHash: "b".repeat(64), workflowHash: "c".repeat(64) };
  const incident = createDoctorIncident(binding, "delegated", []);
  const next = { ...incident, revision: 1, previousHash: doctorHash(incident) };
  assert.equal(replayDoctorHistory([next, incident]).status, "compatible");
  assert.throws(() => replayDoctorHistory([next]), /REPLAY_FAILED/);
  assert.throws(() => replayDoctorHistory([incident, { ...next, authorityMode: "supervised" }]), /REPLAY_FAILED/);
  assert.throws(() => replayDoctorHistory([]), /REPLAY_FAILED/);
  assert.throws(() => replayDoctorHistory(null), /REPLAY_FAILED/);
});

test("Doctor activation is unavailable without a separately trusted host adapter", () => {
  assert.deepEqual(promoteDoctorRepair(null, null, null, null, null, null), {
    status: "blocked", reason: "DOCTOR_HOST_ACTIVATION_UNAVAILABLE", values: [],
  });
  assert.throws(() => createDoctorHostAdapter(process.cwd(), {}, {}, {}), /verified/);
});

test("trusted fixture host rollback is exact, observable after a lost response, and preserves immutable bytes", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "doctor-host-fixture-")));
  try {
    const cwd = path.join(base, "repo");
    mkdirSync(cwd);
    const input = { session_id: "fixture-only-host" };
    const fixture = createWorkerAuthorityFixture(cwd, input);
    const authority = fixture.authority();
    const previousRoot = fixture.installRoot;
    const candidateRoot = installLocalPlugin(new URL("../", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""), { baseDirectory: path.join(base, "candidate-install") }).installRoot;
    const observation = (root, generation) => ({ schemaVersion: 1, kind: "doctor-host-observation", complete: true,
      workerAuthorities: 1, hookAuthorities: 1, legacyEnabled: false, safeActivation: true, generation, installRoot: root,
      commit: "a".repeat(40), tree: "b".repeat(40), sourceHash: resolvePluginSourceIdentity(root).sourceHash,
      installRecordHash: sha256(readFileSync(path.join(root, "install-record.json"))) });
    const previous = observation(previousRoot, 1);
    const expected = observation(candidateRoot, 2);
    let current = expected;
    let switches = 0;
    const adapter = createDoctorHostAdapter(cwd, input, authority, {
      observe: () => structuredClone(current),
      observeMatrix: () => null,
      health: (root) => ({ status: "healthy", sourceHash: resolvePluginSourceIdentity(root).sourceHash }),
      continueCampaign: () => null,
      compareAndSet: (before, after) => {
        assert.equal(doctorHash(before), doctorHash(current));
        switches += 1;
        current = structuredClone(after);
        throw new Error("fixture loses reply after effect");
      },
    });
    const binding = { incidentId: randomUUID(), repositoryHash: "a".repeat(64), campaignHash: "b".repeat(64), workflowHash: "c".repeat(64) };
    const actionId = randomUUID();
    const identity = (record) => Object.fromEntries(["commit", "tree", "sourceHash", "installRecordHash"].map((key) => [key, record[key]]));
    const promotion = { schemaVersion: 1, kind: "doctor-promotion", binding, actionId, candidate: identity(expected), previous: identity(previous),
      reviewHash: "a".repeat(64), testHash: "b".repeat(64), ciHash: "c".repeat(64), replayHash: "d".repeat(64), healthHash: "e".repeat(64), status: "activated" };
    const intent = { schemaVersion: 1, kind: "doctor-repair-intent", binding, attemptId: randomUUID(), actionId, action: "rollback",
      capabilityHash: "a".repeat(64), expectedHash: "b".repeat(64), inputHashes: [doctorHash(promotion)] };
    const beforeHash = sha256(readFileSync(path.join(previousRoot, "src", "core.mjs")));
    const result = rollbackDoctorPromotion(cwd, input, authority, intent, promotion, previous, expected, adapter);
    assert.equal(result.reason, "DOCTOR_CANDIDATE_ROLLED_BACK");
    assert.equal(result.values[1].status, "restored");
    assert.equal(current.installRoot, previousRoot);
    assert.equal(switches, 1);
    assert.equal(sha256(readFileSync(path.join(previousRoot, "src", "core.mjs"))), beforeHash);
    assert.equal(rollbackDoctorPromotion(cwd, input, authority, intent, promotion, previous, expected, adapter).status, "conflict");
    assert.equal(switches, 1);
    assert.throws(() => rollbackDoctorPromotion(cwd, input, authority, intent, promotion, { ...previous, commit: "f".repeat(40) }, expected, adapter), /BINDING_CONFLICT/);
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("continuation refuses an unavailable host and never fabricates a resume", () => {
  assert.deepEqual(continueDoctorCampaign(null, null, null, null, null), {
    status: "blocked", reason: "DOCTOR_HOST_CONTINUATION_UNAVAILABLE", values: [],
  });
});