import assert from "node:assert/strict";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  acceptWorkflowRoles,
  DEFAULT_ROLES,
  parseWorkflowJson,
  resolveWorkflowRoles,
  validateWorkflowValue,
  WORKFLOW_ACCEPTANCE_PATH,
  WORKFLOW_CONFIG_PATH,
} from "../src/workflow.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function workspace() {
  return mkdtempSync(path.join(os.tmpdir(), "supervised-worker-workflow-"));
}

function example() {
  return JSON.parse(readFileSync(path.join(root, "examples", "workflow.json"), "utf8"));
}

function writeWorkflow(cwd, value) {
  const filePath = path.join(cwd, ...WORKFLOW_CONFIG_PATH.split("/"));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

test("role resolution uses bundled reference agents when repository config is absent", () => {
  const cwd = workspace();
  try {
    assert.deepEqual(resolveWorkflowRoles(cwd), {
      ok: true,
      source: "bundled-defaults",
      configured: false,
      requiresAcceptance: false,
      workflowHash: null,
      accepted: true,
      roles: { ...DEFAULT_ROLES },
      errors: [],
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("role resolution returns specialized repository selectors", () => {
  const cwd = workspace();
  try {
    const workflow = example();
    workflow.roles = {
      architect: "architect",
      builder: "builder",
      reviewer: "diff-reviewer",
    };
    workflow.review.agent = "diff-reviewer";
    writeWorkflow(cwd, workflow);
    const result = resolveWorkflowRoles(cwd);
    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.equal(result.source, WORKFLOW_CONFIG_PATH);
    assert.equal(result.requiresAcceptance, true);
    assert.equal(result.accepted, false);
    assert.match(result.workflowHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.roles, workflow.roles);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("legacy review agent overrides only the default reviewer", () => {
  const cwd = workspace();
  try {
    const workflow = example();
    delete workflow.roles;
    workflow.review.agent = "specialized-reviewer";
    writeWorkflow(cwd, workflow);
    assert.deepEqual(resolveWorkflowRoles(cwd).roles, {
      ...DEFAULT_ROLES,
      reviewer: "specialized-reviewer",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("conflicting reviewer selectors fail closed", () => {
  const workflow = example();
  workflow.review.agent = "different-reviewer";
  assert.match(validateWorkflowValue(workflow).join("\n"), /must match/);
});

test("companion role selectors are distinct and cannot impersonate the Worker", () => {
  const duplicate = example();
  duplicate.roles.builder = duplicate.roles.architect;
  assert.match(validateWorkflowValue(duplicate).join("\n"), /three distinct agents/);

  const workerRole = example();
  workerRole.roles.architect = "seangalliher-supervised-worker";
  assert.match(validateWorkflowValue(workerRole).join("\n"), /cannot identify/);
});

test("invalid repository workflow does not fall back to reference roles", () => {
  const cwd = workspace();
  try {
    const workflow = example();
    workflow.review.required = false;
    writeWorkflow(cwd, workflow);
    const result = resolveWorkflowRoles(cwd);
    assert.equal(result.ok, false);
    assert.equal(result.roles, null);
    assert.match(result.errors.join("\n"), /review.required/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("redirected and hard-linked workflow files are rejected", () => {
  const cwd = workspace();
  const outside = workspace();
  try {
    const configPath = writeWorkflow(outside, example());
    const githubPath = path.join(cwd, ".github");
    symlinkSync(path.dirname(configPath), githubPath, process.platform === "win32" ? "junction" : "dir");
    assert.match(resolveWorkflowRoles(cwd).errors.join("\n"), /workflow directory/);
    rmSync(githubPath, { recursive: true, force: true });
    const localConfig = writeWorkflow(cwd, example());
    linkSync(localConfig, path.join(outside, "workflow-hardlink.json"));
    assert.match(resolveWorkflowRoles(cwd).errors.join("\n"), /multiple hard links/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("dangling workflow link fails closed instead of selecting defaults", () => {
  const cwd = workspace();
  try {
    const filePath = path.join(cwd, ...WORKFLOW_CONFIG_PATH.split("/"));
    const target = path.join(cwd, "workflow-link-target");
    mkdirSync(path.dirname(filePath), { recursive: true });
    mkdirSync(target);
    symlinkSync(target, filePath, process.platform === "win32" ? "junction" : "dir");
    rmSync(target, { recursive: true, force: true });
    const result = resolveWorkflowRoles(cwd);
    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.match(result.errors.join("\n"), /symbolic link or junction/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow acceptance hash changes with the configured bytes", () => {
  const cwd = workspace();
  try {
    const workflow = example();
    writeWorkflow(cwd, workflow);
    const first = resolveWorkflowRoles(cwd);
    workflow.tracker.scope = "specialized/repository";
    writeWorkflow(cwd, workflow);
    const second = resolveWorkflowRoles(cwd);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.workflowHash, second.workflowHash);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("legacy reviewer alias cannot collapse role independence", () => {
  const workflow = example();
  delete workflow.roles;
  workflow.review.agent = DEFAULT_ROLES.architect;
  assert.match(validateWorkflowValue(workflow).join("\n"), /three distinct agents/);
});

test("configured roles require exact hash acceptance and invalidate on byte changes", () => {
  const cwd = workspace();
  try {
    writeWorkflow(cwd, example());
    const initial = resolveWorkflowRoles(cwd);
    assert.equal(initial.ok, true);
    assert.equal(initial.accepted, false);
    assert.equal(resolveWorkflowRoles(cwd, { requireAcceptance: true }).ok, false);
    assert.equal(acceptWorkflowRoles(cwd, "0".repeat(64)).ok, false);

    const accepted = acceptWorkflowRoles(cwd, initial.workflowHash);
    assert.equal(accepted.ok, true, accepted.errors.join("\n"));
    assert.equal(accepted.accepted, true);
    assert.equal(resolveWorkflowRoles(cwd, { requireAcceptance: true }).ok, true);

    const filePath = path.join(cwd, ...WORKFLOW_CONFIG_PATH.split("/"));
    writeFileSync(filePath, `${readFileSync(filePath, "utf8")}\n`);
    const changed = resolveWorkflowRoles(cwd);
    assert.equal(changed.ok, true);
    assert.equal(changed.accepted, false);
    assert.equal(resolveWorkflowRoles(cwd, { requireAcceptance: true }).ok, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow parser rejects invalid UTF-8 and duplicate object keys", () => {
  assert.throws(() => parseWorkflowJson(Buffer.from([0xc3, 0x28])), /encoded data|encoding/i);
  assert.throws(
    () => parseWorkflowJson(Buffer.from('{"roles":{"architect":"a","architect":"b"}}')),
    /duplicate object key: architect/,
  );
});

test("resolver rejects malformed authority bytes at the fixed repository path", () => {
  const cwd = workspace();
  try {
    const filePath = writeWorkflow(cwd, example());
    writeFileSync(filePath, Buffer.from([0xc3, 0x28]));
    assert.equal(resolveWorkflowRoles(cwd).ok, false);

    const text = JSON.stringify(example());
    const duplicate = text.replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    );
    assert.notEqual(duplicate, text, "duplicate-key fixture must be active");
    writeFileSync(filePath, duplicate);
    assert.match(resolveWorkflowRoles(cwd).errors.join("\n"), /duplicate object key/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("invalid or hard-linked acceptance state fails closed", () => {
  const cwd = workspace();
  const outside = workspace();
  try {
    writeWorkflow(cwd, example());
    const hash = resolveWorkflowRoles(cwd).workflowHash;
    assert.equal(acceptWorkflowRoles(cwd, hash).ok, true);
    const filePath = path.join(cwd, ...WORKFLOW_ACCEPTANCE_PATH.split("/"));
    const accepted = JSON.parse(readFileSync(filePath, "utf8"));
    writeFileSync(
      filePath,
      `{"schemaVersion":1,"workflowHash":"${accepted.workflowHash}",` +
        `"workflowHash":"${accepted.workflowHash}","acceptedAt":"${accepted.acceptedAt}"}`,
    );
    assert.match(resolveWorkflowRoles(cwd).errors.join("\n"), /duplicate object key/);

    assert.equal(acceptWorkflowRoles(cwd, hash).ok, true);
    linkSync(filePath, path.join(outside, "acceptance-hardlink.json"));
    assert.match(resolveWorkflowRoles(cwd).errors.join("\n"), /safe regular file/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("acceptance rejects impossible calendar timestamps", () => {
  const cwd = workspace();
  try {
    writeWorkflow(cwd, example());
    const hash = resolveWorkflowRoles(cwd).workflowHash;
    assert.equal(acceptWorkflowRoles(cwd, hash).ok, true);
    const filePath = path.join(cwd, ...WORKFLOW_ACCEPTANCE_PATH.split("/"));
    const value = JSON.parse(readFileSync(filePath, "utf8"));
    value.acceptedAt = "2026-02-30T00:00:00Z";
    writeFileSync(filePath, `${JSON.stringify(value)}\n`);
    assert.match(resolveWorkflowRoles(cwd).errors.join("\n"), /acceptance record is invalid/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("acceptance replacement leaves no temporary file and uses private POSIX mode", () => {
  const cwd = workspace();
  try {
    const workflowPath = writeWorkflow(cwd, example());
    const firstHash = resolveWorkflowRoles(cwd).workflowHash;
    assert.equal(acceptWorkflowRoles(cwd, firstHash).ok, true);
    const acceptancePath = path.join(cwd, ...WORKFLOW_ACCEPTANCE_PATH.split("/"));

    const workflow = JSON.parse(readFileSync(workflowPath, "utf8"));
    workflow.tracker.scope = "changed/repository";
    writeWorkflow(cwd, workflow);
    const secondHash = resolveWorkflowRoles(cwd).workflowHash;
    assert.notEqual(firstHash, secondHash);
    assert.equal(acceptWorkflowRoles(cwd, secondHash).ok, true);

    assert.equal(JSON.parse(readFileSync(acceptancePath, "utf8")).workflowHash, secondHash);
    assert.deepEqual(
      readdirSync(path.dirname(acceptancePath)).filter((name) => name.endsWith(".tmp")),
      [],
    );
    if (process.platform !== "win32") {
      assert.equal(lstatSync(acceptancePath).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow string lengths count Unicode code points like JSON Schema", () => {
  const workflow = example();
  workflow.tracker.scope = "💩a";
  assert.match(validateWorkflowValue(workflow).join("\n"), /at least 3 characters/);
});

test("reachable and dangling linked workflow parents fail closed", () => {
  for (const dangling of [false, true]) {
    const cwd = workspace();
    const outside = workspace();
    try {
      symlinkSync(outside, path.join(cwd, ".github"), process.platform === "win32" ? "junction" : "dir");
      if (dangling) rmSync(outside, { recursive: true, force: true });
      const result = resolveWorkflowRoles(cwd);
      assert.equal(result.ok, false);
      assert.equal(result.configured, true);
      assert.match(result.errors.join("\n"), /workflow directory/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});