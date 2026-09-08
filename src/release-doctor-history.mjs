import { advanceDoctorIncident, decideDoctorStep, doctorHash, reserveDoctorStep } from "./doctor-state.mjs";
import { replayDoctorHistory } from "./doctor-promotion.mjs";

function equal(left, right) {
  return doctorHash(left) === doctorHash(right);
}

export function validateReleaseDoctorHistory(commits, capabilities) {
  const records = [...capabilities];
  let previous = null;
  for (const commit of commits) {
    const next = commit.incident;
    if (previous === null) {
      if (next.revision !== 0 || next.previousHash !== null || next.state !== "detected" || next.pendingActionHash !== null ||
        next.cancelled || next.stepHashes.length !== 0 || commit.records.length !== 0) throw new Error("RELEASE_DOCTOR_INITIAL_STATE_INVALID");
    } else {
      if (next.revision !== previous.revision + 1 || next.previousHash !== doctorHash(previous)) throw new Error("RELEASE_DOCTOR_TRANSITION_INVALID");
      const handoff = commit.records.length === 1 && commit.records[0].kind === "doctor-handoff" ? commit.records[0] : null;
      const intent = commit.records.find((record) => record.kind === "doctor-repair-intent");
      const step = commit.records.find((record) => record.kind === "doctor-step");
      const outcome = commit.records.find((record) => record.kind === "doctor-repair-outcome");
      let expected;
      if (handoff !== null) {
        if (previous.cancelled || previous.pendingActionHash !== null || handoff.attemptId !== previous.attemptId || !equal(handoff.binding, previous.binding)) throw new Error("RELEASE_DOCTOR_TRANSITION_INVALID");
        expected = { ...previous, revision: previous.revision + 1, previousHash: doctorHash(previous), updatedAt: next.updatedAt };
      } else if (intent && step && !outcome && commit.records.length === 2) {
        const capability = capabilities.find((record) => doctorHash(record) === intent.capabilityHash);
        if (!capability || decideDoctorStep(previous, records, capability, intent, step.startedAt).status !== "execute" ||
          !equal(reserveDoctorStep(previous, intent, step.actor, step.startedAt), step)) throw new Error("RELEASE_DOCTOR_TRANSITION_INVALID");
        expected = { ...previous, revision: previous.revision + 1, previousHash: doctorHash(previous), pendingActionHash: doctorHash(intent), updatedAt: step.startedAt };
      } else if (step && outcome && !intent && previous.pendingActionHash !== null) {
        const resultKinds = new Set(["doctor-repair-attempt", "doctor-validation", "doctor-review", "doctor-promotion", "doctor-rollback", "doctor-continuation"]);
        if (commit.records.filter((record) => record.kind === "doctor-step").length !== 1 ||
          commit.records.filter((record) => record.kind === "doctor-repair-outcome").length !== 1 ||
          commit.records.some((record) => record !== step && record !== outcome && (!resultKinds.has(record.kind) || !outcome.outputHashes.includes(doctorHash(record))))) throw new Error("RELEASE_DOCTOR_TRANSITION_INVALID");
        const reservedIntent = records.find((record) => record.kind === "doctor-repair-intent" && doctorHash(record) === previous.pendingActionHash);
        const reservation = records.find((record) => record.kind === "doctor-step" && record.status === "reserved" && record.actionId === step.actionId);
        if (!reservedIntent || !reservation || outcome.intentHash !== doctorHash(reservedIntent) || outcome.capabilityHash !== reservedIntent.capabilityHash ||
          step.status !== outcome.status || step.completedAt !== outcome.completedAt || !equal(step.outputHashes, outcome.outputHashes) ||
          !equal({ ...step, status: reservation.status, completedAt: reservation.completedAt, outputHashes: reservation.outputHashes,
            progressHash: reservation.progressHash, continuation: reservation.continuation }, reservation)) throw new Error("RELEASE_DOCTOR_TRANSITION_INVALID");
        expected = advanceDoctorIncident(previous, step, outcome);
        if (step.action === "continue" && outcome.status === "succeeded") {
          const continuation = commit.records.find((record) => record.kind === "doctor-continuation");
          if (!continuation || continuation.status !== "resumed" || continuation.actionId !== step.actionId ||
            continuation.stateHash !== previous.previousHash || !reservedIntent.inputHashes.includes(continuation.interruptedActionHash)) throw new Error("RELEASE_DOCTOR_CONTINUATION_INVALID");
          expected.state = "resolved";
        }
      } else throw new Error("RELEASE_DOCTOR_TRANSITION_INVALID");
      if (!equal(expected, next)) throw new Error("RELEASE_DOCTOR_TRANSITION_INVALID");
    }
    records.push(next, ...commit.records);
    previous = next;
  }
  replayDoctorHistory(records);
  return records;
}