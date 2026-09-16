import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { isatty, ReadStream, WriteStream } from "node:tty";

import { requireVerifiedWorkerAuthority, verifyWorkerAuthority } from "./authority.mjs";
import { inspectRecoveryState, publishRecoveryAuthorization, readOperatorRecoveryProposal } from "./core.mjs";
import { recoveryValueHash, requireRecovery } from "./recovery-state.mjs";
import { SupervisorError } from "./supervisor-diagnostics.mjs";

const operatorConfirmed = new WeakSet();
export const RECOVERY_AUTHORIZATION_LIFETIME_MS = 600_000;

export function verifyRecoveryAuthorization(value, cwd, input, authority, now = Date.now()) {
  requireRecovery(value, "authorization");
  requireVerifiedWorkerAuthority(authority, cwd, input);
  const proposal = value.proposal;
  if (authority.assurance !== "local-scoped" || value.proposalHash !== recoveryValueHash(proposal) ||
    proposal.expectedHash !== recoveryValueHash(proposal.expected) ||
    recoveryValueHash(proposal.session) !== recoveryValueHash(input) ||
    proposal.expected.sessionHash !== authority.sessionHash || proposal.expected.sourceHash !== authority.sourceHash ||
    !Number.isFinite(now) || Date.parse(value.issuedAt) > now || Date.parse(value.expiresAt) <= now ||
    Date.parse(value.expiresAt) - Date.parse(value.issuedAt) !== RECOVERY_AUTHORIZATION_LIFETIME_MS) {
    throw new SupervisorError("RECOVERY_AUTHORIZATION_REQUIRED", "recovery");
  }
  return value;
}

export function requireOperatorAuthorizationPublication(value) {
  if (!operatorConfirmed.has(value)) throw new SupervisorError("RECOVERY_AUTHORIZATION_REQUIRED", "recovery");
}

async function confirmAtOperatorConsole(proposalHash, proposal) {
  let inputFd;
  let outputFd;
  let input;
  let output;
  let terminal;
  try {
    inputFd = openSync(process.platform === "win32" ? "CONIN$" : "/dev/tty", "r");
    outputFd = openSync(process.platform === "win32" ? "CONOUT$" : "/dev/tty", "w");
    if (!isatty(inputFd) || !isatty(outputFd)) throw new Error("operator console is unavailable");
    input = new ReadStream(inputFd);
    output = new WriteStream(outputFd);
    terminal = createInterface({ input, output, terminal: true });
    output.write(`\nOne recovery action; no ownership acquisition or unknown-effect replay.\nRepository: ${proposal.expected.repositoryHash}\nSource: ${proposal.expected.sourceHash}\nWorkflow: ${proposal.expected.workflowHash}\nProspective session: ${proposal.expected.sessionHash}\nAction: ${JSON.stringify(proposal.action)}\nUncertainty: ${proposal.expected.diagnostics.join(", ") || "none observed"}\n`);
    const answer = await terminal.question(`Type AUTHORIZE ${proposalHash} to authorize this exact snapshot for ten minutes: `);
    return answer === `AUTHORIZE ${proposalHash}`;
  } catch {
    return false;
  } finally {
    terminal?.close();
    if (input) input.destroy();
    else if (inputFd !== undefined) closeSync(inputFd);
    if (output) output.destroy();
    else if (outputFd !== undefined) closeSync(outputFd);
  }
}

export async function authorizeRecoveryProposal(cwd, proposalPath, proposalHash, pluginRoot) {
  requireRecovery(proposalHash, "hash");
  const captured = readOperatorRecoveryProposal(proposalPath);
  const proposal = captured.proposal;
  if (recoveryValueHash(proposal) !== proposalHash || recoveryValueHash(proposal.expected) !== proposal.expectedHash) throw new SupervisorError("RECOVERY_AUTHORIZATION_REQUIRED", "recovery");
  const authority = verifyWorkerAuthority(cwd, proposal.session, pluginRoot);
  if (authority.assurance !== "local-scoped") throw new SupervisorError("RECOVERY_AUTHORIZATION_REQUIRED", "recovery");
  const before = inspectRecoveryState(cwd, proposal.session, authority);
  if (before.observationHash !== proposal.expectedHash ||
    !before.candidates.some((action) => recoveryValueHash(action) === recoveryValueHash(proposal.action))) throw new SupervisorError("RECOVERY_LINEAGE_AMBIGUOUS", "recovery");
  if (!await confirmAtOperatorConsole(proposalHash, proposal)) throw new SupervisorError("RECOVERY_AUTHORIZATION_REQUIRED", "recovery");
  const current = readOperatorRecoveryProposal(proposalPath);
  if (recoveryValueHash(current) !== recoveryValueHash(captured)) throw new SupervisorError("RECOVERY_LINEAGE_AMBIGUOUS", "recovery");
  const after = inspectRecoveryState(cwd, proposal.session, authority);
  if (after.observationHash !== proposal.expectedHash) throw new SupervisorError("RECOVERY_LINEAGE_AMBIGUOUS", "recovery");
  const now = Date.now();
  const value = requireRecovery({
    schemaVersion: 1, kind: "recovery-authorization", authorizationId: randomUUID(), proposalHash, proposal,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + RECOVERY_AUTHORIZATION_LIFETIME_MS).toISOString(),
    maxUses: 1, assurance: "cooperative-local-operator",
  }, "authorization");
  operatorConfirmed.add(value);
  try {
    return publishRecoveryAuthorization(cwd, proposal.session, value, authority);
  } finally {
    operatorConfirmed.delete(value);
  }
}
