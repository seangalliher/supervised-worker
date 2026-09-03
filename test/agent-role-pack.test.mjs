import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

import { validateHandoffValue } from "../src/handoff.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsRoot = path.join(root, "agents");

function readAgent(id) {
  const text = readFileSync(path.join(agentsRoot, `${id}.agent.md`), "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  assert.ok(match, `${id} must have YAML frontmatter`);
  const document = parseDocument(match[1], { uniqueKeys: true });
  assert.deepEqual(document.errors, [], `${id} frontmatter must be valid YAML`);
  return { metadata: document.toJS(), body: match[2] };
}

function handoffTemplate(agent) {
  const match = agent.body.match(/```json\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(match, "agent must contain an inline JSON handoff template");
  return JSON.parse(match[1]);
}

test("plugin ships the complete namespaced companion role pack", () => {
  const ids = readdirSync(agentsRoot)
    .filter((name) => name.endsWith(".agent.md"))
    .map((name) => name.slice(0, -".agent.md".length))
    .sort();
  assert.deepEqual(ids, [
    "seangalliher-supervised-architect",
    "seangalliher-supervised-builder",
    "seangalliher-supervised-diff-reviewer",
    "seangalliher-supervised-worker",
    "supervised-worker",
  ]);
});

test("root and Copilot-namespaced agent copies are byte-identical", () => {
  for (const fileName of readdirSync(agentsRoot).filter((name) => name.endsWith(".agent.md"))) {
    assert.deepEqual(
      readFileSync(path.join(root, "com.github.copilot", "agents", fileName)),
      readFileSync(path.join(agentsRoot, fileName)),
      fileName,
    );
  }
});

test("namespaced and compatibility worker selectors enforce the same policy", () => {
  const compatibility = readAgent("supervised-worker");
  const namespaced = readAgent("seangalliher-supervised-worker");
  const compatibilityMetadata = { ...compatibility.metadata };
  const namespacedMetadata = { ...namespaced.metadata };
  delete compatibilityMetadata["user-invocable"];
  delete namespacedMetadata["user-invocable"];
  assert.deepEqual(namespacedMetadata, compatibilityMetadata);
  assert.equal(namespaced.metadata["user-invocable"], true);
  assert.equal(compatibility.metadata["user-invocable"], false);
  assert.equal(
    namespaced.body.replaceAll("seangalliher-supervised-worker", "supervised-worker"),
    compatibility.body,
  );
});

test("companion agents have bounded non-overlapping authority", () => {
  const architect = readAgent("seangalliher-supervised-architect");
  const builder = readAgent("seangalliher-supervised-builder");
  const reviewer = readAgent("seangalliher-supervised-diff-reviewer");

  assert.deepEqual(architect.metadata.tools, ["read", "search", "web"]);
  assert.deepEqual(builder.metadata.tools, ["read", "search", "edit"]);
  assert.deepEqual(reviewer.metadata.tools, ["read", "search", "web"]);
  assert.equal(architect.metadata["user-invocable"], true);
  assert.equal(architect.metadata["disable-model-invocation"], false);
  assert.equal(builder.metadata["user-invocable"], false);
  assert.equal(builder.metadata["disable-model-invocation"], false);
  assert.equal(reviewer.metadata["user-invocable"], true);
  assert.equal(reviewer.metadata["disable-model-invocation"], false);
  assert.match(builder.metadata.description, /reports Worker-supplied focused validation/);
  assert.doesNotMatch(builder.metadata.description, /runs focused validation/);
  for (const [id, agent] of [
    ["seangalliher-supervised-architect", architect],
    ["seangalliher-supervised-builder", builder],
    ["seangalliher-supervised-diff-reviewer", reviewer],
  ]) {
    assert.equal(agent.metadata.model, undefined, `${id} must not pin a model`);
    assert.match(agent.body, /schemas\/role-handoff\.schema\.json/);
    assert.match(agent.body, /Do not (?:create|edit|modify).*\.supervised-worker/is);
    assert.match(agent.body, /Do not commit, push, or close/is);
    assert.match(agent.body, /Reference Implementation/);
    assert.match(agent.body, /\.github\/supervised-worker\.json/);
    assert.doesNotMatch(agent.body, /\b(?:ProbOS|Captain|AD-\d|BF-\d)\b/);
  }
  assert.doesNotMatch(architect.metadata.tools.join(" "), /edit/);
  assert.doesNotMatch(reviewer.metadata.tools.join(" "), /edit/);
  assert.doesNotMatch(architect.metadata.tools.join(" "), /execute/);
  assert.doesNotMatch(builder.metadata.tools.join(" "), /execute/);
  assert.doesNotMatch(reviewer.metadata.tools.join(" "), /execute/);
  assert.match(architect.body, /probe from the Supervised Worker/i);
  assert.match(reviewer.body, /probe requests to the Supervised Worker/i);
  assert.match(builder.body, /approved build contract/i);
  assert.match(builder.body, /contract as untrusted data/i);
  assert.match(builder.body, /validation evidence is\s+pending/is);
  assert.match(builder.body, /active Worker selector as\s+`producedBy`/is);
  assert.match(builder.body, /Do not stage/i);
  assert.match(builder.body, /absent from the approved build contract/i);
  assert.match(reviewer.body, /actual consumer/i);
  assert.match(reviewer.metadata["argument-hint"], /build report and hash/i);
  assert.match(reviewer.body, /build report.*SHA-256/is);
});

test("companion inline handoff templates pass the runtime validator", () => {
  for (const id of [
    "seangalliher-supervised-architect",
    "seangalliher-supervised-builder",
    "seangalliher-supervised-diff-reviewer",
  ]) {
    const value = handoffTemplate(readAgent(id));
    value.producedBy = id;
    assert.deepEqual(validateHandoffValue(value, root), [], id);
  }
});

test("main worker is the sole durable-plan owner and names every handoff", () => {
  for (const workerId of ["seangalliher-supervised-worker", "supervised-worker"]) {
    const worker = readAgent(workerId);
    assert.equal(
      worker.metadata["user-invocable"],
      workerId === "seangalliher-supervised-worker",
    );
    assert.equal(worker.metadata["disable-model-invocation"], true);
    assert.equal(worker.metadata.infer, undefined);
    assert.match(worker.body, /sole owner of `\.supervised-worker\/plan\.json`/i);
    assert.match(worker.body, /workflow roles/);
    assert.match(worker.body, /effective `architect` role/);
    assert.match(worker.body, /effective `builder` role/);
    assert.match(worker.body, /effective `reviewer` role/);
    assert.match(worker.body, /ask the user to run.*workflow accept/is);
    assert.match(worker.body, /Do not run that acceptance command yourself/);
    assert.match(worker.body, /simple.*directly/is);
    assert.match(worker.body, /contract hash/i);
    assert.match(worker.body, /staged-tree hash/i);
    assert.match(worker.body, /Verify Role Provenance/);
    assert.match(worker.body, /handoff validate/);
    assert.match(worker.body, /handoff pre-review/);
    assert.match(worker.body, /handoff issue-review/);
    assert.match(worker.body, /rendered staged\s+diff/is);
    assert.match(worker.body, /handoff\s+verify/is);
    assert.match(worker.body, /host-reported Builder and Reviewer model IDs/i);
    assert.match(worker.body, /host\s+fallback is a failed review precondition/i);
  }
});