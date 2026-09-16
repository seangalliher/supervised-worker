import { SupervisorError } from "./supervisor-diagnostics.mjs";

export const JOURNAL_LIMITS = Object.freeze({
  files: 256, fileBytes: 1_048_576, totalBytes: 16_777_216, recordBytes: 16_384,
  controlBytes: 1_048_576, controlFiles: 4, terminalRecords: 2,
});
export const RECOVERY_LIMITS = Object.freeze({
  bytes: 16_777_216, records: 1024, recordBytes: 262_144, controlBytes: 2_097_152, controlRecords: 8,
});
const namePattern = /^([0-9a-f]{64})(?:\.([0-9]{6}))?\.jsonl$/;
const digest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const uint = (value) => Number.isSafeInteger(value) && value >= 0;
export const MAX_RECOVERY_OPERATIONS = 256;
export const HANDOFF_HELPER_ID = "handoff.validate.v1";

export const JOURNAL_EVENT_TRAFFIC = Object.freeze({
  plan_transitioned: "admission", plan_inactive: "control", completion_verified: "control",
  completion_unverified_release: "control", stop_blocked: "control", stop_decision: "control",
  tool_started: "admission", tool_denied: "admission", denied_retry_reserved: "admission",
  denied_retry_consumed: "admission", tool_completed: "terminal", helper_attempt_reserved: "admission",
  helper_circuit_open: "terminal", helper_result: "terminal", checkpoint_persisted: "control",
  checkpoint_resumed: "control", pre_compact: "admission", provisional_claim_released: "control",
  ownership_cleanup_failed: "control",
});

const invocationKey = (session, invocation) => JSON.stringify([session, invocation]);
const identityFields = ["session", "operationId", "invocationHash", "routeGeneration", "claimGeneration"];
const helperBindings = ["helperId", "parentOperationId", "retryRoot", "attempt", "namespaceHash", "parametersHash",
  "inputHash", "implementationHash", "planHash", "planBytesHash", "attachmentHash", "ownershipHash", "delivery"];
const sameOperation = (left, right) => identityFields.every((key) => (left[key] ?? null) === (right[key] ?? null));
const addIndexRecord = (index, key, record) => {
  const entries = index.get(key) ?? [];
  entries.push(record);
  index.set(key, entries);
};

export class JournalOperationIndex {
  constructor(records = []) {
    if (!Array.isArray(records)) throw new Error("JOURNAL_CAPACITY_INPUT_INVALID");
    this.events = new Map();
    this.operations = new Map();
    this.invocations = new Map();
    this.requests = new Map();
    this.unresolved = new Map();
    this.reservations = new Map();
    this.uncorrelatedCompletions = 0;
    this.incomplete = false;
    for (const record of records) this.indexRecord(record);
    for (const operationId of this.operations.keys()) this.refresh(operationId);
  }

  indexRecord(record) {
    if (!record || !digest(record.session) || !Object.hasOwn(JOURNAL_EVENT_TRAFFIC, record.event)) throw new Error("JOURNAL_PRODUCER_UNCLASSIFIED");
    if (["tool_started", "denied_retry_consumed", "helper_attempt_reserved"].includes(record.event) &&
      typeof record.operationId !== "string") throw new Error("JOURNAL_CAPACITY_INPUT_INVALID");
    addIndexRecord(this.events, record.event, record);
    if (typeof record.operationId === "string") addIndexRecord(this.operations, record.operationId, record);
    if (record.event === "tool_started") addIndexRecord(this.invocations, invocationKey(record.session, record.invocationHash), record);
    if (record.event === "tool_denied") addIndexRecord(this.requests, invocationKey(record.session, record.requestHash), record);
    if (record.event === "tool_completed" && !record.operationId) this.uncorrelatedCompletions += 1;
    if (record.event === "checkpoint_resumed" && record.observationStatus === "unavailable") this.incomplete = true;
  }

  forEvent(event, session = null) {
    const records = this.events.get(event) ?? [];
    return session === null ? records : records.filter((record) => record.session === session);
  }

  forOperation(operationId) {
    return this.operations.get(operationId) ?? [];
  }

  startsForInvocation(session, invocation) {
    return this.invocations.get(invocationKey(session, invocation)) ?? [];
  }

  denialsForRequest(session, request) {
    return this.requests.get(invocationKey(session, request)) ?? [];
  }

  evaluate(operationId, inherited = null, additions = [], invocationAdditions = new Map()) {
    const records = [...this.forOperation(operationId), ...additions];
    const starts = records.filter((record) => record.event === "tool_started");
    const retries = records.filter((record) => record.event === "denied_retry_consumed");
    const helpers = records.filter((record) => record.event === "helper_attempt_reserved");
    if (starts.length > 1 || retries.length > 1 || helpers.length > 1 || (helpers.length && (starts.length || retries.length)) ||
      (starts.length && retries.length && (!sameOperation(starts[0], retries[0]) || starts[0].requestHash !== retries[0].requestHash))) {
      throw new SupervisorError("RECOVERY_OPERATION_CONFLICT", "observation");
    }
    const origin = starts[0] ?? helpers[0] ?? retries[0];
    const retrySource = retries.length ? this.forOperation(retries[0].sourceOperationId).find((record) => record.event === "tool_denied") : null;
    const orphan = origin ? {
      operationId, sessionHash: origin.session, invocationHash: origin.invocationHash ?? null,
      routeGeneration: origin.routeGeneration ?? null, claimGeneration: origin.claimGeneration ?? null,
      toolName: origin.toolName ?? origin.helperId ?? retrySource?.toolName ?? "denied-retry",
      observationStatus: "outcome-unknown",
    } : inherited;
    if (orphan === null) return { orphan: null, reservation: null };
    if (inherited && origin && Object.keys(orphan).some((key) => orphan[key] !== inherited[key])) {
      throw new SupervisorError("RECOVERY_OPERATION_CONFLICT", "observation");
    }
    const identity = { ...orphan, session: orphan.sessionHash };
    const matching = records.filter((record) => sameOperation(record, identity));
    const helper = helpers.length > 0 || orphan.toolName === HANDOFF_HELPER_ID;
    if (helper) {
      const terminals = matching.filter((record) => origin && ["helper_result", "helper_circuit_open"].includes(record.event) &&
        helperBindings.every((key) => record[key] === origin[key]));
      // A helper result discharges its write reservation, not its unconfirmed delivery.
      return { orphan, reservation: terminals.length === 1 ? null : orphan.sessionHash };
    }
    const key = invocationKey(orphan.sessionHash, orphan.invocationHash);
    const invocationStarts = this.startsForInvocation(orphan.sessionHash, orphan.invocationHash);
    const additionalStarts = invocationAdditions.get(key) ?? [];
    const startCount = invocationStarts.length + additionalStarts.length;
    const unambiguous = startCount === 0 || (startCount === 1 && (invocationStarts[0] ?? additionalStarts[0]).operationId === operationId);
    const completions = matching.filter((record) => record.event === "tool_completed");
    const denials = matching.filter((record) => record.event === "tool_denied" && record.outcome === "not-executed" &&
      (origin ? (origin.requestHash === null || digest(origin.requestHash)) && record.requestHash === origin.requestHash
        : (record.requestHash === null || digest(record.requestHash)) && record.toolName === orphan.toolName));
    // The allocated operation ID still binds cancellation when the host omitted
    // hints. It does not supply the non-null evidence required by retry admission.
    const resolved = (unambiguous && digest(orphan.invocationHash) && completions.length === 1 && denials.length === 0) ||
      ((orphan.invocationHash === null || unambiguous) && completions.length === 0 && denials.length === 1);
    return { orphan: resolved ? null : orphan, reservation: resolved ? null : orphan.sessionHash };
  }

  refresh(operationId) {
    const { orphan, reservation } = this.evaluate(operationId);
    if (orphan === null) this.unresolved.delete(operationId);
    else this.unresolved.set(operationId, orphan);
    if (reservation === null) this.reservations.delete(operationId);
    else this.reservations.set(operationId, reservation);
  }

  append(record) {
    const prior = record.event === "tool_started" ? this.startsForInvocation(record.session, record.invocationHash) : [];
    const previousUnique = prior.length === 1 ? prior[0].operationId : null;
    this.indexRecord(record);
    if (typeof record.operationId === "string") this.refresh(record.operationId);
    if (previousUnique !== null && previousUnique !== record.operationId) this.refresh(previousUnique);
  }

  project(writes = [], inherited = []) {
    if (!Array.isArray(writes) || !Array.isArray(inherited)) throw new Error("JOURNAL_CAPACITY_INPUT_INVALID");
    const unknown = new Map(this.unresolved);
    const pending = new Map(this.reservations);
    const retained = new Map();
    const additions = new Map();
    const invocations = new Map();
    const affected = new Set();
    for (const orphan of inherited) {
      if (!digest(orphan?.sessionHash) || typeof orphan.operationId !== "string") throw new Error("JOURNAL_CAPACITY_INPUT_INVALID");
      if (retained.has(orphan.operationId)) throw new SupervisorError("RECOVERY_OPERATION_CONFLICT", "observation");
      retained.set(orphan.operationId, orphan);
      affected.add(orphan.operationId);
    }
    for (const record of writes) {
      if (!record || !digest(record.session) || !Object.hasOwn(JOURNAL_EVENT_TRAFFIC, record.event)) throw new Error("JOURNAL_PRODUCER_UNCLASSIFIED");
      if (typeof record.operationId === "string") {
        addIndexRecord(additions, record.operationId, record);
        affected.add(record.operationId);
      }
      if (record.event === "tool_started") {
        addIndexRecord(invocations, invocationKey(record.session, record.invocationHash), record);
        const prior = this.startsForInvocation(record.session, record.invocationHash);
        if (prior.length === 1) affected.add(prior[0].operationId);
      }
    }
    for (const operationId of affected) {
      const { orphan, reservation } = this.evaluate(operationId, retained.get(operationId) ?? null, additions.get(operationId) ?? [], invocations);
      if (orphan === null) unknown.delete(operationId);
      else unknown.set(operationId, orphan);
      if (reservation === null) pending.delete(operationId);
      else pending.set(operationId, reservation);
    }
    if (unknown.size > MAX_RECOVERY_OPERATIONS) throw new SupervisorError("RECOVERY_OPERATION_LIMIT", "admission");
    const traffic = writes.map((record) => {
      const classification = JOURNAL_EVENT_TRAFFIC[record.event];
      if (classification !== "terminal" && record.event !== "tool_denied") return classification;
      const before = this.evaluate(record.operationId, retained.get(record.operationId) ?? null);
      return before.reservation !== null && !pending.has(record.operationId) ? "terminal" : "admission";
    });
    return { orphans: [...unknown.values()], outstanding: [...pending.values()], traffic };
  }
}

export function projectJournalCapacity({ files, records, index = null, writes = [], inherited = [], controlWrites = [] }) {
  if (!Array.isArray(controlWrites) || (index === null ? !Array.isArray(records) : !(index instanceof JournalOperationIndex))) throw new Error("JOURNAL_CAPACITY_INPUT_INVALID");
  const projected = (index ?? new JournalOperationIndex(records)).project(writes, inherited);
  const traffic = [...projected.traffic];
  if (controlWrites.length) traffic.push("control");
  const assessment = assessJournalCapacity({
    files, outstanding: projected.outstanding,
    writes: [...writes.map((record) => ({ sessionHash: record.session, bytes: Buffer.byteLength(`${JSON.stringify(record)}\n`) })), ...controlWrites],
    traffic: traffic.includes("admission") || traffic.length === 0 ? "admission" : traffic.includes("control") ? "control" : "terminal",
  });
  return { ...assessment, outstandingOperations: projected.outstanding.length, unresolvedOperations: projected.orphans.length };
}

export function assessJournalCapacity({ files, outstanding = [], writes = [], newOperations = [], traffic = "admission" }) {
  if (!Array.isArray(files) || !Array.isArray(outstanding) || !Array.isArray(writes) || !Array.isArray(newOperations) ||
    !["admission", "terminal", "control"].includes(traffic) || ![...outstanding, ...newOperations].every(digest) ||
    outstanding.length + newOperations.length > 4096 || writes.length > 4096) throw new Error("JOURNAL_CAPACITY_INPUT_INVALID");
  const streams = new Map();
  const names = new Set();
  let measuredBytes = 0;
  for (const file of files) {
    const match = namePattern.exec(file?.name ?? "");
    if (!match || match[2] === "000000" || !uint(file.bytes) || names.has(file.name)) throw new Error("JOURNAL_CAPACITY_INPUT_INVALID");
    names.add(file.name);
    measuredBytes += file.bytes;
    const segments = streams.get(match[1]) ?? [];
    segments.push({ index: Number(match[2] ?? 0), bytes: file.bytes });
    streams.set(match[1], segments);
  }
  let invalidLayout = false;
  for (const segments of streams.values()) {
    segments.sort((a, b) => a.index - b.index);
    if (segments.some((segment, index) => segment.index !== index)) invalidLayout = true;
  }
  let projectedBytes = measuredBytes;
  let projectedFiles = files.length;
  const tails = new Map([...streams].map(([session, segments]) => [session, segments.at(-1).bytes]));
  const append = (session, bytes) => {
    const tail = tails.get(session);
    if (tail === undefined || tail + bytes > JOURNAL_LIMITS.fileBytes) {
      projectedFiles += 1;
      tails.set(session, bytes);
    } else tails.set(session, tail + bytes);
    projectedBytes += bytes;
  };
  for (const write of writes) {
    if (!digest(write?.sessionHash) || !uint(write.bytes) || write.bytes === 0 || write.bytes > JOURNAL_LIMITS.recordBytes) throw new Error("JOURNAL_CAPACITY_INPUT_INVALID");
    append(write.sessionHash, write.bytes);
  }
  const writeBytes = projectedBytes - measuredBytes;
  const writeFiles = projectedFiles - files.length;
  for (const session of [...outstanding, ...newOperations]) {
    for (let index = 0; index < JOURNAL_LIMITS.terminalRecords; index += 1) append(session, JOURNAL_LIMITS.recordBytes);
  }
  const terminalBytes = projectedBytes - measuredBytes - writeBytes;
  const terminalFiles = projectedFiles - files.length - writeFiles;
  const controlBytes = traffic === "admission" ? JOURNAL_LIMITS.controlBytes : 0;
  const controlFiles = traffic === "admission" ? JOURNAL_LIMITS.controlFiles : 0;
  const physicalInvalid = invalidLayout || files.some((file) => file.bytes > JOURNAL_LIMITS.fileBytes) ||
    measuredBytes > JOURNAL_LIMITS.totalBytes || files.length > JOURNAL_LIMITS.files;
  const reason = physicalInvalid ? "physical-limit"
    : projectedBytes + controlBytes > JOURNAL_LIMITS.totalBytes ? "terminal-and-control-bytes"
      : projectedFiles + controlFiles > JOURNAL_LIMITS.files ? "terminal-and-control-files" : null;
  return {
    allowed: reason === null, reason, measured: { bytes: measuredBytes, files: files.length },
    projected: { bytes: writeBytes, files: writeFiles }, reserved: { terminalBytes, terminalFiles, controlBytes, controlFiles },
    ordinaryHeadroom: { bytes: Math.max(0, JOURNAL_LIMITS.totalBytes - projectedBytes - JOURNAL_LIMITS.controlBytes),
      files: Math.max(0, JOURNAL_LIMITS.files - projectedFiles - JOURNAL_LIMITS.controlFiles) },
    controlHeadroom: { bytes: Math.max(0, JOURNAL_LIMITS.totalBytes - projectedBytes), files: Math.max(0, JOURNAL_LIMITS.files - projectedFiles) },
  };
}

export function assessRecoveryCapacity(usage, bundle, traffic = "ordinary") {
  if (!usage || !uint(usage.bytes) || !uint(usage.records) || !Array.isArray(bundle) ||
    bundle.length > RECOVERY_LIMITS.records || !bundle.every((bytes) => uint(bytes) && bytes > 0 && bytes <= RECOVERY_LIMITS.recordBytes) ||
    !["ordinary", "finalization"].includes(traffic)) throw new Error("RECOVERY_CAPACITY_INPUT_INVALID");
  const bytes = bundle.reduce((total, count) => total + count, usage.bytes);
  const records = usage.records + bundle.length;
  const reserveBytes = traffic === "ordinary" ? RECOVERY_LIMITS.controlBytes : 0;
  const reserveRecords = traffic === "ordinary" ? RECOVERY_LIMITS.controlRecords : 0;
  const reason = bytes + reserveBytes > RECOVERY_LIMITS.bytes ? "recovery-bytes"
    : records + reserveRecords > RECOVERY_LIMITS.records ? "recovery-records" : null;
  return { allowed: reason === null, reason, measured: { ...usage }, projected: { bytes, records },
    reserved: { bytes: reserveBytes, records: reserveRecords },
    ordinaryHeadroom: { bytes: Math.max(0, RECOVERY_LIMITS.bytes - bytes - RECOVERY_LIMITS.controlBytes),
      records: Math.max(0, RECOVERY_LIMITS.records - records - RECOVERY_LIMITS.controlRecords) },
    controlHeadroom: { bytes: Math.max(0, RECOVERY_LIMITS.bytes - bytes), records: Math.max(0, RECOVERY_LIMITS.records - records) } };
}
