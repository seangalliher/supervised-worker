import { randomUUID } from "node:crypto";

import { inspectLifecycleLock, issueRescueCapability, rescueLifecycle, sha256, withDoctorTransaction } from "./core.mjs";
import { createDoctorIncident, decideDoctorStep, doctorHash, requireDoctor, reserveDoctorStep, advanceDoctorIncident } from "./doctor-state.mjs";
import { resolveWorkflowRoles } from "./workflow.mjs";
import { cleanupDoctorRepairAttempt, createDoctorRepairAttempt } from "./doctor-repair.mjs";
import { reviewDoctorRepair, selectDoctorEvidence, validateDoctorRepair } from "./doctor-evidence.mjs";
import { continueDoctorCampaign, promoteDoctorRepair, rollbackDoctorRepair } from "./doctor-promotion.mjs";

const executorActor = Object.freeze({ role: "executor", selector: "supervised-worker-rescue", model: null, family: null, provenance: "unavailable" });

function policy(cwd) {
  const workflow = resolveWorkflowRoles(cwd, { requireAcceptance: true });
  if (!workflow.ok || !workflow.configured || !workflow.accepted || !["supervised", "delegated"].includes(workflow.authorityMode)) throw new Error("DOCTOR_ACCEPTED_WORKFLOW_REQUIRED");
  return workflow;
}

function committedHistory(stored) {
  const commits = stored.filter((record) => record.kind === "doctor-commit").sort((left, right) => left.incident.revision - right.incident.revision);
  let previous = null;
  const records = stored.filter((record) => record.kind === "doctor-capability");
  if (records.length + commits.length !== stored.length) throw new Error("DOCTOR_HISTORY_INVALID");
  for (const commit of commits) {
    const incident = commit.incident;
    if (incident.revision !== (previous === null ? 0 : previous.revision + 1) || incident.previousHash !== (previous === null ? null : doctorHash(previous))) throw new Error("DOCTOR_HISTORY_CONFLICT");
    if (doctorHash(commit.binding) !== doctorHash(incident.binding) || commit.records.some((record) => doctorHash(record.binding) !== doctorHash(incident.binding))) throw new Error("DOCTOR_HISTORY_BINDING_CONFLICT");
    records.push(incident, ...commit.records);
    previous = incident;
  }
  return { incident: previous, records };
}

function transaction(cwd, input, incidentId, authority, action) {
  return withDoctorTransaction(cwd, input, incidentId, authority, (store) => {
    const workflow = policy(store.root);
    const { incident, records } = committedHistory(store.read());
    if (incident && (incident.binding.workflowHash !== workflow.workflowHash || incident.authorityMode !== workflow.authorityMode ||
      incident.binding.repositoryHash !== store.observation.repositoryHash || incident.binding.campaignHash !== store.observation.planHash)) throw new Error("DOCTOR_CAMPAIGN_OR_POLICY_CHANGED");
    const append = (record) => {
      if (policy(store.root).workflowHash !== workflow.workflowHash) throw new Error("DOCTOR_POLICY_CHANGED");
      return store.append(record);
    };
    const commit = (next, values) => {
      for (const value of [next, ...values]) store.artifact(value);
      return append(requireDoctor({ schemaVersion: 1, kind: "doctor-commit", binding: next.binding, incident: next, records: values }, "commit"));
    };
    return action({ root: store.root, records, incident, workflow, observation: store.observation, append, commit,
      authorize: () => store.authorize(), artifact: (value) => store.artifact(value) });
  });
}

export function detectDoctorIncident(cwd, input, incidentId, diagnosticHash, authority) {
  requireDoctor(diagnosticHash, "hash");
  return transaction(cwd, input, incidentId, authority, ({ incident, workflow, observation, commit }) => {
    if (incident) {
      if (!incident.inputHashes.includes(diagnosticHash)) throw new Error("DOCTOR_INCIDENT_CONFLICT");
      return { incident, hash: doctorHash(incident), status: "recorded" };
    }
    const value = createDoctorIncident({ incidentId, repositoryHash: observation.repositoryHash,
      campaignHash: observation.planHash, workflowHash: workflow.workflowHash }, workflow.authorityMode, [diagnosticHash]);
    commit(value, []);
    return { incident: value, hash: doctorHash(value), status: "detected" };
  });
}

export function inspectDoctorIncident(cwd, input, incidentId, authority) {
  return transaction(cwd, input, incidentId, authority, ({ incident, records }) => ({ incident, records, hash: incident === null ? null : doctorHash(incident) }));
}

export function acceptDoctorHandoff(cwd, input, handoff, expectedHash, authority) {
  requireDoctor(handoff, "handoff");
  requireDoctor(expectedHash, "hash");
  return transaction(cwd, input, handoff.binding.incidentId, authority, ({ incident, records, commit }) => {
    const hash = doctorHash(handoff);
    if (records.some((record) => record.kind === "doctor-handoff" && doctorHash(record) === hash)) return { status: "recorded", hash };
    if (!incident || incident.pendingActionHash !== null || incident.cancelled || doctorHash(incident) !== expectedHash ||
      doctorHash(handoff.binding) !== doctorHash(incident.binding) || handoff.attemptId !== incident.attemptId) throw new Error("DOCTOR_HANDOFF_BINDING_CONFLICT");
    commit({ ...incident, revision: incident.revision + 1, previousHash: expectedHash, updatedAt: new Date().toISOString() }, [handoff]);
    return { status: "recorded", hash };
  });
}

export function grantDoctorAction(cwd, input, incidentId, request, authority) {
  if (!request || Object.keys(request).sort().join(",") !== "action,actionId,expectedHash") throw new Error("DOCTOR_GRANT_REQUEST_INVALID");
  requireDoctor(request.action, "action");
  requireDoctor(request.actionId, "id");
  requireDoctor(request.expectedHash, "hash");
  return transaction(cwd, input, incidentId, authority, ({ records, incident, append }) => {
    if (!incident || incident.cancelled || incident.state === "resolved" ||
      (incident.state === "blocked" && !["cancel", "revoke"].includes(request.action)) || doctorHash(incident) !== request.expectedHash) throw new Error("DOCTOR_STATE_CONFLICT");
    const existing = records.find((record) => record.kind === "doctor-capability" && record.actionId === request.actionId);
    if (existing) {
      if (existing.action !== request.action || existing.expectedHash !== request.expectedHash || existing.sessionHash !== sha256(input.session_id) || existing.grantHash !== authority.grantHash) throw new Error("DOCTOR_ACTION_CONFLICT");
      return { capability: existing, hash: doctorHash(existing) };
    }
    const now = Date.now();
    const capability = requireDoctor({ schemaVersion: 1, kind: "doctor-capability", binding: incident.binding,
      capabilityId: randomUUID(), actionId: request.actionId, action: request.action, expectedHash: request.expectedHash,
      sessionHash: sha256(input.session_id), authorityMode: incident.authorityMode, grantHash: authority.grantHash,
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900_000).toISOString(), maxUses: 1 }, "capability");
    return { capability, hash: append(capability) };
  });
}

function lifecycleSelector(input, scope) {
  return { scope, ...(input.transcript_path === undefined ? {} : { session_id: input.session_id, transcript_path: input.transcript_path }) };
}

function applyInternalAction(cwd, input, intent, authority, records, incident, hostAdapter, authorize, artifact) {
  try {
    authorize();
  } catch (error) {
    throw Object.assign(error, { doctorEffectStarted: false });
  }
  if (intent.action === "promote") return promoteDoctorRepair(cwd, input, authority, policy(cwd), intent, records, hostAdapter, authorize, artifact);
  if (intent.action === "rollback") return rollbackDoctorRepair(cwd, input, authority, intent, records, hostAdapter);
  if (intent.action === "continue") return continueDoctorCampaign(cwd, input, authority, intent, incident, hostAdapter, authorize);
  if (intent.action === "cleanup-repair") {
    let attempt;
    let workflow;
    try {
      attempt = selectDoctorEvidence(records, intent.inputHashes, "doctor-repair-attempt");
      workflow = policy(cwd);
      authorize();
    } catch (error) {
      throw Object.assign(error, { doctorEffectStarted: false });
    }
    return { status: "succeeded", reason: "DOCTOR_REPAIR_CLEANUP_OBSERVED", values: [cleanupDoctorRepairAttempt(cwd, workflow, attempt)] };
  }
  if (["validate", "review"].includes(intent.action)) {
    try {
      const value = intent.action === "validate" ? validateDoctorRepair(cwd, policy(cwd), intent, records) : reviewDoctorRepair(cwd, policy(cwd), intent, records);
      return { status: "succeeded", reason: intent.action === "validate" ? "DOCTOR_BUILD_VERIFIED" : "DOCTOR_REVIEW_VERIFIED", values: [value] };
    } catch (error) {
      return { status: "blocked", reason: /^DOCTOR_[A-Z_]+$/.test(error.message) ? error.message : "DOCTOR_EVIDENCE_UNCONFIRMED", values: [] };
    }
  }
  if (intent.action === "create-repair") return { status: "succeeded", reason: "DOCTOR_REPAIR_CREATED", values: [createDoctorRepairAttempt(cwd, policy(cwd), intent, authorize)] };
  if (["diagnose", "inspect"].includes(intent.action)) {
    const inspections = ["repository", ...(input.transcript_path === undefined ? [] : ["session"])].map((scope) => inspectLifecycleLock(cwd, lifecycleSelector(input, scope)));
    if (inspections.some((value) => value.status === "unconfirmed")) return { status: "blocked", reason: "DOCTOR_OWNER_UNVERIFIABLE", values: inspections };
    return { status: "succeeded", reason: "DOCTOR_INSPECTED", values: inspections };
  }
  if (intent.action === "recover") {
    const inspections = ["repository", ...(input.transcript_path === undefined ? [] : ["session"])].map((scope) => inspectLifecycleLock(cwd, lifecycleSelector(input, scope)));
    const dead = inspections.filter((value) => value.status === "inspected" && value.diagnostics[0]?.code === "LIFECYCLE_OWNER_DEAD");
    if (dead.length !== 1 || inspections.some((value) => value.status === "unconfirmed")) return { status: "blocked", reason: "DOCTOR_EXACT_DEAD_OWNER_REQUIRED", values: inspections };
    const selected = dead[0];
    if (!intent.inputHashes.includes(doctorHash(selected))) return { status: "conflict", reason: "DOCTOR_RECOVERY_SNAPSHOT_CHANGED", values: inspections };
    const grant = issueRescueCapability(cwd, { session_id: input.session_id,
      ...(input.transcript_path === undefined ? {} : { transcript_path: input.transcript_path }), scope: selected.expected.scope,
      incidentId: intent.binding.incidentId, expiresAt: new Date(Date.now() + 600_000).toISOString() }, authority);
    const result = rescueLifecycle(cwd, { session_id: input.session_id, ...(input.transcript_path === undefined ? {} : { transcript_path: input.transcript_path }),
      capability: grant.capability, incidentId: grant.incidentId, snapshotHash: grant.snapshotHash, action: "recover" });
    return { status: ["recovered", "already-recovered"].includes(result.status) ? "succeeded" : "unknown", reason: "DOCTOR_RECOVERY_OBSERVED", values: [result] };
  }
  if (["cancel", "revoke"].includes(intent.action)) return { status: "cancelled", reason: "DOCTOR_CANCELLED", values: [] };
  return { status: "blocked", reason: "DOCTOR_HOST_ACTION_UNAVAILABLE", values: [] };
}

export function executeDoctorIntent(cwd, input, intent, authority, hostAdapter = null) {
  requireDoctor(intent, "repairIntent");
  const incidentId = intent.binding.incidentId;
  return transaction(cwd, input, incidentId, authority, ({ root, incident, records, commit, authorize: authorizeOwner, artifact }) => {
    const capability = records.find((record) => record.kind === "doctor-capability" && doctorHash(record) === intent.capabilityHash);
    if (!capability || capability.sessionHash !== sha256(input.session_id) || capability.grantHash !== authority.grantHash) throw new Error("DOCTOR_CAPABILITY_UNCONFIRMED");
    const decision = decideDoctorStep(incident, records, capability, intent);
    if (decision.status !== "execute") return decision;
    const authorize = () => {
      authorizeOwner();
      if (Date.parse(capability.expiresAt) <= Date.now()) throw new Error("DOCTOR_CAPABILITY_EXPIRED");
    };
    const step = reserveDoctorStep(incident, intent, executorActor);
    const reserved = requireDoctor({ ...incident, previousHash: doctorHash(incident), revision: incident.revision + 1,
      pendingActionHash: doctorHash(intent), updatedAt: step.startedAt }, "incident");
    commit(reserved, [intent, step]);
    let result;
    try {
      result = applyInternalAction(root, input, intent, authority, records, incident, hostAdapter, authorize, artifact);
    } catch (error) {
      result = error.doctorEffectStarted === false
        ? { status: error.message === "DOCTOR_CI_UNCONFIRMED" ? "retryable" : "blocked",
          reason: /^DOCTOR_[A-Z_]+$/.test(error.message) ? error.message : "DOCTOR_PRECONDITION_UNCONFIRMED", values: [] }
        : { status: "unknown", reason: "DOCTOR_EFFECT_OUTCOME_UNKNOWN", values: [] };
    }
    const outcome = requireDoctor({ schemaVersion: 1, kind: "doctor-repair-outcome", binding: intent.binding,
      attemptId: intent.attemptId, actionId: intent.actionId, intentHash: doctorHash(intent), capabilityHash: intent.capabilityHash,
      status: result.status, reason: result.reason, outputHashes: [...new Set(result.values.map(doctorHash))], completedAt: new Date().toISOString() }, "repairOutcome");
    const completed = { ...step, status: outcome.status, completedAt: outcome.completedAt,
      outputHashes: outcome.outputHashes, progressHash: doctorHash(outcome.outputHashes),
      continuation: outcome.status === "unknown" ? "unknown"
        : result.values.some((value) => value.kind === "doctor-continuation" && value.status === "resumed") ? "resume"
        : ["DOCTOR_HOST_ACTIVATION_UNAVAILABLE", "DOCTOR_HOST_CONTINUATION_UNAVAILABLE", "DOCTOR_SUPERVISED_ACTIVATION_BOUNDARY"].includes(outcome.reason) ? "checkpoint-required"
        : ["succeeded", "retryable"].includes(outcome.status) ? "pending" : "blocked" };
    const next = advanceDoctorIncident(reserved, completed, outcome);
    if (intent.action === "continue" && result.status === "succeeded") next.state = "resolved";
    for (const value of result.values) artifact(value);
    commit(next, [completed, outcome, ...result.values.filter((value) => ["doctor-repair-attempt", "doctor-validation", "doctor-review", "doctor-promotion", "doctor-rollback", "doctor-continuation"].includes(value.kind))]);
    return { status: outcome.status, outcome, outcomeHash: doctorHash(outcome), incidentHash: doctorHash(next), values: result.values };
  });
}