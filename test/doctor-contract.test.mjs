import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { validateDoctor } from "../src/core.mjs";

const schema = JSON.parse(readFileSync(new URL("../schemas/doctor.schema.json", import.meta.url)));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const hash = "a".repeat(64);
const id = "11111111-1111-4111-8111-111111111111";
const time = "2026-09-07T00:00:00.000Z";
const binding = { incidentId: id, repositoryHash: hash, campaignHash: hash, workflowHash: hash };
const candidate = { commit: "a".repeat(40), tree: "b".repeat(40), sourceHash: hash, installRecordHash: hash };
const envelope = { schemaVersion: 1, binding };
const fixtures = [
  { ...envelope, kind: "doctor-incident", attemptId: id, state: "detected", revision: 0, previousHash: null, pendingActionHash: null,
    authorityMode: "supervised", budget: { maxAttempts: 3, maxSteps: 64, maxNoProgress: 3, maxElapsedMs: 3600000 },
    createdAt: time, updatedAt: time, reason: "INTERNAL_FAILURE", inputHashes: [], stepHashes: [], cancelled: false },
  { ...envelope, kind: "doctor-capability", capabilityId: id, actionId: id, action: "inspect", expectedHash: hash,
    sessionHash: hash, authorityMode: "supervised", grantHash: hash, issuedAt: time, expiresAt: "2026-09-07T00:10:00.000Z", maxUses: 1 },
  { ...envelope, kind: "doctor-step", attemptId: id, actionId: id, action: "inspect", expectedHash: hash,
    from: "detected", to: "diagnosing", authorityMode: "supervised",
    actor: { role: "executor", selector: "supervised-worker-rescue", model: null, family: null, provenance: "unavailable" },
    startedAt: time, completedAt: null, inputHashes: [], outputHashes: [], effectClass: "read-only", status: "reserved", progressHash: null, continuation: "pending" },
  { ...envelope, kind: "doctor-repair-intent", attemptId: id, actionId: id, action: "inspect", capabilityHash: hash, expectedHash: hash, inputHashes: [] },
  { ...envelope, kind: "doctor-repair-outcome", attemptId: id, actionId: id, intentHash: hash, capabilityHash: hash,
    status: "succeeded", reason: "INSPECTED", outputHashes: [], completedAt: time },
  { ...envelope, kind: "doctor-promotion", actionId: id, candidate, previous: candidate, reviewHash: hash, testHash: hash,
    ciHash: hash, replayHash: hash, healthHash: hash, status: "prepared" },
  { ...envelope, kind: "doctor-rollback", actionId: id, promotionHash: hash, restored: candidate, healthHash: hash, status: "restored" },
  { ...envelope, kind: "doctor-continuation", actionId: id, stateHash: hash, interruptedActionHash: hash, reason: "HOST_ACTIVATION_UNAVAILABLE", status: "checkpoint-required" },
  { ...envelope, kind: "doctor-handoff", attemptId: id, producedBy: "seangalliher-supervised-doctor", diagnosisHash: hash,
    intentHashes: [], evidenceHashes: [], continuation: "pending" },
];

for (const fixture of fixtures) {
  test(`${fixture.kind} accepts a bounded versioned baseline`, () => {
    assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
    assert.deepEqual(validateDoctor(fixture), []);
  });

  test(`${fixture.kind} rejects authority widening and unbound records`, () => {
    assert.equal(validate(fixture), true, "test premise: the baseline must be accepted");
    for (const mutation of [
      (value) => { value.command = "arbitrary shell"; },
      (value) => { value.binding.repositoryHash = "unbound"; },
      (value) => { value.binding.policyOverride = true; },
      (value) => { value.schemaVersion = 2; },
      (value) => { delete value.binding; },
    ]) {
      const changed = structuredClone(fixture);
      mutation(changed);
      assert.equal(validate(changed), false, JSON.stringify(changed));
      assert.equal(validateDoctor(changed).length, 1);
    }
  });
}

test("Doctor schema rejects empty, unknown, and malformed boundaries", () => {
  for (const value of [null, [], {}, "", { ...fixtures[0], state: "complete" },
    { ...fixtures[0], budget: { ...fixtures[0].budget, maxAttempts: 999 } },
    { ...fixtures[1], maxUses: 2 }, { ...fixtures[1], authorityMode: "administrator" },
    { ...fixtures[1], expiresAt: "2026-02-30T00:00:00.000Z" },
    { ...fixtures[8], continuation: "resumed" }]) {
    assert.equal(validate(value), false, JSON.stringify(value));
    assert.equal(validateDoctor(value).length, 1);
  }
});