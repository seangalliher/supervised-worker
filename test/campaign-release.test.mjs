import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileCampaignRelease, compileOpenedCampaignRelease, renderCampaignReleaseMarkdown, serializeCampaignRelease, validateCompiledRelease } from "../src/campaign-release.mjs";
import { canonicalPlanHash, observeCampaignTransition, sha256 } from "../src/core.mjs";
import { detectDoctorIncident } from "../src/doctor.mjs";
import { doctorGit } from "../src/doctor-repair.mjs";
import { acceptWorkflowRoles, DEFAULT_ROLES, resolveWorkflowRoles } from "../src/workflow.mjs";
import { observeReleaseDoctorInventory } from "../src/release-inputs.mjs";
import { createWorkerAuthorityFixture } from "./worker-authority-fixture.mjs";

function fixture(action) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "release-compiler-fixture-")));
  try {
    doctorGit(root, ["init", "--quiet", "--initial-branch=main"]);
    doctorGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "fixture"]);
    const input = { session_id: "compiler-test-only" };
    const worker = createWorkerAuthorityFixture(root, input);
    assert.equal(worker.admit().status, "applied");
    const authority = worker.authority();
    const planBytes = readFileSync(path.join(root, ".supervised-worker", "plan.json"));
    const commit = doctorGit(root, ["rev-parse", "HEAD"]).trim();
    const candidate = { commit, tree: doctorGit(root, ["rev-parse", "HEAD^{tree}"]).trim(), baseCommit: commit, ref: "refs/heads/main" };
    const manifest = { schemaVersion: 1, kind: "campaign-release-input", candidate,
      artifacts: [{ role: "plan", reference: { locator: ".supervised-worker/plan.json", sha256: sha256(planBytes) } }],
      doctorInventoryHash: observeReleaseDoctorInventory(root, input, authority).doctorInventoryHash };
    const add = (role, value) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const hash = sha256(bytes);
      const locator = `.supervised-worker/release-inputs/${hash}.json`;
      mkdirSync(path.dirname(path.join(root, locator)), { recursive: true });
      writeFileSync(path.join(root, locator), bytes);
      manifest.artifacts.push({ role, reference: { locator, sha256: hash } });
    };
    action({ root, input, authority, worker, manifest, add, plan: JSON.parse(planBytes) });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("identical Worker-opened inputs yield identical JSON and Markdown without upgrading unavailable facts", () => {
  fixture(({ root, input, authority, manifest }) => {
    const first = compileCampaignRelease(root, input, manifest, authority);
    const second = compileCampaignRelease(root, input, structuredClone(manifest), authority);
    assert.equal(serializeCampaignRelease(first), serializeCampaignRelease(second));
    assert.equal(renderCampaignReleaseMarkdown(first), renderCampaignReleaseMarkdown(second));
    assert.equal(renderCampaignReleaseMarkdown(first), renderCampaignReleaseMarkdown(JSON.parse(serializeCampaignRelease(first))));
    assert.notEqual(renderCampaignReleaseMarkdown(first), renderCampaignReleaseMarkdown({ ...first, inputHash: "f".repeat(64) }));
    assert.ok(renderCampaignReleaseMarkdown(first).includes(`Receipt: ${sha256(serializeCampaignRelease(first))}`));
    assert.equal(first.doctor.status, "inapplicable");
    assert.equal(first.dispositions.item, "inapplicable");
    assert.equal(first.dispositions.provider, "unavailable");
    assert.deepEqual(first.authority, { grantsPermissions: false, satisfiesStop: false, providerSealed: false });
    assert.equal(first.timing.durationsMs, null);
    assert.throws(() => compileOpenedCampaignRelease({ kind: "worker-opened-release-inputs" }), /WORKER_OPENED/);
    assert.doesNotMatch(serializeCampaignRelease(first), /Complete the selected queue|test-only|fixture@example/);
    const changed = structuredClone(first);
    changed.facts.find((fact) => fact.name === "ci").status = "verified";
    assert.ok(validateCompiledRelease(changed).length > 0);
    for (const name of ["ci", "models", "closures"]) {
      const drifted = structuredClone(first);
      Object.assign(drifted.facts.find((fact) => fact.name === name), { status: "recorded", provenance: "plugin-verified-local" });
      assert.ok(validateCompiledRelease(drifted).length > 0);
    }
    assert.ok(validateCompiledRelease({ ...first, dispositions: { ...first.dispositions, doctor: "recorded-resolved" } }).length > 0);
  });
});

test("changed commit, tree, ref, or subordinate bytes invalidates compilation", () => {
  fixture(({ root, input, authority, manifest }) => {
    assert.doesNotThrow(() => compileCampaignRelease(root, input, manifest, authority));
    for (const key of ["commit", "tree", "ref"]) {
      const changed = structuredClone(manifest);
      changed.candidate[key] = key === "ref" ? "refs/heads/missing" : "f".repeat(40);
      assert.throws(() => compileCampaignRelease(root, input, changed, authority));
    }
    writeFileSync(path.join(root, ".supervised-worker", "plan.json"), "{}");
    assert.throws(() => compileCampaignRelease(root, input, manifest, authority));
  });
});

test("complete measured timings stay separate and incomplete observations become unavailable", () => {
  fixture(({ root, input, authority, manifest, add, plan }) => {
    const durationsMs = Object.fromEntries(["productiveWorker", "productiveModel", "hookContention", "retries", "recovery", "doctor", "evidenceCompilation", "formalReview", "broadGates"].map((category, index) => [category, index * 10]));
    const value = { schemaVersion: 1, kind: "release-timing-observation", planHash: canonicalPlanHash(plan), commit: manifest.candidate.commit,
      complete: true, doctorIncluded: false, basis: "measured-activity-durations", durationsMs };
    add("timing", value);
    assert.deepEqual(compileCampaignRelease(root, input, manifest, authority).timing.durationsMs, durationsMs);
    manifest.artifacts.pop();
    add("timing", { ...value, complete: false });
    const receipt = compileCampaignRelease(root, input, manifest, authority);
    assert.equal(receipt.timing.status, "unavailable");
    assert.equal(receipt.timing.durationsMs, null);
    assert.equal(receipt.timing.references.length, 1);
  });
});

for (const reviewMode of ["legacy-staged", "staged", "committed"]) {
test(`${reviewMode} handoff compilation binds published model evidence and separates item from campaign completion`, () => {
  fixture(({ root, input, authority, worker, manifest, plan }) => {
    writeFileSync(path.join(root, "earlier-item.txt"), "a previously completed item\n");
    doctorGit(root, ["add", "earlier-item.txt"]);
    doctorGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "earlier item"]);
    assert.notEqual(doctorGit(root, ["rev-parse", "HEAD"]).trim(), manifest.candidate.baseCommit, "the campaign must include an earlier unrelated commit");
    const itemId = plan.items[0].id;
    const directory = path.join(root, ".supervised-worker", "handoffs", sha256(itemId));
    mkdirSync(directory, { recursive: true });
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "module.mjs"), "export const tested = true;\n");
    doctorGit(root, ["add", "src/module.mjs"]);
    const tree = doctorGit(root, ["write-tree"]).trim();
    const load = (name) => JSON.parse(readFileSync(new URL(`../examples/handoff.${name}.json`, import.meta.url)));
    const save = (name, value) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const file = path.join(directory, `${name}.json`);
      writeFileSync(file, bytes);
      return { locator: `.supervised-worker/handoffs/${sha256(itemId)}/${name}.json`, sha256: sha256(bytes) };
    };
    const contract = { ...load("build-contract"), itemId, targetFiles: ["src/module.mjs"] };
    const contractReference = save("build-contract", contract);
    const build = { ...load("build-report"), itemId, contractHash: contractReference.sha256, testedTreeHash: tree, changedFiles: contract.targetFiles,
      checks: [...contract.focusedChecks, contract.broadGate].map((command) => ({ command, outcome: "passed", evidence: { kind: "test-output", locator: "fixture:check" } })) };
    const buildReference = save("build-report", build);
    const itemParent = doctorGit(root, ["rev-parse", "HEAD"]).trim();
    const commitCandidate = () => {
      doctorGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "reviewed candidate"]);
      manifest.candidate.commit = doctorGit(root, ["rev-parse", "HEAD"]).trim();
      manifest.candidate.tree = tree;
    };
    if (reviewMode === "committed") commitCandidate();
    const modeArguments = reviewMode === "committed" ? ["--committed", manifest.candidate.commit] : [];
    const runHandoff = (args, request) => {
      const result = spawnSync(process.execPath, [path.join(worker.installRoot, "src", "cli.mjs"), "handoff", ...args], {
        cwd: root, env: { ...process.env, SUPERVISED_WORKER_HOST_AUTHORITY: worker.inventoryPath },
        input: request === undefined ? undefined : JSON.stringify(request), encoding: "utf8", timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stdout || result.stderr);
      return JSON.parse(result.stdout);
    };
    const paths = [path.join(root, contractReference.locator), path.join(root, buildReference.locator)];
    assert.equal(runHandoff(["pre-review", ...paths, ...modeArguments]).ok, true);
    const attempt = runHandoff(["issue-review", ...paths, ...modeArguments]);
    assert.equal(attempt.ok, true, attempt.errors.join("\n"));
    assert.equal(attempt.schemaVersion, 2);
    assert.equal(attempt.mode, reviewMode === "committed" ? "committed" : "staged");
    assert.deepEqual(attempt.committedCandidate, reviewMode === "committed"
      ? { commit: manifest.candidate.commit, tree, baseCommit: itemParent } : undefined);
    const review = { ...load("review-report"), itemId, contractHash: contractReference.sha256, buildReportHash: buildReference.sha256,
      stagedTreeHash: tree, reviewAttemptId: attempt.reviewAttemptId, createdAt: attempt.issuedAt, consumers: contract.consumers };
    const modelReferences = [];
    for (const role of ["builder", "reviewer"]) {
      const value = { schemaVersion: 2, itemId, role, agentSelector: DEFAULT_ROLES[role], model: review.modelResolution[role].model,
        family: review.modelResolution[role].family, workflowHash: null, reviewAttemptId: attempt.reviewAttemptId,
        buildReportHash: buildReference.sha256, stagedTreeHash: tree, observedBy: "supervised-worker:seangalliher-supervised-worker",
        observedAt: new Date().toISOString(), host: "vscode", sessionHash: sha256(input.session_id), source: "host" };
      const publication = runHandoff(["record-model"], { ...input, expected: observeCampaignTransition(root, input), receipt: value });
      assert.equal(publication.ok, true);
      assert.equal(publication.provenance, "worker-recorded");
      const reference = { locator: publication.locator, sha256: publication.sha256 };
      assert.equal(sha256(readFileSync(path.join(root, reference.locator))), reference.sha256);
      review.modelResolution[role].evidence = { kind: "host-model", ...reference };
      modelReferences.push({ role: `model-${role}`, reference });
    }
    review.createdAt = new Date().toISOString();
    const reviewReference = save("review-report", review);
    if (reviewMode === "legacy-staged") {
      const attemptPath = path.join(root, attempt.locator);
      const legacy = JSON.parse(readFileSync(attemptPath));
      legacy.schemaVersion = 1;
      delete legacy.mode;
      writeFileSync(attemptPath, JSON.stringify(legacy));
    }
    assert.equal(runHandoff(["verify", ...paths, path.join(root, reviewReference.locator), ...modeArguments]).ok, true);
    if (reviewMode !== "committed") commitCandidate();
    assert.equal(doctorGit(root, ["diff", "--cached", "--name-only"]).trim(), "");
    plan.items[0].status = "banked";
    const bytes = Buffer.from(JSON.stringify(plan));
    writeFileSync(path.join(root, ".supervised-worker", "plan.json"), bytes);
    manifest.artifacts[0].reference.sha256 = sha256(bytes);
    manifest.artifacts.push({ role: "build-contract", reference: contractReference }, { role: "build-report", reference: buildReference },
      { role: "review-report", reference: reviewReference }, ...modelReferences);
    const receipt = compileCampaignRelease(root, input, manifest, authority);
    assert.equal(receipt.dispositions.item, "recorded-complete");
    assert.equal(receipt.dispositions.campaign, "incomplete");
    assert.equal(receipt.dispositions.hostSession, "unavailable");
    assert.equal(receipt.facts.find((fact) => fact.name === "models").status, "recorded");
    assert.equal(serializeCampaignRelease(receipt), serializeCampaignRelease(compileCampaignRelease(root, input, { ...manifest, artifacts: [...manifest.artifacts].reverse() }, authority)));
    const attemptPath = path.join(root, ".supervised-worker", "runtime", "review-attempts", `${sha256(itemId)}.json`);
    const attemptBytes = readFileSync(attemptPath);
    writeFileSync(attemptPath, JSON.stringify({ ...JSON.parse(attemptBytes), issuedAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString() }));
    assert.throws(() => compileCampaignRelease(root, input, manifest, authority), /RELEASE_HANDOFF_VERIFICATION_FAILED/, "expired item evidence must fail rather than be silently dropped");
    writeFileSync(attemptPath, attemptBytes);
    assert.doesNotThrow(() => compileCampaignRelease(root, input, manifest, authority));
    if (reviewMode === "committed") {
      doctorGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--amend", "-m", "same tree, different commit"]);
      const rewritten = doctorGit(root, ["rev-parse", "HEAD"]).trim();
      assert.notEqual(rewritten, manifest.candidate.commit);
      assert.equal(doctorGit(root, ["rev-parse", "HEAD^{tree}"]).trim(), tree);
      manifest.candidate.commit = rewritten;
      assert.throws(() => compileCampaignRelease(root, input, manifest, authority), /RELEASE_HANDOFF_VERIFICATION_FAILED/);
      return;
    }
    writeFileSync(path.join(root, modelReferences[0].reference.locator), "{}");
    assert.throws(() => compileCampaignRelease(root, input, manifest, authority), /ARTIFACT_CHANGED/);
  });
});

test("provider and queue observations remain recorded and cannot grant completion", () => {
  fixture(({ root, input, authority, manifest, add, plan }) => {
    const queue = { schemaVersion: 1, kind: "github-queue-observation", status: "complete", reason: null,
      scope: { host: "github.com", repository: "fixture/project", state: "open" }, startedAt: "2026-09-07T00:00:00.000Z", finishedAt: "2026-09-07T00:00:01.000Z",
      consistency: "interval-observation", integrity: "unattested", actor: { id: "fixture-actor" }, repository: { id: "fixture-repository", nameWithOwner: "fixture/project" }, totalCount: 0, pageCount: 1, issues: [] };
    add("queue-start", queue);
    assert.throws(() => compileCampaignRelease(root, input, manifest, authority), /QUEUE_PAIR_REQUIRED/);
    add("queue-final", { ...queue, startedAt: "2026-09-07T00:01:00.000Z", finishedAt: "2026-09-07T00:01:01.000Z" });
    const commit = manifest.candidate.commit;
    const ci = { commit, complete: true, runId: 1, conclusion: "success", jobs: ["ubuntu-latest", "macos-latest", "windows-latest"].flatMap((os) => [20, 22, 24].map((node) =>
      ({ name: `test (${os}, ${node})`, commit, conclusion: "success", steps: ["Run npm test", "Run npm run validate"].map((name) => ({ name, status: "completed", conclusion: "success" })) }))) };
    add("provider", { schemaVersion: 1, kind: "release-provider-observation", integrity: "unattested", actorHash: sha256(queue.actor.id), repositoryHash: sha256(queue.repository.id),
      commit, ref: manifest.candidate.ref, observedAt: "2026-09-07T00:02:00.000Z", complete: true, remoteCommit: commit, ci,
      closures: [{ itemHash: sha256(`supervised-worker-item-v1\0${plan.items[0].id}`), state: "CLOSED", stateReason: "COMPLETED" }] });
    const receipt = compileCampaignRelease(root, input, manifest, authority);
    for (const name of ["queue-start", "queue-final", "ci", "closures"]) assert.equal(receipt.facts.find((fact) => fact.name === name).status, "recorded");
    assert.equal(receipt.dispositions.provider, "unavailable");
    assert.equal(receipt.authority.satisfiesStop, false);
    assert.doesNotMatch(serializeCampaignRelease(receipt), /fixture-actor|fixture-repository|fixture\/project/);
    const provider = manifest.artifacts.find((entry) => entry.role === "provider");
    const observed = JSON.parse(readFileSync(path.join(root, provider.reference.locator)));
    manifest.artifacts = manifest.artifacts.filter((entry) => entry.role !== "provider");
    add("provider", { ...observed, closures: [{ ...observed.closures[0], itemHash: "e".repeat(64) }] });
    assert.throws(() => compileCampaignRelease(root, input, manifest, authority), /CLOSURE_NOT_IN_PLAN/);
    manifest.artifacts = manifest.artifacts.filter((entry) => entry.role !== "provider");
    manifest.artifacts.push(provider);
    rmSync(path.join(root, provider.reference.locator));
    assert.throws(() => compileCampaignRelease(root, input, manifest, authority));
  });
});

test("Doctor-inclusive receipt compiles through the installed CLI without companion ownership", () => {
  fixture(({ root, input, authority, worker, manifest, add, plan }) => {
    mkdirSync(path.join(root, ".github"));
    writeFileSync(path.join(root, ".github", "supervised-worker.json"), readFileSync(new URL("../examples/workflow.json", import.meta.url)));
    doctorGit(root, ["add", ".github/supervised-worker.json"]);
    doctorGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "fixture workflow"]);
    assert.equal(acceptWorkflowRoles(root, resolveWorkflowRoles(root).workflowHash).accepted, true);
    manifest.candidate.commit = doctorGit(root, ["rev-parse", "HEAD"]).trim();
    manifest.candidate.tree = doctorGit(root, ["rev-parse", "HEAD^{tree}"]).trim();
    detectDoctorIncident(root, input, randomUUID(), "a".repeat(64), authority);
    manifest.doctorInventoryHash = observeReleaseDoctorInventory(root, input, authority).doctorInventoryHash;
    const local = compileCampaignRelease(root, input, manifest, authority);
    assert.equal(local.doctor.incidents.length, 1);
    assert.equal(local.doctor.provenance, "worker-recorded");
    assert.equal(local.doctor.incidents[0].coverage, "partial");
    assert.deepEqual(local.doctor.incidents[0].dependencies[0], { name: "input", sha256: "a".repeat(64), status: "unavailable", reference: null });
    assert.equal(local.dispositions.doctor, "unresolved");
    const run = (format, env = {}) => spawnSync(process.execPath, [path.join(worker.installRoot, "src", "cli.mjs"), "campaign", "compile", "--format", format], {
      cwd: root, input: JSON.stringify({ ...input, manifest }), encoding: "utf8", timeout: 20000,
      env: { ...process.env, SUPERVISED_WORKER_HOST_AUTHORITY: worker.inventoryPath, ...env },
    });
    const compiled = run("json");
    assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr);
    assert.equal(compiled.stdout, serializeCampaignRelease(local));
    const markdown = run("markdown");
    assert.equal(markdown.status, 0, markdown.stdout || markdown.stderr);
    assert.equal(markdown.stdout, renderCampaignReleaseMarkdown(local));
    assert.equal(run("json", { SUPERVISED_WORKER_HOST_AUTHORITY: "" }).status, 1);
    add("timing", { schemaVersion: 1, kind: "release-timing-observation", planHash: canonicalPlanHash(plan), commit: manifest.candidate.commit,
      complete: true, doctorIncluded: false, basis: "measured-activity-durations", durationsMs: Object.fromEntries(["productiveWorker", "productiveModel", "hookContention", "retries", "recovery", "doctor", "evidenceCompilation", "formalReview", "broadGates"].map((name) => [name, 1])) });
    assert.equal(compileCampaignRelease(root, input, manifest, authority).timing.status, "unavailable");
  });
});

test("checkpoint disposition binds its exact plan and bytes without declaring campaign completion", () => {
  fixture(({ root, input, authority, manifest, plan }) => {
    const value = { schemaVersion: 1, kind: "session-checkpoint", checkpointId: randomUUID(), createdAt: "2026-09-07T00:00:00.000Z",
      planHash: canonicalPlanHash(plan), sessionHash: sha256(input.session_id), routeGeneration: null, claimGeneration: null, attachmentHash: "a".repeat(64),
      ledgerPosition: { path: `runs/${sha256(input.session_id)}.jsonl`, byteOffset: 0, recordCount: 0, prefixHash: sha256("") },
      context: { counts: { pending: 0, in_progress: 1, banked: 0, parked: 0 }, itemHashes: [sha256(`supervised-worker-checkpoint-item-v1\0${plan.items[0].id}`)], stopState: null,
        operations: { status: "observed", reason: null, orphans: [], uncorrelatedCompletions: 0 } } };
    const bytes = Buffer.from(JSON.stringify(value));
    const reference = { locator: `.supervised-worker/checkpoints/${sha256(bytes)}.json`, sha256: sha256(bytes) };
    mkdirSync(path.dirname(path.join(root, reference.locator)), { recursive: true });
    writeFileSync(path.join(root, reference.locator), bytes);
    manifest.artifacts.push({ role: "checkpoint", reference });
    const receipt = compileCampaignRelease(root, input, manifest, authority);
    assert.equal(receipt.dispositions.hostSession, "checkpoint-recorded");
    assert.equal(receipt.dispositions.campaign, "incomplete");
    assert.equal(receipt.dispositions.provider, "unavailable");
    rmSync(path.join(root, reference.locator));
    assert.throws(() => compileCampaignRelease(root, input, manifest, authority));
  });
});

test("recovery evidence is inventoried without Doctor and cannot become recorded resolution", () => {
  fixture(({ root, input, authority, manifest }) => {
    const initial = observeReleaseDoctorInventory(root, input, authority);
    const value = { schemaVersion: 1, kind: "lifecycle-recovery-outcome", intentHash: "a".repeat(64), status: "recovered", diagnostics: [] };
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    const locator = `.supervised-worker/lifecycle-evidence/${sha256(bytes)}.outcome.json`;
    mkdirSync(path.dirname(path.join(root, locator)), { recursive: true });
    writeFileSync(path.join(root, locator), bytes);
    const inventory = observeReleaseDoctorInventory(root, input, authority);
    assert.notEqual(inventory.doctorInventoryHash, initial.doctorInventoryHash);
    assert.equal(inventory.references.length, 1);
    manifest.doctorInventoryHash = inventory.doctorInventoryHash;
    const receipt = compileCampaignRelease(root, input, manifest, authority);
    assert.equal(receipt.doctor.status, "inapplicable");
    assert.equal(receipt.dispositions.doctor, "inapplicable");
    assert.equal(receipt.facts.find((fact) => fact.name === "recovery").references[0].sha256, sha256(bytes));
    rmSync(path.join(root, locator));
    assert.throws(() => compileCampaignRelease(root, input, manifest, authority), /INVENTORY_CHANGED/);
  });
});
}