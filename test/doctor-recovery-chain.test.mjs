import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { inspectLifecycleLock, issueRescueCapability, releaseAttachment, sha256 } from "../src/core.mjs";
import { doctorHash } from "../src/doctor-state.mjs";
import { doctorInvocationRequest } from "../src/doctor-invocation.mjs";
import { withReliabilityFixture } from "./reliability-fixture.mjs";
import { authorizeFixtureProposal } from "./recovery-action-fixture.mjs";

function createDeadScopes(fixture, scopes) {
  const child = spawnSync(process.execPath, ["--eval", ""], { encoding: "utf8", timeout: 20_000 });
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" }, "dead-owner fault requires an actually exited child");
  return scopes.map((scope) => {
    const target = scope === "session" ? path.join(fixture.storage, "supervised-worker", "session-locks", sha256(fixture.input.session_id))
      : path.join(fixture.cwd, ".supervised-worker", "locks", scope === "repository" ? "lifecycle" : "journal");
    const token = randomUUID();
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, `${token}.json`), JSON.stringify({ schemaVersion: 1, token, processId: child.pid, acquiredAt: new Date().toISOString() }));
    return { scope, target, token, pid: child.pid };
  });
}

function doctorStep(fixture, incident, action, inputHashes = [], recovery = null) {
  const grant = fixture.doctor({ operation: "grant", incidentId: incident.binding.incidentId,
    grant: { action, actionId: randomUUID(), expectedHash: doctorHash(incident) } });
  const intent = { schemaVersion: recovery === null ? 1 : 2, kind: "doctor-repair-intent", binding: incident.binding,
    attemptId: incident.attemptId, actionId: grant.capability.actionId, action, capabilityHash: grant.hash,
    expectedHash: doctorHash(incident), inputHashes, ...(recovery === null ? {} : { recovery }) };
  return fixture.doctor({ operation: "execute", incidentId: incident.binding.incidentId, intent });
}

test("reliability: native typed journal denial already contains a usable strict diagnosis request", () => withReliabilityFixture((fixture) => {
  fixture.tool("positive-before-routing-fault");
  const foreign = path.join(fixture.cwd, ".supervised-worker", "runs", "foreign-report.json");
  fs.writeFileSync(foreign, "{}\n");
  assert.ok(fs.existsSync(foreign));
  const denied = fixture.hook("PreToolUse", { tool_name: "read_file", tool_use_id: "journal-fault-attempt", tool_input: { filePath: path.join(fixture.cwd, "README.md") } });
  assert.equal(denied.permissionDecision, "deny");
  assert.equal(denied.supervisorFailure.code, "JOURNAL_INTEGRITY");
  assert.ok(denied.supervisorFailure.diagnostics.includes("JOURNAL_OBSERVATION_UNCONFIRMED"),
    "failed denial journaling must not replace the original admission failure");
  assert.equal(denied.recoveryInvocation.status, "formatted");
  const command = denied.recoveryInvocation.command;
  const request = doctorInvocationRequest({ cwd: fixture.cwd, ...fixture.input, tool_name: "run_in_terminal", tool_input: { command } }, fixture.installRoot);
  assert.equal(request.operation, "diagnose");
  const diagnosis = fixture.doctor({ operation: "diagnose" });
  assert.equal(diagnosis.observation.status, "complete");
  assert.ok(diagnosis.candidates.some((candidate) => candidate.kind === "quarantine-journal-entry"));
  for (const invalid of [`${command}; echo extra`, `node ${command}`, command.replace("doctor-rescue.mjs", "cli.mjs")]) {
    const output = fixture.hook("PreToolUse", { tool_name: "run_in_terminal", tool_use_id: randomUUID(), tool_input: { command: invalid } });
    assert.equal(output.permissionDecision, "deny");
  }
}));

for (const scopes of [["journal"], ["repository", "session"], ["repository", "session", "journal"]]) {
  test(`reliability: Doctor recovers ${scopes.join("+")} in exact ordered native actions`, () => withReliabilityFixture((fixture) => {
    fixture.tool("positive-before-dead-scope-fault");
    const faults = createDeadScopes(fixture, scopes);
    const incidentId = randomUUID();
    let { incident } = fixture.doctor({ operation: "detect", incidentId, diagnosticHash: "a".repeat(64) });
    for (let index = 0; index < faults.length; index += 1) {
      const inspected = doctorStep(fixture, incident, "inspect");
      assert.equal(inspected.status, "succeeded", JSON.stringify(inspected));
      const selected = inspected.values.find((value) => value.kind === "doctor-scope-observation" && value.owner === "dead");
      assert.equal(selected.scope, faults[index].scope);
      const scoped = inspected.values.filter((value) => value.kind === "doctor-scope-observation");
      assert.ok(scoped.slice(scoped.indexOf(selected) + 1).every((value) => value.status === "deferred"));
      incident = fixture.doctor({ operation: "inspect", incidentId }).incident;
      const recovered = doctorStep(fixture, incident, "recover", inspected.outcome.outputHashes,
        { scope: selected.scope, snapshotHash: selected.snapshotHash });
      assert.equal(recovered.status, "succeeded", JSON.stringify(recovered));
      assert.equal(fs.existsSync(faults[index].target), false);
      assert.equal(fs.existsSync(`${faults[index].target}.${faults[index].token}.recovered`), true);
      for (const later of faults.slice(index + 1)) assert.equal(fs.existsSync(later.target), true, "one action must not recover later scopes");
      incident = fixture.doctor({ operation: "inspect", incidentId }).incident;
    }
    fixture.tool("positive-after-ordered-recovery");
  }));
}

test("reliability: selected snapshot replacement before capability minting leaves the replacement untouched", () => withReliabilityFixture((fixture) => {
  fixture.tool("positive-before-mint-race");
  const [fault] = createDeadScopes(fixture, ["repository"]);
  const selected = inspectLifecycleLock(fixture.cwd, { ...fixture.input, scope: "repository" });
  assert.equal(selected.status, "inspected");
  fs.renameSync(fault.target, `${fault.target}.retained`);
  const replacement = createDeadScopes(fixture, ["repository"])[0];
  assert.notEqual(replacement.token, fault.token, "replacement fault must fire");
  assert.throws(() => issueRescueCapability(fixture.cwd, { ...fixture.input, scope: "repository", incidentId: randomUUID(),
    expiresAt: new Date(Date.now() + 600_000).toISOString() }, fixture.authority(), selected.expected), /DOCTOR_RECOVERY_SNAPSHOT_CHANGED/);
  assert.ok(fs.existsSync(path.join(replacement.target, `${replacement.token}.json`)));
  assert.equal(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "rescue-capabilities")), false);
}));

test("reliability: ownerless operator recovery uses selective guards without bootstrapping Worker ownership", (t) => withReliabilityFixture((fixture) => {
  fixture.tool("positive-before-ownerless-lock-fault");
  const released = releaseAttachment(fixture.cwd, fixture.observe(), fixture.input, fixture.authority());
  // A session-lock recovery needs the kernel's existing repository-bound route.
  // A never-routed fresh session is not proof that its dead lock belongs here.
  const before = fixture.doctor({ operation: "diagnose" });
  assert.ok(before.observation.scopes.every((value) => value.status === "absent"));
  const faults = createDeadScopes(fixture, ["repository", "session", "journal"]);
  for (let index = 0; index < faults.length; index += 1) {
    const diagnosis = fixture.doctor({ operation: "diagnose" });
    const action = diagnosis.candidates.find((value) => value.kind === "recover-lock");
    assert.equal(action.scope, faults[index].scope);
    const proposed = fixture.doctor({ operation: "propose-recovery", expectedHash: diagnosis.observationHash, action });
    const grant = authorizeFixtureProposal(fixture, proposed);
    t.diagnostic(`Applying exact ownerless ${action.scope} recovery after successful diagnosis and operator authorization`);
    const result = fixture.doctor({ operation: "recover-authorized", authorizationHash: grant.authorizationHash });
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(fs.existsSync(path.join(fixture.cwd, ".supervised-worker", "attachment.json")), false);
    assert.equal(fs.existsSync(faults[index].target), false);
    for (const later of faults.slice(index + 1)) assert.equal(fs.existsSync(later.target), true);
  }
  fixture.select("prospective-worker");
  const resumed = fixture.native(["resume"], { ...fixture.input, checkpointHash: null, planHash: before.observation.planHash, frontierHash: released.frontierHash });
  assert.equal(resumed.status, "resumed");
  fixture.tool("positive-after-ownerless-lock-recovery");
}));
