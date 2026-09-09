import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { requireVerifiedWorkerAuthority } from "./authority.mjs";
import { sha256, validateDoctor } from "./core.mjs";
import { doctorHash, requireDoctor } from "./doctor-state.mjs";
import { doctorEvidenceContext, reviewDoctorRepair, selectDoctorEvidence } from "./doctor-evidence.mjs";
import { doctorGit, snapshotDoctorUserWork } from "./doctor-repair.mjs";
import { installLocalPlugin, resolvePluginSourceIdentity } from "./install.mjs";

const hostAdapters = new WeakMap();
const matrixNames = ["ubuntu-latest", "macos-latest", "windows-latest"].flatMap((os) => [20, 22, 24].map((node) => `test (${os}, ${node})`));

export function validateDoctorMatrix(value, commit) {
  if (!value || value.complete !== true || value.commit !== commit || value.conclusion !== "success" ||
    !Number.isSafeInteger(value.runId) || value.runId < 1 || !Array.isArray(value.jobs) || value.jobs.length !== 9) throw new Error("DOCTOR_CI_UNCONFIRMED");
  const names = new Set();
  for (const job of value.jobs) {
    if (!matrixNames.includes(job.name) || names.has(job.name) || job.conclusion !== "success" || job.commit !== commit ||
      !Array.isArray(job.steps) || !["npm test", "npm run validate"].every((command) => job.steps.some((step) =>
        step.name === `Run ${command}` && step.status === "completed" && step.conclusion === "success"))) throw new Error("DOCTOR_CI_UNCONFIRMED");
    names.add(job.name);
  }
  return { schemaVersion: 1, kind: "doctor-ci-observation", commit, runId: value.runId,
    jobs: value.jobs.map((job) => ({ name: job.name, conclusion: job.conclusion })).sort((left, right) => left.name.localeCompare(right.name)) };
}

export function replayDoctorHistory(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > 4096) throw new Error("DOCTOR_HISTORY_REPLAY_FAILED");
  for (const record of records) if (validateDoctor(record).length > 0) throw new Error("DOCTOR_HISTORY_REPLAY_FAILED");
  const incidents = records.filter((record) => record.kind === "doctor-incident").sort((left, right) => left.revision - right.revision);
  if (incidents.length === 0) throw new Error("DOCTOR_HISTORY_REPLAY_FAILED");
  let previous = null;
  for (const incident of incidents) {
    if (incident.revision !== (previous?.revision ?? -1) + 1 || incident.previousHash !== (previous === null ? null : doctorHash(previous)) ||
      (previous && (doctorHash(previous.binding) !== doctorHash(incident.binding) || previous.authorityMode !== incident.authorityMode))) throw new Error("DOCTOR_HISTORY_REPLAY_FAILED");
    previous = incident;
  }
  const outcomes = new Map();
  for (const outcome of records.filter((record) => record.kind === "doctor-repair-outcome")) {
    const key = `${outcome.binding.incidentId}:${outcome.actionId}`;
    if (outcomes.has(key) || !records.some((record) => record.kind === "doctor-repair-intent" && doctorHash(record) === outcome.intentHash)) throw new Error("DOCTOR_HISTORY_REPLAY_FAILED");
    outcomes.set(key, doctorHash(outcome));
  }
  return { schemaVersion: 1, kind: "doctor-history-replay", historyHash: doctorHash(records), incidents: incidents.length, outcomes: outcomes.size, status: "compatible" };
}

export function createDoctorHostAdapter(cwd, input, authority, implementation) {
  requireVerifiedWorkerAuthority(authority, cwd, input);
  const methods = ["observe", "compareAndSet", "observeMatrix", "health", "continueCampaign"];
  if (!implementation || methods.some((method) => typeof implementation[method] !== "function")) throw new Error("DOCTOR_HOST_ADAPTER_INVALID");
  const adapter = Object.freeze({ kind: "trusted-doctor-host-adapter" });
  hostAdapters.set(adapter, { implementation, repository: realpathSync(cwd), sessionId: input.session_id, authority });
  return adapter;
}

function host(adapter, cwd, input, authority) {
  const trusted = hostAdapters.get(adapter);
  if (!trusted || trusted.repository !== realpathSync(cwd) || trusted.sessionId !== input.session_id || trusted.authority !== authority) throw new Error("DOCTOR_HOST_ACTIVATION_UNAVAILABLE");
  requireVerifiedWorkerAuthority(authority, cwd, input);
  return trusted.implementation;
}

function immutable(root) {
  const identity = resolvePluginSourceIdentity(root);
  if (identity.sourceKind !== "immutable-install-record") throw new Error("DOCTOR_IMMUTABLE_INSTALL_REQUIRED");
  return { sourceHash: identity.sourceHash, installRecordHash: sha256(readFileSync(path.join(root, "install-record.json"))) };
}

function active(value) {
  if (!value || value.schemaVersion !== 1 || value.kind !== "doctor-host-observation" || value.complete !== true ||
    value.workerAuthorities !== 1 || value.hookAuthorities !== 1 || value.legacyEnabled !== false || value.safeActivation !== true ||
    !Number.isSafeInteger(value.generation) || value.generation < 0 || typeof value.installRoot !== "string" || !path.isAbsolute(value.installRoot)) throw new Error("DOCTOR_HOST_PROVENANCE_UNCONFIRMED");
  requireDoctor(value.commit, "gitHash");
  requireDoctor(value.tree, "gitHash");
  const identity = immutable(value.installRoot);
  if (identity.sourceHash !== value.sourceHash || identity.installRecordHash !== value.installRecordHash) throw new Error("DOCTOR_HOST_PROVENANCE_UNCONFIRMED");
  return value;
}

function candidateHistoryCheck(root, records) {
  const script = `import { readFileSync } from "node:fs"; import { replayDoctorHistory } from ${JSON.stringify(pathToFileURL(path.join(root, "src", "doctor-promotion.mjs")).href)}; process.stdout.write(JSON.stringify(replayDoctorHistory(JSON.parse(readFileSync(0, "utf8")))));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root, input: JSON.stringify(records), encoding: "utf8", timeout: 30_000, maxBuffer: 1_048_576,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !["NODE_OPTIONS", "NODE_TEST_CONTEXT"].includes(key))),
  });
  if (result.error || result.status !== 0) throw new Error("DOCTOR_CANDIDATE_REPLAY_FAILED");
  const replay = JSON.parse(result.stdout);
  if (replay.status !== "compatible" || replay.historyHash !== doctorHash(records)) throw new Error("DOCTOR_CANDIDATE_REPLAY_FAILED");
  return replay;
}

export function promoteDoctorRepair(cwd, input, authority, workflow, intent, records, adapter = null, authorize = () => {}, publish = () => {}) {
  if (adapter === null) return { status: "blocked", reason: "DOCTOR_HOST_ACTIVATION_UNAVAILABLE", values: [] };
  let effectStarted = false;
  try {
  if (workflow?.authorityMode !== "delegated") return { status: "blocked", reason: "DOCTOR_SUPERVISED_ACTIVATION_BOUNDARY", values: [] };
  const bridge = host(adapter, cwd, input, authority);
  const reviewed = selectDoctorEvidence(records, intent.inputHashes, "doctor-review");
  const repair = selectDoctorEvidence(records, [reviewed.repairHash], "doctor-repair-attempt");
  const context = doctorEvidenceContext(cwd, workflow, repair);
  const checkedReview = reviewDoctorRepair(cwd, workflow, { ...intent, action: "review", actionId: reviewed.actionId, inputHashes: [reviewed.validationHash] }, records);
  if (doctorHash(checkedReview) !== doctorHash(reviewed)) throw new Error("DOCTOR_REVIEW_CHANGED");
  const commit = doctorGit(context.root, ["rev-parse", "HEAD"]).trim();
  if (doctorGit(context.root, ["rev-parse", "HEAD^{tree}"]).trim() !== reviewed.tree ||
    doctorGit(context.root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim() !== "") throw new Error("DOCTOR_COMMITTED_CANDIDATE_REQUIRED");
  const before = active(bridge.observe());
  const ci = validateDoctorMatrix(bridge.observeMatrix(commit), commit);
  const source = resolvePluginSourceIdentity(context.root);
  const humanBefore = snapshotDoctorUserWork(workflow.doctor.sourceRepository);
  authorize();
  effectStarted = true;
  const installation = installLocalPlugin(context.root, { baseDirectory: path.dirname(before.installRoot) });
  const installed = immutable(installation.installRoot);
  if (installed.sourceHash !== source.sourceHash) throw new Error("DOCTOR_INSTALL_SOURCE_CHANGED");
  const replay = candidateHistoryCheck(installation.installRoot, records);
  const health = bridge.health(installation.installRoot);
  if (!health || health.status !== "healthy" || health.sourceHash !== installed.sourceHash) throw new Error("DOCTOR_CANDIDATE_HEALTH_FAILED");
  if (snapshotDoctorUserWork(workflow.doctor.sourceRepository) !== humanBefore || doctorHash(active(bridge.observe())) !== doctorHash(before)) throw new Error("DOCTOR_PROMOTION_STATE_CHANGED");
  const previous = { commit: before.commit, tree: before.tree, sourceHash: before.sourceHash, installRecordHash: before.installRecordHash };
  const candidate = { commit, tree: reviewed.tree, ...installed };
  const promotion = requireDoctor({ schemaVersion: 1, kind: "doctor-promotion", binding: intent.binding, actionId: intent.actionId,
    candidate, previous, reviewHash: reviewed.reviewReportHash, testHash: reviewed.buildReportHash, ciHash: doctorHash(ci),
    replayHash: doctorHash(replay), healthHash: doctorHash(health), status: "prepared" }, "promotion");
  publish(promotion);
  if (workflow.authorityMode !== "delegated") return { status: "blocked", reason: "DOCTOR_SUPERVISED_ACTIVATION_BOUNDARY", values: [promotion] };
  const replacement = { ...before, generation: before.generation + 1, installRoot: installation.installRoot, ...candidate };
  const operationId = `${intent.binding.incidentId}:${intent.actionId}:promote`;
  authorize();
  try {
    bridge.compareAndSet(before, replacement, operationId);
  } catch {
    const observed = active(bridge.observe());
    if (doctorHash(observed) !== doctorHash(replacement)) return { status: "unknown", reason: "DOCTOR_ACTIVATION_OUTCOME_UNKNOWN", values: [promotion] };
  }
  const observed = active(bridge.observe());
  if (doctorHash(observed) !== doctorHash(replacement)) return { status: "conflict", reason: "DOCTOR_ACTIVATION_CONFLICT", values: [promotion] };
  let activatedHealth = null;
  try {
    activatedHealth = bridge.health(installation.installRoot);
  } catch {
    activatedHealth = null;
  }
  if (activatedHealth?.status === "healthy" && activatedHealth.sourceHash === installed.sourceHash) {
    return { status: "succeeded", reason: "DOCTOR_IMMUTABLE_PROMOTED", values: [{ ...promotion, status: "activated" }] };
  }
  return rollbackDoctorPromotion(cwd, input, authority, intent, { ...promotion, status: "activated" }, before, replacement, adapter);
  } catch (error) {
    throw Object.assign(error, { doctorEffectStarted: effectStarted });
  }
}

export function rollbackDoctorPromotion(cwd, input, authority, intent, promotion, previous, expected, adapter) {
  let effectStarted = false;
  try {
  requireDoctor(promotion, "promotion");
  requireDoctor(intent, "repairIntent");
  if (doctorHash(promotion.binding) !== doctorHash(intent.binding) ||
    ["commit", "tree", "sourceHash", "installRecordHash"].some((key) => promotion.previous[key] !== previous[key] || promotion.candidate[key] !== expected[key])) throw new Error("DOCTOR_ROLLBACK_BINDING_CONFLICT");
  const bridge = host(adapter, cwd, input, authority);
  active(previous);
  if (doctorHash(active(bridge.observe())) !== doctorHash(expected)) return { status: "conflict", reason: "DOCTOR_ROLLBACK_STATE_CHANGED", values: [promotion] };
  const restored = { ...previous, generation: expected.generation + 1 };
  effectStarted = true;
  try {
    bridge.compareAndSet(expected, restored, `${intent.binding.incidentId}:${intent.actionId}:rollback`);
  } catch {
    if (doctorHash(active(bridge.observe())) !== doctorHash(restored)) return { status: "unknown", reason: "DOCTOR_ROLLBACK_OUTCOME_UNKNOWN", values: [promotion] };
  }
  const health = bridge.health(restored.installRoot);
  if (doctorHash(active(bridge.observe())) !== doctorHash(restored) || health?.status !== "healthy" || health.sourceHash !== restored.sourceHash) return { status: "unknown", reason: "DOCTOR_ROLLBACK_HEALTH_UNCONFIRMED", values: [promotion] };
  const rollback = requireDoctor({ schemaVersion: 1, kind: "doctor-rollback", binding: intent.binding, actionId: intent.actionId,
    promotionHash: doctorHash(promotion), restored: promotion.previous, healthHash: doctorHash(health), status: "restored" }, "rollback");
  return { status: "blocked", reason: "DOCTOR_CANDIDATE_ROLLED_BACK", values: [{ ...promotion, status: "rolled-back" }, rollback] };
  } catch (error) {
    throw Object.assign(error, { doctorEffectStarted: effectStarted });
  }
}

export function rollbackDoctorRepair(cwd, input, authority, intent, records, adapter = null) {
  if (adapter === null) return { status: "blocked", reason: "DOCTOR_HOST_ACTIVATION_UNAVAILABLE", values: [] };
  let delegated = false;
  try {
  const bridge = host(adapter, cwd, input, authority);
  const promotion = selectDoctorEvidence(records, intent.inputHashes, "doctor-promotion");
  const current = active(bridge.observe());
  const parent = path.dirname(current.installRoot);
  const entries = readdirSync(parent, { withFileTypes: true });
  if (entries.length > 128) throw new Error("DOCTOR_ROLLBACK_SEARCH_BOUND_EXCEEDED");
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const root = path.join(parent, entry.name);
    try {
      const identity = immutable(root);
      if (identity.sourceHash === promotion.previous.sourceHash && identity.installRecordHash === promotion.previous.installRecordHash) matches.push(root);
    } catch {
      continue;
    }
  }
  if (matches.length !== 1) throw new Error("DOCTOR_ROLLBACK_TARGET_UNCONFIRMED");
  const previous = { ...current, ...promotion.previous, installRoot: matches[0] };
  delegated = true;
  return rollbackDoctorPromotion(cwd, input, authority, intent, promotion, previous, current, adapter);
  } catch (error) {
    if (!delegated) error.doctorEffectStarted = false;
    throw error;
  }
}

export function continueDoctorCampaign(cwd, input, authority, intent, incident, adapter = null, authorize = () => {}) {
  if (adapter === null) return { status: "blocked", reason: "DOCTOR_HOST_CONTINUATION_UNAVAILABLE", values: [] };
  let effectStarted = false;
  try {
  const bridge = host(adapter, cwd, input, authority);
  active(bridge.observe());
  authorize();
  effectStarted = true;
  const result = bridge.continueCampaign({ incidentId: incident.binding.incidentId, actionId: intent.actionId,
    campaignHash: incident.binding.campaignHash, expectedHash: doctorHash(incident) });
  requireDoctor(result, "continuation");
  if (doctorHash(result.binding) !== doctorHash(incident.binding) || result.actionId !== intent.actionId || result.stateHash !== doctorHash(incident) ||
    !intent.inputHashes.includes(result.interruptedActionHash)) throw new Error("DOCTOR_CONTINUATION_UNCONFIRMED");
  return { status: result.status === "resumed" ? "succeeded" : result.status === "unknown" ? "unknown" : "blocked", reason: result.reason, values: [result] };
  } catch (error) {
    throw Object.assign(error, { doctorEffectStarted: effectStarted });
  }
}