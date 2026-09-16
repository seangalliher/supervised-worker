import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalPlanHash, sha256, validateArtifactPublication, validateDoctorInvocation, validateLifecycle, validateRecovery } from "../src/core.mjs";
import { doctorGit } from "../src/doctor-repair.mjs";
import { createWorkerAuthorityFixture } from "./worker-authority-fixture.mjs";

test("reliability: recovery, Doctor and publication share the established lifecycle session-ID domain", () => {
  const manifest = { schemaVersion: 1, kind: "campaign-release-input",
    candidate: { commit: "a".repeat(40), tree: "b".repeat(40), baseCommit: "c".repeat(40), ref: "refs/heads/main" },
    artifacts: [{ role: "plan", reference: { locator: ".supervised-worker/plan.json", sha256: "a".repeat(64) } }],
    doctorInventoryHash: "b".repeat(64) };
  for (const session_id of ["worker", "dot.session", "session+".repeat(30), "s".repeat(256), "", "s".repeat(257), "bad/id", "bad id", "bad:id", "\n"]) {
    const accepted = validateLifecycle(session_id, "sessionId").length === 0;
    assert.equal(validateRecovery({ session_id }, "inspectRequest").length === 0, accepted, session_id);
    assert.equal(validateDoctorInvocation({ operation: "diagnose", session_id }, "request").length === 0, accepted, session_id);
    assert.equal(validateArtifactPublication({ session_id, manifest }, "request").length === 0, accepted, session_id);
  }
});

for (const sourceSession of ["dot.session", "s".repeat(256)]) {
  test(`reliability: installed admitted session of length ${sourceSession.length} crosses publication and recovery into fresh resume`, () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sw-session-contract-")));
    try {
      doctorGit(root, ["init", "--quiet", "--initial-branch=main"]);
      doctorGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-qm", "fixture"]);
      let input = { session_id: sourceSession };
      const worker = createWorkerAuthorityFixture(root, input);
      assert.equal(worker.admit().status, "applied", "the existing admission path must accept the premise");
      const invoke = (args, request) => {
        const result = spawnSync(process.execPath, [path.join(worker.installRoot, "src", "cli.mjs"), ...args], {
          cwd: root, input: JSON.stringify(request), encoding: "utf8",
          timeout: args[0] === "hook" ? (process.platform === "win32" ? 15_000 : 5_000) : 30_000,
          env: { ...process.env, SUPERVISED_WORKER_HOST_AUTHORITY: worker.inventoryPath },
        });
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.status, 0, result.stdout || result.stderr);
        return JSON.parse(result.stdout);
      };
      const observed = invoke(["recovery", "inspect"], input);
      assert.equal(observed.status, "observed");
      assert.equal(observed.observation.sessionHash, sha256(sourceSession));
      const formatted = invoke(["doctor", "request"], { ...input, operation: "diagnose" });
      assert.equal(formatted.status, "formatted");
      const planPath = path.join(root, ".supervised-worker", "plan.json");
      const plan = JSON.parse(readFileSync(planPath));
      const commit = doctorGit(root, ["rev-parse", "HEAD"]).trim();
      const inventory = invoke(["campaign", "inventory"], input);
      const manifest = { schemaVersion: 1, kind: "campaign-release-input",
        candidate: { commit, tree: doctorGit(root, ["rev-parse", "HEAD^{tree}"]).trim(), baseCommit: commit, ref: "refs/heads/main" },
        artifacts: [{ role: "plan", reference: { locator: ".supervised-worker/plan.json", sha256: sha256(readFileSync(planPath)) } }],
        doctorInventoryHash: inventory.doctorInventoryHash };
      const published = invoke(["campaign", "publish"], { ...input, manifest });
      assert.equal(published.status, "published");
      assert.equal(sha256(readFileSync(path.join(root, published.locator))), published.sha256);
      const checkpoint = invoke(["checkpoint"], { ...input, planHash: canonicalPlanHash(plan),
        attachmentHash: sha256(readFileSync(path.join(root, ".supervised-worker", "attachment.json"))) });
      assert.equal(checkpoint.status, "checkpointed");
      input = { session_id: `next.${sourceSession.slice(0, 200)}` };
      worker.select(input);
      const resumed = invoke(["resume"], { ...input, planHash: checkpoint.planHash,
        checkpointHash: checkpoint.checkpointHash, frontierHash: checkpoint.frontierHash });
      assert.equal(resumed.status, "resumed");
      assert.equal(invoke(["recovery", "inspect"], input).observation.sessionHash, sha256(input.session_id));
      const call = { cwd: root, ...input, tool_name: "read_file", tool_use_id: "session-contract-read",
        tool_input: { filePath: planPath } };
      assert.notEqual(invoke(["hook", "PreToolUse"], call).permissionDecision, "deny");
      assert.ok(readFileSync(planPath).length > 0);
      assert.equal(invoke(["hook", "PostToolUse"], call).additionalContext, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}
