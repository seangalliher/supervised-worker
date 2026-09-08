import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createDoctorIncident, decideDoctorStep, doctorHash, reserveDoctorStep, advanceDoctorIncident } from "../src/doctor-state.mjs";

const hash = "a".repeat(64);
const now = "2026-09-07T00:01:00.000Z";
const actor = { role: "executor", selector: "supervised-worker-rescue", model: null, family: null, provenance: "unavailable" };

function fixture(action = "inspect") {
  const binding = { incidentId: randomUUID(), repositoryHash: hash, campaignHash: hash, workflowHash: hash };
  const incident = createDoctorIncident(binding, "delegated", [hash], "2026-09-07T00:00:00.000Z");
  const capability = { schemaVersion: 1, kind: "doctor-capability", binding, capabilityId: randomUUID(), actionId: randomUUID(), action,
    expectedHash: doctorHash(incident), sessionHash: hash, authorityMode: incident.authorityMode, grantHash: hash,
    issuedAt: "2026-09-07T00:00:00.000Z", expiresAt: "2026-09-07T00:10:00.000Z", maxUses: 1 };
  const intent = { schemaVersion: 1, kind: "doctor-repair-intent", binding, attemptId: incident.attemptId, actionId: capability.actionId,
    action, capabilityHash: doctorHash(capability), expectedHash: capability.expectedHash, inputHashes: [hash] };
  return { incident, capability, intent };
}

test("Doctor admits a bounded step and advances from an exact outcome", () => {
  const { incident, capability, intent } = fixture();
  assert.equal(decideDoctorStep(incident, [], capability, intent, now).status, "execute");
  const step = reserveDoctorStep(incident, intent, actor, now);
  const outcome = { schemaVersion: 1, kind: "doctor-repair-outcome", binding: incident.binding, attemptId: incident.attemptId,
    actionId: intent.actionId, intentHash: doctorHash(intent), capabilityHash: doctorHash(capability), status: "succeeded", reason: "INSPECTED", outputHashes: [hash], completedAt: now };
  const next = advanceDoctorIncident(incident, step, outcome);
  assert.equal(next.state, "diagnosing");
  assert.equal(next.previousHash, doctorHash(incident));
  assert.equal(next.revision, 1);
  assert.equal(decideDoctorStep(next, [step, outcome], capability, intent, now).prior, outcome);
});

for (const [name, mutate, expected] of [
  ["cross repository", (value) => { value.capability.binding = { ...value.incident.binding, repositoryHash: "b".repeat(64) }; }, "DOCTOR_BINDING_CONFLICT"],
  ["stale state", (value) => { value.incident.reason = "CHANGED"; }, "DOCTOR_STATE_CONFLICT"],
  ["expired capability", (value) => { value.capability.expiresAt = now; value.intent.capabilityHash = doctorHash(value.capability); }, "DOCTOR_CAPABILITY_EXPIRED"],
  ["cancelled incident", (value) => { value.incident.cancelled = true; value.capability.expectedHash = doctorHash(value.incident); value.intent.expectedHash = value.capability.expectedHash; value.intent.capabilityHash = doctorHash(value.capability); }, "DOCTOR_INCIDENT_TERMINAL"],
  ["changed action", (value) => { value.intent.actionId = randomUUID(); }, "DOCTOR_BINDING_CONFLICT"],
  ["changed authority", (value) => { value.capability.authorityMode = "supervised"; }, "DOCTOR_BINDING_CONFLICT"],
]) {
  test(`Doctor rejects ${name}`, () => {
    const value = fixture();
    assert.equal(decideDoctorStep(value.incident, [], value.capability, value.intent, now).status, "execute");
    mutate(value);
    assert.equal(decideDoctorStep(value.incident, [], value.capability, value.intent, now).reason, expected);
  });
}

test("Doctor never replays a reserved step with an unknown effect", () => {
  const { incident, capability, intent } = fixture();
  const step = reserveDoctorStep(incident, intent, actor, now);
  assert.equal(decideDoctorStep(incident, [step], capability, intent, now).status, "unknown");
});

test("Doctor distinguishes moving validation from repeated non-progress", () => {
  const { incident, capability, intent } = fixture();
  const steps = Array.from({ length: 3 }, (_, index) => ({ ...reserveDoctorStep(incident, intent, actor, now),
    actionId: randomUUID(), status: "succeeded", completedAt: now, progressHash: String(index + 1).repeat(64) }));
  const check = (completed) => {
    incident.stepHashes = completed.map(doctorHash);
    capability.expectedHash = doctorHash(incident);
    intent.expectedHash = capability.expectedHash;
    intent.capabilityHash = doctorHash(capability);
    const reserved = completed.map((step) => ({ ...step, status: "reserved", progressHash: null, completedAt: null }));
    const shuffled = [...completed].reverse().concat(reserved);
    return decideDoctorStep(incident, shuffled, capability, intent, now);
  };
  assert.equal(check(steps).status, "execute");
  assert.equal(check(steps.map((step) => ({ ...step, progressHash: hash }))).reason, "DOCTOR_NO_PROGRESS");
});

test("Doctor fences another action while a committed reservation has an unknown outcome", () => {
  const { incident, capability, intent } = fixture();
  incident.pendingActionHash = "f".repeat(64);
  capability.expectedHash = doctorHash(incident);
  intent.expectedHash = capability.expectedHash;
  intent.capabilityHash = doctorHash(capability);
  assert.equal(decideDoctorStep(incident, [], capability, intent, now).reason, "DOCTOR_ACTION_IN_FLIGHT");
  capability.action = "cancel";
  intent.action = "cancel";
  intent.capabilityHash = doctorHash(capability);
  assert.equal(decideDoctorStep(incident, [], capability, intent, now).status, "execute");
});

test("Doctor rejects empty records and malformed history", () => {
  const { incident, capability, intent } = fixture();
  assert.throws(() => createDoctorIncident(null, "delegated", []), /DOCTOR_RECORD_INVALID/);
  assert.throws(() => decideDoctorStep(incident, null, capability, intent, now), /DOCTOR_HISTORY_INVALID/);
  assert.throws(() => decideDoctorStep(incident, [{}], capability, intent, now), /DOCTOR_RECORD_INVALID/);
});