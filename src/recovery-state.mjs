import { createHash } from "node:crypto";

import { validateArtifactPublication, validateRecovery } from "./core.mjs";
import { MAX_RECOVERY_OPERATIONS } from "./journal-capacity.mjs";
import { SupervisorError } from "./supervisor-diagnostics.mjs";

export const MAX_RECOVERY_BYTES = 262_144;
export const RECOVERY_PHASES_PREPARED = Object.freeze(["detach-prepared", "checkpoint-prepared", "resume-prepared"]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function recoveryValueHash(value) {
  return hash(JSON.stringify(canonical(value)));
}

export function requireRecovery(value, definition = null) {
  if (definition === "operations" && Array.isArray(value?.orphans) && value.orphans.length > MAX_RECOVERY_OPERATIONS) {
    throw new SupervisorError("RECOVERY_OPERATION_LIMIT", "observation");
  }
  if (validateRecovery(value, definition).length) throw new Error("RECOVERY_RECORD_INVALID");
  if (definition === "operations" && new Set(value.orphans.map((operation) => operation.operationId)).size !== value.orphans.length) throw new SupervisorError("RECOVERY_OPERATION_CONFLICT", "observation");
  return value;
}

function canonicalRecordBytes(value) {
  const bytes = Buffer.from(`${JSON.stringify(canonical(value))}\n`);
  if (bytes.length > MAX_RECOVERY_BYTES) throw new Error("RECOVERY_RECORD_TOO_LARGE");
  return bytes;
}

export function serializeRecovery(value, definition = null) {
  requireRecovery(value, definition);
  return canonicalRecordBytes(value);
}

export function serializeQuarantineMetadata(value) {
  if (validateArtifactPublication(value, "quarantineIntent").length) throw new Error("RECOVERY_RECORD_INVALID");
  const paths = [".", ".supervised-worker", ".supervised-worker/recovery", ".supervised-worker/recovery/quarantine",
    `.supervised-worker/recovery/quarantine/${value.actionId}`];
  if (value.ancestors.some((entry, index) => entry.path !== paths[index])) throw new Error("RECOVERY_RECORD_INVALID");
  return canonicalRecordBytes(value);
}

export function exactCounter(value) {
  return requireRecovery({ certainty: "exact", value }, "counter");
}

export function unknownCounter(lastObservation = null, knownAfter = 0) {
  return requireRecovery({ certainty: "unknown", value: null, lastObservation, knownAfter }, "counter");
}

export function freshStopState(progressHash) {
  return requireRecovery({ schemaVersion: 3, progressHash, sameProgressBlocks: exactCounter(0), totalBlocks: exactCounter(0) }, "stopState");
}

export function uncertainStopState(progressHash, last = null, evidenceHash = null) {
  return requireRecovery({ schemaVersion: 3, progressHash,
    sameProgressBlocks: unknownCounter(last === null ? null : { value: last.sameProgressBlocks, evidenceHash }),
    totalBlocks: unknownCounter(last === null ? null : { value: last.totalBlocks, evidenceHash }) }, "stopState");
}

export function observeProgress(state, progressHash) {
  requireRecovery(state, "stopState");
  if (state.progressHash === progressHash) return structuredClone(state);
  return requireRecovery({ ...structuredClone(state), progressHash, sameProgressBlocks: exactCounter(0) }, "stopState");
}

export function decideStop(state, progressHash, recursive = false, limit = 2) {
  requireRecovery(state, "stopState");
  if (typeof recursive !== "boolean" || !Number.isSafeInteger(limit) || limit < 0 || limit > 2) throw new Error("RECOVERY_STOP_DECISION_INVALID");
  const current = observeProgress(state, progressHash);
  const uncertain = current.sameProgressBlocks.certainty === "unknown";
  if (uncertain || recursive || current.sameProgressBlocks.value >= limit) return {
    decision: "allow", cause: uncertain ? "stop-counters-uncertain" : recursive ? "stop-recursive" : "stop-budget-exhausted", stopState: current,
  };
  const increment = (counter) => counter.certainty === "exact"
    ? exactCounter(counter.value + 1) : unknownCounter(counter.lastObservation, counter.knownAfter + 1);
  return { decision: "block", cause: "stop-block",
    stopState: { ...current, sameProgressBlocks: increment(current.sameProgressBlocks), totalBlocks: increment(current.totalBlocks) } };
}

export function mergeOperationCoverage(previous, observed) {
  requireRecovery(previous, "operations");
  requireRecovery(observed, "operations");
  const orphans = new Map(previous.orphans.map((operation) => [operation.operationId, operation]));
  for (const operation of observed.orphans) {
    const prior = orphans.get(operation.operationId);
    if (prior && recoveryValueHash(prior) !== recoveryValueHash(operation)) throw new SupervisorError("RECOVERY_OPERATION_CONFLICT", "observation");
    orphans.set(operation.operationId, operation);
  }
  const coverage = previous.coverage === "complete" ? observed.coverage : previous.coverage;
  return requireRecovery({ coverage, orphans: [...orphans.values()],
    uncorrelatedCompletions: previous.uncorrelatedCompletions.certainty === "unknown"
      ? previous.uncorrelatedCompletions : observed.uncorrelatedCompletions }, "operations");
}

function verifiedFrontier(head, selected, sequence, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_RECOVERY_BYTES || hash(bytes) !== selected) throw new Error("RECOVERY_LINEAGE_AMBIGUOUS");
  const value = requireRecovery(JSON.parse(bytes.toString("utf8")), "frontier");
  if (!serializeRecovery(value, "frontier").equals(bytes) || value.campaignId !== head.campaignId || value.sequence !== sequence) throw new Error("RECOVERY_LINEAGE_AMBIGUOUS");
  if (sequence === 0 ? value.previousHash !== null : value.previousHash === null) throw new Error("RECOVERY_LINEAGE_AMBIGUOUS");
  if (value.previousHash === null && !["fresh-plan", "legacy-reconcile"].includes(value.cause)) throw new Error("RECOVERY_LINEAGE_AMBIGUOUS");
  return value;
}

export function verifyFrontierTip(head, readBytes) {
  requireRecovery(head, "head");
  if (typeof readBytes !== "function" || head.sequence >= 1024) throw new Error("RECOVERY_LINEAGE_AMBIGUOUS");
  return { frontier: verifiedFrontier(head, head.frontierHash, head.sequence, readBytes(head.frontierHash)), frontierHash: head.frontierHash };
}

export function verifyFrontierChain(head, readBytes) {
  requireRecovery(head, "head");
  if (typeof readBytes !== "function" || head.sequence >= 1024) throw new Error("RECOVERY_LINEAGE_AMBIGUOUS");
  let selected = head.frontierHash;
  let sequence = head.sequence;
  let current = null;
  const seen = new Set();
  while (selected !== null) {
    if (seen.size >= 1024 || seen.has(selected)) throw new Error("RECOVERY_LINEAGE_AMBIGUOUS");
    seen.add(selected);
    const value = verifiedFrontier(head, selected, sequence, readBytes(selected));
    current ??= value;
    selected = value.previousHash;
    sequence -= 1;
  }
  return { frontier: current, frontierHash: head.frontierHash, hashes: [...seen] };
}

export function resolveLegacyLineage({ journals, checkpoints, planHash, operations, ledger }) {
  requireRecovery(planHash, "hash");
  requireRecovery(operations, "operations");
  requireRecovery(ledger, "ledger");
  const blocked = { status: "ambiguous", tipSessionHash: null, evidenceHash: null, provenState: null,
    stopState: uncertainStopState(planHash), operations, ledger };
  if (!Array.isArray(journals) || journals.length === 0 || journals.length > 256 ||
    !Array.isArray(checkpoints) || checkpoints.length > 1024) return blocked;
  const sessions = new Map(journals.map((journal) => [journal.sessionHash, journal]));
  if (sessions.size !== journals.length) return blocked;
  const receipts = new Map(checkpoints.map((checkpoint) => [checkpoint.sha256, checkpoint.value]));
  const parents = new Map();
  const children = new Map();
  const roots = [];
  for (const journal of journals) {
    const resumes = journal.records.filter((record) => record.event === "checkpoint_resumed");
    if (resumes.length > 1) return blocked;
    if (resumes.length === 0) {
      if (journal.records.filter((record) => record.event === "plan_transitioned" && record.priorPlanHash === null).length !== 1) return blocked;
      roots.push(journal.sessionHash);
      continue;
    }
    const resume = resumes[0];
    const source = sessions.get(resume.sourceSessionHash);
    const receipt = receipts.get(resume.checkpointHash);
    if (!source || !receipt || receipt.sessionHash !== resume.sourceSessionHash || receipt.planHash !== resume.planHash ||
      resume.sourceSessionHash === journal.sessionHash ||
      !source.records.some((record) => record.event === "checkpoint_persisted" && record.checkpointHash === resume.checkpointHash &&
        record.attachmentHash === receipt.attachmentHash && record.planHash === receipt.planHash &&
        record.claimGeneration === receipt.claimGeneration && record.routeGeneration === receipt.routeGeneration)) return blocked;
    parents.set(journal.sessionHash, resume.sourceSessionHash);
    const successors = children.get(resume.sourceSessionHash) ?? [];
    successors.push(journal.sessionHash);
    if (successors.length !== 1) return blocked;
    children.set(resume.sourceSessionHash, successors);
  }
  const tips = journals.filter((journal) => !children.has(journal.sessionHash));
  if (roots.length !== 1 || tips.length !== 1) return blocked;
  const tip = tips[0];
  const visited = new Set();
  let cursor = tip.sessionHash;
  while (cursor !== undefined) {
    if (visited.has(cursor)) return blocked;
    visited.add(cursor);
    cursor = parents.get(cursor);
  }
  if (visited.size !== journals.length || !visited.has(roots[0])) return blocked;
  const last = tip.records.filter((record) => record.event === "stop_blocked").at(-1);
  const stopState = uncertainStopState(planHash, last ?? null, last ? tip.sha256 : null);
  let provenState = null;
  let evidenceHash = tip.sha256;
  const terminal = tip.records.at(-1);
  const frozen = terminal?.event === "checkpoint_persisted" ? receipts.get(terminal.checkpointHash) : null;
  if (frozen?.planHash === planHash && frozen.context.stopState !== null && frozen.schemaVersion < 3 &&
    frozen.attachmentHash === terminal.attachmentHash && frozen.claimGeneration === terminal.claimGeneration &&
    frozen.routeGeneration === terminal.routeGeneration) {
    provenState = { schemaVersion: 3, progressHash: frozen.context.stopState.progressHash,
      sameProgressBlocks: exactCounter(frozen.context.stopState.sameProgressBlocks),
      totalBlocks: exactCounter(frozen.context.stopState.totalBlocks) };
    evidenceHash = terminal.checkpointHash;
  }
  return { status: "unique", tipSessionHash: tip.sessionHash, evidenceHash, provenState, stopState,
    operations: { ...operations, coverage: "partial", uncorrelatedCompletions: unknownCounter() }, ledger };
}
