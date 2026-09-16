import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { sha256, validateArtifactPublication } from "../src/core.mjs";
import { doctorGit } from "../src/doctor-repair.mjs";
import { applyRecovery } from "../src/recovery.mjs";
import { serializeQuarantineMetadata, serializeRecovery } from "../src/recovery-state.mjs";
import { withReliabilityFixture } from "./reliability-fixture.mjs";
import { authorizeFixtureProposal } from "./recovery-action-fixture.mjs";

const clockOffset = 660_000;
const ajv = new Ajv2020({ strictTypes: false, strictRequired: false });
addFormats(ajv);
const schemaRoot = new URL("../schemas/", import.meta.url);
for (const file of fs.readdirSync(schemaRoot).filter(name => name.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(fs.readFileSync(new URL(file, schemaRoot))));
}
const metadataSchema = ajv.getSchema("https://supervised-worker.dev/schemas/artifact-publication.schema.json#/$defs/quarantineIntent");

function clockedInvocation(fixture, args) {
  const cli = path.join(fixture.installRoot, "src", "cli.mjs");
  return `
    const realNow = Date.now;
    Date.now = () => realNow() + ${clockOffset};
    process.chdir(${JSON.stringify(fixture.cwd)});
    process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(pathToFileURL(cli).href)});
  `;
}

function nativeAt(fixture, args, request, expectedExit = 0) {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", clockedInvocation(fixture, args)], {
    cwd: fixture.cwd, input: JSON.stringify(request), encoding: "utf8", timeout: 30_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, expectedExit, child.stdout || child.stderr);
  return JSON.parse(child.stdout);
}

function concurrentApply(fixture, authorizationHash) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", clockedInvocation(fixture, ["recovery", "apply"])],
      { cwd: fixture.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("bounded confirmation process timed out")); }, 30_000);
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(signal, null, stderr);
        assert.ok([0, 1].includes(code), stdout || stderr);
        resolve(JSON.parse(stdout));
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ ...fixture.input, authorizationHash }));
  });
}

function incompleteQuarantine(fixture, failOutcome = true, otherForeign = null) {
  fixture.tool("confirmation-positive-before-fault");
  if (otherForeign !== null) fs.writeFileSync(otherForeign.path, otherForeign.bytes);
  const payload = Buffer.from([0xff, 0x00, 0x41, 0x7f]);
  const source = path.join(fixture.cwd, ".supervised-worker", "runs", "misplaced.bin");
  fs.writeFileSync(source, payload);
  const diagnosed = fixture.doctor({ operation: "diagnose" });
  const action = diagnosed.candidates.find(value => value.kind === "quarantine-journal-entry");
  assert.ok(action);
  const proposed = fixture.doctor({ operation: "propose-recovery", expectedHash: diagnosed.observationHash, action });
  const grant = authorizeFixtureProposal(fixture, proposed);
  const directory = path.join(fixture.cwd, ".supervised-worker", "recovery", "actions", proposed.proposal.actionId);
  const outcome = path.join(directory, "outcome.json");
  const destination = path.join(fixture.cwd, ".supervised-worker", "recovery", "quarantine",
    proposed.proposal.actionId, `${sha256(payload)}.quarantined`);
  const originalRename = fs.renameSync;
  let faultFired = false;
  let failure;
  let result;
  fs.renameSync = (from, to) => {
    if (failOutcome && to === outcome) {
      faultFired = true;
      throw Object.assign(new Error("injected lost outcome publication"), { code: "EIO" });
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    try {
      result = applyRecovery(fixture.cwd, { ...fixture.input, authorizationHash: grant.authorizationHash }, fixture.authority());
    } catch (error) {
      failure = error;
    }
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(faultFired, failOutcome, `the move must finish before the outcome fault: ${failure?.stack}`);
  if (!failOutcome) assert.equal(result?.status, "applied", failure?.stack);
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(fs.readFileSync(destination), payload);
  assert.equal(fs.existsSync(outcome), !failOutcome);
  return { payload, source, destination, directory, outcome, proposed, grant };
}

function confirmationProposal(fixture) {
  const diagnosis = nativeAt(fixture, ["recovery", "inspect"], fixture.input);
  assert.equal(diagnosis.healthy, false, "missing receipt must remain visible after grant expiry");
  assert.ok(diagnosis.observation.diagnostics.includes("RECOVERY_PERSISTENCE_UNCONFIRMED"));
  const action = diagnosis.candidates.find(value => value.kind === "confirm-completed-action");
  assert.ok(action, JSON.stringify(diagnosis));
  return nativeAt(fixture, ["recovery", "propose"], { ...fixture.input, expectedHash: diagnosis.observationHash, action });
}

test("reliability: expired lost-outcome quarantine is confirmed with fresh authorization and zero payload effects", () => withReliabilityFixture(fixture => {
  doctorGit(fixture.cwd, ["init", "--quiet", "--initial-branch=main"]);
  doctorGit(fixture.cwd, ["add", "README.md", ".github/supervised-worker.json"]);
  doctorGit(fixture.cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
  const commit = doctorGit(fixture.cwd, ["rev-parse", "HEAD"]).trim();
  const manifest = { schemaVersion: 1, kind: "campaign-release-input",
    candidate: { commit, tree: doctorGit(fixture.cwd, ["rev-parse", "HEAD^{tree}"]).trim(), baseCommit: commit, ref: "refs/heads/main" },
    artifacts: [{ role: "plan", reference: { locator: ".supervised-worker/plan.json",
      sha256: sha256(fs.readFileSync(path.join(fixture.cwd, ".supervised-worker", "plan.json"))) } }],
    doctorInventoryHash: fixture.native(["campaign", "inventory"], fixture.input).doctorInventoryHash };
  assert.equal(fixture.native(["campaign", "publish"], { ...fixture.input, manifest }).status, "published");
  const original = incompleteQuarantine(fixture);
  const expired = nativeAt(fixture, ["recovery", "apply"], { ...fixture.input, authorizationHash: original.grant.authorizationHash }, 1);
  assert.equal(expired.failure.code, "RECOVERY_AUTHORIZATION_REQUIRED");
  fixture.tool("legitimate-append-before-confirmation");
  const proposed = confirmationProposal(fixture);
  const grant = authorizeFixtureProposal(fixture, proposed, { clockOffset });
  const inventoryBefore = nativeAt(fixture, ["campaign", "inventory"], fixture.input);
  manifest.doctorInventoryHash = inventoryBefore.doctorInventoryHash;
  const publicationBefore = nativeAt(fixture, ["campaign", "publish"], { ...fixture.input, manifest });
  assert.equal(publicationBefore.status, "published");
  const realNow = Date.now;
  const originalRename = fs.renameSync;
  const originalWrite = fs.writeFileSync;
  const originalRemove = fs.rmSync;
  const originalCopy = fs.copyFileSync;
  const payloadPaths = new Set([original.source, original.destination]);
  const effects = [];
  Date.now = () => realNow() + clockOffset;
  fs.renameSync = (from, to) => {
    if (payloadPaths.has(from) || payloadPaths.has(to)) effects.push("rename");
    return originalRename(from, to);
  };
  fs.writeFileSync = (file, ...args) => {
    if (payloadPaths.has(file)) effects.push("write");
    return originalWrite(file, ...args);
  };
  fs.rmSync = (file, ...args) => {
    if (payloadPaths.has(file)) effects.push("remove");
    return originalRemove(file, ...args);
  };
  fs.copyFileSync = (from, to, ...args) => {
    if (payloadPaths.has(from) || payloadPaths.has(to)) effects.push("copy");
    return originalCopy(from, to, ...args);
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = applyRecovery(fixture.cwd, { ...fixture.input, authorizationHash: grant.authorizationHash }, fixture.authority());
  } finally {
    Date.now = realNow;
    fs.renameSync = originalRename;
    fs.writeFileSync = originalWrite;
    fs.rmSync = originalRemove;
    fs.copyFileSync = originalCopy;
    syncBuiltinESMExports();
  }
  assert.deepEqual(effects, []);
  assert.equal(result.status, "confirmed-complete");
  assert.equal(result.effect, "receipt-only");
  assert.equal(result.targetActionId, original.proposed.proposal.actionId);
  assert.equal(result.actionId, proposed.proposal.actionId);
  assert.equal(result.postStateHash, proposed.proposal.expectedHash);
  assert.equal(result.originalAuthorizationHash, original.grant.authorizationHash);
  assert.equal(fs.existsSync(original.outcome), false);
  assert.equal(fs.existsSync(path.join(original.directory, "..", result.actionId)), false, "confirmation cannot create another pending generic action");
  assert.deepEqual(fs.readFileSync(original.destination), original.payload);
  assert.deepEqual(nativeAt(fixture, ["recovery", "apply"], { ...fixture.input, authorizationHash: grant.authorizationHash }), result);
  const after = nativeAt(fixture, ["recovery", "inspect"], fixture.input);
  assert.equal(after.candidates.some(action => action.kind === "confirm-completed-action"), false);
  assert.equal(after.healthy, true, JSON.stringify(after.observation.diagnostics));
  const inventoryAfter = nativeAt(fixture, ["campaign", "inventory"], fixture.input);
  assert.notEqual(inventoryAfter.doctorInventoryHash, inventoryBefore.doctorInventoryHash);
  assert.equal(nativeAt(fixture, ["campaign", "publish"], { ...fixture.input, manifest }, 1).status, "blocked");
  manifest.doctorInventoryHash = inventoryAfter.doctorInventoryHash;
  const published = nativeAt(fixture, ["campaign", "publish"], { ...fixture.input, manifest });
  assert.notEqual(published.sha256, publicationBefore.sha256);
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.cwd, published.locator)));
  const recovery = receipt.facts.find(fact => fact.name === "recovery");
  assert.equal(recovery.status, "recorded");
  const confirmationPath = `.supervised-worker/recovery/actions/${result.targetActionId}/confirmation.json`;
  const reference = recovery.references.find(entry => entry.locator === confirmationPath);
  assert.equal(reference?.sha256, sha256(fs.readFileSync(path.join(fixture.cwd, confirmationPath))));
  for (const hash of [result.authorizationHash, result.originalAuthorizationHash]) {
    assert.ok(recovery.references.some(entry => entry.locator === `.supervised-worker/recovery/authorizations/${hash}.json`));
  }
  assert.equal(nativeAt(fixture, ["campaign", "publish"], { ...fixture.input, manifest }).status, "already-published");
  const retainedPayload = path.join(fixture.base, "confirmed-payload-retained");
  fs.renameSync(original.destination, retainedPayload);
  fs.writeFileSync(original.destination, original.payload);
  try {
    assert.notEqual(fs.statSync(original.destination, { bigint: true }).ino, fs.statSync(retainedPayload, { bigint: true }).ino,
      "the replacement must actually have a distinct filesystem identity");
    assert.equal(nativeAt(fixture, ["recovery", "inspect"], fixture.input).healthy, false);
    assert.equal(nativeAt(fixture, ["campaign", "inventory"], fixture.input, 1).ok, false);
    assert.equal(nativeAt(fixture, ["campaign", "publish"], { ...fixture.input, manifest }, 1).status, "blocked");
  } finally {
    fs.rmSync(original.destination);
    fs.renameSync(retainedPayload, original.destination);
  }
  const confirmationBytes = fs.readFileSync(path.join(fixture.cwd, confirmationPath));
  try {
    fs.writeFileSync(path.join(fixture.cwd, confirmationPath),
      serializeRecovery({ ...result, targetIntentHash: "f".repeat(64) }, "actionConfirmation"));
    assert.equal(nativeAt(fixture, ["campaign", "inventory"], fixture.input, 1).ok, false);
  } finally {
    fs.writeFileSync(path.join(fixture.cwd, confirmationPath), confirmationBytes);
  }
}));

test("reliability: duplicate-root metadata cannot hide a replaced quarantine ancestor", () => withReliabilityFixture(fixture => {
  const original = incompleteQuarantine(fixture);
  confirmationProposal(fixture);
  const metadataPath = path.join(original.directory, "quarantine.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath));
  assert.deepEqual(validateArtifactPublication(metadata, "quarantineIntent"), []);
  assert.equal(metadataSchema(metadata), true, JSON.stringify(metadataSchema.errors));
  const wrongActionPath = structuredClone(metadata);
  wrongActionPath.ancestors[4].path = ".supervised-worker/recovery/quarantine/11111111-1111-4111-8111-111111111111";
  assert.throws(() => serializeQuarantineMetadata(wrongActionPath), /RECOVERY_RECORD_INVALID/,
    "the final path must name this action, not merely a structurally valid UUID");
  const directory = path.dirname(original.destination);
  const oldIno = fs.statSync(directory, { bigint: true }).ino;
  const payloadIno = fs.statSync(original.destination, { bigint: true }).ino;
  const retainedDirectory = path.join(fixture.base, "retained-quarantine-directory");
  fs.renameSync(directory, retainedDirectory);
  fs.mkdirSync(directory);
  fs.renameSync(path.join(retainedDirectory, path.basename(original.destination)), original.destination);
  assert.notEqual(fs.statSync(directory, { bigint: true }).ino, oldIno);
  assert.equal(fs.statSync(original.destination, { bigint: true }).ino, payloadIno);
  metadata.ancestors = Array.from({ length: 5 }, () => structuredClone(metadata.ancestors[0]));
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  fs.writeFileSync(metadataPath, `${JSON.stringify(canonical(metadata))}\n`);
  assert.ok(validateArtifactPublication(metadata, "quarantineIntent").length > 0);
  assert.equal(metadataSchema(metadata), false);
  const diagnosis = nativeAt(fixture, ["recovery", "inspect"], fixture.input);
  assert.equal(diagnosis.healthy, false);
  assert.equal(diagnosis.candidates.some(action => action.kind === "confirm-completed-action"), false);
  assert.equal(nativeAt(fixture, ["campaign", "inventory"], fixture.input, 1).ok, false);
  assert.equal(fs.existsSync(path.join(original.directory, "confirmation.json")), false);
}));

test("reliability: applied quarantine with missing payload is unhealthy and cannot enter release evidence", () => withReliabilityFixture(fixture => {
  const original = incompleteQuarantine(fixture, false);
  assert.equal(JSON.parse(fs.readFileSync(original.outcome)).status, "applied");
  assert.equal(nativeAt(fixture, ["recovery", "inspect"], fixture.input).healthy, true);
  for (const mode of ["extra-member", "orphan-directory", "missing-member"]) {
    const extra = mode === "orphan-directory"
      ? path.join(path.dirname(path.dirname(original.destination)), "22222222-2222-4222-8222-222222222222", `${sha256("extra")}.quarantined`)
      : path.join(path.dirname(original.destination), `${sha256("extra")}.quarantined`);
    const retained = path.join(fixture.base, "retained-applied-payload");
    if (mode === "missing-member") fs.renameSync(original.destination, retained);
    else {
      fs.mkdirSync(path.dirname(extra), { recursive: true });
      fs.writeFileSync(extra, "extra");
    }
    try {
      const diagnosis = nativeAt(fixture, ["recovery", "inspect"], fixture.input);
      assert.equal(diagnosis.healthy, false, mode);
      assert.equal(diagnosis.observation.status, "incomplete", mode);
      assert.ok(diagnosis.observation.diagnostics.includes("RECOVERY_PERSISTENCE_UNCONFIRMED"));
      assert.equal(nativeAt(fixture, ["campaign", "inventory"], fixture.input, 1).ok, false, mode);
    } finally {
      if (mode === "missing-member") fs.renameSync(retained, original.destination);
      else {
        fs.rmSync(extra);
        if (mode === "orphan-directory") fs.rmdirSync(path.dirname(extra));
      }
    }
    assert.equal(nativeAt(fixture, ["recovery", "inspect"], fixture.input).healthy, true, `${mode} restoration`);
  }
}));

for (const order of ["confirm-first", "quarantine-second-first"]) {
  test(`reliability: two foreign entries retain independent confirmation evidence (${order})`, () => withReliabilityFixture(fixture => {
    const second = { path: path.join(fixture.cwd, ".supervised-worker", "runs", "second-foreign.bin"), bytes: Buffer.from("another preserved entry") };
    const original = incompleteQuarantine(fixture, true, second);
    const applySecond = () => {
      const diagnosis = nativeAt(fixture, ["recovery", "inspect"], fixture.input);
      const action = diagnosis.candidates.find(value => value.kind === "quarantine-journal-entry");
      assert.ok(action, "the second independent foreign entry must still be quarantinable");
      const proposed = nativeAt(fixture, ["recovery", "propose"], { ...fixture.input, expectedHash: diagnosis.observationHash, action });
      const grant = authorizeFixtureProposal(fixture, proposed, { clockOffset });
      const result = nativeAt(fixture, ["recovery", "apply"], { ...fixture.input, authorizationHash: grant.authorizationHash });
      assert.equal(result.status, "applied");
      assert.equal(fs.existsSync(second.path), false);
      assert.deepEqual(fs.readFileSync(path.join(fixture.cwd, result.locator)), second.bytes);
    };
    if (order === "quarantine-second-first") applySecond();
    else assert.deepEqual(fs.readFileSync(second.path), second.bytes);
    const proposed = confirmationProposal(fixture);
    const grant = authorizeFixtureProposal(fixture, proposed, { clockOffset });
    const confirmed = nativeAt(fixture, ["recovery", "apply"], { ...fixture.input, authorizationHash: grant.authorizationHash });
    assert.equal(confirmed.status, "confirmed-complete");
    assert.equal(confirmed.targetActionId, original.proposed.proposal.actionId);
    assert.deepEqual(fs.readFileSync(original.destination), original.payload);
    assert.equal(fs.existsSync(original.outcome), false);
    if (order === "confirm-first") applySecond();
    assert.equal(nativeAt(fixture, ["recovery", "inspect"], fixture.input).healthy, true);
    const inventory = nativeAt(fixture, ["campaign", "inventory"], fixture.input);
    assert.ok(inventory.references.some(reference => reference.locator.endsWith("/confirmation.json")));
    assert.equal(inventory.references.filter(reference => reference.locator.endsWith(".quarantined")).length, 2);
  }));
}

test("reliability: confirmation never proposes or performs a missing or replaced quarantine effect", () => withReliabilityFixture(fixture => {
  const original = incompleteQuarantine(fixture);
  const before = confirmationProposal(fixture);
  const grant = authorizeFixtureProposal(fixture, before, { clockOffset });
  for (const mode of ["source-reappeared", "payload-changed", "payload-missing", "same-byte-replacement", "journal-prefix-rewritten"]) {
    const retained = path.join(fixture.base, "retained-payload");
    const journalFile = path.join(fixture.cwd, ".supervised-worker", "runs", `${sha256(fixture.input.session_id)}.jsonl`);
    const originalJournal = fs.readFileSync(journalFile);
    if (mode === "source-reappeared") fs.writeFileSync(original.source, original.payload);
    else if (mode === "payload-changed") fs.writeFileSync(original.destination, "wrong payload");
    else if (mode === "journal-prefix-rewritten") {
      const records = originalJournal.toString().trim().split("\n").map(JSON.parse);
      records[0].at = "2020-01-01T00:00:00.000Z";
      fs.writeFileSync(journalFile, `${records.map(JSON.stringify).join("\n")}\n`);
    } else {
      fs.renameSync(original.destination, retained);
      if (mode === "same-byte-replacement") fs.writeFileSync(original.destination, original.payload);
    }
    try {
      const diagnosis = nativeAt(fixture, ["recovery", "inspect"], fixture.input);
      assert.equal(diagnosis.healthy, false, mode);
      assert.equal(diagnosis.candidates.some(action => action.kind === "confirm-completed-action"), false, mode);
      assert.equal(nativeAt(fixture, ["recovery", "apply"], { ...fixture.input, authorizationHash: grant.authorizationHash }, 1).status, "blocked", mode);
      assert.equal(fs.existsSync(path.join(original.directory, "confirmation.json")), false);
    } finally {
      if (mode === "source-reappeared") fs.rmSync(original.source);
      else if (mode === "payload-changed") fs.writeFileSync(original.destination, original.payload);
      else if (mode === "journal-prefix-rewritten") fs.writeFileSync(journalFile, originalJournal);
      else {
        if (fs.existsSync(original.destination)) fs.rmSync(original.destination);
        fs.renameSync(retained, original.destination);
      }
    }
    assert.deepEqual(fs.readFileSync(original.destination), original.payload);
    assert.ok(nativeAt(fixture, ["recovery", "inspect"], fixture.input).candidates.some(action => action.kind === "confirm-completed-action"),
      `${mode} fixture restoration must re-establish the completed effect premise`);
  }
}));

for (const stage of ["before-rename", "after-rename"]) {
  test(`reliability: ${stage} confirmation publication fault remains single-use without a payload replay`, () => withReliabilityFixture(fixture => {
    const original = incompleteQuarantine(fixture);
    const proposed = confirmationProposal(fixture);
    const grant = authorizeFixtureProposal(fixture, proposed, { clockOffset });
    const target = path.join(original.directory, "confirmation.json");
    const originalRename = fs.renameSync;
    const realNow = Date.now;
    let fired = false;
    let writes = 0;
    Date.now = () => realNow() + clockOffset;
    fs.renameSync = (from, to) => {
      assert.notEqual(to, original.destination, "confirmation cannot rerun the payload rename");
      assert.notEqual(from, original.source, "confirmation cannot consume a source");
      if (to === target) {
        fired = true;
        if (stage === "before-rename") throw Object.assign(new Error("injected confirmation write failure"), { code: "EIO" });
        originalRename(from, to);
        writes++;
        throw Object.assign(new Error("injected lost confirmation response"), { code: "EIO" });
      }
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => applyRecovery(fixture.cwd, { ...fixture.input, authorizationHash: grant.authorizationHash }, fixture.authority()));
    } finally {
      Date.now = realNow;
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
    }
    assert.equal(fired, true);
    assert.equal(writes, stage === "after-rename" ? 1 : 0);
    const prior = fs.existsSync(target) ? fs.readFileSync(target) : null;
    const retry = nativeAt(fixture, ["recovery", "apply"], { ...fixture.input, authorizationHash: grant.authorizationHash });
    assert.equal(retry.status, "confirmed-complete");
    if (prior) assert.deepEqual(fs.readFileSync(target), prior);
    assert.deepEqual(nativeAt(fixture, ["recovery", "apply"], { ...fixture.input, authorizationHash: grant.authorizationHash }), retry);
    assert.deepEqual(fs.readFileSync(original.destination), original.payload);
    assert.equal(fs.existsSync(original.source), false);
    assert.equal(fs.existsSync(original.outcome), false);
  }));
}

test("reliability: concurrent fresh confirmers preserve the original unconfirmed outcome and one receipt", () => withReliabilityFixture(async fixture => {
  const original = incompleteQuarantine(fixture);
  const unresolved = { schemaVersion: 1, kind: "recovery-action", actionId: original.proposed.proposal.actionId,
    authorizationHash: original.grant.authorizationHash, proposalHash: original.proposed.proposalHash,
    status: "unconfirmed", beforeHash: original.proposed.proposal.expectedHash, afterHash: null,
    frontierHash: null, locator: `.supervised-worker/recovery/quarantine/${original.proposed.proposal.actionId}/${sha256(original.payload)}.quarantined`,
    sha256: sha256(original.payload) };
  const outcomeBytes = serializeRecovery(unresolved, "actionReceipt");
  fs.writeFileSync(original.outcome, outcomeBytes);
  const firstProposal = confirmationProposal(fixture);
  const firstGrant = authorizeFixtureProposal(fixture, firstProposal, { clockOffset });
  const secondProposal = confirmationProposal(fixture);
  const secondGrant = authorizeFixtureProposal(fixture, secondProposal, { clockOffset });
  assert.notEqual(firstProposal.proposal.actionId, secondProposal.proposal.actionId);
  const results = await Promise.all([
    concurrentApply(fixture, firstGrant.authorizationHash),
    concurrentApply(fixture, secondGrant.authorizationHash),
  ]);
  const confirmed = results.filter(result => result.status === "confirmed-complete");
  assert.equal(confirmed.length, 1, JSON.stringify(results));
  assert.equal(results.filter(result => result.status === "blocked").length, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(original.directory, "confirmation.json")));
  assert.deepEqual(receipt, confirmed[0]);
  assert.deepEqual(fs.readFileSync(original.outcome), outcomeBytes);
  assert.deepEqual(fs.readFileSync(original.destination), original.payload);
  assert.equal(fs.existsSync(original.source), false);
  const actionDirectories = fs.readdirSync(path.dirname(original.directory));
  assert.deepEqual(actionDirectories, [original.proposed.proposal.actionId]);
}));
