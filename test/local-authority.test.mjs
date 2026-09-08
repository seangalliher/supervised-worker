import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { requireVerifiedWorkerAuthority, verifyWorkerAuthority } from "../src/authority.mjs";
import { applyCampaignPlan, canonicalPlanHash, checkpointSession, handlePluginHook, observeCampaignTransition, resumeSession, sha256 } from "../src/core.mjs";
import { detectDoctorIncident, executeDoctorIntent, grantDoctorAction, inspectDoctorIncident } from "../src/doctor.mjs";
import { doctorHash } from "../src/doctor-state.mjs";
import { installLocalPlugin } from "../src/install.mjs";
import { acceptWorkflowRoles, resolveWorkflowRoles } from "../src/workflow.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function withLocalFixture(action) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sw-local-authority-")));
  try {
    const cwd = path.join(base, "repo");
    const workflowPath = path.join(cwd, ".github", "supervised-worker.json");
    mkdirSync(path.dirname(workflowPath), { recursive: true });
    const workflow = JSON.parse(readFileSync(path.join(sourceRoot, "examples", "workflow.json")));
    workflow.authority.assurance = "local-scoped";
    writeFileSync(workflowPath, JSON.stringify(workflow));
    const storage = path.join(base, "storage");
    const transcripts = path.join(storage, "GitHub.copilot-chat", "transcripts");
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(path.join(storage, "workspace.json"), "{}\n");
    const input = { cwd, session_id: "local-worker", transcript_path: path.join(transcripts, "local-worker.jsonl") };
    writeFileSync(input.transcript_path, "");
    const { installRoot } = installLocalPlugin(sourceRoot, { baseDirectory: path.join(base, "install") });
    const accept = () => {
      const result = acceptWorkflowRoles(cwd, resolveWorkflowRoles(cwd).workflowHash);
      assert.equal(result.ok, true, result.errors?.join("\n"));
    };
    action({ base, cwd, workflow, workflowPath, storage, input, installRoot, accept });
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("local admission requires exact workflow acceptance and labels its limited provenance", () => {
  withLocalFixture(({ cwd, input, installRoot, accept }) => {
    assert.throws(() => verifyWorkerAuthority(cwd, input, installRoot, ""), /accepted workflow hash/);
    accept();
    const authority = verifyWorkerAuthority(cwd, input, installRoot, "");
    assert.equal(authority.assurance, "local-scoped");
    assert.equal(authority.provenance, "accepted-plugin-session");
    assert.equal(Object.hasOwn(authority, "complete"), false);
    assert.equal(Object.hasOwn(authority, "providerSealed"), false);
    assert.doesNotThrow(() => requireVerifiedWorkerAuthority(authority, cwd, input));
    assert.throws(() => requireVerifiedWorkerAuthority({ ...authority }, cwd, input), /verified/);
    assert.throws(() => requireVerifiedWorkerAuthority(authority, cwd, { ...input, session_id: "other" }), /session-bound/);
  });
});

test("local assurance is never selected by missing host evidence or a legacy workflow", () => {
  withLocalFixture(({ cwd, workflow, workflowPath, input, installRoot, accept }) => {
    delete workflow.authority.assurance;
    writeFileSync(workflowPath, JSON.stringify(workflow));
    accept();
    assert.equal(resolveWorkflowRoles(cwd).authorityAssurance, "host-attested");
    assert.throws(() => verifyWorkerAuthority(cwd, input, installRoot, ""), /trusted host authority inventory is unavailable/);
  });
});

test("local admission rejects checkout code and malformed or linked session locators", () => {
  withLocalFixture(({ base, cwd, input, installRoot, accept }) => {
    accept();
    assert.throws(() => verifyWorkerAuthority(cwd, input, sourceRoot, ""), /immutable/);
    for (const request of [
      { session_id: input.session_id },
      { ...input, session_id: "" },
      { ...input, session_id: "different" },
      { ...input, transcript_path: "relative.jsonl" },
      { ...input, transcript_path: path.join(base, "local-worker.jsonl") },
    ]) assert.throws(() => verifyWorkerAuthority(cwd, request, installRoot, ""));
    linkSync(input.transcript_path, path.join(base, "linked-transcript"));
    assert.throws(() => verifyWorkerAuthority(cwd, input, installRoot, ""), /single-link/);
  });
});

test("local authority survives transcript append but rejects workflow and workspace drift", () => {
  withLocalFixture(({ cwd, workflowPath, storage, input, installRoot, accept }) => {
    accept();
    const authority = verifyWorkerAuthority(cwd, input, installRoot, "");
    appendFileSync(input.transcript_path, '{"type":"tool.completed"}\n');
    assert.doesNotThrow(() => requireVerifiedWorkerAuthority(authority, cwd, input));
    writeFileSync(path.join(storage, "workspace.json"), '{"changed":true}');
    assert.throws(() => requireVerifiedWorkerAuthority(authority, cwd, input), /changed/);
    writeFileSync(path.join(storage, "workspace.json"), "{}\n");
    appendFileSync(workflowPath, "\n");
    assert.throws(() => requireVerifiedWorkerAuthority(authority, cwd, input), /accepted workflow hash/);
  });
});

test("local authority matches established Windows transcript casing rules", { skip: process.platform !== "win32" }, () => {
  withLocalFixture(({ cwd, input, installRoot, accept }) => {
    accept();
    const canonical = verifyWorkerAuthority(cwd, input, installRoot, "");
    const alias = { ...input, transcript_path: input.transcript_path.toUpperCase() };
    assert.equal(observeCampaignTransition(cwd, alias).state, "released");
    const aliased = verifyWorkerAuthority(cwd, alias, installRoot, "");
    assert.equal(aliased.grantHash, canonical.grantHash);
    assert.doesNotThrow(() => requireVerifiedWorkerAuthority(canonical, cwd, alias));
  });
});

test("installed local CLI publishes a plan and its real hook enforces Stop without a host inventory", () => {
  withLocalFixture(({ cwd, input, installRoot, accept }) => {
    accept();
    const env = { ...process.env };
    delete env.SUPERVISED_WORKER_HOST_AUTHORITY;
    const invoke = (args, request) => {
      const result = spawnSync(process.execPath, [path.join(installRoot, "src", "cli.mjs"), ...args], {
        cwd, input: JSON.stringify(request), encoding: "utf8", timeout: 20_000, env,
      });
      assert.equal(result.error, undefined);
      return { code: result.status, value: JSON.parse(result.stdout) };
    };
    const request = { session_id: input.session_id, transcript_path: input.transcript_path };
    const before = invoke(["lifecycle", "observe"], request);
    assert.equal(before.code, 0);
    const plan = { schemaVersion: 1, mode: "active", goal: "Complete the bounded local queue.",
      items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
    const applied = invoke(["lifecycle", "plan"], { ...request, expected: before.value, plan });
    assert.equal(applied.value.status, "applied", JSON.stringify(applied));
    assert.deepEqual(invoke(["status"], {}).value.assurance, {
      requested: "local-scoped", workflowAcceptance: "accepted",
      hostInventory: "not-checked", providerCompletion: "not-checked",
    });
    assert.equal(invoke(["hook", "Stop"], input).value.decision, "block");
    assert.deepEqual(invoke(["hook", "Stop"], { ...input, session_id: "ordinary" }).value, {});
    assert.equal(invoke(["lifecycle", "plan"], { ...request, expected: before.value, plan }).value.status, "conflict");
  });
});

test("status distinguishes unaccepted workflows and bundled defaults from failed verification", () => {
  withLocalFixture(({ cwd, workflowPath, installRoot }) => {
    const status = () => {
      const result = spawnSync(process.execPath, [path.join(installRoot, "src", "cli.mjs"), "status"], {
        cwd, encoding: "utf8", timeout: 20_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      return JSON.parse(result.stdout).assurance;
    };
    assert.deepEqual(status(), {
      requested: "local-scoped", workflowAcceptance: "required",
      hostInventory: "not-checked", providerCompletion: "not-checked",
    });
    rmSync(workflowPath);
    assert.deepEqual(status(), {
      requested: "host-attested", workflowAcceptance: "not-required",
      hostInventory: "not-checked", providerCompletion: "not-checked",
    });
    writeFileSync(workflowPath, "{");
    assert.equal(status().workflowAcceptance, "invalid");
  });
});

test("admitted local sessions cannot silently execute after workflow authority is revoked", () => {
  withLocalFixture(({ cwd, input, installRoot, workflowPath, accept }) => {
    accept();
    const authority = verifyWorkerAuthority(cwd, input, installRoot, "");
    const plan = { schemaVersion: 1, mode: "active", goal: "Keep governed execution.",
      items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
    const request = { session_id: input.session_id, transcript_path: input.transcript_path };
    applyCampaignPlan(cwd, { ...request, expected: observeCampaignTransition(cwd, request), plan }, authority);
    appendFileSync(workflowPath, "\n");
    const denied = handlePluginHook({ ...input, tool_name: "Read", tool_input: { file_path: path.join(cwd, "README.md") } }, "PreToolUse", installRoot);
    assert.equal(denied.permissionDecision, "deny");
    assert.match(denied.permissionDecisionReason, /unchanged accepted authority/);
    assert.match(handlePluginHook(input, "Stop", installRoot).systemMessage, /No campaign completion/);
  });
});

test("local checkpoint resumes in a fresh session and fences both competing and old sessions", () => {
  withLocalFixture(({ cwd, input, installRoot, accept }) => {
    accept();
    const authority = verifyWorkerAuthority(cwd, input, installRoot, "");
    const request = { session_id: input.session_id, transcript_path: input.transcript_path };
    const plan = { schemaVersion: 1, mode: "active", goal: "Continue the local campaign.",
      items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
    const admitted = applyCampaignPlan(cwd, { ...request, expected: observeCampaignTransition(cwd, request), plan }, authority);
    const next = { session_id: "local-successor", transcript_path: path.join(path.dirname(input.transcript_path), "local-successor.jsonl") };
    writeFileSync(next.transcript_path, "");
    const successorAuthority = verifyWorkerAuthority(cwd, next, installRoot, "");
    assert.throws(() => applyCampaignPlan(cwd, { ...next, expected: observeCampaignTransition(cwd, next), plan }, successorAuthority), /owning Worker/);
    const checkpointRequest = { ...request, planHash: canonicalPlanHash(plan), attachmentHash: admitted.observation.attachmentHash };
    const checkpoint = checkpointSession(cwd, checkpointRequest, authority);
    assert.equal(checkpoint.status, "checkpointed");
    assert.equal(JSON.parse(readFileSync(path.join(cwd, ".supervised-worker", "plan.json"))).mode, "active");
    const resumeRequest = { ...next, planHash: checkpoint.planHash, checkpointHash: checkpoint.checkpointHash };
    const resumed = resumeSession(cwd, resumeRequest, successorAuthority);
    assert.equal(resumed.status, "resumed");
    assert.notEqual(observeCampaignTransition(cwd, next).claimGeneration, admitted.observation.claimGeneration);
    assert.deepEqual(resumeSession(cwd, resumeRequest, successorAuthority), resumed);
    assert.throws(() => checkpointSession(cwd, checkpointRequest, authority), /does not own/);
    assert.throws(() => applyCampaignPlan(cwd, { ...request, expected: observeCampaignTransition(cwd, request), plan }, authority), /owning Worker/);
  });
});

test("local Doctor recovers an exact dead owner once and retains the original recovery evidence", () => {
  withLocalFixture(({ cwd, input, installRoot, accept }) => {
    accept();
    const authority = verifyWorkerAuthority(cwd, input, installRoot, "");
    const request = { session_id: input.session_id, transcript_path: input.transcript_path };
    const plan = { schemaVersion: 1, mode: "active", goal: "Recover the local campaign.",
      items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
    applyCampaignPlan(cwd, { ...request, expected: observeCampaignTransition(cwd, request), plan }, authority);
    const child = spawnSync(process.execPath, ["--eval", ""], { encoding: "utf8", timeout: 20_000 });
    assert.equal(child.status, 0);
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    const token = randomUUID();
    const lock = path.join(cwd, ".supervised-worker", "locks", "lifecycle");
    mkdirSync(lock);
    const ownerBytes = JSON.stringify({ schemaVersion: 1, token, processId: child.pid, acquiredAt: new Date().toISOString() });
    writeFileSync(path.join(lock, `${token}.json`), ownerBytes);
    const incidentId = randomUUID();
    const detected = detectDoctorIncident(cwd, request, incidentId, sha256("local-dead-owner"), authority);
    const intentFor = (incident, action, inputHashes = []) => {
      const grant = grantDoctorAction(cwd, request, incidentId, { action, actionId: randomUUID(), expectedHash: doctorHash(incident) }, authority);
      return { schemaVersion: 1, kind: "doctor-repair-intent", binding: incident.binding, attemptId: incident.attemptId,
        actionId: grant.capability.actionId, action, capabilityHash: grant.hash, expectedHash: doctorHash(incident), inputHashes };
    };
    const inspected = executeDoctorIntent(cwd, request, intentFor(detected.incident, "inspect"), authority);
    assert.equal(inspected.status, "succeeded");
    assert.equal(inspected.values[0].diagnostics[0].code, "LIFECYCLE_OWNER_DEAD");
    const current = inspectDoctorIncident(cwd, request, incidentId, authority).incident;
    const intent = intentFor(current, "recover", inspected.outcome.outputHashes);
    const recovered = executeDoctorIntent(cwd, request, intent, authority);
    assert.equal(recovered.status, "succeeded", JSON.stringify(recovered));
    assert.equal(existsSync(lock), false);
    assert.equal(readFileSync(path.join(`${lock}.${token}.recovered`, `${token}.json`), "utf8"), ownerBytes);
    assert.equal(executeDoctorIntent(cwd, request, intent, authority).status, "replayed");
    const observed = observeCampaignTransition(cwd, request);
    assert.equal(observed.state, "active");
    assert.equal(applyCampaignPlan(cwd, { ...request, expected: observed, plan }, authority).status, "applied");
  });
});