import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const WORKFLOW_CONFIG_PATH = ".github/supervised-worker.json";
export const WORKFLOW_ACCEPTANCE_PATH = ".supervised-worker/workflow-acceptance.json";
export const MAX_WORKFLOW_BYTES = 1_048_576;
export const LEGACY_DEFAULT_ROLES = Object.freeze({
  architect: "seangalliher-supervised-architect",
  builder: "seangalliher-supervised-builder",
  reviewer: "seangalliher-supervised-diff-reviewer",
});
export const DEFAULT_ROLES = Object.freeze({
  architect: "supervised-worker:seangalliher-supervised-architect",
  builder: "supervised-worker:seangalliher-supervised-builder",
  reviewer: "supervised-worker:seangalliher-supervised-diff-reviewer",
});
export const DEFAULT_REVIEW_POLICY = Object.freeze({
  requiredModel: null,
  requiredModelFamily: null,
  requireDifferentModelFamily: false,
});

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "tracker",
  "wip",
  "authority",
  "roles",
  "validation",
  "review",
  "filing",
]);
const ROLE_KEYS = new Set(["architect", "builder", "reviewer"]);
const WORKER_SELECTORS = new Set([
  "supervised-worker",
  "seangalliher-supervised-worker",
  "supervised-worker:supervised-worker",
  "supervised-worker:seangalliher-supervised-worker",
]);
const PLUGIN_ID_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const AGENT_ID_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const MODEL_ID_RE = /^[a-z0-9](?:[a-z0-9._:/-]{0,126}[a-z0-9])?$/;
const MODEL_FAMILY_RE = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rejectDuplicateObjectKeys(text) {
  const stack = [];
  const beginValue = () => {
    const parent = stack.at(-1);
    if (parent?.type === "object" && parent.phase === "value") parent.phase = "comma";
    if (parent?.type === "array" && parent.phase === "value") parent.phase = "comma";
  };
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "{") {
      beginValue();
      stack.push({ type: "object", phase: "key", keys: new Set() });
      index += 1;
      continue;
    }
    if (character === "[") {
      beginValue();
      stack.push({ type: "array", phase: "value" });
      index += 1;
      continue;
    }
    if (character === '"') {
      const start = index;
      index += 1;
      while (text[index] !== '"') {
        if (text[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      const parent = stack.at(-1);
      if (parent?.type === "object" && parent.phase === "key") {
        const key = JSON.parse(text.slice(start, index));
        if (parent.keys.has(key)) throw new Error(`workflow contains duplicate object key: ${key}`);
        parent.keys.add(key);
        parent.phase = "colon";
      } else {
        beginValue();
      }
      continue;
    }
    if (character === ":") {
      const parent = stack.at(-1);
      if (parent?.type === "object") parent.phase = "value";
      index += 1;
      continue;
    }
    if (character === ",") {
      const parent = stack.at(-1);
      if (parent?.type === "object") parent.phase = "key";
      if (parent?.type === "array") parent.phase = "value";
      index += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      stack.pop();
      index += 1;
      continue;
    }
    beginValue();
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
  }
}

export function parseWorkflowJson(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  rejectDuplicateObjectKeys(text);
  return value;
}

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRfc3339DateTime(value) {
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

function validSelector(value) {
  if (typeof value !== "string") return false;
  const parts = value.split(":");
  if (parts.length === 1) return AGENT_ID_RE.test(parts[0]);
  return parts.length === 2 && PLUGIN_ID_RE.test(parts[0]) && AGENT_ID_RE.test(parts[1]);
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

function stringArray(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }
  if (value.some((entry) => !nonBlank(entry))) {
    errors.push(`${label} must contain only non-empty strings`);
  }
  if (new Set(value).size !== value.length) errors.push(`${label} must contain unique values`);
}

function positiveInteger(value, label, errors, maximum = null) {
  if (!Number.isInteger(value) || value < 1 || (maximum !== null && value > maximum)) {
    errors.push(`${label} is invalid`);
  }
}

export function validateWorkflowValue(value) {
  const errors = [];
  if (!isRecord(value)) return ["workflow must be a JSON object"];
  unknownKeys(value, TOP_LEVEL_KEYS, "workflow", errors);
  for (const key of ["schemaVersion", "tracker", "wip", "authority", "validation", "review"]) {
    if (!Object.hasOwn(value, key)) errors.push(`workflow.${key} is required`);
  }
  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");

  if (requiredKeys(value.tracker, ["kind", "scope"], "tracker", errors)) {
    unknownKeys(value.tracker, new Set(["kind", "scope", "query"]), "tracker", errors);
    if (value.tracker.kind !== "github") errors.push("tracker.kind must be github");
    if (!nonBlank(value.tracker.scope) || [...value.tracker.scope].length < 3) {
      errors.push("tracker.scope must contain at least 3 characters");
    }
    if (value.tracker.query !== undefined && typeof value.tracker.query !== "string") {
      errors.push("tracker.query must be a string");
    }
  }

  if (requiredKeys(value.wip, ["maxActive", "maxCoupled"], "wip", errors)) {
    unknownKeys(value.wip, new Set(["maxActive", "maxCoupled"]), "wip", errors);
    positiveInteger(value.wip.maxActive, "wip.maxActive", errors, 3);
    positiveInteger(value.wip.maxCoupled, "wip.maxCoupled", errors, 3);
  }

  if (requiredKeys(value.authority, ["mode", "boundaries"], "authority", errors)) {
    unknownKeys(value.authority, new Set(["mode", "boundaries"]), "authority", errors);
    if (!["supervised", "delegated"].includes(value.authority.mode)) {
      errors.push("authority.mode must be supervised or delegated");
    }
    stringArray(value.authority.boundaries, "authority.boundaries", errors);
  }

  if (value.roles !== undefined) {
    if (requiredKeys(value.roles, [...ROLE_KEYS], "roles", errors)) {
      unknownKeys(value.roles, ROLE_KEYS, "roles", errors);
      for (const role of ROLE_KEYS) {
        if (!validSelector(value.roles[role])) errors.push(`roles.${role} is invalid`);
        else if (WORKER_SELECTORS.has(value.roles[role])) {
          errors.push(`roles.${role} cannot identify the Supervised Worker`);
        }
      }
      if (
        [...ROLE_KEYS].every((role) => validSelector(value.roles[role])) &&
        new Set(Object.values(value.roles)).size !== ROLE_KEYS.size
      ) {
        errors.push("roles must identify three distinct agents");
      }
    }
  }

  if (requiredKeys(value.validation, ["focused", "broad"], "validation", errors)) {
    unknownKeys(
      value.validation,
      new Set(["focused", "broad", "receiptGlobs"]),
      "validation",
      errors,
    );
    if (!nonBlank(value.validation.focused)) errors.push("validation.focused must be non-empty");
    if (!nonBlank(value.validation.broad)) errors.push("validation.broad must be non-empty");
    if (value.validation.receiptGlobs !== undefined) {
      stringArray(value.validation.receiptGlobs, "validation.receiptGlobs", errors);
    }
  }

  if (requiredKeys(value.review, ["required", "independent"], "review", errors)) {
    unknownKeys(
      value.review,
      new Set([
        "required",
        "independent",
        "agent",
        "requiredModel",
        "requiredModelFamily",
        "requireDifferentModelFamily",
      ]),
      "review",
      errors,
    );
    if (value.review.required !== true) errors.push("review.required must be true");
    if (value.review.independent !== true) errors.push("review.independent must be true");
    if (value.review.agent !== undefined) {
      if (!validSelector(value.review.agent)) errors.push("review.agent is invalid");
      else if (WORKER_SELECTORS.has(value.review.agent)) {
        errors.push("review.agent cannot identify the Supervised Worker");
      }
    }
    if (
      value.roles !== undefined &&
      validSelector(value.roles?.reviewer) &&
      validSelector(value.review.agent) &&
      value.roles.reviewer !== value.review.agent
    ) {
      errors.push("roles.reviewer and review.agent must match when both are present");
    }
    if (
      value.roles === undefined &&
      validSelector(value.review.agent) &&
      new Set([DEFAULT_ROLES.architect, DEFAULT_ROLES.builder, value.review.agent]).size !== 3
    ) {
      errors.push("effective roles must identify three distinct agents");
    }
    const hasRequiredModel = value.review.requiredModel !== undefined;
    const hasRequiredFamily = value.review.requiredModelFamily !== undefined;
    if (
      hasRequiredModel &&
      (typeof value.review.requiredModel !== "string" ||
        !MODEL_ID_RE.test(value.review.requiredModel))
    ) {
      errors.push("review.requiredModel is invalid");
    }
    if (
      hasRequiredFamily &&
      (typeof value.review.requiredModelFamily !== "string" ||
        !MODEL_FAMILY_RE.test(value.review.requiredModelFamily))
    ) {
      errors.push("review.requiredModelFamily is invalid");
    }
    if (hasRequiredModel !== hasRequiredFamily) {
      errors.push("review.requiredModel and review.requiredModelFamily must be configured together");
    }
    if (
      value.review.requireDifferentModelFamily !== undefined &&
      typeof value.review.requireDifferentModelFamily !== "boolean"
    ) {
      errors.push("review.requireDifferentModelFamily must be boolean");
    }
    if (
      value.review.requireDifferentModelFamily === true &&
      (!hasRequiredModel || !hasRequiredFamily)
    ) {
      errors.push(
        "review.requireDifferentModelFamily requires requiredModel and requiredModelFamily",
      );
    }
  }

  if (value.filing !== undefined) {
    if (isRecord(value.filing)) {
      unknownKeys(
        value.filing,
        new Set(["maximumNewPerClosures", "closureDenominator"]),
        "filing",
        errors,
      );
      if (
        value.filing.maximumNewPerClosures !== undefined &&
        (!Number.isInteger(value.filing.maximumNewPerClosures) ||
          value.filing.maximumNewPerClosures < 0)
      ) {
        errors.push("filing.maximumNewPerClosures is invalid");
      }
      if (value.filing.closureDenominator !== undefined) {
        positiveInteger(value.filing.closureDenominator, "filing.closureDenominator", errors);
      }
    } else {
      errors.push("filing must be an object");
    }
  }
  return errors;
}

function isContained(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function loadWorkflowRoles(workspace = process.cwd()) {
  let workspaceRealPath;
  try {
    workspaceRealPath = realpathSync(path.resolve(workspace));
  } catch {
    return {
      ok: false,
      source: WORKFLOW_CONFIG_PATH,
      configured: false,
      requiresAcceptance: false,
      workflowHash: null,
      roles: null,
      errors: ["workflow workspace cannot be resolved safely"],
    };
  }
  const configPath = path.join(workspaceRealPath, ...WORKFLOW_CONFIG_PATH.split("/"));
  const githubPath = path.dirname(configPath);
  let githubStats;
  try {
    githubStats = lstatSync(githubPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return {
        ok: false,
        source: WORKFLOW_CONFIG_PATH,
        configured: true,
        requiresAcceptance: true,
        workflowHash: null,
        roles: null,
        errors: ["workflow directory cannot be inspected safely"],
      };
    }
  }
  if (githubStats && (githubStats.isSymbolicLink() || !githubStats.isDirectory())) {
    return {
      ok: false,
      source: WORKFLOW_CONFIG_PATH,
      configured: true,
      requiresAcceptance: true,
      workflowHash: null,
      roles: null,
      errors: ["workflow directory is not a safe local directory"],
    };
  }
  let configStats;
  try {
    configStats = lstatSync(configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return {
        ok: false,
        source: WORKFLOW_CONFIG_PATH,
        configured: true,
        requiresAcceptance: true,
        workflowHash: null,
        roles: null,
        errors: ["workflow configuration cannot be inspected safely"],
      };
    }
    return {
      ok: true,
      source: "bundled-defaults",
      configured: false,
      requiresAcceptance: false,
      workflowHash: null,
      roles: { ...DEFAULT_ROLES },
      reviewPolicy: { ...DEFAULT_REVIEW_POLICY },
      errors: [],
    };
  }

  let workflowHash = null;
  try {
    if (githubStats.isSymbolicLink() || configStats.isSymbolicLink()) {
      throw new Error("workflow path contains a symbolic link or junction");
    }
    if (!githubStats.isDirectory() || !configStats.isFile()) {
      throw new Error("workflow path is not a regular repository file");
    }
    if (configStats.nlink > 1) throw new Error("workflow file has multiple hard links");
    if (configStats.size > MAX_WORKFLOW_BYTES) throw new Error("workflow file exceeds the size limit");
    const configRealPath = realpathSync(configPath);
    if (!isContained(workspaceRealPath, configRealPath)) {
      throw new Error("workflow file resolves outside the workspace");
    }
    const bytes = readFileSync(configRealPath);
    workflowHash = sha256(bytes);
    const workflow = parseWorkflowJson(bytes);
    const errors = validateWorkflowValue(workflow);
    if (errors.length > 0) {
      return {
        ok: false,
        source: WORKFLOW_CONFIG_PATH,
        configured: true,
        requiresAcceptance: true,
        workflowHash,
        roles: null,
        errors,
      };
    }
    const roles = {
      ...DEFAULT_ROLES,
      ...(workflow.roles ?? {}),
    };
    if (workflow.roles === undefined && validSelector(workflow.review.agent)) {
      roles.reviewer = workflow.review.agent;
    }
    return {
      ok: true,
      source: WORKFLOW_CONFIG_PATH,
      configured: true,
      requiresAcceptance: true,
      workflowHash,
      roles,
      reviewPolicy: {
        requiredModel: workflow.review.requiredModel ?? null,
        requiredModelFamily: workflow.review.requiredModelFamily ?? null,
        requireDifferentModelFamily: workflow.review.requireDifferentModelFamily ?? false,
      },
      errors: [],
    };
  } catch (error) {
    return {
      ok: false,
      source: WORKFLOW_CONFIG_PATH,
      configured: true,
      requiresAcceptance: true,
      workflowHash,
      roles: null,
      errors: [`workflow configuration cannot be loaded safely: ${error.message}`],
    };
  }
}

function acceptancePath(workspaceRealPath) {
  return path.join(workspaceRealPath, ...WORKFLOW_ACCEPTANCE_PATH.split("/"));
}

function inspectStateDirectory(workspaceRealPath, create = false) {
  const statePath = path.dirname(acceptancePath(workspaceRealPath));
  let stats;
  try {
    stats = lstatSync(statePath);
  } catch (error) {
    if (error?.code !== "ENOENT" || !create) throw error;
    mkdirSync(statePath, { mode: 0o700 });
    stats = lstatSync(statePath);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("workflow acceptance directory is not a safe local directory");
  }
  const resolved = realpathSync(statePath);
  if (!isContained(workspaceRealPath, resolved)) {
    throw new Error("workflow acceptance directory resolves outside the workspace");
  }
  return statePath;
}

function readWorkflowAcceptance(workspaceRealPath) {
  const filePath = acceptancePath(workspaceRealPath);
  try {
    inspectStateDirectory(workspaceRealPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) {
    throw new Error("workflow acceptance is not a safe regular file");
  }
  if (stats.size > MAX_WORKFLOW_BYTES) throw new Error("workflow acceptance exceeds the size limit");
  const resolved = realpathSync(filePath);
  if (!isContained(workspaceRealPath, resolved)) {
    throw new Error("workflow acceptance resolves outside the workspace");
  }
  const value = parseWorkflowJson(readFileSync(resolved));
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "acceptedAt,schemaVersion,workflowHash" ||
    value.schemaVersion !== 1 ||
    !/^[0-9a-f]{64}$/.test(value.workflowHash ?? "") ||
    !isRfc3339DateTime(value.acceptedAt)
  ) {
    throw new Error("workflow acceptance record is invalid");
  }
  return value;
}

export function resolveWorkflowRoles(
  workspace = process.cwd(),
  { requireAcceptance = false } = {},
) {
  const result = loadWorkflowRoles(workspace);
  if (!result.ok) return { ...result, accepted: false };
  if (!result.configured) return { ...result, accepted: true };
  let acceptance;
  try {
    acceptance = readWorkflowAcceptance(realpathSync(path.resolve(workspace)));
  } catch (error) {
    return {
      ...result,
      ok: false,
      roles: null,
      accepted: false,
      errors: [`workflow acceptance cannot be loaded safely: ${error.message}`],
    };
  }
  const accepted = acceptance?.workflowHash === result.workflowHash;
  if (requireAcceptance && !accepted) {
    return {
      ...result,
      ok: false,
      roles: null,
      accepted: false,
      errors: ["workflow configuration hash has not been explicitly accepted"],
    };
  }
  return { ...result, accepted };
}

export function acceptWorkflowRoles(workspace, expectedHash) {
  if (!/^[0-9a-f]{64}$/.test(expectedHash ?? "")) {
    return { ok: false, accepted: false, errors: ["workflow hash must be a SHA-256 value"] };
  }
  const result = loadWorkflowRoles(workspace);
  if (!result.ok) return { ...result, accepted: false };
  if (!result.configured) {
    return {
      ...result,
      ok: false,
      accepted: false,
      errors: ["bundled default roles do not require acceptance"],
    };
  }
  if (result.workflowHash !== expectedHash) {
    return {
      ...result,
      ok: false,
      accepted: false,
      errors: ["workflow hash does not match the current configuration bytes"],
    };
  }
  try {
    const workspaceRealPath = realpathSync(path.resolve(workspace));
    const statePath = inspectStateDirectory(workspaceRealPath, true);
    const filePath = acceptancePath(workspaceRealPath);
    const assertDestinationSafe = () => {
      try {
        const existing = lstatSync(filePath);
        if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink > 1) {
          throw new Error("workflow acceptance is not a safe regular file");
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    };
    assertDestinationSafe();
    const temporaryPath = path.join(
      statePath,
      `.workflow-acceptance.${process.pid}.${randomUUID()}.tmp`,
    );
    const bytes = `${JSON.stringify({
        schemaVersion: 1,
        workflowHash: expectedHash,
        acceptedAt: new Date().toISOString(),
      }, null, 2)}\n`;
    let descriptor = null;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, bytes, { encoding: "utf8" });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      inspectStateDirectory(workspaceRealPath);
      assertDestinationSafe();
      const current = loadWorkflowRoles(workspace);
      if (!current.ok || current.workflowHash !== expectedHash) {
        throw new Error("workflow configuration changed during acceptance");
      }
      renameSync(temporaryPath, filePath);
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(temporaryPath, { force: true });
      throw error;
    }
    return resolveWorkflowRoles(workspace, { requireAcceptance: true });
  } catch (error) {
    return {
      ...result,
      ok: false,
      roles: null,
      accepted: false,
      errors: [`workflow acceptance cannot be persisted safely: ${error.message}`],
    };
  }
}