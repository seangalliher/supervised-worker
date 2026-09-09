import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { sha256, validateCampaignRelease, validateDoctor, validateLifecycle, validateTransition, withWorkerEvidenceRead } from "./core.mjs";
import { doctorHash } from "./doctor-state.mjs";
import { doctorRepairItemId } from "./doctor-repair.mjs";
import { validateModelReceiptValue } from "./handoff.mjs";
import { validateReleaseDoctorHistory } from "./release-doctor-history.mjs";
import { parseWorkflowJson, resolveWorkflowRoles } from "./workflow.mjs";

const openedInputs = new WeakMap();

function freezeJson(value) {
  if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value)) {
    for (const entry of Object.values(value)) freezeJson(entry);
    Object.freeze(value);
  }
  return value;
}
const hashPattern = "[0-9a-f]{64}";
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const safeLocator = new RegExp(`^\\.supervised-worker/(?:plan\\.json|checkpoints/${hashPattern}\\.json|release-inputs/${hashPattern}\\.json|handoffs/${hashPattern}/(?:build-contract|build-report|review-report)\\.json|runtime/(?:model-receipts/${hashPattern}/(?:builder|reviewer)\\.json|review-attempts/${hashPattern}\\.json)|doctor/${uuidPattern}/(?:records|artifacts)/${hashPattern}\\.json|lifecycle-evidence/${hashPattern}\\.(?:intent|outcome)\\.json|rescue-capabilities/${hashPattern}\\.json)$`);

function sameStats(left, right) {
  return ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every((key) => left[key] === right[key]);
}

function safePath(root, locator) {
  if (!safeLocator.test(locator)) throw new Error("RELEASE_LOCATOR_INVALID");
  let current = root;
  const segments = locator.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || (index < segments.length - 1 && !stats.isDirectory())) throw new Error("RELEASE_LINK_REJECTED");
    const relative = path.relative(root, realpathSync(current));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("RELEASE_PATH_ESCAPES");
  }
  return current;
}

function readReference(root, reference) {
  if (validateCampaignRelease(reference, "link").length > 0) throw new Error("RELEASE_REFERENCE_INVALID");
  const file = safePath(root, reference.locator);
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > 4_194_304n) throw new Error("RELEASE_ARTIFACT_INVALID");
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    if (!sameStats(before, fstatSync(descriptor, { bigint: true }))) throw new Error("RELEASE_ARTIFACT_CHANGED");
    bytes = readFileSync(descriptor);
    if (!sameStats(before, fstatSync(descriptor, { bigint: true }))) throw new Error("RELEASE_ARTIFACT_CHANGED");
  } finally {
    closeSync(descriptor);
  }
  if (!sameStats(before, lstatSync(safePath(root, reference.locator), { bigint: true })) || bytes.length !== Number(before.size) || sha256(bytes) !== reference.sha256) throw new Error("RELEASE_ARTIFACT_CHANGED");
  return { reference: { ...reference }, value: parseWorkflowJson(bytes), bytes };
}

function directory(root, locator) {
  let current = root;
  for (const segment of locator.split("/")) {
    current = path.join(current, segment);
    const stats = lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink() || path.relative(root, realpathSync(current)).startsWith("..")) throw new Error("RELEASE_DIRECTORY_INVALID");
  }
  return current;
}

function unlinkedExists(file) {
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error("RELEASE_LINK_REJECTED");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function enumerateDoctor(root) {
  const files = [];
  const doctorRoot = path.join(root, ".supervised-worker", "doctor");
  const add = (locator) => {
    const file = safePath(root, locator);
    const stats = lstatSync(file);
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > 65_536) throw new Error("RELEASE_DOCTOR_ARTIFACT_INVALID");
    const reference = { locator, sha256: sha256(readFileSync(file)) };
    files.push(readReference(root, reference));
    if (files.length > 8192) throw new Error("RELEASE_DOCTOR_INVENTORY_TOO_LARGE");
  };
  if (unlinkedExists(doctorRoot)) {
    const incidents = readdirSync(directory(root, ".supervised-worker/doctor")).sort();
    if (incidents.length > 128) throw new Error("RELEASE_DOCTOR_INVENTORY_TOO_LARGE");
    for (const incidentId of incidents) {
      if (!new RegExp(`^${uuidPattern}$`).test(incidentId)) throw new Error("RELEASE_DOCTOR_ID_INVALID");
      const prefix = `.supervised-worker/doctor/${incidentId}`;
      for (const entry of readdirSync(directory(root, prefix)).sort()) {
        if (/^transition(?:\.[0-9a-f-]{36}\.(?:recovered|retired))?$/.test(entry)) continue;
        if (!["records", "artifacts"].includes(entry)) throw new Error("RELEASE_DOCTOR_DIRECTORY_INVALID");
        for (const name of readdirSync(directory(root, `${prefix}/${entry}`)).sort()) {
          if (!new RegExp(`^${hashPattern}\\.json$`).test(name)) throw new Error("RELEASE_DOCTOR_FILE_INVALID");
          add(`${prefix}/${entry}/${name}`);
        }
      }
    }
  }
  for (const subdirectory of ["lifecycle-evidence", "rescue-capabilities"]) {
    const locator = `.supervised-worker/${subdirectory}`;
    if (!unlinkedExists(path.join(root, locator))) continue;
    for (const name of readdirSync(directory(root, locator)).sort()) {
      const pattern = subdirectory === "lifecycle-evidence" ? `^${hashPattern}\\.(?:intent|outcome)\\.json$` : `^${hashPattern}\\.json$`;
      if (!new RegExp(pattern).test(name)) throw new Error("RELEASE_DOCTOR_FILE_INVALID");
      add(`${locator}/${name}`);
    }
  }
  files.sort((left, right) => left.reference.locator < right.reference.locator ? -1 : left.reference.locator > right.reference.locator ? 1 : 0);
  if (files.reduce((total, entry) => total + entry.bytes.length, 0) > 16_777_216) throw new Error("RELEASE_DOCTOR_INVENTORY_TOO_LARGE");
  return { files, hash: doctorHash(files.map((entry) => entry.reference)) };
}

export function observeReleaseDoctorInventory(cwd, input, authority) {
  return withWorkerEvidenceRead(cwd, input, authority, ({ root, authorize }) => {
    const observed = enumerateDoctor(root);
    authorize();
    return { doctorInventoryHash: observed.hash, references: observed.files.map((entry) => entry.reference) };
  });
}

export function openWorkerReleaseInputs(cwd, input, manifest, authority) {
  if (validateCampaignRelease(manifest, "input").length > 0) throw new Error("RELEASE_INPUT_INVALID");
  return withWorkerEvidenceRead(cwd, input, authority, ({ root, observation, authorize }) => {
    const roles = new Set(manifest.artifacts.map((entry) => entry.role));
    if (roles.size !== manifest.artifacts.length || !roles.has("plan")) throw new Error("RELEASE_ROLE_INVENTORY_INVALID");
    const artifacts = manifest.artifacts.map((entry) => ({ role: entry.role, ...readReference(root, entry.reference) }));
    const plan = artifacts.find((entry) => entry.role === "plan");
    if (plan.reference.locator !== ".supervised-worker/plan.json") throw new Error("RELEASE_PLAN_LOCATOR_INVALID");
    const doctor = enumerateDoctor(root);
    if (doctor.hash !== manifest.doctorInventoryHash) throw new Error("RELEASE_DOCTOR_INVENTORY_CHANGED");
    const workflow = resolveWorkflowRoles(root, { requireAcceptance: true });
    if (!workflow.ok || !workflow.accepted) throw new Error("RELEASE_WORKFLOW_UNCONFIRMED");
    const token = Object.freeze({ kind: "worker-opened-release-inputs" });
    const dependencies = [];
    const requireUnchanged = () => {
      authorize();
      for (const entry of artifacts) readReference(root, entry.reference);
      for (const reference of dependencies) readReference(root, reference);
      const currentWorkflow = resolveWorkflowRoles(root, { requireAcceptance: true });
      if (enumerateDoctor(root).hash !== doctor.hash || !currentWorkflow.ok || !currentWorkflow.accepted || currentWorkflow.workflowHash !== workflow.workflowHash) throw new Error("RELEASE_INPUTS_CHANGED");
    };
    const dependency = (reference) => {
      const entry = readReference(root, reference);
      if (!dependencies.some((previous) => previous.locator === reference.locator && previous.sha256 === reference.sha256)) dependencies.push({ ...reference });
      return freezeJson(entry);
    };
    const dependencyAt = (locator) => {
      const file = safePath(root, locator);
      const stats = lstatSync(file);
      if (!stats.isFile() || stats.nlink !== 1 || stats.size > 4_194_304) throw new Error("RELEASE_ARTIFACT_INVALID");
      return dependency({ locator, sha256: sha256(readFileSync(file)) });
    };
    const normalized = structuredClone(manifest);
    normalized.artifacts.sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : 0);
    openedInputs.set(token, freezeJson({ root, manifest: normalized, observation, workflow, artifacts, doctor, requireUnchanged, dependency, dependencyAt }));
    requireUnchanged();
    return token;
  });
}

export function useWorkerReleaseInputs(token, action) {
  const captured = openedInputs.get(token);
  if (!captured) throw new Error("RELEASE_WORKER_OPENED_INPUTS_REQUIRED");
  captured.requireUnchanged();
  const result = action(captured);
  captured.requireUnchanged();
  return result;
}

export function summarizeReleaseDoctor(captured) {
  const { files, hash } = captured.doctor;
  if (files.length === 0) return { status: "inapplicable", provenance: "inapplicable", inventoryHash: hash, incidents: [], references: [] };
  const incidents = [];
  const groups = new Map();
  const hashes = new Set(files.map((entry) => entry.reference.sha256));
  for (const entry of files) {
    const value = entry.value;
    if (entry.reference.locator.includes("/rescue-capabilities/")) {
      if (value.kind !== "lifecycle-rescue-capability" || validateLifecycle(value.expected, "snapshot").length > 0 ||
        validateTransition(value.observation, "observation").length > 0) throw new Error("RELEASE_RESCUE_CAPABILITY_INVALID");
    } else if (validateDoctor(value).length > 0 && validateLifecycle(value).length > 0 && validateTransition(value).length > 0) throw new Error("RELEASE_DOCTOR_RECORD_INVALID");
    if (!entry.reference.locator.includes("/records/")) continue;
    if (doctorHash(value) !== entry.reference.sha256) throw new Error("RELEASE_DOCTOR_RECORD_HASH_INVALID");
    const incidentId = entry.reference.locator.split("/")[2];
    if (value.binding.incidentId !== incidentId) throw new Error("RELEASE_DOCTOR_BINDING_INVALID");
    if (!groups.has(incidentId)) groups.set(incidentId, []);
    groups.get(incidentId).push(value);
  }
  for (const [incidentId, stored] of groups) {
    const commits = stored.filter((value) => value.kind === "doctor-commit").sort((left, right) => left.incident.revision - right.incident.revision);
    const capabilities = stored.filter((value) => value.kind === "doctor-capability");
    if (commits.length === 0 || stored.length !== commits.length + capabilities.length) throw new Error("RELEASE_DOCTOR_HISTORY_INVALID");
    const records = validateReleaseDoctorHistory(commits, capabilities);
    for (const commit of commits) for (const value of [commit.incident, ...commit.records]) {
      if (doctorHash(value.binding) !== doctorHash(commit.binding) || !hashes.has(doctorHash(value))) throw new Error("RELEASE_DOCTOR_ARTIFACT_MISSING");
      if (value.kind === "doctor-repair-outcome" && value.outputHashes.some((hash) => !hashes.has(hash))) throw new Error("RELEASE_DOCTOR_ARTIFACT_MISSING");
    }
    const current = commits.at(-1).incident;
    if (current.binding.repositoryHash !== captured.observation.repositoryHash) throw new Error("RELEASE_DOCTOR_REPOSITORY_CHANGED");
    const available = new Map([...files, ...captured.artifacts].map((entry) => [entry.reference.sha256, entry.reference]));
    const externalReferences = [];
    const repairs = records.filter((record) => record.kind === "doctor-repair-attempt" && record.status === "created");
    for (const repair of repairs) {
      const itemId = doctorRepairItemId(incidentId, repair.actionId);
      const prefix = `.supervised-worker/handoffs/${sha256(itemId)}`;
      const required = [["build-contract", repair.contractHash]];
      for (const record of records.filter((entry) => entry.repairHash === doctorHash(repair))) {
        if (record.buildReportHash) required.push(["build-report", record.buildReportHash]);
        if (record.reviewReportHash) required.push(["review-report", record.reviewReportHash]);
      }
      for (const [kind, hash] of required) {
        const entry = captured.dependency({ locator: `${prefix}/${kind}.json`, sha256: hash });
        if (entry.value.kind !== kind || entry.value.itemId !== itemId || entry.value.workflowHash !== repair.binding.workflowHash) throw new Error("RELEASE_DOCTOR_HANDOFF_BINDING_INVALID");
        available.set(hash, entry.reference);
        externalReferences.push(entry.reference);
        if (kind === "review-report") {
          for (const role of ["builder", "reviewer"]) {
            const evidence = entry.value.modelResolution?.[role]?.evidence;
            const canonicalLocator = `.supervised-worker/runtime/model-receipts/${sha256(itemId)}/${role}.json`;
            if (!evidence || evidence.locator !== canonicalLocator) throw new Error("RELEASE_DOCTOR_MODEL_MISSING");
            const model = captured.dependency({ locator: canonicalLocator, sha256: evidence.sha256 });
            if (validateModelReceiptValue(model.value).length > 0 || model.value.itemId !== itemId || model.value.role !== role ||
              model.value.workflowHash !== repair.binding.workflowHash || model.value.reviewAttemptId !== entry.value.reviewAttemptId ||
              model.value.buildReportHash !== entry.value.buildReportHash || model.value.stagedTreeHash !== entry.value.stagedTreeHash) throw new Error("RELEASE_DOCTOR_MODEL_INVALID");
            available.set(model.reference.sha256, model.reference);
            externalReferences.push(model.reference);
          }
          const attempt = captured.dependencyAt(`.supervised-worker/runtime/review-attempts/${sha256(itemId)}.json`);
          if (attempt.value.itemId !== itemId || attempt.value.reviewAttemptId !== entry.value.reviewAttemptId ||
            attempt.value.contractHash !== entry.value.contractHash || attempt.value.buildReportHash !== entry.value.buildReportHash ||
            attempt.value.stagedTreeHash !== entry.value.stagedTreeHash) throw new Error("RELEASE_DOCTOR_REVIEW_ATTEMPT_CHANGED");
          available.set(attempt.reference.sha256, attempt.reference);
          externalReferences.push(attempt.reference);
        }
      }
    }
    const dependencies = new Map();
    const add = (name, hash) => {
      if (typeof hash !== "string") return;
      const reference = available.get(hash) ?? null;
      if (reference !== null) externalReferences.push(reference);
      dependencies.set(`${name}:${hash}`, { name, sha256: hash, status: reference === null ? "unavailable" : "recorded", reference });
    };
    const fields = { diagnosisHash: "diagnosis", contractHash: "contract", buildReportHash: "build-report", reviewReportHash: "review-report",
      reviewHash: "review-report", testHash: "build-report", ciHash: "ci", replayHash: "history-replay", healthHash: "health",
      repairHash: "repair-attempt", validationHash: "validation", promotionHash: "promotion", interruptedActionHash: "interrupted-action" };
    for (const record of records) {
      for (const [key, name] of Object.entries(fields)) add(name, record[key]);
      for (const hash of record.inputHashes ?? []) add("input", hash);
      for (const hash of record.evidenceHashes ?? []) add("evidence", hash);
      for (const hash of record.intentHashes ?? []) add("repair-intent", hash);
    }
    const dependencyList = [...dependencies.values()].sort((left, right) => `${left.name}:${left.sha256}` < `${right.name}:${right.sha256}` ? -1 : 1);
    incidents.push({ incidentId, stateHash: doctorHash(current), state: current.state, authorityMode: current.authorityMode,
      capabilityHashes: capabilities.map(doctorHash).sort(), coverage: dependencyList.some((entry) => entry.status === "unavailable") ? "partial" : "complete", dependencies: dependencyList,
      externalReferences });
  }
  const doctorFiles = files.filter((entry) => entry.reference.locator.startsWith(".supervised-worker/doctor/"));
  if (incidents.length === 0) {
    if (doctorFiles.length > 0) throw new Error("RELEASE_DOCTOR_HISTORY_MISSING");
    return { status: "inapplicable", provenance: "inapplicable", inventoryHash: hash, incidents: [], references: [] };
  }
  const references = new Map([...doctorFiles.map((entry) => entry.reference), ...incidents.flatMap((incident) => incident.externalReferences)].map((entry) => [entry.locator, entry]));
  return { status: "recorded", provenance: "worker-recorded", inventoryHash: hash,
    incidents: incidents.map(({ externalReferences, ...incident }) => incident).sort((left, right) => left.incidentId < right.incidentId ? -1 : left.incidentId > right.incidentId ? 1 : 0),
    references: [...references.values()].sort((left, right) => left.locator < right.locator ? -1 : 1) };
}