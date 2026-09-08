import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acceptDoctorHandoff, detectDoctorIncident, executeDoctorIntent, grantDoctorAction, inspectDoctorIncident } from "../src/doctor.mjs";
import { doctorHash } from "../src/doctor-state.mjs";
import { acceptWorkflowRoles, resolveWorkflowRoles } from "../src/workflow.mjs";
import { createWorkerAuthorityFixture } from "./worker-authority-fixture.mjs";
import { handlePluginHook, sha256 } from "../src/core.mjs";
import { routeDoctorFromHook } from "../src/doctor-routing.mjs";

function withFixture(action) {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "doctor-fixture-")));
  try {
    const input = { session_id: "test-only-worker" };
    const host = createWorkerAuthorityFixture(cwd, input);
    mkdirSync(path.join(cwd, ".github"));
    writeFileSync(path.join(cwd, ".github", "supervised-worker.json"), readFileSync(new URL("../examples/workflow.json", import.meta.url)));
    const accepted = acceptWorkflowRoles(cwd, resolveWorkflowRoles(cwd).workflowHash);
    assert.equal(accepted.accepted, true);
    assert.equal(host.admit().status, "applied");
    const authority = host.authority();
    action({ cwd, input, authority, host });
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function intentFor(cwd, input, authority, incident, action, inputHashes = []) {
  const grant = grantDoctorAction(cwd, input, incident.binding.incidentId,
    { action, actionId: randomUUID(), expectedHash: doctorHash(incident) }, authority);
  return { schemaVersion: 1, kind: "doctor-repair-intent", binding: incident.binding, attemptId: incident.attemptId,
    actionId: grant.capability.actionId, action, capabilityHash: grant.hash, expectedHash: doctorHash(incident), inputHashes };
}

test("Doctor persists an incident and deduplicates a completed read across reload", () => {
  withFixture(({ cwd, input, authority }) => {
    const incidentId = randomUUID();
    const detected = detectDoctorIncident(cwd, input, incidentId, "a".repeat(64), authority);
    assert.equal(detectDoctorIncident(cwd, input, incidentId, "a".repeat(64), authority).hash, detected.hash);
    const intent = intentFor(cwd, input, authority, detected.incident, "inspect");
    const result = executeDoctorIntent(cwd, input, intent, authority);
    assert.equal(result.status, "succeeded");
    assert.equal(result.values[0].status, "absent");
    const artifact = path.join(cwd, ".supervised-worker", "doctor", incidentId, "artifacts", `${result.outcome.outputHashes[0]}.json`);
    assert.equal(sha256(readFileSync(artifact)), result.outcome.outputHashes[0], "subordinate hash must bind actual stored bytes");
    const replay = executeDoctorIntent(cwd, input, intent, authority);
    assert.equal(replay.status, "replayed");
    assert.deepEqual(replay.prior, result.outcome);
    assert.equal(inspectDoctorIncident(cwd, input, incidentId, authority).incident.state, "diagnosing");
  });
});

test("Doctor diagnoses and recovers an exact dead campaign owner without the campaign lock", () => {
  withFixture(({ cwd, input, authority }) => {
    const child = spawnSync(process.execPath, ["--eval", ""], { encoding: "utf8", timeout: 20000 });
    assert.equal(child.status, 0);
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    const token = randomUUID();
    const lock = path.join(cwd, ".supervised-worker", "locks", "lifecycle");
    mkdirSync(lock);
    writeFileSync(path.join(lock, `${token}.json`), JSON.stringify({ schemaVersion: 1, token, processId: child.pid, acquiredAt: new Date().toISOString() }));
    const incidentId = randomUUID();
    const { incident } = detectDoctorIncident(cwd, input, incidentId, "a".repeat(64), authority);
    const inspected = executeDoctorIntent(cwd, input, intentFor(cwd, input, authority, incident, "inspect"), authority);
    assert.equal(inspected.status, "succeeded");
    assert.equal(inspected.values[0].diagnostics[0].code, "LIFECYCLE_OWNER_DEAD");
    const current = inspectDoctorIncident(cwd, input, incidentId, authority).incident;
    const intent = intentFor(cwd, input, authority, current, "recover", inspected.outcome.outputHashes);
    const recovered = executeDoctorIntent(cwd, input, intent, authority);
    assert.equal(recovered.status, "succeeded", JSON.stringify(recovered));
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(`${lock}.${token}.recovered`), true);
    assert.equal(executeDoctorIntent(cwd, input, intent, authority).status, "replayed");
  });
});

test("Doctor cannot initialize or mutate with a copied authority or changed policy", () => {
  withFixture(({ cwd, input, authority }) => {
    const incidentId = randomUUID();
    assert.throws(() => detectDoctorIncident(cwd, input, incidentId, "a".repeat(64), { ...authority }), /verified/);
    assert.equal(existsSync(path.join(cwd, ".supervised-worker", "doctor", incidentId)), false);
    const { incident } = detectDoctorIncident(cwd, input, incidentId, "a".repeat(64), authority);
    const intent = intentFor(cwd, input, authority, incident, "inspect");
    const config = path.join(cwd, ".github", "supervised-worker.json");
    writeFileSync(config, `${readFileSync(config, "utf8")}\n`);
    assert.throws(() => executeDoctorIntent(cwd, input, intent, authority), /ACCEPTED_WORKFLOW_REQUIRED/);
  });
});

test("installed rescue entry point is independently callable and rejects shell payloads", () => {
  withFixture(({ cwd, input, host }) => {
    const incidentId = randomUUID();
    const run = (request) => spawnSync(process.execPath, [path.join(host.installRoot, "src", "doctor-rescue.mjs")], {
      cwd, input: JSON.stringify(request), encoding: "utf8", timeout: 20000,
      env: { ...process.env, SUPERVISED_WORKER_HOST_AUTHORITY: host.inventoryPath },
    });
    const request = { operation: "detect", session_id: input.session_id, incidentId, diagnosticHash: "a".repeat(64) };
    const result = run(request);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "detected");
    const denied = run({ ...request, command: "arbitrary shell" });
    assert.equal(denied.status, 1);
    assert.equal(JSON.parse(denied.stdout).reason, "DOCTOR_REQUEST_INVALID");
  });
});

test("Doctor classifies missing approval as denied before effect and permits cancellation", () => {
  withFixture(({ cwd, input, authority }) => {
    const incidentId = randomUUID();
    const { incident } = detectDoctorIncident(cwd, input, incidentId, "a".repeat(64), authority);
    executeDoctorIntent(cwd, input, intentFor(cwd, input, authority, incident, "inspect"), authority);
    const current = inspectDoctorIncident(cwd, input, incidentId, authority).incident;
    const rejected = executeDoctorIntent(cwd, input, intentFor(cwd, input, authority, current, "create-repair"), authority);
    assert.equal(rejected.status, "blocked");
    assert.equal(rejected.outcome.reason, "DOCTOR_REPAIR_CONTRACT_UNCONFIRMED");
    const blocked = inspectDoctorIncident(cwd, input, incidentId, authority).incident;
    const cancelled = executeDoctorIntent(cwd, input, intentFor(cwd, input, authority, blocked, "cancel"), authority);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(inspectDoctorIncident(cwd, input, incidentId, authority).incident.cancelled, true);
  });
});

test("Doctor recovers its own exact dead transition owner while retaining kernel evidence", () => {
  withFixture(({ cwd, input, authority }) => {
    const incidentId = randomUUID();
    const detected = detectDoctorIncident(cwd, input, incidentId, "a".repeat(64), authority);
    const child = spawnSync(process.execPath, ["--eval", ""], { encoding: "utf8", timeout: 20000 });
    assert.equal(child.status, 0);
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    const token = randomUUID();
    const lock = path.join(cwd, ".supervised-worker", "doctor", incidentId, "transition");
    mkdirSync(lock);
    const bytes = JSON.stringify({ schemaVersion: 1, token, processId: child.pid, acquiredAt: new Date().toISOString() });
    writeFileSync(path.join(lock, `${token}.json`), bytes);
    const observed = inspectDoctorIncident(cwd, input, incidentId, authority);
    assert.equal(observed.hash, detected.hash);
    assert.equal(readFileSync(path.join(`${lock}.${token}.recovered`, `${token}.json`), "utf8"), bytes);
    assert.equal(existsSync(lock), false);
  });
});

test("Doctor never recovers its live transition owner", () => {
  withFixture(({ cwd, input, authority }) => {
    const incidentId = randomUUID();
    detectDoctorIncident(cwd, input, incidentId, "a".repeat(64), authority);
    const token = randomUUID();
    const lock = path.join(cwd, ".supervised-worker", "doctor", incidentId, "transition");
    mkdirSync(lock);
    const bytes = JSON.stringify({ schemaVersion: 1, token, processId: process.pid, acquiredAt: new Date().toISOString() });
    writeFileSync(path.join(lock, `${token}.json`), bytes);
    assert.throws(() => inspectDoctorIncident(cwd, input, incidentId, authority), /LIFECYCLE_OWNER_LIVE/);
    assert.equal(readFileSync(path.join(lock, `${token}.json`), "utf8"), bytes);
  });
});

test("Doctor handoff ingestion is bounded to the current incident and does not grant authority", () => {
  withFixture(({ cwd, input, authority }) => {
    const incidentId = randomUUID();
    const { incident, hash } = detectDoctorIncident(cwd, input, incidentId, "a".repeat(64), authority);
    const handoff = { schemaVersion: 1, kind: "doctor-handoff", binding: incident.binding, attemptId: incident.attemptId,
      producedBy: "seangalliher-supervised-doctor", diagnosisHash: "b".repeat(64), intentHashes: [], evidenceHashes: [], continuation: "pending" };
    const accepted = acceptDoctorHandoff(cwd, input, handoff, hash, authority);
    assert.equal(accepted.hash, doctorHash(handoff));
    assert.equal(acceptDoctorHandoff(cwd, input, handoff, hash, authority).hash, accepted.hash);
    assert.throws(() => acceptDoctorHandoff(cwd, input, { ...handoff, diagnosisHash: "c".repeat(64) }, hash, authority), /BINDING_CONFLICT/);
    assert.throws(() => acceptDoctorHandoff(cwd, input, { ...handoff, authorityMode: "delegated" }, hash, authority), /RECORD_INVALID/);
    assert.equal(inspectDoctorIncident(cwd, input, incidentId, authority).incident.state, "detected");
  });
});

test("typed hook failure routes Doctor without changing its decision or accepting copied failure text", () => {
  withFixture(({ cwd, input, host }) => {
    const previous = process.env.SUPERVISED_WORKER_HOST_AUTHORITY;
    process.env.SUPERVISED_WORKER_HOST_AUTHORITY = host.inventoryPath;
    try {
      const child = spawnSync(process.execPath, ["--eval", ""], { encoding: "utf8", timeout: 20000 });
      assert.equal(child.status, 0);
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
      const token = randomUUID();
      const lock = path.join(cwd, ".supervised-worker", "locks", "lifecycle");
      mkdirSync(lock);
      writeFileSync(path.join(lock, `${token}.json`), JSON.stringify({ schemaVersion: 1, token, processId: child.pid, acquiredAt: new Date().toISOString() }));
      const request = { ...input, cwd };
      const output = handlePluginHook(request, "Stop", host.installRoot);
      assert.match(output.reason, /LIFECYCLE_OWNER_DEAD/);
      assert.deepEqual(routeDoctorFromHook(request, { ...output }, host.installRoot), output, "copied text is not an internal failure capability");
      const routed = routeDoctorFromHook(request, output, host.installRoot);
      assert.equal(routed.decision, output.decision);
      assert.match(routed.reason, /invoke Supervised Doctor/);
      assert.equal(existsSync(lock), true);
      delete process.env.SUPERVISED_WORKER_HOST_AUTHORITY;
      const blocked = routeDoctorFromHook(request, output, host.installRoot);
      assert.equal(blocked.decision, output.decision);
      assert.match(blocked.reason, /Doctor incident capture is unavailable/);
    } finally {
      if (previous === undefined) delete process.env.SUPERVISED_WORKER_HOST_AUTHORITY;
      else process.env.SUPERVISED_WORKER_HOST_AUTHORITY = previous;
    }
  });
});

test("lost outcome publication preserves the reserved state and forbids effect replay", (context) => {
  withFixture(({ cwd, input, authority }) => {
    const incidentId = randomUUID();
    const { incident } = detectDoctorIncident(cwd, input, incidentId, "a".repeat(64), authority);
    const intent = intentFor(cwd, input, authority, incident, "inspect");
    const originalRename = fs.renameSync;
    let injected = 0;
    context.mock.method(fs, "renameSync", (from, to) => {
      if (String(to).includes(`${path.sep}records${path.sep}`) && String(to).endsWith(".json")) {
        const value = JSON.parse(readFileSync(from));
        if (value.kind === "doctor-commit" && value.incident.revision === 2) {
          injected += 1;
          throw Object.assign(new Error("injected before outcome publication"), { code: "EIO" });
        }
      }
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => executeDoctorIntent(cwd, input, intent, authority));
      assert.equal(injected, 1, "the actual outcome publication must be intercepted");
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(inspectDoctorIncident(cwd, input, incidentId, authority).incident.pendingActionHash, doctorHash(intent));
    assert.equal(executeDoctorIntent(cwd, input, intent, authority).status, "unknown");
  });
});