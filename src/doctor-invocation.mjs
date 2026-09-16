import path from "node:path";

import { parseWorkflowJson } from "./workflow.mjs";
import { validateDoctorInvocation } from "./core.mjs";
import { recoveryValueHash } from "./recovery-state.mjs";
import { supervisorFailure } from "./supervisor-diagnostics.mjs";

const MAX_REQUEST_BYTES = 65_536;
export const MAX_DOCTOR_NATIVE_BYTES = 8_000;

export function parseDoctorRequest(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) throw new Error("DOCTOR_REQUEST_INVALID");
  const request = parseWorkflowJson(Buffer.from(text));
  if (validateDoctorInvocation(request, "request").length ||
    (request.handoff && request.handoff.binding.incidentId !== request.incidentId) ||
    (request.intent && request.intent.binding.incidentId !== request.incidentId)) throw new Error("DOCTOR_REQUEST_INVALID");
  return request;
}

export function parseDoctorEnvelope(encoded) {
  if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_REQUEST_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("DOCTOR_REQUEST_INVALID");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_REQUEST_BYTES || bytes.toString("base64") !== encoded) throw new Error("DOCTOR_REQUEST_INVALID");
  const envelope = parseWorkflowJson(bytes);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
    Object.keys(envelope).some((key) => !["cwd", "request"].includes(key)) ||
    typeof envelope.cwd !== "string" || !path.isAbsolute(envelope.cwd)) throw new Error("DOCTOR_REQUEST_INVALID");
  return { cwd: envelope.cwd, request: parseDoctorRequest(JSON.stringify(envelope.request)) };
}

function quoteArgument(value) {
  return `'${process.platform === "win32" ? value.replaceAll("'", "''") : value.replaceAll("'", "'\\''")}'`;
}

function invocationPrefix(pluginRoot, nodePath) {
  if ([pluginRoot, nodePath].some((value) => typeof value !== "string" || !path.isAbsolute(value) || /[\r\n\0]/.test(value))) throw new Error("DOCTOR_REQUEST_INVALID");
  return `${process.platform === "win32" ? "& " : ""}${quoteArgument(nodePath)} ${quoteArgument(path.join(pluginRoot, "src", "doctor-rescue.mjs"))} --request-base64 `;
}

export function formatDoctorInvocation(cwd, request, pluginRoot, nodePath = process.execPath) {
  const parsed = parseDoctorRequest(JSON.stringify(request));
  const encoded = Buffer.from(JSON.stringify({ cwd, request: parsed })).toString("base64");
  parseDoctorEnvelope(encoded);
  const command = `${invocationPrefix(pluginRoot, nodePath)}${quoteArgument(encoded)}`;
  const oversized = Buffer.byteLength(command, "utf8") > MAX_DOCTOR_NATIVE_BYTES;
  return {
    schemaVersion: 1, kind: "doctor-invocation", status: oversized ? "blocked" : "formatted",
    command: oversized ? null : command, requestHash: recoveryValueHash({ cwd, request: parsed }),
    failure: oversized ? supervisorFailure("DOCTOR_NATIVE_REQUEST_TOO_LARGE", "invocation") : null,
  };
}

export function doctorInvocationRequest(input, pluginRoot, nodePath = process.execPath) {
  if (String(input?.tool_name ?? input?.toolName ?? "").toLowerCase().split(/[./]/).at(-1) !== "run_in_terminal") return null;
  const parameters = input.tool_input ?? input.toolArgs ?? input.toolInput;
  if (!parameters || Object.keys(parameters).some((key) => !["command", "explanation", "goal", "mode", "isBackground", "timeout"].includes(key))) return null;
  const command = parameters.command;
  if (typeof command !== "string" || Buffer.byteLength(command, "utf8") > MAX_DOCTOR_NATIVE_BYTES || /[\r\n\0]/.test(command)) return null;
  if (typeof nodePath !== "string" || !path.isAbsolute(nodePath)) return null;
  let prefix;
  try { prefix = invocationPrefix(pluginRoot, nodePath); } catch { return null; }
  if (!command.startsWith(prefix)) return null;
  const encoded = command.slice(prefix.length);
  if (!encoded.startsWith("'") || !encoded.endsWith("'")) return null;
  const text = encoded.slice(1, -1);
  if (quoteArgument(text) !== encoded) return null;
  try {
    const envelope = parseDoctorEnvelope(text);
    const key = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (typeof input.cwd !== "string" || key(envelope.cwd) !== key(input.cwd)) return null;
    const request = envelope.request;
    if (request.session_id !== (input.session_id ?? input.sessionId) ||
      request.transcript_path !== (input.transcript_path ?? input.transcriptPath)) return null;
    return request;
  } catch {
    return null;
  }
}