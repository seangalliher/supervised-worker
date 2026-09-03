import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { atomicWriteJson, sha256, stateDirectory } from "./core.mjs";
import {
  LEGACY_DEFAULT_ROLES,
  parseWorkflowJson,
  resolveWorkflowRoles,
  WORKFLOW_CONFIG_PATH,
} from "./workflow.mjs";

export const MAX_HANDOFF_BYTES = 1_048_576;

const ARTIFACT_FILES = new Map([
  ["build-contract", "build-contract.json"],
  ["build-report", "build-report.json"],
  ["review-report", "review-report.json"],
]);
const ARTIFACT_FILE_NAMES = new Set(ARTIFACT_FILES.values());
const PROTECTED_ROOTS = new Set([".git", ".supervised-worker"]);
const HASH_RE = /^[0-9a-f]{64}$/;
const TREE_HASH_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ID_RE = /^[a-z0-9][a-z0-9.-]*$/;
const MODEL_ID_RE = /^[a-z0-9](?:[a-z0-9._:/-]{0,126}[a-z0-9])?$/;
const MODEL_FAMILY_RE = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const MODEL_RECEIPT_HOSTS = new Set([
  "vscode",
  "copilot-cli",
  "github-copilot-app",
  "copilot-cloud-agent",
]);
const REVIEW_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const REVIEW_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const REVIEW_ATTEMPT_KEYS = new Set([
  "schemaVersion",
  "itemId",
  "reviewAttemptId",
  "issuedAt",
  "contractHash",
  "buildReportHash",
  "stagedTreeHash",
]);
const WORKER_PRODUCERS = [
  "supervised-worker",
  "seangalliher-supervised-worker",
  "supervised-worker:supervised-worker",
  "supervised-worker:seangalliher-supervised-worker",
];

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isDateTime(value) {
  if (!nonBlank(value)) return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ];
  if (day < 1 || day > daysInMonth) return false;
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  return true;
}

function pathKey(value) {
  return value;
}

function isContained(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function directoryIdentityMatches(leftPath, rightPath, left, right) {
  if (leftPath === rightPath) return true;
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.ino !== 0n &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function sameDirectoryIdentity(leftPath, rightPath) {
  return directoryIdentityMatches(
    leftPath,
    rightPath,
    lstatSync(leftPath, { bigint: true }),
    lstatSync(rightPath, { bigint: true }),
  );
}

function unknownKeys(value, allowed, label, errors) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} contains unknown property: ${key}`);
  }
}

function requiredKeys(value, required, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) errors.push(`${label}.${key} is required`);
  }
  return true;
}

function stringArray(value, label, errors, { minimum = 0, unique = false } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  if (value.length < minimum) errors.push(`${label} must contain at least ${minimum} item(s)`);
  const valid = [];
  for (const [index, item] of value.entries()) {
    if (!nonBlank(item)) errors.push(`${label}[${index}] must be a non-empty string`);
    else valid.push(item);
  }
  if (unique && new Set(valid).size !== valid.length) errors.push(`${label} must contain unique values`);
  return valid;
}

function validateEvidence(value, label, errors) {
  const keys = new Set(["kind", "locator", "sha256"]);
  if (!requiredKeys(value, ["kind", "locator"], label, errors)) return;
  unknownKeys(value, keys, label, errors);
  if (!nonBlank(value.kind)) errors.push(`${label}.kind must be a non-empty string`);
  if (!nonBlank(value.locator)) errors.push(`${label}.locator must be a non-empty string`);
  if (value.sha256 !== undefined && !HASH_RE.test(value.sha256)) {
    errors.push(`${label}.sha256 must be a SHA-256 hash`);
  }
}

function evidenceArray(value, label, errors, minimum = 0) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }
  if (value.length < minimum) errors.push(`${label} must contain at least ${minimum} item(s)`);
  value.forEach((entry, index) => validateEvidence(entry, `${label}[${index}]`, errors));
}

function validateBlockedBy(value, label, errors) {
  if (!requiredKeys(value, ["boundary", "decision", "resumeWhen"], label, errors)) return;
  unknownKeys(value, new Set(["boundary", "decision", "resumeWhen"]), label, errors);
  for (const key of ["boundary", "decision", "resumeWhen"]) {
    if (!nonBlank(value[key])) errors.push(`${label}.${key} must be a non-empty string`);
  }
}

function assertExistingPathSafe(workspace, repositoryPath, label, errors) {
  const workspacePath = path.resolve(workspace);
  let workspaceReal;
  try {
    workspaceReal = realpathSync(workspacePath);
  } catch {
    errors.push(`${label} workspace cannot be resolved`);
    return;
  }
  let current = workspacePath;
  for (const segment of repositoryPath.split("/")) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      errors.push(`${label} cannot be resolved safely`);
      return;
    }
    if (stats.isSymbolicLink()) {
      errors.push(`${label} traverses a symbolic link or junction`);
      return;
    }
    if (stats.isFile() && stats.nlink > 1) {
      errors.push(`${label} targets a regular file with multiple hard links`);
      return;
    }
    try {
      const currentReal = realpathSync(current);
      if (!isContained(workspaceReal, currentReal)) {
        errors.push(`${label} resolves outside the workspace`);
        return;
      }
    } catch {
      errors.push(`${label} cannot be resolved safely`);
      return;
    }
  }
}

export function validateRepositoryPath(workspace, value, label = "path") {
  const errors = [];
  if (!nonBlank(value)) return [`${label} must be a non-empty string`];
  if (/\s/.test(value[0]) || /\s/.test(value.at(-1))) {
    errors.push(`${label} must not have leading or trailing whitespace`);
  }
  if (/[\x00-\x1f\x7f]/.test(value)) errors.push(`${label} contains a control character`);
  if (value.includes("\\")) errors.push(`${label} must use forward slashes`);
  if (value.includes(":")) errors.push(`${label} must not contain a drive or URI scheme`);
  if (value.startsWith("/")) errors.push(`${label} must be repository-relative`);
  if (/[*?{}\[\]]/.test(value)) errors.push(`${label} must identify one path, not a glob`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    errors.push(`${label} contains an empty or traversal segment`);
  }
  if (segments.some((segment) => /[. ]$/.test(segment))) {
    errors.push(`${label} contains a segment with a trailing dot or space`);
  }
  const firstSegment = segments[0]?.replace(/[. ]+$/g, "").toLowerCase();
  if (PROTECTED_ROOTS.has(firstSegment)) {
    errors.push(`${label} targets protected repository state`);
  }
  if (segments.map((segment) => segment.toLowerCase()).join("/") === WORKFLOW_CONFIG_PATH) {
    errors.push(`${label} targets protected role authority`);
  }
  if (errors.length === 0) assertExistingPathSafe(workspace, value, label, errors);
  return errors;
}

function validateCommon(value, expectedKind, producers, workflow, errors) {
  if (!isRecord(value)) return [`${expectedKind} must be an object`];
  if (![1, 2].includes(value.schemaVersion)) errors.push("schemaVersion must be 1 or 2");
  if (value.kind !== expectedKind) errors.push(`kind must be ${expectedKind}`);
  if (!nonBlank(value.itemId)) errors.push("itemId must be a non-empty string");
  if (!producers.includes(value.producedBy)) errors.push(`producedBy is invalid for ${expectedKind}`);
  const expectedWorkflowHash = workflow.configured ? workflow.workflowHash : null;
  const artifactWorkflowHash = value.schemaVersion === 1 ? null : value.workflowHash;
  if (value.schemaVersion === 1 && Object.hasOwn(value, "workflowHash")) {
    errors.push(`schemaVersion 1 ${expectedKind} cannot contain workflowHash`);
  }
  if (artifactWorkflowHash !== expectedWorkflowHash) {
    errors.push(`workflowHash does not match the accepted workflow for ${expectedKind}`);
  }
  if (!isDateTime(value.createdAt)) errors.push("createdAt must be an RFC 3339 date-time");
  return errors;
}

function companionProducers(workflow, role) {
  const producers = [workflow[role]];
  if (!workflow.configured) producers.push(LEGACY_DEFAULT_ROLES[role]);
  return [...new Set(producers)];
}

function validateBuildContract(value, workspace, roles) {
  const errors = [];
  const keys = new Set([
    "schemaVersion", "kind", "itemId", "producedBy", "workflowHash", "createdAt", "status", "premise",
    "objective", "authorityBoundaries", "options", "selectedApproach", "targetFiles",
    "consumers", "acceptanceCriteria", "focusedChecks", "broadGate", "exclusions", "blockedBy",
  ]);
  const required = [...keys].filter((key) => key !== "workflowHash" || value?.schemaVersion === 2);
  if (!requiredKeys(value, required, "build-contract", errors)) return errors;
  unknownKeys(value, keys, "build-contract", errors);
  validateCommon(
    value,
    "build-contract",
    [...WORKER_PRODUCERS, ...companionProducers(roles, "architect")],
    roles,
    errors,
  );
  if (!["approved", "escalation-required"].includes(value.status)) {
    errors.push("status must be approved or escalation-required");
  }
  if (requiredKeys(value.premise, ["claim", "evidence"], "premise", errors)) {
    unknownKeys(value.premise, new Set(["claim", "evidence"]), "premise", errors);
    if (!nonBlank(value.premise.claim)) errors.push("premise.claim must be a non-empty string");
    evidenceArray(value.premise.evidence, "premise.evidence", errors, 1);
  }
  if (!nonBlank(value.objective)) errors.push("objective must be a non-empty string");
  stringArray(value.authorityBoundaries, "authorityBoundaries", errors, { unique: true });
  if (!Array.isArray(value.options) || value.options.length === 0) {
    errors.push("options must be a non-empty array");
  } else {
    const ids = new Set();
    const ranks = new Set();
    value.options.forEach((option, index) => {
      const label = `options[${index}]`;
      if (!requiredKeys(option, ["id", "summary", "rank"], label, errors)) return;
      unknownKeys(option, new Set(["id", "summary", "rank"]), label, errors);
      if (!ID_RE.test(option.id ?? "")) errors.push(`${label}.id is invalid`);
      if (!nonBlank(option.summary)) errors.push(`${label}.summary must be non-empty`);
      if (!Number.isInteger(option.rank) || option.rank < 1) errors.push(`${label}.rank is invalid`);
      if (ids.has(option.id)) errors.push(`${label}.id duplicates an earlier option`);
      if (ranks.has(option.rank)) errors.push(`${label}.rank duplicates an earlier option`);
      ids.add(option.id);
      ranks.add(option.rank);
    });
  }
  const targetFiles = stringArray(value.targetFiles, "targetFiles", errors, { unique: true });
  targetFiles.forEach((file, index) => {
    errors.push(...validateRepositoryPath(workspace, file, `targetFiles[${index}]`));
  });
  stringArray(value.consumers, "consumers", errors, { unique: true });
  stringArray(value.acceptanceCriteria, "acceptanceCriteria", errors, { unique: true });
  stringArray(value.focusedChecks, "focusedChecks", errors, { unique: true });
  stringArray(value.exclusions, "exclusions", errors, { unique: true });
  if (value.status === "approved") {
    if (!nonBlank(value.selectedApproach)) errors.push("approved contract needs selectedApproach");
    else if (!value.options?.some((option) => option.id === value.selectedApproach)) {
      errors.push("selectedApproach must identify one declared option");
    }
    if (targetFiles.length === 0) errors.push("approved contract needs targetFiles");
    if (value.consumers?.length === 0) errors.push("approved contract needs consumers");
    if (value.acceptanceCriteria?.length === 0) errors.push("approved contract needs acceptanceCriteria");
    if (value.focusedChecks?.length === 0) errors.push("approved contract needs focusedChecks");
    if (!nonBlank(value.broadGate)) errors.push("approved contract needs broadGate");
    if (value.blockedBy !== null) errors.push("approved contract blockedBy must be null");
  }
  if (value.status === "escalation-required") {
    if (value.selectedApproach !== null) errors.push("escalation contract cannot select an approach");
    if (targetFiles.length !== 0) errors.push("escalation contract cannot authorize targetFiles");
    if (value.focusedChecks?.length !== 0) errors.push("escalation contract cannot authorize checks");
    if (value.broadGate !== null) errors.push("escalation contract broadGate must be null");
    validateBlockedBy(value.blockedBy, "blockedBy", errors);
  }
  return errors;
}

function validateCheck(value, label, errors) {
  if (!requiredKeys(value, ["command", "outcome", "evidence"], label, errors)) return;
  unknownKeys(value, new Set(["command", "outcome", "evidence"]), label, errors);
  if (!nonBlank(value.command)) errors.push(`${label}.command must be non-empty`);
  if (!["passed", "failed", "skipped"].includes(value.outcome)) errors.push(`${label}.outcome is invalid`);
  validateEvidence(value.evidence, `${label}.evidence`, errors);
}

function validateBuildReport(value, workspace, roles) {
  const errors = [];
  const keys = new Set([
    "schemaVersion", "kind", "itemId", "producedBy", "workflowHash", "createdAt", "status", "contractHash",
    "testedTreeHash", "changedFiles", "checks", "evidence", "deviations", "blocker",
  ]);
  const required = [...keys].filter((key) => key !== "workflowHash" || value?.schemaVersion === 2);
  if (!requiredKeys(value, required, "build-report", errors)) return errors;
  unknownKeys(value, keys, "build-report", errors);
  validateCommon(
    value,
    "build-report",
    [...WORKER_PRODUCERS, ...companionProducers(roles, "builder")],
    roles,
    errors,
  );
  if (!["implemented", "blocked"].includes(value.status)) errors.push("build-report status is invalid");
  if (!HASH_RE.test(value.contractHash ?? "")) errors.push("contractHash must be a SHA-256 hash");
  const changedFiles = stringArray(value.changedFiles, "changedFiles", errors, { unique: true });
  changedFiles.forEach((file, index) => {
    errors.push(...validateRepositoryPath(workspace, file, `changedFiles[${index}]`));
  });
  if (!Array.isArray(value.checks)) errors.push("checks must be an array");
  else {
    const commands = new Set();
    value.checks.forEach((check, index) => {
      validateCheck(check, `checks[${index}]`, errors);
      if (nonBlank(check?.command)) {
        if (commands.has(check.command)) errors.push(`checks[${index}].command duplicates an earlier check`);
        commands.add(check.command);
      }
    });
  }
  evidenceArray(value.evidence, "evidence", errors);
  stringArray(value.deviations, "deviations", errors, { unique: true });
  if (value.status === "implemented") {
    if (!TREE_HASH_RE.test(value.testedTreeHash ?? "")) {
      errors.push("implemented report testedTreeHash is invalid");
    }
    if (changedFiles.length === 0) errors.push("implemented report needs changedFiles");
    if (!value.checks?.length) errors.push("implemented report needs checks");
    if (value.checks?.some((check) => check.outcome !== "passed")) {
      errors.push("implemented report checks must all pass");
    }
    if (value.blocker !== null) errors.push("implemented report blocker must be null");
  }
  if (value.status === "blocked") {
    if (value.testedTreeHash !== null) errors.push("blocked report testedTreeHash must be null");
    if (!nonBlank(value.blocker)) errors.push("blocked report needs a blocker");
  }
  return errors;
}

function validateFinding(value, label, errors) {
  const keys = new Set(["severity", "summary", "consumer", "evidence", "blocksCommit"]);
  if (!requiredKeys(value, [...keys], label, errors)) return;
  unknownKeys(value, keys, label, errors);
  if (!["critical", "high", "medium", "low"].includes(value.severity)) {
    errors.push(`${label}.severity is invalid`);
  }
  if (!nonBlank(value.summary)) errors.push(`${label}.summary must be non-empty`);
  if (!nonBlank(value.consumer)) errors.push(`${label}.consumer must be non-empty`);
  evidenceArray(value.evidence, `${label}.evidence`, errors, 1);
  if (typeof value.blocksCommit !== "boolean") errors.push(`${label}.blocksCommit must be boolean`);
}

function modelReceiptLocator(itemId, role) {
  return `.supervised-worker/runtime/model-receipts/${sha256(itemId)}/${role}.json`;
}

function validateHostModelEvidence(value, itemId, role, label, errors) {
  if (!requiredKeys(value, ["kind", "locator", "sha256"], label, errors)) return;
  unknownKeys(value, new Set(["kind", "locator", "sha256"]), label, errors);
  if (value.kind !== "host-model") errors.push(`${label}.kind must be host-model`);
  if (value.locator !== modelReceiptLocator(itemId, role)) {
    errors.push(`${label}.locator does not match the canonical model receipt path`);
  }
  if (!HASH_RE.test(value.sha256 ?? "")) errors.push(`${label}.sha256 must be a SHA-256 hash`);
}

function validateModelIdentity(value, itemId, role, label, errors) {
  if (!requiredKeys(value, ["model", "family", "evidence"], label, errors)) return;
  unknownKeys(value, new Set(["model", "family", "evidence"]), label, errors);
  if (typeof value.model !== "string" || !MODEL_ID_RE.test(value.model)) {
    errors.push(`${label}.model is invalid`);
  }
  if (typeof value.family !== "string" || !MODEL_FAMILY_RE.test(value.family)) {
    errors.push(`${label}.family is invalid`);
  }
  validateHostModelEvidence(value.evidence, itemId, role, `${label}.evidence`, errors);
}

function validateModelResolution(value, itemId, errors) {
  if (!requiredKeys(value, ["builder", "reviewer"], "modelResolution", errors)) return;
  unknownKeys(value, new Set(["builder", "reviewer"]), "modelResolution", errors);
  validateModelIdentity(value.builder, itemId, "builder", "modelResolution.builder", errors);
  validateModelIdentity(value.reviewer, itemId, "reviewer", "modelResolution.reviewer", errors);
}

function validateReviewReport(value, roles) {
  const errors = [];
  const keys = new Set([
    "schemaVersion", "kind", "itemId", "producedBy", "workflowHash", "createdAt", "contractHash",
    "buildReportHash", "stagedTreeHash", "claimedBehavior", "consumers", "modelSeparation",
    "reviewAttemptId", "modelResolution", "verdict", "findings", "notChecked",
  ]);
  const required = [...keys].filter(
    (key) =>
      key !== "modelResolution" &&
      !(["workflowHash", "reviewAttemptId"].includes(key) && value?.schemaVersion !== 2),
  );
  if (!requiredKeys(value, required, "review-report", errors)) return errors;
  unknownKeys(value, keys, "review-report", errors);
  validateCommon(
    value,
    "review-report",
    companionProducers(roles, "reviewer"),
    roles,
    errors,
  );
  if (!HASH_RE.test(value.contractHash ?? "")) errors.push("contractHash must be a SHA-256 hash");
  if (!HASH_RE.test(value.buildReportHash ?? "")) errors.push("buildReportHash must be a SHA-256 hash");
  if (!TREE_HASH_RE.test(value.stagedTreeHash ?? "")) errors.push("stagedTreeHash is invalid");
  if (
    value.schemaVersion === 2 &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.reviewAttemptId ?? "",
    )
  ) {
    errors.push("reviewAttemptId is invalid");
  }
  if (!nonBlank(value.claimedBehavior)) errors.push("claimedBehavior must be non-empty");
  stringArray(value.consumers, "consumers", errors, { minimum: 1, unique: true });
  if (!["different-family", "same-family", "unknown"].includes(value.modelSeparation)) {
    errors.push("modelSeparation is invalid");
  }
  if (value.modelResolution !== undefined) {
    validateModelResolution(value.modelResolution, value.itemId, errors);
  }
  const reviewPolicy = roles.reviewPolicy ?? {};
  const modelPolicyActive = Boolean(
    reviewPolicy.requiredModel ||
    reviewPolicy.requiredModelFamily ||
    reviewPolicy.requireDifferentModelFamily,
  );
  if (modelPolicyActive && value.modelResolution === undefined) {
    errors.push("modelResolution is required by the accepted workflow");
  }
  if (value.modelResolution !== undefined) {
    const builderFamily = value.modelResolution?.builder?.family;
    const reviewerFamily = value.modelResolution?.reviewer?.family;
    if (value.modelSeparation === "different-family" && builderFamily === reviewerFamily) {
      errors.push("modelSeparation conflicts with identical resolved model families");
    }
    if (value.modelSeparation === "same-family" && builderFamily !== reviewerFamily) {
      errors.push("modelSeparation conflicts with different resolved model families");
    }
  }
  if (!["clean", "changes-required"].includes(value.verdict)) errors.push("verdict is invalid");
  if (!Array.isArray(value.findings)) errors.push("findings must be an array");
  else value.findings.forEach((finding, index) => validateFinding(finding, `findings[${index}]`, errors));
  stringArray(value.notChecked, "notChecked", errors, { unique: true });
  if (value.verdict === "clean" && value.findings?.length !== 0) {
    errors.push("clean review cannot contain findings");
  }
  if (value.verdict === "clean" && modelPolicyActive) {
    if (value.modelResolution?.reviewer?.model !== reviewPolicy.requiredModel) {
      errors.push("clean review did not use the workflow-required reviewer model");
    }
    if (value.modelResolution?.reviewer?.family !== reviewPolicy.requiredModelFamily) {
      errors.push("clean review did not use the workflow-required reviewer model family");
    }
    if (
      reviewPolicy.requireDifferentModelFamily &&
      value.modelSeparation !== "different-family"
    ) {
      errors.push("clean review requires a different Builder and Reviewer model family");
    }
  }
  if (value.verdict === "changes-required") {
    if (!value.findings?.length) errors.push("changes-required review needs findings");
    else if (!value.findings.some((finding) => finding.blocksCommit === true)) {
      errors.push("changes-required review needs a commit-blocking finding");
    }
  }
  return errors;
}

export function validateHandoffValue(value, workspace = process.cwd()) {
  if (!isRecord(value)) return ["handoff must be a JSON object"];
  const workflow = resolveWorkflowRoles(workspace, { requireAcceptance: true });
  if (!workflow.ok) return workflow.errors.map((error) => `workflow: ${error}`);
  const effectiveWorkflow = {
    ...workflow.roles,
    configured: workflow.configured,
    workflowHash: workflow.workflowHash,
    reviewPolicy: workflow.reviewPolicy,
  };
  if (value.kind === "build-contract") return validateBuildContract(value, workspace, effectiveWorkflow);
  if (value.kind === "build-report") return validateBuildReport(value, workspace, effectiveWorkflow);
  if (value.kind === "review-report") return validateReviewReport(value, effectiveWorkflow);
  return ["handoff kind is unsupported"];
}

export function validateModelReceiptValue(value) {
  const errors = [];
  const keys = new Set([
    "schemaVersion",
    "itemId",
    "role",
    "agentSelector",
    "model",
    "family",
    "workflowHash",
    "reviewAttemptId",
    "buildReportHash",
    "stagedTreeHash",
    "observedBy",
    "observedAt",
    "host",
    "sessionHash",
    "source",
  ]);
  if (!requiredKeys(value, [...keys], "model receipt", errors)) return errors;
  unknownKeys(value, keys, "model receipt", errors);
  if (value.schemaVersion !== 2) errors.push("model receipt schemaVersion must be 2");
  if (!nonBlank(value.itemId)) errors.push("model receipt itemId must be non-empty");
  if (!["builder", "reviewer"].includes(value.role)) errors.push("model receipt role is invalid");
  if (!nonBlank(value.agentSelector)) errors.push("model receipt agentSelector must be non-empty");
  if (typeof value.model !== "string" || !MODEL_ID_RE.test(value.model)) {
    errors.push("model receipt model is invalid");
  }
  if (typeof value.family !== "string" || !MODEL_FAMILY_RE.test(value.family)) {
    errors.push("model receipt family is invalid");
  }
  if (value.workflowHash !== null && !HASH_RE.test(value.workflowHash ?? "")) {
    errors.push("model receipt workflowHash must be null or a SHA-256 hash");
  }
  if (
    typeof value.reviewAttemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.reviewAttemptId,
    )
  ) {
    errors.push("model receipt reviewAttemptId is invalid");
  }
  if (!HASH_RE.test(value.buildReportHash ?? "")) {
    errors.push("model receipt buildReportHash is invalid");
  }
  if (!TREE_HASH_RE.test(value.stagedTreeHash ?? "")) {
    errors.push("model receipt stagedTreeHash is invalid");
  }
  if (!WORKER_PRODUCERS.includes(value.observedBy)) {
    errors.push("model receipt observedBy must identify the Supervised Worker");
  }
  if (!isDateTime(value.observedAt)) errors.push("model receipt observedAt must be RFC 3339");
  if (!MODEL_RECEIPT_HOSTS.has(value.host)) errors.push("model receipt host is invalid");
  if (!HASH_RE.test(value.sessionHash ?? "")) errors.push("model receipt sessionHash is invalid");
  if (value.source !== "host") errors.push("model receipt source must be host");
  return errors;
}

function reviewAttemptLocator(itemId) {
  return `.supervised-worker/runtime/review-attempts/${sha256(itemId)}.json`;
}

function validateReviewAttemptValue(value) {
  const errors = [];
  if (!requiredKeys(value, [...REVIEW_ATTEMPT_KEYS], "review attempt", errors)) return errors;
  unknownKeys(value, REVIEW_ATTEMPT_KEYS, "review attempt", errors);
  if (value.schemaVersion !== 1) errors.push("review attempt schemaVersion must be 1");
  if (!nonBlank(value.itemId)) errors.push("review attempt itemId must be non-empty");
  if (
    typeof value.reviewAttemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.reviewAttemptId,
    )
  ) {
    errors.push("review attempt reviewAttemptId is invalid");
  }
  if (!isDateTime(value.issuedAt)) errors.push("review attempt issuedAt must be RFC 3339");
  if (!HASH_RE.test(value.contractHash ?? "")) {
    errors.push("review attempt contractHash is invalid");
  }
  if (!HASH_RE.test(value.buildReportHash ?? "")) {
    errors.push("review attempt buildReportHash is invalid");
  }
  if (!TREE_HASH_RE.test(value.stagedTreeHash ?? "")) {
    errors.push("review attempt stagedTreeHash is invalid");
  }
  return errors;
}

function loadRuntimeJson(workspace, relativeParts, label) {
  const workspaceReal = realpathSync(path.resolve(workspace));
  const stateRoot = stateDirectory(workspaceReal);
  const runtimeRoot = path.join(stateRoot, "runtime");
  const filePath = path.join(runtimeRoot, ...relativeParts);
  const directories = [stateRoot, runtimeRoot];
  let current = runtimeRoot;
  for (const part of relativeParts.slice(0, -1)) {
    current = path.join(current, part);
    directories.push(current);
  }
  for (const candidate of [...directories, filePath]) {
    let stats;
    try {
      stats = lstatSync(candidate);
    } catch (error) {
      throw new Error(`${label} path is unavailable: ${error.message}`);
    }
    if (stats.isSymbolicLink()) throw new Error(`${label} path contains a link`);
    if (candidate !== filePath && !stats.isDirectory()) {
      throw new Error(`${label} path component is not a directory`);
    }
    if (candidate === filePath && (!stats.isFile() || stats.nlink > 1)) {
      throw new Error(`${label} is not a safe regular file`);
    }
    if (candidate === filePath && stats.size > MAX_HANDOFF_BYTES) {
      throw new Error(`${label} exceeds the size limit`);
    }
  }
  const resolved = realpathSync(filePath);
  if (!isContained(realpathSync(runtimeRoot), resolved)) {
    throw new Error(`${label} resolves outside the runtime root`);
  }
  const bytes = readFileSync(resolved);
  try {
    return { value: parseWorkflowJson(bytes), bytes };
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function loadReviewAttempt(workspace, itemId) {
  const loaded = loadRuntimeJson(
    workspace,
    ["review-attempts", `${sha256(itemId)}.json`],
    "review attempt",
  );
  const errors = validateReviewAttemptValue(loaded.value);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return loaded.value;
}

function loadModelReceipt(workspace, review, workflow, role, attempt, now) {
  const identity = review.modelResolution[role];
  const expectedLocator = modelReceiptLocator(review.itemId, role);
  if (identity.evidence.locator !== expectedLocator) {
    throw new Error(`${role} model receipt locator is not canonical`);
  }
  const { bytes, value } = loadRuntimeJson(
    workspace,
    ["model-receipts", sha256(review.itemId), `${role}.json`],
    `${role} model receipt`,
  );
  if (sha256(bytes) !== identity.evidence.sha256) {
    throw new Error(`${role} model receipt hash does not match the review report`);
  }
  const errors = validateModelReceiptValue(value);
  const expected = {
    itemId: review.itemId,
    role,
    agentSelector: workflow.roles[role],
    model: identity.model,
    family: identity.family,
    workflowHash: workflow.workflowHash,
    reviewAttemptId: review.reviewAttemptId,
    buildReportHash: review.buildReportHash,
    stagedTreeHash: review.stagedTreeHash,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) errors.push(`${role} model receipt ${key} does not match`);
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
  const observedAt = Date.parse(value.observedAt);
  if (observedAt > Date.parse(review.createdAt)) {
    throw new Error(`${role} model receipt observedAt is after the review report`);
  }
  if (observedAt > now + REVIEW_CLOCK_SKEW_MS) {
    throw new Error(`${role} model receipt observedAt is too far in the future`);
  }
  if (attempt && observedAt < Date.parse(attempt.issuedAt) - REVIEW_CLOCK_SKEW_MS) {
    throw new Error(`${role} model receipt observedAt is before the review attempt`);
  }
  return value;
}

function assertSafeArtifactPath(workspace, filePath) {
  const workspacePath = path.resolve(workspace);
  const requestedPath = path.resolve(workspacePath, filePath);
  let workspaceRealPath;
  try {
    workspaceRealPath = realpathSync(workspacePath);
  } catch {
    throw new Error("handoff workspace cannot be resolved safely");
  }

  const requestedItemPath = path.dirname(requestedPath);
  const requestedHandoffsPath = path.dirname(requestedItemPath);
  const requestedStatePath = path.dirname(requestedHandoffsPath);
  const requestedWorkspacePrefix = path.dirname(requestedStatePath);
  const requestedItemHash = path.basename(requestedItemPath);
  const requestedFileName = path.basename(requestedPath);
  if (
    path.basename(requestedStatePath) !== ".supervised-worker" ||
    path.basename(requestedHandoffsPath) !== "handoffs" ||
    !HASH_RE.test(requestedItemHash) ||
    !ARTIFACT_FILE_NAMES.has(requestedFileName)
  ) {
    throw new Error("handoff file path must be handoffs/<item-hash>/<artifact-name>");
  }
  let requestedWorkspaceRealPath;
  try {
    requestedWorkspaceRealPath = realpathSync(requestedWorkspacePrefix);
  } catch {
    throw new Error("handoff path prefix cannot be resolved safely");
  }
  if (!sameDirectoryIdentity(requestedWorkspaceRealPath, workspaceRealPath)) {
    throw new Error("handoff path prefix does not identify the active workspace");
  }

  const statePath = path.join(workspaceRealPath, ".supervised-worker");
  const handoffsPath = path.join(statePath, "handoffs");
  const itemPath = path.join(handoffsPath, requestedItemHash);
  const artifactPath = path.join(itemPath, requestedFileName);
  for (const [candidate, kind] of [
    [statePath, "directory"],
    [handoffsPath, "directory"],
    [itemPath, "directory"],
    [artifactPath, "file"],
  ]) {
    let stats;
    try {
      stats = lstatSync(candidate);
    } catch {
      throw new Error("handoff file does not exist or cannot be resolved safely");
    }
    if (stats.isSymbolicLink()) {
      throw new Error("handoff path contains a symbolic link or junction");
    }
    if (kind === "directory" && !stats.isDirectory()) {
      throw new Error("handoff path component is not a directory");
    }
    if (kind === "file" && !stats.isFile()) {
      throw new Error("handoff path is not a regular file");
    }
  }

  let resolved;
  let handoffsRealPath;
  try {
    resolved = realpathSync(requestedPath);
    handoffsRealPath = realpathSync(handoffsPath);
  } catch {
    throw new Error("handoff file does not exist or cannot be resolved safely");
  }
  if (!isContained(handoffsRealPath, resolved)) {
    throw new Error("handoff file is outside the handoff directory");
  }
  const resolvedRelative = path.relative(handoffsRealPath, resolved).split(path.sep);
  if (
    resolvedRelative.length !== 2 ||
    resolvedRelative[0] !== requestedItemHash ||
    resolvedRelative[1] !== requestedFileName
  ) {
    throw new Error("handoff resolved identity differs from the requested item and artifact");
  }
  const stats = lstatSync(artifactPath);
  if (stats.nlink > 1) throw new Error("handoff artifact has multiple hard links");
  if (stats.size > MAX_HANDOFF_BYTES) throw new Error("handoff file exceeds the size limit");
  return { resolved, itemHash: requestedItemHash, fileName: requestedFileName };
}

function loadHandoffFile(workspace, filePath, expectedKind = null) {
  const safe = assertSafeArtifactPath(workspace, filePath);
  const bytes = readFileSync(safe.resolved);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { value: null, hash: sha256(bytes), errors: ["handoff file is not valid JSON"], ...safe };
  }
  const errors = validateHandoffValue(value, workspace);
  if (expectedKind && value.kind !== expectedKind) errors.push(`handoff kind must be ${expectedKind}`);
  const expectedName = ARTIFACT_FILES.get(value.kind);
  if (expectedName && safe.fileName !== expectedName) errors.push(`handoff file name must be ${expectedName}`);
  if (nonBlank(value.itemId) && safe.itemHash !== sha256(value.itemId)) {
    errors.push("handoff directory does not match sha256(itemId)");
  }
  return { value, hash: sha256(bytes), errors, ...safe };
}

export function inspectHandoffFile(workspace, filePath) {
  try {
    const result = loadHandoffFile(workspace, filePath);
    return {
      ok: result.errors.length === 0,
      kind: result.value?.kind ?? null,
      itemId: result.value?.itemId ?? null,
      sha256: result.hash,
      errors: result.errors,
    };
  } catch (error) {
    return { ok: false, kind: null, itemId: null, sha256: null, errors: [error.message] };
  }
}

function setEquals(left, right) {
  if (left.size !== right.size) return false;
  return [...left].every((value) => right.has(value));
}

function resolveGitExecutable(workspace) {
  const workspaceReal = realpathSync(path.resolve(workspace));
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const executableName = process.platform === "win32" ? "git.exe" : "git";
  for (const rawEntry of pathValue.split(path.delimiter)) {
    const trimmed = rawEntry.trim();
    const entry = trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
    if (!path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, executableName);
    try {
      const resolved = realpathSync(candidate);
      if (!lstatSync(resolved).isFile() || isContained(workspaceReal, resolved)) continue;
      return resolved;
    } catch {
      // Continue to the next absolute PATH entry.
    }
  }
  throw new Error("trusted Git executable is unavailable outside the workspace");
}

function runGit(workspace, args, encoding) {
  const workspaceReal = realpathSync(path.resolve(workspace));
  const executable = resolveGitExecutable(workspaceReal);
  return execFileSync(
    executable,
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-C",
      workspaceReal,
      ...args,
    ],
    { cwd: path.dirname(executable), encoding },
  );
}

function gitPaths(workspace, args) {
  const output = runGit(workspace, args, "buffer");
  return output.toString("utf8").split("\0").filter(Boolean).map((value) => value.replaceAll("\\", "/"));
}

function verifyBuildContext(workspace, contractPath, buildReportPath) {
  const errors = [];
  let contract;
  let build;
  try {
    contract = loadHandoffFile(workspace, contractPath, "build-contract");
    build = loadHandoffFile(workspace, buildReportPath, "build-report");
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
  errors.push(...contract.errors.map((error) => `contract: ${error}`));
  errors.push(...build.errors.map((error) => `build report: ${error}`));
  if (errors.length > 0) return { ok: false, errors };

  if (contract.value.status !== "approved") errors.push("contract must be approved before verification");
  if (build.value.status !== "implemented") errors.push("build report must be implemented before verification");
  if (contract.value.itemId !== build.value.itemId) errors.push("contract and build report item IDs must match");
  if (build.value.contractHash !== contract.hash) errors.push("build report contractHash does not match contract bytes");

  const targets = new Set(contract.value.targetFiles.map(pathKey));
  const changed = new Set(build.value.changedFiles.map(pathKey));
  for (const file of changed) {
    if (!targets.has(file)) errors.push(`build report changed file is outside targetFiles: ${file}`);
  }
  if (build.value.deviations.length > 0) {
    errors.push("implemented build report contains unapproved deviations");
  }
  const passedChecks = new Set(
    build.value.checks
      .filter((check) => check.outcome === "passed")
      .map((check) => check.command),
  );
  for (const command of [...contract.value.focusedChecks, contract.value.broadGate]) {
    if (!passedChecks.has(command)) errors.push(`required contract check did not pass: ${command}`);
  }

  let stagedTreeHash = null;
  try {
    stagedTreeHash = runGit(workspace, ["write-tree"], "utf8").trim();
    if (build.value.testedTreeHash !== stagedTreeHash) {
      errors.push("build report testedTreeHash does not match the current Git index");
    }
    const staged = new Set(
      gitPaths(workspace, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--cached",
        "--no-renames",
        "--name-only",
        "-z",
      ]).map(pathKey),
    );
    if (!setEquals(staged, changed)) errors.push("staged paths do not exactly match build report changedFiles");
    const unstaged = new Set(gitPaths(workspace, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
    ]).map(pathKey));
    if (unstaged.size > 0) errors.push("worktree contains unstaged tracked changes");
    const untracked = gitPaths(workspace, ["ls-files", "--others", "--exclude-standard", "-z"])
      .map(pathKey)
      .filter((file) => file !== ".supervised-worker" && !file.startsWith(".supervised-worker/"));
    if (untracked.length > 0) {
      errors.push("worktree contains untracked files outside .supervised-worker");
    }
  } catch {
    errors.push("Git staged state could not be verified");
  }

  return {
    ok: errors.length === 0,
    itemId: contract.value.itemId,
    contractHash: contract.hash,
    buildReportHash: build.hash,
    stagedTreeHash,
    errors,
    contract,
    build,
  };
}

export function verifyBuildHandoff(workspace, contractPath, buildReportPath) {
  const result = verifyBuildContext(workspace, contractPath, buildReportPath);
  return {
    ok: result.ok,
    itemId: result.itemId ?? null,
    contractHash: result.contractHash ?? null,
    buildReportHash: result.buildReportHash ?? null,
    stagedTreeHash: result.stagedTreeHash ?? null,
    errors: result.errors,
  };
}

export function issueReviewAttempt(workspace, contractPath, buildReportPath) {
  const result = verifyBuildContext(workspace, contractPath, buildReportPath);
  if (!result.ok) {
    return {
      ok: false,
      itemId: result.itemId ?? null,
      reviewAttemptId: null,
      issuedAt: null,
      contractHash: result.contractHash ?? null,
      buildReportHash: result.buildReportHash ?? null,
      stagedTreeHash: result.stagedTreeHash ?? null,
      locator: null,
      errors: result.errors,
    };
  }
  const attempt = {
    schemaVersion: 1,
    itemId: result.itemId,
    reviewAttemptId: randomUUID(),
    issuedAt: new Date().toISOString(),
    contractHash: result.contractHash,
    buildReportHash: result.buildReportHash,
    stagedTreeHash: result.stagedTreeHash,
  };
  const locator = reviewAttemptLocator(result.itemId);
  try {
    atomicWriteJson(
      workspace,
      path.join(path.resolve(workspace), ...locator.split("/")),
      attempt,
    );
  } catch (error) {
    return { ok: false, ...attempt, locator, errors: [error.message] };
  }
  return { ok: true, ...attempt, locator, errors: [] };
}

export function verifyHandoffChain(workspace, contractPath, buildReportPath, reviewReportPath) {
  const buildContext = verifyBuildContext(workspace, contractPath, buildReportPath);
  const errors = [...buildContext.errors];
  let review;
  try {
    review = loadHandoffFile(workspace, reviewReportPath, "review-report");
    errors.push(...review.errors.map((error) => `review report: ${error}`));
    if (review.value?.schemaVersion !== 2) {
      errors.push("final verification requires review-report schemaVersion 2");
    }
  } catch (error) {
    errors.push(error.message);
  }
  if (!buildContext.contract || !buildContext.build || !review?.value) {
    return { ok: false, errors };
  }

  const contract = buildContext.contract;
  const build = buildContext.build;
  if (contract.value.itemId !== review.value.itemId) errors.push("all handoff item IDs must match");
  if (review.value.contractHash !== contract.hash) {
    errors.push("review report contractHash does not match contract bytes");
  }
  if (review.value.buildReportHash !== build.hash) {
    errors.push("review report buildReportHash does not match build report bytes");
  }
  if (review.value.stagedTreeHash !== buildContext.stagedTreeHash) {
    errors.push("review stagedTreeHash does not match the current Git index");
  }
  if (!setEquals(new Set(contract.value.consumers), new Set(review.value.consumers))) {
    errors.push("review consumers do not match the build contract");
  }
  const now = Date.now();
  let attempt = null;
  if (review.value.schemaVersion === 2) {
    try {
      attempt = loadReviewAttempt(workspace, review.value.itemId);
      if (attempt.itemId !== review.value.itemId) {
        errors.push("review attempt itemId does not match the review report");
      }
      if (attempt.reviewAttemptId !== review.value.reviewAttemptId) {
        errors.push("review report does not match the current review attempt");
      }
      if (attempt.contractHash !== contract.hash) {
        errors.push("review attempt contractHash does not match contract bytes");
      }
      if (attempt.buildReportHash !== build.hash) {
        errors.push("review attempt buildReportHash does not match build report bytes");
      }
      if (attempt.stagedTreeHash !== buildContext.stagedTreeHash) {
        errors.push("review attempt stagedTreeHash does not match the current Git index");
      }
      const issuedAt = Date.parse(attempt.issuedAt);
      const reviewCreatedAt = Date.parse(review.value.createdAt);
      if (issuedAt > now + REVIEW_CLOCK_SKEW_MS) {
        errors.push("review attempt issuedAt is too far in the future");
      }
      if (now - issuedAt > REVIEW_ATTEMPT_MAX_AGE_MS + REVIEW_CLOCK_SKEW_MS) {
        errors.push("review attempt has expired");
      }
      if (reviewCreatedAt > now + REVIEW_CLOCK_SKEW_MS) {
        errors.push("review report createdAt is too far in the future");
      }
      if (reviewCreatedAt < issuedAt - REVIEW_CLOCK_SKEW_MS) {
        errors.push("review report createdAt is before the review attempt");
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  const workflow = resolveWorkflowRoles(workspace, { requireAcceptance: true });
  if (!workflow.ok) errors.push(...workflow.errors.map((error) => `workflow: ${error}`));
  const reviewPolicy = workflow.reviewPolicy ?? {};
  const modelPolicyActive = Boolean(
    reviewPolicy.requiredModel ||
    reviewPolicy.requiredModelFamily ||
    reviewPolicy.requireDifferentModelFamily,
  );
  if (workflow.ok && review.value.modelResolution !== undefined) {
    for (const role of ["builder", "reviewer"]) {
      try {
        loadModelReceipt(workspace, review.value, workflow, role, attempt, now);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }
  if (review.value.verdict !== "clean") errors.push("review verdict requires changes");

  return {
    ok: errors.length === 0,
    itemId: contract.value.itemId,
    contractHash: contract.hash,
    buildReportHash: build.hash,
    stagedTreeHash: buildContext.stagedTreeHash,
    verdict: review.value.verdict,
    errors,
  };
}
