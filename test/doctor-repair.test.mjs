import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256 } from "../src/core.mjs";
import { doctorHash } from "../src/doctor-state.mjs";
import { validateDoctorRepair, reviewDoctorRepair } from "../src/doctor-evidence.mjs";
import { inspectHandoffFile } from "../src/handoff.mjs";
import { acceptWorkflowRoles, resolveWorkflowRoles } from "../src/workflow.mjs";
import { createDoctorRepairAttempt, cleanupDoctorRepairAttempt, doctorGit, doctorRepairItemId, doctorRepairLocation, snapshotDoctorUserWork } from "../src/doctor-repair.mjs";

function fixture(action) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "doctor-repair-fixture-")));
  try {
    const source = path.join(base, "source");
    const campaign = path.join(base, "campaign");
    const attempts = path.join(base, "attempts");
    for (const directory of [source, campaign, attempts]) mkdirSync(directory);
    doctorGit(source, ["init"]);
    doctorGit(source, ["config", "user.name", "Fixture"]);
    doctorGit(source, ["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(path.join(source, "plugin.json"), JSON.stringify({ name: "supervised-worker", version: "0.0.0" }));
    writeFileSync(path.join(source, "human.txt"), "committed\n");
    doctorGit(source, ["add", "."]);
    doctorGit(source, ["-c", "commit.gpgSign=false", "commit", "-m", "fixture baseline"]);
    const baseCommit = doctorGit(source, ["rev-parse", "HEAD"]).trim();
    writeFileSync(path.join(source, "human.txt"), "human staged bytes\n");
    doctorGit(source, ["add", "human.txt"]);
    writeFileSync(path.join(source, "human.txt"), "human unstaged bytes\n");
    writeFileSync(path.join(source, "untracked.txt"), "human untracked bytes\n");
    const configuration = JSON.parse(readFileSync(new URL("../examples/workflow.json", import.meta.url)));
    configuration.doctor = { sourceRepository: source, repairDirectory: attempts, baseCommit };
    mkdirSync(path.join(campaign, ".github"));
    writeFileSync(path.join(campaign, ".github", "supervised-worker.json"), JSON.stringify(configuration));
    const acceptance = acceptWorkflowRoles(campaign, resolveWorkflowRoles(campaign).workflowHash);
    assert.equal(acceptance.accepted, true);
    const workflow = resolveWorkflowRoles(campaign, { requireAcceptance: true });
    const binding = { incidentId: randomUUID(), repositoryHash: "a".repeat(64), campaignHash: "b".repeat(64), workflowHash: workflow.workflowHash };
    const actionId = randomUUID();
    const itemId = doctorRepairItemId(binding.incidentId, actionId);
    const contract = JSON.parse(readFileSync(new URL("../examples/handoff.build-contract.json", import.meta.url)));
    Object.assign(contract, { itemId, workflowHash: binding.workflowHash, producedBy: workflow.roles.architect });
    const directory = path.join(campaign, ".supervised-worker", "handoffs", sha256(itemId));
    mkdirSync(directory, { recursive: true });
    const bytes = JSON.stringify(contract);
    writeFileSync(path.join(directory, "build-contract.json"), bytes);
    const inspection = inspectHandoffFile(campaign, path.join(directory, "build-contract.json"));
    assert.equal(inspection.ok, true, `fixture contract must be admitted: ${JSON.stringify(inspection.errors)}`);
    const intent = { schemaVersion: 1, kind: "doctor-repair-intent", binding, attemptId: randomUUID(), actionId, action: "create-repair",
      capabilityHash: "d".repeat(64), expectedHash: "e".repeat(64), inputHashes: [sha256(bytes)] };
    action({ source, campaign, workflow, intent });
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("Doctor creates an exact isolated attempt while preserving staged, unstaged, and untracked work", () => {
  fixture(({ source, campaign, workflow, intent }) => {
    const before = snapshotDoctorUserWork(source);
    const attempt = createDoctorRepairAttempt(campaign, workflow, intent);
    const location = doctorRepairLocation(campaign, workflow.doctor, intent.binding.incidentId, intent.actionId);
    assert.equal(attempt.status, "created");
    assert.equal(doctorGit(location.root, ["rev-parse", "HEAD"]).trim(), workflow.doctor.baseCommit);
    assert.equal(snapshotDoctorUserWork(source), before);
    assert.throws(() => createDoctorRepairAttempt(campaign, workflow, intent), /ALREADY_EXISTS/);
    assert.equal(cleanupDoctorRepairAttempt(campaign, workflow, attempt).status, "removed");
    assert.equal(existsSync(location.root), false);
    assert.equal(snapshotDoctorUserWork(source), before);
  });
});

test("Doctor retains a dirty attempt instead of resetting or deleting it", () => {
  fixture(({ source, campaign, workflow, intent }) => {
    const before = snapshotDoctorUserWork(source);
    const attempt = createDoctorRepairAttempt(campaign, workflow, intent);
    const location = doctorRepairLocation(campaign, workflow.doctor, intent.binding.incidentId, intent.actionId);
    writeFileSync(path.join(location.root, "new-work.txt"), "retain this work");
    assert.equal(cleanupDoctorRepairAttempt(campaign, workflow, attempt).status, "retained");
    assert.equal(readFileSync(path.join(location.root, "new-work.txt"), "utf8"), "retain this work");
    assert.equal(snapshotDoctorUserWork(source), before);
  });
});

test("Doctor rejects missing approval, wrong source, and non-isolated repair roots", () => {
  fixture(({ source, campaign, workflow, intent }) => {
    assert.throws(() => createDoctorRepairAttempt(campaign, workflow, { ...intent, inputHashes: [] }), /CONTRACT_UNCONFIRMED/);
    assert.throws(() => doctorRepairLocation(campaign, null, intent.binding.incidentId, intent.actionId), /POLICY_UNAVAILABLE/);
    assert.throws(() => doctorRepairLocation(campaign, { ...workflow.doctor, repairDirectory: source }, intent.binding.incidentId, intent.actionId), /ISOLATION_REQUIRED/);
    assert.throws(() => doctorRepairLocation(campaign, { ...workflow.doctor, baseCommit: "invalid" }, intent.binding.incidentId, intent.actionId), /RECORD_INVALID/);
  });
});

test("Doctor evidence snapshots do not execute a repository textconv command", () => {
  fixture(({ source }) => {
    const marker = path.join(source, "textconv-fired");
    const probe = path.join(source, "textconv-probe.cjs");
    writeFileSync(probe, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdout.write("converted");`);
    writeFileSync(path.join(source, ".gitattributes"), "human.txt diff=doctor-probe\n");
    doctorGit(source, ["config", "diff.doctor-probe.textconv", `\"${process.execPath.replaceAll("\\", "/")}\" \"${probe.replaceAll("\\", "/")}\"`]);
    assert.equal(existsSync(marker), false);
    doctorGit(source, ["diff", "--cached", "--textconv", "--", "human.txt"]);
    assert.equal(existsSync(marker), true, "the unprotected control must execute the actual textconv fixture");
    rmSync(marker);
    snapshotDoctorUserWork(source);
    assert.equal(existsSync(marker), false);
  });
});

test("Doctor rejects case-variant protected repair targets", () => {
  fixture(({ campaign, workflow, intent }) => {
    const file = path.join(campaign, ".supervised-worker", "handoffs", sha256(doctorRepairItemId(intent.binding.incidentId, intent.actionId)), "build-contract.json");
    const baseline = JSON.parse(readFileSync(file));
    for (const target of ["Policy/constitution.json", "POLICY/constitution.json", ".GitHub/workflows/ci.yml"]) {
      const bytes = JSON.stringify({ ...baseline, targetFiles: [target] });
      writeFileSync(file, bytes);
      assert.throws(() => createDoctorRepairAttempt(campaign, workflow, { ...intent, inputHashes: [sha256(bytes)] }), /CONTRACT_REJECTED/);
    }
  });
});

test("Doctor validates and independently reviews the isolated source using parent-owned evidence", () => {
  fixture(({ campaign, workflow, intent }) => {
    const repair = createDoctorRepairAttempt(campaign, workflow, intent);
    const location = doctorRepairLocation(campaign, workflow.doctor, intent.binding.incidentId, intent.actionId);
    for (const directory of ["src", "test"]) mkdirSync(path.join(location.root, directory));
    writeFileSync(path.join(location.root, "src", "adapter.js"), "export const repaired = true;\n");
    writeFileSync(path.join(location.root, "test", "adapter.test.js"), "import 'node:test';\n");
    doctorGit(location.root, ["add", "src/adapter.js", "test/adapter.test.js"]);
    const tree = doctorGit(location.root, ["write-tree"]).trim();
    const directory = path.join(campaign, ".supervised-worker", "handoffs", sha256(doctorRepairItemId(intent.binding.incidentId, intent.actionId)));
    const contract = JSON.parse(readFileSync(path.join(directory, "build-contract.json")));
    const build = JSON.parse(readFileSync(new URL("../examples/handoff.build-report.json", import.meta.url)));
    Object.assign(build, { itemId: contract.itemId, producedBy: workflow.roles.builder, workflowHash: workflow.workflowHash,
      contractHash: repair.contractHash, testedTreeHash: tree, checks: [...new Set([...contract.focusedChecks, contract.broadGate, "npm test", "npm run validate"])].map((command) =>
        ({ command, outcome: "passed", evidence: { kind: "test-output", locator: "fixture:recorded-check" } })) });
    const buildBytes = JSON.stringify(build);
    writeFileSync(path.join(directory, "build-report.json"), buildBytes);
    const validationIntent = { ...intent, actionId: randomUUID(), action: "validate", inputHashes: [doctorHash(repair)] };
    const validation = validateDoctorRepair(campaign, workflow, validationIntent, [repair]);
    assert.equal(validation.tree, tree);
    const review = JSON.parse(readFileSync(new URL("../examples/handoff.review-report.json", import.meta.url)));
    Object.assign(review, { itemId: contract.itemId, producedBy: workflow.roles.reviewer, workflowHash: workflow.workflowHash,
      contractHash: repair.contractHash, buildReportHash: sha256(buildBytes), stagedTreeHash: tree, consumers: contract.consumers,
      reviewAttemptId: validation.reviewAttemptId, createdAt: validation.issuedAt });
    for (const role of ["builder", "reviewer"]) {
      const locator = `.supervised-worker/runtime/model-receipts/${sha256(contract.itemId)}/${role}.json`;
      const receipt = { schemaVersion: 2, itemId: contract.itemId, role, agentSelector: workflow.roles[role],
        model: review.modelResolution[role].model, family: review.modelResolution[role].family, workflowHash: workflow.workflowHash,
        reviewAttemptId: review.reviewAttemptId, buildReportHash: review.buildReportHash, stagedTreeHash: tree,
        observedBy: "supervised-worker:seangalliher-supervised-worker", observedAt: review.createdAt, host: "copilot-cli", sessionHash: "f".repeat(64), source: "host" };
      const bytes = JSON.stringify(receipt);
      mkdirSync(path.dirname(path.join(campaign, locator)), { recursive: true });
      writeFileSync(path.join(campaign, locator), bytes);
      review.modelResolution[role].evidence = { kind: "host-model", locator, sha256: sha256(bytes) };
    }
    writeFileSync(path.join(directory, "review-report.json"), JSON.stringify(review));
    const reviewIntent = { ...intent, actionId: randomUUID(), action: "review", inputHashes: [doctorHash(validation)] };
    const reviewed = reviewDoctorRepair(campaign, workflow, reviewIntent, [repair, validation]);
    assert.equal(reviewed.tree, tree);
    assert.equal(reviewed.repairHash, doctorHash(repair));
    assert.equal(existsSync(path.join(location.root, ".supervised-worker")), false);
    rmSync(path.join(campaign, review.modelResolution.reviewer.evidence.locator));
    assert.throws(() => reviewDoctorRepair(campaign, workflow, reviewIntent, [repair, validation]), /REVIEW_VERIFICATION_FAILED/);
    assert.throws(() => validateDoctorRepair(campaign, workflow, { ...validationIntent, inputHashes: [] }, [repair]), /EXACT_EVIDENCE_REQUIRED/);
  });
});