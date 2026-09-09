import { randomUUID } from "node:crypto";

import { sha256, validateDoctor } from "./core.mjs";

export const DEFAULT_DOCTOR_BUDGET = Object.freeze({ maxAttempts: 3, maxSteps: 64, maxNoProgress: 3, maxElapsedMs: 3_600_000 });
export const DOCTOR_ACTIONS = Object.freeze({
  diagnose: { to: "diagnosing", effect: "read-only", from: ["detected", "diagnosing", "stabilizing", "repairing", "validating", "reviewing"] },
  inspect: { to: "diagnosing", effect: "read-only", from: ["detected", "diagnosing", "stabilizing", "resuming"] },
  recover: { to: "stabilizing", effect: "internal-state", from: ["diagnosing", "stabilizing"] },
  "create-repair": { to: "repairing", effect: "git-local", from: ["diagnosing", "stabilizing", "repairing", "validating", "reviewing"] },
  "cleanup-repair": { to: "diagnosing", effect: "git-local", from: ["diagnosing", "repairing", "validating", "reviewing"] },
  validate: { to: "validating", effect: "read-only", from: ["repairing", "validating"] },
  review: { to: "reviewing", effect: "read-only", from: ["validating", "reviewing"] },
  promote: { to: "promoting", effect: "host-activation", from: ["reviewing", "promoting"] },
  rollback: { to: "promoting", effect: "host-activation", from: ["promoting", "resuming"] },
  continue: { to: "resuming", effect: "continuation", from: ["diagnosing", "stabilizing", "promoting", "resuming"] },
  cancel: { to: "blocked", effect: "internal-state", from: ["detected", "diagnosing", "stabilizing", "repairing", "validating", "reviewing", "promoting", "resuming", "blocked"] },
  revoke: { to: "blocked", effect: "internal-state", from: ["detected", "diagnosing", "stabilizing", "repairing", "validating", "reviewing", "promoting", "resuming", "blocked"] },
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function doctorHash(value) {
  return sha256(JSON.stringify(canonical(value)));
}

export function requireDoctor(value, definition = null) {
  if (validateDoctor(value, definition).length > 0) throw new Error("DOCTOR_RECORD_INVALID");
  return value;
}

function sameBinding(left, right) {
  return doctorHash(left) === doctorHash(right);
}

export function createDoctorIncident(binding, authorityMode, inputHashes, now = new Date().toISOString(), budget = DEFAULT_DOCTOR_BUDGET) {
  return requireDoctor({
    schemaVersion: 1, kind: "doctor-incident", binding: structuredClone(binding), attemptId: randomUUID(),
    state: "detected", revision: 0, previousHash: null, pendingActionHash: null, authorityMode, budget: { ...budget },
    createdAt: now, updatedAt: now, reason: "INTERNAL_FAILURE", inputHashes: [...inputHashes], stepHashes: [], cancelled: false,
  }, "incident");
}

export function decideDoctorStep(incident, history, capability, intent, now = new Date().toISOString()) {
  requireDoctor(incident, "incident");
  requireDoctor(capability, "capability");
  requireDoctor(intent, "repairIntent");
  requireDoctor(now, "time");
  if (!Array.isArray(history) || history.length > 4096) throw new Error("DOCTOR_HISTORY_INVALID");
  for (const record of history) requireDoctor(record);
  const reject = (reason, status = "blocked") => ({ status, reason, prior: null });
  if (!sameBinding(incident.binding, capability.binding) || !sameBinding(incident.binding, intent.binding) ||
    capability.actionId !== intent.actionId || capability.action !== intent.action ||
    capability.authorityMode !== incident.authorityMode || doctorHash(capability) !== intent.capabilityHash ||
    intent.attemptId !== incident.attemptId || capability.expectedHash !== intent.expectedHash) return reject("DOCTOR_BINDING_CONFLICT", "conflict");
  const records = history.filter((record) => sameBinding(record.binding, incident.binding));
  if (records.length !== history.length) return reject("DOCTOR_HISTORY_BINDING_CONFLICT", "conflict");
  const prior = records.find((record) => record.kind === "doctor-repair-outcome" && record.actionId === intent.actionId);
  if (prior) {
    if (prior.intentHash !== doctorHash(intent) || prior.capabilityHash !== intent.capabilityHash) return reject("DOCTOR_ACTION_CONFLICT", "conflict");
    return { status: "replayed", reason: "DOCTOR_RECORDED_OUTCOME", prior };
  }
  if (records.some((record) => record.kind === "doctor-repair-intent" && record.actionId === intent.actionId && doctorHash(record) !== doctorHash(intent))) {
    return reject("DOCTOR_ACTION_CONFLICT", "conflict");
  }
  if (records.some((record) => record.kind === "doctor-step" && record.actionId === intent.actionId)) return reject("DOCTOR_OUTCOME_UNKNOWN", "unknown");
  if (doctorHash(incident) !== intent.expectedHash) return reject("DOCTOR_STATE_CONFLICT", "conflict");
  const cancelling = ["cancel", "revoke"].includes(intent.action);
  if (incident.pendingActionHash !== null && !cancelling) return reject("DOCTOR_ACTION_IN_FLIGHT", "unknown");
  if (incident.cancelled || incident.state === "resolved" || (incident.state === "blocked" && !cancelling)) return reject("DOCTOR_INCIDENT_TERMINAL");
  const timestamp = Date.parse(now);
  if (Date.parse(capability.issuedAt) > timestamp || Date.parse(capability.expiresAt) <= timestamp ||
    Date.parse(capability.expiresAt) - Date.parse(capability.issuedAt) > 900_000 ||
    Date.parse(capability.expiresAt) <= Date.parse(capability.issuedAt)) return reject("DOCTOR_CAPABILITY_EXPIRED");
  if (records.some((record) => record.kind === "doctor-step" && ["cancel", "revoke"].includes(record.action))) return reject("DOCTOR_CAPABILITY_REVOKED");
  if (cancelling) return { status: "execute", reason: "DOCTOR_CANCELLATION_ADMITTED", prior: null };
  const steps = records.filter((record) => record.kind === "doctor-step" && record.status !== "reserved");
  const orderedSteps = incident.stepHashes.map((hash) => {
    const matches = steps.filter((step) => doctorHash(step) === hash);
    if (matches.length !== 1) throw new Error("DOCTOR_HISTORY_INVALID");
    return matches[0];
  });
  const attempts = new Set(steps.filter((record) => record.action === "create-repair").map((record) => record.actionId));
  if (orderedSteps.length >= incident.budget.maxSteps || (intent.action === "create-repair" && attempts.size >= incident.budget.maxAttempts) ||
    timestamp - Date.parse(incident.createdAt) >= incident.budget.maxElapsedMs || timestamp < Date.parse(incident.updatedAt)) return reject("DOCTOR_BUDGET_EXHAUSTED");
  const recent = orderedSteps.slice(-incident.budget.maxNoProgress);
  if (recent.length === incident.budget.maxNoProgress && recent.every((step) => step.progressHash === recent[0].progressHash)) return reject("DOCTOR_NO_PROGRESS");
  const action = DOCTOR_ACTIONS[intent.action];
  if (!action.from.includes(incident.state)) return reject("DOCTOR_STATE_CONFLICT", "conflict");
  if (incident.authorityMode === "supervised" && action.effect === "host-activation") return reject("DOCTOR_SUPERVISED_ACTIVATION_BOUNDARY");
  return { status: "execute", reason: "DOCTOR_STEP_ADMITTED", prior: null };
}

export function reserveDoctorStep(incident, intent, actor, now = new Date().toISOString()) {
  requireDoctor(incident, "incident");
  requireDoctor(intent, "repairIntent");
  const action = DOCTOR_ACTIONS[intent.action];
  return requireDoctor({
    schemaVersion: 1, kind: "doctor-step", binding: incident.binding, attemptId: intent.attemptId, actionId: intent.actionId,
    action: intent.action, expectedHash: intent.expectedHash, from: incident.state, to: action.to,
    authorityMode: incident.authorityMode, actor, startedAt: now, completedAt: null,
    inputHashes: intent.inputHashes, outputHashes: [], effectClass: action.effect, status: "reserved", progressHash: null, continuation: "pending",
  }, "step");
}

export function advanceDoctorIncident(incident, step, outcome) {
  requireDoctor(incident, "incident");
  requireDoctor(step, "step");
  requireDoctor(outcome, "repairOutcome");
  if (!sameBinding(incident.binding, step.binding) || !sameBinding(incident.binding, outcome.binding) ||
    step.expectedHash !== (incident.pendingActionHash === null ? doctorHash(incident) : incident.previousHash) ||
    (incident.pendingActionHash !== null && incident.pendingActionHash !== outcome.intentHash) ||
    step.actionId !== outcome.actionId || step.attemptId !== outcome.attemptId ||
    !["succeeded", "retryable", "blocked", "conflict", "unknown", "cancelled"].includes(outcome.status)) throw new Error("DOCTOR_OUTCOME_BINDING_CONFLICT");
  const terminal = !["succeeded", "retryable"].includes(outcome.status) || ["cancel", "revoke"].includes(step.action);
  return requireDoctor({
    ...incident, revision: incident.revision + 1, previousHash: doctorHash(incident),
    state: terminal ? "blocked" : outcome.status === "retryable" ? step.from : step.to,
    pendingActionHash: null, updatedAt: outcome.completedAt, reason: outcome.reason,
    stepHashes: [...incident.stepHashes, doctorHash(step)], cancelled: incident.cancelled || ["cancel", "revoke"].includes(step.action),
  }, "incident");
}