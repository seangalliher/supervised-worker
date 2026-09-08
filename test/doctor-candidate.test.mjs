import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { doctorHash } from "../src/doctor-state.mjs";
import { snapshotDoctorUserWork } from "../src/doctor-repair.mjs";
import { sha256 } from "../src/core.mjs";
import { withDoctorCandidateFixture } from "./doctor-candidate-fixture.mjs";

for (const fault of [null, "lost-reply", "post-health"]) {
  test(`Doctor exact repair-to-promotion chain preserves rollback and user work (${fault ?? "healthy"})`, () => {
    withDoctorCandidateFixture((fixture) => {
      const previousBytes = sha256(readFileSync(path.join(fixture.initial.installRoot, "src", "core.mjs")));
      const intent = fixture.makeIntent("promote", [doctorHash(fixture.reviewed)]);
      const result = fixture.run(intent, fixture.adapter);
      assert.equal(result.status, fault === "post-health" ? "blocked" : "succeeded", JSON.stringify(result));
      if (fault === "post-health") {
        assert.equal(result.reason ?? result.outcome.reason, "DOCTOR_CANDIDATE_ROLLED_BACK");
        assert.equal(fixture.active().installRoot, fixture.initial.installRoot);
        assert.equal(fixture.operations.size, 2);
      } else {
        assert.equal(fixture.active().commit, fixture.commit);
        assert.equal(fixture.active().tree, fixture.tree);
        assert.notEqual(fixture.active().installRoot, fixture.initial.installRoot);
        assert.equal(fixture.operations.size, 1);
        assert.equal(fixture.run(intent, fixture.adapter).status, "replayed");
        assert.equal(fixture.operations.size, 1);
        const continued = fixture.run(fixture.makeIntent("continue", ["f".repeat(64)]), fixture.adapter);
        assert.equal(continued.status, "succeeded", JSON.stringify(continued));
        assert.equal(fixture.observe().incident.state, "resolved");
      }
      assert.equal(sha256(readFileSync(path.join(fixture.initial.installRoot, "src", "core.mjs"))), previousBytes);
      assert.equal(snapshotDoctorUserWork(fixture.source), fixture.humanHash);
      assert.equal(existsSync(path.join(fixture.repairRoot, ".supervised-worker")), false);
    }, fault);
  });
}

test("Doctor can explicitly roll back the exact recorded promoted candidate", () => {
  withDoctorCandidateFixture((fixture) => {
    const promoted = fixture.run(fixture.makeIntent("promote", [doctorHash(fixture.reviewed)]), fixture.adapter);
    assert.equal(promoted.status, "succeeded", JSON.stringify(promoted));
    const promotion = promoted.values[0];
    const result = fixture.run(fixture.makeIntent("rollback", [doctorHash(promotion)]), fixture.adapter);
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(result.outcome.reason, "DOCTOR_CANDIDATE_ROLLED_BACK");
    assert.equal(fixture.active().installRoot, fixture.initial.installRoot);
    assert.equal(fixture.operations.size, 2);
  });
});

test("pending CI is effect-free and retryable without destroying its incident", () => {
  withDoctorCandidateFixture((fixture) => {
    const parent = path.dirname(fixture.initial.installRoot);
    const before = readdirSync(parent).sort();
    const intent = fixture.makeIntent("promote", [doctorHash(fixture.reviewed)]);
    const result = fixture.run(intent, fixture.adapter);
    assert.equal(result.status, "retryable");
    assert.equal(result.outcome.reason, "DOCTOR_CI_UNCONFIRMED");
    assert.equal(fixture.observe().incident.state, "reviewing");
    assert.deepEqual(readdirSync(parent).sort(), before);
    assert.equal(fixture.operations.size, 0);
    assert.equal(fixture.run(intent, fixture.adapter).status, "replayed");
    assert.doesNotThrow(() => fixture.makeIntent("promote", [doctorHash(fixture.reviewed)]));
  }, "ci-pending");
});

test("host-reported unknown continuation remains unknown in durable outcome", () => {
  withDoctorCandidateFixture((fixture) => {
    assert.equal(fixture.run(fixture.makeIntent("promote", [doctorHash(fixture.reviewed)]), fixture.adapter).status, "succeeded");
    const result = fixture.run(fixture.makeIntent("continue", ["f".repeat(64)]), fixture.adapter);
    assert.equal(result.status, "unknown");
    assert.equal(result.outcome.status, "unknown");
    assert.equal(result.values[0].status, "unknown");
    const observed = fixture.observe();
    assert.notEqual(observed.incident.state, "resolved");
    assert.equal(observed.records.find((record) => record.kind === "doctor-step" && record.status === "unknown").continuation, "unknown");
  }, "continue-unknown");
});

test("cleanup with missing evidence is recorded as an effect-free refusal", () => {
  withDoctorCandidateFixture((fixture) => {
    const result = fixture.run(fixture.makeIntent("cleanup-repair"));
    assert.equal(result.status, "blocked");
    assert.equal(result.outcome.reason, "DOCTOR_EXACT_EVIDENCE_REQUIRED");
    assert.equal(existsSync(fixture.repairRoot), true);
  });
});