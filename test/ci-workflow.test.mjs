import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseDocument } from "yaml";

import { validateDoctorMatrix } from "../src/doctor-promotion.mjs";

function workflow() {
  const document = parseDocument(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"), { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  return document.toJS();
}

test("routine CI is Windows-only while tags and explicit full dispatch retain every platform", () => {
  const value = workflow();
  assert.ok(Object.hasOwn(value.on, "push"));
  assert.ok(Object.hasOwn(value.on, "pull_request"));
  assert.deepEqual(value.on.workflow_dispatch.inputs.profile, {
    description: "Validation scope", type: "choice", options: ["windows", "full"], default: "windows",
  });
  assert.equal(value.jobs.test.strategy.matrix.os,
    '${{ fromJSON((github.ref_type == \'tag\' || inputs.profile == \'full\') && \'["ubuntu-latest","macos-latest","windows-latest"]\' || \'["windows-latest"]\') }}');
});

test("both CI profiles retain supported Node versions and complete test and validation commands", () => {
  const job = workflow().jobs.test;
  assert.deepEqual(job.strategy.matrix.node, [20, 22, 24]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job["runs-on"], "${{ matrix.os }}");
  assert.deepEqual(job.steps.filter((step) => step.run).map((step) => step.run), ["npm ci", "npm test", "npm run validate"]);
  for (const step of job.steps.filter((entry) => entry.uses)) assert.match(step.uses, /@[0-9a-f]{40}$/);
});

test("Windows-only CI evidence cannot satisfy strict Doctor promotion", () => {
  const commit = "a".repeat(40);
  const observation = { complete: true, commit, runId: 1, conclusion: "success",
    jobs: [20, 22, 24].map((version) => ({ name: `test (windows-latest, ${version})`, commit,
      conclusion: "success", steps: ["npm test", "npm run validate"].map((command) => ({
        name: `Run ${command}`, status: "completed", conclusion: "success",
      })) })),
  };
  assert.throws(() => validateDoctorMatrix(observation, commit), /DOCTOR_CI_UNCONFIRMED/);
});