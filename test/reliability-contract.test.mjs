import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { sha256, validateArtifactPublication, validateDoctorInvocation, validateRecovery } from "../src/core.mjs";
import { doctorInvocationRequest, formatDoctorInvocation, parseDoctorRequest } from "../src/doctor-invocation.mjs";
import { installLocalPlugin } from "../src/install.mjs";
import { resolveWorkflowRoles } from "../src/workflow.mjs";
import { withReliabilityFixture } from "./reliability-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cwd = path.resolve("fixture-repository");
const H = "a".repeat(64);
const I = "11111111-1111-4111-8111-111111111111";

test("reliability: generated Doctor command crosses the same strict recognizer without a formatter tool", () => {
  const request = { operation: "diagnose", session_id: "worker", transcript_path: path.resolve("worker.jsonl") };
  const invocation = formatDoctorInvocation(cwd, request, root);
  assert.equal(invocation.status, "formatted");
  assert.deepEqual(validateDoctorInvocation(invocation, "invocation"), []);
  const input = { cwd, ...request, tool_name: "run_in_terminal", tool_input: { command: invocation.command } };
  assert.deepEqual(doctorInvocationRequest(input, root), request);
  for (const command of [`${invocation.command}; echo extra`, `node ${invocation.command}`, invocation.command.replace("doctor-rescue", "cli"),
    invocation.command.replaceAll(process.platform === "win32" ? "\\" : "/", process.platform === "win32" ? "/" : "\\")]) {
    assert.equal(doctorInvocationRequest({ ...input, tool_input: { command } }, root), null);
  }
});

test("reliability: Doctor request fields are operation-specific and reject plausible malformed recovery", () => {
  for (const value of [
    { operation: "inspect", session_id: "worker" },
    { operation: "detect", session_id: "worker", incidentId: I },
    { action: "diagnose", session_id: "worker" },
    { operation: "diagnose", session_id: "worker", incidentId: I },
    { operation: "inspect", session_id: "worker", incidentId: I, diagnosticHash: H },
    { operation: "recover-authorized", session_id: "worker" },
    { operation: "propose-recovery", session_id: "worker", expectedHash: H, action: { kind: "quarantine-journal-entry", path: "arbitrary" } },
  ]) assert.throws(() => parseDoctorRequest(JSON.stringify(value)), JSON.stringify(value));
  for (const value of [
    { operation: "detect", session_id: "worker", incidentId: I, diagnosticHash: H },
    { operation: "recover-authorized", session_id: "worker", authorizationHash: H },
    { operation: "propose-recovery", session_id: "worker", expectedHash: H, action: { kind: "legacy-reconcile", resolution: { kind: "preserve-uncertainty" } } },
  ]) assert.deepEqual(parseDoctorRequest(JSON.stringify(value)), value);
  assert.throws(() => parseDoctorRequest('{"operation":"diagnose","session_id":"worker","session_id":"other"}'));
});

test("reliability: oversized native requests produce actionable typed failure and no shell command", () => {
  const result = formatDoctorInvocation(path.resolve("x".repeat(4000)), { operation: "diagnose", session_id: "worker", transcript_path: "y".repeat(4000) }, root);
  assert.equal(result.status, "blocked");
  assert.equal(result.command, null);
  assert.equal(result.failure.code, "DOCTOR_NATIVE_REQUEST_TOO_LARGE");
  assert.throws(() => formatDoctorInvocation("relative", { operation: "diagnose", session_id: "worker" }, root));
});

test("reliability: published recovery and Doctor schemas agree with dependency-free runtime checks", () => {
  const ajv = new Ajv2020({ strictTypes: false, strictRequired: false });
  addFormats(ajv);
  for (const name of readdirSync(path.join(root, "schemas")).filter((entry) => entry.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(readFileSync(path.join(root, "schemas", name))));
  }
  for (const [name, definition, runtime, values] of [
    ["recovery", "counter", validateRecovery, [{ certainty: "exact", value: 0 }, { certainty: "unknown", value: null, lastObservation: null, knownAfter: 0 }, { certainty: "exact", value: null }, { certainty: "unknown", value: 0 }]],
    ["recovery", "action", validateRecovery, [{ kind: "recover-lock", scope: "journal", snapshotHash: H }, { kind: "recover-lock", scope: "doctor", snapshotHash: H }, { kind: "quarantine-journal-entry", entryHash: H, path: "unsafe" }]],
    ["doctor-invocation", "request", validateDoctorInvocation, [{ operation: "diagnose", session_id: "worker" }, { operation: "diagnose", session_id: "worker", incidentId: I }, { operation: "inspect", session_id: "worker", incidentId: I }, { operation: "inspect", session_id: "worker" }]],
    ["recovery", "quarantineLocator", validateRecovery, [`.supervised-worker/recovery/quarantine/${I}/${H}.quarantined`,
      `logs/gates/supervised-worker/quarantine/${I}/${H}.quarantined`, `.supervised-worker/recovery/quarantine/${"-".repeat(36)}/${H}.quarantined`,
      `.supervised-worker/recovery/quarantine/${I}/../${H}.quarantined`]],
    ["artifact-publication", "releaseLocator", validateArtifactPublication, [`.supervised-worker/releases/${H}.json`,
      `logs/gates/supervised-worker/releases/${H}.json`, `.supervised-worker/releases/${H}.json/child`, `.supervised-worker/releases/${H.toUpperCase()}.json`]],
    ["artifact-publication", "quarantineAncestorPath", validateArtifactPublication, [".", ".supervised-worker", ".supervised-worker/recovery",
      ".supervised-worker/recovery/quarantine", `.supervised-worker/recovery/quarantine/${I}`, "logs", ".supervised-worker/recover",
      `.supervised-worker/recovery/quarantine/${I}/child`, ".supervised-worker/releases", "..", ".supervised-worker/recovery/../releases"]],
  ]) {
    const validate = ajv.getSchema(`https://supervised-worker.dev/schemas/${name}.schema.json#/$defs/${definition}`);
    assert.ok(validate);
    for (const value of values) assert.equal(validate(value), runtime(value, definition).length === 0, JSON.stringify(value));
  }
});

function stringsIn(text) {
  return [...text.matchAll(/["']([^"'\n]+)["']/g)].map((match) => match[1]);
}

function implementationFiles() {
  const text = readFileSync(path.join(root, "src", "handoff.mjs"), "utf8");
  const body = /const HANDOFF_IMPLEMENTATION_FILES = \[([\s\S]*?)\]\.map/.exec(text)?.[1];
  assert.ok(body);
  const files = stringsIn(body).map((file) => path.posix.normalize(path.posix.join("src", file)));
  assert.equal(new Set(files).size, files.length, "implementation inventory cannot contain duplicate entries");
  return files;
}

function dependencyFiles() {
  const required = new Set();
  const visit = (file) => {
    if (required.has(file)) return;
    required.add(file);
    const text = readFileSync(path.join(root, file), "utf8");
    if (file.endsWith(".mjs")) {
      for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.{1,2}\/[^"']+\.(?:mjs|json))["']/g)) {
        visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
      }
      for (const match of text.matchAll(/new URL\(["'](\.{1,2}\/[^"']+\.schema\.json)["']/g)) {
        visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
      }
    }
  };
  visit("src/cli.mjs");
  visit("src/handoff.mjs");
  // These computed entry points are explicitly declared, never guessed from a
  // runtime crawler: installer/recognizer launchers and bounded schema registries.
  for (const file of ["src/hook-launcher.mjs", "src/doctor-rescue.mjs", "src/rescue.mjs"]) visit(file);
  for (const [file, pattern] of [
    ["src/core.mjs", /const additionalSchemaNames = new Set\(\[([\s\S]*?)\]\)/],
    ["src/standards.mjs", /const SCHEMA_FILES = \[([\s\S]*?)\]/],
  ]) {
    const body = pattern.exec(readFileSync(path.join(root, file), "utf8"))?.[1];
    assert.ok(body, `${file} computed dependency declaration must remain explicit`);
    for (const name of stringsIn(body)) visit(`schemas/${name}`);
  }
  return [...required].sort();
}

test("reliability: implementation identity covers local imports reexports dynamic entry points and computed schemas", () => {
  const inventory = implementationFiles();
  const required = dependencyFiles();
  const check = (files) => {
    const missing = required.filter((file) => !files.includes(file));
    assert.deepEqual(missing, [], `missing implementation dependencies: ${missing.join(", ")}`);
  };
  check(inventory);
  assert.ok(inventory.includes("src/ci-policy.mjs"), "retain the parent's independently approved CI identity entry");
  assert.throws(() => check(inventory.filter((file) => file !== "src/recovery-state.mjs")), /missing implementation dependencies/);
  const cli = /const required = \[([\s\S]*?)\];/.exec(readFileSync(path.join(root, "src", "cli.mjs"), "utf8"))?.[1];
  assert.ok(cli);
  for (const file of required) assert.ok(stringsIn(cli).includes(file), `CLI package inventory omits ${file}`);
  const standards = /const SCHEMA_FILES = \[([\s\S]*?)\];/.exec(readFileSync(path.join(root, "src", "standards.mjs"), "utf8"))?.[1];
  assert.deepEqual(stringsIn(standards).sort(), readdirSync(path.join(root, "schemas")).filter((file) => file.endsWith(".schema.json")).sort());
});

function writeIdentityArtifact(fixture) {
  const workflow = resolveWorkflowRoles(fixture.cwd, { requireAcceptance: true });
  const value = { ...JSON.parse(readFileSync(path.join(root, "examples", "handoff.build-contract.json"))),
    itemId: "one", workflowHash: workflow.workflowHash, producedBy: workflow.roles.architect, targetFiles: ["README.md"] };
  const directory = path.join(fixture.cwd, ".supervised-worker", "handoffs", sha256("one"));
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "build-contract.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

test("reliability: each newly covered dependency changes helper identity independently of installation sealing", () => withReliabilityFixture((fixture) => {
  const artifact = writeIdentityArtifact(fixture);
  const priorCoverage = new Set(["src/handoff.mjs", "src/workflow.mjs", "src/ci-policy.mjs", "src/core.mjs", "src/cli.mjs", "schemas/lifecycle.schema.json"]);
  const dependencies = implementationFiles().filter((file) => !priorCoverage.has(file));
  for (const [index, dependency] of dependencies.entries()) {
    const installed = installLocalPlugin(root, { baseDirectory: path.join(fixture.base, `identity-${index}`) }).installRoot;
    const script = `
      import assert from 'node:assert/strict';
      import { appendFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const root = ${JSON.stringify(installed)};
      const { captureHandoffValidation } = await import(pathToFileURL(root + '/src/handoff.mjs').href);
      const { resolvePluginSourceIdentity } = await import(pathToFileURL(root + '/src/install.mjs').href);
      const capture = () => captureHandoffValidation(${JSON.stringify(fixture.cwd)}, ${JSON.stringify(artifact)});
      const initial = capture();
      initial.requireUnchanged();
      assert.equal(capture().implementationHash, initial.implementationHash);
      assert.equal(resolvePluginSourceIdentity(root).sourceKind, 'immutable-install-record');
      appendFileSync(root + '/' + ${JSON.stringify(dependency)}, '\\n');
      assert.throws(() => initial.requireUnchanged(), /helper implementation/);
      assert.throws(() => capture(), /helper implementation/);
      assert.throws(() => resolvePluginSourceIdentity(root), /immutable record/);
      process.stdout.write(JSON.stringify({ dependency: ${JSON.stringify(dependency)}, hash: initial.implementationHash }));
    `;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", script],
      { cwd: fixture.cwd, encoding: "utf8", timeout: 30_000 }));
    assert.equal(result.dependency, dependency);
    assert.match(result.hash, /^[0-9a-f]{64}$/);
  }
  assert.ok(dependencies.length >= 30, "exercise the complete expanded dependency set, not only six module names");
}, { admit: false }));

test("reliability: dependency-only drift invalidates recorded helper retry at the implementation comparison", () => withReliabilityFixture((fixture) => {
  const artifact = writeIdentityArtifact(fixture);
  const session = "legacy-helper-owner";
  writeFileSync(path.join(fixture.cwd, ".supervised-worker", "plan.json"), JSON.stringify(fixture.plan));
  writeFileSync(path.join(fixture.cwd, ".supervised-worker", "attachment.json"), JSON.stringify({
    schemaVersion: 1, sessionHash: sha256(session), attachedAt: "2026-01-01T00:00:00.000Z",
  }));
  const setup = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const { handleHook, observeHandoffValidation } = await import(pathToFileURL(${JSON.stringify(path.join(fixture.installRoot, "src", "core.mjs"))}).href);
    const { captureHandoffValidation } = await import(pathToFileURL(${JSON.stringify(path.join(fixture.installRoot, "src", "handoff.mjs"))}).href);
    const cwd = ${JSON.stringify(fixture.cwd)};
    const artifact = ${JSON.stringify(artifact)};
    const input = { cwd, session_id: ${JSON.stringify(session)}, tool_name: 'run_in_terminal', tool_input: { command: 'bounded fixture observation' } };
    const records = () => fs.readFileSync(${JSON.stringify(path.join(fixture.cwd, ".supervised-worker", "runs", `${sha256(session)}.jsonl`))}, 'utf8').trim().split('\\n').map(JSON.parse);
  `;
  const run = (body) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `${setup}\n${body}`],
    { cwd: fixture.cwd, encoding: "utf8", timeout: 30_000 }));
  const first = run(`
    assert.notEqual(handleHook({ ...input, tool_use_id: 'first-helper' }, 'PreToolUse').permissionDecision, 'deny');
    const append = fs.appendFileSync;
    let fired = false;
    fs.appendFileSync = (target, bytes, ...args) => {
      if (!fired && String(target).includes('runs') && JSON.parse(String(bytes)).event === 'helper_result') {
        fired = true; throw new Error('injected helper result loss');
      }
      return append(target, bytes, ...args);
    };
    syncBuiltinESMExports();
    let result;
    try { result = observeHandoffValidation(cwd, artifact, { session_id: input.session_id, tool_use_id: 'first-helper', retryOf: null }); }
    finally { fs.appendFileSync = append; syncBuiltinESMExports(); }
    assert.equal(fired, true);
    assert.equal(result.outcome, 'completion-unconfirmed');
    process.stdout.write(JSON.stringify(result));
  `);
  appendFileSync(path.join(fixture.installRoot, "src", "journal-capacity.mjs"), "\n// isolated dependency-only drift\n");
  const second = run(`
    assert.notEqual(handleHook({ ...input, tool_use_id: 'retry-helper' }, 'PreToolUse').permissionDecision, 'deny');
    const saved = records().find((record) => record.event === 'helper_attempt_reserved');
    const current = captureHandoffValidation(cwd, artifact);
    for (const key of ['namespaceHash', 'parametersHash', 'inputHash']) assert.equal(current[key], saved[key]);
    assert.notEqual(current.implementationHash, saved.implementationHash);
    let boundary = false;
    const ErrorClass = globalThis.Error;
    globalThis.Error = class extends ErrorClass {
      constructor(message) {
        super(message);
        if (message === 'helper retry evidence changed, is ambiguous, or its circuit is open') boundary = true;
      }
    };
    let result;
    try { result = observeHandoffValidation(cwd, artifact, { session_id: input.session_id, tool_use_id: 'retry-helper', retryOf: ${JSON.stringify(first.operationId)} }); }
    finally { globalThis.Error = ErrorClass; }
    assert.equal(boundary, true, 'reach the actual helper comparison, not installation validation');
    assert.equal(result.status, 'denied');
    assert.equal(records().filter((record) => record.event === 'helper_attempt_reserved').length, 1);
    process.stdout.write(JSON.stringify({ boundary, status: result.status }));
  `);
  assert.deepEqual(second, { boundary: true, status: "denied" });
}, { admit: false }));
