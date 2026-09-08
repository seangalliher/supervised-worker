import { verifyWorkerAuthority } from "./authority.mjs";
import { sha256, supervisorFailureFor } from "./core.mjs";
import { detectDoctorIncident } from "./doctor.mjs";
import { doctorHash } from "./doctor-state.mjs";

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