import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export const STATE_DIRECTORY = ".supervised-worker";
export const PLAN_FILE = "plan.json";
export const MAX_SAME_PROGRESS_BLOCKS = 2;
export const MAX_SESSION_BLOCKS = 6;
export const MAX_PLAN_BYTES = 1_048_576;

const ITEM_STATUSES = new Set(["pending", "in_progress", "banked", "parked"]);
const PLAN_MODES = new Set(["active", "complete", "inactive"]);
const PLAN_KEYS = new Set(["schemaVersion", "mode", "goal", "items", "completion"]);
const ITEM_KEYS = new Set(["id", "title", "status", "resumeWhen"]);
const COMPLETION_KEYS = new Set(["enumeration", "evidence"]);
const ENUMERATION_KEYS = new Set(["status", "source", "checkedAt", "remainingActionable"]);
const EVIDENCE_KEYS = new Set(["kind", "locator", "sha256"]);
export const PLAN_WRITER_TOOLS = new Set([
  "apply_patch",
  "create",
  "create_file",
  "edit",
  "insert",
  "insert_edit_into_file",
  "multi_replace_string_in_file",
  "replace_string_in_file",
  "str_replace_editor",
  "write",
]);
const PATH_KEYS = new Set(["filePath", "file_path", "path"]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
      if (error?.code === "ENOENT") break;
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
    if (!existsSync(currentPath)) mkdirSync(currentPath, { mode: 0o700 });
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
  if (
    attachment?.schemaVersion !== 1 ||
    !/^[0-9a-f]{64}$/.test(attachment?.sessionHash ?? "") ||
    !isDateTime(attachment?.attachedAt)
  ) {
    throw new Error("session attachment is invalid");
  }
  return attachment;
}

function isAttached(cwd, input) {
  const expected = sessionHash(input);
  return expected !== null && readAttachment(cwd)?.sessionHash === expected;
}

function pathEquals(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function toolTouchesPlan(input, cwd) {
  const rawToolName = input?.tool_name ?? input?.toolName ?? "";
  const toolName = rawToolName.toLowerCase().split(/[./]/).at(-1);
  if (!PLAN_WRITER_TOOLS.has(toolName)) {
    return false;
  }
  const toolInput = input?.tool_input ?? input?.toolArgs ?? input?.toolInput;
  const candidates = [];
  if (toolInput && typeof toolInput === "object") {
    const pending = [toolInput];
    const seen = new WeakSet();
    while (pending.length > 0) {
      const value = pending.pop();
      if (Array.isArray(value)) {
        if (seen.has(value)) continue;
        seen.add(value);
        pending.push(...value);
        continue;
      }
      if (!value || typeof value !== "object") continue;
      if (seen.has(value)) continue;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (PATH_KEYS.has(key) && typeof child === "string") candidates.push(child);
        else if (child && typeof child === "object") pending.push(child);
      }
    }
  }
  if (candidates.some((candidate) =>
    pathEquals(path.isAbsolute(candidate) ? candidate : path.join(cwd, candidate), planPath(cwd)),
  )) {
    return true;
  }
  if (toolName === "apply_patch" || toolName === "edit") {
    const patchTexts = [
      typeof toolInput === "string" ? toolInput : null,
      toolInput?.input,
      toolInput?.patch,
      toolInput?.raw,
    ].filter((value) => typeof value === "string");
    const targets = patchTexts.flatMap((patchText) =>
      patchText.split(/\r?\n/).flatMap((line) => {
        const fileHeader = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+?)\s*$/)?.[1];
        if (fileHeader) return fileHeader.split(/\s+->\s+/);
        const moveHeader = line.match(/^\*\*\* Move to:\s+(.+?)\s*$/)?.[1];
        return moveHeader ? [moveHeader] : [];
      }),
    );
    return targets.some((target) =>
      pathEquals(path.isAbsolute(target) ? target : path.join(cwd, target), planPath(cwd)),
    );
  }
  return false;
}

function claimSession(cwd, input) {
  const hash = sessionHash(input);
  if (hash === null) return { claimed: false, conflict: false };
  const filePath = attachmentPath(cwd);
  assertSafeStatePath(cwd, filePath);
  ensureSafeDirectory(cwd, path.dirname(filePath));
  const record = {
    schemaVersion: 1,
    sessionHash: hash,
    attachedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return { claimed: true, conflict: false };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readAttachment(cwd);
    if (existing?.sessionHash === hash) return { claimed: true, conflict: false };
    return { claimed: false, conflict: true };
  }
}

function removeStateFile(cwd, filePath) {
  assertSafeStatePath(cwd, filePath);
  rmSync(filePath, { force: true });
}

function detachSession(cwd, input) {
  if (isAttached(cwd, input)) removeStateFile(cwd, attachmentPath(cwd));
}

function bestEffortDetach(cwd, input) {
  try {
    detachSession(cwd, input);
  } catch {
    // The visible hook response carries the failure; never follow an unsafe path.
  }
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
      value.schemaVersion === 1 &&
      /^[0-9a-f]{64}$/.test(value.progressHash ?? "") &&
      Number.isInteger(value.sameProgressBlocks) &&
      value.sameProgressBlocks >= 0 &&
      Number.isInteger(value.totalBlocks) &&
      value.totalBlocks >= 0,
  );
}

function releaseStop(cwd, input, event, detail, output) {
  try {
    appendLedger(cwd, input, event, detail);
  } finally {
    try {
      removeStateFile(cwd, runtimeStatePath(cwd, input));
    } catch {
      // Best effort cleanup; the attachment is still removed below.
    }
    bestEffortDetach(cwd, input);
  }
  return output;
}

function handleStop(input, cwd) {
  if (!isAttached(cwd, input)) return {};
  const planResult = loadPlan(cwd);
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
      { planHash: sha256(JSON.stringify(planResult.plan)) },
      {},
    );
  }

  const filePath = runtimeStatePath(cwd, input);
  const progressHash = sha256(JSON.stringify(planResult.plan ?? planResult.errors));
  let state = {
    schemaVersion: 1,
    progressHash,
    sameProgressBlocks: 0,
    totalBlocks: 0,
  };
  assertSafeStatePath(cwd, filePath);
  let stateWasInvalid = false;
  if (existsSync(filePath)) {
    try {
      const candidate = readJson(cwd, filePath);
      if (validRuntimeState(candidate)) state = candidate;
      else stateWasInvalid = true;
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
      schemaVersion: 1,
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
    (recursiveStop && state.totalBlocks === 0) ||
    state.sameProgressBlocks >= MAX_SAME_PROGRESS_BLOCKS ||
    state.totalBlocks >= MAX_SESSION_BLOCKS
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
    state.sameProgressBlocks >= MAX_SAME_PROGRESS_BLOCKS ||
    state.totalBlocks >= MAX_SESSION_BLOCKS
      ? `${stopReason(planResult)} This is the final bounded continuation before an unchanged Stop is released. If no measurable progress is possible, the final response must state that queue completion remains unverified.`
      : stopReason(planResult);
  return blockOutput(input, "Stop", reason);
}

function handleHookUnsafe(input, eventName, cwd) {
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
      if (!toolTouchesPlan(input, cwd)) return {};
      assertSafeStatePath(cwd, planPath(cwd));
      if (sessionHash(input) === null) {
        return preToolDecision(
          input,
          "deny",
          "Supervised Worker cannot establish plan ownership because this hook payload has no session identifier.",
        );
      }
      const claim = claimSession(cwd, input);
      if (claim.conflict) {
        return preToolDecision(
          input,
          "deny",
          "Another Copilot session owns .supervised-worker/plan.json. Confirm that session is stale, then run the plugin helper's `release` command from this repository before retrying.",
        );
      }
      return {};
    }
    case "PostToolUse": {
      if (toolTouchesPlan(input, cwd)) {
        assertSafeStatePath(cwd, planPath(cwd));
        if (sessionHash(input) === null) {
          return contextOutput(
            input,
            "PostToolUse",
            "Supervised Worker could not attach this plan write because the hook payload had no session identifier. Do not rely on Stop governance for this run.",
          );
        }
        const claim = claimSession(cwd, input);
        if (claim.conflict) {
          return contextOutput(
            input,
            "PostToolUse",
            "Supervised Worker did not attach this session because another session owns the durable plan. Do not continue that campaign. Ask the user to run the plugin helper's `release` command from the target repository only after confirming the prior session is stale.",
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
      if (toolTouchesPlan(input, cwd) && !existsSync(planPath(cwd))) {
        bestEffortDetach(cwd, input);
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

export function handleHook(input, eventName, cwd = input?.cwd ?? process.cwd()) {
  try {
    return handleHookUnsafe(input, eventName, cwd);
  } catch {
    if (eventName === "Stop") bestEffortDetach(cwd, input);
    if (eventName === "PreToolUse") {
      return preToolDecision(
        input,
        "deny",
        "Supervised Worker could not verify plan ownership, so the plan write was denied.",
      );
    }
    const reason =
      "Supervised Worker could not verify its local state and allowed this hook to fail open visibly. Do not rely on this run as queue completion.";
    return eventName === "Stop"
      ? allowStopOutput(input, reason)
      : {
          ...contextOutput(input, eventName, reason),
          systemMessage: reason,
        };
  }
}

export function releaseAttachment(cwd) {
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