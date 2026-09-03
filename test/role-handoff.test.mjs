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

test("raw and plugin-qualified Worker selector identities produce valid handoffs", () => {
  const contract = clone(readJson("examples/handoff.build-contract.json"));
  const build = clone(readJson("examples/handoff.build-report.json"));
  for (const producer of [
    "supervised-worker",
    "seangalliher-supervised-worker",
    "supervised-worker:supervised-worker",
    "supervised-worker:seangalliher-supervised-worker",
  ]) {
    contract.producedBy = producer;
    assertValid(contract, `${producer} contract`);
    build.producedBy = producer;
    assertValid(build, `${producer} build report`);
  }

  contract.producedBy = "other-worker";
  assert.equal(validate(contract), true, ajv.errorsText(validate.errors));
  assert.match(
    validateHandoffValue(contract, root).join("\n"),
    /producedBy is invalid for build-contract/,
  );
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
    ".github/supervised-worker.json",
    ".GitHub/Supervised-Worker.JSON",
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

test("legacy v1 handoffs remain valid only with bundled reference roles", () => {
  const legacyProducers = new Map([
    ["handoff.build-contract.json", "seangalliher-supervised-architect"],
    ["handoff.build-report.json", "seangalliher-supervised-builder"],
    ["handoff.review-report.json", "seangalliher-supervised-diff-reviewer"],
  ]);
  for (const [fileName, producedBy] of legacyProducers) {
    const previousV2 = clone(readJson(`examples/${fileName}`));
    previousV2.producedBy = producedBy;
    assertValid(previousV2, `previous version 2 ${fileName}`);

    const legacy = clone(previousV2);
    legacy.schemaVersion = 1;
    delete legacy.workflowHash;
    assertValid(legacy, `legacy ${fileName}`);

    const invalidV1 = clone(legacy);
    invalidV1.workflowHash = null;
    assertInvalid(invalidV1, `version 1 ${fileName} with workflowHash`);
  }
});

test("schema and runtime reject the same noncanonical timestamps", () => {
  for (const fileName of [
    "handoff.build-contract.json",
    "handoff.build-report.json",
    "handoff.review-report.json",
  ]) {
    for (const timestamp of [
      "2026-09-02t12:00:00z",
      "1990-12-31T23:59:60Z",
      "0000-01-01T00:00:00Z",
      "2026-02-30T00:00:00Z",
    ]) {
      const value = clone(readJson(`examples/${fileName}`));
      value.createdAt = timestamp;
      assertInvalid(value, `${fileName} timestamp ${timestamp}`);
    }
  }
});

test("review model resolution is schema and runtime validated", () => {
  for (const mutate of [
    (value) => { delete value.modelResolution.reviewer.evidence; },
    (value) => {
      value.modelResolution.reviewer.evidence = {
        kind: "self-attested",
        locator: "agent-output:claim",
        sha256: "a".repeat(64),
      };
    },
    (value) => { value.modelResolution.reviewer.model = "GPT 5.6 Sol"; },
    (value) => { value.modelResolution.reviewer.model = 5; },
    (value) => { value.modelResolution.builder.family = "Anthropic"; },
    (value) => { value.modelResolution.builder.family = 5; },
    (value) => { value.modelResolution.extra = {}; },
  ]) {
    const value = clone(readJson("examples/handoff.review-report.json"));
    mutate(value);
    assertInvalid(value, "invalid model resolution");
  }
});

test("review model separation must agree with resolved families", () => {
  const sameFamily = clone(readJson("examples/handoff.review-report.json"));
  sameFamily.modelResolution.builder.family = "openai";
  assert.equal(validate(sameFamily), true, ajv.errorsText(validate.errors));
  assert.match(
    validateHandoffValue(sameFamily, root).join("\n"),
    /identical resolved model families/,
  );

  const differentFamilies = clone(readJson("examples/handoff.review-report.json"));
  differentFamilies.modelSeparation = "same-family";
  assert.equal(validate(differentFamilies), true, ajv.errorsText(validate.errors));
  assert.match(
    validateHandoffValue(differentFamilies, root).join("\n"),
    /different resolved model families/,
  );
});