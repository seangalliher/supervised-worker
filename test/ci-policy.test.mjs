import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { validateRepositoryCiPolicy, verifyRepositoryCiObservation } from "../src/ci-policy.mjs";
import { validateCampaignRelease } from "../src/core.mjs";
import { validateWorkflowValue } from "../src/workflow.mjs";

const hash = "a".repeat(64);
const commit = "b".repeat(40);
const policy = { requiredJobs: [
  { name: "python-tests", requiredSteps: ["Run tests"] },
  { name: "ui-tests", requiredSteps: [] },
] };
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const workflowSchema = ajv.compile(JSON.parse(readFileSync(new URL("../schemas/workflow.schema.json", import.meta.url))));
const providerSchema = ajv.compile({
  ...JSON.parse(readFileSync(new URL("../schemas/campaign-release.schema.json", import.meta.url))),
  oneOf: [{ $ref: "#/$defs/provider" }],
});

function observation() {
  return { kind: "repository-ci", workflowHash: hash, runId: 1, commit, complete: true, conclusion: "success",
    jobs: policy.requiredJobs.map(job => ({ name: job.name, commit, conclusion: "success",
      steps: job.requiredSteps.map(name => ({ name, status: "completed", conclusion: "success" })) })) };
}

function provider(ci) {
  return { schemaVersion: 1, kind: "release-provider-observation", integrity: "unattested",
    actorHash: hash, repositoryHash: hash, commit, ref: "refs/heads/main",
    observedAt: "2026-01-01T00:00:00.000Z", complete: true, remoteCommit: commit, ci, closures: [] };
}

test("repository CI requires an explicit nonempty job policy and preserves optional step requirements", () => {
  assert.deepEqual(validateRepositoryCiPolicy(policy), []);
  assert.doesNotThrow(() => verifyRepositoryCiObservation(observation(), policy, hash, commit));
  const withExtra = observation();
  withExtra.jobs.push({ name: "extra-check", commit, conclusion: "success", steps: [] });
  assert.doesNotThrow(() => verifyRepositoryCiObservation(withExtra, policy, hash, commit));
});

test("repository CI policy rejects malformed, duplicate and excessive requirements", () => {
  for (const invalid of [
    null, undefined, [], {}, { requiredJobs: [] }, { ...policy, allowMissing: true },
    { requiredJobs: [{ name: "", requiredSteps: [] }] },
    { requiredJobs: [{ name: " ", requiredSteps: [] }] },
    { requiredJobs: [{ name: "line\nbreak", requiredSteps: [] }] },
    { requiredJobs: [{ name: "x".repeat(257), requiredSteps: [] }] },
    { requiredJobs: [{ name: "python-tests" }] },
    { requiredJobs: [{ name: "python-tests", requiredSteps: null }] },
    { requiredJobs: [{ name: "python-tests", requiredSteps: ["Run tests", "Run tests"] }] },
    { requiredJobs: [{ name: "python-tests", requiredSteps: ["\t"] }] },
    { requiredJobs: [{ name: "python-tests", requiredSteps: [], skip: true }] },
    { requiredJobs: [policy.requiredJobs[0], policy.requiredJobs[0]] },
    { requiredJobs: Array.from({ length: 129 }, (_, i) => ({ name: `job-${i}`, requiredSteps: [] })) },
    { requiredJobs: [{ name: "job", requiredSteps: Array.from({ length: 129 }, (_, i) => `step-${i}`) }] },
  ]) {
    assert.ok(validateRepositoryCiPolicy(invalid).length > 0, JSON.stringify(invalid));
  }
});

test("repository CI refuses missing, failing, stale and duplicate observations", () => {
  assert.doesNotThrow(() => verifyRepositoryCiObservation(observation(), policy, hash, commit));
  for (const mutate of [
    ci => { ci.jobs.pop(); },
    ci => { ci.jobs[0].steps = []; },
    ci => { ci.jobs[0].steps[0].conclusion = "failure"; },
    ci => { ci.jobs[0].steps[0].status = "in_progress"; },
    ci => { ci.jobs[0].steps.push(ci.jobs[0].steps[0]); },
    ci => { ci.jobs[0].conclusion = "failure"; },
    ci => { ci.jobs.push(ci.jobs[0]); },
    ci => { ci.jobs.push({ name: "extra-check", commit, conclusion: "failure", steps: [] }); },
    ci => { ci.jobs[0].commit = "c".repeat(40); },
    ci => { ci.commit = "c".repeat(40); },
    ci => { ci.workflowHash = "c".repeat(64); },
    ci => { ci.complete = false; },
    ci => { ci.conclusion = "failure"; },
    ci => { ci.runId = 0; },
    ci => { ci.kind = "promotion-ci"; },
    ci => { ci.jobs[0].name = ""; },
    ci => { ci.jobs[0].steps[0].rawOutput = "untrusted"; },
    ci => { ci.extra = true; },
  ]) {
    const ci = observation();
    mutate(ci);
    assert.throws(() => verifyRepositoryCiObservation(ci, policy, hash, commit), /RELEASE_CI_OBSERVATION_INVALID/);
  }
  for (const ci of [null, {}, [], undefined]) {
    assert.throws(() => verifyRepositoryCiObservation(ci, policy, hash, commit), /RELEASE_CI_OBSERVATION_INVALID/);
  }
  assert.throws(() => verifyRepositoryCiObservation(observation(), null, hash, commit), /RELEASE_CI_POLICY_REQUIRED/);
  assert.throws(() => verifyRepositoryCiObservation(observation(), policy, null, commit), /RELEASE_CI_POLICY_REQUIRED/);
});

test("workflow schema and runtime accept repository CI and reject malformed policy", () => {
  const baseline = JSON.parse(readFileSync(new URL("../examples/workflow.json", import.meta.url)));
  for (const ci of [policy, { requiredJobs: [{ name: "build", requiredSteps: ["Compile"] }] }]) {
    const workflow = structuredClone(baseline);
    workflow.validation.ci = ci;
    assert.equal(workflowSchema(workflow), true, JSON.stringify(workflowSchema.errors));
    assert.deepEqual(validateWorkflowValue(workflow), []);
  }
  for (const ci of [null, {}, { requiredJobs: [] }, { requiredJobs: [{ name: "job", requiredSteps: null }] }]) {
    const workflow = structuredClone(baseline);
    workflow.validation.ci = ci;
    assert.equal(workflowSchema(workflow), false);
    assert.ok(validateWorkflowValue(workflow).length > 0);
  }
});

test("duplicate CI job names with distinct step lists require the documented semantic runtime check", () => {
  const workflow = JSON.parse(readFileSync(new URL("../examples/workflow.json", import.meta.url)));
  workflow.validation.ci = { requiredJobs: [
    { name: "build", requiredSteps: ["Compile"] },
    { name: "build", requiredSteps: ["Test"] },
  ] };
  // JSON Schema checks object shape; job-name uniqueness is a cross-field runtime invariant.
  assert.equal(workflowSchema(workflow), true, JSON.stringify(workflowSchema.errors));
  assert.ok(validateWorkflowValue(workflow).some(error => error.includes("validation.ci")));
});

test("provider schema admits bounded tagged repository CI without admitting arbitrary provider fields", () => {
  assert.equal(providerSchema(provider(observation())), true, JSON.stringify(providerSchema.errors));
  assert.equal(providerSchema(provider(null)), true, JSON.stringify(providerSchema.errors));
  for (const mutate of [
    ci => { delete ci.kind; },
    ci => { delete ci.workflowHash; },
    ci => { ci.jobs = []; },
    ci => { ci.jobs[0].steps[0].status = "in_progress"; },
    ci => { ci.jobs[0].steps[0].rawOutput = "untrusted"; },
    ci => { ci.jobs = Array.from({ length: 257 }, (_, i) => ({ name: `job-${i}`, commit, conclusion: "success", steps: [] })); },
  ]) {
    const ci = observation();
    mutate(ci);
    assert.equal(providerSchema(provider(ci)), false, JSON.stringify(ci));
  }
});

test("CI name consumers reject Unicode controls and format characters without excluding visible Unicode", () => {
  const baseline = JSON.parse(readFileSync(new URL("../examples/workflow.json", import.meta.url)));
  const check = (text, accepted) => {
    const ciPolicy = { requiredJobs: [{ name: text, requiredSteps: [text] }] };
    const ci = { ...observation(), jobs: [{ name: text, commit, conclusion: "success",
      steps: [{ name: text, status: "completed", conclusion: "success" }] }] };
    const workflow = structuredClone(baseline);
    workflow.validation.ci = ciPolicy;
    assert.equal(validateRepositoryCiPolicy(ciPolicy).length === 0, accepted, JSON.stringify(text));
    assert.equal(validateWorkflowValue(workflow).length === 0, accepted, JSON.stringify(text));
    assert.equal(workflowSchema(workflow), accepted, JSON.stringify(text));
    assert.equal(providerSchema(provider(ci)), accepted, JSON.stringify(text));
    assert.equal(validateCampaignRelease(provider(ci), "provider").length === 0, accepted, JSON.stringify(text));
    if (accepted) assert.doesNotThrow(() => verifyRepositoryCiObservation(ci, ciPolicy, hash, commit));
    for (const location of ["job", "step"]) {
      const withExtra = observation();
      if (location === "job") withExtra.jobs.push({ name: text, commit, conclusion: "success", steps: [] });
      else withExtra.jobs[0].steps.push({ name: text, status: "completed", conclusion: "success" });
      if (accepted) assert.doesNotThrow(() => verifyRepositoryCiObservation(withExtra, policy, hash, commit));
      else assert.throws(() => verifyRepositoryCiObservation(withExtra, policy, hash, commit), /RELEASE_CI_OBSERVATION_INVALID/);
    }
  };
  check("build", true);
  check("\u00e9tape", true);
  for (const text of ["\u007f", "\u0085", "\u009f", "\u200b", "build\u200b", "\u2028", "\u2029", "\u202e", "\ufeff"]) {
    check(text, false);
  }
});
