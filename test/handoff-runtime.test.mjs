import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkpointSession, observeCampaignTransition, recordModelReceipt, sha256 } from "../src/core.mjs";
import {
  directoryIdentityMatches,
  inspectHandoffFile,
  issueReviewAttempt,
  resolveCommittedCandidate,
  validateHandoffValue,
  validateRepositoryPath,
  verifyBuildHandoff,
  verifyCommittedHandoffChain,
  verifyHandoffChain,
} from "../src/handoff.mjs";
import { acceptWorkflowRoles, DEFAULT_ROLES, resolveWorkflowRoles } from "../src/workflow.mjs";
import { createWorkerAuthorityFixture } from "./worker-authority-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.mjs");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, bytes);
  return sha256(bytes);
}

function writeModelReceipts(cwd, review, workflowHash, roles) {
  for (const role of ["builder", "reviewer"]) {
    const locator =
      `.supervised-worker/runtime/model-receipts/${sha256(review.itemId)}/${role}.json`;
    const receipt = {
      schemaVersion: 2,
      itemId: review.itemId,
      role,
      agentSelector: roles[role],
      model: review.modelResolution[role].model,
      family: review.modelResolution[role].family,
      workflowHash,
      reviewAttemptId: review.reviewAttemptId,
      buildReportHash: review.buildReportHash,
      stagedTreeHash: review.stagedTreeHash,
      observedBy: "supervised-worker:seangalliher-supervised-worker",
      observedAt: review.createdAt,
      host: "copilot-cli",
      sessionHash: "d".repeat(64),
      source: "host",
    };
    const receiptHash = writeJson(path.join(cwd, ...locator.split("/")), receipt);
    review.modelResolution[role].evidence = {
      kind: "host-model",
      locator,
      sha256: receiptHash,
    };
  }
}

function issueFixtureReview(fixture, workflowHash = null, roles = DEFAULT_ROLES) {
  const attempt = issueReviewAttempt(fixture.cwd, fixture.contractPath, fixture.buildPath);
  assert.equal(attempt.ok, true, attempt.errors.join("\n"));
  fixture.review.reviewAttemptId = attempt.reviewAttemptId;
  fixture.review.createdAt = attempt.issuedAt;
  fixture.review.contractHash = attempt.contractHash;
  fixture.review.buildReportHash = attempt.buildReportHash;
  fixture.review.stagedTreeHash = attempt.stagedTreeHash;
  writeModelReceipts(fixture.cwd, fixture.review, workflowHash, roles);
  writeJson(fixture.reviewPath, fixture.review);
  fixture.attempt = attempt;
  return attempt;
}

function modelPublicationFixture(fixture, assurance = "host-attested") {
  fixture.cwd = realpathSync(fixture.cwd);
  const input = { session_id: "model-publication-owner" };
  let options = {};
  let workflowHash = null;
  if (assurance === "local-scoped") {
    const workflow = readJson("examples/workflow.vscode-local.json");
    workflow.roles = { ...DEFAULT_ROLES };
    Object.assign(workflow.review, { agent: DEFAULT_ROLES.reviewer, requiredModel: "fixture-reviewer",
      requiredModelFamily: "fixture-provider", requireDifferentModelFamily: true });
    writeJson(path.join(fixture.cwd, ".github", "supervised-worker.json"), workflow);
    git(fixture.cwd, "add", "--", ".github/supervised-worker.json");
    git(fixture.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture baseline");
    writeFileSync(path.join(fixture.cwd, "src", "module.js"), "export const value = 2;\n");
    git(fixture.cwd, "add", "--", "src/module.js");
    workflowHash = resolveWorkflowRoles(fixture.cwd).workflowHash;
    assert.equal(acceptWorkflowRoles(fixture.cwd, workflowHash).ok, true);
    fixture.contract.workflowHash = workflowHash;
    fixture.build.workflowHash = workflowHash;
    fixture.build.contractHash = writeJson(fixture.contractPath, fixture.contract);
    fixture.build.testedTreeHash = git(fixture.cwd, "write-tree");
    writeJson(fixture.buildPath, fixture.build);
    const external = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sw-local-model-publication-")));
    const transcripts = path.join(external, "storage", "GitHub.copilot-chat", "transcripts");
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(path.join(external, "storage", "workspace.json"), "{}\n");
    input.transcript_path = path.join(transcripts, `${input.session_id}.jsonl`);
    writeFileSync(input.transcript_path, "");
    options = { baseDirectory: external };
  }
  const runtime = createWorkerAuthorityFixture(fixture.cwd, input, options);
  assert.equal(runtime.admit({ schemaVersion: 1, mode: "active", goal: "Model publication boundaries",
    items: [{ id: fixture.review.itemId, title: "Receipt item", status: "in_progress" }], completion: null }).status, "applied");
  const attempt = issueReviewAttempt(fixture.cwd, fixture.contractPath, fixture.buildPath);
  assert.equal(attempt.ok, true, attempt.errors.join("\n"));
  const receipt = { schemaVersion: 2, itemId: fixture.review.itemId, role: "builder", agentSelector: DEFAULT_ROLES.builder,
    model: "fixture-model", family: "fixture-family", workflowHash,
    reviewAttemptId: attempt.reviewAttemptId, buildReportHash: attempt.buildReportHash, stagedTreeHash: attempt.stagedTreeHash,
    observedBy: "supervised-worker:seangalliher-supervised-worker", observedAt: new Date().toISOString(),
    host: "vscode", sessionHash: sha256(input.session_id), source: "host" };
  return { input, runtime, receipt, attempt,
    request: { ...input, expected: observeCampaignTransition(fixture.cwd, input), receipt },
    target: path.join(fixture.cwd, ".supervised-worker", "runtime", "model-receipts", sha256(receipt.itemId), "builder.json") };
}

for (const mutation of ["role", "workflow", "attempt", "build", "tree", "session", "host", "observed-time", "expected", "extra", "null"]) {
  test(`model receipt publication rejects ${mutation} mismatch without changing prior evidence`, () => {
    withFixture((fixture) => {
      const context = modelPublicationFixture(fixture);
      const before = readFileSync(context.target);
      const request = structuredClone(context.request);
      if (mutation === "role") request.receipt.agentSelector = "other-builder";
      if (mutation === "workflow") request.receipt.workflowHash = "e".repeat(64);
      if (mutation === "attempt") request.receipt.reviewAttemptId = "11111111-1111-4111-8111-111111111111";
      if (mutation === "build") request.receipt.buildReportHash = "e".repeat(64);
      if (mutation === "tree") request.receipt.stagedTreeHash = "e".repeat(40);
      if (mutation === "session") request.receipt.sessionHash = "e".repeat(64);
      if (mutation === "host") request.receipt.host = "copilot-cli";
      if (mutation === "observed-time") request.receipt.observedAt = "2000-01-01T00:00:00Z";
      if (mutation === "expected") request.expected.planHash = "e".repeat(64);
      if (mutation === "extra") request.target = "arbitrary/path";
      assert.throws(() => recordModelReceipt(fixture.cwd, mutation === "null" ? null : request, context.runtime.authority()));
      assert.deepEqual(readFileSync(context.target), before);
    });
  });
}

test("model receipt publication refuses copied authority and a checkpointed owner", () => {
  withFixture((fixture) => {
    const context = modelPublicationFixture(fixture);
    const authority = context.runtime.authority();
    assert.throws(() => recordModelReceipt(fixture.cwd, context.request, { ...authority }), /verified/);
    const checkpoint = checkpointSession(fixture.cwd, { ...context.input,
      planHash: context.request.expected.planHash, attachmentHash: context.request.expected.attachmentHash }, authority);
    assert.equal(checkpoint.status, "checkpointed");
    const request = { ...context.request, expected: observeCampaignTransition(fixture.cwd, context.input) };
    assert.throws(() => recordModelReceipt(fixture.cwd, request, authority));
  });
});

test("model receipt publication honors accepted local-scoped authority and reviewer policy", () => {
  withFixture((fixture) => {
    const context = modelPublicationFixture(fixture, "local-scoped");
    const authority = context.runtime.authority();
    assert.equal(authority.assurance, "local-scoped");
    const builder = recordModelReceipt(fixture.cwd, context.request, authority);
    assert.equal(builder.ok, true);
    const reviewer = structuredClone(context.request);
    reviewer.receipt.role = "reviewer";
    reviewer.receipt.agentSelector = DEFAULT_ROLES.reviewer;
    assert.throws(() => recordModelReceipt(fixture.cwd, reviewer, authority));
    reviewer.receipt.model = "fixture-reviewer";
    reviewer.receipt.family = "fixture-provider";
    assert.equal(recordModelReceipt(fixture.cwd, reviewer, authority).ok, true);
    fs.appendFileSync(path.join(fixture.cwd, ".github", "supervised-worker.json"), "\n");
    assert.throws(() => recordModelReceipt(fixture.cwd, context.request, authority));
  });
});

test("model receipt publication rechecks plan ownership after preparing the write", () => {
  withFixture((fixture) => {
    const context = modelPublicationFixture(fixture);
    const authority = context.runtime.authority();
    const before = readFileSync(context.target);
    const original = fs.writeFileSync;
    let fired = false;
    try {
      fs.writeFileSync = (target, bytes, ...options) => {
        let value;
        try { value = JSON.parse(String(bytes)); } catch { value = null; }
        if (!fired && value?.sessionHash === context.receipt.sessionHash && value?.role === "builder") {
          fired = true;
          const planPath = path.join(fixture.cwd, ".supervised-worker", "plan.json");
          const plan = JSON.parse(readFileSync(planPath));
          original(planPath, JSON.stringify({ ...plan, goal: "changed during publication" }));
        }
        return original(target, bytes, ...options);
      };
      syncBuiltinESMExports();
      assert.throws(() => recordModelReceipt(fixture.cwd, context.request, authority));
      assert.equal(fired, true, "The actual model-receipt write must reach the injected drift");
      assert.deepEqual(readFileSync(context.target), before);
    } finally {
      fs.writeFileSync = original;
      syncBuiltinESMExports();
    }
  });
});

test("model receipt publication preserves previous bytes and refuses same-attempt conflicts", () => {
  withFixture((fixture) => {
    const context = modelPublicationFixture(fixture);
    const prior = readFileSync(context.target);
    const publication = recordModelReceipt(fixture.cwd, context.request, context.runtime.authority());
    assert.equal(publication.ok, true);
    assert.deepEqual(readFileSync(path.join(path.dirname(context.target), "history", `${sha256(prior)}.json`)), prior);
    const current = readFileSync(context.target);
    const changed = structuredClone(context.request);
    changed.receipt.model = "changed-model";
    assert.throws(() => recordModelReceipt(fixture.cwd, changed, context.runtime.authority()));
    assert.deepEqual(readFileSync(context.target), current);
  });
});

test("model receipt publication creates absent canonical evidence and leaves identical writes untouched", () => {
  withFixture((fixture) => {
    const context = modelPublicationFixture(fixture);
    rmSync(path.dirname(context.target), { recursive: true });
    assert.equal(existsSync(context.target), false);
    const first = recordModelReceipt(fixture.cwd, context.request, context.runtime.authority());
    const before = lstatSync(context.target, { bigint: true });
    const second = recordModelReceipt(fixture.cwd, context.request, context.runtime.authority());
    assert.equal(second.sha256, first.sha256);
    assert.equal(lstatSync(context.target, { bigint: true }).mtimeNs, before.mtimeNs);
    assert.equal(sha256(readFileSync(context.target)), first.sha256);
  });
});

test("model receipt publication refuses a changed staged candidate and hard-linked evidence", () => {
  withFixture((fixture) => {
    const context = modelPublicationFixture(fixture);
    const before = readFileSync(context.target);
    writeFileSync(path.join(fixture.cwd, "src", "module.js"), "export const value = 2;\n");
    git(fixture.cwd, "add", "--", "src/module.js");
    assert.throws(() => recordModelReceipt(fixture.cwd, context.request, context.runtime.authority()));
    assert.deepEqual(readFileSync(context.target), before);
  });
  withFixture((fixture) => {
    const context = modelPublicationFixture(fixture);
    const before = readFileSync(context.target);
    const linked = path.join(fixture.cwd, ".supervised-worker", "receipt-alias.json");
    linkSync(context.target, linked);
    assert.throws(() => recordModelReceipt(fixture.cwd, context.request, context.runtime.authority()));
    assert.deepEqual(readFileSync(linked), before);
  });
});

test("installed owner publishes model receipts that the real handoff verifier accepts", () => {
  withFixture((fixture) => {
    const input = { session_id: "model-receipt-owner" };
    const runtime = createWorkerAuthorityFixture(fixture.cwd, input);
    assert.equal(runtime.admit({ schemaVersion: 1, mode: "active", goal: "Verify receipt publication",
      items: [{ id: fixture.review.itemId, title: "Receipt item", status: "in_progress" }], completion: null }).status, "applied");
    const environment = { ...process.env, SUPERVISED_WORKER_HOST_AUTHORITY: runtime.inventoryPath };
    const installedCli = path.join(runtime.installRoot, "src", "cli.mjs");
    const attempt = issueReviewAttempt(fixture.cwd, fixture.contractPath, fixture.buildPath);
    assert.equal(attempt.ok, true, attempt.errors.join("\n"));
    Object.assign(fixture.review, { reviewAttemptId: attempt.reviewAttemptId, contractHash: attempt.contractHash,
      buildReportHash: attempt.buildReportHash, stagedTreeHash: attempt.stagedTreeHash });
    for (const role of ["builder", "reviewer"]) {
      const receipt = { schemaVersion: 2, itemId: fixture.review.itemId, role,
        agentSelector: DEFAULT_ROLES[role], model: fixture.review.modelResolution[role].model,
        family: fixture.review.modelResolution[role].family, workflowHash: null,
        reviewAttemptId: attempt.reviewAttemptId, buildReportHash: attempt.buildReportHash,
        stagedTreeHash: attempt.stagedTreeHash, observedBy: "supervised-worker:seangalliher-supervised-worker",
        observedAt: new Date().toISOString(), host: "vscode", sessionHash: sha256(input.session_id), source: "host" };
      const request = { ...input, expected: observeCampaignTransition(fixture.cwd, input), receipt };
      const result = spawnSync(process.execPath, [installedCli, "handoff", "record-model"], {
        cwd: fixture.cwd, env: environment, input: JSON.stringify(request), encoding: "utf8", timeout: 30000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout || result.stderr);
      const publication = JSON.parse(result.stdout);
      assert.equal(publication.ok, true);
      assert.equal(publication.provenance, "worker-recorded");
      const publishedPath = path.join(fixture.cwd, publication.locator);
      assert.equal(sha256(readFileSync(publishedPath)), publication.sha256);
      const repeated = spawnSync(process.execPath, [installedCli, "handoff", "record-model"], {
        cwd: fixture.cwd, env: environment, input: JSON.stringify(request), encoding: "utf8", timeout: 30000,
      });
      assert.equal(repeated.status, 0, repeated.stdout || repeated.stderr);
      assert.equal(JSON.parse(repeated.stdout).sha256, publication.sha256);
      const forbidden = spawnSync(process.execPath, [installedCli, "hook", "PreToolUse"], {
        cwd: fixture.cwd, env: environment, encoding: "utf8", timeout: 30000,
        input: JSON.stringify({ ...input, cwd: fixture.cwd, tool_name: "create_file", tool_use_id: `direct-${role}`,
          tool_input: { filePath: publishedPath, content: JSON.stringify(receipt) } }),
      });
      assert.equal(forbidden.status, 0, forbidden.stdout || forbidden.stderr);
      assert.equal(JSON.parse(forbidden.stdout).permissionDecision, "deny");
      fixture.review.modelResolution[role].evidence = { kind: "host-model", locator: publication.locator, sha256: publication.sha256 };
    }
    fixture.review.createdAt = new Date().toISOString();
    writeJson(fixture.reviewPath, fixture.review);
    const verified = verifyHandoffChain(fixture.cwd, fixture.contractPath, fixture.buildPath, fixture.reviewPath);
    assert.equal(verified.ok, true, verified.errors.join("\n"));
  });
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function chainFixture(cwd = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-handoff-"))) {
  git(cwd, "init", "--quiet");
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "module.js"), "export const value = 1;\n");
  git(cwd, "add", "--", "src/module.js");

  const itemId = "issue-42";
  const directory = path.join(cwd, ".supervised-worker", "handoffs", sha256(itemId));
  const contractPath = path.join(directory, "build-contract.json");
  const buildPath = path.join(directory, "build-report.json");
  const reviewPath = path.join(directory, "review-report.json");

  const contract = readJson("examples/handoff.build-contract.json");
  contract.itemId = itemId;
  contract.targetFiles = ["src/module.js"];
  contract.consumers = ["module importer"];
  const contractHash = writeJson(contractPath, contract);

  const build = readJson("examples/handoff.build-report.json");
  build.itemId = itemId;
  build.contractHash = contractHash;
  build.testedTreeHash = git(cwd, "write-tree");
  build.changedFiles = ["src/module.js"];
  build.checks = [...contract.focusedChecks, contract.broadGate].map((command) => ({
    command,
    outcome: "passed",
    evidence: { kind: "test-output", locator: `local:${command}` },
  }));
  const buildReportHash = writeJson(buildPath, build);

  const review = readJson("examples/handoff.review-report.json");
  review.itemId = itemId;
  review.contractHash = contractHash;
  review.buildReportHash = buildReportHash;
  review.stagedTreeHash = git(cwd, "write-tree");
  review.consumers = ["module importer"];

  const fixture = { cwd, contractPath, buildPath, reviewPath, contract, build, review };
  issueFixtureReview(fixture);
  return fixture;
}

function withFixture(run) {
  const fixture = chainFixture();
  try {
    return run(fixture);
  } finally {
    rmSync(fixture.cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("runtime validates and hash-binds a complete staged handoff chain", () => {
  withFixture(({ cwd, contractPath, buildPath, reviewPath }) => {
    const inspected = inspectHandoffFile(cwd, contractPath);
    assert.equal(inspected.ok, true, inspected.errors.join("\n"));
    assert.match(inspected.sha256, /^[0-9a-f]{64}$/);

    const preReview = verifyBuildHandoff(cwd, contractPath, buildPath);
    assert.equal(preReview.ok, true, preReview.errors.join("\n"));
    assert.equal(preReview.stagedTreeHash, git(cwd, "write-tree"));

    const result = verifyHandoffChain(cwd, contractPath, buildPath, reviewPath);
    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.equal(result.verdict, "clean");
    assert.equal(result.stagedTreeHash, git(cwd, "write-tree"));
  });
});

test("committed pre-review validates the tested HEAD without restaging its changes", () => {
  withFixture((fixture) => {
    git(fixture.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false",
      "commit", "--quiet", "--allow-empty", "--only", "-m", "baseline");
    const baseCommit = git(fixture.cwd, "rev-parse", "HEAD");
    assert.equal(verifyBuildHandoff(fixture.cwd, fixture.contractPath, fixture.buildPath).ok, true);
    git(fixture.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false",
      "commit", "--quiet", "-m", "tested candidate");
    const commit = git(fixture.cwd, "rev-parse", "HEAD");
    assert.equal(git(fixture.cwd, "rev-parse", `${commit}^1`), baseCommit);
    const tree = git(fixture.cwd, "write-tree");
    const reportBytes = readFileSync(fixture.buildPath);
    assert.equal(git(fixture.cwd, "diff", "--cached", "--name-only"), "", "The regression requires an empty post-commit index diff");
    assert.equal(verifyBuildHandoff(fixture.cwd, fixture.contractPath, fixture.buildPath).ok, false, "Staged mode must not silently switch candidates");
    const result = spawnSync(process.execPath, [cli, "handoff", "pre-review", fixture.contractPath, fixture.buildPath, "--committed", commit],
      { cwd: fixture.cwd, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const verified = JSON.parse(result.stdout);
    assert.equal(verified.ok, true, verified.errors.join("\n"));
    assert.equal(verified.stagedTreeHash, tree);
    assert.equal(git(fixture.cwd, "rev-parse", "HEAD"), commit);
    assert.equal(git(fixture.cwd, "diff", "--cached", "--name-only"), "");
    assert.deepEqual(readFileSync(fixture.buildPath), reportBytes);
  });
});

function commitFixtureCandidate(fixture) {
  git(fixture.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false",
    "commit", "--quiet", "--allow-empty", "--only", "-m", "baseline");
  git(fixture.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false",
    "commit", "--quiet", "-m", "tested candidate");
  return resolveCommittedCandidate(fixture.cwd, git(fixture.cwd, "rev-parse", "HEAD"));
}

for (const mutation of ["abbreviated", "commit", "tree", "parent", "extra-key", "index", "unstaged", "untracked", "build", "contract"]) {
  test(`committed review rejects ${mutation} drift without issuing a new attempt`, () => {
    withFixture((fixture) => {
      const candidate = commitFixtureCandidate(fixture);
      const baseline = verifyBuildHandoff(fixture.cwd, fixture.contractPath, fixture.buildPath, null, candidate);
      assert.equal(baseline.ok, true, baseline.errors.join("\n"));
      const attemptPath = path.join(fixture.cwd, fixture.attempt.locator);
      const previous = readFileSync(attemptPath);
      if (mutation === "abbreviated") candidate.commit = candidate.commit.slice(0, 12);
      if (mutation === "commit") candidate.commit = candidate.baseCommit;
      if (mutation === "tree") candidate.tree = "f".repeat(40);
      if (mutation === "parent") candidate.baseCommit = candidate.commit;
      if (mutation === "extra-key") candidate.ref = "refs/heads/main";
      if (mutation === "index" || mutation === "unstaged") {
        writeFileSync(path.join(fixture.cwd, "src", "module.js"), "export const value = 99;\n");
        if (mutation === "index") {
          git(fixture.cwd, "add", "src/module.js");
          fixture.build.testedTreeHash = git(fixture.cwd, "write-tree");
          assert.notEqual(fixture.build.testedTreeHash, candidate.tree);
          writeJson(fixture.buildPath, fixture.build);
        }
      }
      if (mutation === "untracked") writeFileSync(path.join(fixture.cwd, "unexpected.txt"), "untracked\n");
      if (mutation === "build") {
        fixture.build.changedFiles = [];
        writeJson(fixture.buildPath, fixture.build);
      }
      if (mutation === "contract") fs.appendFileSync(fixture.contractPath, "\n");
      const rejected = issueReviewAttempt(fixture.cwd, fixture.contractPath, fixture.buildPath, null, candidate);
      assert.equal(rejected.ok, false, `The ${mutation} mutation must invalidate the candidate`);
      if (mutation === "index") assert.ok(rejected.errors.includes("Git index does not match the committed candidate tree"));
      assert.deepEqual(readFileSync(attemptPath), previous);
    });
  });
}

test("committed review rejects root commits and malformed CLI candidate arguments", () => {
  withFixture((fixture) => {
    git(fixture.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false",
      "commit", "--quiet", "-m", "root candidate");
    const commit = git(fixture.cwd, "rev-parse", "HEAD");
    for (const tail of [["--committed", commit], ["--committed", commit.slice(0, 12)], ["--committed"], ["--committed", commit, "extra"]]) {
      const result = spawnSync(process.execPath, [cli, "handoff", "pre-review", fixture.contractPath, fixture.buildPath, ...tail],
        { cwd: fixture.cwd, encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).ok, false);
    }
    assert.equal(git(fixture.cwd, "rev-parse", "HEAD"), commit);
  });
});

test("committed model publication rejects a rewritten same-tree HEAD and preserves prior receipts", () => {
  withFixture((fixture) => {
    const context = modelPublicationFixture(fixture);
    const candidate = commitFixtureCandidate(fixture);
    const attempt = issueReviewAttempt(fixture.cwd, fixture.contractPath, fixture.buildPath, null, candidate);
    assert.equal(attempt.ok, true, attempt.errors.join("\n"));
    context.request.receipt.reviewAttemptId = attempt.reviewAttemptId;
    context.request.receipt.observedAt = new Date().toISOString();
    const published = recordModelReceipt(fixture.cwd, context.request, context.runtime.authority());
    assert.equal(published.ok, true);
    const previous = readFileSync(context.target);
    git(fixture.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false",
      "commit", "--quiet", "--amend", "-m", "rewritten candidate");
    assert.notEqual(git(fixture.cwd, "rev-parse", "HEAD"), candidate.commit);
    assert.equal(git(fixture.cwd, "rev-parse", "HEAD^{tree}"), candidate.tree, "The stale attempt must face an identical tree");
    assert.throws(() => recordModelReceipt(fixture.cwd, context.request, context.runtime.authority()), (error) => {
      assert.match(error.message, /record-model could not confirm its local lifecycle state/);
      assert.match(error.cause?.message ?? "", /verified current build candidate/);
      return true;
    });
    assert.deepEqual(readFileSync(context.target), previous);
  });
});

for (const mutation of ["deleted", "null", "extra-key", "missing-tree", "abbreviated", "repair-context", "wrong-parent", "missing-mode", "wrong-mode", "legacy-version", "legacy-downgrade"]) {
  test(`committed model publication rejects ${mutation} attempt context`, () => {
    withFixture((fixture) => {
      const context = modelPublicationFixture(fixture);
      const candidate = commitFixtureCandidate(fixture);
      const attempt = issueReviewAttempt(fixture.cwd, fixture.contractPath, fixture.buildPath, null, candidate);
      assert.equal(attempt.ok, true, attempt.errors.join("\n"));
      context.request.receipt.reviewAttemptId = attempt.reviewAttemptId;
      context.request.receipt.observedAt = new Date().toISOString();
      if (!["deleted", "legacy-downgrade"].includes(mutation)) assert.equal(recordModelReceipt(fixture.cwd, context.request, context.runtime.authority()).ok, true);
      const previous = readFileSync(context.target);
      const attemptPath = path.join(fixture.cwd, attempt.locator);
      const changed = JSON.parse(readFileSync(attemptPath));
      if (["deleted", "legacy-downgrade"].includes(mutation)) {
        delete changed.committedCandidate;
        if (mutation === "legacy-downgrade") {
          delete changed.mode;
          changed.schemaVersion = 1;
        }
        assert.equal(Object.hasOwn(changed, "committedCandidate"), false);
        git(fixture.cwd, "reset", "--soft", candidate.baseCommit);
        assert.notEqual(git(fixture.cwd, "rev-parse", "HEAD"), candidate.commit);
        assert.equal(git(fixture.cwd, "write-tree"), candidate.tree);
        assert.equal(verifyBuildHandoff(fixture.cwd, fixture.contractPath, fixture.buildPath).ok, true,
          "The altered fixture must pass staged validation so only the committed-attempt guard discriminates");
      }
      if (mutation === "null") changed.committedCandidate = null;
      if (mutation === "extra-key") changed.committedCandidate.ref = "refs/heads/main";
      if (mutation === "missing-tree") delete changed.committedCandidate.tree;
      if (mutation === "abbreviated") changed.committedCandidate.commit = candidate.commit.slice(0, 12);
      if (mutation === "repair-context") changed.sourceBinding = "a".repeat(64);
      if (mutation === "wrong-parent") changed.committedCandidate.baseCommit = candidate.commit;
      if (mutation === "missing-mode") delete changed.mode;
      if (mutation === "wrong-mode") changed.mode = "staged";
      if (mutation === "legacy-version") changed.schemaVersion = 1;
      writeJson(attemptPath, changed);
      assert.throws(() => recordModelReceipt(fixture.cwd, context.request, context.runtime.authority()),
        (error) => {
          assert.match(error.message, /record-model could not confirm its local lifecycle state/);
          assert.match(error.cause?.message ?? "",
            mutation === "wrong-parent" ? /verified current build candidate/ :
              mutation === "repair-context" ? /sourceBinding does not match its mode/ :
                mutation === "missing-mode" ? /review attempt mode is invalid/ :
                  mutation === "legacy-version" ? /unknown property/ :
                    mutation === "legacy-downgrade" ? /fresh version 2 review attempt/ : /committedCandidate is invalid/);
          return true;
        });
      assert.deepEqual(readFileSync(context.target), previous);
    });
  });
}

test("committed review refuses a simultaneous repair source context", () => {
  withFixture((fixture) => {
    const candidate = commitFixtureCandidate(fixture);
    assert.equal(verifyBuildHandoff(fixture.cwd, fixture.contractPath, fixture.buildPath, null, candidate).ok, true);
    const result = verifyBuildHandoff(fixture.cwd, fixture.contractPath, fixture.buildPath,
      { sourceRoot: fixture.cwd, baseCommit: candidate.baseCommit }, candidate);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("Git staged state could not be verified: source-context"));
  });
});

test("explicit committed verification rejects a staged attempt without breaking historical compilation", () => {
  withFixture((fixture) => {
    const candidate = commitFixtureCandidate(fixture);
    assert.equal(verifyBuildHandoff(fixture.cwd, fixture.contractPath, fixture.buildPath, null, candidate).ok, true);
    const result = verifyHandoffChain(fixture.cwd, fixture.contractPath, fixture.buildPath, fixture.reviewPath, null, candidate);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("explicit committed verification requires a committed-mode review attempt"));
    const historical = verifyCommittedHandoffChain(fixture.cwd, fixture.contractPath, fixture.buildPath, fixture.reviewPath, candidate);
    assert.equal(historical.ok, true, historical.errors.join("\n"));
  });
});

test("legacy attempts require reissuance before new model receipt publication", () => {
  withFixture((fixture) => {
    const context = modelPublicationFixture(fixture);
    const attemptPath = path.join(fixture.cwd, context.attempt.locator);
    const legacy = JSON.parse(readFileSync(attemptPath));
    legacy.schemaVersion = 1;
    delete legacy.mode;
    writeJson(attemptPath, legacy);
    const previous = readFileSync(context.target);
    assert.throws(() => recordModelReceipt(fixture.cwd, context.request, context.runtime.authority()), (error) => {
      assert.match(error.cause?.message ?? "", /fresh version 2 review attempt; reissue review/);
      return true;
    });
    assert.deepEqual(readFileSync(context.target), previous);
    const attempt = issueReviewAttempt(fixture.cwd, fixture.contractPath, fixture.buildPath);
    assert.equal(attempt.ok, true, attempt.errors.join("\n"));
    assert.equal(attempt.schemaVersion, 2);
    assert.notEqual(attempt.reviewAttemptId, legacy.reviewAttemptId);
    context.request.receipt.reviewAttemptId = attempt.reviewAttemptId;
    context.request.receipt.observedAt = new Date().toISOString();
    assert.equal(recordModelReceipt(fixture.cwd, context.request, context.runtime.authority()).ok, true);
  });
});

test("repair handoffs keep artifacts in their owner and bind a separate source worktree", (context) => {
  withFixture((fixture) => {
    const sourceRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "repair-handoff-source-")));
    try {
      git(sourceRoot, "init", "--quiet");
      git(sourceRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "baseline");
      const baseCommit = git(sourceRoot, "rev-parse", "HEAD");
      mkdirSync(path.join(sourceRoot, "src"));
      writeFileSync(path.join(sourceRoot, "src", "module.js"), "export const value = 1;\n");
      git(sourceRoot, "add", "src/module.js");
      const source = { sourceRoot, baseCommit };
      assert.equal(git(sourceRoot, "write-tree"), fixture.build.testedTreeHash, "fixture must carry the same tree in a distinct repository");
      const baseline = verifyBuildHandoff(fixture.cwd, fixture.contractPath, fixture.buildPath, source);
      assert.equal(baseline.ok, true, baseline.errors.join("\n"));
      if (process.platform === "win32") {
        const originalRealpath = fs.realpathSync;
        const gitRoot = git(sourceRoot, "rev-parse", "--show-toplevel");
        let aliasReads = 0;
        context.mock.method(fs, "realpathSync", (value, options) => {
          const resolved = originalRealpath(value, options);
          if (value === gitRoot) {
            aliasReads += 1;
            return resolved.toUpperCase();
          }
          return resolved;
        });
        syncBuiltinESMExports();
        try {
          const aliased = verifyBuildHandoff(fixture.cwd, fixture.contractPath, fixture.buildPath, source);
          assert.ok(aliasReads > 0, "Git's actual toplevel path must cross the alias comparison");
          assert.equal(aliased.ok, true, aliased.errors.join("\n"));
        } finally {
          context.mock.restoreAll();
          syncBuiltinESMExports();
        }
      }
      assert.equal(verifyHandoffChain(fixture.cwd, fixture.contractPath, fixture.buildPath, fixture.reviewPath, source).ok, false, "an old same-tree attempt has no source binding");
      const attempt = issueReviewAttempt(fixture.cwd, fixture.contractPath, fixture.buildPath, source);
      assert.equal(attempt.ok, true, attempt.errors.join("\n"));
      Object.assign(fixture.review, { reviewAttemptId: attempt.reviewAttemptId, createdAt: attempt.issuedAt });
      writeModelReceipts(fixture.cwd, fixture.review, null, DEFAULT_ROLES);
      writeJson(fixture.reviewPath, fixture.review);
      assert.equal(verifyHandoffChain(fixture.cwd, fixture.contractPath, fixture.buildPath, fixture.reviewPath, source).ok, true);
      assert.equal(existsSync(path.join(sourceRoot, ".supervised-worker")), false);
      assert.equal(verifyHandoffChain(fixture.cwd, fixture.contractPath, fixture.buildPath, fixture.reviewPath).ok, false, "source-bound review cannot be reused without its context");
      writeFileSync(path.join(sourceRoot, "src", "module.js"), "changed after review\n");
      assert.equal(verifyHandoffChain(fixture.cwd, fixture.contractPath, fixture.buildPath, fixture.reviewPath, source).ok, false);
      const overlapping = verifyBuildHandoff(fixture.cwd, fixture.contractPath, fixture.buildPath, { sourceRoot: fixture.cwd, baseCommit });
      assert.equal(overlapping.ok, false);
      assert.ok(overlapping.errors.includes("Git staged state could not be verified: source-root"));
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

test("handoff verification never executes a workspace-planted Git binary", {
  skip: process.platform !== "win32",
}, () => {
  withFixture((fixture) => {
    const external = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-git-probe-"));
    try {
      const markerPath = path.join(external, "workspace-git-ran.txt");
      const probePath = path.join(external, "probe.mjs");
      writeFileSync(
        probePath,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "ran");\n`,
      );
      copyFileSync(process.execPath, path.join(fixture.cwd, "git.exe"));
      const excludePath = path.join(fixture.cwd, ".git", "info", "exclude");
      writeFileSync(excludePath, `${readFileSync(excludePath, "utf8")}\n/git.exe\n`);

      const premise = spawnSync("git", [probePath], {
        cwd: fixture.cwd,
        encoding: "utf8",
      });
      assert.equal(premise.status, 0, premise.stderr);
      assert.equal(existsSync(markerPath), true, "planted git.exe must win bare lookup");
      rmSync(markerPath);

      const result = verifyBuildHandoff(
        fixture.cwd,
        fixture.contractPath,
        fixture.buildPath,
      );
      assert.equal(result.ok, true, result.errors.join("\n"));
      assert.equal(existsSync(markerPath), false);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});

test("final verification always reopens supplied model receipts", () => {
  withFixture(({ cwd, contractPath, buildPath, reviewPath, review }) => {
    for (const role of ["builder", "reviewer"]) {
      rmSync(path.join(cwd, ...review.modelResolution[role].evidence.locator.split("/")));
    }
    const result = verifyHandoffChain(cwd, contractPath, buildPath, reviewPath);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /model receipt/);
  });
});

test("final verification requires the current review-attempt record", () => {
  withFixture((fixture) => {
    rmSync(path.join(fixture.cwd, ...fixture.attempt.locator.split("/")));
    const result = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /review attempt path is unavailable/);
  });
});

test("failed review issuance does not rotate the current attempt", () => {
  withFixture((fixture) => {
    const attemptPath = path.join(fixture.cwd, ...fixture.attempt.locator.split("/"));
    const originalAttempt = readFileSync(attemptPath, "utf8");
    fixture.build.changedFiles = ["src/outside.js"];
    writeJson(fixture.buildPath, fixture.build);

    const result = issueReviewAttempt(fixture.cwd, fixture.contractPath, fixture.buildPath);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /outside targetFiles/);
    assert.equal(readFileSync(attemptPath, "utf8"), originalAttempt);
  });
});

test("final verification rejects a previously valid bundle after attempt rotation", () => {
  withFixture((fixture) => {
    const previousAttemptId = fixture.review.reviewAttemptId;
    const current = issueReviewAttempt(fixture.cwd, fixture.contractPath, fixture.buildPath);
    assert.equal(current.ok, true, current.errors.join("\n"));
    assert.notEqual(current.reviewAttemptId, previousAttemptId);

    const rejected = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join("\n"), /does not match the current review attempt/);

    fixture.review.reviewAttemptId = current.reviewAttemptId;
    fixture.review.createdAt = current.issuedAt;
    writeModelReceipts(fixture.cwd, fixture.review, null, DEFAULT_ROLES);
    writeJson(fixture.reviewPath, fixture.review);
    const accepted = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(accepted.ok, true, accepted.errors.join("\n"));
  });
});

test("final verification rejects a readable v1 review after attempt rotation", () => {
  withFixture((fixture) => {
    const rotated = issueReviewAttempt(fixture.cwd, fixture.contractPath, fixture.buildPath);
    assert.equal(rotated.ok, true, rotated.errors.join("\n"));
    const legacyReview = structuredClone(fixture.review);
    legacyReview.schemaVersion = 1;
    delete legacyReview.workflowHash;
    delete legacyReview.reviewAttemptId;
    delete legacyReview.modelResolution;
    legacyReview.modelSeparation = "unknown";
    writeJson(fixture.reviewPath, legacyReview);
    rmSync(
      path.join(fixture.cwd, ".supervised-worker", "runtime", "model-receipts"),
      { recursive: true, force: true },
    );

    const inspected = spawnSync(
      process.execPath,
      [cli, "handoff", "validate", fixture.reviewPath],
      { cwd: fixture.cwd, encoding: "utf8" },
    );
    assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
    assert.equal(JSON.parse(inspected.stdout).ok, true);

    const rejected = spawnSync(
      process.execPath,
      [
        cli,
        "handoff",
        "verify",
        fixture.contractPath,
        fixture.buildPath,
        fixture.reviewPath,
      ],
      { cwd: fixture.cwd, encoding: "utf8" },
    );
    assert.equal(rejected.status, 1, rejected.stderr || rejected.stdout);
    assert.match(
      JSON.parse(rejected.stdout).errors.join("\n"),
      /final verification requires review-report schemaVersion 2/,
    );
  });
});

test("final verification rejects model evidence observed after the review report", () => {
  withFixture((fixture) => {
    const receiptPath = path.join(
      fixture.cwd,
      ...fixture.review.modelResolution.builder.evidence.locator.split("/"),
    );
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.observedAt = new Date(Date.parse(fixture.review.createdAt) + 60_000).toISOString();
    fixture.review.modelResolution.builder.evidence.sha256 = writeJson(receiptPath, receipt);
    writeJson(fixture.reviewPath, fixture.review);

    const result = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /model receipt observedAt is after the review report/);
  });
});

test("final verification rejects an internally consistent future-dated bundle", () => {
  withFixture((fixture) => {
    const attemptPath = path.join(fixture.cwd, ...fixture.attempt.locator.split("/"));
    const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
    attempt.issuedAt = "2099-01-01T00:10:00Z";
    writeJson(attemptPath, attempt);
    fixture.review.createdAt = "2099-01-01T00:30:00Z";
    writeModelReceipts(fixture.cwd, fixture.review, null, DEFAULT_ROLES);
    writeJson(fixture.reviewPath, fixture.review);

    const result = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /issuedAt is too far in the future/);
    assert.match(result.errors.join("\n"), /createdAt is too far in the future/);
    assert.match(result.errors.join("\n"), /observedAt is too far in the future/);
  });
});

test("final verification rejects an expired review attempt", () => {
  withFixture((fixture) => {
    const attemptPath = path.join(fixture.cwd, ...fixture.attempt.locator.split("/"));
    const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
    attempt.issuedAt = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString();
    writeJson(attemptPath, attempt);

    const result = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /review attempt has expired/);
  });
});

test("directory identity distinguishes aliases, distinct roots, and zero-inode filesystems", () => {
  const stats = (dev, ino, directory = true) => ({
    dev: BigInt(dev),
    ino: BigInt(ino),
    isDirectory: () => directory,
  });
  assert.equal(directoryIdentityMatches("C:\\Root", "C:\\Root", stats(1, 0), stats(2, 0)), true);
  assert.equal(directoryIdentityMatches("C:\\Root", "c:\\root", stats(1, 42), stats(1, 42)), true);
  assert.equal(directoryIdentityMatches("C:\\Root", "c:\\root", stats(1, 42), stats(1, 43)), false);
  assert.equal(directoryIdentityMatches("C:\\Root", "c:\\root", stats(1, 0), stats(1, 0)), false);
  assert.equal(directoryIdentityMatches("C:\\Root", "c:\\root", stats(1, 42, false), stats(1, 42)), false);
});

test("runtime rejects cross-item reports at the hashed directory boundary", () => {
  withFixture((fixture) => {
    fixture.review.itemId = "other-item";
    writeJson(fixture.reviewPath, fixture.review);
    const result = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /directory does not match/);
  });
});

test("runtime rejects a stale contract hash", () => {
  withFixture((fixture) => {
    fixture.review.contractHash = "d".repeat(64);
    writeJson(fixture.reviewPath, fixture.review);
    const result = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /contractHash does not match/);
  });
});

test("runtime rejects a stale build-report hash", () => {
  withFixture((fixture) => {
    fixture.review.buildReportHash = "d".repeat(64);
    writeJson(fixture.reviewPath, fixture.review);
    const result = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /buildReportHash does not match/);
  });
});

test("runtime requires every contract gate against the current staged tree", () => {
  withFixture((fixture) => {
    fixture.contract.focusedChecks = ["node --test focused.test.mjs"];
    fixture.contract.broadGate = "npm test";
    const contractHash = writeJson(fixture.contractPath, fixture.contract);
    fixture.build.contractHash = contractHash;
    fixture.build.testedTreeHash = "d".repeat(40);
    fixture.build.checks = [
      {
        command: "echo irrelevant",
        outcome: "passed",
        evidence: { kind: "test-output", locator: "local:irrelevant" },
      },
    ];
    const buildHash = writeJson(fixture.buildPath, fixture.build);
    fixture.review.contractHash = contractHash;
    fixture.review.buildReportHash = buildHash;
    writeJson(fixture.reviewPath, fixture.review);

    const result = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /required contract check did not pass: node --test/);
    assert.match(result.errors.join("\n"), /required contract check did not pass: npm test/);
    assert.match(result.errors.join("\n"), /testedTreeHash does not match/);
  });
});

test("runtime rejects changed files outside the approved footprint", () => {
  withFixture((fixture) => {
    fixture.build.changedFiles = ["src/outside.js"];
    const contractHash = sha256(readFileSync(fixture.contractPath));
    fixture.build.contractHash = contractHash;
    const buildHash = writeJson(fixture.buildPath, fixture.build);
    fixture.review.contractHash = contractHash;
    fixture.review.buildReportHash = buildHash;
    writeJson(fixture.reviewPath, fixture.review);
    const result = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /outside targetFiles/);
  });
});

test("runtime rejects a review of a different staged tree", () => {
  withFixture((fixture) => {
    fixture.review.stagedTreeHash = "e".repeat(40);
    writeJson(fixture.reviewPath, fixture.review);
    const result = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /does not match the current Git index/);
  });
});

test("runtime rejects consumer drift and unapproved build deviations", () => {
  withFixture((fixture) => {
    fixture.build.deviations = ["Changed an additional behavior."];
    const buildHash = writeJson(fixture.buildPath, fixture.build);
    fixture.review.buildReportHash = buildHash;
    fixture.review.consumers = ["different consumer"];
    writeJson(fixture.reviewPath, fixture.review);
    const result = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /unapproved deviations/);
    assert.match(result.errors.join("\n"), /consumers do not match/);
  });
});

test("final verification rejects a valid changes-required verdict", () => {
  withFixture((fixture) => {
    fixture.review.verdict = "changes-required";
    fixture.review.findings.push({
      severity: "high",
      summary: "The consumer rejects the generated value.",
      consumer: "module importer",
      evidence: [{ kind: "probe", locator: "local:consumer-probe" }],
      blocksCommit: true,
    });
    writeJson(fixture.reviewPath, fixture.review);
    const result = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(result.ok, false);
    assert.equal(result.verdict, "changes-required");
    assert.match(result.errors.join("\n"), /verdict requires changes/);
  });
});

test("runtime rejects staged paths omitted from the build report", () => {
  withFixture((fixture) => {
    writeFileSync(path.join(fixture.cwd, "extra.js"), "export const extra = true;\n");
    git(fixture.cwd, "add", "--", "extra.js");
    fixture.review.stagedTreeHash = git(fixture.cwd, "write-tree");
    writeJson(fixture.reviewPath, fixture.review);
    const result = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /staged paths do not exactly match/);
  });
});

test("runtime rejects hidden unstaged and untracked edits", () => {
  withFixture((fixture) => {
    writeFileSync(path.join(fixture.cwd, "src", "module.js"), "export const value = 2;\n");
    writeFileSync(path.join(fixture.cwd, "unreported.js"), "export const hidden = true;\n");
    const result = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /unstaged tracked changes/);
    assert.match(result.errors.join("\n"), /untracked files outside/);
  });
});

test("runtime rejects undeclared approaches and duplicate option identities", () => {
  const contract = readJson("examples/handoff.build-contract.json");
  contract.selectedApproach = "not-declared";
  contract.options.push({ ...contract.options[0] });
  const errors = validateHandoffValue(contract, root);
  assert.match(errors.join("\n"), /selectedApproach must identify/);
  assert.match(errors.join("\n"), /id duplicates/);
  assert.match(errors.join("\n"), /rank duplicates/);
});

test("runtime rejects impossible calendar timestamps", () => {
  const contract = readJson("examples/handoff.build-contract.json");
  contract.createdAt = "2026-02-30T12:00:00Z";
  assert.match(validateHandoffValue(contract, root).join("\n"), /createdAt/);
});

test("repository paths reject protected and escaping links", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-path-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-outside-"));
  try {
    const link = path.join(cwd, "linked");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    assert.match(validateRepositoryPath(cwd, ".git/config").join("\n"), /protected/);
    assert.match(
      validateRepositoryPath(cwd, ".supervised-worker/plan.json").join("\n"),
      /protected/,
    );
    assert.match(validateRepositoryPath(cwd, "linked/file.js").join("\n"), /symbolic link/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("contract and build paths reject dangling links", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-dangling-"));
  const target = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-target-"));
  try {
    const dangling = path.join(cwd, "dangling");
    symlinkSync(target, dangling, process.platform === "win32" ? "junction" : "dir");
    rmSync(target, { recursive: true, force: true });

    const contract = readJson("examples/handoff.build-contract.json");
    contract.targetFiles = ["dangling/file.js"];
    assert.match(validateHandoffValue(contract, cwd).join("\n"), /symbolic link/);

    const build = readJson("examples/handoff.build-report.json");
    build.changedFiles = ["dangling/file.js"];
    assert.match(validateHandoffValue(build, cwd).join("\n"), /symbolic link/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("contract and build paths reject hard-linked regular files", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-hardlink-"));
  try {
    mkdirSync(path.join(cwd, ".git"), { recursive: true });
    mkdirSync(path.join(cwd, "src"), { recursive: true });
    const protectedFile = path.join(cwd, ".git", "config");
    writeFileSync(protectedFile, "protected\n");
    linkSync(protectedFile, path.join(cwd, "src", "alias.txt"));

    const contract = readJson("examples/handoff.build-contract.json");
    contract.targetFiles = ["src/alias.txt"];
    assert.match(validateHandoffValue(contract, cwd).join("\n"), /multiple hard links/);

    const build = readJson("examples/handoff.build-report.json");
    build.changedFiles = ["src/alias.txt"];
    assert.match(validateHandoffValue(build, cwd).join("\n"), /multiple hard links/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rename verification requires both source and destination paths", () => {
  withFixture((fixture) => {
    git(
      fixture.cwd,
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "baseline",
    );
    const source = path.join(fixture.cwd, "src", "module.js");
    const destination = path.join(fixture.cwd, "src", "renamed.js");
    renameSync(source, destination);
    git(fixture.cwd, "add", "--all", "--", "src");

    fixture.contract.targetFiles = ["src/module.js", "src/renamed.js"];
    const contractHash = writeJson(fixture.contractPath, fixture.contract);
    fixture.build.contractHash = contractHash;
    fixture.build.testedTreeHash = git(fixture.cwd, "write-tree");
    fixture.build.changedFiles = ["src/module.js", "src/renamed.js"];
    const buildHash = writeJson(fixture.buildPath, fixture.build);
    fixture.review.contractHash = contractHash;
    fixture.review.buildReportHash = buildHash;
    fixture.review.stagedTreeHash = git(fixture.cwd, "write-tree");
    issueFixtureReview(fixture);
    const accepted = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(accepted.ok, true, accepted.errors.join("\n"));

    fixture.build.changedFiles = ["src/renamed.js"];
    const incompleteHash = writeJson(fixture.buildPath, fixture.build);
    fixture.review.buildReportHash = incompleteHash;
    writeModelReceipts(fixture.cwd, fixture.review, null, DEFAULT_ROLES);
    writeJson(fixture.reviewPath, fixture.review);
    const rejected = verifyHandoffChain(
      fixture.cwd,
      fixture.contractPath,
      fixture.buildPath,
      fixture.reviewPath,
    );
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join("\n"), /staged paths do not exactly match/);
  });
});

test("case-only rename keeps source and destination as distinct Git paths", () => {
  withFixture((fixture) => {
    git(
      fixture.cwd,
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "baseline",
    );
    writeFileSync(path.join(fixture.cwd, "src", "Foo.js"), "export const value = 1;\n");
    git(fixture.cwd, "add", "--", "src/Foo.js");
    git(
      fixture.cwd,
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "add case source",
    );
    git(fixture.cwd, "mv", "-f", "--", "src/Foo.js", "src/foo.js");

    fixture.contract.targetFiles = ["src/Foo.js", "src/foo.js"];
    const contractHash = writeJson(fixture.contractPath, fixture.contract);
    fixture.build.contractHash = contractHash;
    fixture.build.testedTreeHash = git(fixture.cwd, "write-tree");
    fixture.build.changedFiles = ["src/Foo.js", "src/foo.js"];
    const buildHash = writeJson(fixture.buildPath, fixture.build);
    fixture.review.contractHash = contractHash;
    fixture.review.buildReportHash = buildHash;
    fixture.review.stagedTreeHash = git(fixture.cwd, "write-tree");
    writeJson(fixture.reviewPath, fixture.review);
    assert.equal(
      verifyBuildHandoff(fixture.cwd, fixture.contractPath, fixture.buildPath).ok,
      true,
    );

    fixture.build.changedFiles = ["src/foo.js"];
    writeJson(fixture.buildPath, fixture.build);
    const rejected = verifyBuildHandoff(fixture.cwd, fixture.contractPath, fixture.buildPath);
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join("\n"), /staged paths do not exactly match/);
  });
});

test("CLI validates one artifact and verifies the complete chain", () => {
  withFixture((fixture) => {
    const { cwd, contractPath, buildPath, reviewPath } = fixture;
    const inspected = spawnSync(process.execPath, [cli, "handoff", "validate", contractPath], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
    assert.equal(JSON.parse(inspected.stdout).ok, true);

    const preReview = spawnSync(
      process.execPath,
      [cli, "handoff", "pre-review", contractPath, buildPath],
      { cwd, encoding: "utf8" },
    );
    assert.equal(preReview.status, 0, preReview.stderr || preReview.stdout);
    assert.equal(JSON.parse(preReview.stdout).ok, true);

    const issued = spawnSync(
      process.execPath,
      [cli, "handoff", "issue-review", contractPath, buildPath],
      { cwd, encoding: "utf8" },
    );
    assert.equal(issued.status, 0, issued.stderr || issued.stdout);
    const attempt = JSON.parse(issued.stdout);
    assert.equal(attempt.ok, true, attempt.errors.join("\n"));
    fixture.review.reviewAttemptId = attempt.reviewAttemptId;
    fixture.review.createdAt = attempt.issuedAt;
    writeModelReceipts(cwd, fixture.review, null, DEFAULT_ROLES);
    writeJson(reviewPath, fixture.review);

    const verified = spawnSync(
      process.execPath,
      [cli, "handoff", "verify", contractPath, buildPath, reviewPath],
      { cwd, encoding: "utf8" },
    );
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    assert.equal(JSON.parse(verified.stdout).ok, true);
  });
});

test("preferred Worker producer passes every CLI handoff gate", () => {
  withFixture((fixture) => {
    fixture.contract.producedBy = "seangalliher-supervised-worker";
    const contractHash = writeJson(fixture.contractPath, fixture.contract);
    fixture.build.producedBy = "seangalliher-supervised-worker";
    fixture.build.contractHash = contractHash;
    const buildHash = writeJson(fixture.buildPath, fixture.build);
    fixture.review.contractHash = contractHash;
    fixture.review.buildReportHash = buildHash;
    issueFixtureReview(fixture);

    for (const args of [
      ["handoff", "validate", fixture.contractPath],
      ["handoff", "pre-review", fixture.contractPath, fixture.buildPath],
      ["handoff", "verify", fixture.contractPath, fixture.buildPath, fixture.reviewPath],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: fixture.cwd,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).ok, true);
    }
  });
});

test("specialized workflow roles pass the complete CLI handoff chain", () => {
  withFixture((fixture) => {
    const workflow = readJson("examples/workflow.json");
    workflow.roles = {
      architect: "architect",
      builder: "builder",
      reviewer: "diff-reviewer",
    };
    workflow.review.agent = "diff-reviewer";
    workflow.review.requiredModel = "gpt-5.6-sol";
    workflow.review.requiredModelFamily = "openai";
    workflow.review.requireDifferentModelFamily = true;
    const workflowPath = path.join(fixture.cwd, ".github", "supervised-worker.json");
    writeJson(workflowPath, workflow);
    git(fixture.cwd, "add", "--", "src/module.js", ".github/supervised-worker.json");
    git(
      fixture.cwd,
      "-c",
      "user.name=Supervised Worker Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "add workflow baseline",
    );
    writeFileSync(path.join(fixture.cwd, "src", "module.js"), "export const value = 2;\n");
    git(fixture.cwd, "add", "--", "src/module.js");

    const resolved = spawnSync(process.execPath, [cli, "workflow", "roles"], {
      cwd: fixture.cwd,
      encoding: "utf8",
    });
    assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);
    const roleReport = JSON.parse(resolved.stdout);
    assert.equal(roleReport.accepted, false);
    assert.match(roleReport.workflowHash, /^[0-9a-f]{64}$/);

    fixture.contract.producedBy = "architect";
    fixture.contract.workflowHash = roleReport.workflowHash;
    const contractHash = writeJson(fixture.contractPath, fixture.contract);
    fixture.build.producedBy = "builder";
    fixture.build.workflowHash = roleReport.workflowHash;
    fixture.build.contractHash = contractHash;
    fixture.build.testedTreeHash = git(fixture.cwd, "write-tree");
    const buildHash = writeJson(fixture.buildPath, fixture.build);
    fixture.review.producedBy = "diff-reviewer";
    fixture.review.workflowHash = roleReport.workflowHash;
    fixture.review.contractHash = contractHash;
    fixture.review.buildReportHash = buildHash;
    fixture.review.stagedTreeHash = git(fixture.cwd, "write-tree");
    writeModelReceipts(fixture.cwd, fixture.review, roleReport.workflowHash, workflow.roles);
    writeJson(fixture.reviewPath, fixture.review);

    const handoffCommands = [
      ["handoff", "validate", fixture.contractPath],
      ["handoff", "pre-review", fixture.contractPath, fixture.buildPath],
      ["handoff", "verify", fixture.contractPath, fixture.buildPath, fixture.reviewPath],
    ];
    for (const args of handoffCommands) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: fixture.cwd,
        encoding: "utf8",
      });
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(JSON.parse(result.stdout).errors.join("\n"), /explicitly accepted/);
    }

    const accepted = spawnSync(
      process.execPath,
      [cli, "workflow", "accept", roleReport.workflowHash],
      { cwd: fixture.cwd, encoding: "utf8" },
    );
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.equal(JSON.parse(accepted.stdout).accepted, true);
    issueFixtureReview(fixture, roleReport.workflowHash, workflow.roles);

    for (const args of handoffCommands) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: fixture.cwd,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).ok, true);
    }

    const validReview = structuredClone(fixture.review);
    const reviewerReceiptPath = path.join(
      fixture.cwd,
      ...validReview.modelResolution.reviewer.evidence.locator.split("/"),
    );
    const validReviewerReceipt = JSON.parse(readFileSync(reviewerReceiptPath, "utf8"));
    const wrongReceiptHashReview = structuredClone(validReview);
    wrongReceiptHashReview.modelResolution.reviewer.evidence.sha256 = "a".repeat(64);
    writeJson(fixture.reviewPath, wrongReceiptHashReview);
    let rejected = spawnSync(
      process.execPath,
      [cli, "handoff", "verify", fixture.contractPath, fixture.buildPath, fixture.reviewPath],
      { cwd: fixture.cwd, encoding: "utf8" },
    );
    assert.equal(rejected.status, 1, rejected.stderr || rejected.stdout);
    assert.match(JSON.parse(rejected.stdout).errors.join("\n"), /receipt hash does not match/);

    const forgedReceipt = structuredClone(validReviewerReceipt);
    forgedReceipt.model = "gpt-5.4";
    const forgedReceiptHash = writeJson(reviewerReceiptPath, forgedReceipt);
    const forgedReceiptReview = structuredClone(validReview);
    forgedReceiptReview.modelResolution.reviewer.evidence.sha256 = forgedReceiptHash;
    writeJson(fixture.reviewPath, forgedReceiptReview);
    rejected = spawnSync(
      process.execPath,
      [cli, "handoff", "verify", fixture.contractPath, fixture.buildPath, fixture.reviewPath],
      { cwd: fixture.cwd, encoding: "utf8" },
    );
    assert.equal(rejected.status, 1, rejected.stderr || rejected.stdout);
    assert.match(JSON.parse(rejected.stdout).errors.join("\n"), /receipt model does not match/);
    writeJson(reviewerReceiptPath, validReviewerReceipt);

    for (const [name, mutate, expected] of [
      [
        "wrong reviewer model",
        (review) => { review.modelResolution.reviewer.model = "gpt-5.4"; },
        /workflow-required reviewer model/,
      ],
      [
        "unknown model separation",
        (review) => { review.modelSeparation = "unknown"; },
        /requires a different Builder and Reviewer model family/,
      ],
      [
        "same resolved family",
        (review) => { review.modelResolution.builder.family = "openai"; },
        /identical resolved model families/,
      ],
    ]) {
      const invalidReview = structuredClone(validReview);
      mutate(invalidReview);
      writeJson(fixture.reviewPath, invalidReview);
      const result = spawnSync(
        process.execPath,
        [cli, "handoff", "verify", fixture.contractPath, fixture.buildPath, fixture.reviewPath],
        { cwd: fixture.cwd, encoding: "utf8" },
      );
      assert.equal(result.status, 1, `${name}: ${result.stderr || result.stdout}`);
      assert.match(JSON.parse(result.stdout).errors.join("\n"), expected);
    }
    writeJson(fixture.reviewPath, validReview);

    writeFileSync(workflowPath, `${readFileSync(workflowPath, "utf8")}\n`);
    for (const args of handoffCommands) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: fixture.cwd,
        encoding: "utf8",
      });
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(JSON.parse(result.stdout).errors.join("\n"), /explicitly accepted/);
    }

    const changedRoles = spawnSync(process.execPath, [cli, "workflow", "roles"], {
      cwd: fixture.cwd,
      encoding: "utf8",
    });
    const changedRoleReport = JSON.parse(changedRoles.stdout);
    const reaccepted = spawnSync(
      process.execPath,
      [cli, "workflow", "accept", changedRoleReport.workflowHash],
      { cwd: fixture.cwd, encoding: "utf8" },
    );
    assert.equal(reaccepted.status, 0, reaccepted.stderr || reaccepted.stdout);
    for (const args of handoffCommands) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: fixture.cwd,
        encoding: "utf8",
      });
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(JSON.parse(result.stdout).errors.join("\n"), /workflowHash does not match/);
    }
  });
});

test("default workflow rejects a specialized producer identity", () => {
  const contract = readJson("examples/handoff.build-contract.json");
  contract.producedBy = "architect";
  assert.match(
    validateHandoffValue(contract, root).join("\n"),
    /producedBy is invalid for build-contract/,
  );
});

test("CLI accepts a filesystem alias that resolves inside the handoff directory", () => {
  withFixture(({ cwd, contractPath }) => {
    const aliasParent = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-alias-parent-"));
    const alias = path.join(aliasParent, "workspace-alias");
    try {
      symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
      const aliasContract = path.join(alias, path.relative(cwd, contractPath));
      const inspected = spawnSync(process.execPath, [cli, "handoff", "validate", aliasContract], {
        cwd,
        encoding: "utf8",
      });
      assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
      assert.equal(JSON.parse(inspected.stdout).ok, true);
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
    }
  });
});

test("CLI accepts a case-only alias for a normal Windows workspace", {
  skip: process.platform !== "win32",
}, () => {
  withFixture(({ cwd, contractPath }) => {
    const aliasRoot = path.join(path.dirname(cwd), path.basename(cwd).toUpperCase());
    const canonicalStats = lstatSync(realpathSync(cwd), { bigint: true });
    const aliasStats = lstatSync(realpathSync(aliasRoot), { bigint: true });
    assert.notEqual(aliasRoot, cwd, "the alias spelling must differ");
    assert.equal(aliasStats.dev, canonicalStats.dev, "the alias must stay on the same device");
    assert.equal(aliasStats.ino, canonicalStats.ino, "the alias must identify the same directory");

    const aliasContract = path.join(aliasRoot, path.relative(cwd, contractPath));
    const result = spawnSync(process.execPath, [cli, "handoff", "validate", aliasContract], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).ok, true);
  });
});

test("CLI rejects an external handoff-root junction", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-root-link-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-root-outside-"));
  try {
    const contract = readJson("examples/handoff.build-contract.json");
    const itemHash = sha256(contract.itemId);
    const outsideItem = path.join(outside, itemHash);
    writeJson(path.join(outsideItem, "build-contract.json"), contract);
    const state = path.join(cwd, ".supervised-worker");
    mkdirSync(state, { recursive: true });
    symlinkSync(outside, path.join(state, "handoffs"), process.platform === "win32" ? "junction" : "dir");

    const requested = path.join(state, "handoffs", itemHash, "build-contract.json");
    const result = spawnSync(process.execPath, [cli, "handoff", "validate", requested], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(result.stdout).errors.join("\n"), /symbolic link or junction/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("CLI rejects an item-hash junction to a sibling item", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-item-link-"));
  try {
    const contract = readJson("examples/handoff.build-contract.json");
    contract.itemId = "item-b";
    const itemBHash = sha256(contract.itemId);
    const itemAHash = sha256("item-a");
    const handoffs = path.join(cwd, ".supervised-worker", "handoffs");
    const itemB = path.join(handoffs, itemBHash);
    writeJson(path.join(itemB, "build-contract.json"), contract);
    symlinkSync(itemB, path.join(handoffs, itemAHash), process.platform === "win32" ? "junction" : "dir");

    const requested = path.join(handoffs, itemAHash, "build-contract.json");
    const result = spawnSync(process.execPath, [cli, "handoff", "validate", requested], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(result.stdout).errors.join("\n"), /symbolic link or junction/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("all CLI gates reject an external exact-suffix item alias", () => {
  withFixture(({ cwd, contractPath, buildPath, reviewPath }) => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-external-item-"));
    try {
      const itemHash = path.basename(path.dirname(contractPath));
      const externalItem = path.join(outside, ".supervised-worker", "handoffs", itemHash);
      mkdirSync(path.dirname(externalItem), { recursive: true });
      symlinkSync(
        path.dirname(contractPath),
        externalItem,
        process.platform === "win32" ? "junction" : "dir",
      );
      const externalContract = path.join(externalItem, "build-contract.json");
      const externalBuild = path.join(externalItem, "build-report.json");
      const externalReview = path.join(externalItem, "review-report.json");
      for (const args of [
        ["handoff", "validate", externalContract],
        ["handoff", "pre-review", externalContract, externalBuild],
        ["handoff", "verify", externalContract, externalBuild, externalReview],
      ]) {
        const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
        assert.equal(result.status, 1, result.stderr);
        assert.match(
          JSON.parse(result.stdout).errors.join("\n"),
          /prefix does not identify the active workspace/,
        );
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("all CLI gates reject a case-distinct external workspace", {
  skip: process.platform !== "win32",
}, (context) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-case-root-"));
  try {
    try {
      execFileSync("fsutil", ["file", "setCaseSensitiveInfo", parent, "enable"]);
    } catch (error) {
      const reason = error.code ?? error.status ?? error.message;
      context.skip(`per-directory case sensitivity is unavailable: ${reason}`);
      return;
    }
    const active = path.join(parent, "Workspace");
    const external = path.join(parent, "workspace");
    mkdirSync(active);
    mkdirSync(external);
    const fixture = chainFixture(active);
    const activeReal = realpathSync(active);
    const externalReal = realpathSync(external);
    assert.notEqual(activeReal, externalReal, "case-sensitive roots must be distinct");

    const itemHash = path.basename(path.dirname(fixture.contractPath));
    const externalItem = path.join(external, ".supervised-worker", "handoffs", itemHash);
    const externalContract = structuredClone(fixture.contract);
    externalContract.objective = "External contract must not be consumed";
    const externalContractPath = path.join(externalItem, "build-contract.json");
    const externalContractHash = writeJson(externalContractPath, externalContract);
    assert.notEqual(
      externalContractHash,
      sha256(readFileSync(fixture.contractPath)),
      "external and canonical contract bytes must differ",
    );

    const externalBuild = structuredClone(fixture.build);
    externalBuild.contractHash = externalContractHash;
    const externalBuildPath = path.join(externalItem, "build-report.json");
    const externalBuildHash = writeJson(externalBuildPath, externalBuild);
    const externalReview = structuredClone(fixture.review);
    externalReview.contractHash = externalContractHash;
    externalReview.buildReportHash = externalBuildHash;
    const externalReviewPath = path.join(externalItem, "review-report.json");
    writeJson(externalReviewPath, externalReview);

    for (const args of [
      ["handoff", "validate", externalContractPath],
      ["handoff", "pre-review", externalContractPath, externalBuildPath],
      ["handoff", "verify", externalContractPath, externalBuildPath, externalReviewPath],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: active, encoding: "utf8" });
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(
        JSON.parse(result.stdout).errors.join("\n"),
        /prefix does not identify the active workspace/,
      );
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("all CLI gates reject a hard-linked handoff artifact", () => {
  withFixture(({ cwd, contractPath, buildPath, reviewPath }) => {
    const alias = path.join(cwd, "contract-hardlink-copy.json");
    linkSync(contractPath, alias);
    for (const args of [
      ["handoff", "validate", contractPath],
      ["handoff", "pre-review", contractPath, buildPath],
      ["handoff", "verify", contractPath, buildPath, reviewPath],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
      assert.equal(result.status, 1, result.stderr);
      assert.match(JSON.parse(result.stdout).errors.join("\n"), /multiple hard links/);
    }
  });
});
