import assert from "node:assert/strict";
import fs from "node:fs";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import { requireVerifiedWorkerAuthority, verifyWorkerAuthority } from "../src/authority.mjs";
import { applyCampaignPlan, canonicalPlanHash, handlePluginHook, issueRescueCapability, observeCampaignTransition, releaseAttachment, rescueLifecycle, resumeSession, sha256, summarizeRunLedger } from "../src/core.mjs";
import { installLocalPlugin } from "../src/install.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

export function withAuthorityFixture(action) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "supervised-worker-authority-")));
  try {
    const cwd = path.join(base, "repo");
    mkdirSync(cwd);
    const { installRoot } = installLocalPlugin(sourceRoot, { baseDirectory: path.join(base, "fixture-install") });
    const input = { cwd, session_id: "authorized-worker" };
    const workerPath = path.join(installRoot, "com.github.copilot", "agents", "seangalliher-supervised-worker.agent.md");
    const hookPath = path.join(installRoot, "com.github.copilot", "hooks", "hooks.json");
    const now = Date.now();
    const inventory = {
      schemaVersion: 1, kind: "worker-host-authority", host: "vscode", complete: true,
      sessionHash: sha256(input.session_id), repositoryHash: sha256(process.platform === "win32" ? cwd.toLowerCase() : cwd),
      processId: process.pid, issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
      workers: [{ path: workerPath, hash: sha256(readFileSync(workerPath)) }],
      hooks: [{ path: hookPath, hash: sha256(readFileSync(hookPath)) }],
    };
    const inventoryPath = path.join(base, "host-authority.json");
    writeFileSync(inventoryPath, JSON.stringify(inventory));
    return action({ base, cwd, input, installRoot, inventory, inventoryPath });
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("Worker authority verifies the immutable selected sources and a single host authority", () => {
  withAuthorityFixture(({ cwd, input, installRoot, inventoryPath }) => {
    const authority = verifyWorkerAuthority(cwd, input, installRoot, inventoryPath);
    assert.match(authority.grantHash, /^[0-9a-f]{64}$/);
    assert.doesNotThrow(() => requireVerifiedWorkerAuthority(authority, cwd, input));
    assert.throws(() => requireVerifiedWorkerAuthority({ ...authority }, cwd, input), /verified/);
    assert.throws(() => requireVerifiedWorkerAuthority(authority, cwd, { ...input, session_id: "ordinary" }), /session-bound/);
  });
});

test("Worker startup rejects checkout, absent, competing, expired, and mismatched authorities", () => {
  withAuthorityFixture(({ cwd, input, installRoot, inventory, inventoryPath }) => {
    assert.throws(() => verifyWorkerAuthority(cwd, input, sourceRoot, inventoryPath), /immutable/);
    assert.throws(() => verifyWorkerAuthority(cwd, input, installRoot, ""), /unavailable/);
    for (const invalid of [
      { ...inventory, complete: false },
      { ...inventory, workers: [...inventory.workers, inventory.workers[0]] },
      { ...inventory, hooks: [...inventory.hooks, inventory.hooks[0]] },
      { ...inventory, sessionHash: sha256("other-session") },
      { ...inventory, repositoryHash: sha256("other-repository") },
      { ...inventory, expiresAt: inventory.issuedAt },
      { ...inventory, workers: [{ ...inventory.workers[0], path: path.join(cwd, ".github", "agents", "supervised-worker.agent.md") }] },
      { ...inventory, hooks: [{ ...inventory.hooks[0], hash: sha256("legacy") }] },
    ]) {
      writeFileSync(inventoryPath, JSON.stringify(invalid));
      assert.throws(() => verifyWorkerAuthority(cwd, input, installRoot, inventoryPath));
    }
  });
});

test("production hooks require a verified session grant and plans use exact CAS publication", () => {
  withAuthorityFixture(({ cwd, input, installRoot, inventoryPath }) => {
    const previousInventory = process.env.SUPERVISED_WORKER_HOST_AUTHORITY;
    process.env.SUPERVISED_WORKER_HOST_AUTHORITY = inventoryPath;
    try {
      const plan = { schemaVersion: 1, mode: "active", goal: "Complete the selected queue.",
        items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
      const authority = verifyWorkerAuthority(cwd, input, installRoot, inventoryPath);
      const expected = observeCampaignTransition(cwd, input);
      const write = { ...input, tool_name: "Write", tool_input: { file_path: path.join(cwd, ".supervised-worker", "plan.json") } };
      assert.equal(handlePluginHook(write, "PreToolUse", installRoot).permissionDecision, "deny");
      assert.deepEqual(observeCampaignTransition(cwd, input), expected);
      const result = applyCampaignPlan(cwd, { session_id: input.session_id, expected, plan }, authority);
      assert.equal(result.status, "applied");
      assert.equal(result.observation.state, "active");
      const policyEdit = { ...input, tool_name: "Write", tool_use_id: "denied-policy-edit",
        tool_input: { file_path: path.join(cwd, ".github", "supervised-worker.json") } };
      assert.equal(handlePluginHook(policyEdit, "PreToolUse", installRoot).permissionDecision, "deny");
      const ledger = path.join(cwd, ".supervised-worker", "runs", `${sha256(input.session_id)}.jsonl`);
      assert.equal(JSON.parse(readFileSync(ledger, "utf8").trim().split("\n").at(-1)).event, "tool_denied");
      assert.equal(handlePluginHook(input, "Stop", installRoot).decision, "block");
      assert.deepEqual(handlePluginHook({ ...input, session_id: "ordinary-session" }, "Stop", installRoot), {});
      assert.throws(() => applyCampaignPlan(cwd, { session_id: input.session_id, expected, plan }, authority), /compare-and-set/);
      assert.equal(summarizeRunLedger(cwd).status, "available");
      delete process.env.SUPERVISED_WORKER_HOST_AUTHORITY;
      const unconfirmed = handlePluginHook(input, "Stop", installRoot);
      assert.equal(unconfirmed.decision, "allow");
      assert.match(unconfirmed.systemMessage, /could not revalidate/);
    } finally {
      if (previousInventory === undefined) delete process.env.SUPERVISED_WORKER_HOST_AUTHORITY;
      else process.env.SUPERVISED_WORKER_HOST_AUTHORITY = previousInventory;
    }
  });
});

test("installed CLI observes and publishes a plan before its real hook enforces Stop", () => {
  withAuthorityFixture(({ cwd, input, installRoot, inventoryPath }) => {
    const cliPath = path.join(installRoot, "src", "cli.mjs");
    const invoke = (args, request) => {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd, input: JSON.stringify(request), encoding: "utf8", timeout: 20_000,
        env: { ...process.env, SUPERVISED_WORKER_HOST_AUTHORITY: inventoryPath },
      });
      assert.equal(result.error, undefined);
      return { code: result.status, value: JSON.parse(result.stdout) };
    };
    const request = { session_id: input.session_id };
    const observed = invoke(["lifecycle", "observe"], request);
    assert.equal(observed.code, 0);
    const plan = { schemaVersion: 1, mode: "active", goal: "Complete the selected queue.",
      items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
    const transition = { ...request, expected: observed.value, plan };
    assert.equal(invoke(["lifecycle", "plan"], transition).value.status, "applied");
    assert.equal(invoke(["lifecycle", "plan"], transition).value.status, "conflict");
    assert.equal(invoke(["hook", "Stop"], input).value.decision, "block");
    assert.deepEqual(invoke(["hook", "Stop"], { ...input, session_id: "ordinary" }).value, {});
    assert.equal(invoke(["release"], {}).code, 1);
    const beforeRelease = invoke(["lifecycle", "observe"], request).value;
    assert.equal(invoke(["release"], { ...request, expected: beforeRelease }).value.released, true);
  });
});

function withRescueFixture(action) {
  withAuthorityFixture(({ cwd, input, installRoot, inventoryPath }) => {
    const authority = verifyWorkerAuthority(cwd, input, installRoot, inventoryPath);
    const plan = { schemaVersion: 1, mode: "active", goal: "Complete the selected queue.",
      items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
    applyCampaignPlan(cwd, { session_id: input.session_id, expected: observeCampaignTransition(cwd, input), plan }, authority);
    const child = spawnSync(process.execPath, ["--eval", ""], { encoding: "utf8", timeout: 20_000 });
    assert.equal(child.status, 0);
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    const ownerToken = "11111111-1111-4111-8111-111111111111";
    const lock = path.join(cwd, ".supervised-worker", "locks", "lifecycle");
    mkdirSync(lock);
    const ownerPath = path.join(lock, `${ownerToken}.json`);
    const ownerBytes = JSON.stringify({ schemaVersion: 1, token: ownerToken, processId: child.pid, acquiredAt: new Date().toISOString() });
    writeFileSync(ownerPath, ownerBytes);
    const grant = issueRescueCapability(cwd, { session_id: input.session_id, scope: "repository",
      incidentId: "22222222-2222-4222-8222-222222222222", expiresAt: new Date(Date.now() + 600_000).toISOString() }, authority);
    assert.equal(grant.status, "issued");
    const request = { session_id: input.session_id, capability: grant.capability, incidentId: grant.incidentId,
      snapshotHash: grant.snapshotHash, action: "inspect" };
    action({ cwd, input, installRoot, inventoryPath, child, grant, request, lock, ownerToken, ownerPath, ownerBytes });
  });
}

test("capability-bound rescue works outside blocked hooks and retains exact recovery evidence", () => {
  withRescueFixture(({ cwd, input, installRoot, inventoryPath, request, lock, ownerToken, ownerPath, ownerBytes }) => {
    const blocked = spawnSync(process.execPath, [path.join(installRoot, "src", "hook-launcher.mjs"), "Stop"], {
      cwd, input: JSON.stringify(input), encoding: "utf8", timeout: 20_000,
      env: { ...process.env, SUPERVISED_WORKER_HOST_AUTHORITY: inventoryPath },
    });
    assert.equal(blocked.status, 0);
    assert.match(blocked.stdout, /LIFECYCLE_OWNER_DEAD/);
    assert.equal(rescueLifecycle(cwd, request).status, "inspected");
    assert.equal(rescueLifecycle(cwd, { ...request, incidentId: ownerToken }).status, "unconfirmed");
    assert.equal(rescueLifecycle(cwd, { ...request, command: "arbitrary shell" }).status, "unconfirmed");
    assert.equal(readFileSync(ownerPath, "utf8"), ownerBytes);
    const result = spawnSync(process.execPath, [path.join(installRoot, "src", "rescue.mjs")], {
      cwd, input: JSON.stringify({ ...request, action: "recover" }), encoding: "utf8", timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stdout || result.stderr);
    const recovered = JSON.parse(result.stdout);
    assert.equal(recovered.status, "recovered");
    assert.match(recovered.intentHash, /^[0-9a-f]{64}$/);
    assert.match(recovered.outcomeHash, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(path.join(`${lock}.${ownerToken}.recovered`, `${ownerToken}.json`), "utf8"), ownerBytes);
    assert.equal(rescueLifecycle(cwd, { ...request, action: "recover" }).status, "already-recovered");
  });
});

for (const fault of ["plan", "attachment", "owner", "live", "unknown", "expired", "repository", "snapshot"]) {
  test(`rescue rejects ${fault} drift without reclaiming ownership`, (context) => {
    withRescueFixture(({ cwd, request, ownerPath, lock, child, grant }) => {
      if (fault === "plan") {
        const filePath = path.join(cwd, ".supervised-worker", "plan.json");
        const plan = JSON.parse(readFileSync(filePath));
        writeFileSync(filePath, JSON.stringify({ ...plan, goal: "Changed after authorization" }));
      }
      if (fault === "attachment") {
        const filePath = path.join(cwd, ".supervised-worker", "attachment.json");
        const attachment = JSON.parse(readFileSync(filePath));
        writeFileSync(filePath, JSON.stringify({ ...attachment, claimGeneration: "33333333-3333-4333-8333-333333333333" }));
      }
      if (fault === "owner") {
        const owner = JSON.parse(readFileSync(ownerPath));
        writeFileSync(ownerPath, JSON.stringify({ ...owner, processId: process.pid }));
      }
      if (["live", "unknown"].includes(fault)) {
        const originalKill = process.kill;
        context.mock.method(process, "kill", (processId, signal) => {
          if (processId !== child.pid) return originalKill(processId, signal);
          if (fault === "unknown") throw Object.assign(new Error("unverifiable"), { code: "EPERM" });
          return true;
        });
      }
      if (fault === "expired") context.mock.method(Date, "now", () => Date.parse(grant.expiresAt));
      const target = fault === "repository" ? path.dirname(cwd) : cwd;
      const ownerBytes = readFileSync(ownerPath);
      const attachmentBytes = readFileSync(path.join(cwd, ".supervised-worker", "attachment.json"));
      const planBytes = readFileSync(path.join(cwd, ".supervised-worker", "plan.json"));
      const denied = rescueLifecycle(target, { ...request, action: "recover", ...(fault === "snapshot" ? { snapshotHash: sha256("changed") } : {}) });
      assert.equal(denied.status, "unconfirmed");
      assert.deepEqual(readFileSync(ownerPath), ownerBytes);
      assert.deepEqual(readFileSync(path.join(cwd, ".supervised-worker", "attachment.json")), attachmentBytes);
      assert.deepEqual(readFileSync(path.join(cwd, ".supervised-worker", "plan.json")), planBytes);
      assert.equal(existsSync(lock), true);
      assert.equal(readdirSync(path.dirname(lock)).some((name) => name.endsWith(".recovered")), false);
    });
  });
}

for (const phase of ["before-publication", "after-publication"]) {
  test(`plan transition surfaces ${phase} interruption without stale replay`, (context) => {
    withAuthorityFixture(({ cwd, input, installRoot, inventoryPath }) => {
      const authority = verifyWorkerAuthority(cwd, input, installRoot, inventoryPath);
      const expected = observeCampaignTransition(cwd, input);
      const plan = { schemaVersion: 1, mode: "active", goal: "Complete the selected queue.",
        items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
      const request = { session_id: input.session_id, expected, plan };
      const planFile = path.join(cwd, ".supervised-worker", "plan.json");
      const originalRename = fs.renameSync;
      let injected = 0;
      context.mock.method(fs, "renameSync", (source, destination) => {
        if (destination !== planFile) return originalRename(source, destination);
        injected += 1;
        if (phase === "after-publication") originalRename(source, destination);
        throw Object.assign(new Error("injected publication interruption"), { code: "EIO" });
      });
      syncBuiltinESMExports();
      try {
        assert.throws(() => applyCampaignPlan(cwd, request, authority));
      } finally {
        context.mock.restoreAll();
        syncBuiltinESMExports();
      }
      assert.equal(injected, 1);
      assert.equal(existsSync(planFile), phase === "after-publication");
      const observed = observeCampaignTransition(cwd, input);
      assert.equal(observed.state, "provisional");
      const attachmentFile = path.join(cwd, ".supervised-worker", "attachment.json");
      const attachmentBytes = readFileSync(attachmentFile);
      assert.throws(() => applyCampaignPlan(cwd, request, authority), { transitionCode: "CAMPAIGN_COMPARE_AND_SET_CONFLICT" });
      assert.deepEqual(readFileSync(attachmentFile), attachmentBytes);
      assert.equal(applyCampaignPlan(cwd, { ...request, expected: observed }, authority).status, "applied");
      assert.deepEqual(JSON.parse(readFileSync(planFile)), plan);
    });
  });
}

test("authorized release retires its matching route and permits explicit readmission", () => {
  withAuthorityFixture(({ base, cwd, input, installRoot, inventoryPath }) => {
    const storage = path.join(base, "storage");
    const transcripts = path.join(storage, "GitHub.copilot-chat", "transcripts");
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(path.join(storage, "workspace.json"), "{}\n");
    const transcript = path.join(transcripts, `${input.session_id}.jsonl`);
    writeFileSync(transcript, "");
    const session = { session_id: input.session_id, transcript_path: transcript };
    const authority = verifyWorkerAuthority(cwd, session, installRoot, inventoryPath);
    const plan = { schemaVersion: 1, mode: "active", goal: "Complete the selected queue.",
      items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
    applyCampaignPlan(cwd, { ...session, expected: observeCampaignTransition(cwd, session), plan }, authority);
    const before = observeCampaignTransition(cwd, session);
    const routeFile = path.join(storage, "supervised-worker", "session-roots", sha256(input.session_id), "route.json");
    const result = releaseAttachment(cwd, before, session, authority);
    assert.equal(result.released, true);
    assert.equal(existsSync(path.join(cwd, ".supervised-worker", "attachment.json")), false);
    assert.equal(JSON.parse(readFileSync(routeFile)).status, "released");
    assert.deepEqual(JSON.parse(readFileSync(path.join(cwd, ".supervised-worker", "plan.json"))), plan);
    const resumed = resumeSession(cwd, { ...session, planHash: canonicalPlanHash(plan), checkpointHash: null }, authority);
    assert.equal(resumed.status, "resumed");
    assert.notEqual(observeCampaignTransition(cwd, session).claimGeneration, before.claimGeneration);
    assert.notEqual(JSON.parse(readFileSync(routeFile)).generation, before.routeGeneration);
  });
});

test("owning hooks revalidate a revoked host grant after acquiring lifecycle exclusion", (context) => {
  withAuthorityFixture(({ cwd, input, installRoot, inventory, inventoryPath }) => {
    const authority = verifyWorkerAuthority(cwd, input, installRoot, inventoryPath);
    const plan = { schemaVersion: 1, mode: "active", goal: "Complete the selected queue.",
      items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
    applyCampaignPlan(cwd, { session_id: input.session_id, expected: observeCampaignTransition(cwd, input), plan }, authority);
    const before = observeCampaignTransition(cwd, input);
    const ledgerFile = path.join(cwd, ".supervised-worker", "runs", `${sha256(input.session_id)}.jsonl`);
    const ledgerBefore = readFileSync(ledgerFile);
    const originalMkdir = fs.mkdirSync;
    const previousInventory = process.env.SUPERVISED_WORKER_HOST_AUTHORITY;
    let revoked = false;
    process.env.SUPERVISED_WORKER_HOST_AUTHORITY = inventoryPath;
    context.mock.method(fs, "mkdirSync", (directory, ...args) => {
      const result = originalMkdir(directory, ...args);
      if (directory === path.join(cwd, ".supervised-worker", "locks", "lifecycle")) {
        revoked = true;
        writeFileSync(inventoryPath, JSON.stringify({ ...inventory, complete: false }));
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      const result = handlePluginHook(input, "Stop", installRoot);
      assert.equal(revoked, true);
      assert.notEqual(result.decision, "block");
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      if (previousInventory === undefined) delete process.env.SUPERVISED_WORKER_HOST_AUTHORITY;
      else process.env.SUPERVISED_WORKER_HOST_AUTHORITY = previousInventory;
    }
    assert.deepEqual(observeCampaignTransition(cwd, input), before);
    assert.deepEqual(readFileSync(ledgerFile), ledgerBefore);
  });
});