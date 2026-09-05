import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { parseWorkflowJson } from "./workflow.mjs";

const MAX_PAGES = 100;
const MAX_ISSUES = 10_000;
const MAX_STREAM_BYTES = 1_048_576;
const MAX_TOTAL_BYTES = 8 * MAX_STREAM_BYTES;
const REQUEST_TIMEOUT_MS = 10_000;
const OVERALL_TIMEOUT_MS = 60_000;
const STATES = Object.freeze({ open: ["OPEN"], closed: ["CLOSED"], all: ["OPEN", "CLOSED"] });
const REASONS = new Set([
  "invalid-input", "gh-unavailable", "authentication-unavailable", "transport-failed",
  "response-invalid", "provider-error", "identity-invalid", "pagination-invalid",
  "limit-exceeded", "timeout", "internal-error",
]);
const OBSERVATION_KEYS = [
  "schemaVersion", "kind", "status", "reason", "scope", "startedAt", "finishedAt",
  "consistency", "integrity", "actor", "repository", "totalCount", "pageCount", "issues",
];
const QUERY = `query QueueInspection($owner: String!, $name: String!, $states: [IssueState!]!, $cursor: String) {
  viewer { id }
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    issues(first: 100, after: $cursor, states: $states, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      nodes { id number state updatedAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const SYSTEM_CLOCK = Object.freeze({ wall: () => Date.now(), monotonic: () => performance.now() });
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class QueueFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function fail(reason) {
  throw new QueueFailure(reason);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shape(value, required, optional = []) {
  return isRecord(value) && required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function validRepository(value) {
  if (typeof value !== "string" || /[\s\p{Cc}]/u.test(value)) return false;
  const parts = value.split("/");
  return parts.length === 2 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(parts[0]) &&
    /^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]) && ![".", ".."].includes(parts[1]);
}

function validInput(value) {
  return shape(value, ["repository", "state"]) && validRepository(value.repository) &&
    typeof value.state === "string" && Object.hasOwn(STATES, value.state);
}

function validScope(value) {
  return shape(value, ["host", "repository", "state"]) && value.host === "github.com" &&
    validInput({ repository: value.repository, state: value.state });
}

function opaque(value, maximum) {
  return typeof value === "string" && value.length <= maximum * 2 &&
    value.trim().length > 0 && [...value].length <= maximum && !/[\p{Cc}\p{Cs}]/u.test(value);
}

function timestamp(value, utc = false) {
  if (typeof value !== "string" || /\s/.test(value)) return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zoneText] = match;
  const zone = zoneText.toUpperCase();
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59 &&
    (!utc || zone === "Z") &&
    (zone === "Z" || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59)) &&
    Number.isFinite(Date.parse(value));
}

function validIssue(value, state) {
  return shape(value, ["id", "number", "state", "updatedAt"]) && opaque(value.id, 512) &&
    Number.isSafeInteger(value.number) && value.number > 0 &&
    STATES[state]?.includes(value.state) === true && timestamp(value.updatedAt);
}

export function validateGitHubQueueObservation(value) {
  if (!shape(value, OBSERVATION_KEYS)) return ["shape-invalid"];
  const errors = [];
  if (value.schemaVersion !== 1) errors.push("version-invalid");
  if (value.kind !== "github-queue-observation" || value.consistency !== "interval-observation" ||
      value.integrity !== "unattested") errors.push("constants-invalid");
  if (!timestamp(value.startedAt, true) || !timestamp(value.finishedAt, true) ||
      Date.parse(value.finishedAt) < Date.parse(value.startedAt)) errors.push("timestamps-invalid");
  if (value.status === "unavailable") {
    if (!REASONS.has(value.reason)) errors.push("status-invalid");
    if (value.reason === "invalid-input" ? value.scope !== null :
      !validScope(value.scope) && !(value.scope === null && value.reason === "internal-error")) {
      errors.push("scope-invalid");
    }
    if (["actor", "repository", "totalCount", "pageCount", "issues"].some((key) => value[key] !== null)) {
      errors.push("unavailable-data-invalid");
    }
    return errors;
  }
  if (value.status !== "complete" || value.reason !== null) errors.push("status-invalid");
  const scopeValid = validScope(value.scope);
  if (!scopeValid) errors.push("scope-invalid");
  if (!shape(value.actor, ["id"]) || !opaque(value.actor.id, 512) ||
      !shape(value.repository, ["id", "nameWithOwner"]) || !opaque(value.repository.id, 512) ||
      !validRepository(value.repository.nameWithOwner) || !scopeValid ||
      value.repository.nameWithOwner.toLowerCase() !== value.scope.repository.toLowerCase()) {
    errors.push("identity-invalid");
  }
  if (!Number.isSafeInteger(value.totalCount) || value.totalCount < 0 || value.totalCount > MAX_ISSUES ||
      !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > MAX_PAGES ||
      value.totalCount > value.pageCount * 100 || value.pageCount > Math.max(1, value.totalCount)) {
    errors.push("counts-invalid");
  }
  if (!Array.isArray(value.issues) || value.issues.length > MAX_ISSUES ||
      value.issues.length !== value.totalCount || !scopeValid) {
    errors.push("issues-invalid");
  } else {
    const ids = new Set();
    let previous = 0;
    for (const issue of value.issues) {
      if (!validIssue(issue, value.scope.state) || ids.has(issue.id) || issue.number <= previous) {
        errors.push("issues-invalid");
        break;
      }
      ids.add(issue.id);
      previous = issue.number;
    }
  }
  return errors;
}

function contained(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function binaryExecutable(candidate) {
  const descriptor = openSync(candidate, "r");
  try {
    const header = Buffer.alloc(4);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) return false;
    if (process.platform === "win32") {
      return path.extname(candidate).toLowerCase() === ".exe" && header[0] === 0x4d && header[1] === 0x5a;
    }
    return ["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]
      .includes(header.toString("hex"));
  } finally {
    closeSync(descriptor);
  }
}

function resolveGhExecutable() {
  const workspace = realpathSync(process.cwd());
  const plugin = realpathSync(PLUGIN_ROOT);
  const executableName = process.platform === "win32" ? "gh.exe" : "gh";
  for (const rawEntry of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) {
    const trimmed = rawEntry.trim();
    const entry = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
    if (!path.isAbsolute(entry) || (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(entry))) continue;
    const candidate = path.join(entry, executableName);
    try {
      const resolved = realpathSync(candidate);
      if ([workspace, plugin].some((directory) => contained(directory, candidate) || contained(directory, resolved)) ||
          !lstatSync(resolved).isFile() || /\.(?:cmd|bat|sh|bash|ps1)$/i.test(resolved)) continue;
      accessSync(resolved, constants.X_OK);
      if (binaryExecutable(resolved)) return resolved;
    } catch {
      continue;
    }
  }
  fail("gh-unavailable");
}

function ghEnvironment(executable) {
  const allowed = new Set([
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR",
    "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN",
    "TMPDIR", "TMP", "TEMP",
  ]);
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toUpperCase())) environment[key.toUpperCase()] = value;
  }
  return {
    ...environment,
    PATH: path.dirname(executable),
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_NO_ANALYTICS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GH_PAGER: "",
    PAGER: "",
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

function requestGitHub({ query, variables, timeout }) {
  const executable = resolveGhExecutable();
  return spawnSync(executable, ["api", "graphql", "--hostname", "github.com", "--method", "POST", "--input", "-"], {
    shell: false,
    cwd: path.dirname(executable),
    env: ghEnvironment(executable),
    input: JSON.stringify({ query, variables }),
    encoding: null,
    stdio: ["pipe", "pipe", "pipe"],
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 2 * MAX_STREAM_BYTES,
    windowsHide: true,
  });
}

function validProviderErrors(value) {
  return shape(value, ["errors"], ["data"]) && Array.isArray(value.errors) && value.errors.length > 0 &&
    value.errors.every((error) => shape(error, ["message"], ["type", "path", "locations", "extensions"]) &&
      typeof error.message === "string" && error.message.trim().length > 0 &&
      (error.type === undefined || typeof error.type === "string") &&
      (error.path === undefined || (Array.isArray(error.path) && error.path.every((part) =>
        typeof part === "string" || (Number.isSafeInteger(part) && part >= 0)))) &&
      (error.locations === undefined || (Array.isArray(error.locations) && error.locations.every((location) =>
        shape(location, ["line", "column"]) && Number.isSafeInteger(location.line) && location.line > 0 &&
        Number.isSafeInteger(location.column) && location.column > 0))) &&
      (error.extensions === undefined || isRecord(error.extensions)));
}

function readResponse(result, budget) {
  if (!isRecord(result) || [result.stdout, result.stderr].some((stream) => stream != null && !Buffer.isBuffer(stream))) {
    fail("transport-failed");
  }
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  if (stdout.length > MAX_STREAM_BYTES || stderr.length > MAX_STREAM_BYTES || stdout.length > budget) fail("limit-exceeded");
  if (result.error) {
    const code = result.error.code;
    if (code === "ETIMEDOUT") fail("timeout");
    if (code === "ENOBUFS") fail("limit-exceeded");
    if (["ENOENT", "EACCES", "EPERM", "ENOEXEC"].includes(code)) fail("gh-unavailable");
    fail("transport-failed");
  }
  if (result.signal != null) fail("transport-failed");
  if (result.status === 4) fail("authentication-unavailable");
  let payload;
  try {
    payload = parseWorkflowJson(stdout);
  } catch {
    fail(result.status === 0 ? "response-invalid" : "transport-failed");
  }
  if (isRecord(payload) && Object.hasOwn(payload, "errors")) {
    fail(validProviderErrors(payload) ? "provider-error" : "response-invalid");
  }
  if (result.status !== 0) fail("transport-failed");
  if (!shape(payload, ["data"]) || !shape(payload.data, ["viewer", "repository"])) fail("response-invalid");
  return { data: payload.data, bytes: stdout.length };
}

function wallTime(clock) {
  const milliseconds = clock.wall();
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) fail("internal-error");
  const value = new Date(milliseconds).toISOString();
  if (!timestamp(value, true)) fail("internal-error");
  return value;
}

export function inspectGitHubQueue(input, { transport = requestGitHub, clock = SYSTEM_CLOCK } = {}) {
  let scope = null;
  let startedAt;
  let finishedAt;
  let reason = null;
  let complete = null;
  try {
    startedAt = wallTime(clock);
    if (!validInput(input)) fail("invalid-input");
    scope = { host: "github.com", repository: input.repository, state: input.state };
    let lastTick = -Infinity;
    const tick = () => {
      const current = clock.monotonic();
      if (typeof current !== "number" || !Number.isFinite(current) || current < lastTick) fail("internal-error");
      lastTick = current;
      return current;
    };
    const deadline = tick() + OVERALL_TIMEOUT_MS;
    const [owner, name] = input.repository.split("/");
    const ids = new Set();
    const numbers = new Set();
    const cursors = new Set();
    const issues = [];
    let actor = null;
    let repository = null;
    let totalCount = null;
    let pageCount = 0;
    let bytes = 0;
    let cursor = null;
    while (true) {
      if (pageCount === MAX_PAGES || bytes === MAX_TOTAL_BYTES) fail("limit-exceeded");
      const beforeRequest = tick();
      const timeout = Math.min(REQUEST_TIMEOUT_MS, Math.floor(deadline - beforeRequest));
      if (timeout < 1) fail("timeout");
      let response;
      try {
        response = transport({ query: QUERY, variables: { owner, name, states: [...STATES[input.state]], cursor }, timeout });
      } catch (error) {
        if (error instanceof QueueFailure) throw error;
        fail("transport-failed");
      }
      const afterRequest = tick();
      if (afterRequest >= deadline || afterRequest - beforeRequest >= timeout) fail("timeout");
      const page = readResponse(response, MAX_TOTAL_BYTES - bytes);
      bytes += page.bytes;
      const { viewer, repository: currentRepository } = page.data;
      if (viewer === null) fail("authentication-unavailable");
      if (!shape(viewer, ["id"]) || !opaque(viewer.id, 512) ||
          !shape(currentRepository, ["id", "nameWithOwner", "issues"]) || !opaque(currentRepository.id, 512) ||
          !validRepository(currentRepository.nameWithOwner) ||
          currentRepository.nameWithOwner.toLowerCase() !== scope.repository.toLowerCase()) fail("identity-invalid");
      if (actor && (actor.id !== viewer.id || repository.id !== currentRepository.id ||
          repository.nameWithOwner.toLowerCase() !== currentRepository.nameWithOwner.toLowerCase())) fail("identity-invalid");
        actor ??= { id: viewer.id };
        repository ??= { id: currentRepository.id, nameWithOwner: currentRepository.nameWithOwner };
      const connection = currentRepository.issues;
      if (!shape(connection, ["totalCount", "nodes", "pageInfo"]) ||
          !Number.isSafeInteger(connection.totalCount) || connection.totalCount < 0 ||
          !Array.isArray(connection.nodes) || connection.nodes.length > 100 ||
          !shape(connection.pageInfo, ["hasNextPage", "endCursor"]) ||
          typeof connection.pageInfo.hasNextPage !== "boolean") fail("response-invalid");
      if (connection.totalCount > MAX_ISSUES) fail("limit-exceeded");
      if (totalCount !== null && totalCount !== connection.totalCount) fail("pagination-invalid");
      totalCount = connection.totalCount;
      const { hasNextPage, endCursor } = connection.pageInfo;
      if ((endCursor !== null && !opaque(endCursor, 4096)) ||
          (connection.nodes.length > 0 && endCursor === null) ||
          (endCursor !== null && (endCursor === cursor || cursors.has(endCursor))) ||
          (connection.nodes.length === 0 && (hasNextPage || endCursor !== null))) fail("pagination-invalid");
      for (const issue of connection.nodes) {
        if (!validIssue(issue, scope.state)) fail("response-invalid");
        if (ids.has(issue.id) || numbers.has(issue.number)) fail("pagination-invalid");
        ids.add(issue.id);
        numbers.add(issue.number);
        issues.push({ id: issue.id, number: issue.number, state: issue.state, updatedAt: issue.updatedAt });
      }
      pageCount += 1;
      if (issues.length > MAX_ISSUES) fail("limit-exceeded");
      if (issues.length > totalCount || hasNextPage !== (issues.length < totalCount)) fail("pagination-invalid");
      if (tick() >= deadline) fail("timeout");
      if (!hasNextPage) {
        complete = { actor, repository, totalCount, pageCount, issues: issues.sort((left, right) => left.number - right.number) };
        if (tick() >= deadline) fail("timeout");
        break;
      }
      cursors.add(endCursor);
      cursor = endCursor;
    }
  } catch (error) {
    reason = error instanceof QueueFailure ? error.reason : "internal-error";
  }
  try {
    finishedAt = wallTime(clock);
    if (!timestamp(startedAt, true) || Date.parse(finishedAt) < Date.parse(startedAt)) fail("internal-error");
  } catch {
    startedAt = new Date().toISOString();
    finishedAt = startedAt;
    reason = "internal-error";
  }
  const observation = {
    schemaVersion: 1,
    kind: "github-queue-observation",
    status: reason === null ? "complete" : "unavailable",
    reason,
    scope,
    startedAt,
    finishedAt,
    consistency: "interval-observation",
    integrity: "unattested",
    actor: null,
    repository: null,
    totalCount: null,
    pageCount: null,
    issues: null,
    ...(reason === null ? complete : {}),
  };
  if (validateGitHubQueueObservation(observation).length > 0) {
    Object.assign(observation, { status: "unavailable", reason: "internal-error", actor: null, repository: null,
      totalCount: null, pageCount: null, issues: null });
  }
  return observation;
}