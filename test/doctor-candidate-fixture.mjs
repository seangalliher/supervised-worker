import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";

import { sha256 } from "../src/core.mjs";
import { detectDoctorIncident, executeDoctorIntent, grantDoctorAction, inspectDoctorIncident } from "../src/doctor.mjs";
import { doctorHash } from "../src/doctor-state.mjs";
import { createDoctorHostAdapter } from "../src/doctor-promotion.mjs";
import { doctorGit, doctorRepairItemId, doctorRepairLocation, snapshotDoctorUserWork } from "../src/doctor-repair.mjs";
import { resolvePluginSourceIdentity } from "../src/install.mjs";
import { acceptWorkflowRoles, resolveWorkflowRoles } from "../src/workflow.mjs";
import { createWorkerAuthorityFixture } from "./worker-authority-fixture.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const json = (file) => JSON.parse(readFileSync(path.join(sourceRoot, file)));

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(value));
  writeFileSync(file, bytes);
  return sha256(bytes);
}

export function withDoctorCandidateFixture(callback, fault = null) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "doctor-candidate-fixture-")));
  try {
    const campaign = path.join(base, "campaign");
    const source = path.join(base, "source");
    const attempts = path.join(base, "attempts");
    for (const directory of [campaign, source, attempts]) mkdirSync(directory);
    for (const entry of ["LICENSE", "NOTICE", "README.md", "package.json", "plugin.json", "hooks.json", "agents", "com.github.copilot", "policy", "schemas", "skills", "src"]) {
      cpSync(path.join(sourceRoot, entry), path.join(source, entry), { recursive: true });
    }
    doctorGit(source, ["init", "--quiet"]);
    doctorGit(source, ["config", "core.autocrlf", "false"]);
    doctorGit(source, ["config", "user.name", "Fixture"]);
    doctorGit(source, ["config", "user.email", "fixture@example.invalid"]);
    doctorGit(source, ["add", "."]);
    doctorGit(source, ["-c", "commit.gpgSign=false", "commit", "-m", "fixture baseline"]);
    const baseCommit = doctorGit(source, ["rev-parse", "HEAD"]).trim();
    const baseTree = doctorGit(source, ["rev-parse", "HEAD^{tree}"]).trim();
    writeFileSync(path.join(source, "human-notes.txt"), "unrelated human work\n");
    const humanHash = snapshotDoctorUserWork(source);
    const input = { session_id: "candidate-fixture-only" };
    const worker = createWorkerAuthorityFixture(campaign, input);
    const config = json("examples/workflow.json");
    config.authority.mode = "delegated";
    config.doctor = { sourceRepository: source, repairDirectory: attempts, baseCommit };
    writeJson(path.join(campaign, ".github", "supervised-worker.json"), config);
    assert.equal(acceptWorkflowRoles(campaign, resolveWorkflowRoles(campaign).workflowHash).accepted, true);
    assert.equal(worker.admit().status, "applied");
    const authority = worker.authority();
    const workflow = resolveWorkflowRoles(campaign, { requireAcceptance: true });
    const incidentId = randomUUID();
    detectDoctorIncident(campaign, input, incidentId, "a".repeat(64), authority);
    const observe = () => inspectDoctorIncident(campaign, input, incidentId, authority);
    const makeIntent = (action, hashes = [], actionId = randomUUID()) => {
      const incident = observe().incident;
      const grant = grantDoctorAction(campaign, input, incidentId, { action, actionId, expectedHash: doctorHash(incident) }, authority);
      return { schemaVersion: 1, kind: "doctor-repair-intent", binding: incident.binding, attemptId: incident.attemptId,
        action, actionId, expectedHash: doctorHash(incident), capabilityHash: grant.hash, inputHashes: hashes };
    };
    const run = (intent, adapter = null) => executeDoctorIntent(campaign, input, intent, authority, adapter);
    assert.equal(run(makeIntent("inspect")).status, "succeeded");
    const repairActionId = randomUUID();
    const itemId = doctorRepairItemId(incidentId, repairActionId);
    const directory = path.join(campaign, ".supervised-worker", "handoffs", sha256(itemId));
    const contract = json("examples/handoff.build-contract.json");
    Object.assign(contract, { itemId, producedBy: workflow.roles.architect, workflowHash: workflow.workflowHash,
      targetFiles: ["src/fixture-repair.mjs"], focusedChecks: ["node --check src/fixture-repair.mjs"] });
    const contractHash = writeJson(path.join(directory, "build-contract.json"), contract);
    const created = run(makeIntent("create-repair", [contractHash], repairActionId));
    assert.equal(created.status, "succeeded", JSON.stringify(created));
    const repair = created.values[0];
    const location = doctorRepairLocation(campaign, workflow.doctor, incidentId, repairActionId);
    writeFileSync(path.join(location.root, "src", "fixture-repair.mjs"), "export const repaired = true;\n");
    doctorGit(location.root, ["add", "src/fixture-repair.mjs"]);
    doctorGit(location.root, ["-c", "commit.gpgSign=false", "commit", "-m", "fixture repair"]);
    const commit = doctorGit(location.root, ["rev-parse", "HEAD"]).trim();
    const tree = doctorGit(location.root, ["rev-parse", "HEAD^{tree}"]).trim();
    const build = json("examples/handoff.build-report.json");
    Object.assign(build, { itemId, producedBy: workflow.roles.builder, workflowHash: workflow.workflowHash, contractHash, testedTreeHash: tree,
      changedFiles: contract.targetFiles, checks: [...contract.focusedChecks, "npm test", "npm run validate"].map((command) =>
        ({ command, outcome: "passed", evidence: { kind: "test-output", locator: "fixture:bounded-check-evidence" } })) });
    const buildHash = writeJson(path.join(directory, "build-report.json"), build);
    const validated = run(makeIntent("validate", [doctorHash(repair)]));
    assert.equal(validated.status, "succeeded", JSON.stringify(validated));
    const validation = validated.values[0];
    const review = json("examples/handoff.review-report.json");
    Object.assign(review, { itemId, producedBy: workflow.roles.reviewer, workflowHash: workflow.workflowHash, contractHash, buildReportHash: buildHash,
      stagedTreeHash: tree, consumers: contract.consumers, reviewAttemptId: validation.reviewAttemptId, createdAt: validation.issuedAt });
    for (const role of ["builder", "reviewer"]) {
      const locator = `.supervised-worker/runtime/model-receipts/${sha256(itemId)}/${role}.json`;
      const model = review.modelResolution[role];
      const receiptHash = writeJson(path.join(campaign, locator), { schemaVersion: 2, itemId, role, agentSelector: workflow.roles[role],
        model: model.model, family: model.family, workflowHash: workflow.workflowHash, reviewAttemptId: review.reviewAttemptId,
        buildReportHash: buildHash, stagedTreeHash: tree, observedBy: "supervised-worker:seangalliher-supervised-worker",
        observedAt: review.createdAt, host: "copilot-cli", sessionHash: "d".repeat(64), source: "host" });
      model.evidence = { kind: "host-model", locator, sha256: receiptHash };
    }
    writeJson(path.join(directory, "review-report.json"), review);
    const reviewedResult = run(makeIntent("review", [doctorHash(validation)]));
    assert.equal(reviewedResult.status, "succeeded", JSON.stringify(reviewedResult));
    const reviewed = reviewedResult.values[0];
    const identity = resolvePluginSourceIdentity(worker.installRoot);
    const initial = { schemaVersion: 1, kind: "doctor-host-observation", complete: true, safeActivation: true,
      workerAuthorities: 1, hookAuthorities: 1, legacyEnabled: false, generation: 1, installRoot: worker.installRoot,
      sourceHash: identity.sourceHash, installRecordHash: sha256(readFileSync(path.join(worker.installRoot, "install-record.json"))), commit: baseCommit, tree: baseTree };
    let active = initial;
    const operations = new Map();
    const adapter = createDoctorHostAdapter(campaign, input, authority, {
      observe: () => structuredClone(active),
      observeMatrix: (expected) => ({ complete: true, commit: expected, runId: 1, conclusion: fault === "ci-pending" ? "in_progress" : "success",
        jobs: ["ubuntu-latest", "macos-latest", "windows-latest"].flatMap((os) => [20, 22, 24].map((node) => ({ name: `test (${os}, ${node})`,
          commit: expected, conclusion: "success", steps: ["npm test", "npm run validate"].map((command) => ({ name: `Run ${command}`, status: "completed", conclusion: "success" })) }))) }),
      health: (root) => ({ status: fault === "post-health" && root !== initial.installRoot && active.installRoot === root ? "unhealthy" : "healthy",
        sourceHash: resolvePluginSourceIdentity(root).sourceHash }),
      compareAndSet: (expected, replacement, key) => {
        if (operations.has(key)) return operations.get(key);
        assert.equal(doctorHash(expected), doctorHash(active));
        active = structuredClone(replacement);
        operations.set(key, structuredClone(replacement));
        if (fault === "lost-reply") throw new Error("fixture lost reply after activation");
        return replacement;
      },
      continueCampaign: (request) => ({ schemaVersion: 1, kind: "doctor-continuation", binding: observeBinding(), actionId: request.actionId,
        stateHash: request.expectedHash, interruptedActionHash: "f".repeat(64), reason: fault === "continue-unknown" ? "DOCTOR_RESUME_OUTCOME_UNKNOWN" : "DOCTOR_CONTINUED",
        status: fault === "continue-unknown" ? "unknown" : "resumed" }),
    });
    const observeBinding = () => reviewed.binding;
    const childResults = [];
    const originalSpawn = childProcess.spawnSync;
    const observedSpawn = mock.method(childProcess, "spawnSync", (command, args, options) => {
      const startedAt = performance.now();
      const result = originalSpawn(command, args, options);
      childResults.push({ executable: path.basename(command), timeout: options?.timeout ?? null,
        status: result.status, errorCode: result.error?.code ?? null, elapsedMs: performance.now() - startedAt });
      return result;
    });
    syncBuiltinESMExports();
    try {
      callback({ campaign, source, input, authority, workflow, worker, repairRoot: location.root, reviewed, commit, tree, initial,
        makeIntent, run, observe, adapter, active: () => active, operations, humanHash, childResults });
    } finally {
      observedSpawn.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}