import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
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

import { WORKFLOW_CONFIG_PATH } from "./workflow.mjs";

export const STATE_DIRECTORY = ".supervised-worker";
export const PLAN_FILE = "plan.json";
export const MAX_SAME_PROGRESS_BLOCKS = 2;
export const MAX_PLAN_BYTES = 1_048_576;
export const MAX_TOOL_TARGETS = 256;
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
const ATTACHMENT_STATUSES = new Set(["provisional", "active"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PLAN_WRITER_MATCHER =
  "Write|Edit|create|edit|apply_patch|create_file|str_replace_editor|insert|insert_edit_into_file|replace_string_in_file|multi_replace_string_in_file";
export const PLAN_WRITER_TOOLS = new Set(
  PLAN_WRITER_MATCHER.split("|").map((name) => name.toLowerCase()),
);
const PATH_KEYS = new Set(["filePath", "file_path", "path"]);

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

function readAttachment(cwd) {
  const filePath = attachmentPath(cwd);
  assertSafeStatePath(cwd, filePath);
  if (!existsSync(filePath)) return null;
  const attachment = readJson(cwd, filePath);
  if (attachment?.schemaVersion === 1) {
    if (
      !/^[0-9a-f]{64}$/.test(attachment?.sessionHash ?? "") ||
      !isDateTime(attachment?.attachedAt)
    ) {
      throw new Error("session attachment is invalid");
    }
    return { ...attachment, status: "active", routeGeneration: null };
  }
  if (
    attachment?.schemaVersion !== 2 ||
    !attachment ||
    typeof attachment !== "object" ||
    Array.isArray(attachment) ||
    Object.keys(attachment).some((key) => !ATTACHMENT_KEYS.has(key)) ||
    !/^[0-9a-f]{64}$/.test(attachment?.sessionHash ?? "") ||
    !ATTACHMENT_STATUSES.has(attachment.status) ||
    !(attachment.routeGeneration === null || UUID_PATTERN.test(attachment.routeGeneration ?? "")) ||
    !isDateTime(attachment.attachedAt) ||
    !isDateTime(attachment.updatedAt)
  ) {
    throw new Error("session attachment is invalid");
  }
  return attachment;
}

function attachedRecord(cwd, input, routeGeneration = undefined) {
  const expected = sessionHash(input);
  const attachment = expected === null ? null : readAttachment(cwd);
  if (attachment?.sessionHash !== expected) return null;
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
  ensureSafeDirectory(context.storageRoot, locksDirectory);
  const token = randomUUID();
  const ownerPath = path.join(lockDirectory, `${token}.json`);
  assertSafeStatePath(context.storageRoot, lockDirectory);
  const deadline = performance.now() + SESSION_LOCK_WAIT_MS;
  let observedContention = false;
  while (true) {
    if (observedContention && performance.now() >= deadline) {
      throw new Error("session lifecycle lock is busy");
    }
    try {
      mkdirSync(lockDirectory, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      observedContention = true;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("session lifecycle lock is busy");
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
    throw new Error("session lifecycle lock identity is unavailable");
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
  const currentStats = lstatSync(lockDirectory, { bigint: true });
  const entries = readdirSync(lockDirectory);
  const verifiedStats = lstatSync(lockDirectory, { bigint: true });
  if (
    !currentStats.isDirectory() ||
    currentStats.isSymbolicLink() ||
    currentStats.dev !== directoryStats.dev ||
    currentStats.ino !== directoryStats.ino ||
    !verifiedStats.isDirectory() ||
    verifiedStats.isSymbolicLink() ||
    verifiedStats.dev !== directoryStats.dev ||
    verifiedStats.ino !== directoryStats.ino ||
    entries.length !== 1 ||
    entries[0] !== path.basename(ownerPath)
  ) {
    throw new Error("session lifecycle lock identity changed during acquisition");
  }
  return {
    storageRoot: context.storageRoot,
    lockDirectory,
    ownerPath,
    token,
    directoryDev: directoryStats.dev,
    directoryIno: directoryStats.ino,
  };
}

function sessionLockIdentityMatches(lock) {
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

function releaseSessionLock(lock) {
  if (lock === null) return;
  try {
    if (!sessionLockIdentityMatches(lock)) return;
    const owner = readJson(lock.storageRoot, lock.ownerPath, MAX_SESSION_LOCATOR_BYTES);
    if (owner?.token !== lock.token || owner?.processId !== process.pid) return;
    if (!sessionLockIdentityMatches(lock)) return;
    removeStateFile(lock.storageRoot, lock.ownerPath);
    if (!sessionLockIdentityMatches(lock)) return;
    assertSafeStatePath(lock.storageRoot, lock.lockDirectory);
    rmdirSync(lock.lockDirectory);
  } catch {
    // An abandoned lock requires operator-confirmed cleanup.
  }
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

function readSessionLocator(input) {
  const context = sessionLocatorContext(input);
  if (context === null) return { context: null, exists: false, locator: null };
  const marker = readSessionMarker(context, input);
  assertSafeStatePath(context.storageRoot, context.directoryPath);
  assertSafeStatePath(context.storageRoot, context.filePath);
  if (existsSync(context.filePath) && marker === null) {
    ensureSessionMarker(context, input);
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
      if (attachedRecord(existing.repositoryRoot, input, existing.generation)) {
        removeStateFile(existing.repositoryRoot, attachmentPath(existing.repositoryRoot));
      }
      atomicWriteJson(context.storageRoot, context.filePath, record);
      return { bound: true, created: true, conflict: false, generation: record.generation };
    }
    if (pathEquals(existing.repositoryRoot, repositoryRoot)) {
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

function updateSessionLocatorStatus(input, expectedCwd, generation, status) {
  const result = readSessionLocator(input);
  if (result.context === null) return;
  if (
    !result.exists ||
    !pathEquals(result.locator.repositoryRoot, expectedCwd) ||
    result.locator.generation !== generation
  ) {
    throw new Error("session repository locator does not match the attachment generation");
  }
  if (result.locator.status === status) return;
  if (result.locator.status === "released") {
    throw new Error("released session repository locator cannot be reactivated");
  }
  atomicWriteJson(result.context.storageRoot, result.context.filePath, {
    ...result.locator,
    status,
    updatedAt: new Date().toISOString(),
  });
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
  const attachment = attachedRecord(
    result.locator.repositoryRoot,
    input,
    result.locator.generation,
  );
  if (result.locator.status === "released") {
    if (attachment !== null) {
      removeStateFile(
        result.locator.repositoryRoot,
        attachmentPath(result.locator.repositoryRoot),
      );
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
    schemaVersion: 2,
    sessionHash: hash,
    status: "provisional",
    routeGeneration: locatorClaim.generation ?? null,
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
    const existing = readAttachment(cwd);
    if (
      existing?.sessionHash === hash &&
      existing.routeGeneration === null &&
      record.routeGeneration !== null
    ) {
      const migrated = {
        schemaVersion: 2,
        sessionHash: hash,
        status: "active",
        routeGeneration: record.routeGeneration,
        attachedAt: existing.attachedAt,
        updatedAt: new Date().toISOString(),
      };
      let migrationWritten = false;
      try {
        atomicWriteJson(cwd, filePath, migrated);
        migrationWritten = true;
        updateSessionLocatorStatus(input, cwd, record.routeGeneration, "active");
      } catch (migrationError) {
        try {
          if (migrationWritten) {
            atomicWriteJson(cwd, filePath, {
              schemaVersion: 1,
              sessionHash: hash,
              attachedAt: existing.attachedAt,
            });
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

function detachSession(cwd, input) {
  const attachment = attachedRecord(cwd, input);
  if (attachment === null) return false;
  if (attachment.routeGeneration !== null) {
    updateSessionLocatorStatus(
      input,
      cwd,
      attachment.routeGeneration,
      "released",
    );
  }
  removeStateFile(cwd, attachmentPath(cwd));
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
  try {
    removeStateFile(cwd, runtimeStatePath(cwd, input));
  } catch {
    // Runtime counters are recoverable; ownership cleanup remains authoritative.
  }
  try {
    if (!detachSession(cwd, input)) {
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
      { planHash: sha256(canonicalJson(planResult.plan)) },
      {},
    );
  }

  const filePath = runtimeStatePath(cwd, input);
  const progressHash = planResult.errors.length === 0
    ? sha256(canonicalJson(planResult.plan))
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
        `A durable Supervised Worker plan is active at .supervised-worker/plan.json. Counts: ${JSON.stringify(counts)}. Read it before selecting work; do not infer completion from this summary.`,
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
          claim.routingConflict
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
          if (isAttached(cwd, input)) {
            appendLedger(cwd, input, "tool_completed", {
              toolName: input?.tool_name ?? input?.toolName ?? "unknown",
              success: false,
            });
            try {
              if (!detachSession(cwd, input)) {
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
            "The plan-targeting tool completed without materializing .supervised-worker/plan.json. Supervised Worker released its provisional claim and did not record the write as successful.",
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
      appendLedger(cwd, input, "tool_completed", {
        toolName: input?.tool_name ?? input?.toolName ?? "unknown",
        success: true,
      });
      return {};
    }
    case "PostToolUseFailure":
      if (!isAttached(cwd, input)) return {};
      appendLedger(cwd, input, "tool_completed", {
        toolName: input?.tool_name ?? input?.toolName ?? "unknown",
        success: false,
      });
      if (toolTouchesPlan(inspectedTargets, cwd) && !existsSync(planPath(cwd))) {
        try {
          if (!detachSession(cwd, input)) {
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
      return {};
    case "PreCompact":
      if (!isAttached(cwd, input)) return {};
      appendLedger(cwd, input, "pre_compact", {
        trigger: input?.trigger ?? "unknown",
      });
      return {};
    case "Stop":
      return handleStop(input, cwd);
    default:
      return {};
  }
}

export function handleHook(input, eventName, cwd = input?.cwd) {
  if (eventName === "PreToolUse") {
    const toolName = (input?.tool_name ?? input?.toolName ?? "")
      .toLowerCase()
      .split(/[./]/)
      .at(-1);
    if (!PLAN_WRITER_TOOLS.has(toolName)) return {};
  }
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
  let routedAttachmentObserved = false;
  try {
    const preparedTargets = prepareToolTargets(input);
    preflightSessionLocatorLocality(input);
    sessionContext = sessionLocatorContext(input);
    sessionLock = acquireSessionLock(input, sessionContext);
    windowsPathChecksMaySpawn = false;
    effectiveCwd = resolveHookCwd(input, preparedTargets, cwd);
    const inspectedTargets = completeToolTargetInspection(preparedTargets, effectiveCwd);
    const attachment = attachedRecord(effectiveCwd, input);
    routedAttachmentObserved = attachment?.routeGeneration !== null && attachment !== null;
    if (routedAttachmentObserved && (sessionContext === null || sessionLock === null)) {
      throw new Error("routed attachment requires its workspace-scoped session lock");
    }
    return handleHookUnsafe(input, eventName, effectiveCwd, inspectedTargets);
  } catch (error) {
    if (eventName === "PreToolUse") {
      return preToolDecision(
        input,
        "deny",
        "Supervised Worker could not verify plan ownership, so the plan write was denied.",
      );
    }
    const reason = error?.message === "session lifecycle lock is busy"
      ? "Supervised Worker could not verify its local state because another lifecycle hook held the session lock beyond the bounded overlap window. This hook failed open visibly; do not rely on this run as queue completion."
      : "Supervised Worker could not verify its local state and allowed this hook to fail open visibly. Do not rely on this run as queue completion.";
    return eventName === "Stop"
      ? allowStopOutput(input, reason)
      : {
          ...contextOutput(input, eventName, reason),
          systemMessage: reason,
        };
  } finally {
    releaseSessionLock(sessionLock);
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
  if (!existsSync(filePath)) return { released: false, message: "No attachment found." };
  let attachment = null;
  try {
    attachment = readAttachment(cwd);
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
  removeStateFile(cwd, filePath);
  return { released: true, message: "Released the stale session attachment." };
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
  };
}