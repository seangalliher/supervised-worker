import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validatePlan } from "../src/core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(path.join(root, "schemas", "plan.schema.json"), "utf8"),
);

function validActive() {
  return {
    schemaVersion: 1,
    mode: "active",
    goal: "Complete queue",
    items: [{ id: "one", title: "One", status: "pending" }],
    completion: null,
  };
}

function validComplete() {
  return {
    schemaVersion: 1,
    mode: "complete",
    goal: "Complete queue",
    items: [{ id: "one", title: "One", status: "banked" }],
    completion: {
      enumeration: {
        status: "complete",
        source: "Authenticated GitHub",
        checkedAt: "2024-02-29T00:00:00Z",
        remainingActionable: 0,
      },
      evidence: [{ kind: "gate", locator: "receipt" }],
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

const cases = [
  ["valid active", validActive(), true],
  ["valid complete", validComplete(), true],
  ["blank goal", { ...validActive(), goal: " " }, false],
  ["blank id", { ...validActive(), items: [{ id: " ", title: "One", status: "pending" }] }, false],
  ["blank title", { ...validActive(), items: [{ id: "one", title: " ", status: "pending" }] }, false],
  ["numeric resumeWhen", { ...validActive(), items: [{ id: "one", title: "One", status: "pending", resumeWhen: 42 }] }, false],
  ["duplicate item", { ...validActive(), items: [validActive().items[0], validActive().items[0]] }, false],
  ["unknown top property", { ...validActive(), extra: true }, false],
  ["active completion", { ...validActive(), completion: validComplete().completion }, false],
  ["complete pending", { ...validComplete(), items: validActive().items }, false],
  ["lowercase timestamp", (() => { const value = clone(validComplete()); value.completion.enumeration.checkedAt = "2024-02-29t00:00:00z"; return value; })(), false],
  ["non-leap date", (() => { const value = clone(validComplete()); value.completion.enumeration.checkedAt = "2025-02-29T00:00:00Z"; return value; })(), false],
  ["short-month overflow", (() => { const value = clone(validComplete()); value.completion.enumeration.checkedAt = "2026-04-31T00:00:00Z"; return value; })(), false],
  ["blank source", (() => { const value = clone(validComplete()); value.completion.enumeration.source = " "; return value; })(), false],
  ["blank evidence kind", (() => { const value = clone(validComplete()); value.completion.evidence[0].kind = " "; return value; })(), false],
  ["blank evidence locator", (() => { const value = clone(validComplete()); value.completion.evidence[0].locator = " "; return value; })(), false],
];

function schemaStructuralValidity(plan) {
  const textPatterns = {
    goal: new RegExp(schema.properties.goal.pattern),
    id: new RegExp(schema.properties.items.items.properties.id.pattern),
    title: new RegExp(schema.properties.items.items.properties.title.pattern),
    resumeWhen: new RegExp(schema.properties.items.items.properties.resumeWhen.pattern),
    checkedAt: new RegExp(
      schema.properties.completion.oneOf[1].properties.enumeration.properties.checkedAt.pattern,
    ),
    source: new RegExp(
      schema.properties.completion.oneOf[1].properties.enumeration.properties.source.pattern,
    ),
    kind: new RegExp(schema.$defs.evidenceRef.properties.kind.pattern),
    locator: new RegExp(schema.$defs.evidenceRef.properties.locator.pattern),
  };
  if (Object.keys(plan).some((key) => !["schemaVersion", "mode", "goal", "items", "completion"].includes(key))) return false;
  if (plan.schemaVersion !== 1 || !["active", "complete", "inactive"].includes(plan.mode)) return false;
  if (typeof plan.goal !== "string" || !textPatterns.goal.test(plan.goal)) return false;
  if (!Array.isArray(plan.items)) return false;
  if (new Set(plan.items.map((item) => JSON.stringify(item))).size !== plan.items.length) return false;
  for (const item of plan.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    if (Object.keys(item).some((key) => !["id", "title", "status", "resumeWhen"].includes(key))) return false;
    if (typeof item.id !== "string" || !textPatterns.id.test(item.id)) return false;
    if (typeof item.title !== "string" || !textPatterns.title.test(item.title)) return false;
    if (!["pending", "in_progress", "banked", "parked"].includes(item.status)) return false;
    if (item.resumeWhen !== undefined && (typeof item.resumeWhen !== "string" || !textPatterns.resumeWhen.test(item.resumeWhen))) return false;
    if (item.status === "parked" && item.resumeWhen === undefined) return false;
  }
  if (plan.mode !== "complete") return plan.completion === null;
  if (plan.items.some((item) => ["pending", "in_progress"].includes(item.status))) return false;
  const completion = plan.completion;
  if (!completion || typeof completion !== "object" || Array.isArray(completion)) return false;
  if (Object.keys(completion).some((key) => !["enumeration", "evidence"].includes(key))) return false;
  const enumeration = completion.enumeration;
  if (!enumeration || typeof enumeration !== "object" || Array.isArray(enumeration)) return false;
  if (Object.keys(enumeration).some((key) => !["status", "source", "checkedAt", "remainingActionable"].includes(key))) return false;
  if (enumeration.status !== "complete" || enumeration.remainingActionable !== 0) return false;
  if (typeof enumeration.source !== "string" || !textPatterns.source.test(enumeration.source)) return false;
  if (typeof enumeration.checkedAt !== "string" || !textPatterns.checkedAt.test(enumeration.checkedAt)) return false;
  if (!Array.isArray(completion.evidence) || completion.evidence.length === 0) return false;
  return completion.evidence.every((entry) =>
    entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    !Object.keys(entry).some((key) => !["kind", "locator", "sha256"].includes(key)) &&
    typeof entry.kind === "string" && textPatterns.kind.test(entry.kind) &&
    typeof entry.locator === "string" && textPatterns.locator.test(entry.locator) &&
    (entry.sha256 === undefined || /^[0-9a-f]{64}$/.test(entry.sha256)),
  );
}

test("runtime and published schema agree on the contract matrix", () => {
  for (const [name, plan, expected] of cases) {
    const runtimeValid = validatePlan(plan).length === 0;
    const schemaValid = schemaStructuralValidity(plan);
    assert.equal(runtimeValid, expected, `${name}: runtime`);
    assert.equal(schemaValid, expected, `${name}: schema`);
    assert.equal(runtimeValid, schemaValid, `${name}: parity`);
  }
});