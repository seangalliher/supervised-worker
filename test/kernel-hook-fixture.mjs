import { checkpointSession, handleHook, lifecycleFailureDetails, recoverLifecycleLock, releaseAttachment, resumeSession } from "../src/core.mjs";
import { parseWorkflowJson } from "../src/workflow.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const operation = process.argv[2];
let request = null;
try {
  const bytes = Buffer.concat(chunks);
  if (bytes.length > 8_192 && ["checkpoint", "resume", "recover"].includes(operation)) throw new Error("bounded fixture request");
  request = parseWorkflowJson(bytes);
} catch {
  request = null;
}
try {
  const result = operation === "checkpoint" ? checkpointSession(process.cwd(), request)
    : operation === "resume" ? resumeSession(process.cwd(), request)
    : operation === "recover" ? recoverLifecycleLock(process.cwd(), request)
    : operation === "release" ? releaseAttachment(process.cwd())
    : handleHook(request, operation, request.cwd);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "unconfirmed") process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify(lifecycleFailureDetails(error) ?? { status: "unconfirmed" })}\n`);
  process.exitCode = 1;
}