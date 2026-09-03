import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { validateModelReceiptValue } from "../src/handoff.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(path.join(root, "schemas", "model-receipt.schema.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false });
addFormats(ajv);
const validate = ajv.compile(schema);

function receipt() {
  return {
    schemaVersion: 2,
    itemId: "issue-42",
    role: "reviewer",
    agentSelector: "probos-diff-reviewer",
    model: "gpt-5.6-sol",
    family: "openai",
    workflowHash: "a".repeat(64),
    reviewAttemptId: "11111111-1111-4111-8111-111111111111",
    buildReportHash: "c".repeat(64),
    stagedTreeHash: "d".repeat(40),
    observedBy: "supervised-worker:seangalliher-supervised-worker",
    observedAt: "2026-09-02T12:20:00Z",
    host: "vscode",
    sessionHash: "b".repeat(64),
    source: "host",
  };
}

test("host model receipt passes schema and runtime validation", () => {
  const value = receipt();
  assert.equal(validate(value), true, ajv.errorsText(validate.errors));
  assert.deepEqual(validateModelReceiptValue(value), []);
});

test("host model receipt rejects untrusted provenance and malformed fields", () => {
  for (const [label, schemaMustReject, mutate] of [
    ["untrusted observer", false, (value) => { value.observedBy = "probos-diff-reviewer"; }],
    ["self-attested source", true, (value) => { value.source = "self-attested"; }],
    ["unknown host", true, (value) => { value.host = "unknown"; }],
    ["invalid session hash", true, (value) => { value.sessionHash = "not-a-hash"; }],
    ["invalid timestamp", true, (value) => { value.observedAt = "2026-02-30T00:00:00Z"; }],
    ["numeric model", true, (value) => { value.model = 5; }],
    ["numeric family", true, (value) => { value.family = 5; }],
    ["invalid attempt", true, (value) => { value.reviewAttemptId = "not-an-attempt"; }],
    ["invalid build hash", true, (value) => { value.buildReportHash = "not-a-hash"; }],
    ["invalid tree hash", true, (value) => { value.stagedTreeHash = "not-a-tree"; }],
    ["unknown property", true, (value) => { value.extra = true; }],
  ]) {
    const value = receipt();
    mutate(value);
    const schemaValid = validate(value);
    const runtimeErrors = validateModelReceiptValue(value);
    if (schemaMustReject) assert.equal(schemaValid, false, `${label}: schema`);
    assert.ok(runtimeErrors.length > 0, `${label}: runtime`);
  }
});