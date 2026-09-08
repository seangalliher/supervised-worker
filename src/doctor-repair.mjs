import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

import { sha256 } from "./core.mjs";
import { doctorHash, requireDoctor } from "./doctor-state.mjs";
import { inspectHandoffFile, runTrustedGit, validateRepositoryPath } from "./handoff.mjs";
import { parseWorkflowJson } from "./workflow.mjs";

const pathKey = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

function canonicalDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || pathKey(directory) !== pathKey(realpathSync(directory)) ||
    !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("DOCTOR_REPAIR_PATH_INVALID");
  return realpathSync(directory);
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function doctorGit(root, argumentsList) {
  try {
    return runTrustedGit(root, argumentsList);
  } catch {
    throw new Error("DOCTOR_GIT_OPERATION_UNCONFIRMED");
  }
}

export function snapshotDoctorUserWork(root) {
  canonicalDirectory(root);
  const paths = [...new Set(doctorGit(root, ["ls-files", "--modified", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))].sort();
  if (paths.length > 4096) throw new Error("DOCTOR_USER_WORK_BOUND_EXCEEDED");
  let bytes = 0;
  const entries = paths.map((relative) => {
    const target = path.resolve(root, relative);
    if (!contains(root, target)) throw new Error("DOCTOR_USER_WORK_PATH_INVALID");
    if (!existsSync(target)) return { path: relative, kind: "absent" };
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) return { path: relative, kind: "link", hash: sha256(readlinkSync(target)) };
    if (!stats.isFile() || stats.size > 8_388_608 || !contains(root, realpathSync(target))) throw new Error("DOCTOR_USER_WORK_PATH_INVALID");
    bytes += stats.size;
    if (bytes > 67_108_864) throw new Error("DOCTOR_USER_WORK_BOUND_EXCEEDED");
    return { path: relative, kind: "file", hash: sha256(readFileSync(target)) };
  });
  return doctorHash({ head: doctorGit(root, ["rev-parse", "HEAD"]).trim(),
    index: sha256(doctorGit(root, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"])),
    status: doctorGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), entries });
}

export function doctorRepairLocation(campaignRoot, configuration, incidentId, actionId) {
  requireDoctor(incidentId, "id");
  requireDoctor(actionId, "id");
  if (!configuration) throw new Error("DOCTOR_REPAIR_POLICY_UNAVAILABLE");
  const source = canonicalDirectory(configuration.sourceRepository);
  const parent = canonicalDirectory(configuration.repairDirectory);
  const campaign = canonicalDirectory(campaignRoot);
  if (contains(source, parent) || contains(parent, source) || contains(campaign, parent) || contains(parent, campaign)) throw new Error("DOCTOR_REPAIR_ISOLATION_REQUIRED");
  requireDoctor(configuration.baseCommit, "gitHash");
  if (doctorGit(source, ["rev-parse", "--verify", `${configuration.baseCommit}^{commit}`]).trim() !== configuration.baseCommit) throw new Error("DOCTOR_REPAIR_BASE_INVALID");
  const plugin = parseWorkflowJson(Buffer.from(doctorGit(source, ["show", `${configuration.baseCommit}:plugin.json`])));
  if (plugin.name !== "supervised-worker") throw new Error("DOCTOR_REPAIR_SOURCE_INVALID");
  return { source, root: path.join(parent, `${incidentId}-${actionId}`) };
}

export function doctorRepairItemId(incidentId, actionId) {
  requireDoctor(incidentId, "id");
  requireDoctor(actionId, "id");
  return `doctor-${incidentId}-${actionId}`;
}

export function readDoctorBuildContract(campaignRoot, workflow, intent) {
  const itemId = doctorRepairItemId(intent.binding.incidentId, intent.actionId);
  const filePath = path.join(campaignRoot, ".supervised-worker", "handoffs", sha256(itemId), "build-contract.json");
  const inspected = inspectHandoffFile(campaignRoot, filePath);
  if (!inspected.ok || inspected.kind !== "build-contract" || inspected.itemId !== itemId || !intent.inputHashes.includes(inspected.sha256)) throw new Error("DOCTOR_REPAIR_CONTRACT_UNCONFIRMED");
  const bytes = readFileSync(filePath);
  if (sha256(bytes) !== inspected.sha256 || inspectHandoffFile(campaignRoot, filePath).sha256 !== inspected.sha256) throw new Error("DOCTOR_REPAIR_CONTRACT_CHANGED");
  const contract = parseWorkflowJson(bytes);
  if (contract.status !== "approved" || contract.workflowHash !== workflow.workflowHash || contract.producedBy !== workflow.roles.architect ||
    contract.targetFiles.some((target) => /^(?:\.github\/|policy\/|\.supervised-worker(?:\/|$))/i.test(target))) throw new Error("DOCTOR_REPAIR_CONTRACT_REJECTED");
  return { contract, hash: inspected.sha256 };
}

export function createDoctorRepairAttempt(campaignRoot, workflow, intent, authorize = () => {}) {
  let location;
  let hash;
  let before;
  try {
    requireDoctor(intent, "repairIntent");
    const approved = readDoctorBuildContract(campaignRoot, workflow, intent);
    hash = approved.hash;
    location = doctorRepairLocation(campaignRoot, workflow.doctor, intent.binding.incidentId, intent.actionId);
    if (approved.contract.targetFiles.some((target) => validateRepositoryPath(location.source, target).length > 0)) throw new Error("DOCTOR_REPAIR_SOURCE_CONTRACT_INVALID");
    if (existsSync(location.root)) throw new Error("DOCTOR_REPAIR_ATTEMPT_ALREADY_EXISTS");
    before = snapshotDoctorUserWork(location.source);
  } catch (error) {
    throw Object.assign(error, { doctorEffectStarted: false });
  }
  authorize();
  doctorGit(location.source, ["worktree", "add", "--detach", "--", location.root, workflow.doctor.baseCommit]);
  if (snapshotDoctorUserWork(location.source) !== before) throw new Error("DOCTOR_UNRELATED_WORK_CHANGED");
  if (doctorGit(location.root, ["rev-parse", "HEAD"]).trim() !== workflow.doctor.baseCommit ||
    doctorGit(location.root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim() !== "") throw new Error("DOCTOR_REPAIR_ATTEMPT_UNCONFIRMED");
  return requireDoctor({ schemaVersion: 1, kind: "doctor-repair-attempt", binding: intent.binding, attemptId: intent.attemptId,
    actionId: intent.actionId, contractHash: hash, baseCommit: workflow.doctor.baseCommit,
    rootHash: sha256(pathKey(location.root)), sourceSnapshotHash: before, status: "created" }, "repairAttempt");
}

export function cleanupDoctorRepairAttempt(campaignRoot, workflow, attempt) {
  let effectStarted = false;
  try {
  requireDoctor(attempt, "repairAttempt");
  const location = doctorRepairLocation(campaignRoot, workflow.doctor, attempt.binding.incidentId, attempt.actionId);
  if (sha256(pathKey(location.root)) !== attempt.rootHash || attempt.baseCommit !== workflow.doctor.baseCommit) throw new Error("DOCTOR_REPAIR_ATTEMPT_CONFLICT");
  canonicalDirectory(location.root);
  const common = canonicalDirectory(doctorGit(location.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
  if (pathKey(common) !== pathKey(doctorGit(location.source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim())) throw new Error("DOCTOR_REPAIR_REPOSITORY_CHANGED");
  if (doctorGit(location.root, ["rev-parse", "HEAD"]).trim() !== attempt.baseCommit ||
    doctorGit(location.root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim() !== "" ||
    doctorGit(location.root, ["ls-files", "--others", "-z"]) !== "") return { ...attempt, status: "retained" };
  const before = snapshotDoctorUserWork(location.source);
  effectStarted = true;
  doctorGit(location.source, ["worktree", "remove", "--", location.root]);
  if (snapshotDoctorUserWork(location.source) !== before) throw new Error("DOCTOR_UNRELATED_WORK_CHANGED");
  return { ...attempt, status: "removed" };
  } catch (error) {
    throw Object.assign(error, { doctorEffectStarted: effectStarted });
  }
}