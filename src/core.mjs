import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { parseWorkflowJson, WORKFLOW_CONFIG_PATH } from "./workflow.mjs";

export const STATE_DIRECTORY = ".supervised-worker";
export const PLAN_FILE = "plan.json";
export const MAX_SAME_PROGRESS_BLOCKS = 2;
export const MAX_PLAN_BYTES = 1_048_576;
export const MAX_TOOL_TARGETS = 256;
export const MAX_CHECKPOINT_BYTES = 262_144;
export const MAX_CHECKPOINT_REQUEST_BYTES = 8_192;
const MAX_CHECKPOINT_ITEMS = 4_096;
const MAX_CHECKPOINT_ORPHANS = 256;
const MAX_GIT_POINTER_BYTES = 4_096;
const MAX_SESSION_LOCATOR_BYTES = 4_096;
const SESSION_LOCK_WAIT_MS = 250;
const SESSION_LOCK_POLL_MS = 10;
const sessionLockWaitCell = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);
const WINDOWS_DRIVE_CHECK_TIMEOUT_MS = 500;
const WINDOWS_PATH_CHECK_BUDGET_MS = 1_500;
const MAX_WINDOWS_DRIVES_PER_OPERATION = 3;
const windowsLocalDriveCache = new Map();
let windowsSubstDrivesCache;
let windowsPathCheckDeadline = Number.POSITIVE_INFINITY;
let windowsCheckedDrives = new Set();
let windowsPathChecksMaySpawn = true;

const ITEM_STATUSES = new Set(["pending", "in_progress", "banked", "parked"]);
const PLAN_MODES = new Set(["active", "complete", "inactive"]);
const PLAN_KEYS = new Set(["schemaVersion", "mode", "goal", "items", "completion"]);
const ITEM_KEYS = new Set(["id", "title", "status", "resumeWhen"]);
const COMPLETION_KEYS = new Set(["enumeration", "evidence"]);
const ENUMERATION_KEYS = new Set(["status", "source", "checkedAt", "remainingActionable"]);
const EVIDENCE_KEYS = new Set(["kind", "locator", "sha256"]);
const SESSION_LOCATOR_KEYS = new Set([
  "schemaVersion",
  "sessionHash",
  "repositoryRoot",
  "repositoryRootHash",
  "generation",
  "status",
  "boundAt",
  "updatedAt",
]);
const SESSION_LOCATOR_STATUSES = new Set(["provisional", "active", "released"]);
const SESSION_MARKER_KEYS = new Set(["schemaVersion", "sessionHash", "firstBoundAt"]);
const ATTACHMENT_KEYS = new Set([
  "schemaVersion",
  "sessionHash",
  "status",
  "routeGeneration",
  "attachedAt",
  "updatedAt",
]);
const ATTACHMENT_V3_KEYS = new Set([...ATTACHMENT_KEYS, "claimGeneration", "checkpointHash"]);
const ATTACHMENT_STATUSES = new Set(["provisional", "active"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PLAN_WRITER_MATCHER =
  "Write|Edit|create|edit|apply_patch|create_file|str_replace_editor|insert|insert_edit_into_file|replace_string_in_file|multi_replace_string_in_file";
export const ALL_TOOL_MATCHER = ".*";
export const PLAN_WRITER_TOOLS = new Set(
  PLAN_WRITER_MATCHER.split("|").map((name) => name.toLowerCase()),
);
const PATH_KEYS = new Set(["filePath", "file_path", "path"]);
const RUN_LEDGER_MAX_FILES = 256;
const RUN_LEDGER_MAX_FILE_BYTES = 1_048_576;
const RUN_LEDGER_MAX_TOTAL_BYTES = 16_777_216;
const RUN_LEDGER_MAX_RECORD_BYTES = 16_384;
const RUN_LEDGER_FILE_PATTERN = /^[0-9a-f]{64}\.jsonl$/;
const RUN_LEDGER_COMMON_KEYS = new Set(["schemaVersion", "at", "event", "session"]);
const RUN_LEDGER_EVENT_FIELDS = new Map([
  ["plan_inactive", { required: [], optional: [] }],
  ["completion_verified", { required: ["planHash"], optional: [] }],
  ["completion_unverified_release", { required: ["progressHash", "reason"], optional: [] }],
  ["stop_blocked", {
    required: ["progressHash", "sameProgressBlocks", "totalBlocks"],
    optional: [],
  }],
  ["tool_started", {
    required: ["toolName", "operationId", "invocationHash", "routeGeneration", "claimGeneration"],
    optional: [],
  }],
  ["tool_completed", {
    required: ["toolName", "success"],
    optional: ["observationId", "operationId", "invocationHash", "routeGeneration", "claimGeneration"],
  }],
  ["checkpoint_persisted", {
    required: ["checkpointHash", "planHash", "attachmentHash", "routeGeneration", "claimGeneration"],
    optional: [],
  }],
  ["checkpoint_resumed", {
    required: ["checkpointHash", "planHash", "sourceSessionHash", "routeGeneration", "claimGeneration", "observationStatus", "observationReason"],
    optional: [],
  }],
  ["pre_compact", { required: ["trigger"], optional: [] }],
  ["provisional_claim_released", { required: [], optional: ["trigger"] }],
  ["ownership_cleanup_failed", { required: ["attemptedEvent"], optional: [] }],
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalPlanHash(plan) {
  return sha256(canonicalJson(plan));
}

export function stateDirectory(cwd) {
  return path.join(path.resolve(cwd), STATE_DIRECTORY);
}

export function planPath(cwd) {
  return path.join(stateDirectory(cwd), PLAN_FILE);
}

function isContained(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSafeStatePath(cwd, candidatePath) {
  const workspacePath = path.resolve(cwd);
  const targetPath = path.resolve(candidatePath);
  if (!isContained(workspacePath, targetPath)) {
    throw new Error("state path is outside the workspace");
  }
  const workspaceRealPath = realpathSync(workspacePath);
  let currentPath = workspacePath;
  const relative = path.relative(workspacePath, targetPath);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    let stats;
    try {
      stats = lstatSync(currentPath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") break;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error("state path contains a symbolic link or junction");
    }
    const currentRealPath = realpathSync(currentPath);
    if (!isContained(workspaceRealPath, currentRealPath)) {
      throw new Error("state path resolves outside the workspace");
    }
  }
  return targetPath;
}

function ensureSafeDirectory(cwd, directoryPath) {
  const safeDirectory = assertSafeStatePath(cwd, directoryPath);
  const workspacePath = path.resolve(cwd);
  let currentPath = workspacePath;
  for (const segment of path.relative(workspacePath, safeDirectory).split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    if (!existsSync(currentPath)) {
      try {
        mkdirSync(currentPath, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    assertSafeStatePath(cwd, currentPath);
    if (!lstatSync(currentPath).isDirectory()) {
      throw new Error("state directory component is not a directory");
    }
  }
  return safeDirectory;
}

export function atomicWriteJson(cwd, filePath, value) {
  const safePath = assertSafeStatePath(cwd, filePath);
  ensureSafeDirectory(cwd, path.dirname(safePath));
  assertSafeStatePath(cwd, safePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  assertSafeStatePath(cwd, temporaryPath);
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    assertSafeStatePath(cwd, path.dirname(safePath));
    assertSafeStatePath(cwd, safePath);
    renameSync(temporaryPath, safePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function readJson(cwd, filePath, maximumBytes = MAX_PLAN_BYTES) {
  const safePath = assertSafeStatePath(cwd, filePath);
  const stats = lstatSync(safePath);
  if (!stats.isFile()) throw new Error("state path is not a regular file");
  if (stats.size > maximumBytes) throw new Error("state file exceeds the size limit");
  return JSON.parse(readFileSync(safePath, "utf8"));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function unknownKeys(value, allowedKeys, label, errors) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) errors.push(`${label} contains unknown property: ${key}`);
  }
}

function isDateTime(value) {
  if (!nonEmptyString(value)) return false;
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

export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return ["plan must be a JSON object"];
  }
  unknownKeys(plan, PLAN_KEYS, "plan", errors);
  if (plan.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!PLAN_MODES.has(plan.mode)) {
    errors.push("mode must be active, complete, or inactive");
  }
  if (!nonEmptyString(plan.goal)) errors.push("goal must be a non-empty string");
  if (!Array.isArray(plan.items)) {
    errors.push("items must be an array");
  } else {
    const itemIds = new Set();
    for (const [index, item] of plan.items.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`items[${index}] must be an object`);
        continue;
      }
      unknownKeys(item, ITEM_KEYS, `items[${index}]`, errors);
      if (!nonEmptyString(item.id)) errors.push(`items[${index}].id is required`);
      if (!nonEmptyString(item.title)) errors.push(`items[${index}].title is required`);
      if (!ITEM_STATUSES.has(item.status)) {
        errors.push(`items[${index}].status is invalid`);
      }
      if (item.status === "parked" && !nonEmptyString(item.resumeWhen)) {
        errors.push(`items[${index}].resumeWhen is required when parked`);
      } else if (item.resumeWhen !== undefined && !nonEmptyString(item.resumeWhen)) {
        errors.push(`items[${index}].resumeWhen must be a non-empty string when present`);
      }
      if (nonEmptyString(item.id)) {
        if (itemIds.has(item.id)) errors.push(`items[${index}].id duplicates an earlier item`);
        itemIds.add(item.id);
      }
    }
  }
  if (plan.mode === "active" || plan.mode === "inactive") {
    if (plan.completion !== null) errors.push(`completion must be null when mode is ${plan.mode}`);
  } else if (plan.mode === "complete") {
    if (!plan.completion || typeof plan.completion !== "object" || Array.isArray(plan.completion)) {
      errors.push("completion must be an object when mode is complete");
    }
    if (Array.isArray(plan.items) && plan.items.some((item) =>
      item?.status === "pending" || item?.status === "in_progress")) {
      errors.push("complete plans cannot contain pending or in_progress items");
    }
  }
  if (plan.completion && typeof plan.completion === "object" && !Array.isArray(plan.completion)) {
    unknownKeys(plan.completion, COMPLETION_KEYS, "completion", errors);
    const enumeration = plan.completion.enumeration;
    if (!enumeration || typeof enumeration !== "object" || Array.isArray(enumeration)) {
      errors.push("completion.enumeration must be an object");
    } else {
      unknownKeys(enumeration, ENUMERATION_KEYS, "completion.enumeration", errors);
      if (enumeration.status !== "complete") {
        errors.push("completion.enumeration.status must be complete");
      }
      if (!nonEmptyString(enumeration.source)) {
        errors.push("completion.enumeration.source is required");
      }
      if (!isDateTime(enumeration.checkedAt)) {
        errors.push("completion.enumeration.checkedAt must be an RFC 3339 date-time");
      }
      if (enumeration.remainingActionable !== 0) {
        errors.push("completion.enumeration.remainingActionable must be 0");
      }
    }
    if (!Array.isArray(plan.completion.evidence) || plan.completion.evidence.length === 0) {
      errors.push("completion.evidence must be a non-empty array");
    } else {
      for (const [index, evidence] of plan.completion.evidence.entries()) {
        if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
          errors.push(`completion.evidence[${index}] must be an object`);
          continue;
        }
        unknownKeys(evidence, EVIDENCE_KEYS, `completion.evidence[${index}]`, errors);
        if (!nonEmptyString(evidence.kind)) {
          errors.push(`completion.evidence[${index}].kind is required`);
        }
        if (!nonEmptyString(evidence.locator)) {
          errors.push(`completion.evidence[${index}].locator is required`);
        }
        if (evidence.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(evidence.sha256)) {
          errors.push(`completion.evidence[${index}].sha256 is invalid`);
        }
      }
    }
  }
  return errors;
}

export function loadPlan(cwd) {
  const filePath = planPath(cwd);
  assertSafeStatePath(cwd, filePath);
  if (!existsSync(filePath)) return { exists: false, plan: null, errors: [] };
  try {
    const plan = readJson(cwd, filePath);
    return { exists: true, plan, errors: validatePlan(plan) };
  } catch {
    return { exists: true, plan: null, errors: ["plan cannot be parsed as valid bounded JSON"] };
  }
}

function isComplete(plan) {
  return plan?.mode === "complete" && validatePlan(plan).length === 0;
}

function sessionId(input) {
  const value = input?.session_id ?? input?.sessionId;
  return nonEmptyString(value) ? value : "unknown-session";
}

function sessionHash(input) {
  const value = sessionId(input);
  return value === "unknown-session" ? null : sha256(value);
}

function isVscodePayload(input) {
  return Object.hasOwn(input ?? {}, "hook_event_name") || Object.hasOwn(input ?? {}, "session_id");
}

function blockOutput(input, eventName, reason) {
  return {
    decision: "block",
    reason,
    ...(isVscodePayload(input)
      ? {
          hookSpecificOutput: {
            hookEventName: eventName,
            decision: "block",
            reason,
          },
        }
      : {}),
  };
}

function contextOutput(input, eventName, additionalContext) {
  return {
    additionalContext,
    ...(isVscodePayload(input)
      ? { hookSpecificOutput: { hookEventName: eventName, additionalContext } }
      : {}),
  };
}

function preToolDecision(input, decision, reason) {
  return {
    permissionDecision: decision,
    ...(reason ? { permissionDecisionReason: reason } : {}),
    ...(isVscodePayload(input)
      ? {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: decision,
            ...(reason ? { permissionDecisionReason: reason } : {}),
          },
        }
      : {}),
  };
}

function allowStopOutput(input, reason) {
  return {
    decision: "allow",
    reason,
    systemMessage: reason,
    ...(isVscodePayload(input)
      ? {
          hookSpecificOutput: {
            hookEventName: "Stop",
            decision: "allow",
            reason,
          },
        }
      : {}),
  };
}

function runtimeStatePath(cwd, input) {
  return path.join(stateDirectory(cwd), "runtime", `${sha256(sessionId(input))}.json`);
}

function attachmentPath(cwd) {
  return path.join(stateDirectory(cwd), "attachment.json");
}

function readAttachmentSnapshot(cwd) {
  const filePath = attachmentPath(cwd);
  assertSafeStatePath(cwd, filePath);
  if (!existsSync(filePath)) return null;
  const before = lstatSync(filePath, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size > BigInt(MAX_SESSION_LOCATOR_BYTES)
  ) {
    throw new Error("session attachment is not a bounded single-link file");
  }
  const descriptor = openSync(filePath, "r");
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameRunLedgerStats(before, opened)) {
      throw new Error("session attachment changed while opening");
    }
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    assertSafeStatePath(cwd, filePath);
    if (
      length !== Number(before.size) ||
      !sameRunLedgerStats(opened, fstatSync(descriptor, { bigint: true })) ||
      !sameRunLedgerStats(opened, lstatSync(filePath, { bigint: true }))
    ) {
      throw new Error("session attachment changed while reading");
    }
    const bytes = buffer.subarray(0, length);
    return { bytes, hash: sha256(bytes), dev: opened.dev, ino: opened.ino };
  } finally {
    closeSync(descriptor);
  }
}

function attachmentFromSnapshot(snapshot) {
  const attachment = parseWorkflowJson(snapshot.bytes);
  if (attachment?.schemaVersion === 1) {
    if (
      !exactObject(attachment, ["schemaVersion", "sessionHash", "attachedAt"]) ||
      !digest(attachment.sessionHash) ||
      !isDateTime(attachment?.attachedAt)
    ) {
      throw new Error("session attachment is invalid");
    }
    return {
      ...attachment,
      status: "active",
      routeGeneration: null,
      claimGeneration: null,
      checkpointHash: null,
    };
  }
  const version3 = attachment?.schemaVersion === 3;
  const allowedKeys = version3 ? ATTACHMENT_V3_KEYS : ATTACHMENT_KEYS;
  const checkpointed = version3 && attachment.status === "checkpointed";
  if (
    ![2, 3].includes(attachment?.schemaVersion) ||
    !attachment ||
    typeof attachment !== "object" ||
    Array.isArray(attachment) ||
    Object.keys(attachment).some((key) => !allowedKeys.has(key)) ||
    !digest(attachment?.sessionHash) ||
    !(ATTACHMENT_STATUSES.has(attachment.status) || checkpointed) ||
    !generation(attachment.routeGeneration) ||
    !isDateTime(attachment.attachedAt) ||
    !isDateTime(attachment.updatedAt) ||
    (version3 && (
      !(uuid(attachment.claimGeneration) ||
        (checkpointed && attachment.claimGeneration === null)) ||
      !(typeof attachment.checkpointHash === "string" &&
        /^[0-9a-f]{64}$/.test(attachment.checkpointHash) ||
        (!checkpointed && attachment.checkpointHash === null))
    ))
  ) {
    throw new Error("session attachment is invalid");
  }
  return version3 ? attachment : { ...attachment, claimGeneration: null, checkpointHash: null };
}

function readAttachment(cwd) {
  const snapshot = readAttachmentSnapshot(cwd);
  return snapshot === null ? null : attachmentFromSnapshot(snapshot);
}

function requireAttachmentSnapshot(cwd, expected) {
  const current = readAttachmentSnapshot(cwd);
  if (
    expected === null ||
    current === null ||
    current.hash !== expected.hash ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new Error("session attachment changed; retry only after inspecting current ownership");
  }
}

function removeAttachmentSnapshot(cwd, expected) {
  requireAttachmentSnapshot(cwd, expected);
  removeStateFile(cwd, attachmentPath(cwd));
}

function attachedRecord(cwd, input, routeGeneration = undefined, snapshot = undefined) {
  const expected = sessionHash(input);
  const attachment = expected === null || snapshot === null
    ? null
    : snapshot === undefined ? readAttachment(cwd) : attachmentFromSnapshot(snapshot);
  if (attachment?.sessionHash !== expected || !ATTACHMENT_STATUSES.has(attachment?.status)) return null;
  if (routeGeneration !== undefined && attachment.routeGeneration !== routeGeneration) return null;
  return attachment;
}

function isAttached(cwd, input) {
  return attachedRecord(cwd, input) !== null;
}

function pathNameEquals(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function pathIdentity(value) {
  const resolved = path.resolve(value);
  if (process.platform !== "win32") return resolved;
  return resolved
    .split(path.sep)
    .map((segment) => segment.replace(/[. ]+$/g, ""))
    .join(path.sep)
    .toLowerCase();
}

function sessionLocatorContext(input) {
  const transcriptPath = input?.transcript_path ?? input?.transcriptPath;
  const hash = sessionHash(input);
  if (
    !isFullyQualifiedRepositoryCwd(transcriptPath) ||
    !isLocalRepositoryPath(transcriptPath) ||
    hash === null
  ) return null;
  const resolvedTranscript = path.resolve(transcriptPath);
  if (!pathNameEquals(path.basename(resolvedTranscript), `${sessionId(input)}.jsonl`)) return null;
  const transcriptDirectory = path.dirname(resolvedTranscript);
  const copilotDirectory = path.dirname(transcriptDirectory);
  const storageRoot = path.dirname(copilotDirectory);
  if (
    !pathNameEquals(path.basename(transcriptDirectory), "transcripts") ||
    !pathNameEquals(path.basename(copilotDirectory), "GitHub.copilot-chat")
  ) {
    return null;
  }
  try {
    if (!lstatSync(resolvedTranscript).isFile()) return null;
    if (!lstatSync(transcriptDirectory).isDirectory()) return null;
    if (!lstatSync(copilotDirectory).isDirectory()) return null;
    if (!lstatSync(storageRoot).isDirectory()) return null;
    if (!lstatSync(path.join(storageRoot, "workspace.json")).isFile()) return null;
  } catch {
    return null;
  }
  return {
    storageRoot,
    directoryPath: path.join(storageRoot, "supervised-worker", "session-roots", hash),
    filePath: path.join(storageRoot, "supervised-worker", "session-roots", hash, "route.json"),
    markerPath: path.join(storageRoot, "supervised-worker", "session-bindings", `${hash}.json`),
  };
}

function acquireSessionLock(input, context = sessionLocatorContext(input)) {
  if (context === null) return null;
  const locksDirectory = path.join(context.storageRoot, "supervised-worker", "session-locks");
  const lockDirectory = path.join(locksDirectory, sessionHash(input));
  return acquireLifecycleLock(context.storageRoot, lockDirectory, "session");
}

function acquireLifecycleLock(storageRoot, lockDirectory, scope) {
  ensureSafeDirectory(storageRoot, path.dirname(lockDirectory));
  const token = randomUUID();
  const ownerPath = path.join(lockDirectory, `${token}.json`);
  assertSafeStatePath(storageRoot, lockDirectory);
  const deadline = performance.now() + SESSION_LOCK_WAIT_MS;
  let observedContention = false;
  while (true) {
    if (observedContention && performance.now() >= deadline) {
      throw new Error(`${scope} lifecycle lock is busy`);
    }
    try {
      mkdirSync(lockDirectory, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      observedContention = true;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`${scope} lifecycle lock is busy`);
      Atomics.wait(
        sessionLockWaitCell,
        0,
        0,
        Math.min(SESSION_LOCK_POLL_MS, remaining),
      );
    }
  }
  const directoryStats = lstatSync(lockDirectory, { bigint: true });
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    directoryStats.dev === 0n ||
    directoryStats.ino === 0n
  ) {
    throw new Error(`${scope} lifecycle lock identity is unavailable`);
  }
  writeFileSync(
    ownerPath,
    `${JSON.stringify({
      schemaVersion: 1,
      token,
      processId: process.pid,
      acquiredAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  let ownerFd = null;
  try {
    ownerFd = openSync(ownerPath, "r");
    const ownerStats = fstatSync(ownerFd, { bigint: true });
    const currentStats = lstatSync(lockDirectory, { bigint: true });
    const currentOwnerStats = lstatSync(ownerPath, { bigint: true });
    const entries = readdirSync(lockDirectory);
    const verifiedStats = lstatSync(lockDirectory, { bigint: true });
    const verifiedOwnerStats = lstatSync(ownerPath, { bigint: true });
    if (
      !currentStats.isDirectory() ||
      currentStats.isSymbolicLink() ||
      currentStats.dev !== directoryStats.dev ||
      currentStats.ino !== directoryStats.ino ||
      !verifiedStats.isDirectory() ||
      verifiedStats.isSymbolicLink() ||
      verifiedStats.dev !== directoryStats.dev ||
      verifiedStats.ino !== directoryStats.ino ||
      !ownerStats.isFile() ||
      ownerStats.dev === 0n ||
      ownerStats.ino === 0n ||
      !currentOwnerStats.isFile() ||
      currentOwnerStats.isSymbolicLink() ||
      currentOwnerStats.dev !== ownerStats.dev ||
      currentOwnerStats.ino !== ownerStats.ino ||
      !verifiedOwnerStats.isFile() ||
      verifiedOwnerStats.isSymbolicLink() ||
      verifiedOwnerStats.dev !== ownerStats.dev ||
      verifiedOwnerStats.ino !== ownerStats.ino ||
      entries.length !== 1 ||
      entries[0] !== path.basename(ownerPath)
    ) {
      throw new Error(`${scope} lifecycle lock identity changed during acquisition`);
    }
    return {
      storageRoot,
      lockDirectory,
      ownerPath,
      ownerFd,
      token,
      directoryDev: directoryStats.dev,
      directoryIno: directoryStats.ino,
      ownerDev: ownerStats.dev,
      ownerIno: ownerStats.ino,
    };
  } catch (error) {
    if (ownerFd !== null) closeSync(ownerFd);
    throw error;
  }
}

function lifecycleLockIdentityMatches(lock) {
  const stats = lstatSync(lock.lockDirectory, { bigint: true });
  return (
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    lock.directoryDev !== 0n &&
    lock.directoryIno !== 0n &&
    stats.dev === lock.directoryDev &&
    stats.ino === lock.directoryIno
  );
}

function lifecycleLockOwnerIdentityMatches(lock, ownerPath = lock.ownerPath) {
  const heldStats = fstatSync(lock.ownerFd, { bigint: true });
  const pathStats = lstatSync(ownerPath, { bigint: true });
  return (
    heldStats.isFile() &&
    heldStats.dev !== 0n &&
    heldStats.ino !== 0n &&
    heldStats.dev === lock.ownerDev &&
    heldStats.ino === lock.ownerIno &&
    pathStats.isFile() &&
    !pathStats.isSymbolicLink() &&
    pathStats.dev === heldStats.dev &&
    pathStats.ino === heldStats.ino
  );
}

function releaseLifecycleLock(lock) {
  if (lock === null) return;
  let activeOwnerFd = lock.ownerFd;
  let ownerFdOpen = true;
  try {
    if (!lifecycleLockIdentityMatches(lock) || !lifecycleLockOwnerIdentityMatches(lock)) return;
    const owner = readJson(lock.storageRoot, lock.ownerPath, MAX_SESSION_LOCATOR_BYTES);
    if (owner?.token !== lock.token || owner?.processId !== process.pid) return;
    if (!lifecycleLockIdentityMatches(lock) || !lifecycleLockOwnerIdentityMatches(lock)) return;
    const retiredDirectory = `${lock.lockDirectory}.${lock.token}.retired`;
    const retiredOwnerPath = path.join(retiredDirectory, path.basename(lock.ownerPath));
    assertSafeStatePath(lock.storageRoot, retiredDirectory);
    if (existsSync(retiredDirectory)) return;
    if (process.platform === "win32") {
      closeSync(activeOwnerFd);
      ownerFdOpen = false;
    }
    renameSync(lock.lockDirectory, retiredDirectory);
    if (process.platform === "win32") {
      activeOwnerFd = openSync(retiredOwnerPath, "r");
      ownerFdOpen = true;
    }
    const retiredLock = {
      ...lock,
      lockDirectory: retiredDirectory,
      ownerPath: retiredOwnerPath,
      ownerFd: activeOwnerFd,
    };
    if (
      !lifecycleLockIdentityMatches(retiredLock) ||
      !lifecycleLockOwnerIdentityMatches(retiredLock, retiredOwnerPath)
    ) return;
    const retiredOwner = readJson(
      lock.storageRoot,
      retiredOwnerPath,
      MAX_SESSION_LOCATOR_BYTES,
    );
    const entries = readdirSync(retiredDirectory);
    if (
      retiredOwner?.token !== lock.token ||
      retiredOwner?.processId !== process.pid ||
      entries.length !== 1 ||
      entries[0] !== path.basename(retiredOwnerPath) ||
      !lifecycleLockIdentityMatches(retiredLock) ||
      !lifecycleLockOwnerIdentityMatches(retiredLock, retiredOwnerPath)
    ) return;
    closeSync(activeOwnerFd);
    ownerFdOpen = false;
    removeStateFile(lock.storageRoot, retiredOwnerPath);
    if (!lifecycleLockIdentityMatches(retiredLock)) return;
    assertSafeStatePath(lock.storageRoot, retiredDirectory);
    rmdirSync(retiredDirectory);
  } catch {
    // An abandoned lock requires operator-confirmed cleanup.
  } finally {
    if (ownerFdOpen) {
      try {
        closeSync(activeOwnerFd);
      } catch {
        // The lock is already closed; no cleanup remains.
      }
    }
  }
}

function acquireRepositoryLocks(roots) {
  const canonicalRoots = new Map();
  for (const root of roots) {
    const canonicalRoot = realpathSync(path.resolve(root));
    if (!isFullyQualifiedRepositoryCwd(canonicalRoot) || !isLocalRepositoryPath(canonicalRoot)) {
      throw new Error("repository lifecycle lock requires a canonical local root");
    }
    canonicalRoots.set(pathIdentity(canonicalRoot), canonicalRoot);
  }
  const locks = [];
  try {
    for (const identity of [...canonicalRoots.keys()].sort()) {
      const root = canonicalRoots.get(identity);
      locks.push(acquireLifecycleLock(
        root,
        path.join(stateDirectory(root), "locks", "lifecycle"),
        "repository",
      ));
    }
    return locks;
  } catch (error) {
    for (const lock of locks.reverse()) releaseLifecycleLock(lock);
    throw error;
  }
}

function acquireHookRepositoryLocks(input, eventName, targets, cwd) {
  const routing = protectedTargetRouting(targets);
  if (routing.hasUnqualifiedTarget || routing.roots.length > 1) {
    throw new Error("protected edit must name one fully qualified repository");
  }
  const result = readSessionLocator(input);
  const candidateRoot = routing.roots[0] ?? result.locator?.repositoryRoot ?? cwd;
  const inputCwd = input?.cwd ?? cwd;
  const roots = result.exists ? [result.locator.repositoryRoot] : [];
  const inspectedTargets = completeToolTargetInspection(targets, candidateRoot);
  if (
    attachedRecord(candidateRoot, input) !== null ||
    (["PreToolUse", "PostToolUse"].includes(eventName) &&
      toolTouchesPlan(inspectedTargets, candidateRoot))
  ) {
    if (
      result.context === null &&
      !pathEquals(candidateRoot, inputCwd) &&
      !pathsShareFilesystemIdentity(candidateRoot, inputCwd)
    ) {
      throw new Error("cross-directory hook routing requires a valid transcript anchor");
    }
    roots.push(candidateRoot);
  }
  if (
    routing.roots.length === 0 &&
    !pathEquals(candidateRoot, cwd) &&
    attachedRecord(cwd, input) !== null
  ) {
    roots.push(cwd);
  }
  return acquireRepositoryLocks(roots);
}

function readSessionMarker(context, input) {
  assertSafeStatePath(context.storageRoot, context.markerPath);
  if (!existsSync(context.markerPath)) return null;
  const marker = readJson(context.storageRoot, context.markerPath, MAX_SESSION_LOCATOR_BYTES);
  if (
    !marker ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    Object.keys(marker).some((key) => !SESSION_MARKER_KEYS.has(key)) ||
    marker.schemaVersion !== 1 ||
    marker.sessionHash !== sessionHash(input) ||
    !isDateTime(marker.firstBoundAt)
  ) {
    throw new Error("session repository binding marker is invalid");
  }
  return marker;
}

function ensureSessionMarker(context, input) {
  const existing = readSessionMarker(context, input);
  if (existing !== null) return existing;
  ensureSafeDirectory(context.storageRoot, path.dirname(context.markerPath));
  const marker = {
    schemaVersion: 1,
    sessionHash: sessionHash(input),
    firstBoundAt: new Date().toISOString(),
  };
  try {
    writeFileSync(context.markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return marker;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return readSessionMarker(context, input);
  }
}

function readSessionLocator(input, repairMarker = true) {
  const context = sessionLocatorContext(input);
  if (context === null) return { context: null, exists: false, locator: null };
  const marker = readSessionMarker(context, input);
  assertSafeStatePath(context.storageRoot, context.directoryPath);
  assertSafeStatePath(context.storageRoot, context.filePath);
  if (existsSync(context.filePath) && marker === null) {
    if (repairMarker) ensureSessionMarker(context, input);
    throw new Error("session repository binding marker is missing");
  }
  if (!existsSync(context.filePath)) {
    if (marker !== null || existsSync(context.directoryPath)) {
      throw new Error("session repository locator is missing");
    }
    return { context, exists: false, locator: null };
  }
  const locator = readJson(context.storageRoot, context.filePath, MAX_SESSION_LOCATOR_BYTES);
  if (
    !locator ||
    typeof locator !== "object" ||
    Array.isArray(locator) ||
    Object.keys(locator).some((key) => !SESSION_LOCATOR_KEYS.has(key)) ||
    locator.schemaVersion !== 2 ||
    locator.sessionHash !== sessionHash(input) ||
    !isFullyQualifiedRepositoryCwd(locator.repositoryRoot) ||
    !isLocalRepositoryPath(locator.repositoryRoot) ||
    locator.repositoryRootHash !== sha256(pathIdentity(locator.repositoryRoot)) ||
    !UUID_PATTERN.test(locator.generation ?? "") ||
    !SESSION_LOCATOR_STATUSES.has(locator.status) ||
    !isDateTime(locator.boundAt) ||
    !isDateTime(locator.updatedAt)
  ) {
    throw new Error("session repository locator is invalid");
  }
  return { context, exists: true, locator };
}

function preflightSessionLocatorLocality(input) {
  const context = sessionLocatorContext(input);
  if (context === null) return;
  try {
    assertSafeStatePath(context.storageRoot, context.filePath);
    if (!existsSync(context.filePath)) return;
    const candidate = readJson(context.storageRoot, context.filePath, MAX_SESSION_LOCATOR_BYTES);
    if (isFullyQualifiedRepositoryCwd(candidate?.repositoryRoot)) {
      isLocalRepositoryPath(candidate.repositoryRoot);
    }
  } catch {
    // Authoritative locator validation runs under the session lock.
  }
}

function bindSessionLocator(input, cwd) {
  const context = sessionLocatorContext(input);
  if (context === null) {
    const inputCwd = input?.cwd ?? cwd;
    if (!pathEquals(cwd, inputCwd) && !pathsShareFilesystemIdentity(cwd, inputCwd)) {
      throw new Error("cross-directory hook routing requires a valid transcript anchor");
    }
    return { bound: false, created: false, conflict: false };
  }
  ensureSessionMarker(context, input);
  const repositoryRoot = realpathSync(path.resolve(cwd));
  const now = new Date().toISOString();
  const record = {
    schemaVersion: 2,
    sessionHash: sessionHash(input),
    repositoryRoot,
    repositoryRootHash: sha256(pathIdentity(repositoryRoot)),
    generation: randomUUID(),
    status: "provisional",
    boundAt: now,
    updatedAt: now,
  };
  ensureSafeDirectory(context.storageRoot, context.directoryPath);
  assertSafeStatePath(context.storageRoot, context.filePath);
  try {
    writeFileSync(context.filePath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return { bound: true, created: true, conflict: false, generation: record.generation };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readSessionLocator(input).locator;
    if (!existing) throw new Error("session repository locator disappeared during claim");
    if (existing.status === "released") {
      const snapshot = readAttachmentSnapshot(existing.repositoryRoot);
      if (attachedRecord(existing.repositoryRoot, input, existing.generation, snapshot)) {
        removeAttachmentSnapshot(existing.repositoryRoot, snapshot);
      }
      atomicWriteJson(context.storageRoot, context.filePath, record);
      return { bound: true, created: true, conflict: false, generation: record.generation };
    }
    if (pathEquals(existing.repositoryRoot, repositoryRoot)) {
      if (readAttachment(existing.repositoryRoot) === null) {
        atomicWriteJson(context.storageRoot, context.filePath, record);
        return { bound: true, created: true, conflict: false, generation: record.generation };
      }
      return {
        bound: true,
        created: false,
        conflict: false,
        generation: existing.generation,
      };
    }
    return { bound: false, created: false, conflict: true };
  }
}

function updateSessionLocatorStatus(input, expectedCwd, generation, status, durable = false) {
  const result = readSessionLocator(input);
  if (result.context === null) return;
  if (
    !result.exists ||
    !pathEquals(result.locator.repositoryRoot, expectedCwd) ||
    result.locator.generation !== generation
  ) {
    throw new Error("session repository locator does not match the attachment generation");
  }
  if (result.locator.status === status) {
    if (durable) readBoundedStateBytes(result.context.storageRoot, result.context.filePath, MAX_SESSION_LOCATOR_BYTES, true);
    return;
  }
  if (result.locator.status === "released") {
    throw new Error("released session repository locator cannot be reactivated");
  }
  const updated = {
    ...result.locator,
    status,
    updatedAt: new Date().toISOString(),
  };
  if (durable) {
    durableWriteBytes(result.context.storageRoot, result.context.filePath,
      Buffer.from(`${JSON.stringify(updated, null, 2)}\n`), MAX_SESSION_LOCATOR_BYTES);
  } else atomicWriteJson(result.context.storageRoot, result.context.filePath, updated);
}

function bestEffortReleaseSessionLocator(input, expectedCwd, generation) {
  try {
    updateSessionLocatorStatus(input, expectedCwd, generation, "released");
  } catch {
    // A stale locator has no authority without the matching repository attachment.
  }
}

function attachedSessionRoot(input) {
  const result = readSessionLocator(input);
  if (!result.exists) return null;
  const snapshot = readAttachmentSnapshot(result.locator.repositoryRoot);
  const attachment = attachedRecord(
    result.locator.repositoryRoot,
    input,
    result.locator.generation,
    snapshot,
  );
  if (result.locator.status === "released") {
    if (attachment !== null) {
      removeAttachmentSnapshot(result.locator.repositoryRoot, snapshot);
    }
    return null;
  }
  if (attachment === null) {
    throw new Error("session repository locator has no matching attachment");
  }
  if (result.locator.status === "provisional" && attachment.status === "active") {
    updateSessionLocatorStatus(
      input,
      result.locator.repositoryRoot,
      result.locator.generation,
      "active",
    );
  }
  if (result.locator.status === "active" && attachment.status !== "active") {
    throw new Error("active session repository locator has a provisional attachment");
  }
  return result.locator.repositoryRoot;
}

function pathEquals(left, right) {
  return pathIdentity(left) === pathIdentity(right);
}

function toolTargetCandidates(input) {
  const rawToolName = input?.tool_name ?? input?.toolName ?? "";
  const toolName = rawToolName.toLowerCase().split(/[./]/).at(-1);
  if (!PLAN_WRITER_TOOLS.has(toolName)) {
    return [];
  }
  const toolInput = input?.tool_input ?? input?.toolArgs ?? input?.toolInput;
  const candidates = [];
  const candidateKeys = new Set();
  const addCandidate = (candidate) => {
    const key = process.platform === "win32"
      ? candidate.replaceAll("/", "\\").toLowerCase()
      : candidate;
    if (candidateKeys.has(key)) return;
    if (candidates.length >= MAX_TOOL_TARGETS) {
      throw new Error(`tool input exceeds the ${MAX_TOOL_TARGETS}-target limit`);
    }
    candidateKeys.add(key);
    candidates.push(candidate);
  };
  if (toolInput && typeof toolInput === "object") {
    const pending = [toolInput];
    const seen = new WeakSet();
    while (pending.length > 0) {
      const value = pending.pop();
      if (Array.isArray(value)) {
        if (seen.has(value)) continue;
        seen.add(value);
        for (const child of value) pending.push(child);
        continue;
      }
      if (!value || typeof value !== "object") continue;
      if (seen.has(value)) continue;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (PATH_KEYS.has(key) && typeof child === "string") addCandidate(child);
        else if (child && typeof child === "object") pending.push(child);
      }
    }
  }
  if (toolName === "apply_patch" || toolName === "edit") {
    const patchTexts = [
      typeof toolInput === "string" ? toolInput : null,
      toolInput?.input,
      toolInput?.patch,
      toolInput?.raw,
    ].filter((value) => typeof value === "string");
    for (const patchText of patchTexts) {
      for (const line of patchText.split(/\r?\n/)) {
        const fileHeader = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+?)\s*$/)?.[1];
        if (fileHeader) {
          for (const target of fileHeader.split(/\s+->\s+/)) addCandidate(target);
          continue;
        }
        const moveHeader = line.match(/^\*\*\* Move to:\s+(.+?)\s*$/)?.[1];
        if (moveHeader) addCandidate(moveHeader);
      }
    }
  }
  return candidates;
}

function normalizedPathSegment(segment) {
  return process.platform === "win32"
    ? segment.replace(/[. ]+$/g, "").toLowerCase()
    : segment;
}

function protectedMarkerIndex(segments) {
  for (const [index, segment] of segments.entries()) {
    const normalized = normalizedPathSegment(segment);
    if (normalized === normalizedPathSegment(STATE_DIRECTORY) || normalized === ".git") {
      return index;
    }
    if (
      normalized === ".github" &&
      normalizedPathSegment(segments[index + 1] ?? "") === "supervised-worker.json" &&
      index + 2 === segments.length
    ) {
      return index;
    }
  }
  return -1;
}

function repositoryRootFromProtectedTarget(candidate) {
  if (!isFullyQualifiedRepositoryCwd(candidate) || isWindowsDevicePath(candidate)) return null;
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  const segments = resolved
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  const markerIndex = protectedMarkerIndex(segments);
  if (markerIndex < 0) return null;
  return path.resolve(parsed.root, ...segments.slice(0, markerIndex));
}

function isProtectedTarget(candidate) {
  const segments = candidate.split(/[\\/]+/).filter(Boolean);
  return protectedMarkerIndex(segments) >= 0;
}

function inspectTargetCandidate(candidate, cwd = null) {
  if (isWindowsDevicePath(candidate)) {
    return {
      raw: candidate,
      qualified: false,
      lexical: candidate,
      canonical: candidate,
      unsafe: true,
      ancestorIdentities: new Set(),
    };
  }
  const qualified = isFullyQualifiedRepositoryCwd(candidate);
  if (!qualified && cwd === null) return { raw: candidate, qualified: false };
  if (qualified && !isLocalRepositoryPath(candidate)) {
    return {
      raw: candidate,
      qualified: true,
      lexical: candidate,
      canonical: candidate,
      unsafe: true,
      ancestorIdentities: new Set(),
    };
  }
  const lexical = path.resolve(qualified ? candidate : path.join(cwd, candidate));
  const canonical = canonicalizeDeepestExisting(lexical);
  return {
    raw: candidate,
    qualified,
    lexical,
    canonical: canonical.path,
    unsafe: canonical.unsafe ||
      canonical.ancestorIdentities.has("multi-linked-regular-file") ||
      canonical.ancestorIdentities.has("unresolvable-filesystem-identity"),
    ancestorIdentities: canonical.ancestorIdentities,
  };
}

function prepareToolTargets(input) {
  return toolTargetCandidates(input).map((candidate) => inspectTargetCandidate(candidate));
}

function completeToolTargetInspection(targets, cwd) {
  const completed = targets.map((target) =>
    target.lexical === undefined ? inspectTargetCandidate(target.raw, cwd) : target,
  );
  return { targets: completed, unsafe: completed.some((target) => target.unsafe) };
}

function protectedTargetRouting(targets) {
  const roots = [];
  let hasUnqualifiedTarget = false;
  for (const target of targets) {
    const candidate = target.raw;
    if (target.unsafe) continue;
    if (
      isProtectedTarget(candidate) &&
      !target.qualified &&
      !isWindowsDevicePath(candidate)
    ) {
      hasUnqualifiedTarget = true;
      continue;
    }
    const root = target.canonical === undefined
      ? null
      : repositoryRootFromProtectedTarget(target.canonical) ??
        repositoryRootFromProtectedTarget(target.lexical);
    if (root !== null && !roots.some((existing) => pathEquals(existing, root))) roots.push(root);
  }
  return { roots, hasUnqualifiedTarget };
}

function pathsShareFilesystemIdentity(left, right) {
  const leftRoot = canonicalizeDeepestExisting(left);
  const rightRoot = canonicalizeDeepestExisting(right);
  return leftRoot.exactExists &&
    rightRoot.exactExists &&
    leftRoot.selfIdentity !== null &&
    leftRoot.selfIdentity === rightRoot.selfIdentity;
}

function resolveHookCwd(input, targets, fallbackCwd) {
  const { roots: targetRoots, hasUnqualifiedTarget } = protectedTargetRouting(targets);
  if (hasUnqualifiedTarget) {
    throw new Error("protected edit target is not fully qualified");
  }
  if (targetRoots.length > 1) {
    throw new Error("one hook invocation targets protected paths in multiple repositories");
  }
  if (targetRoots.length === 1) {
    return targetRoots[0];
  }
  return attachedSessionRoot(input) ?? fallbackCwd;
}

function pathWithin(candidatePath, rootPath) {
  return isContained(pathIdentity(rootPath), pathIdentity(candidatePath));
}

function isWindowsDevicePath(value) {
  const normalized = value.replaceAll("/", "\\");
  return normalized.startsWith("\\\\?\\") ||
    normalized.startsWith("\\\\.\\") ||
    normalized.startsWith("\\??\\");
}

function isFullyQualifiedRepositoryCwd(value) {
  if (!nonEmptyString(value)) return false;
  if (process.platform !== "win32") return path.isAbsolute(value);
  if (isWindowsDevicePath(value)) return false;
  const normalized = value.replaceAll("/", "\\");
  return /^[A-Za-z]:\\/.test(normalized) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(normalized);
}

function scrubbedChildEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"].includes(key.toUpperCase()),
    ),
  );
}

function windowsSystemExecutable(name) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !/^[A-Za-z]:[\\/]/.test(systemRoot)) return null;
  return path.join(systemRoot, "System32", name);
}

function resetWindowsPathChecks() {
  windowsSubstDrivesCache = undefined;
  windowsLocalDriveCache.clear();
  windowsCheckedDrives = new Set();
  windowsPathChecksMaySpawn = true;
  windowsPathCheckDeadline = Date.now() + WINDOWS_PATH_CHECK_BUDGET_MS;
}

function windowsPathCheckTimeout() {
  return Math.max(
    0,
    Math.min(WINDOWS_DRIVE_CHECK_TIMEOUT_MS, windowsPathCheckDeadline - Date.now()),
  );
}

function windowsSubstDrives() {
  if (windowsSubstDrivesCache !== undefined) return windowsSubstDrivesCache;
  const executable = windowsSystemExecutable("subst.exe");
  if (executable === null) {
    windowsSubstDrivesCache = null;
    return windowsSubstDrivesCache;
  }
  const timeout = windowsPathCheckTimeout();
  if (timeout === 0) {
    windowsSubstDrivesCache = null;
    return windowsSubstDrivesCache;
  }
  const result = spawnSync(executable, [], {
    encoding: "utf8",
    env: scrubbedChildEnvironment(),
    timeout,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    windowsSubstDrivesCache = null;
    return windowsSubstDrivesCache;
  }
  windowsSubstDrivesCache = new Set(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Za-z]):\\:/)?.[1]?.toUpperCase())
      .filter(Boolean),
  );
  return windowsSubstDrivesCache;
}

function isLocalRepositoryPath(value) {
  if (process.platform !== "win32") return true;
  const normalized = value.replaceAll("/", "\\");
  if (normalized.startsWith("\\\\")) return false;
  const drive = normalized.match(/^([A-Za-z]):\\/)?.[1]?.toUpperCase();
  if (!drive) return false;
  const substDrives = windowsSubstDrives();
  if (substDrives === null || substDrives.has(drive)) return false;
  if (windowsLocalDriveCache.has(drive)) return windowsLocalDriveCache.get(drive);
  if (!windowsPathChecksMaySpawn) return false;
  if (windowsCheckedDrives.size >= MAX_WINDOWS_DRIVES_PER_OPERATION) return false;
  windowsCheckedDrives.add(drive);
  const executable = windowsSystemExecutable("net.exe");
  if (executable === null) return false;
  const timeout = windowsPathCheckTimeout();
  if (timeout === 0) return false;
  const result = spawnSync(executable, ["use", `${drive}:`], {
    encoding: "utf8",
    env: scrubbedChildEnvironment(),
    timeout,
    windowsHide: true,
  });
  const local = !result.error && result.status === 2;
  windowsLocalDriveCache.set(drive, local);
  return local;
}

function fileIdentity(stats) {
  const inode = stats.ino;
  if (inode === 0n) return null;
  return `${stats.dev}:${inode}`;
}

function canonicalizeDeepestExisting(candidatePath) {
  const unresolved = [];
  let current = path.resolve(candidatePath);
  while (true) {
    try {
      const stats = lstatSync(current, { bigint: true });
      if (stats.isSymbolicLink()) {
        try {
          const canonicalPath = path.resolve(realpathSync(current), ...unresolved);
          return {
            path: canonicalPath,
            unsafe: false,
            exactExists: unresolved.length === 0,
            selfIdentity: fileIdentity(lstatSync(canonicalPath, { bigint: true })),
            ancestorIdentities: existingAncestorIdentities(canonicalPath),
          };
        } catch {
          return pathInspectionFailure(current);
        }
      }
      const canonicalPath = path.resolve(realpathSync(current), ...unresolved);
      return {
        path: canonicalPath,
        unsafe: stats.isFile() && stats.nlink > 1n,
        exactExists: unresolved.length === 0,
        selfIdentity: unresolved.length === 0 ? fileIdentity(stats) : null,
        ancestorIdentities: existingAncestorIdentities(current),
      };
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        return pathInspectionFailure(current);
      }
      const parent = path.dirname(current);
      if (parent === current) return pathInspectionFailure(current);
      unresolved.unshift(path.basename(current));
      current = parent;
    }
  }
}

function pathInspectionFailure(candidatePath) {
  return {
    path: candidatePath,
    unsafe: true,
    exactExists: false,
    selfIdentity: null,
    ancestorIdentities: new Set(),
  };
}

function existingAncestorIdentities(candidatePath) {
  const identities = new Set();
  let current = path.resolve(candidatePath);
  while (true) {
    try {
      const stats = lstatSync(current, { bigint: true });
      const identity = fileIdentity(stats);
      if (identity) identities.add(identity);
      if (stats.isFile() && stats.nlink > 1n) identities.add("multi-linked-regular-file");
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        identities.add("unresolvable-filesystem-identity");
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return identities;
}

function targetWithin(target, rootPath, canonicalRoot) {
  return pathWithin(target.lexical, rootPath) ||
    (!target.unsafe && !canonicalRoot.unsafe && pathWithin(target.canonical, canonicalRoot.path)) ||
    (canonicalRoot.exactExists &&
      canonicalRoot.selfIdentity !== null &&
      target.ancestorIdentities.has(canonicalRoot.selfIdentity));
}

function readGitPointer(filePath, prefix = null) {
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile() || stats.size > MAX_GIT_POINTER_BYTES) return null;
  const text = readFileSync(filePath, "utf8");
  if (text.includes("\0")) return null;
  const value = prefix
    ? text.match(new RegExp(`^${prefix}: (.+?)(?:\\r?\\n)?$`))?.[1]
    : text.match(/^(.+?)(?:\r?\n)?$/)?.[1];
  if (!value) return null;
  return path.resolve(path.dirname(filePath), value);
}

function gitMetadataRoots(cwd) {
  const dotGit = path.join(path.resolve(cwd), ".git");
  const roots = [dotGit];
  let stats;
  try {
    stats = lstatSync(dotGit);
  } catch (error) {
    if (error?.code === "ENOENT") return roots;
    throw error;
  }
  if (!stats.isFile()) return roots;

  const gitDirectory = readGitPointer(dotGit, "gitdir");
  if (!gitDirectory) return roots;
  roots.push(gitDirectory);
  const commonDirectory = readGitPointer(path.join(gitDirectory, "commondir"));
  if (commonDirectory) roots.push(commonDirectory);
  return roots;
}

function toolTouchesPlan(inspectedTargets, cwd) {
  const root = planPath(cwd);
  const canonicalRoot = canonicalizeDeepestExisting(root);
  return inspectedTargets.targets.some((target) =>
    pathEquals(target.lexical, root) ||
    (!target.unsafe && !canonicalRoot.unsafe && pathEquals(target.canonical, canonicalRoot.path)),
  );
}

function toolTouchesState(inspectedTargets, cwd) {
  const root = stateDirectory(cwd);
  const canonicalRoot = canonicalizeDeepestExisting(root);
  return inspectedTargets.targets.some((target) =>
    targetWithin(target, root, canonicalRoot),
  );
}

function toolTouchesGitMetadata(inspectedTargets, cwd) {
  const roots = gitMetadataRoots(cwd).map((rootPath) => ({
    rootPath,
    canonicalRoot: canonicalizeDeepestExisting(rootPath),
  }));
  return roots.some(({ rootPath, canonicalRoot }) =>
    inspectedTargets.targets.some((target) => targetWithin(target, rootPath, canonicalRoot)),
  );
}

function toolTouchesWorkflowConfig(inspectedTargets, cwd) {
  const root = path.join(path.resolve(cwd), ...WORKFLOW_CONFIG_PATH.split("/"));
  const canonicalRoot = canonicalizeDeepestExisting(root);
  return inspectedTargets.targets.some((target) =>
    pathEquals(target.lexical, root) ||
    (!target.unsafe && !canonicalRoot.unsafe && pathEquals(target.canonical, canonicalRoot.path)),
  );
}

function promoteAttachment(cwd, input, routeGeneration) {
  const attachment = attachedRecord(cwd, input, routeGeneration);
  if (attachment === null) throw new Error("session attachment cannot be promoted");
  if (attachment.status === "active") return attachment;
  const promoted = {
    ...attachment,
    status: "active",
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(cwd, attachmentPath(cwd), promoted);
  return promoted;
}

function promoteSessionClaim(cwd, input, routeGeneration) {
  promoteAttachment(cwd, input, routeGeneration);
  if (routeGeneration !== null) {
    updateSessionLocatorStatus(input, cwd, routeGeneration, "active");
  }
}

function claimSession(cwd, input, promote = false) {
  const hash = sessionHash(input);
  if (hash === null) return { claimed: false, conflict: false };
  const filePath = attachmentPath(cwd);
  if (readAttachment(cwd)?.status === "checkpointed") {
    return { claimed: false, conflict: true, checkpointed: true };
  }
  const locatorClaim = bindSessionLocator(input, cwd);
  if (locatorClaim.conflict) {
    return { claimed: false, conflict: true, routingConflict: true };
  }
  try {
    assertSafeStatePath(cwd, filePath);
    ensureSafeDirectory(cwd, path.dirname(filePath));
  } catch (error) {
    if (locatorClaim.created) {
      bestEffortReleaseSessionLocator(input, cwd, locatorClaim.generation);
    }
    throw error;
  }
  const record = {
    schemaVersion: 3,
    sessionHash: hash,
    status: "provisional",
    routeGeneration: locatorClaim.generation ?? null,
    claimGeneration: randomUUID(),
    checkpointHash: null,
    attachedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let attachmentCreated = false;
  try {
    writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    attachmentCreated = true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      if (locatorClaim.created) {
        bestEffortReleaseSessionLocator(input, cwd, locatorClaim.generation);
      }
      throw error;
    }
    const existingSnapshot = readAttachmentSnapshot(cwd);
    const existing = existingSnapshot === null ? null : attachmentFromSnapshot(existingSnapshot);
    if (
      existing?.sessionHash === hash &&
      existing.routeGeneration === null &&
      record.routeGeneration !== null
    ) {
      const migrated = {
        schemaVersion: 3,
        sessionHash: hash,
        status: existing.status,
        routeGeneration: record.routeGeneration,
        claimGeneration: existing.claimGeneration ?? randomUUID(),
        checkpointHash: existing.checkpointHash,
        attachedAt: existing.attachedAt,
        updatedAt: new Date().toISOString(),
      };
      let migrationWritten = false;
      try {
        atomicWriteJson(cwd, filePath, migrated);
        migrationWritten = true;
        updateSessionLocatorStatus(input, cwd, record.routeGeneration, migrated.status);
        if (promote) promoteSessionClaim(cwd, input, record.routeGeneration);
      } catch (migrationError) {
        try {
          if (migrationWritten) {
            atomicWriteJson(cwd, filePath, JSON.parse(existingSnapshot.bytes.toString("utf8")));
          }
        } finally {
          if (locatorClaim.created) {
            bestEffortReleaseSessionLocator(input, cwd, locatorClaim.generation);
          }
        }
        throw migrationError;
      }
      return { claimed: true, conflict: false };
    }
    if (
      existing?.sessionHash !== hash ||
      existing.routeGeneration !== record.routeGeneration
    ) {
      if (locatorClaim.created) {
        bestEffortReleaseSessionLocator(input, cwd, locatorClaim.generation);
      }
      return { claimed: false, conflict: true };
    }
  }
  try {
    if (promote) promoteSessionClaim(cwd, input, record.routeGeneration);
    return { claimed: true, conflict: false };
  } catch (error) {
    if (attachmentCreated) removeStateFile(cwd, filePath);
    if (locatorClaim.created) {
      bestEffortReleaseSessionLocator(input, cwd, locatorClaim.generation);
    }
    throw error;
  }
}

function removeStateFile(cwd, filePath) {
  assertSafeStatePath(cwd, filePath);
  rmSync(filePath, { force: true });
}

function detachSession(cwd, input, snapshot = readAttachmentSnapshot(cwd)) {
  const attachment = attachedRecord(cwd, input, undefined, snapshot);
  if (attachment === null) return false;
  requireAttachmentSnapshot(cwd, snapshot);
  if (attachment.routeGeneration !== null) {
    updateSessionLocatorStatus(
      input,
      cwd,
      attachment.routeGeneration,
      "released",
    );
  }
  removeAttachmentSnapshot(cwd, snapshot);
  return true;
}

function appendLedger(cwd, input, event, detail = {}) {
  try {
    const directory = path.join(stateDirectory(cwd), "runs");
    ensureSafeDirectory(cwd, directory);
    const record = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      event,
      session: sessionHash(input) ?? sha256("unknown-session"),
      ...detail,
    };
    const filePath = path.join(directory, `${record.session}.jsonl`);
    assertSafeStatePath(cwd, filePath);
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

function readBoundedStateBytes(cwd, filePath, maximumBytes, flush = false) {
  assertSafeStatePath(cwd, filePath);
  const before = lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) {
    throw new Error("state file is not a bounded single-link regular file");
  }
  const descriptor = openSync(filePath, flush ? "r+" : "r");
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameRunLedgerStats(before, opened)) throw new Error("state file changed while opening");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (flush) fsyncSync(descriptor);
    assertSafeStatePath(cwd, filePath);
    if (
      length !== Number(before.size) ||
      !sameRunLedgerStats(opened, fstatSync(descriptor, { bigint: true })) ||
      !sameRunLedgerStats(opened, lstatSync(filePath, { bigint: true }))
    ) throw new Error("state file changed while reading");
    return { bytes: buffer.subarray(0, length), stats: opened };
  } finally {
    closeSync(descriptor);
  }
}

function durableWriteBytes(cwd, filePath, bytes, maximumBytes, immutable = false, suffix = null, beforePublish = null) {
  if (bytes.length > maximumBytes) throw new Error("durable state exceeds the size limit");
  assertSafeStatePath(cwd, filePath);
  ensureSafeDirectory(cwd, path.dirname(filePath));
  if (immutable && existsSync(filePath)) {
    if (!readBoundedStateBytes(cwd, filePath, maximumBytes, true).bytes.equals(bytes)) {
      throw new Error("immutable state already exists with different bytes");
    }
    return;
  }
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    writeFileSync(temporaryPath, suffix === null ? bytes : bytes.subarray(0, bytes.length - suffix.length), {
      mode: 0o600,
      flag: "wx",
    });
    if (suffix !== null) appendFileSync(temporaryPath, suffix);
    descriptor = openSync(temporaryPath, "r+");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (!readBoundedStateBytes(cwd, temporaryPath, maximumBytes).bytes.equals(bytes)) {
      throw new Error("durable state temporary read-back failed");
    }
    assertSafeStatePath(cwd, filePath);
    if (immutable && existsSync(filePath)) throw new Error("immutable state publication conflicted");
    if (beforePublish !== null) beforePublish();
    renameSync(temporaryPath, filePath);
    if (!readBoundedStateBytes(cwd, filePath, maximumBytes).bytes.equals(bytes)) {
      throw new Error("durable state publication read-back failed");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) removeStateFile(cwd, temporaryPath);
  }
}

function parseRunLedgerBytes(bytes, expectedSession) {
  if (bytes.length > RUN_LEDGER_MAX_FILE_BYTES) throw runLedgerFailure("run-ledger-limit-exceeded");
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) throw runLedgerFailure("run-ledger-invalid");
  const records = [];
  const canonicalRecords = new Set();
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const recordBytes = bytes.subarray(start, index);
    start = index + 1;
    if (recordBytes.length === 0) throw runLedgerFailure("run-ledger-invalid");
    if (recordBytes.length > RUN_LEDGER_MAX_RECORD_BYTES) throw runLedgerFailure("run-ledger-limit-exceeded");
    let record;
    try {
      record = parseWorkflowJson(recordBytes);
    } catch {
      throw runLedgerFailure("run-ledger-invalid");
    }
    requireRunLedgerRecord(record, expectedSession);
    const canonicalRecord = canonicalJson(record);
    if (canonicalRecords.has(canonicalRecord)) throw runLedgerFailure("run-ledger-invalid");
    canonicalRecords.add(canonicalRecord);
    records.push(record);
  }
  return records;
}

function readSessionLedger(cwd, hash, flush = false) {
  const filePath = path.join(stateDirectory(cwd), "runs", `${hash}.jsonl`);
  assertSafeStatePath(cwd, filePath);
  if (!existsSync(filePath)) return { bytes: Buffer.alloc(0), records: [], exists: false };
  const snapshot = readBoundedStateBytes(cwd, filePath, RUN_LEDGER_MAX_FILE_BYTES, flush);
  return { ...snapshot, records: parseRunLedgerBytes(snapshot.bytes, hash), exists: true };
}

function appendDurableLedger(cwd, input, event, detail, beforePublish = null) {
  const hash = sessionHash(input);
  if (hash === null) throw new Error("durable ledger requires a session identity");
  const snapshot = readSessionLedger(cwd, hash);
  const record = { schemaVersion: 1, at: new Date().toISOString(), event, session: hash, ...detail };
  requireRunLedgerRecord(record, hash);
  const suffix = Buffer.from(`${JSON.stringify(record)}\n`);
  const bytes = Buffer.concat([snapshot.bytes, suffix]);
  parseRunLedgerBytes(bytes, hash);
  durableWriteBytes(
    cwd, path.join(stateDirectory(cwd), "runs", `${hash}.jsonl`),
    bytes, RUN_LEDGER_MAX_FILE_BYTES, false, suffix, beforePublish,
  );
  return record;
}

function boundedToolName(input) {
  const name = input?.tool_name ?? input?.toolName;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(name) ? name : "unknown";
}

function invocationHash(input) {
  const hint = input?.tool_use_id ?? input?.toolUseId;
  if (
    typeof hint !== "string" || hint.length === 0 || Buffer.byteLength(hint) > 512 ||
    /[\x00-\x1f\x7f]/.test(hint) ||
    (input?.tool_use_id !== undefined && input?.toolUseId !== undefined && input.tool_use_id !== input.toolUseId)
  ) return null;
  return sha256(`supervised-worker-tool-invocation-v1\0${hint}`);
}

function sameClaim(record, attachment) {
  return record.session === attachment.sessionHash &&
    record.claimGeneration === attachment.claimGeneration && record.routeGeneration === attachment.routeGeneration;
}

function recordToolStart(cwd, input) {
  const snapshot = readAttachmentSnapshot(cwd);
  const attachment = attachedRecord(cwd, input, undefined, snapshot);
  if (attachment === null) return;
  appendDurableLedger(cwd, input, "tool_started", {
    toolName: boundedToolName(input),
    operationId: randomUUID(),
    invocationHash: invocationHash(input),
    routeGeneration: attachment.routeGeneration,
    claimGeneration: attachment.claimGeneration,
  }, () => requireAttachmentSnapshot(cwd, snapshot));
}

function recordToolCompletion(cwd, input, success) {
  const attachmentSnapshot = readAttachmentSnapshot(cwd);
  const attachment = attachedRecord(cwd, input, undefined, attachmentSnapshot);
  if (attachment === null) return true;
  try {
    const snapshot = readSessionLedger(cwd, attachment.sessionHash);
    const hintHash = invocationHash(input);
    const starts = hintHash === null ? [] : snapshot.records.filter((record) =>
      record.event === "tool_started" && record.invocationHash === hintHash);
    const operationId = starts.length === 1 && sameClaim(starts[0], attachment) ? starts[0].operationId : null;
    if (operationId !== null && snapshot.records.some((record) =>
      record.event === "tool_completed" && record.operationId === operationId &&
      record.invocationHash === hintHash && sameClaim(record, attachment))) return true;
    appendDurableLedger(cwd, input, "tool_completed", {
      toolName: boundedToolName(input), success, observationId: randomUUID(), operationId,
      invocationHash: hintHash, routeGeneration: attachment.routeGeneration, claimGeneration: attachment.claimGeneration,
    }, () => requireAttachmentSnapshot(cwd, attachmentSnapshot));
    return true;
  } catch {
    return false;
  }
}

function completionUncertain(input, eventName) {
  return contextOutput(input, eventName,
    "Supervised Worker could not persist tool completion. Its outcome remains unknown; inspect the side effect before continuing and do not replay the operation automatically.");
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}

function digest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function generation(value) {
  return value === null || (typeof value === "string" && UUID_PATTERN.test(value));
}

function uuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function boundedCounter(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function checkpointStopState(value) {
  return value === null || (exactObject(value, ["schemaVersion", "progressHash", "sameProgressBlocks", "totalBlocks"]) &&
    [1, 2].includes(value.schemaVersion) && digest(value.progressHash) &&
    boundedCounter(value.sameProgressBlocks) && boundedCounter(value.totalBlocks));
}

function validOperationContext(value) {
  if (!exactObject(value, ["status", "reason", "orphans", "uncorrelatedCompletions"])) return false;
  if (value.status === "unavailable") {
    return ["ledger-absent", "ledger-invalid", "inherited-observation-unavailable"].includes(value.reason) &&
      value.orphans === null && value.uncorrelatedCompletions === null;
  }
  if (value.status !== "observed" || value.reason !== null ||
    !boundedCounter(value.uncorrelatedCompletions) || !Array.isArray(value.orphans) ||
    value.orphans.length > MAX_CHECKPOINT_ORPHANS) return false;
  const identifiers = new Set();
  for (const operation of value.orphans) {
    if (!exactObject(operation, ["operationId", "sessionHash", "routeGeneration", "claimGeneration", "invocationHash", "toolName", "observationStatus"]) ||
      !uuid(operation.operationId) || !digest(operation.sessionHash) ||
      !generation(operation.routeGeneration) || !generation(operation.claimGeneration) ||
      !(operation.invocationHash === null || digest(operation.invocationHash)) ||
      typeof operation.toolName !== "string" || !/^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(operation.toolName) ||
      operation.observationStatus !== "outcome-unknown" || identifiers.has(operation.operationId)) return false;
    identifiers.add(operation.operationId);
  }
  return true;
}

export function validateCheckpoint(value) {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_CHECKPOINT_BYTES) return ["checkpoint exceeds the size limit"];
  } catch {
    return ["checkpoint must be bounded JSON"];
  }
  if (!exactObject(value, ["schemaVersion", "kind", "checkpointId", "createdAt", "planHash", "sessionHash", "routeGeneration", "claimGeneration", "attachmentHash", "ledgerPosition", "context"])) {
    return ["checkpoint must contain exactly the published fields"];
  }
  const errors = [];
  if (value.schemaVersion !== 1 || value.kind !== "session-checkpoint") errors.push("checkpoint kind or version is invalid");
  if (!uuid(value.checkpointId)) errors.push("checkpointId must be a UUID");
  if (!isDateTime(value.createdAt) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) {
    errors.push("createdAt must be a canonical RFC 3339 time");
  }
  for (const key of ["planHash", "sessionHash", "attachmentHash"]) {
    if (!digest(value[key])) errors.push(`${key} must be a SHA-256 digest`);
  }
  if (!generation(value.routeGeneration) || !generation(value.claimGeneration)) errors.push("checkpoint generations are invalid");
  const position = value.ledgerPosition;
  if (!exactObject(position, ["path", "byteOffset", "recordCount", "prefixHash"]) ||
    position.path !== `runs/${value.sessionHash}.jsonl` ||
    !boundedCounter(position.byteOffset, RUN_LEDGER_MAX_FILE_BYTES) ||
    !boundedCounter(position.recordCount, RUN_LEDGER_MAX_FILE_BYTES) || !digest(position.prefixHash) ||
    ((position.byteOffset === 0) !== (position.recordCount === 0)) ||
    (position.byteOffset === 0 && position.prefixHash !== sha256(Buffer.alloc(0)))) {
    errors.push("ledgerPosition must identify a bounded complete-record prefix");
  }
  const context = value.context;
  if (!exactObject(context, ["counts", "itemHashes", "stopState", "operations"])) {
    errors.push("context must contain exactly the published fields");
  } else {
    if (!exactObject(context.counts, [...ITEM_STATUSES]) ||
      !Object.values(context.counts).every((count) => boundedCounter(count, MAX_CHECKPOINT_ITEMS))) {
      errors.push("context counts are invalid");
    }
    if (!Array.isArray(context.itemHashes) || context.itemHashes.length > MAX_CHECKPOINT_ITEMS ||
      !context.itemHashes.every(digest) || new Set(context.itemHashes).size !== context.itemHashes.length) {
      errors.push("context item hashes are invalid");
    } else if (context.counts && Object.values(context.counts).reduce((total, count) => total + count, 0) !== context.itemHashes.length) {
      errors.push("context counts do not match its item hashes");
    }
    if (!checkpointStopState(context.stopState)) errors.push("context Stop state is invalid");
    if (!validOperationContext(context.operations)) errors.push("context operation observations are invalid");
  }
  return errors;
}

function checkpointFailure(reason) {
  throw Object.assign(new Error(reason), { checkpointReason: reason });
}

function requireSessionRequest(request, operation) {
  const binding = operation === "checkpoint" ? "attachmentHash" : "checkpointHash";
  try {
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_CHECKPOINT_REQUEST_BYTES) throw new Error();
    if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).some((key) => !["session_id", "transcript_path", "planHash", binding].includes(key)) ||
      !["session_id", "planHash", binding].every((key) => Object.hasOwn(request, key)) ||
      !nonEmptyString(request.session_id) || Buffer.byteLength(request.session_id) > 256 ||
      /[\x00-\x1f\x7f]/.test(request.session_id) || sessionHash(request) === null ||
      !digest(request.planHash) || !(digest(request[binding]) || (operation === "resume" && request[binding] === null)) ||
      (Object.hasOwn(request, "transcript_path") &&
        (typeof request.transcript_path !== "string" || Buffer.byteLength(request.transcript_path) > 4_096))) throw new Error();
  } catch {
    checkpointFailure(`${operation} request is invalid or exceeds the bounded JSON limit`);
  }
}

function withSessionLifecycle(cwd, request, operation, action) {
  requireSessionRequest(request, operation);
  let sessionLock = null;
  let repositoryLocks = [];
  try {
    if (process.platform === "win32") resetWindowsPathChecks();
    if (!isFullyQualifiedRepositoryCwd(cwd) || !isLocalRepositoryPath(cwd) ||
      !pathEquals(path.resolve(cwd), realpathSync(cwd))) {
      checkpointFailure(`${operation} requires a canonical local repository cwd`);
    }
    const root = realpathSync(cwd);
    const input = { ...request, cwd: root };
    preflightSessionLocatorLocality(input);
    const context = sessionLocatorContext(input);
    if (Object.hasOwn(request, "transcript_path")) {
      if (context === null || !pathEquals(context.storageRoot, realpathSync(context.storageRoot))) {
        checkpointFailure(`${operation} requires a valid canonical transcript anchor`);
      }
      assertSafeStatePath(context.storageRoot, input.transcript_path);
      assertSafeStatePath(context.storageRoot, path.join(context.storageRoot, "workspace.json"));
      if (lstatSync(input.transcript_path).nlink !== 1) checkpointFailure("transcript anchor must be a single-link file");
    }
    sessionLock = acquireSessionLock(input, context);
    const routing = readSessionLocator(input, false);
    if (routing.exists && !pathEquals(routing.locator.repositoryRoot, root)) {
      checkpointFailure(`${operation} session routing conflicts with the process cwd`);
    }
    windowsPathChecksMaySpawn = false;
    repositoryLocks = acquireRepositoryLocks([root]);
    const requireGuards = () => {
      for (const lock of [sessionLock, ...repositoryLocks].filter((value) => value !== null)) {
        if (!lifecycleLockIdentityMatches(lock) || !lifecycleLockOwnerIdentityMatches(lock)) {
          checkpointFailure("lifecycle lock ownership changed; no replacement owner may be modified");
        }
      }
    };
    requireGuards();
    return action(root, input, routing, requireGuards);
  } catch (error) {
    if (error?.checkpointReason) throw error;
    throw new Error(`${operation} could not confirm its local lifecycle state; inspect status, ledger integrity, and ownership before retrying`);
  } finally {
    for (const lock of repositoryLocks.reverse()) releaseLifecycleLock(lock);
    releaseLifecycleLock(sessionLock);
  }
}

function requireActivePlan(cwd, expectedHash) {
  const filePath = planPath(cwd);
  assertSafeStatePath(cwd, filePath);
  if (!existsSync(filePath)) checkpointFailure("checkpoint/resume requires an existing active incomplete plan");
  let plan;
  try {
    plan = parseWorkflowJson(readBoundedStateBytes(cwd, filePath, MAX_PLAN_BYTES).bytes);
  } catch {
    checkpointFailure("checkpoint/resume plan is not valid bounded JSON");
  }
  if (validatePlan(plan).length > 0 || plan.mode !== "active" || plan.completion !== null) {
    checkpointFailure("checkpoint/resume requires a valid active plan with completion null");
  }
  if (canonicalPlanHash(plan) !== expectedHash) checkpointFailure("checkpoint/resume plan hash is stale");
  if (plan.items.length > MAX_CHECKPOINT_ITEMS) checkpointFailure("checkpoint context item limit exceeded; no items were truncated");
  return plan;
}

function readStopSnapshot(cwd, hash) {
  const filePath = path.join(stateDirectory(cwd), "runtime", `${hash}.json`);
  assertSafeStatePath(cwd, filePath);
  if (!existsSync(filePath)) return null;
  let value;
  try {
    value = parseWorkflowJson(readBoundedStateBytes(cwd, filePath, MAX_SESSION_LOCATOR_BYTES).bytes);
  } catch {
    checkpointFailure("checkpoint Stop state is not valid bounded JSON; repair it explicitly");
  }
  if (!checkpointStopState(value) || value === null) checkpointFailure("checkpoint Stop state is invalid; repair it explicitly");
  return value;
}

function unavailableOperations(reason) {
  return { status: "unavailable", reason, orphans: null, uncorrelatedCompletions: null };
}

function inspectOperations(records, inherited = null) {
  if (inherited?.status === "unavailable" || records.some((record) =>
    record.event === "checkpoint_resumed" && record.observationStatus === "unavailable")) {
    return unavailableOperations("inherited-observation-unavailable");
  }
  const starts = records.filter((record) => record.event === "tool_started");
  const terminals = records.filter((record) => record.event === "tool_completed");
  const orphans = new Map((inherited?.orphans ?? []).map((operation) => [operation.operationId, operation]));
  const seenOperations = new Set();
  for (const start of starts) {
    if (seenOperations.has(start.operationId)) checkpointFailure("ledger contains duplicate operation identities");
    seenOperations.add(start.operationId);
    const matchingStarts = start.invocationHash === null ? [] : starts.filter((candidate) =>
      candidate.invocationHash === start.invocationHash && candidate.session === start.session);
    const matchingTerminals = terminals.filter((terminal) => terminal.operationId === start.operationId &&
      terminal.invocationHash === start.invocationHash && terminal.session === start.session &&
      terminal.claimGeneration === start.claimGeneration && terminal.routeGeneration === start.routeGeneration);
    if (matchingStarts.length === 1 && matchingTerminals.length === 1) continue;
    orphans.set(start.operationId, {
      operationId: start.operationId, sessionHash: start.session,
      routeGeneration: start.routeGeneration, claimGeneration: start.claimGeneration,
      invocationHash: start.invocationHash, toolName: start.toolName, observationStatus: "outcome-unknown",
    });
  }
  if (orphans.size > MAX_CHECKPOINT_ORPHANS) checkpointFailure("checkpoint orphan limit exceeded; no operations were truncated");
  return {
    status: "observed", reason: null, orphans: [...orphans.values()],
    uncorrelatedCompletions: (inherited?.uncorrelatedCompletions ?? 0) + terminals.filter((record) => !record.operationId).length,
  };
}

function checkpointContext(plan, stopState, operations) {
  return {
    counts: Object.fromEntries([...ITEM_STATUSES].map((status) => [status, plan.items.filter((item) => item.status === status).length])),
    itemHashes: plan.items.map((item) => sha256(item.id)),
    stopState,
    operations,
  };
}

function readCheckpointReceipt(cwd, hash) {
  const filePath = path.join(stateDirectory(cwd), "checkpoints", `${hash}.json`);
  let value;
  try {
    const snapshot = readBoundedStateBytes(cwd, filePath, MAX_CHECKPOINT_BYTES);
    if (sha256(snapshot.bytes) !== hash) checkpointFailure("checkpoint receipt byte hash does not match its reference");
    value = parseWorkflowJson(snapshot.bytes);
  } catch (error) {
    if (error?.checkpointReason) throw error;
    checkpointFailure("checkpoint receipt is unavailable or is not valid bounded JSON");
  }
  if (validateCheckpoint(value).length > 0) checkpointFailure("checkpoint receipt does not match its published schema");
  return value;
}

function requireCheckpointLedger(cwd, receipt, hash, flush = true) {
  let snapshot;
  try {
    snapshot = readSessionLedger(cwd, receipt.sessionHash, flush);
  } catch {
    checkpointFailure("checkpoint source ledger is corrupt, partial, unsafe, or exceeds its bound");
  }
  const position = receipt.ledgerPosition;
  const prefix = snapshot.bytes.subarray(0, position.byteOffset);
  if (!snapshot.exists || prefix.length !== position.byteOffset || sha256(prefix) !== position.prefixHash ||
    (prefix.length > 0 && parseRunLedgerBytes(prefix, receipt.sessionHash).length !== position.recordCount)) {
    checkpointFailure("checkpoint source ledger prefix does not match the receipt");
  }
  const event = snapshot.records[position.recordCount];
  if (event?.event !== "checkpoint_persisted" || event.checkpointHash !== hash ||
    event.planHash !== receipt.planHash || event.attachmentHash !== receipt.attachmentHash ||
    event.claimGeneration !== receipt.claimGeneration || event.routeGeneration !== receipt.routeGeneration) {
    checkpointFailure("checkpoint source ledger has no matching persistence event at its watermark");
  }
}

function requireSourceRoute(attachment, input, routing, allowReleased = false) {
  if (attachment.routeGeneration === null) {
    if (routing.exists && routing.locator.status !== "released") checkpointFailure("source attachment and session route disagree");
    return;
  }
  if (routing.context === null || !routing.exists || routing.locator.generation !== attachment.routeGeneration ||
    (!allowReleased && routing.locator.status !== "active")) {
    checkpointFailure("source ownership requires its matching active transcript route");
  }
}

function checkpointResult(cwd, hash, receipt) {
  return {
    status: "checkpointed", checkpointHash: hash, planHash: receipt.planHash,
    attachmentHash: readAttachmentSnapshot(cwd).hash, context: receipt.context,
  };
}

export function checkpointSession(cwd, request) {
  return withSessionLifecycle(cwd, request, "checkpoint", (root, input, routing, requireGuards) => {
    const plan = requireActivePlan(root, request.planHash);
    const snapshot = readAttachmentSnapshot(root);
    if (snapshot === null) checkpointFailure("checkpoint requires the current owning attachment");
    const attachment = attachmentFromSnapshot(snapshot);
    if (attachment.sessionHash !== sessionHash(input)) checkpointFailure("checkpoint session does not own the attachment");
    if (attachment.status === "checkpointed") {
      const receipt = readCheckpointReceipt(root, attachment.checkpointHash);
      if (receipt.attachmentHash !== request.attachmentHash || receipt.planHash !== request.planHash ||
        receipt.sessionHash !== attachment.sessionHash || receipt.routeGeneration !== attachment.routeGeneration ||
        receipt.claimGeneration !== attachment.claimGeneration) checkpointFailure("checkpoint retry does not match the source binding");
      requireCheckpointLedger(root, receipt, attachment.checkpointHash);
      requireSourceRoute(attachment, input, routing, true);
      requireGuards();
      requireAttachmentSnapshot(root, snapshot);
      if (attachment.routeGeneration !== null) updateSessionLocatorStatus(input, root, attachment.routeGeneration, "released", true);
      return checkpointResult(root, attachment.checkpointHash, receipt);
    }
    if (attachment.status !== "active" || snapshot.hash !== request.attachmentHash) {
      checkpointFailure("checkpoint requires an active owner and its exact current attachment hash");
    }
    requireSourceRoute(attachment, input, routing);
    let ledger;
    try {
      ledger = readSessionLedger(root, attachment.sessionHash, true);
    } catch {
      checkpointFailure("checkpoint source ledger is corrupt, partial, unsafe, or exceeds its bound");
    }
    let inherited = null;
    if (attachment.checkpointHash !== null) {
      const previous = readCheckpointReceipt(root, attachment.checkpointHash);
      requireCheckpointLedger(root, previous, attachment.checkpointHash);
      inherited = previous.context.operations;
    }
    const receipt = {
      schemaVersion: 1, kind: "session-checkpoint", checkpointId: randomUUID(), createdAt: new Date().toISOString(),
      planHash: request.planHash, sessionHash: attachment.sessionHash,
      routeGeneration: attachment.routeGeneration, claimGeneration: attachment.claimGeneration, attachmentHash: snapshot.hash,
      ledgerPosition: { path: `runs/${attachment.sessionHash}.jsonl`, byteOffset: ledger.bytes.length, recordCount: ledger.records.length, prefixHash: sha256(ledger.bytes) },
      context: checkpointContext(plan, readStopSnapshot(root, attachment.sessionHash), ledger.exists ? inspectOperations(ledger.records, inherited) : unavailableOperations("ledger-absent")),
    };
    if (validateCheckpoint(receipt).length > 0) checkpointFailure("checkpoint context exceeds its typed artifact limits");
    const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    const hash = sha256(bytes);
    const requireSource = () => {
      requireGuards();
      requireAttachmentSnapshot(root, snapshot);
      requireActivePlan(root, request.planHash);
    };
    durableWriteBytes(root, path.join(stateDirectory(root), "checkpoints", `${hash}.json`), bytes, MAX_CHECKPOINT_BYTES, true, null, requireSource);
    requireAttachmentSnapshot(root, snapshot);
    requireActivePlan(root, request.planHash);
    appendDurableLedger(root, input, "checkpoint_persisted", {
      checkpointHash: hash, planHash: receipt.planHash, attachmentHash: snapshot.hash,
      routeGeneration: attachment.routeGeneration, claimGeneration: attachment.claimGeneration,
    }, requireSource);
    requireCheckpointLedger(root, receipt, hash);
    requireAttachmentSnapshot(root, snapshot);
    const tombstone = {
      schemaVersion: 3, sessionHash: attachment.sessionHash, status: "checkpointed",
      routeGeneration: attachment.routeGeneration, claimGeneration: attachment.claimGeneration,
      checkpointHash: hash, attachedAt: attachment.attachedAt, updatedAt: new Date().toISOString(),
    };
    durableWriteBytes(root, attachmentPath(root), Buffer.from(`${JSON.stringify(tombstone, null, 2)}\n`), MAX_SESSION_LOCATOR_BYTES, false, null, requireSource);
    requireGuards();
    if (attachment.routeGeneration !== null) updateSessionLocatorStatus(input, root, attachment.routeGeneration, "released", true);
    return checkpointResult(root, hash, receipt);
  });
}

function restoreStopSnapshot(cwd, input, state) {
  const filePath = runtimeStatePath(cwd, input);
  assertSafeStatePath(cwd, filePath);
  if (state === null) {
    if (existsSync(filePath)) checkpointFailure("fresh successor has unexpected Stop state; inspect it before resuming");
    return;
  }
  if (existsSync(filePath)) {
    const existing = readStopSnapshot(cwd, sessionHash(input));
    if (canonicalJson(existing) !== canonicalJson(state)) checkpointFailure("fresh successor Stop state conflicts with the checkpoint");
    return;
  }
  durableWriteBytes(cwd, filePath, Buffer.from(`${JSON.stringify(state, null, 2)}\n`), MAX_SESSION_LOCATOR_BYTES);
}

function ownerlessContext(cwd, plan) {
  const ledger = summarizeRunLedger(cwd);
  let operations;
  if (ledger.status !== "available") {
    operations = unavailableOperations(ledger.reason === "run-ledger-absent" ? "ledger-absent" : "ledger-invalid");
  } else {
    const directory = path.join(stateDirectory(cwd), "runs");
    const records = readdirSync(directory).sort().flatMap((name) => readSessionLedger(cwd, name.slice(0, 64), true).records);
    if (summarizeRunLedger(cwd).hash !== ledger.hash) checkpointFailure("ownerless recovery ledger changed while observing it");
    operations = inspectOperations(records);
  }
  const states = new Map();
  const runtimeDirectory = path.join(stateDirectory(cwd), "runtime");
  assertSafeStatePath(cwd, runtimeDirectory);
  if (existsSync(runtimeDirectory)) {
    const names = readdirSync(runtimeDirectory).filter((name) => name.endsWith(".json"));
    if (names.length > RUN_LEDGER_MAX_FILES || names.some((name) => !/^[0-9a-f]{64}\.json$/.test(name))) {
      checkpointFailure("ownerless recovery Stop-state directory is invalid or exceeds its bound");
    }
    for (const name of names) {
      const state = readStopSnapshot(cwd, name.slice(0, 64));
      if (state !== null) states.set(canonicalJson(state), state);
    }
  }
  if (states.size > 1) checkpointFailure("ownerless recovery has ambiguous Stop state; inspect the prior sessions explicitly");
  return checkpointContext(plan, states.values().next().value ?? null, operations);
}

export function resumeSession(cwd, request) {
  return withSessionLifecycle(cwd, request, "resume", (root, input, routing, requireGuards) => {
    const plan = requireActivePlan(root, request.planHash);
    const snapshot = readAttachmentSnapshot(root);
    const existing = snapshot === null ? null : attachmentFromSnapshot(snapshot);
    let receipt = null;
    let context;
    if (request.checkpointHash === null) {
      if (existing !== null) checkpointFailure("ownerless recovery requires no attachment or checkpoint tombstone; never release an owner automatically");
      context = ownerlessContext(root, plan);
    } else {
      receipt = readCheckpointReceipt(root, request.checkpointHash);
      if (receipt.planHash !== request.planHash) checkpointFailure("resume plan hash does not match the checkpoint");
      const expectedContext = checkpointContext(plan, receipt.context.stopState, receipt.context.operations);
      if (canonicalJson(expectedContext.counts) !== canonicalJson(receipt.context.counts) ||
        canonicalJson(expectedContext.itemHashes) !== canonicalJson(receipt.context.itemHashes)) {
        checkpointFailure("resume checkpoint counts and item references do not match the unchanged plan");
      }
      if (receipt.sessionHash === sessionHash(input)) checkpointFailure("resume requires a fresh session distinct from the source");
      requireCheckpointLedger(root, receipt, request.checkpointHash);
      if (existing === null || existing.checkpointHash !== request.checkpointHash) checkpointFailure("resume requires the matching checkpoint tombstone or its exact successor");
      if (existing.status === "checkpointed") {
        if (existing.sessionHash !== receipt.sessionHash || existing.claimGeneration !== receipt.claimGeneration ||
          existing.routeGeneration !== receipt.routeGeneration) checkpointFailure("checkpoint tombstone source identity does not match its receipt");
      } else if (existing.status !== "active" || existing.sessionHash !== sessionHash(input)) {
        checkpointFailure("another session owns this checkpoint successor");
      }
      context = receipt.context;
    }
    let successor = existing?.status === "active" ? existing : null;
    if (successor !== null) {
      if (successor.routeGeneration !== null && (routing.context === null || !routing.exists ||
        routing.locator.generation !== successor.routeGeneration || routing.locator.status === "released")) {
        checkpointFailure("resume retry does not match the successor transcript route");
      }
    } else {
      if (routing.exists && !["released", "provisional"].includes(routing.locator.status)) {
        checkpointFailure("resume requires a fresh, interrupted provisional, or explicitly released successor session route");
      }
      restoreStopSnapshot(root, input, context.stopState);
      const route = bindSessionLocator(input, root);
      if (route.conflict) checkpointFailure("resume successor routing conflicts with current ownership");
      if (routing.context !== null) readBoundedStateBytes(routing.context.storageRoot, routing.context.filePath, MAX_SESSION_LOCATOR_BYTES, true);
      if (snapshot === null) {
        if (readAttachmentSnapshot(root) !== null) checkpointFailure("ownership appeared during ownerless recovery");
      } else requireAttachmentSnapshot(root, snapshot);
      requireActivePlan(root, request.planHash);
      successor = {
        schemaVersion: 3, sessionHash: sessionHash(input), status: "active",
        routeGeneration: route.generation ?? null, claimGeneration: randomUUID(), checkpointHash: request.checkpointHash,
        attachedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      durableWriteBytes(root, attachmentPath(root), Buffer.from(`${JSON.stringify(successor, null, 2)}\n`), MAX_SESSION_LOCATOR_BYTES, false, null, () => {
        requireGuards();
        if (snapshot === null) {
          if (readAttachmentSnapshot(root) !== null) checkpointFailure("ownership appeared during ownerless recovery");
        } else requireAttachmentSnapshot(root, snapshot);
        requireActivePlan(root, request.planHash);
      });
    }
    requireGuards();
    const successorSnapshot = readAttachmentSnapshot(root);
    if (successorSnapshot === null || canonicalJson(attachmentFromSnapshot(successorSnapshot)) !== canonicalJson(successor)) {
      checkpointFailure("successor ownership changed before route confirmation");
    }
    if (successor.routeGeneration !== null) updateSessionLocatorStatus(input, root, successor.routeGeneration, "active", true);
    const resumed = readSessionLedger(root, successor.sessionHash).records.filter((record) =>
      record.event === "checkpoint_resumed" && record.checkpointHash === request.checkpointHash &&
      record.planHash === request.planHash && sameClaim(record, successor));
    if (resumed.length > 1) checkpointFailure("successor ledger has ambiguous resume observations");
    if (resumed.length === 0) appendDurableLedger(root, input, "checkpoint_resumed", {
      checkpointHash: request.checkpointHash, planHash: request.planHash,
      sourceSessionHash: receipt?.sessionHash ?? successor.sessionHash,
      routeGeneration: successor.routeGeneration, claimGeneration: successor.claimGeneration,
      observationStatus: context.operations.status, observationReason: context.operations.reason,
    }, () => {
      requireGuards();
      requireAttachmentSnapshot(root, successorSnapshot);
    });
    const confirmed = readAttachment(root);
    if (canonicalJson(confirmed) !== canonicalJson(successor)) checkpointFailure("successor ownership changed during confirmation");
    requireActivePlan(root, request.planHash);
    return { status: "resumed", checkpointHash: request.checkpointHash, planHash: request.planHash,
      attachmentHash: readAttachmentSnapshot(root).hash, context };
  });
}

function stopReason(planResult) {
  if (planResult.errors.length > 0) {
    return "The durable Supervised Worker plan is invalid. Repair .supervised-worker/plan.json against the published schema, then continue the task.";
  }
  return "The durable plan is not complete. Continue the current queue without a status-only response. Bank the active item, re-enumerate the authoritative queue, and record complete enumeration plus evidence before stopping.";
}

function validRuntimeState(value) {
  return Boolean(
    value &&
      [1, 2].includes(value.schemaVersion) &&
      /^[0-9a-f]{64}$/.test(value.progressHash ?? "") &&
      Number.isInteger(value.sameProgressBlocks) &&
      value.sameProgressBlocks >= 0 &&
      Number.isInteger(value.totalBlocks) &&
      value.totalBlocks >= 0,
  );
}

function releaseStop(cwd, input, event, detail, output) {
  const intendedAttachment = readAttachmentSnapshot(cwd);
  try {
    removeStateFile(cwd, runtimeStatePath(cwd, input));
  } catch {
    // Runtime counters are recoverable; ownership cleanup remains authoritative.
  }
  try {
    if (!detachSession(cwd, input, intendedAttachment)) {
      throw new Error("expected attachment disappeared during Stop cleanup");
    }
    appendLedger(cwd, input, event, detail);
    return output;
  } catch {
    appendLedger(cwd, input, "ownership_cleanup_failed", { attemptedEvent: event });
    const reason =
      "Supervised Worker allowed Stop, but ownership cleanup failed. The durable claim may remain attached; do not rely on this run as queue completion or release.";
    return allowStopOutput(input, reason);
  }
}

function handleStop(input, cwd) {
  const attachment = attachedRecord(cwd, input);
  if (attachment === null) return {};
  const planResult = loadPlan(cwd);
  if (attachment.status === "provisional") {
    if (!planResult.exists) {
      const reason =
        "Supervised Worker released a provisional claim because its plan write did not complete. Do not rely on this run as queue completion.";
      return releaseStop(
        cwd,
        input,
        "provisional_claim_released",
        {},
        allowStopOutput(input, reason),
      );
    }
    promoteSessionClaim(cwd, input, attachment.routeGeneration);
  }
  if (!planResult.exists) {
    return releaseStop(cwd, input, "plan_inactive", {}, {});
  }
  if (planResult.errors.length === 0 && planResult.plan?.mode === "inactive") {
    return releaseStop(cwd, input, "plan_inactive", {}, {});
  }
  if (planResult.errors.length === 0 && isComplete(planResult.plan)) {
    return releaseStop(
      cwd,
      input,
      "completion_verified",
      { planHash: canonicalPlanHash(planResult.plan) },
      {},
    );
  }

  const filePath = runtimeStatePath(cwd, input);
  const progressHash = planResult.errors.length === 0
    ? canonicalPlanHash(planResult.plan)
    : sha256("invalid-plan");
  const legacyProgressHash = sha256(JSON.stringify(planResult.plan ?? planResult.errors));
  let state = {
    schemaVersion: 2,
    progressHash,
    sameProgressBlocks: 0,
    totalBlocks: 0,
  };
  assertSafeStatePath(cwd, filePath);
  const stateExists = existsSync(filePath);
  let stateWasInvalid = false;
  if (stateExists) {
    try {
      const candidate = readJson(cwd, filePath);
      if (validRuntimeState(candidate)) {
        state = candidate;
        if (state.schemaVersion === 1) {
          const legacyHashMismatch = state.progressHash !== legacyProgressHash;
          state.schemaVersion = 2;
          state.progressHash = progressHash;
          if (legacyHashMismatch) state.sameProgressBlocks = 0;
        }
      } else stateWasInvalid = true;
    } catch {
      stateWasInvalid = true;
    }
  }
  const recursiveStop = input?.stop_hook_active === true;
  if (recursiveStop && stateWasInvalid) {
    const reason =
      "Supervised Worker released the Stop gate because its bounded runtime state was invalid. The durable plan remains incomplete; do not rely on this run as queue completion.";
    return releaseStop(
      cwd,
      input,
      "completion_unverified_release",
      { progressHash, reason: "invalid_runtime_state" },
      allowStopOutput(input, reason),
    );
  }
  if (stateWasInvalid) {
    removeStateFile(cwd, filePath);
    state = {
      schemaVersion: 2,
      progressHash,
      sameProgressBlocks: 0,
      totalBlocks: 0,
    };
  }
  if (state.progressHash !== progressHash) {
    state.progressHash = progressHash;
    state.sameProgressBlocks = 0;
  }
  if (
    (recursiveStop && !stateExists) ||
    state.sameProgressBlocks >= MAX_SAME_PROGRESS_BLOCKS
  ) {
    const reason =
      "Supervised Worker released the Stop gate after its bounded retry limit. The durable plan remains incomplete; do not rely on this run as queue completion.";
    return releaseStop(
      cwd,
      input,
      "completion_unverified_release",
      { progressHash, reason: "bounded_stop_limit" },
      allowStopOutput(input, reason),
    );
  }
  state.sameProgressBlocks += 1;
  state.totalBlocks += 1;
  atomicWriteJson(cwd, filePath, state);
  appendLedger(cwd, input, "stop_blocked", {
    progressHash,
    sameProgressBlocks: state.sameProgressBlocks,
    totalBlocks: state.totalBlocks,
  });
  const reason =
    state.sameProgressBlocks >= MAX_SAME_PROGRESS_BLOCKS
      ? `${stopReason(planResult)} This is the final bounded continuation before an unchanged Stop is released. If no measurable progress is possible, the final response must state that queue completion remains unverified.`
      : stopReason(planResult);
  return blockOutput(input, "Stop", reason);
}

function handleHookUnsafe(input, eventName, cwd, inspectedTargets) {
  switch (eventName) {
    case "SessionStart": {
      if (!isAttached(cwd, input)) return {};
      const planResult = loadPlan(cwd);
      if (!planResult.exists) return {};
      if (planResult.errors.length > 0) {
        return contextOutput(
          input,
          "SessionStart",
          "The attached Supervised Worker plan is invalid. Repair .supervised-worker/plan.json against the published schema before continuing.",
        );
      }
      if (planResult.plan?.mode === "inactive") return {};
      const counts = Object.fromEntries(
        [...ITEM_STATUSES].map((status) => [
          status,
          planResult.plan?.items?.filter((item) => item.status === status).length ?? 0,
        ]),
      );
      return contextOutput(
        input,
        "SessionStart",
        `A durable Supervised Worker plan is active at .supervised-worker/plan.json. Counts: ${JSON.stringify(counts)}. Checkpoint observations: ${JSON.stringify(checkpointStatus(cwd))}. Read the plan and inspect outcome-unknown operations before continuing; never replay them automatically or infer completion from this summary.`,
      );
    }
    case "PreToolUse": {
      if (inspectedTargets.unsafe) {
        return preToolDecision(
          input,
          "deny",
          "Supervised Worker denied a file edit because its target path could not be resolved safely.",
        );
      }
      const touchesPlan = toolTouchesPlan(inspectedTargets, cwd);
      const touchesState = toolTouchesState(inspectedTargets, cwd);
      if (toolTouchesGitMetadata(inspectedTargets, cwd)) {
        return preToolDecision(
          input,
          "deny",
          "Supervised Worker denied a direct edit to Git metadata. Use reviewed Git commands from the owning worker instead.",
        );
      }
      if (toolTouchesWorkflowConfig(inspectedTargets, cwd)) {
        return preToolDecision(
          input,
          "deny",
          "Supervised Worker denied an agent file edit to human-managed .github/supervised-worker.json role authority.",
        );
      }
      if (!touchesState) return {};
      assertSafeStatePath(cwd, touchesPlan ? planPath(cwd) : stateDirectory(cwd));
      if (sessionHash(input) === null) {
        return preToolDecision(
          input,
          "deny",
          "Supervised Worker cannot establish durable-state ownership because this hook payload has no session identifier.",
        );
      }
      if (!touchesPlan) {
        if (!isAttached(cwd, input)) {
          return preToolDecision(
            input,
            "deny",
            "Only the session attached to .supervised-worker/plan.json may edit durable workflow state.",
          );
        }
        return {};
      }
      const claim = claimSession(cwd, input);
      if (claim.conflict) {
        return preToolDecision(
          input,
          "deny",
          claim.checkpointed
            ? "This durable plan is checkpointed. Use explicit checkpoint resumption; an ordinary plan write cannot acquire it."
            : claim.routingConflict
            ? "This Copilot session is already bound to a different repository's durable plan. Finish or release that campaign before writing another plan."
            : "Another Copilot session owns .supervised-worker/plan.json. Confirm that session is stale, then run the plugin helper's `release` command from this repository before retrying.",
        );
      }
      return {};
    }
    case "PostToolUse": {
      if (toolTouchesPlan(inspectedTargets, cwd)) {
        assertSafeStatePath(cwd, planPath(cwd));
        if (sessionHash(input) === null) {
          return contextOutput(
            input,
            "PostToolUse",
            "Supervised Worker could not attach this plan write because the hook payload had no session identifier. Do not rely on Stop governance for this run.",
          );
        }
        if (!existsSync(planPath(cwd))) {
          let completionPersisted = true;
          if (isAttached(cwd, input)) {
            const intendedAttachment = readAttachmentSnapshot(cwd);
            completionPersisted = recordToolCompletion(cwd, input, false);
            try {
              if (!detachSession(cwd, input, intendedAttachment)) {
                throw new Error("expected attachment disappeared during post-tool cleanup");
              }
            } catch {
              appendLedger(cwd, input, "ownership_cleanup_failed", {
                attemptedEvent: "provisional_claim_released",
              });
              return contextOutput(
                input,
                "PostToolUse",
                "The plan-targeting tool completed without materializing .supervised-worker/plan.json, but ownership cleanup failed. The provisional claim may remain attached; do not rely on this run as released.",
              );
            }
            appendLedger(cwd, input, "provisional_claim_released", {
              trigger: "missing_plan_after_post_tool",
            });
          }
          return contextOutput(
            input,
            "PostToolUse",
            "The plan-targeting tool completed without materializing .supervised-worker/plan.json. Supervised Worker released its provisional claim and did not record the write as successful." +
              (completionPersisted ? "" : " Tool completion persistence failed; its operation outcome remains unknown and must not be replayed automatically."),
          );
        }
        const claim = claimSession(cwd, input, true);
        if (claim.conflict) {
          return contextOutput(
            input,
            "PostToolUse",
            claim.routingConflict
              ? "Supervised Worker did not attach this plan because the session is already bound to another repository. Do not continue either campaign until ownership is resolved."
              : "Supervised Worker did not attach this session because another session owns the durable plan. Do not continue that campaign. Ask the user to run the plugin helper's `release` command from the target repository only after confirming the prior session is stale.",
          );
        }
      }
      if (!isAttached(cwd, input)) return {};
      if (!recordToolCompletion(cwd, input, true)) return completionUncertain(input, "PostToolUse");
      return {};
    }
    case "PostToolUseFailure": {
      if (!isAttached(cwd, input)) return {};
      const intendedAttachment = readAttachmentSnapshot(cwd);
      const completionPersisted = recordToolCompletion(cwd, input, false);
      if (toolTouchesPlan(inspectedTargets, cwd) && !existsSync(planPath(cwd))) {
        try {
          if (!detachSession(cwd, input, intendedAttachment)) {
            throw new Error("expected attachment disappeared during failure cleanup");
          }
        } catch {
          appendLedger(cwd, input, "ownership_cleanup_failed", {
            attemptedEvent: "provisional_claim_released",
          });
          return contextOutput(
            input,
            "PostToolUseFailure",
            "The plan write failed and ownership cleanup also failed. The provisional claim may remain attached; do not rely on this run as released.",
          );
        }
        appendLedger(cwd, input, "provisional_claim_released", {
          trigger: "post_tool_failure",
        });
      }
      return completionPersisted ? {} : completionUncertain(input, "PostToolUseFailure");
    }
    case "PreCompact":
      if (!isAttached(cwd, input)) return {};
      appendLedger(cwd, input, "pre_compact", {
        trigger: ["auto", "manual"].includes(input?.trigger) ? input.trigger : "unknown",
      });
      return {};
    case "Stop":
      return handleStop(input, cwd);
    default:
      return {};
  }
}

export function handleHook(input, eventName, cwd = input?.cwd) {
  if (process.platform === "win32") {
    resetWindowsPathChecks();
  }
  if (!isFullyQualifiedRepositoryCwd(cwd) || !isLocalRepositoryPath(cwd)) {
    const reason =
      "Supervised Worker could not verify local state because the hook payload did not provide an absolute repository cwd. Do not rely on this run as queue completion.";
    if (eventName === "PreToolUse") {
      return preToolDecision(
        input,
        "deny",
        "Supervised Worker denied the file edit because the hook payload did not provide an absolute repository cwd.",
      );
    }
    return eventName === "Stop"
      ? allowStopOutput(input, reason)
      : {
          ...contextOutput(input, eventName, reason),
          systemMessage: reason,
        };
  }
  let effectiveCwd = cwd;
  let sessionContext = null;
  let sessionLock = null;
  let repositoryLocks = [];
  let routedAttachmentObserved = false;
  try {
    const preparedTargets = prepareToolTargets(input);
    for (const target of preparedTargets) {
      if (target.canonical !== undefined) isLocalRepositoryPath(target.canonical);
    }
    preflightSessionLocatorLocality(input);
    sessionContext = sessionLocatorContext(input);
    const nonWriterObservation = eventName === "PreToolUse" &&
      !PLAN_WRITER_TOOLS.has(boundedToolName(input).toLowerCase().split(/[./]/).at(-1));
    if (nonWriterObservation) {
      const routing = readSessionLocator(input, false);
      if (!routing.exists && attachedRecord(cwd, input) === null) return {};
    }
    sessionLock = acquireSessionLock(input, sessionContext);
    windowsPathChecksMaySpawn = false;
    repositoryLocks = acquireHookRepositoryLocks(input, eventName, preparedTargets, cwd);
    effectiveCwd = resolveHookCwd(input, preparedTargets, cwd);
    const inspectedTargets = completeToolTargetInspection(preparedTargets, effectiveCwd);
    const attachment = attachedRecord(effectiveCwd, input);
    const guarded = repositoryLocks.some((lock) =>
      pathEquals(lock.storageRoot, effectiveCwd) || pathsShareFilesystemIdentity(lock.storageRoot, effectiveCwd),
    );
    if (!guarded && attachment !== null) {
      throw new Error("session ownership appeared outside the repository lifecycle guard");
    }
    routedAttachmentObserved = attachment?.routeGeneration !== null && attachment !== null;
    if (routedAttachmentObserved && (sessionContext === null || sessionLock === null)) {
      throw new Error("routed attachment requires its workspace-scoped session lock");
    }
    if (!guarded && eventName !== "PreToolUse") return {};
    const output = handleHookUnsafe(input, eventName, effectiveCwd, inspectedTargets);
    if (eventName === "PreToolUse" && output.permissionDecision !== "deny") {
      try {
        recordToolStart(effectiveCwd, input);
      } catch {
        return preToolDecision(input, "deny",
          "Supervised Worker could not durably record the tool start. The invocation was denied; inspect local ledger state before retrying.");
      }
    }
    return output;
  } catch (error) {
    if (eventName === "PreToolUse") {
      return preToolDecision(
        input,
        "deny",
        "Supervised Worker could not verify plan ownership, so the plan write was denied.",
      );
    }
    const lockScope = error?.message === "session lifecycle lock is busy"
      ? "session"
      : error?.message === "repository lifecycle lock is busy" ? "repository" : null;
    const reason = lockScope !== null
      ? `Supervised Worker could not verify its local state because another lifecycle operation held the ${lockScope} lock beyond the bounded overlap window. This hook failed open visibly; do not rely on this run as queue completion.`
      : "Supervised Worker could not verify its local state and allowed this hook to fail open visibly. Do not rely on this run as queue completion.";
    return eventName === "Stop"
      ? allowStopOutput(input, reason)
      : {
          ...contextOutput(input, eventName, reason),
          systemMessage: reason,
        };
  } finally {
    for (const lock of repositoryLocks.reverse()) releaseLifecycleLock(lock);
    releaseLifecycleLock(sessionLock);
  }
}

export function releaseAttachment(cwd) {
  if (process.platform === "win32") resetWindowsPathChecks();
  if (!isFullyQualifiedRepositoryCwd(cwd) || !isLocalRepositoryPath(cwd)) {
    throw new Error("release requires a local repository root");
  }
  const resolvedCwd = path.resolve(cwd);
  if (!pathEquals(resolvedCwd, realpathSync(resolvedCwd))) {
    throw new Error("release requires a canonical repository root");
  }
  const filePath = attachmentPath(cwd);
  assertSafeStatePath(cwd, filePath);
  const intended = readAttachmentSnapshot(cwd);
  if (intended === null) return { released: false, message: "No attachment found." };
  windowsPathChecksMaySpawn = false;
  const locks = acquireRepositoryLocks([resolvedCwd]);
  try {
    requireAttachmentSnapshot(cwd, intended);
    let attachment = null;
    try {
      attachment = attachmentFromSnapshot(intended);
    } catch {
      // Explicit release may remove malformed local ownership state, but never a link.
    }
    try {
      if (attachment) {
        removeStateFile(cwd, path.join(stateDirectory(cwd), "runtime", `${attachment.sessionHash}.json`));
      }
    } catch {
      // Runtime state is optional; attachment release is the authoritative action.
    }
    removeAttachmentSnapshot(cwd, intended);
    return { released: true, message: "Released the stale session attachment." };
  } finally {
    for (const lock of locks.reverse()) releaseLifecycleLock(lock);
  }
}

function runLedgerUnavailable(reason) {
  return {
    status: "unavailable",
    provenance: "worker-recorded-local",
    integrity: "plugin-verified-local",
    reason,
    hash: null,
    sessionCount: null,
    recordCount: null,
    eventCounts: null,
    firstObservedAt: null,
    lastObservedAt: null,
  };
}

function runLedgerFailure(reason) {
  return Object.assign(new Error(reason), { runLedgerReason: reason });
}

function sameRunLedgerStats(left, right) {
  return ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]
    .every((key) => left[key] === right[key]);
}

function requireRunLedgerRecord(record, expectedSession) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw runLedgerFailure("run-ledger-invalid");
  }
  const fields = RUN_LEDGER_EVENT_FIELDS.get(record.event);
  if (!fields) throw runLedgerFailure("run-ledger-invalid");
  const allowed = new Set([...RUN_LEDGER_COMMON_KEYS, ...fields.required, ...fields.optional]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    [...RUN_LEDGER_COMMON_KEYS, ...fields.required].some((key) => !Object.hasOwn(record, key))
  ) {
    throw runLedgerFailure("run-ledger-invalid");
  }
  if (
    record.schemaVersion !== 1 ||
    record.session !== expectedSession ||
    !isDateTime(record.at) ||
    Number.isNaN(new Date(record.at).valueOf())
  ) {
    throw runLedgerFailure("run-ledger-invalid");
  }
  const hexadecimal = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  if (Object.hasOwn(record, "planHash") && !hexadecimal(record.planHash)) {
    throw runLedgerFailure("run-ledger-invalid");
  }
  if (Object.hasOwn(record, "progressHash") && !hexadecimal(record.progressHash)) {
    throw runLedgerFailure("run-ledger-invalid");
  }
  if (
    Object.hasOwn(record, "sameProgressBlocks") &&
    (!Number.isInteger(record.sameProgressBlocks) || record.sameProgressBlocks < 0)
  ) {
    throw runLedgerFailure("run-ledger-invalid");
  }
  if (
    Object.hasOwn(record, "totalBlocks") &&
    (!Number.isInteger(record.totalBlocks) || record.totalBlocks < 0)
  ) {
    throw runLedgerFailure("run-ledger-invalid");
  }
  for (const key of ["toolName", "trigger", "attemptedEvent"]) {
    if (Object.hasOwn(record, key) && !nonEmptyString(record[key])) {
      throw runLedgerFailure("run-ledger-invalid");
    }
  }
  if (Object.hasOwn(record, "success") && typeof record.success !== "boolean") {
    throw runLedgerFailure("run-ledger-invalid");
  }
  for (const key of ["attachmentHash", "sourceSessionHash"]) {
    if (Object.hasOwn(record, key) && !hexadecimal(record[key])) throw runLedgerFailure("run-ledger-invalid");
  }
  for (const key of ["checkpointHash", "invocationHash"]) {
    if (Object.hasOwn(record, key) && !(hexadecimal(record[key]) ||
      (record[key] === null && (key === "invocationHash" || record.event === "checkpoint_resumed")))) {
      throw runLedgerFailure("run-ledger-invalid");
    }
  }
  for (const key of ["routeGeneration", "claimGeneration"]) {
    if (Object.hasOwn(record, key) && !generation(record[key])) {
      throw runLedgerFailure("run-ledger-invalid");
    }
  }
  if (record.event === "tool_started" || Object.hasOwn(record, "observationId")) {
    if (typeof record.toolName !== "string" || !/^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(record.toolName) ||
      !(uuid(record.operationId) || (record.event === "tool_completed" && record.operationId === null))) {
      throw runLedgerFailure("run-ledger-invalid");
    }
  }
  if (record.event === "tool_completed") {
    const keys = ["observationId", "operationId", "invocationHash", "routeGeneration", "claimGeneration"];
    if (keys.some((key) => Object.hasOwn(record, key)) &&
      (!keys.every((key) => Object.hasOwn(record, key)) || !uuid(record.observationId) ||
       (record.operationId !== null && record.invocationHash === null))) throw runLedgerFailure("run-ledger-invalid");
  }
  if (record.event === "checkpoint_resumed" && !uuid(record.claimGeneration)) {
    throw runLedgerFailure("run-ledger-invalid");
  }
  if (record.event === "checkpoint_resumed" &&
    !((record.observationStatus === "observed" && record.observationReason === null) ||
      (record.observationStatus === "unavailable" &&
        ["ledger-absent", "ledger-invalid", "inherited-observation-unavailable"].includes(record.observationReason)))) {
    throw runLedgerFailure("run-ledger-invalid");
  }
  if (
    record.event === "completion_unverified_release" &&
    !["invalid_runtime_state", "bounded_stop_limit"].includes(record.reason)
  ) {
    throw runLedgerFailure("run-ledger-invalid");
  }
  return new Date(record.at).toISOString();
}

function hashRunLedger(files) {
  const hash = createHash("sha256");
  hash.update("supervised-worker-run-ledger-v1\0");
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(files.length));
  hash.update(count);
  for (const { name, bytes } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const nameLength = Buffer.alloc(8);
    const contentLength = Buffer.alloc(8);
    nameLength.writeBigUInt64BE(BigInt(nameBytes.length));
    contentLength.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(nameLength);
    hash.update(nameBytes);
    hash.update(contentLength);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function summarizeRunLedger(cwd) {
  const directory = path.join(stateDirectory(cwd), "runs");
  try {
    assertSafeStatePath(cwd, directory);
    if (!existsSync(directory)) return runLedgerUnavailable("run-ledger-absent");
    let directoryBefore;
    try {
      directoryBefore = lstatSync(directory, { bigint: true });
    } catch (error) {
      throw runLedgerFailure(
        error?.code === "ENOENT" ? "run-ledger-changed-during-read" : "run-ledger-invalid",
      );
    }
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
      throw runLedgerFailure("run-ledger-invalid");
    }
    const names = readdirSync(directory).sort();
    if (names.length > RUN_LEDGER_MAX_FILES) {
      throw runLedgerFailure("run-ledger-limit-exceeded");
    }
    if (names.some((name) => !RUN_LEDGER_FILE_PATTERN.test(name))) {
      throw runLedgerFailure("run-ledger-invalid");
    }

    const files = [];
    const canonicalRecords = new Set();
    const eventCounts = new Map();
    let aggregateBytes = 0;
    let recordCount = 0;
    let firstObservedAt = null;
    let lastObservedAt = null;
    for (const name of names) {
      const filePath = path.join(directory, name);
      assertSafeStatePath(cwd, filePath);
      let before;
      try {
        before = lstatSync(filePath, { bigint: true });
      } catch (error) {
        throw runLedgerFailure(
          error?.code === "ENOENT" ? "run-ledger-changed-during-read" : "run-ledger-invalid",
        );
      }
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        throw runLedgerFailure("run-ledger-invalid");
      }
      if (before.size > BigInt(RUN_LEDGER_MAX_FILE_BYTES)) {
        throw runLedgerFailure("run-ledger-limit-exceeded");
      }
      aggregateBytes += Number(before.size);
      if (aggregateBytes > RUN_LEDGER_MAX_TOTAL_BYTES) {
        throw runLedgerFailure("run-ledger-limit-exceeded");
      }

      let descriptor;
      let bytes;
      let opened;
      let afterRead;
      try {
        descriptor = openSync(filePath, "r");
        opened = fstatSync(descriptor, { bigint: true });
        if (!sameRunLedgerStats(before, opened)) {
          throw runLedgerFailure("run-ledger-changed-during-read");
        }
        bytes = readFileSync(descriptor);
        afterRead = fstatSync(descriptor, { bigint: true });
      } catch (error) {
        if (error?.runLedgerReason) throw error;
        throw runLedgerFailure(
          ["ENOENT", "ESTALE"].includes(error?.code)
            ? "run-ledger-changed-during-read"
            : "run-ledger-invalid",
        );
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
      let afterPath;
      try {
        afterPath = lstatSync(filePath, { bigint: true });
      } catch {
        throw runLedgerFailure("run-ledger-changed-during-read");
      }
      if (
        !sameRunLedgerStats(opened, afterRead) ||
        !sameRunLedgerStats(afterRead, afterPath) ||
        bytes.length !== Number(afterRead.size)
      ) {
        throw runLedgerFailure("run-ledger-changed-during-read");
      }
      if (bytes.length === 0 || bytes.at(-1) !== 0x0a) {
        throw runLedgerFailure("run-ledger-invalid");
      }

      const expectedSession = name.slice(0, 64);
      for (const record of parseRunLedgerBytes(bytes, expectedSession)) {
        const observedAt = requireRunLedgerRecord(record, expectedSession);
        const canonicalRecord = canonicalJson(record);
        if (canonicalRecords.has(canonicalRecord)) {
          throw runLedgerFailure("run-ledger-invalid");
        }
        canonicalRecords.add(canonicalRecord);
        recordCount += 1;
        eventCounts.set(record.event, (eventCounts.get(record.event) ?? 0) + 1);
        if (firstObservedAt === null || observedAt < firstObservedAt) firstObservedAt = observedAt;
        if (lastObservedAt === null || observedAt > lastObservedAt) lastObservedAt = observedAt;
      }
      files.push({ name, bytes, stats: afterPath });
    }

    for (const file of files) {
      const filePath = path.join(directory, file.name);
      let beforeVerify;
      let verifyBytes;
      let afterVerify;
      try {
        beforeVerify = lstatSync(filePath, { bigint: true });
        if (
          !beforeVerify.isFile() ||
          beforeVerify.isSymbolicLink() ||
          beforeVerify.nlink !== 1n ||
          !sameRunLedgerStats(file.stats, beforeVerify)
        ) {
          throw runLedgerFailure("run-ledger-changed-during-read");
        }
        verifyBytes = readFileSync(filePath);
        afterVerify = lstatSync(filePath, { bigint: true });
      } catch (error) {
        if (error?.runLedgerReason) throw error;
        throw runLedgerFailure("run-ledger-changed-during-read");
      }
      if (
        !sameRunLedgerStats(beforeVerify, afterVerify) ||
        !file.bytes.equals(verifyBytes)
      ) {
        throw runLedgerFailure("run-ledger-changed-during-read");
      }
    }

    let namesAfter;
    let directoryAfter;
    try {
      namesAfter = readdirSync(directory).sort();
      directoryAfter = lstatSync(directory, { bigint: true });
    } catch {
      throw runLedgerFailure("run-ledger-changed-during-read");
    }
    if (
      JSON.stringify(namesAfter) !== JSON.stringify(names) ||
      !sameRunLedgerStats(directoryBefore, directoryAfter)
    ) {
      throw runLedgerFailure("run-ledger-changed-during-read");
    }
    return {
      status: "available",
      provenance: "worker-recorded-local",
      integrity: "plugin-verified-local",
      reason: null,
      hash: hashRunLedger(files),
      sessionCount: files.length,
      recordCount,
      eventCounts: [...eventCounts]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([event, count]) => ({ event, count })),
      firstObservedAt,
      lastObservedAt,
    };
  } catch (error) {
    return runLedgerUnavailable(error?.runLedgerReason ?? "run-ledger-invalid");
  }
}

function checkpointStatus(cwd) {
  const snapshot = readAttachmentSnapshot(cwd);
  const attachment = snapshot === null ? null : attachmentFromSnapshot(snapshot);
  let operations;
  try {
    if (attachment?.checkpointHash) {
      const receipt = readCheckpointReceipt(cwd, attachment.checkpointHash);
      requireCheckpointLedger(cwd, receipt, attachment.checkpointHash, false);
      operations = attachment.status === "checkpointed" ? receipt.context.operations :
        inspectOperations(readSessionLedger(cwd, attachment.sessionHash).records, receipt.context.operations);
    } else {
      const summary = summarizeRunLedger(cwd);
      if (summary.status !== "available") {
        operations = unavailableOperations(summary.reason === "run-ledger-absent" ? "ledger-absent" : "ledger-invalid");
      } else {
        const records = readdirSync(path.join(stateDirectory(cwd), "runs")).sort()
          .flatMap((name) => readSessionLedger(cwd, name.slice(0, 64)).records);
        operations = summarizeRunLedger(cwd).hash === summary.hash ? inspectOperations(records) : unavailableOperations("ledger-invalid");
      }
    }
  } catch {
    operations = unavailableOperations("ledger-invalid");
  }
  return {
    attachmentHash: snapshot?.hash ?? null,
    attachment: attachment === null ? null : {
      status: attachment.status, sessionHash: attachment.sessionHash, routeGeneration: attachment.routeGeneration,
      claimGeneration: attachment.claimGeneration, checkpointHash: attachment.checkpointHash,
    },
    operations,
  };
}

export function summarizePlan(cwd) {
  const result = loadPlan(cwd);
  if (!result.exists) return { active: false, message: "No durable plan found." };
  if (result.errors.length > 0) return { active: true, valid: false, errors: result.errors };
  const counts = Object.fromEntries(
    [...ITEM_STATUSES].map((status) => [
      status,
      result.plan.items.filter((item) => item.status === status).length,
    ]),
  );
  return {
    active: result.plan.mode !== "inactive",
    valid: true,
    mode: result.plan.mode,
    counts,
    complete: isComplete(result.plan),
    planHash: canonicalPlanHash(result.plan),
    ...checkpointStatus(cwd),
  };
}