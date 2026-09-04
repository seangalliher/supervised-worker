import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { canonicalPlanHash, checkpointSession, handleHook, MAX_CHECKPOINT_BYTES, sha256, validateCheckpoint } from "../src/core.mjs";
import {
  validatePluginManifest,
  validateSkillDocument,
  validateStandards,
} from "../src/standards.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture() {
  const target = realpathSync(mkdtempSync(path.join(os.tmpdir(), "supervised-worker-standards-")));
  for (const relativePath of ["agents", "com.github.copilot", "examples", "schemas", "skills"]) {
    cpSync(path.join(root, relativePath), path.join(target, relativePath), { recursive: true });
  }
  cpSync(path.join(root, "hooks.json"), path.join(target, "hooks.json"));
  cpSync(path.join(root, "plugin.json"), path.join(target, "plugin.json"));
  return target;
}

function mutateJson(rootPath, relativePath, mutate) {
  const filePath = path.join(rootPath, relativePath);
  const value = JSON.parse(readFileSync(filePath, "utf8"));
  mutate(value);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("published plugin, skill, schemas, examples, and safety gates conform", () => {
  assert.deepEqual(validateStandards(root), []);
});

test("checkpoint runtime and published schema accept producer artifacts and reject untyped fields", () => {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "supervised-worker-checkpoint-schema-")));
  try {
    const state = path.join(cwd, ".supervised-worker");
    mkdirSync(state);
    const planFile = path.join(state, "plan.json");
    const plan = { schemaVersion: 1, mode: "active", goal: "Fixture", items: [{ id: "one", title: "One", status: "pending" }], completion: null };
    writeFileSync(planFile, JSON.stringify(plan));
    assert.deepEqual(handleHook({ cwd, session_id: "schema-source", tool_name: "Write", tool_input: { file_path: planFile } }, "PostToolUse"), {});
    const checkpoint = checkpointSession(cwd, { session_id: "schema-source", planHash: canonicalPlanHash(plan), attachmentHash: sha256(readFileSync(path.join(state, "attachment.json"))) });
    const artifact = JSON.parse(readFileSync(path.join(state, "checkpoints", `${checkpoint.checkpointHash}.json`)));
    const ajv = new Ajv2020({ allErrors: true, strictTypes: false, strictRequired: false });
    addFormats(ajv);
    const schema = ajv.compile(JSON.parse(readFileSync(path.join(root, "schemas", "checkpoint.schema.json"))));
    assert.equal(schema(artifact), true, JSON.stringify(schema.errors));
    assert.deepEqual(validateCheckpoint(artifact), []);
    for (const mutate of [
      (value) => { value.raw = "PRIVATE_CONTENT"; },
      (value) => { value.context.continuation = "PRIVATE_CONTENT"; },
      (value) => { value.sessionHash = [value.sessionHash]; },
      (value) => { value.claimGeneration = [value.claimGeneration]; },
      (value) => { value.checkpointId = [value.checkpointId]; },
      (value) => { value.createdAt = "2026-02-30T00:00:00.000Z"; },
      (value) => { value.ledgerPosition.path = "../outside.jsonl"; },
      (value) => { value.ledgerPosition.byteOffset = -1; },
      (value) => { value.context.counts.pending = "1"; },
      (value) => { value.context.itemHashes.push(value.context.itemHashes[0]); },
      (value) => { value.context.stopState = { raw: "PRIVATE_CONTENT" }; },
      (value) => { value.context.operations.status = "unavailable"; },
    ]) {
      const invalid = structuredClone(artifact);
      mutate(invalid);
      assert.equal(schema(invalid), false, JSON.stringify(invalid));
      assert.ok(validateCheckpoint(invalid).length > 0);
      assert.doesNotMatch(validateCheckpoint(invalid).join("\n"), /PRIVATE_CONTENT/);
    }
    const oversized = { ...artifact, padding: "x".repeat(MAX_CHECKPOINT_BYTES) };
    assert.match(validateCheckpoint(oversized).join("\n"), /size limit/);
    for (const value of [null, [], {}, undefined]) assert.ok(validateCheckpoint(value).length > 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("standards registration detects a missing or weakened checkpoint schema", () => {
  const target = fixture();
  try {
    mutateJson(target, "schemas/checkpoint.schema.json", (schema) => {
      schema.properties.context.additionalProperties = true;
    });
    assert.match(validateStandards(target).join("\n"), /checkpoint schema accepted unsafe state/);
    rmSync(path.join(target, "schemas", "checkpoint.schema.json"));
    assert.match(validateStandards(target).join("\n"), /expected exactly these published schemas/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("plugin validation rejects undeclared manifest fields", () => {
  const plugin = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8"));
  assert.match(
    validatePluginManifest({ ...plugin, undeclared: true }).join("\n"),
    /unknown property: undeclared/,
  );
});

test("skill validation rejects nonportable frontmatter fields", () => {
  const original = readFileSync(
    path.join(root, "skills", "governed-queue", "SKILL.md"),
    "utf8",
  );
  const text = original.replace(
    /(description:.*\r?\n)/,
    "$1user-invocable: true\n",
  );
  assert.notEqual(text, original, "the nonportable-field mutant must be active");
  assert.match(validateSkillDocument(text, "governed-queue").join("\n"), /unsupported field/);
});

test("standards validation rejects an invalid Draft 2020-12 schema", () => {
  const target = fixture();
  try {
    mutateJson(target, "schemas/episode.schema.json", (schema) => {
      schema.type = "not-a-json-schema-type";
    });
    assert.match(validateStandards(target).join("\n"), /schemas\/episode\.schema\.json/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("standards validation detects weakened policy approval gates", () => {
  const target = fixture();
  try {
    mutateJson(target, "schemas/policy-proposal.schema.json", (schema) => {
      delete schema.allOf;
    });
    assert.match(validateStandards(target).join("\n"), /accepted unsafe state/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("standards validation detects optional independent review", () => {
  const target = fixture();
  try {
    mutateJson(target, "schemas/workflow.schema.json", (schema) => {
      schema.properties.review.properties.required = { type: "boolean" };
      schema.properties.review.properties.independent = { type: "boolean" };
    });
    assert.match(
      validateStandards(target).join("\n"),
      /workflow schema accepted unsafe state: review/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("standards validation detects weakened local campaign provider facts", () => {
  const target = fixture();
  try {
    mutateJson(target, "schemas/local-campaign-receipt.schema.json", (schema) => {
      schema.$defs.providerFact.properties.value = {};
    });
    assert.match(
      validateStandards(target).join("\n"),
      /local campaign receipt schema accepted unsafe state: non-null provider fact/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("standards validation detects local campaign aggregate drift", () => {
  const target = fixture();
  try {
    mutateJson(target, "examples/local-campaign-receipt.json", (receipt) => {
      receipt.runLedger.eventCounts[0].count += 1;
    });
    assert.match(
      validateStandards(target).join("\n"),
      /event counts must total recordCount/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("workflow accepts specialized role selectors", () => {
  const target = fixture();
  try {
    mutateJson(target, "examples/workflow.json", (workflow) => {
      workflow.roles = {
        architect: "architect",
        builder: "builder",
        reviewer: "diff-reviewer",
      };
      workflow.review.agent = "diff-reviewer";
    });
    assert.deepEqual(validateStandards(target), []);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("workflow rejects incomplete or unsafe role selectors", () => {
  for (const mutate of [
    (workflow) => { delete workflow.roles.builder; },
    (workflow) => { workflow.roles.reviewer = " reviewer"; },
    (workflow) => { workflow.roles.extra = "extra-agent"; },
  ]) {
    const target = fixture();
    try {
      mutateJson(target, "examples/workflow.json", mutate);
      assert.match(validateStandards(target).join("\n"), /examples\/workflow\.json/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

test("workflow schema and runtime both reject blank contract strings", () => {
  for (const mutate of [
    (workflow) => { workflow.tracker.scope = "   "; },
    (workflow) => { workflow.authority.boundaries = [" "]; },
    (workflow) => { workflow.validation.focused = "\t"; },
    (workflow) => { workflow.validation.receiptGlobs = [" "]; },
    (workflow) => { workflow.tracker.scope = "💩a"; },
  ]) {
    const target = fixture();
    try {
      mutateJson(target, "examples/workflow.json", mutate);
      assert.match(validateStandards(target).join("\n"), /examples\/workflow\.json/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

test("standards validation rejects drift in Copilot extension copies", () => {
  const target = fixture();
  try {
    const copy = path.join(
      target,
      "com.github.copilot",
      "agents",
      "seangalliher-supervised-worker.agent.md",
    );
    writeFileSync(copy, `${readFileSync(copy, "utf8")}\nDrift.\n`);
    assert.match(validateStandards(target).join("\n"), /differs from agents/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("standards validation rejects drift in the Copilot hook manifest", () => {
  const target = fixture();
  try {
    const copy = path.join(target, "com.github.copilot", "hooks", "hooks.json");
    writeFileSync(copy, `${readFileSync(copy, "utf8")}\n`);
    assert.match(validateStandards(target).join("\n"), /hooks\.json differs from hooks\.json/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});