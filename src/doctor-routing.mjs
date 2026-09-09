import { verifyWorkerAuthority } from "./authority.mjs";
import { observeCampaignTransition, sha256, supervisorFailureFor } from "./core.mjs";
import { detectDoctorIncident, inspectDoctorIncident } from "./doctor.mjs";
import { doctorHash, requireDoctor } from "./doctor-state.mjs";
import { parseWorkflowJson } from "./workflow.mjs";

export function routeDoctorConsultation(input, eventName, pluginRoot) {
  if (!["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(eventName) ||
    String(input?.tool_name ?? input?.toolName ?? "").toLowerCase().split(/[./]/).at(-1) !== "runsubagent") return null;
  const parameters = input.tool_input ?? input.toolArgs ?? input.toolInput;
  if (!parameters || parameters.agentName !== "Supervised Doctor" ||
    Object.keys(parameters).some((key) => !["agentName", "prompt", "description", "model"].includes(key)) ||
    typeof parameters.prompt !== "string" || Buffer.byteLength(parameters.prompt) > 65_536) return null;
  try {
    const request = parseWorkflowJson(Buffer.from(parameters.prompt));
    if (!request || request.kind !== "doctor-consultation" ||
      Object.keys(request).some((key) => !["kind", "incident", "incidentHash", "evidence"].includes(key)) ||
      !Array.isArray(request.evidence) || request.evidence.length > 16) return null;
    requireDoctor(request.incident, "incident");
    if (doctorHash(request.incident) !== request.incidentHash) return null;
    for (const entry of request.evidence) {
      if (!entry || typeof entry !== "object" || Object.keys(entry).some((key) => !["sha256", "value"].includes(key)) ||
        doctorHash(entry.value) !== entry.sha256) return null;
    }
    observeCampaignTransition(input.cwd, input);
    const authority = verifyWorkerAuthority(input.cwd, input, pluginRoot);
    if (authority.assurance !== "local-scoped") return null;
    const current = inspectDoctorIncident(input.cwd, input, request.incident.binding.incidentId, authority);
    if (current.hash !== request.incidentHash) return null;
    const recordedHashes = new Set(current.incident.inputHashes);
    for (const record of current.records) {
      recordedHashes.add(doctorHash(record));
      for (const reference of [...(record.inputHashes ?? []), ...(record.outputHashes ?? [])]) recordedHashes.add(reference);
    }
    if (request.evidence.some((entry) => !recordedHashes.has(entry.sha256))) return null;
    const output = { permissionDecision: "allow", permissionDecisionReason:
      "Current hash-bound Doctor consultation admitted under the owning Worker's local authority; no campaign mutation or recovery permission is granted to the companion." };
    return eventName === "PreToolUse" ? { ...output,
      ...(Object.hasOwn(input, "hook_event_name") || Object.hasOwn(input, "session_id")
        ? { hookSpecificOutput: { hookEventName: eventName, ...output } } : {}) } : {};
  } catch {
    return null;
  }
}

export function routeDoctorFromHook(input, output, pluginRoot) {
  const failure = supervisorFailureFor(output);
  if (failure === null) return output;
  try {
    const authority = verifyWorkerAuthority(input.cwd, input, pluginRoot);
    const diagnosticHash = doctorHash(failure.diagnostics);
    const identity = sha256(JSON.stringify([authority.repositoryHash, authority.sessionHash, input.tool_use_id ?? input.toolUseId ?? "hook", diagnosticHash]));
    const incidentId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
    const detected = detectDoctorIncident(input.cwd, input, incidentId, diagnosticHash, authority);
    const message = ` Internal supervisor incident ${incidentId} is ${detected.status}. Worker: invoke Supervised Doctor with the validated incident and hash ${detected.hash}; use the separate doctor-rescue helper and do not replay unknown effects or relay operator recovery commands.`;
    const enrich = (value) => Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      ["reason", "permissionDecisionReason", "additionalContext", "systemMessage"].includes(key) && typeof entry === "string" ? `${entry}${message}` : entry]));
    return { ...enrich(output), ...(output.hookSpecificOutput ? { hookSpecificOutput: enrich(output.hookSpecificOutput) } : {}) };
  } catch {
    const message = " Doctor incident capture is unavailable for the current authority, policy, or campaign state. Preserve the original failure and checkpoint through the owning Worker when possible; no recovery or completion is confirmed.";
    const enrich = (value) => Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      ["reason", "permissionDecisionReason", "additionalContext", "systemMessage"].includes(key) && typeof entry === "string" ? `${entry}${message}` : entry]));
    return { ...enrich(output), ...(output.hookSpecificOutput ? { hookSpecificOutput: enrich(output.hookSpecificOutput) } : {}) };
  }
}