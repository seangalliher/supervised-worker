import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256 } from "../src/core.mjs";
import { detectDoctorIncident } from "../src/doctor.mjs";
import { doctorHash } from "../src/doctor-state.mjs";
import { observeReleaseDoctorInventory, openWorkerReleaseInputs, summarizeReleaseDoctor, useWorkerReleaseInputs } from "../src/release-inputs.mjs";
import { acceptWorkflowRoles, resolveWorkflowRoles } from "../src/workflow.mjs";
import { createWorkerAuthorityFixture } from "./worker-authority-fixture.mjs";

function fixture(action) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "release-input-fixture-")));
  try {
    const input = { session_id: "release-test-only" };
    const worker = createWorkerAuthorityFixture(root, input);
    assert.equal(worker.admit().status, "applied");
    const authority = worker.authority();
    const reference = { locator: ".supervised-worker/plan.json", sha256: sha256(readFileSync(path.join(root, ".supervised-worker", "plan.json"))) };
    const manifest = { schemaVersion: 1, kind: "campaign-release-input", candidate: { commit: "a".repeat(40), tree: "b".repeat(40), baseCommit: "c".repeat(40), ref: "refs/heads/main" },
      artifacts: [{ role: "plan", reference }], doctorInventoryHash: observeReleaseDoctorInventory(root, input, authority).doctorInventoryHash };
    action({ root, input, authority, manifest });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("release capture requires genuine Worker-opened inputs and performs no writes", () => {
  fixture(({ root, input, authority, manifest }) => {
    const before = readdirSync(path.join(root, ".supervised-worker"));
    const token = openWorkerReleaseInputs(root, input, manifest, authority);
    assert.equal(useWorkerReleaseInputs(token, ({ artifacts }) => artifacts.length), 1);
    assert.throws(() => useWorkerReleaseInputs(token, ({ artifacts }) => { artifacts[0].value.mode = "complete"; }), TypeError);
    assert.throws(() => useWorkerReleaseInputs(token, (captured) => { captured.manifest.candidate.commit = "f".repeat(40); }), TypeError);
    assert.throws(() => useWorkerReleaseInputs({ ...token }, () => null), /WORKER_OPENED/);
    assert.throws(() => openWorkerReleaseInputs(root, input, manifest, { ...authority }), /verified/);
    assert.deepEqual(readdirSync(path.join(root, ".supervised-worker")), before);
    assert.equal(existsSync(path.join(root, ".supervised-worker", "release-inputs")), false);
  });
});

test("release capture rejects changed artifacts, unsafe paths, and duplicate roles", () => {
  fixture(({ root, input, authority, manifest }) => {
    const token = openWorkerReleaseInputs(root, input, manifest, authority);
    assert.throws(() => openWorkerReleaseInputs(root, input, { ...manifest, artifacts: [...manifest.artifacts, manifest.artifacts[0]] }, authority), /ROLE_INVENTORY/);
    assert.throws(() => openWorkerReleaseInputs(root, input, { ...manifest, artifacts: [{ role: "plan", reference: { ...manifest.artifacts[0].reference, locator: ".supervised-worker/../outside.json" } }] }, authority), /LOCATOR/);
    const file = path.join(root, ".supervised-worker", "plan.json");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
    assert.throws(() => useWorkerReleaseInputs(token, () => null), /OWNER_CHANGED|ARTIFACT_CHANGED/);
  });
});

test("Doctor inventory binds complete recorded history and rejects a missing applicable artifact", () => {
  fixture(({ root, input, authority, manifest }) => {
    mkdirSync(path.join(root, ".github"));
    writeFileSync(path.join(root, ".github", "supervised-worker.json"), readFileSync(new URL("../examples/workflow.json", import.meta.url)));
    assert.equal(acceptWorkflowRoles(root, resolveWorkflowRoles(root).workflowHash).accepted, true);
    const incidentId = randomUUID();
    detectDoctorIncident(root, input, incidentId, "a".repeat(64), authority);
    const inventory = observeReleaseDoctorInventory(root, input, authority);
    assert.ok(inventory.references.length > 0);
    const current = { ...manifest, doctorInventoryHash: inventory.doctorInventoryHash };
    const token = openWorkerReleaseInputs(root, input, current, authority);
    assert.equal(useWorkerReleaseInputs(token, summarizeReleaseDoctor).incidents[0].incidentId, incidentId);
    const artifact = inventory.references.find((entry) => entry.locator.includes("/artifacts/"));
    rmSync(path.join(root, artifact.locator));
    assert.throws(() => useWorkerReleaseInputs(token, summarizeReleaseDoctor), /INPUTS_CHANGED/);
    assert.throws(() => openWorkerReleaseInputs(root, input, current, authority), /INVENTORY_CHANGED/);
  });
});

test("release input rejects hard links and dangling Doctor roots rather than declaring no incidents", () => {
  fixture(({ root, input, authority, manifest }) => {
    const original = path.join(root, ".supervised-worker", "plan.json");
    const linked = path.join(root, ".supervised-worker", "plan-copy.json");
    linkSync(original, linked);
    assert.throws(() => openWorkerReleaseInputs(root, input, manifest, authority));
    rmSync(linked);
    assert.doesNotThrow(() => openWorkerReleaseInputs(root, input, manifest, authority));
    const target = path.join(root, "missing-doctor");
    symlinkSync(target, path.join(root, ".supervised-worker", "doctor"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => observeReleaseDoctorInventory(root, input, authority), /LINK_REJECTED/);
  });
});

test("hash-consistent Doctor state jumps cannot assert resolution", () => {
  fixture(({ root, input, authority, manifest }) => {
    mkdirSync(path.join(root, ".github"));
    writeFileSync(path.join(root, ".github", "supervised-worker.json"), readFileSync(new URL("../examples/workflow.json", import.meta.url)));
    assert.equal(acceptWorkflowRoles(root, resolveWorkflowRoles(root).workflowHash).accepted, true);
    const { incident, hash } = detectDoctorIncident(root, input, randomUUID(), "a".repeat(64), authority);
    const next = { ...incident, revision: 1, previousHash: hash, state: "resolved" };
    const prefix = path.join(root, ".supervised-worker", "doctor", incident.binding.incidentId);
    const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
    const write = (location, value) => {
      const bytes = JSON.stringify(canonical(value));
      assert.equal(sha256(bytes), doctorHash(value), "forged fixture must retain valid content hashes");
      writeFileSync(path.join(prefix, location, `${doctorHash(value)}.json`), bytes);
    };
    write("artifacts", next);
    write("records", { schemaVersion: 1, kind: "doctor-commit", binding: incident.binding, incident: next, records: [] });
    const current = { ...manifest, doctorInventoryHash: observeReleaseDoctorInventory(root, input, authority).doctorInventoryHash };
    assert.throws(() => useWorkerReleaseInputs(openWorkerReleaseInputs(root, input, current, authority), summarizeReleaseDoctor), /DOCTOR_TRANSITION_INVALID/);
  });
});