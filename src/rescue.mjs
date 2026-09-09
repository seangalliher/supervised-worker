import { rescueLifecycle, MAX_LIFECYCLE_REQUEST_BYTES } from "./core.mjs";
import { parseWorkflowJson } from "./workflow.mjs";

const chunks = [];
let length = 0;
let request = null;
try {
  if (process.argv.length !== 2) throw new Error("rescue takes only bounded JSON stdin");
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_LIFECYCLE_REQUEST_BYTES) throw new Error("rescue input exceeds its bound");
    chunks.push(chunk);
  }
  request = parseWorkflowJson(Buffer.concat(chunks));
} catch {
  request = null;
}
const result = rescueLifecycle(process.cwd(), request);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!["inspected", "recovered", "already-recovered"].includes(result.status)) process.exitCode = 1;