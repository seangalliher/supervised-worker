import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";

import { publishCampaignRelease } from "../src/artifact-publication.mjs";
import { compileCampaignRelease, serializeCampaignRelease } from "../src/campaign-release.mjs";
import { canonicalPlanHash, sha256, summarizeRunLedger, validateArtifactPublication } from "../src/core.mjs";
import { doctorGit } from "../src/doctor-repair.mjs";
import { resolveCommittedCandidate, verifyBuildHandoff } from "../src/handoff.mjs";
import { applyRecovery } from "../src/recovery.mjs";
import { serializeQuarantineMetadata, serializeRecovery } from "../src/recovery-state.mjs";
import { observeReleaseDoctorInventory } from "../src/release-inputs.mjs";
import { resolveWorkflowRoles } from "../src/workflow.mjs";
import { authorizeFixtureProposal } from "./recovery-action-fixture.mjs";
import { reliabilitySourceRoot, withReliabilityFixture } from "./reliability-fixture.mjs";

function publicationFixture(action, options = {}) {
  return withReliabilityFixture((fixture) => {
    doctorGit(fixture.cwd, ["init", "--quiet", "--initial-branch=main"]);
    doctorGit(fixture.cwd, ["add", "README.md", ".github/supervised-worker.json"]);
    doctorGit(fixture.cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
    const commit = doctorGit(fixture.cwd, ["rev-parse", "HEAD"]).trim();
    const manifest = { schemaVersion: 1, kind: "campaign-release-input",
      candidate: { commit, tree: doctorGit(fixture.cwd, ["rev-parse", "HEAD^{tree}"]).trim(), baseCommit: commit, ref: "refs/heads/main" },
      artifacts: [{ role: "plan", reference: { locator: ".supervised-worker/plan.json", sha256: sha256(fs.readFileSync(path.join(fixture.cwd, ".supervised-worker", "plan.json"))) } }],
      doctorInventoryHash: observeReleaseDoctorInventory(fixture.cwd, fixture.input, fixture.authority()).doctorInventoryHash };
    const add = (role, value) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const hash = sha256(bytes);
      const locator = `.supervised-worker/release-inputs/${hash}.json`;
      fs.mkdirSync(path.dirname(path.join(fixture.cwd, locator)), { recursive: true });
      fs.writeFileSync(path.join(fixture.cwd, locator), bytes);
      manifest.artifacts = manifest.artifacts.filter((entry) => entry.role !== role);
      manifest.artifacts.push({ role, reference: { locator, sha256: hash } });
    };
    return action(fixture, manifest, add);
  }, options);
}

function timing(fixture, manifest, add) {
  add("timing", { schemaVersion: 1, kind: "release-timing-observation", planHash: canonicalPlanHash(fixture.plan),
    commit: manifest.candidate.commit, complete: false, doctorIncluded: false, basis: "measured-activity-durations",
    durationsMs: Object.fromEntries(["productiveWorker", "productiveModel", "hookContention", "retries", "recovery", "doctor", "evidenceCompilation", "formalReview", "broadGates"].map((name) => [name, 0])) });
}

function journals(fixture) {
  const root = path.join(fixture.cwd, ".supervised-worker", "runs");
  return Object.fromEntries(fs.readdirSync(root).filter((name) => name.endsWith(".jsonl")).sort()
    .map((name) => [name, fs.readFileSync(path.join(root, name))]));
}

function quarantineProposal(fixture, source) {
  const diagnosis = fixture.doctor({ operation: "diagnose" });
  const entry = diagnosis.observation.files.find((value) => value.path === `.supervised-worker/runs/${path.basename(source)}`);
  assert.equal(entry?.kind, "file", JSON.stringify(diagnosis));
  const action = diagnosis.candidates.find((value) => value.kind === "quarantine-journal-entry");
  assert.ok(action, JSON.stringify(diagnosis));
  return fixture.doctor({ operation: "propose-recovery", expectedHash: diagnosis.observationHash, action });
}

test("reliability: quarantine metadata codec rejects empty and malformed records", () => {
  for (const value of [null, [], {}, { schemaVersion: 1, kind: "journal-entry-quarantine" }]) {
    assert.throws(() => serializeQuarantineMetadata(value), /RECOVERY_RECORD_INVALID/);
  }
});

test("reliability: campaign publish selects exact canonical bytes outside runs and permits a subsequent durable tool", () => publicationFixture((fixture, manifest) => {
  fixture.tool("positive-before-publication");
  const before = fixture.observe();
  const expected = Buffer.from(serializeCampaignRelease(compileCampaignRelease(fixture.cwd, fixture.input, manifest, fixture.authority())));
  const result = fixture.native(["campaign", "publish"], { ...fixture.input, manifest });
  assert.equal(result.status, "published");
  // The former logs/gates destination polluted the candidate's untracked source.
  assert.equal(result.locator, `.supervised-worker/releases/${sha256(expected)}.json`);
  assert.deepEqual(fs.readFileSync(path.join(fixture.cwd, result.locator)), expected);
  assert.deepEqual(fixture.observe(), before, "publication is not a plan or lifecycle transition");
  assert.deepEqual(Buffer.from(serializeCampaignRelease(compileCampaignRelease(fixture.cwd, fixture.input, manifest, fixture.authority()))), expected,
    "the identical manifest must still compile to identical bytes after publication");
  const again = fixture.native(["campaign", "publish"], { ...fixture.input, manifest });
  assert.equal(again.status, "already-published");
  assert.equal(again.sha256, result.sha256);
  fixture.tool("positive-after-publication");
  const direct = fixture.hook("PreToolUse", { tool_name: "create_file", tool_use_id: "unsafe-report-edit", tool_input: { filePath: path.join(fixture.cwd, result.locator), content: "{}" } });
  assert.equal(direct.permissionDecision, "deny");
  const unrelated = fixture.hook("PreToolUse", { tool_name: "create_file", tool_use_id: "ordinary-gate-file", tool_input: { filePath: path.join(fixture.cwd, "logs", "gates", "ordinary.json"), content: "{}" } });
  assert.notEqual(unrelated.permissionDecision, "deny", JSON.stringify(unrelated));
}));

test("reliability: quarantine changes the canonical recovery inventory and invalidates the earlier publication", () => publicationFixture((fixture, manifest) => {
  fixture.tool("inventory-positive-before-quarantine");
  const first = fixture.native(["campaign", "publish"], { ...fixture.input, manifest });
  assert.equal(first.status, "published");
  const before = fixture.native(["campaign", "inventory"], fixture.input);
  assert.equal(before.doctorInventoryHash, manifest.doctorInventoryHash);
  const source = path.join(fixture.cwd, ".supervised-worker", "runs", "foreign-report.bin");
  const payload = Buffer.from([0xff, 0x00, 0x7b, 0x7d]);
  fs.writeFileSync(source, payload);
  const proposed = quarantineProposal(fixture, source);
  const grant = authorizeFixtureProposal(fixture, proposed);
  const unusedGrantInventory = fixture.native(["campaign", "inventory"], fixture.input);
  assert.equal(unusedGrantInventory.doctorInventoryHash, before.doctorInventoryHash,
    "an unused authorization is not consumed recovery action evidence");
  assert.deepEqual(unusedGrantInventory.references, before.references);
  assert.equal(fixture.native(["campaign", "publish"], { ...fixture.input, manifest }).status, "already-published",
    "grant issuance alone cannot stale the prior action-evidence publication");
  const applied = fixture.native(["recovery", "apply"], { ...fixture.input, authorizationHash: grant.authorizationHash });
  assert.equal(applied.status, "applied");
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(fs.readFileSync(path.join(fixture.cwd, applied.locator)), payload);
  const after = fixture.native(["campaign", "inventory"], fixture.input);
  assert.notEqual(after.doctorInventoryHash, before.doctorInventoryHash, "the real applied action must change the release inventory");
  assert.throws(() => compileCampaignRelease(fixture.cwd, fixture.input, manifest, fixture.authority()), /RELEASE_DOCTOR_INVENTORY_CHANGED/);

  manifest.doctorInventoryHash = after.doctorInventoryHash;
  const publishCall = { tool_name: "run_in_terminal", tool_use_id: "inventory-publish-after-quarantine",
    tool_input: { command: "campaign publish fixture control" } };
  assert.notEqual(fixture.hook("PreToolUse", publishCall).permissionDecision, "deny");
  const second = fixture.native(["campaign", "publish"], { ...fixture.input, manifest });
  assert.equal(second.status, "published");
  assert.notEqual(second.sha256, first.sha256);
  assert.equal(fixture.hook("PostToolUse", publishCall).additionalContext, undefined);
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.cwd, second.locator)));
  const recovery = receipt.facts.find(fact => fact.name === "recovery");
  assert.equal(recovery.status, "recorded");
  const locators = new Set(recovery.references.map(reference => reference.locator));
  const actionRoot = `.supervised-worker/recovery/actions/${proposed.proposal.actionId}`;
  const quarantineBytes = fs.readFileSync(path.join(fixture.cwd, actionRoot, "quarantine.json"));
  assert.deepEqual(serializeQuarantineMetadata(JSON.parse(quarantineBytes)), quarantineBytes);
  for (const locator of [
    `${actionRoot}/intent.json`, `${actionRoot}/outcome.json`, `${actionRoot}/quarantine.json`,
    `.supervised-worker/recovery/authorizations/${grant.authorizationHash}.json`, applied.locator,
  ]) assert.ok(locators.has(locator), locator);
  assert.ok(!locators.has(".supervised-worker/recovery/head.json"), "moving hook state is not immutable action inventory");
  assert.equal(fixture.native(["campaign", "publish"], { ...fixture.input, manifest }).status, "already-published");
  assert.equal(fixture.native(["campaign", "inventory"], fixture.input).doctorInventoryHash, after.doctorInventoryHash);
  const inspect = () => observeReleaseDoctorInventory(fixture.cwd, fixture.input, fixture.authority());
  for (const [locator, mutate] of [
    [`${actionRoot}/intent.json`, bytes => {
      const value = JSON.parse(bytes);
      value.authorizationHash = "f".repeat(64);
      return serializeRecovery(value, "actionIntent");
    }],
    [`${actionRoot}/outcome.json`, bytes => {
      const value = JSON.parse(bytes);
      value.proposalHash = "f".repeat(64);
      return serializeRecovery(value, "actionReceipt");
    }],
    [`${actionRoot}/quarantine.json`, bytes => {
      const changed = Buffer.from(`${JSON.stringify(JSON.parse(bytes), null, 2)}\n`);
      assert.ok(!changed.equals(bytes), "the metadata's representation, not its meaning, must change");
      return changed;
    }],
    [applied.locator, () => Buffer.from("changed opaque payload")],
  ]) {
    const file = path.join(fixture.cwd, locator);
    const original = fs.readFileSync(file);
    try {
      fs.writeFileSync(file, mutate(original));
      assert.throws(inspect, /RELEASE_RECOVERY_BUNDLE_INVALID/, locator);
    } finally {
      fs.writeFileSync(file, original);
    }
    assert.equal(inspect().doctorInventoryHash, after.doctorInventoryHash, "restored exact evidence must reproduce its inventory hash");
  }
  const unexpected = path.join(fixture.cwd, actionRoot, "unrecognized.json");
  fs.writeFileSync(unexpected, "{}");
  try {
    assert.throws(inspect, /RELEASE_RECOVERY_BUNDLE_INVALID/);
  } finally {
    fs.rmSync(unexpected);
  }
  assert.equal(inspect().doctorInventoryHash, after.doctorInventoryHash);
}));

test("reliability: publication preserves the real campaign-owner handoff cleanliness consumer", () => publicationFixture((fixture, manifest) => {
  fs.appendFileSync(path.join(fixture.cwd, "README.md"), "Reviewed fixture candidate.\n");
  doctorGit(fixture.cwd, ["add", "README.md"]);
  doctorGit(fixture.cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "candidate"]);
  const candidate = resolveCommittedCandidate(fixture.cwd, doctorGit(fixture.cwd, ["rev-parse", "HEAD"]).trim());
  Object.assign(manifest.candidate, candidate);
  const workflow = resolveWorkflowRoles(fixture.cwd, { requireAcceptance: true });
  const directory = path.join(fixture.cwd, ".supervised-worker", "handoffs", sha256("one"));
  fs.mkdirSync(directory, { recursive: true });
  const load = (name) => JSON.parse(fs.readFileSync(path.join(reliabilitySourceRoot, "examples", `handoff.${name}.json`)));
  const contract = { ...load("build-contract"), itemId: "one", workflowHash: workflow.workflowHash,
    producedBy: workflow.roles.architect, targetFiles: ["README.md"] };
  const contractBytes = Buffer.from(JSON.stringify(contract));
  const contractPath = path.join(directory, "build-contract.json");
  const buildPath = path.join(directory, "build-report.json");
  fs.writeFileSync(contractPath, contractBytes);
  fs.writeFileSync(buildPath, JSON.stringify({ ...load("build-report"), itemId: "one", workflowHash: workflow.workflowHash,
    producedBy: workflow.roles.builder, contractHash: sha256(contractBytes), changedFiles: ["README.md"], testedTreeHash: candidate.tree,
    checks: [...contract.focusedChecks, contract.broadGate].map((command) => ({
      command, outcome: "passed", evidence: { kind: "test-output", locator: "fixture:consumer-control" },
    })) }));
  const verify = () => verifyBuildHandoff(fixture.cwd, contractPath, buildPath, null, candidate);
  assert.equal(verify().ok, true, JSON.stringify(verify()));
  const receipt = fixture.native(["campaign", "publish"], { ...fixture.input, manifest });
  assert.equal(receipt.status, "published");
  assert.equal(fixture.native(["campaign", "publish"], { ...fixture.input, manifest }).status, "already-published");
  assert.equal(verify().ok, true, JSON.stringify(verify()));
  assert.equal(fixture.native(["handoff", "pre-review", contractPath, buildPath, "--committed", candidate.commit], fixture.input).ok, true);
  const obsolete = path.join(fixture.cwd, "logs", "gates", "supervised-worker", "releases", `${receipt.sha256}.json`);
  fs.mkdirSync(path.dirname(obsolete), { recursive: true });
  fs.copyFileSync(path.join(fixture.cwd, receipt.locator), obsolete);
  assert.equal(verify().ok, false);
  assert.ok(verify().errors.some((value) => /untracked files/.test(value)), JSON.stringify(verify()));
}));

test("reliability: exact quarantine preserves journals through diagnosis compile tool checkpoint and fresh resume", () => publicationFixture((fixture, manifest) => {
  fixture.tool("before-quarantine-control");
  const original = journals(fixture);
  const source = path.join(fixture.cwd, ".supervised-worker", "runs", "foreign-report.json");
  const bytes = Buffer.from(`{"report":"${"x".repeat(262_144)}"}\n`);
  fs.writeFileSync(source, bytes);
  assert.equal(fs.statSync(source).size, bytes.length, "the foreign-file fault must be present");
  const denied = fixture.hook("PreToolUse", { tool_name: "read_file", tool_use_id: "foreign-file-denial",
    tool_input: { filePath: path.join(fixture.cwd, "README.md") } });
  assert.equal(denied.permissionDecision, "deny");
  assert.equal(denied.supervisorFailure.code, "JOURNAL_INTEGRITY");
  assert.ok(denied.supervisorFailure.diagnostics.includes("JOURNAL_OBSERVATION_UNCONFIRMED"));
  const diagnosis = fixture.executeDoctorInvocation(denied.recoveryInvocation);
  assert.ok(diagnosis.candidates.some((action) => action.kind === "quarantine-journal-entry"));
  const proposed = quarantineProposal(fixture, source);
  const grant = authorizeFixtureProposal(fixture, proposed);
  const result = fixture.doctor({ operation: "recover-authorized", authorizationHash: grant.authorizationHash });
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert.equal(result.locator, `.supervised-worker/recovery/quarantine/${proposed.proposal.actionId}/${sha256(bytes)}.quarantined`);
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(fs.readFileSync(path.join(fixture.cwd, result.locator)), bytes);
  assert.deepEqual(journals(fixture), original, "quarantine must not append, rewrite, or remove any journal");
  const metadata = JSON.parse(fs.readFileSync(path.join(fixture.cwd, ".supervised-worker", "recovery", "actions", proposed.proposal.actionId, "quarantine.json")));
  assert.deepEqual(validateArtifactPublication(metadata, "quarantineIntent"), []);
  assert.deepEqual(metadata.ancestors.map((value) => value.path),
    [".", ".supervised-worker", ".supervised-worker/recovery", ".supervised-worker/recovery/quarantine",
      `.supervised-worker/recovery/quarantine/${proposed.proposal.actionId}`]);
  const fresh = fixture.doctor({ operation: "diagnose" });
  assert.equal(fresh.healthy, true, JSON.stringify(fresh));
  assert.ok(fresh.capacity.recovery, "a bounded quarantined artifact must not make recovery accounting unreadable");
  // The recovered action is now part of release evidence; the pre-recovery
  // inventory cannot silently authorize a post-recovery publication.
  assert.throws(() => compileCampaignRelease(fixture.cwd, fixture.input, manifest, fixture.authority()), /RELEASE_DOCTOR_INVENTORY_CHANGED/);
  manifest.doctorInventoryHash = fixture.native(["campaign", "inventory"], fixture.input).doctorInventoryHash;
  assert.doesNotThrow(() => compileCampaignRelease(fixture.cwd, fixture.input, manifest, fixture.authority()));
  assert.equal(fixture.native(["campaign", "publish"], { ...fixture.input, manifest }).status, "published");
  assert.deepEqual(fixture.doctor({ operation: "recover-authorized", authorizationHash: grant.authorizationHash }), result);
  fixture.tool("after-quarantine");
  const checkpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan), attachmentHash: fixture.observe().attachmentHash });
  fixture.select("quarantine-successor");
  assert.equal(fixture.native(["resume"], { ...fixture.input, ...checkpoint.resume }).status, "resumed");
  fixture.tool("after-quarantine-handoff");
  assert.equal(summarizeRunLedger(fixture.cwd).status, "available");
  for (const [name, prefix] of Object.entries(original)) {
    assert.deepEqual(journals(fixture)[name].subarray(0, prefix.length), prefix, "subsequent native activity must be append-only");
  }
}));

for (const mode of ["before-move", "after-move", "readback", "fsync", "lost-outcome", "ancestor-replaced", "destination-conflict"]) {
  test(`reliability: quarantine ${mode} retains exact evidence and never replays an unknown move`, () => withReliabilityFixture((fixture) => {
    fixture.tool("quarantine-fault-positive");
    const originalJournals = journals(fixture);
    const source = path.join(fixture.cwd, ".supervised-worker", "runs", "foreign.json");
    const bytes = Buffer.from('{"fixture":"preserve these exact bytes"}\n');
    fs.writeFileSync(source, bytes);
    const proposed = quarantineProposal(fixture, source);
    const grant = authorizeFixtureProposal(fixture, proposed);
    const destination = path.join(fixture.cwd, ".supervised-worker", "recovery", "quarantine", proposed.proposal.actionId, `${sha256(bytes)}.quarantined`);
    const outcome = path.join(fixture.cwd, ".supervised-worker", "recovery", "actions", proposed.proposal.actionId, "outcome.json");
    const originals = { renameSync: fs.renameSync, openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, fsyncSync: fs.fsyncSync };
    const descriptors = new Map();
    let fired = false;
    let moved = false;
    let moves = 0;
    fs.openSync = (target, ...args) => {
      const descriptor = originals.openSync(target, ...args);
      if (target === destination) descriptors.set(descriptor, target);
      return descriptor;
    };
    fs.closeSync = (descriptor) => { descriptors.delete(descriptor); return originals.closeSync(descriptor); };
    fs.readSync = (descriptor, ...args) => {
      if (mode === "readback" && moved && !fired && descriptors.has(descriptor)) {
        fired = true;
        throw Object.assign(new Error("injected quarantine readback"), { code: "EIO" });
      }
      return originals.readSync(descriptor, ...args);
    };
    fs.fsyncSync = (descriptor) => {
      if (mode === "fsync" && moved && !fired && descriptors.has(descriptor)) {
        fired = true;
        throw Object.assign(new Error("injected quarantine durability failure"), { code: "ENOSPC" });
      }
      return originals.fsyncSync(descriptor);
    };
    fs.renameSync = (from, to) => {
      if (to === outcome && mode === "lost-outcome" && !fired) {
        fired = true;
        throw Object.assign(new Error("injected outcome loss"), { code: "EIO" });
      }
      if (to === destination && from === source) {
        if (mode === "before-move") {
          fired = true;
          throw Object.assign(new Error("injected move failure"), { code: "EXDEV" });
        }
        if (mode === "ancestor-replaced") {
          fired = true;
          originals.renameSync(path.dirname(destination), `${path.dirname(destination)}.retained`);
          fs.mkdirSync(path.dirname(destination));
        }
        originals.renameSync(from, to);
        moved = true;
        moves += 1;
        if (mode === "after-move") {
          fired = true;
          throw Object.assign(new Error("injected lost move response"), { code: "EIO" });
        }
        return;
      }
      const result = originals.renameSync(from, to);
      if (mode === "destination-conflict" && String(to).endsWith(`${path.sep}quarantine.json`) && !fired) {
        fired = true;
        fs.writeFileSync(destination, "unrelated destination");
      }
      return result;
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => applyRecovery(fixture.cwd, { ...fixture.input, authorizationHash: grant.authorizationHash }, fixture.authority()));
    } finally {
      Object.assign(fs, originals);
      syncBuiltinESMExports();
    }
    assert.equal(fired, true, `${mode} must reach its injected boundary`);
    assert.deepEqual(journals(fixture), originalJournals);
    assert.equal(fs.existsSync(outcome), false);
    const recoverable = ["after-move", "readback", "fsync", "lost-outcome"].includes(mode);
    const retry = fixture.native(["recovery", "apply"], { ...fixture.input, authorizationHash: grant.authorizationHash }, recoverable ? 0 : 1);
    assert.equal(retry.status, recoverable ? "applied" : "blocked", JSON.stringify(retry));
    assert.equal(moves, moved ? 1 : 0);
    assert.deepEqual(journals(fixture), originalJournals);
    if (recoverable) {
      assert.deepEqual(fs.readFileSync(destination), bytes);
      assert.equal(fs.existsSync(source), false);
      assert.deepEqual(fixture.native(["recovery", "apply"], { ...fixture.input, authorizationHash: grant.authorizationHash }), retry);
      fixture.tool(`after-quarantine-${mode}`);
    } else {
      assert.deepEqual(fs.readFileSync(moved ? destination : source), bytes);
      if (mode === "destination-conflict") assert.equal(fs.readFileSync(destination, "utf8"), "unrelated destination");
    }
  }));
}

test("reliability: quarantine never admits journals partial kernel files links directories or oversized payloads", () => withReliabilityFixture((fixture) => {
  fixture.tool("quarantine-ineligible-positive");
  const runRoot = path.join(fixture.cwd, ".supervised-worker", "runs");
  const originalJournals = journals(fixture);
  for (const kind of ["journal", "partial", "directory", "hardlink", "symlink", "oversized"]) {
    const name = kind === "journal" ? `${"a".repeat(64)}.jsonl` : kind === "partial" ? "publication.json.tmp" : `${kind}.json`;
    const target = path.join(runRoot, name);
    const outside = path.join(fixture.base, `${kind}-evidence.json`);
    if (kind === "symlink") fs.mkdirSync(outside);
    else fs.writeFileSync(outside, "{}\n");
    if (kind === "directory") fs.mkdirSync(target);
    else if (kind === "hardlink") fs.linkSync(outside, target);
    else if (kind === "symlink") fs.symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
    else fs.writeFileSync(target, kind === "oversized" ? Buffer.alloc(4_194_305, 32) : "{}\n");
    try {
      assert.equal(fs.lstatSync(target).isDirectory(), kind === "directory");
      if (kind === "symlink") assert.equal(fs.lstatSync(target).isSymbolicLink(), true, "a real junction/link must be created, not skipped");
      const diagnosis = fixture.doctor({ operation: "diagnose" });
      assert.equal(diagnosis.candidates.some((action) => action.kind === "quarantine-journal-entry"), false, kind);
    } finally { fs.rmSync(target, { recursive: true, force: true }); }
    assert.deepEqual(journals(fixture), originalJournals);
  }
}));

test("reliability: obsolete logs/gates publication conflicts with the unchanged compiler untracked-source invariant", () => publicationFixture((fixture, manifest) => {
  const receipt = compileCampaignRelease(fixture.cwd, fixture.input, manifest, fixture.authority());
  const bytes = Buffer.from(serializeCampaignRelease(receipt));
  const destination = path.join(fixture.cwd, "logs", "gates", "supervised-worker", "releases", `${sha256(bytes)}.json`);
  assert.doesNotThrow(() => compileCampaignRelease(fixture.cwd, fixture.input, manifest, fixture.authority()),
    "the same manifest and candidate must pass before the canonical output exists");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  assert.throws(() => compileCampaignRelease(fixture.cwd, fixture.input, manifest, fixture.authority()), /RELEASE_SOURCE_UNTRACKED/,
    "the exact canonical receipt, not malformed input, causes the parent-owned compiler conflict");
}));

test("reliability: campaign publication preserves the accepted target-CI policy and honest unavailable provider status", () => publicationFixture((fixture, manifest, add) => {
  const commit = manifest.candidate.commit;
  const workflowHash = resolveWorkflowRoles(fixture.cwd, { requireAcceptance: true }).workflowHash;
  const provider = { schemaVersion: 1, kind: "release-provider-observation", integrity: "unattested", actorHash: "a".repeat(64),
    repositoryHash: "b".repeat(64), commit, ref: manifest.candidate.ref, observedAt: "2026-01-01T00:00:00.000Z",
    complete: true, remoteCommit: null, closures: [], ci: { kind: "repository-ci", workflowHash, runId: 42, commit, complete: true, conclusion: "success",
      jobs: [{ name: "unit", commit, conclusion: "success", steps: [{ name: "test", status: "completed", conclusion: "success" }] }] } };
  add("provider", provider);
  const published = fixture.native(["campaign", "publish"], { ...fixture.input, manifest });
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.cwd, published.locator)));
  assert.equal(receipt.facts.find((fact) => fact.name === "ci").status, "recorded");
  assert.equal(receipt.dispositions.provider, "unavailable");
  const matrix = { runId: 1, commit, complete: true, conclusion: "success", jobs: ["ubuntu-latest", "macos-latest", "windows-latest"].flatMap((os) => [20, 22, 24].map((node) => ({
    name: `test (${os}, ${node})`, commit, conclusion: "success",
    steps: ["Run npm test", "Run npm run validate"].map((name) => ({ name, status: "completed", conclusion: "success" })),
  }))) };
  add("provider", { ...provider, ci: matrix });
  assert.equal(fixture.native(["campaign", "publish"], { ...fixture.input, manifest }, 1).status, "blocked");
  add("provider", { ...provider, ci: null });
  const unavailable = fixture.native(["campaign", "publish"], { ...fixture.input, manifest });
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.cwd, unavailable.locator))).facts.find((fact) => fact.name === "ci").status, "unavailable");
}, { configureWorkflow: (workflow) => { workflow.validation.ci = { requiredJobs: [{ name: "unit", requiredSteps: ["test"] }] }; } }));

for (const mode of ["before-rename", "after-rename", "fsync", "readback", "ancestor-replaced", "candidate-drift", "authority-drift"]) {
  test(`reliability: publication ${mode} failure is not a success and preserves recoverable campaign ownership`, () => publicationFixture((fixture, manifest, add) => {
    const baseline = publishCampaignRelease(fixture.cwd, { ...fixture.input, manifest }, fixture.authority());
    assert.equal(baseline.status, "published", JSON.stringify(baseline));
    timing(fixture, manifest, add);
    const candidate = Buffer.from(serializeCampaignRelease(compileCampaignRelease(fixture.cwd, fixture.input, manifest, fixture.authority())));
    const destination = path.join(fixture.cwd, ".supervised-worker", "releases", `${sha256(candidate)}.json`);
    assert.notEqual(path.basename(destination), path.basename(baseline.locator));
    const owner = fixture.observe();
    const originals = { renameSync: fs.renameSync, openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, fsyncSync: fs.fsyncSync };
    const descriptors = new Map();
    let fired = false;
    let renamed = false;
    fs.openSync = (target, ...args) => {
      const descriptor = originals.openSync(target, ...args);
      if (typeof target === "string" && target.includes(`${path.sep}releases${path.sep}`)) descriptors.set(descriptor, target);
      return descriptor;
    };
    fs.closeSync = (descriptor) => { descriptors.delete(descriptor); return originals.closeSync(descriptor); };
    fs.fsyncSync = (descriptor) => {
      if (mode === "fsync" && !fired && descriptors.has(descriptor)) { fired = true; throw Object.assign(new Error("injected fsync"), { code: "ENOSPC" }); }
      return originals.fsyncSync(descriptor);
    };
    fs.readSync = (descriptor, ...args) => {
      if (mode === "readback" && renamed && !fired && descriptors.get(descriptor) === destination) { fired = true; throw Object.assign(new Error("injected readback"), { code: "EIO" }); }
      return originals.readSync(descriptor, ...args);
    };
    fs.renameSync = (source, target) => {
      if (target === destination) {
        if (mode === "before-rename") { fired = true; throw Object.assign(new Error("injected publish"), { code: "ENOSPC" }); }
        if (mode === "ancestor-replaced") {
          fired = true;
          originals.renameSync(path.dirname(destination), `${path.dirname(destination)}.retained`);
          fs.mkdirSync(path.dirname(destination));
        }
        if (mode === "candidate-drift") {
          fired = true;
          doctorGit(fixture.cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-qm", "candidate advanced"]);
        }
        if (mode === "authority-drift") {
          fired = true;
          const attachment = path.join(fixture.cwd, ".supervised-worker", "attachment.json");
          const bytes = fs.readFileSync(attachment);
          originals.renameSync(attachment, `${attachment}.retained`);
          fs.writeFileSync(attachment, bytes);
        }
        originals.renameSync(source, target);
        renamed = true;
        if (mode === "after-rename") { fired = true; throw Object.assign(new Error("injected post-publish"), { code: "EIO" }); }
        return;
      }
      return originals.renameSync(source, target);
    };
    syncBuiltinESMExports();
    let result;
    try { result = publishCampaignRelease(fixture.cwd, { ...fixture.input, manifest }, fixture.authority()); }
    finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
    assert.equal(fired, true, `${mode} must reach the intended fault boundary`);
    assert.ok(["unconfirmed", "conflict"].includes(result.status), JSON.stringify(result));
    assert.deepEqual(fixture.observe(), owner);
    if (!["candidate-drift", "ancestor-replaced", "authority-drift"].includes(mode)) {
      const retry = publishCampaignRelease(fixture.cwd, { ...fixture.input, manifest }, fixture.authority());
      assert.ok(["published", "already-published"].includes(retry.status), JSON.stringify(retry));
      assert.deepEqual(fs.readFileSync(destination), candidate);
    }
  }));
}

test("reliability: publication rejects conflicting bytes, unsafe ancestors and caller-selected destinations", () => publicationFixture((fixture, manifest) => {
  const request = { ...fixture.input, manifest };
  assert.equal(publishCampaignRelease(fixture.cwd, { ...request, destination: "other.json" }, fixture.authority()).status, "blocked");
  const result = publishCampaignRelease(fixture.cwd, request, fixture.authority());
  assert.equal(result.status, "published");
  const target = path.join(fixture.cwd, result.locator);
  fs.writeFileSync(target, "different bytes");
  assert.equal(publishCampaignRelease(fixture.cwd, request, fixture.authority()).status, "conflict");
  assert.equal(fs.readFileSync(target, "utf8"), "different bytes");
  const directory = path.dirname(target);
  fs.renameSync(directory, `${directory}.retained`);
  const outside = path.join(fixture.base, "outside-publication");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
  assert.notEqual(publishCampaignRelease(fixture.cwd, request, fixture.authority()).status, "published");
  assert.deepEqual(fs.readdirSync(outside), []);
}));
