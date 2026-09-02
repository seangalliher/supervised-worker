import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { validateHandoffValue } from "../src/handoff.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = readJson("schemas/role-handoff.schema.json");
const ajv = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false });
addFormats(ajv);
const validate = ajv.compile(schema);

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function assertValid(value, label) {
  assert.equal(validate(value), true, `${label}: ${ajv.errorsText(validate.errors)}`);
  assert.deepEqual(validateHandoffValue(value, root), [], `${label}: runtime`);
}

function assertInvalid(value, label) {
  assert.equal(validate(value), false, `${label} unexpectedly passed`);
  assert.ok(validate.errors?.length, `${label} must produce a schema error`);
  assert.ok(validateHandoffValue(value, root).length, `${label} unexpectedly passed runtime`);
}

test("all role handoff examples validate", () => {
  for (const fileName of [
    "handoff.build-contract.json",
    "handoff.build-report.json",
    "handoff.review-report.json",
  ]) {
    assertValid(readJson(`examples/${fileName}`), fileName);
  }
});

test("stable Worker producer identity remains backward compatible", () => {
  const contract = clone(readJson("examples/handoff.build-contract.json"));
  contract.producedBy = "supervised-worker";
  assertValid(contract, "Worker-authored contract");

  const build = clone(readJson("examples/handoff.build-report.json"));
  build.producedBy = "supervised-worker";
  assertValid(build, "Worker-authored build report");

  contract.producedBy = "seangalliher-supervised-worker";
  assertInvalid(contract, "nonexistent qualified Worker producer");
});

test("escalation blocked-build and changes-required branches validate", () => {
  const contract = clone(readJson("examples/handoff.build-contract.json"));
  contract.status = "escalation-required";
  contract.selectedApproach = null;
  contract.targetFiles = [];
  contract.focusedChecks = [];
  contract.broadGate = null;
  contract.blockedBy = {
    boundary: "production access",
    decision: "Authorize a read-only production probe.",
    resumeWhen: "The repository owner grants explicit production access.",
  };
  assertValid(contract, "escalation-required contract");

  const build = clone(readJson("examples/handoff.build-report.json"));
  build.status = "blocked";
  build.testedTreeHash = null;
  build.changedFiles = [];
  build.checks = [];
  build.evidence = [];
  build.blocker = "The contract references a missing consumer.";
  assertValid(build, "blocked build report");

  const review = clone(readJson("examples/handoff.review-report.json"));
  review.verdict = "changes-required";
  review.findings.push({
    severity: "high",
    summary: "The consumer rejects the generated value.",
    consumer: "delivery handler",
    evidence: [{ kind: "probe", locator: "local:consumer-probe" }],
    blocksCommit: true,
  });
  assertValid(review, "changes-required review report");
});

test("approved build contract requires an implementation footprint", () => {
  const value = clone(readJson("examples/handoff.build-contract.json"));
  value.targetFiles = [];
  assertInvalid(value, "empty targetFiles");
});

test("build contract paths stay repository relative", () => {
  for (const target of [
    "../outside.js",
    "/absolute/outside.js",
    "C:\\outside.js",
    ".git/config",
    ".Git/config",
    ".git./config",
    ".supervised-worker/plan.json",
    ".Supervised-Worker/plan.json",
    ".supervised-worker./plan.json",
    "src/unsafe\u0000path.js",
    "src/*.js",
    "src/",
  ]) {
    const contract = clone(readJson("examples/handoff.build-contract.json"));
    contract.targetFiles = [target];
    assertInvalid(contract, `unsafe target path ${target}`);

    const build = clone(readJson("examples/handoff.build-report.json"));
    build.changedFiles = [target];
    assertInvalid(build, `unsafe changed path ${target}`);
  }
});

test("schema and runtime accept the same representative safe paths", () => {
  for (const target of [
    "src/module.js",
    ".github/workflows/ci.yml",
    "docs/file name.md",
  ]) {
    const contract = clone(readJson("examples/handoff.build-contract.json"));
    contract.targetFiles = [target];
    assertValid(contract, `safe target path ${target}`);

    const build = clone(readJson("examples/handoff.build-report.json"));
    build.changedFiles = [target];
    assertValid(build, `safe changed path ${target}`);
  }
});

test("implemented build report cannot hide skipped validation", () => {
  const value = clone(readJson("examples/handoff.build-report.json"));
  value.checks[0].outcome = "skipped";
  assertInvalid(value, "skipped implementation check");
});

test("clean review cannot contain findings", () => {
  const value = clone(readJson("examples/handoff.review-report.json"));
  value.findings.push({
    severity: "medium",
    summary: "The consumer rejects the generated value.",
    consumer: "delivery handler",
    evidence: [{ kind: "probe", locator: "local:consumer-probe" }],
    blocksCommit: true,
  });
  assertInvalid(value, "clean review with finding");
});

test("changes-required review must identify a finding", () => {
  const value = clone(readJson("examples/handoff.review-report.json"));
  value.verdict = "changes-required";
  assertInvalid(value, "changes-required review without finding");
});

test("changes-required review must identify a commit blocker", () => {
  const value = clone(readJson("examples/handoff.review-report.json"));
  value.verdict = "changes-required";
  value.findings.push({
    severity: "low",
    summary: "A follow-up improvement is available.",
    consumer: "maintainer",
    evidence: [{ kind: "reading", locator: "src/module.js" }],
    blocksCommit: false,
  });
  assertInvalid(value, "changes-required review without commit blocker");
});

test("review report requires a real staged tree hash", () => {
  const value = clone(readJson("examples/handoff.review-report.json"));
  value.stagedTreeHash = "not-a-tree";
  assertInvalid(value, "malformed staged tree hash");
});