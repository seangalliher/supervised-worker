import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { sha256 } from "./core.mjs";
import { doctorHash, requireDoctor } from "./doctor-state.mjs";
import { doctorGit, doctorRepairItemId, doctorRepairLocation } from "./doctor-repair.mjs";
import { inspectHandoffFile, issueReviewAttempt, verifyBuildHandoff, verifyHandoffChain } from "./handoff.mjs";
import { parseWorkflowJson } from "./workflow.mjs";

const pathKey = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

export function selectDoctorEvidence(records, hashes, kind) {
  const selected = records.filter((record) => record.kind === kind && hashes.includes(doctorHash(record)));
  if (selected.length !== 1) throw new Error("DOCTOR_EXACT_EVIDENCE_REQUIRED");
  requireDoctor(selected[0]);
  return selected[0];
}

export function doctorEvidenceContext(campaignRoot, workflow, attempt) {
  requireDoctor(attempt, "repairAttempt");
  if (attempt.status !== "created" || attempt.binding.workflowHash !== workflow.workflowHash) throw new Error("DOCTOR_REPAIR_ATTEMPT_UNCONFIRMED");
  const location = doctorRepairLocation(campaignRoot, workflow.doctor, attempt.binding.incidentId, attempt.actionId);
  if (sha256(pathKey(realpathSync(location.root))) !== attempt.rootHash || attempt.baseCommit !== workflow.doctor.baseCommit ||
    pathKey(doctorGit(location.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()) !==
    pathKey(doctorGit(location.source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim())) throw new Error("DOCTOR_REPAIR_ATTEMPT_CONFLICT");
  const itemId = doctorRepairItemId(attempt.binding.incidentId, attempt.actionId);
  const directory = path.join(campaignRoot, ".supervised-worker", "handoffs", sha256(itemId));
  return { ...location, source: { sourceRoot: location.root, baseCommit: attempt.baseCommit },
    contractPath: path.join(directory, "build-contract.json"), buildPath: path.join(directory, "build-report.json"),
    reviewPath: path.join(directory, "review-report.json") };
}

function handoff(root, file) {
  const checked = inspectHandoffFile(root, file);
  if (!checked.ok) throw new Error("DOCTOR_HANDOFF_INVALID");
  const bytes = readFileSync(file);
  if (sha256(bytes) !== checked.sha256) throw new Error("DOCTOR_HANDOFF_CHANGED");
  return { value: parseWorkflowJson(bytes), hash: checked.sha256 };
}

export function validateDoctorRepair(campaignRoot, workflow, intent, records) {
  const repair = selectDoctorEvidence(records, intent.inputHashes, "doctor-repair-attempt");
  const context = doctorEvidenceContext(campaignRoot, workflow, repair);
  const build = handoff(campaignRoot, context.buildPath);
  if (!build.value.checks.some((check) => check.command === "npm test" && check.outcome === "passed") ||
    !build.value.checks.some((check) => check.command === "npm run validate" && check.outcome === "passed")) throw new Error("DOCTOR_REQUIRED_CHECKS_MISSING");
  const verified = verifyBuildHandoff(campaignRoot, context.contractPath, context.buildPath, context.source);
  if (!verified.ok || verified.contractHash !== repair.contractHash || verified.buildReportHash !== build.hash) throw new Error("DOCTOR_BUILD_VERIFICATION_FAILED");
  const attempt = issueReviewAttempt(campaignRoot, context.contractPath, context.buildPath, context.source);
  if (!attempt.ok) throw new Error("DOCTOR_REVIEW_ISSUANCE_FAILED");
  return requireDoctor({ schemaVersion: 1, kind: "doctor-validation", binding: intent.binding, actionId: intent.actionId,
    repairHash: doctorHash(repair), sourceRootHash: repair.rootHash, baseCommit: repair.baseCommit, tree: verified.stagedTreeHash,
    contractHash: verified.contractHash, buildReportHash: verified.buildReportHash, reviewAttemptId: attempt.reviewAttemptId, issuedAt: attempt.issuedAt }, "validation");
}

export function reviewDoctorRepair(campaignRoot, workflow, intent, records) {
  const validation = selectDoctorEvidence(records, intent.inputHashes, "doctor-validation");
  const repair = selectDoctorEvidence(records, [validation.repairHash], "doctor-repair-attempt");
  const context = doctorEvidenceContext(campaignRoot, workflow, repair);
  const review = handoff(campaignRoot, context.reviewPath);
  if (review.value.modelSeparation !== "different-family" || !review.value.modelResolution ||
    review.value.modelResolution.builder.family === review.value.modelResolution.reviewer.family ||
    review.value.reviewAttemptId !== validation.reviewAttemptId) throw new Error("DOCTOR_INDEPENDENT_REVIEW_REQUIRED");
  const verified = verifyHandoffChain(campaignRoot, context.contractPath, context.buildPath, context.reviewPath, context.source);
  if (!verified.ok || verified.stagedTreeHash !== validation.tree || verified.contractHash !== validation.contractHash ||
    verified.buildReportHash !== validation.buildReportHash || verified.reviewReportHash !== review.hash) throw new Error("DOCTOR_REVIEW_VERIFICATION_FAILED");
  return requireDoctor({ schemaVersion: 1, kind: "doctor-review", binding: intent.binding, actionId: intent.actionId,
    validationHash: doctorHash(validation), repairHash: doctorHash(repair), sourceRootHash: repair.rootHash, baseCommit: repair.baseCommit,
    tree: verified.stagedTreeHash, contractHash: verified.contractHash, buildReportHash: verified.buildReportHash,
    reviewReportHash: verified.reviewReportHash, reviewAttemptId: validation.reviewAttemptId }, "review");
}