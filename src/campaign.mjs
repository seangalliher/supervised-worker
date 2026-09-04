import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import {
  canonicalPlanHash,
  MAX_PLAN_BYTES,
  planPath,
  sha256,
  summarizeRunLedger,
  validatePlan,
} from "./core.mjs";
import { resolvePluginSourceIdentity } from "./install.mjs";
import { parseWorkflowJson } from "./workflow.mjs";

const MAX_RECEIPT_BYTES = 1_048_576;
const ITEM_STATUSES = ["pending", "in_progress", "banked", "parked"];
const LEDGER_EVENTS = [
  "completion_unverified_release",
  "completion_verified",
  "ownership_cleanup_failed",
  "plan_inactive",
  "pre_compact",
  "provisional_claim_released",
  "stop_blocked",
  "tool_completed",
];
const PROVIDER_FACTS = Object.freeze({
  repository: "provider-repository-verification-unavailable",
  queue: "provider-queue-verification-unavailable",
  remote: "provider-remote-verification-unavailable",
  pullRequests: "provider-pull-request-verification-unavailable",
  ci: "provider-ci-verification-unavailable",
  reviewer: "provider-reviewer-attestation-unavailable",
  closures: "provider-closure-verification-unavailable",
});
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "kind",
  "scope",
  "localDataStatus",
  "plugin",
  "plan",
  "runLedger",
  "providerFacts",
];
const PLAN_KEYS = [
  "status",
  "provenance",
  "integrity",
  "reason",
  "hash",
  "mode",
  "localCompletionShape",
  "counts",
  "items",
];
const RUN_LEDGER_KEYS = [
  "status",
  "provenance",
  "integrity",
  "reason",
  "hash",
  "sessionCount",
  "recordCount",
  "eventCounts",
  "firstObservedAt",
  "lastObservedAt",
];

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

// RegExp.test coerces its argument, so every published string field checks its type first.
function hexDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function pathEquals(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function pathWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function workspaceRoot(cwd) {
  const resolved = path.resolve(cwd);
  const stats = lstatSync(resolved);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !pathEquals(resolved, realpathSync(resolved))
  ) {
    throw new Error("workspace root is not canonical");
  }
  return resolved;
}

function sameStats(left, right) {
  return ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]
    .every((key) => left[key] === right[key]);
}

function unavailablePlan(reason) {
  return {
    status: "unavailable",
    provenance: "worker-recorded-local",
    integrity: "plugin-verified-local",
    reason,
    hash: null,
    mode: null,
    localCompletionShape: null,
    counts: null,
    items: null,
  };
}

function inspectPlan(cwd) {
  const filePath = planPath(cwd);
  if (!existsSync(filePath)) return unavailablePlan("plan-absent");
  let before;
  try {
    safeReceiptPath(cwd, filePath);
    before = lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_PLAN_BYTES)
    ) {
      return unavailablePlan("plan-invalid");
    }
    let descriptor;
    let opened;
    let bytes;
    let afterRead;
    try {
      descriptor = openSync(filePath, "r");
      opened = fstatSync(descriptor, { bigint: true });
      if (!sameStats(before, opened)) return unavailablePlan("plan-changed-during-read");
      bytes = readFileSync(descriptor);
      afterRead = fstatSync(descriptor, { bigint: true });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    let after;
    try {
      after = lstatSync(filePath, { bigint: true });
      safeReceiptPath(cwd, filePath);
    } catch {
      return unavailablePlan("plan-changed-during-read");
    }
    if (
      !sameStats(opened, afterRead) ||
      !sameStats(afterRead, after) ||
      bytes.length !== Number(afterRead.size)
    ) {
      return unavailablePlan("plan-changed-during-read");
    }
    let plan;
    try {
      plan = parseWorkflowJson(bytes);
    } catch {
      return unavailablePlan("plan-invalid");
    }
    if (validatePlan(plan).length > 0) return unavailablePlan("plan-invalid");
    const counts = Object.fromEntries(
      ITEM_STATUSES.map((status) => [
        status,
        plan.items.filter((item) => item.status === status).length,
      ]),
    );
    const items = plan.items
      .map((item) => ({
        itemHash: sha256(Buffer.concat([
          Buffer.from("supervised-worker-item-v1\0", "utf8"),
          Buffer.from(item.id, "utf8"),
        ])),
        status: item.status,
      }))
      .sort((left, right) => left.itemHash < right.itemHash ? -1 : left.itemHash > right.itemHash ? 1 : 0);
    return {
      status: "available",
      provenance: "worker-recorded-local",
      integrity: "plugin-verified-local",
      reason: null,
      hash: canonicalPlanHash(plan),
      mode: plan.mode,
      localCompletionShape: plan.mode === "complete",
      counts,
      items,
    };
  } catch (error) {
    return unavailablePlan(
      before === undefined && error?.code !== "ENOENT"
        ? "plan-invalid"
        : "plan-changed-during-read",
    );
  }
}

function providerFacts() {
  return Object.fromEntries(
    Object.entries(PROVIDER_FACTS).map(([name, reason]) => [
      name,
      { status: "unavailable", value: null, reason },
    ]),
  );
}

export function createLocalCampaignReceipt(cwd, pluginRoot) {
  const workspace = workspaceRoot(cwd);
  const plugin = resolvePluginSourceIdentity(pluginRoot);
  const plan = inspectPlan(workspace);
  const runLedger = summarizeRunLedger(workspace);
  return {
    schemaVersion: 1,
    kind: "local-campaign-receipt",
    scope: "current-workspace-local-alpha",
    localDataStatus:
      plan.status === "available" && runLedger.status === "available"
        ? "available"
        : "partial",
    plugin,
    plan,
    runLedger,
    providerFacts: providerFacts(),
  };
}

function validatePlugin(plugin, errors) {
  if (!hasExactKeys(plugin, ["version", "sourceHash", "sourceKind", "provenance"])) {
    errors.push("plugin must contain exactly the local identity fields");
    return;
  }
  if (
    typeof plugin.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(plugin.version) ||
    plugin.version.includes("..")
  ) {
    errors.push("plugin.version is invalid");
  }
  if (!hexDigest(plugin.sourceHash)) {
    errors.push("plugin.sourceHash is invalid");
  }
  if (!["checkout-tree", "immutable-install-record"].includes(plugin.sourceKind)) {
    errors.push("plugin.sourceKind is invalid");
  }
  if (plugin.provenance !== "plugin-verified-local") {
    errors.push("plugin.provenance is invalid");
  }
}

function validatePlanReceipt(plan, errors) {
  if (!hasExactKeys(plan, PLAN_KEYS)) {
    errors.push("plan must contain exactly the local plan fields");
    return;
  }
  if (
    plan.provenance !== "worker-recorded-local" ||
    plan.integrity !== "plugin-verified-local"
  ) {
    errors.push("plan provenance is invalid");
  }
  if (plan.status === "unavailable") {
    if (!["plan-absent", "plan-invalid", "plan-changed-during-read"].includes(plan.reason)) {
      errors.push("unavailable plan reason is invalid");
    }
    for (const key of ["hash", "mode", "localCompletionShape", "counts", "items"]) {
      if (plan[key] !== null) errors.push(`unavailable plan ${key} must be null`);
    }
    return;
  }
  if (plan.status !== "available") {
    errors.push("plan.status is invalid");
    return;
  }
  if (plan.reason !== null) errors.push("available plan reason must be null");
  if (!hexDigest(plan.hash)) errors.push("plan.hash is invalid");
  if (!["active", "complete", "inactive"].includes(plan.mode)) errors.push("plan.mode is invalid");
  if (typeof plan.localCompletionShape !== "boolean") {
    errors.push("plan.localCompletionShape must be boolean");
  }
  if (plan.localCompletionShape !== (plan.mode === "complete")) {
    errors.push("plan.localCompletionShape is inconsistent with mode");
  }
  if (!hasExactKeys(plan.counts, ITEM_STATUSES)) {
    errors.push("plan.counts is invalid");
    return;
  }
  if (ITEM_STATUSES.some((status) => !Number.isInteger(plan.counts[status]) || plan.counts[status] < 0)) {
    errors.push("plan.counts must contain nonnegative integers");
  }
  if (!Array.isArray(plan.items)) {
    errors.push("plan.items must be an array");
    return;
  }
  let previousHash = null;
  const observed = Object.fromEntries(ITEM_STATUSES.map((status) => [status, 0]));
  for (const item of plan.items) {
    if (
      !hasExactKeys(item, ["itemHash", "status"]) ||
      !hexDigest(item.itemHash) ||
      !ITEM_STATUSES.includes(item.status)
    ) {
      errors.push("plan item is invalid");
      continue;
    }
    if (previousHash !== null && previousHash >= item.itemHash) {
      errors.push("plan item hashes must be unique and sorted");
    }
    previousHash = item.itemHash;
    observed[item.status] += 1;
  }
  for (const status of ITEM_STATUSES) {
    if (observed[status] !== plan.counts[status]) {
      errors.push("plan item counts do not match plan.counts");
      break;
    }
  }
}

function normalizedUtc(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function validateRunLedger(runLedger, errors) {
  if (!hasExactKeys(runLedger, RUN_LEDGER_KEYS)) {
    errors.push("runLedger must contain exactly the local ledger fields");
    return;
  }
  if (
    runLedger.provenance !== "worker-recorded-local" ||
    runLedger.integrity !== "plugin-verified-local"
  ) {
    errors.push("runLedger provenance is invalid");
  }
  if (runLedger.status === "unavailable") {
    if (![
      "run-ledger-absent",
      "run-ledger-invalid",
      "run-ledger-limit-exceeded",
      "run-ledger-changed-during-read",
    ].includes(runLedger.reason)) {
      errors.push("unavailable runLedger reason is invalid");
    }
    for (const key of [
      "hash",
      "sessionCount",
      "recordCount",
      "eventCounts",
      "firstObservedAt",
      "lastObservedAt",
    ]) {
      if (runLedger[key] !== null) errors.push(`unavailable runLedger ${key} must be null`);
    }
    return;
  }
  if (runLedger.status !== "available") {
    errors.push("runLedger.status is invalid");
    return;
  }
  if (runLedger.reason !== null) errors.push("available runLedger reason must be null");
  if (!hexDigest(runLedger.hash)) errors.push("runLedger.hash is invalid");
  if (
    !Number.isInteger(runLedger.sessionCount) ||
    runLedger.sessionCount < 0 ||
    runLedger.sessionCount > 256 ||
    !Number.isInteger(runLedger.recordCount) ||
    runLedger.recordCount < 0
  ) {
    errors.push("runLedger counts are invalid");
  }
  if ((runLedger.sessionCount === 0) !== (runLedger.recordCount === 0)) {
    errors.push("runLedger session and record counts are inconsistent");
  }
  if (!Array.isArray(runLedger.eventCounts)) {
    errors.push("runLedger.eventCounts must be an array");
    return;
  }
  let previousEvent = null;
  let total = 0;
  for (const entry of runLedger.eventCounts) {
    if (
      !hasExactKeys(entry, ["event", "count"]) ||
      !LEDGER_EVENTS.includes(entry.event) ||
      !Number.isInteger(entry.count) ||
      entry.count < 1
    ) {
      errors.push("runLedger event count is invalid");
      continue;
    }
    if (previousEvent !== null && previousEvent >= entry.event) {
      errors.push("runLedger events must be unique and sorted");
    }
    previousEvent = entry.event;
    total += entry.count;
  }
  if (total !== runLedger.recordCount) {
    errors.push("runLedger event counts must total recordCount");
  }
  if (runLedger.recordCount === 0) {
    if (runLedger.firstObservedAt !== null || runLedger.lastObservedAt !== null) {
      errors.push("empty runLedger observation bounds must be null");
    }
  } else if (
    !normalizedUtc(runLedger.firstObservedAt) ||
    !normalizedUtc(runLedger.lastObservedAt) ||
    runLedger.firstObservedAt > runLedger.lastObservedAt
  ) {
    errors.push("runLedger observation bounds are invalid");
  }
}

function validateProviderFacts(facts, errors) {
  const names = Object.keys(PROVIDER_FACTS);
  if (!hasExactKeys(facts, names)) {
    errors.push("providerFacts must contain exactly the unavailable provider fields");
    return;
  }
  for (const [name, reason] of Object.entries(PROVIDER_FACTS)) {
    const fact = facts[name];
    if (
      !hasExactKeys(fact, ["status", "value", "reason"]) ||
      fact.status !== "unavailable" ||
      fact.value !== null ||
      fact.reason !== reason
    ) {
      errors.push(`providerFacts.${name} must remain unavailable`);
    }
  }
}

export function validateLocalCampaignReceipt(receipt) {
  const errors = [];
  if (!hasExactKeys(receipt, TOP_LEVEL_KEYS)) {
    return ["receipt must contain exactly the local campaign receipt fields"];
  }
  if (receipt.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (receipt.kind !== "local-campaign-receipt") errors.push("kind is invalid");
  if (receipt.scope !== "current-workspace-local-alpha") errors.push("scope is invalid");
  if (!["available", "partial"].includes(receipt.localDataStatus)) {
    errors.push("localDataStatus is invalid");
  }
  validatePlugin(receipt.plugin, errors);
  validatePlanReceipt(receipt.plan, errors);
  validateRunLedger(receipt.runLedger, errors);
  validateProviderFacts(receipt.providerFacts, errors);
  const expectedStatus =
    receipt.plan?.status === "available" && receipt.runLedger?.status === "available"
      ? "available"
      : "partial";
  if (receipt.localDataStatus !== expectedStatus) {
    errors.push("localDataStatus is inconsistent with local sources");
  }
  return errors;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map((entry) => sortValue(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
  );
}

function canonicalReceipt(receipt) {
  return JSON.stringify(sortValue(receipt));
}

function receiptHash(receipt) {
  return sha256(canonicalReceipt(receipt));
}

export function serializeLocalCampaignReceipt(receipt) {
  if (validateLocalCampaignReceipt(receipt).length > 0) {
    throw new Error("local campaign receipt is invalid");
  }
  return `${JSON.stringify(sortValue(receipt), null, 2)}\n`;
}

function markdownEscape(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("|", "\\|")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function markdownValue(value) {
  return `\`${markdownEscape(value === null ? "null" : value)}\``;
}

function markdownLocalValue(status, value) {
  return status === "unavailable" && value === null ? "Unavailable" : markdownValue(value);
}

export function renderLocalCampaignReceiptMarkdown(receipt) {
  if (validateLocalCampaignReceipt(receipt).length > 0) {
    throw new Error("local campaign receipt is invalid");
  }
  const lines = [
    "# Local Campaign Receipt",
    "",
    "**Local-only, not Provider-Verified Completion**",
    "",
    "## Receipt",
    `- Schema version: ${markdownValue(receipt.schemaVersion)}`,
    `- Kind: ${markdownValue(receipt.kind)}`,
    `- Scope: ${markdownValue(receipt.scope)}`,
    `- Local data status: ${markdownValue(receipt.localDataStatus)}`,
    "",
    "## Plugin",
    `- Version: ${markdownValue(receipt.plugin.version)}`,
    `- Source hash: ${markdownValue(receipt.plugin.sourceHash)}`,
    `- Source kind: ${markdownValue(receipt.plugin.sourceKind)}`,
    `- Provenance: ${markdownValue(receipt.plugin.provenance)}`,
    "",
    "## Plan",
    `- Status: ${markdownValue(receipt.plan.status)}`,
    `- Provenance: ${markdownValue(receipt.plan.provenance)}`,
    `- Integrity: ${markdownValue(receipt.plan.integrity)}`,
    `- Reason: ${markdownValue(receipt.plan.reason)}`,
    `- Hash: ${markdownLocalValue(receipt.plan.status, receipt.plan.hash)}`,
    `- Mode: ${markdownLocalValue(receipt.plan.status, receipt.plan.mode)}`,
    `- Local completion shape: ${markdownLocalValue(receipt.plan.status, receipt.plan.localCompletionShape)}`,
  ];
  if (receipt.plan.counts === null) {
    lines.push("- Counts: Unavailable", "- Items: Unavailable");
  } else {
    for (const status of ITEM_STATUSES) {
      lines.push(`- ${status}: ${markdownValue(receipt.plan.counts[status])}`);
    }
    lines.push("", "### Plan Items", "", "| Item hash | Status |", "| --- | --- |");
    for (const item of receipt.plan.items) {
      lines.push(`| ${markdownEscape(item.itemHash)} | ${markdownEscape(item.status)} |`);
    }
    if (receipt.plan.items.length === 0) lines.push("| None observed | None observed |");
  }
  lines.push(
    "",
    "## Run Ledger",
    `- Status: ${markdownValue(receipt.runLedger.status)}`,
    `- Provenance: ${markdownValue(receipt.runLedger.provenance)}`,
    `- Integrity: ${markdownValue(receipt.runLedger.integrity)}`,
    `- Reason: ${markdownValue(receipt.runLedger.reason)}`,
    `- Hash: ${markdownLocalValue(receipt.runLedger.status, receipt.runLedger.hash)}`,
    `- Session count: ${markdownLocalValue(receipt.runLedger.status, receipt.runLedger.sessionCount)}`,
    `- Record count: ${markdownLocalValue(receipt.runLedger.status, receipt.runLedger.recordCount)}`,
    `- First observed at: ${markdownLocalValue(receipt.runLedger.status, receipt.runLedger.firstObservedAt)}`,
    `- Last observed at: ${markdownLocalValue(receipt.runLedger.status, receipt.runLedger.lastObservedAt)}`,
  );
  if (receipt.runLedger.eventCounts === null) {
    lines.push("- Event counts: Unavailable");
  } else {
    lines.push("", "### Event Counts", "", "| Event | Count |", "| --- | ---: |");
    for (const entry of receipt.runLedger.eventCounts) {
      lines.push(`| ${markdownEscape(entry.event)} | ${markdownEscape(entry.count)} |`);
    }
    if (receipt.runLedger.eventCounts.length === 0) lines.push("| None observed | 0 |");
  }
  lines.push("", "## Provider Facts", "", "| Fact | Status | Value | Reason |", "| --- | --- | --- | --- |");
  for (const name of Object.keys(PROVIDER_FACTS)) {
    const fact = receipt.providerFacts[name];
    lines.push(`| ${markdownEscape(name)} | Unavailable | null | ${markdownEscape(fact.reason)} |`);
  }
  return `${lines.join("\n")}\n`;
}

function safeReceiptPath(cwd, suppliedPath) {
  if (typeof suppliedPath !== "string" || suppliedPath.length === 0) {
    throw new Error("receipt path is invalid");
  }
  const target = path.resolve(cwd, suppliedPath);
  if (!pathWithin(cwd, target) || pathEquals(cwd, target)) {
    throw new Error("receipt path is outside the workspace");
  }
  let current = cwd;
  for (const segment of path.relative(cwd, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || !pathWithin(cwd, realpathSync(current))) {
      throw new Error("receipt path contains a link");
    }
  }
  return target;
}

function readReceipt(cwd, suppliedPath) {
  const filePath = safeReceiptPath(cwd, suppliedPath);
  const before = lstatSync(filePath, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(MAX_RECEIPT_BYTES)
  ) {
    throw new Error("receipt is not a safe bounded regular file");
  }
  let descriptor;
  let opened;
  let bytes;
  let afterRead;
  try {
    descriptor = openSync(filePath, "r");
    opened = fstatSync(descriptor, { bigint: true });
    if (!sameStats(before, opened)) throw new Error("receipt changed during read");
    bytes = readFileSync(descriptor);
    afterRead = fstatSync(descriptor, { bigint: true });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const afterPath = lstatSync(filePath, { bigint: true });
  if (
    !sameStats(opened, afterRead) ||
    !sameStats(afterRead, afterPath) ||
    bytes.length !== Number(afterRead.size)
  ) {
    throw new Error("receipt changed during read");
  }
  return parseWorkflowJson(bytes);
}

export function inspectLocalCampaignReceiptFile(cwd, suppliedPath, pluginRoot) {
  let workspace;
  let receipt;
  try {
    workspace = workspaceRoot(cwd);
    receipt = readReceipt(workspace, suppliedPath);
  } catch {
    return {
      ok: false,
      receiptHash: null,
      matchesCurrentWorkspace: false,
      errors: ["Receipt could not be inspected safely."],
    };
  }
  const errors = validateLocalCampaignReceipt(receipt);
  if (errors.length > 0) {
    return { ok: false, receiptHash: null, matchesCurrentWorkspace: false, errors };
  }
  const hash = receiptHash(receipt);
  let current;
  try {
    current = createLocalCampaignReceipt(workspace, pluginRoot);
  } catch {
    return {
      ok: false,
      receiptHash: hash,
      matchesCurrentWorkspace: false,
      errors: ["Current local state could not be verified safely."],
    };
  }
  const matchesCurrentWorkspace = canonicalReceipt(receipt) === canonicalReceipt(current);
  if (receipt.localDataStatus !== "available") {
    errors.push("Receipt local data is partial.");
  }
  if (!matchesCurrentWorkspace) errors.push("Receipt does not match current workspace state.");
  return {
    ok: errors.length === 0,
    receiptHash: hash,
    matchesCurrentWorkspace,
    errors,
  };
}