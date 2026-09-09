import { fileURLToPath } from "node:url";
import path from "node:path";

import { verifyWorkerAuthority } from "./authority.mjs";
import { acceptDoctorHandoff, detectDoctorIncident, executeDoctorIntent, grantDoctorAction, inspectDoctorIncident } from "./doctor.mjs";
import { requireDoctor } from "./doctor-state.mjs";
import { parseDoctorEnvelope } from "./doctor-invocation.mjs";
import { parseWorkflowJson } from "./workflow.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export function handleDoctorRequest(cwd, request) {
  try {
    if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).some((key) => !["operation", "session_id", "transcript_path", "incidentId", "diagnosticHash", "grant", "intent", "handoff", "expectedHash"].includes(key))) throw new Error("DOCTOR_REQUEST_INVALID");
    const input = { session_id: request.session_id, ...(request.transcript_path === undefined ? {} : { transcript_path: request.transcript_path }) };
    const authority = verifyWorkerAuthority(cwd, input, root);
    const incidentId = request.incidentId;
    requireDoctor(incidentId, "id");
    if (request.operation === "detect") return detectDoctorIncident(cwd, input, incidentId, request.diagnosticHash, authority);
    if (request.operation === "inspect") return inspectDoctorIncident(cwd, input, incidentId, authority);
    if (request.operation === "grant") return grantDoctorAction(cwd, input, incidentId, request.grant, authority);
    if (request.operation === "handoff") {
      requireDoctor(request.handoff, "handoff");
      if (request.handoff.binding.incidentId !== incidentId) throw new Error("DOCTOR_REQUEST_BINDING_CONFLICT");
      return acceptDoctorHandoff(cwd, input, request.handoff, request.expectedHash, authority);
    }
    if (request.operation === "execute") {
      requireDoctor(request.intent, "repairIntent");
      if (request.intent.binding.incidentId !== incidentId) throw new Error("DOCTOR_REQUEST_BINDING_CONFLICT");
      return executeDoctorIntent(cwd, input, request.intent, authority);
    }
    throw new Error("DOCTOR_REQUEST_INVALID");
  } catch (error) {
    return { status: "blocked", reason: /^DOCTOR_[A-Z_]+$/.test(error.message) ? error.message : "DOCTOR_AUTHORITY_OR_STATE_UNCONFIRMED" };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    if (process.argv.length === 4 && process.argv[2] === "--request-base64") {
      const envelope = parseDoctorEnvelope(process.argv[3]);
      result = handleDoctorRequest(envelope.cwd, envelope.request);
    } else {
      if (process.argv.length !== 2) throw new Error("arguments are not accepted");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > 65_536) throw new Error("request exceeds its bound");
        chunks.push(chunk);
      }
      result = handleDoctorRequest(process.cwd(), parseWorkflowJson(Buffer.concat(chunks)));
    }
  } catch {
    result = { status: "blocked", reason: "DOCTOR_REQUEST_INVALID" };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (["blocked", "retryable", "conflict", "unknown"].includes(result.status)) process.exitCode = 1;
}