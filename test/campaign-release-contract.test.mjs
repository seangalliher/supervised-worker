import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schema = JSON.parse(readFileSync(new URL("../schemas/campaign-release.schema.json", import.meta.url)));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const hash = "a".repeat(64);
const candidate = { commit: "a".repeat(40), tree: "b".repeat(40), baseCommit: "c".repeat(40), ref: "refs/heads/main" };
const input = { schemaVersion: 1, kind: "campaign-release-input", candidate,
  artifacts: [{ role: "plan", reference: { locator: ".supervised-worker/plan.json", sha256: hash } }], doctorInventoryHash: hash };

test("canonical release input accepts only bounded typed references", () => {
  assert.equal(validate(input), true, JSON.stringify(validate.errors));
  for (const mutation of [
    (value) => { value.rawPrompt = "private"; },
    (value) => { value.candidate.commit = "main"; },
    (value) => { value.artifacts[0].reference.sha256 = "unbound"; },
    (value) => { value.artifacts[0].reference.locator = "../outside.json"; },
    (value) => { value.artifacts[0].role = "shell"; },
    (value) => { value.artifacts = []; },
  ]) {
    const changed = structuredClone(input);
    mutation(changed);
    assert.equal(validate(changed), false);
  }
});

test("receipt authority and provider completion cannot be upgraded by schema input", () => {
  const names = ["plan", "checkpoint", "local-receipt", "queue-start", "queue-final", "handoff", "models", "commit", "ref", "remote", "ci", "closures", "recovery", "provider-verification"];
  const receipt = { schemaVersion: 1, kind: "campaign-release-receipt", scope: "compiled-local-evidence", inputHash: hash,
    candidate, planHash: hash, itemHash: null, workflowHash: null,
    facts: names.map((name) => ({ name, status: "unavailable", provenance: "unavailable", references: [] })),
    doctor: { status: "inapplicable", provenance: "inapplicable", inventoryHash: hash, incidents: [], references: [] },
    dispositions: { item: "inapplicable", hostSession: "unavailable", campaign: "incomplete", doctor: "inapplicable", provider: "unavailable" },
    timing: { status: "unavailable", provenance: "unavailable", basis: "measured-activity-durations-not-wall-time", durationsMs: null, references: [] },
    authority: { grantsPermissions: false, satisfiesStop: false, providerSealed: false } };
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
  for (const field of Object.keys(receipt.authority)) assert.equal(validate({ ...receipt, authority: { ...receipt.authority, [field]: true } }), false);
  assert.equal(validate({ ...receipt, dispositions: { ...receipt.dispositions, provider: "verified-complete" } }), false);
  for (const value of [null, [], {}, "", { ...input, schemaVersion: 2 }]) assert.equal(validate(value), false);
});