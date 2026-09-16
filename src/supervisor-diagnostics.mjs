import { validateSupervisorFailure } from "./core.mjs";

const associations = new WeakMap();

export function supervisorFailure(code, phase, evidenceReferences = []) {
  const nextAction = code === "DOCTOR_NATIVE_REQUEST_TOO_LARGE" ? "reduce-request"
    : code === "RECOVERY_AUTHORIZATION_REQUIRED" ? "operator-authorization"
      : ["RECOVERY_PERSISTENCE_UNCONFIRMED", "JOURNAL_OBSERVATION_UNCONFIRMED", "RECOVERY_OPERATION_LIMIT",
        "RECOVERY_OPERATION_CONFLICT"].includes(code) ? "preserve-evidence" : "diagnose";
  const value = { schemaVersion: 1, kind: "supervisor-failure", code, phase, diagnostics: [code], evidenceReferences, nextAction };
  if (validateSupervisorFailure(value).length) throw new Error("invalid supervisor failure");
  return Object.freeze({ ...value, diagnostics: Object.freeze(value.diagnostics), evidenceReferences: Object.freeze([...evidenceReferences]) });
}

export function associateSupervisorFailure(target, failure) {
  if (!target || typeof target !== "object" || validateSupervisorFailure(failure).length) throw new Error("invalid supervisor failure association");
  associations.set(target, failure);
  return target;
}

export function trustedSupervisorFailure(target) {
  return target && typeof target === "object" ? associations.get(target) ?? null : null;
}

export class SupervisorError extends Error {
  constructor(code, phase, evidenceReferences = []) {
    super(code === "RECOVERY_OPERATION_LIMIT" ? `${code}: checkpoint orphan limit exceeded; no operations were truncated`
      : code === "RECOVERY_OPERATION_CONFLICT" ? `${code}: ledger contains duplicate or conflicting operation identities` : code);
    associateSupervisorFailure(this, supervisorFailure(code, phase, evidenceReferences));
  }
}

export function failureFromError(error, phase) {
  const existing = trustedSupervisorFailure(error);
  if (existing) return existing;
  if (error?.runLedgerReason) return supervisorFailure(
    error.runLedgerReason === "run-ledger-limit-exceeded" ? "JOURNAL_CAPACITY" : "JOURNAL_INTEGRITY", phase);
  return null;
}

export function renderSupervisorFailure(value) {
  if (validateSupervisorFailure(value).length) throw new Error("invalid supervisor failure");
  return `${value.code} at ${value.phase}: campaign state or admission is unconfirmed; ${value.nextAction}. Preserve evidence; unknown effects must not be replayed.`;
}
