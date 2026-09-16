import { randomUUID } from "node:crypto";

import { applyRecoveryAction, inspectRecoveryState } from "./core.mjs";
import { recoveryValueHash, requireRecovery } from "./recovery-state.mjs";
import { SupervisorError } from "./supervisor-diagnostics.mjs";

export function inspectRecovery(cwd, request, authority) {
  requireRecovery(request, "inspectRequest");
  return inspectRecoveryState(cwd, request, authority);
}

export function proposeRecovery(cwd, request, authority) {
  requireRecovery(request, "proposeRequest");
  const session = { session_id: request.session_id, ...(request.transcript_path === undefined ? {} : { transcript_path: request.transcript_path }) };
  const inspection = inspectRecoveryState(cwd, session, authority);
  if (inspection.observation.status !== "complete" || inspection.observationHash !== request.expectedHash ||
    !inspection.candidates.some((action) => recoveryValueHash(action) === recoveryValueHash(request.action))) {
    throw new SupervisorError("RECOVERY_LINEAGE_AMBIGUOUS", "recovery");
  }
  const proposal = requireRecovery({ schemaVersion: 1, kind: "recovery-proposal", actionId: randomUUID(), session,
    expectedHash: request.expectedHash, expected: inspection.observation, action: request.action }, "proposal");
  return { status: "proposed", proposal, proposalHash: recoveryValueHash(proposal) };
}

export function applyRecovery(cwd, request, authority) {
  requireRecovery(request, "applyRequest");
  return applyRecoveryAction(cwd, request, authority);
}
