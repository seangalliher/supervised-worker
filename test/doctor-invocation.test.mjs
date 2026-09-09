import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { doctorInvocationRequest, parseDoctorEnvelope, parseDoctorRequest } from "../src/doctor-invocation.mjs";

const root = path.resolve("fixture-plugin");
const input = { cwd: path.resolve("fixture-repository"), session_id: "fixture-worker", transcript_path: path.resolve("fixture-worker.jsonl"), tool_name: "run_in_terminal" };
const request = { operation: "inspect", session_id: input.session_id, transcript_path: input.transcript_path,
  incidentId: "11111111-1111-4111-8111-111111111111" };
const quote = (value) => `'${process.platform === "win32" ? value.replaceAll("'", "''") : value.replaceAll("'", "'\\''")}'`;
const commandFor = (text, pluginRoot = root, cwd = input.cwd) => `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(path.join(pluginRoot, "src", "doctor-rescue.mjs"))} --request-base64 ${quote(Buffer.from(`{"cwd":${JSON.stringify(cwd)},"request":${text}}`).toString("base64"))}`;
const invocation = (command) => ({ ...input, tool_input: { command, mode: "sync" } });

test("Doctor invocation accepts only the exact immutable executable and session-bound JSON", () => {
  const text = JSON.stringify(request);
  assert.deepEqual(parseDoctorRequest(text), request);
  assert.deepEqual(doctorInvocationRequest(invocation(commandFor(text)), root), request);
  assert.deepEqual(doctorInvocationRequest({ cwd: input.cwd, sessionId: input.session_id, transcriptPath: input.transcript_path,
    toolName: "run_in_terminal", toolInput: { command: commandFor(text) } }, root), request);
  assert.deepEqual(doctorInvocationRequest({ cwd: input.cwd, sessionId: input.session_id, transcriptPath: input.transcript_path,
    toolName: "RUN_IN_TERMINAL", toolArgs: { command: commandFor(text) } }, root), request);
  assert.deepEqual(doctorInvocationRequest({ ...input, tool_name: "functions.run_in_terminal", toolArgs: { command: commandFor(text) }, toolInput: { command: "ignored" } }, root), request);
  const apostropheRoot = path.resolve("fixture'plugin");
  assert.deepEqual(doctorInvocationRequest(invocation(commandFor(text, apostropheRoot)), apostropheRoot), request);
  const alternateNode = path.resolve("fixture-node", "node.exe");
  const alternateCommand = commandFor(text).replace(quote(process.execPath), quote(alternateNode));
  assert.equal(doctorInvocationRequest(invocation(alternateCommand), root), null);
  assert.deepEqual(doctorInvocationRequest(invocation(alternateCommand), root, alternateNode), request);
  assert.equal(doctorInvocationRequest(invocation(alternateCommand), root, "node"), null);
});

for (const [name, value] of Object.entries({ absent: undefined, null: "null", array: "[]", malformed: "{", duplicate: '{"operation":"inspect","operation":"execute"}',
  unknownOperation: JSON.stringify({ ...request, operation: "shell" }), extraKey: JSON.stringify({ ...request, command: "arbitrary" }), oversized: " ".repeat(65537) })) {
  test(`Doctor request rejects ${name}`, () => assert.throws(() => parseDoctorRequest(value)));
}

test("Doctor invocation refuses command additions, substitution, alternative executables and malformed quoting", () => {
  const command = commandFor(JSON.stringify(request));
  for (const candidate of [command + "; echo unsafe", command + " && echo unsafe", command + " | echo unsafe", command + "\n",
    "echo unsafe; " + command, command.replace("--request-base64", "--unknown"), command.replace(quote(process.execPath), "node"),
    command.replace("doctor-rescue.mjs", "cli.mjs"), command + " --extra", command.slice(0, -1), " ".repeat(131073)]) {
    assert.equal(doctorInvocationRequest(invocation(candidate), root), null);
  }
  assert.equal(doctorInvocationRequest(invocation(commandFor(JSON.stringify({ ...request, session_id: "other" }))), root), null);
  assert.equal(doctorInvocationRequest(invocation(commandFor(JSON.stringify({ ...request, transcript_path: "other.jsonl" }))), root), null);
  assert.equal(doctorInvocationRequest(invocation(commandFor(JSON.stringify(request), root, path.resolve("other-repository"))), root), null);
  assert.equal(doctorInvocationRequest(invocation(commandFor("{}")), root), null);
  assert.equal(doctorInvocationRequest(invocation(commandFor('{"operation":"inspect","operation":"execute"}')), root), null);
  assert.equal(doctorInvocationRequest({ ...invocation(command), tool_name: "other_tool" }, root), null);
  assert.equal(doctorInvocationRequest({}, root), null);
  assert.equal(doctorInvocationRequest({ ...input, tool_input: { command: null } }, root), null);
  assert.equal(doctorInvocationRequest({ ...input, tool_input: { command, shell: "other" } }, root), null);
});

test("Doctor request quote escaping preserves data without introducing shell operations", () => {
  const value = { ...request, diagnosticHash: "quoted' data; $(not-a-command) `literal`" };
  assert.deepEqual(doctorInvocationRequest(invocation(commandFor(JSON.stringify(value))), root), value);
  const unsafe = commandFor(JSON.stringify(value)).slice(0, -1) + "' ; echo unsafe";
  assert.equal(doctorInvocationRequest(invocation(unsafe), root), null);
});

test("Doctor envelope requires canonical bounded base64 and an absolute explicit repository", () => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
  assert.deepEqual(parseDoctorEnvelope(encode({ cwd: input.cwd, request })), { cwd: input.cwd, request });
  for (const value of [undefined, "", "*", "a".repeat(87389), "ey==", encode({ cwd: "relative", request }),
    encode({ cwd: input.cwd, request, extra: true }), encode(null), encode([]), encode({ cwd: input.cwd })]) {
    assert.throws(() => parseDoctorEnvelope(value));
  }
  const encoded = encode({ cwd: input.cwd, request });
  assert.throws(() => parseDoctorEnvelope(`${encoded}\n`));
  assert.throws(() => parseDoctorEnvelope(Buffer.from('{"cwd":"/fixture","request":{"operation":"inspect","operation":"execute"}}').toString("base64")));
});