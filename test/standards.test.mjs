import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  validatePluginManifest,
  validateSkillDocument,
  validateStandards,
} from "../src/standards.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture() {
  const target = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-standards-"));
  for (const relativePath of ["examples", "schemas", "skills"]) {
    cpSync(path.join(root, relativePath), path.join(target, relativePath), { recursive: true });
  }
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