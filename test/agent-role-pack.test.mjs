import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

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

test("plugin ships the complete namespaced companion role pack", () => {
  const ids = readdirSync(agentsRoot)
    .filter((name) => name.endsWith(".agent.md"))
    .map((name) => name.slice(0, -".agent.md".length))
    .sort();
  assert.deepEqual(ids, [
    "seangalliher-supervised-architect",
    "seangalliher-supervised-builder",
    "seangalliher-supervised-diff-reviewer",
    "supervised-worker",
  ]);
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
  for (const [id, agent] of [
    ["seangalliher-supervised-architect", architect],
    ["seangalliher-supervised-builder", builder],
    ["seangalliher-supervised-diff-reviewer", reviewer],
  ]) {
    assert.equal(agent.metadata.model, undefined, `${id} must not pin a model`);
    assert.match(agent.body, /\.\.\/schemas\/role-handoff\.schema\.json/);
    assert.match(agent.body, /Do not (?:create|edit|modify).*\.supervised-worker/is);
    assert.match(agent.body, /Do not commit, push, or close/is);
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
  assert.match(builder.body, /producedBy: "supervised-worker"/);
  assert.match(builder.body, /Do not stage/i);
  assert.match(builder.body, /absent from the approved build contract/i);
  assert.match(reviewer.body, /actual consumer/i);
  assert.match(reviewer.metadata["argument-hint"], /build report and hash/i);
  assert.match(reviewer.body, /build report.*SHA-256/is);
});

test("main worker is the sole durable-plan owner and names every handoff", () => {
  const worker = readAgent("supervised-worker");
  assert.equal(worker.metadata["user-invocable"], true);
  assert.equal(worker.metadata["disable-model-invocation"], true);
  assert.equal(worker.metadata.infer, undefined);
  assert.match(worker.body, /sole owner of `\.supervised-worker\/plan\.json`/i);
  for (const id of [
    "seangalliher-supervised-architect",
    "seangalliher-supervised-builder",
    "seangalliher-supervised-diff-reviewer",
  ]) {
    assert.match(worker.body, new RegExp(`\\b${id}\\b`));
  }
  assert.match(worker.body, /simple.*directly/is);
  assert.match(worker.body, /contract hash/i);
  assert.match(worker.body, /staged-tree hash/i);
  assert.match(worker.body, /Verify Role Provenance/);
  assert.match(worker.body, /handoff validate/);
  assert.match(worker.body, /handoff pre-review/);
  assert.match(worker.body, /rendered staged\s+diff/is);
  assert.match(worker.body, /handoff\s+verify/is);
});