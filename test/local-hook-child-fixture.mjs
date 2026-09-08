import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const request = JSON.parse(process.argv[2]);
const { handlePluginHook } = await import(pathToFileURL(path.join(request.installRoot, "src", "core.mjs")));
const originalWrite = fs.writeFileSync;
const originalMkdir = fs.mkdirSync;
const budget = process.platform === "win32" ? 5_000 : 1_000;
let held = false;
let contended = false;
let monotonic = 0;
const attempts = { session: 0, journal: 0 };
if (["shared-budget", "exhaust-live-owner"].includes(request.mode)) performance.now = () => monotonic;
fs.writeFileSync = (file, bytes, ...options) => {
  let value;
  try { value = JSON.parse(String(bytes)); } catch { value = null; }
  if (request.mode === "holder" && !held && value?.event === "tool_started") {
    held = true;
    process.send({ type: "held", operationId: value.operationId });
    const release = Buffer.alloc(1);
    assert.equal(fs.readSync(0, release, 0, 1, null), 1, "Holder requires an explicit test-controller release");
  }
  return originalWrite(file, bytes, ...options);
};
fs.mkdirSync = (directory, ...options) => {
  const normalized = path.resolve(String(directory));
  const scope = normalized === request.sessionLock ? "session"
    : normalized === request.journalLock ? "journal" : null;
  if (scope !== null) attempts[scope] += 1;
  if (request.mode === "shared-budget" && scope !== null && attempts[scope] === 1) {
    monotonic += scope === "session" ? budget * 0.75 : budget * 0.3;
    throw Object.assign(new Error("synthetic contention"), { code: "EEXIST" });
  }
  try { return originalMkdir(directory, ...options); }
  catch (error) {
    if (scope === "session" && error.code === "EEXIST") {
      if (request.mode === "exhaust-live-owner") monotonic += budget;
      if (!contended) {
        contended = true;
        process.send({ type: "contended", scope });
      }
    }
    throw error;
  }
};
syncBuiltinESMExports();
const output = handlePluginHook(request.input, request.event, request.installRoot);
process.send({ type: "result", output, held, contended, attempts });
process.disconnect();