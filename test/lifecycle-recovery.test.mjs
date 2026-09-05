import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { canonicalPlanHash, inspectLifecycleLock, recoverLifecycleLock, sha256, validateLifecycle } from "../src/core.mjs";

const launcherPath = fileURLToPath(new URL("../src/hook-launcher.mjs", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const coreUrl = new URL("../src/core.mjs", import.meta.url).href;
const faultingHookScript = `
  import assert from "node:assert/strict";
  import fs from "node:fs";
  import path from "node:path";
  import { syncBuiltinESMExports } from "node:module";
  import { performance } from "node:perf_hooks";

  const input = JSON.parse(process.argv[1]);
  const fault = process.argv[2] ?? "persistent";
  const lockDirectory = path.join(input.cwd, ".supervised-worker", "locks", "lifecycle");
  const displacedDirectory = path.join(path.dirname(input.cwd), "displaced-lock");
  const replacementToken = "11111111-1111-4111-8111-111111111111";
  const retirementAttempts = [];
  const attemptTimes = [];
  const attemptSnapshots = [];
  const ownerDescriptorsAtRename = [];
  const reopenedOwners = [];
  const waits = [];
  const descriptors = new Map();
  const originalRenameSync = fs.renameSync;
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  const originalWait = Atomics.wait;
  let retiredDirectory = null;
  let originalOwnerPath = null;
  let initialState = null;
  let protectedState = null;
  let mutationFired = false;
  let injectionCount = 0;

  function identity(filePath) {
    const stats = fs.lstatSync(filePath, { bigint: true });
    assert.notEqual(stats.dev, 0n, "the fixture must expose a real device identity");
    assert.notEqual(stats.ino, 0n, "the fixture must expose a real inode identity");
    return { dev: String(stats.dev), ino: String(stats.ino), nlink: String(stats.nlink) };
  }

  function snapshot(directory) {
    if (directory === null || !fs.existsSync(directory)) return null;
    return {
      identity: identity(directory),
      entries: fs.readdirSync(directory).sort().map((name) => ({
        name,
        identity: identity(path.join(directory, name)),
        bytes: fs.readFileSync(path.join(directory, name)).toString("base64"),
      })),
    };
  }

  function releaseState() {
    return {
      root: identity(input.cwd),
      parent: identity(path.dirname(lockDirectory)),
      canonical: snapshot(lockDirectory),
      retired: snapshot(retiredDirectory),
      displaced: snapshot(displacedDirectory),
    };
  }

  function replaceBetweenAttempts() {
    const originalEntry = initialState.canonical.entries[0];
    const bytes = Buffer.from(originalEntry.bytes, "base64");
    const owner = JSON.parse(bytes.toString("utf8"));
    switch (fault) {
      case "copied-owner":
        fs.mkdirSync(displacedDirectory);
        originalRenameSync(originalOwnerPath, path.join(displacedDirectory, originalEntry.name));
        fs.writeFileSync(originalOwnerPath, bytes, { flag: "wx" });
        break;
      case "record-token":
        fs.writeFileSync(originalOwnerPath, JSON.stringify({ ...owner, token: replacementToken }));
        break;
      case "record-pid":
        fs.writeFileSync(originalOwnerPath, JSON.stringify({ ...owner, processId: process.pid + 1 }));
        break;
      case "token-filename": {
        const replacementPath = path.join(lockDirectory, replacementToken + ".json");
        originalRenameSync(originalOwnerPath, replacementPath);
        fs.writeFileSync(replacementPath, JSON.stringify({ ...owner, token: replacementToken }));
        break;
      }
      case "extra-entry":
        fs.writeFileSync(path.join(lockDirectory, replacementToken + ".json"), bytes, { flag: "wx" });
        break;
      case "directory":
        originalRenameSync(lockDirectory, displacedDirectory);
        fs.mkdirSync(lockDirectory);
        fs.writeFileSync(originalOwnerPath, bytes, { flag: "wx" });
        break;
      case "parent": {
        const parent = path.dirname(lockDirectory);
        originalRenameSync(parent, displacedDirectory);
        fs.mkdirSync(parent);
        originalRenameSync(path.join(displacedDirectory, path.basename(lockDirectory)), lockDirectory);
        break;
      }
      case "root":
        originalRenameSync(input.cwd, displacedDirectory);
        fs.mkdirSync(input.cwd);
        originalRenameSync(path.join(displacedDirectory, ".supervised-worker"), path.join(input.cwd, ".supervised-worker"));
        break;
      case "occupied-destination":
        fs.mkdirSync(retiredDirectory);
        fs.writeFileSync(path.join(retiredDirectory, originalEntry.name), bytes, { flag: "wx" });
        break;
      default:
        return;
    }
    mutationFired = true;
    protectedState = releaseState();
  }

  fs.openSync = (filePath, ...options) => {
    const descriptor = originalOpenSync(filePath, ...options);
    descriptors.set(descriptor, String(filePath));
    if (injectionCount > 0 && String(filePath) === originalOwnerPath) {
      const stats = fs.fstatSync(descriptor, { bigint: true });
      reopenedOwners.push({ dev: String(stats.dev), ino: String(stats.ino) });
    }
    return descriptor;
  };
  fs.closeSync = (descriptor) => {
    const result = originalCloseSync(descriptor);
    descriptors.delete(descriptor);
    return result;
  };
  fs.renameSync = (source, destination, ...options) => {
    if (
      String(source) === lockDirectory &&
      String(destination).startsWith(lockDirectory + ".") &&
      String(destination).endsWith(".retired")
    ) {
      attemptTimes.push(performance.now());
      retiredDirectory = String(destination);
      const succeeds = fault === "transient" && retirementAttempts.length > 0;
      const code = succeeds ? null : fault === "permission" ? "EPERM" :
        fault === "unknown" ? "PRIVATE_UNKNOWN_CODE" : "EBUSY";
      retirementAttempts.push({
        syscall: "rename",
        code,
        source: String(source),
        destination: String(destination),
      });
      if (initialState === null) {
        initialState = releaseState();
        assert.equal(initialState.canonical.entries.length, 1);
        const entry = initialState.canonical.entries[0];
        const owner = JSON.parse(Buffer.from(entry.bytes, "base64").toString("utf8"));
        assert.equal(entry.name, owner.token + ".json");
        assert.equal(owner.processId, process.pid);
        assert.equal(entry.identity.nlink, "1");
        assert.equal(retiredDirectory, lockDirectory + "." + owner.token + ".retired");
        originalOwnerPath = path.join(lockDirectory, entry.name);
      }
      attemptSnapshots.push(snapshot(lockDirectory));
      ownerDescriptorsAtRename.push([...descriptors.values()].filter((filePath) => filePath === originalOwnerPath));
      if (succeeds) return originalRenameSync(source, destination, ...options);
      injectionCount += 1;
      if (fault === "retired-only" || fault === "retired-replacement") {
        originalRenameSync(source, destination, ...options);
        if (fault === "retired-replacement") {
          const entry = initialState.canonical.entries[0];
          const owner = JSON.parse(Buffer.from(entry.bytes, "base64").toString("utf8"));
          fs.mkdirSync(lockDirectory);
          fs.writeFileSync(path.join(lockDirectory, replacementToken + ".json"),
            JSON.stringify({ ...owner, token: replacementToken }), { flag: "wx" });
        }
        mutationFired = true;
        protectedState = releaseState();
      }
      const error = new Error("private injected retirement failure details");
      error.code = code;
      error.syscall = "rename";
      throw error;
    }
    return originalRenameSync(source, destination, ...options);
  };
  Atomics.wait = (cell, index, expected, timeout) => {
    if (injectionCount > 0) {
      waits.push({ requestedMs: timeout, elapsedMs: performance.now() - attemptTimes[0] });
      if (!mutationFired) replaceBetweenAttempts();
      if (fault === "deadline") return originalWait(cell, index, expected, 125);
    }
    return originalWait(cell, index, expected, timeout);
  };
  if (fault === "persistent-frozen" || fault === "deadline") Date.now = () => 1_700_000_000_000;
  syncBuiltinESMExports();

  const { handleHook } = await import(${JSON.stringify(coreUrl)});
  const wallBefore = Date.now();
  const output = handleHook(input, process.argv[3] ?? "PostToolUse");
  const retirementElapsedMs = performance.now() - attemptTimes[0];
  const openDescriptors = [...descriptors.values()];
  process.stdout.write(JSON.stringify({
    output,
    retirementAttempts,
    attemptTimes: attemptTimes.map((time) => time - attemptTimes[0]),
    attemptSnapshots,
    ownerDescriptorsAtRename,
    reopenedOwners,
    waits,
    wallTimes: [wallBefore, Date.now()],
    retirementElapsedMs,
    injectionCount,
    mutationFired,
    initialState,
    protectedState,
    finalState: releaseState(),
    openDescriptors,
    processId: process.pid,
  }));
`;

function runChild(cwd, args, input) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function withActiveHookFixture(action) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "supervised-worker-lifecycle-recovery-")));
  try {
    const cwd = path.join(base, "repo");
    const storage = path.join(base, "storage");
    const transcripts = path.join(storage, "GitHub.copilot-chat", "transcripts");
    mkdirSync(cwd);
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(path.join(storage, "workspace.json"), "{}\n");
    const sessionId = "lifecycle-recovery-session";
    const transcriptPath = path.join(transcripts, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, "");
    const readPath = path.join(cwd, "README.md");
    writeFileSync(readPath, "Lifecycle recovery fixture.\n");
    const session = { cwd, session_id: sessionId, transcript_path: transcriptPath };
    function invokeHook(eventName, tool) {
      const result = runChild(cwd, [launcherPath, eventName], JSON.stringify({
        ...session,
        ...tool,
        hook_event_name: eventName,
      }));
      return JSON.parse(result.stdout.trim() || "{}");
    }

    const planPath = path.join(cwd, ".supervised-worker", "plan.json");
    const planWrite = {
      tool_name: "Write",
      tool_use_id: "setup-plan",
      tool_input: { file_path: planPath },
    };
    assert.deepEqual(invokeHook("PreToolUse", planWrite), {});
    writeFileSync(planPath, JSON.stringify({
      schemaVersion: 1,
      mode: "active",
      goal: "Exercise isolated lifecycle retirement exhaustion",
      items: [{ id: "recovery", title: "Recovery", status: "in_progress" }],
      completion: null,
    }));
    assert.deepEqual(invokeHook("PostToolUse", planWrite), {});

    const readTool = {
      tool_name: "read_file",
      tool_use_id: "faulting-read",
      tool_input: { filePath: readPath },
    };
    assert.deepEqual(invokeHook("PreToolUse", readTool), {});
    const lockDirectory = path.join(cwd, ".supervised-worker", "locks", "lifecycle");
    assert.equal(existsSync(lockDirectory), false, "healthy hooks must retire their repository lock");
    const attachmentPath = path.join(cwd, ".supervised-worker", "attachment.json");
    const attachmentBefore = readFileSync(attachmentPath);
    assert.equal(JSON.parse(attachmentBefore.toString("utf8")).status, "active");

    action({ base, cwd, storage, session, readTool, invokeHook, lockDirectory, attachmentPath, attachmentBefore });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function runRetirementScenario(fixture, fault) {
  const child = runChild(fixture.base, [
    "--input-type=module",
    "--eval",
    faultingHookScript,
    JSON.stringify({ ...fixture.session, ...fixture.readTool, hook_event_name: "PostToolUse" }),
    fault,
  ]);
  const release = JSON.parse(child.stdout);
  assert.ok(release.injectionCount > 0, "the selected retirement failure must fire");
  assert.equal(release.processId, child.pid);
  assert.deepEqual(release.openDescriptors, [], "every opened descriptor must be closed");
  assert.deepEqual(readFileSync(fixture.attachmentPath), fixture.attachmentBefore);
  assert.deepEqual(readdirSync(path.join(fixture.storage, "supervised-worker", "session-locks")), [],
    "repository release failure must not skip session lock cleanup");
  assert.doesNotMatch(JSON.stringify(release.output), /private injected|PRIVATE_UNKNOWN_CODE/);
  return release;
}

test("persistent repository retirement EBUSY reports typed failure and a dead owner to the next hook", () => {
  withActiveHookFixture(({ cwd, session, readTool, invokeHook, lockDirectory, attachmentPath, attachmentBefore }) => {
    const child = runChild(cwd, [
      "--input-type=module",
      "--eval",
      faultingHookScript,
      JSON.stringify({ ...session, ...readTool, hook_event_name: "PostToolUse" }),
    ]);
    const release = JSON.parse(child.stdout);
    assert.ok(release.retirementAttempts.length > 0, "the repository retirement EBUSY branch must fire");
    assert.ok(release.retirementAttempts.length <= 3, "retirement must exhaust within three attempts");
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, "the child must have a real positive PID");
    assert.equal(release.processId, child.pid);
    const entries = readdirSync(lockDirectory);
    assert.equal(entries.length, 1, "exhaustion must leave exactly one canonical owner");
    const ownerPath = path.join(lockDirectory, entries[0]);
    const ownerBefore = readFileSync(ownerPath);
    const owner = JSON.parse(ownerBefore.toString("utf8"));
    assert.match(owner.token, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(entries[0], `${owner.token}.json`);
    assert.equal(owner.processId, child.pid);
    for (const attempt of release.retirementAttempts) {
      assert.deepEqual(attempt, {
        syscall: "rename",
        code: "EBUSY",
        source: lockDirectory,
        destination: `${lockDirectory}.${owner.token}.retired`,
      });
    }
    assert.throws(() => process.kill(owner.processId, 0), { code: "ESRCH" });
    assert.deepEqual(readFileSync(attachmentPath), attachmentBefore);

    const next = invokeHook("PreToolUse", { ...readTool, tool_use_id: "read-after-exhaustion" });
    assert.equal(next.permissionDecision, "deny", "a read must fail closed while the dead owner remains");
    assert.deepEqual(readFileSync(attachmentPath), attachmentBefore);
    assert.deepEqual(readdirSync(lockDirectory), entries);
    assert.deepEqual(readFileSync(ownerPath), ownerBefore);

    const reason = next.permissionDecisionReason ?? "";
    assert.match(reason, /\bLIFECYCLE_OWNER_DEAD\b/, "the denied read must expose a typed dead-owner lifecycle diagnostic");
    assert.match(reason, /\brepository\b/i);
    assert.match(reason, /\binvocation\b/i);
    assert.match(reason, /\blifecycle inspect\b/);
    assert.doesNotMatch(reason, /plan write/i);
    assert.equal(next.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(next.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(next.hookSpecificOutput.permissionDecisionReason, reason);

    const releaseContext = release.output.additionalContext ?? "";
    assert.match(releaseContext, /\bLIFECYCLE_SYSCALL_FAILURE\b/);
    assert.match(releaseContext, /\bEBUSY\b/);
    assert.match(releaseContext, /\brepository\b/i);
    assert.match(releaseContext, /\blifecycle inspect\b/);
    assert.equal(release.output.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.equal(release.output.hookSpecificOutput.additionalContext, releaseContext);
    assert.notEqual(release.output.permissionDecision, "deny");
    assert.notEqual(release.output.decision, "block");
    assert.doesNotMatch(JSON.stringify([release.output, next]), /private injected retirement failure details/);
  });
});

for (const host of ["vscode", "cli"]) {
  for (const fault of ["persistent", "copied-owner"]) {
    test(`Stop preserves its recorded block after ${fault} cleanup failure for ${host}`, () => {
      withActiveHookFixture((fixture) => {
        const input = host === "vscode" ? { ...fixture.session, hook_event_name: "Stop" } : {
          cwd: fixture.cwd, sessionId: fixture.session.session_id,
          transcript_path: fixture.session.transcript_path,
        };
        const child = runChild(fixture.base, ["--input-type=module", "--eval", faultingHookScript, JSON.stringify(input), fault, "Stop"]);
        const release = JSON.parse(child.stdout);
        assert.ok(release.injectionCount > 0, "cleanup fault must fire after the primary Stop action");
        if (fault === "copied-owner") assert.equal(release.mutationFired, true);
        const sessionHash = sha256(fixture.session.session_id);
        const state = JSON.parse(readFileSync(path.join(fixture.cwd, ".supervised-worker", "runtime", `${sessionHash}.json`)));
        assert.equal(state.sameProgressBlocks, 1);
        const records = readFileSync(path.join(fixture.cwd, ".supervised-worker", "runs", `${sessionHash}.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(records.filter((record) => record.event === "stop_blocked").length, 1);
        assert.deepEqual(readFileSync(fixture.attachmentPath), fixture.attachmentBefore);
        assert.equal(release.output.decision, "block", "cleanup failure must not downgrade an already-recorded Stop block");
        assert.match(release.output.reason, /LIFECYCLE_(SYSCALL_FAILURE|IDENTITY_REJECTED)/);
        assert.equal(release.output.systemMessage, release.output.reason);
        if (host === "vscode") assert.equal(release.output.hookSpecificOutput.decision, "block");
        else assert.equal(Object.hasOwn(release.output, "hookSpecificOutput"), false);
        assert.deepEqual(release.openDescriptors, []);
      });
    });
  }
}

test("a single retirement EBUSY retries the verified owner and leaves no active lock", () => {
  withActiveHookFixture((fixture) => {
    const release = runRetirementScenario(fixture, "transient");
    assert.equal(release.injectionCount, 1);
    assert.equal(release.retirementAttempts.length, 2, "the second rename must actually execute");
    assert.deepEqual(release.output, {});
    assert.equal(release.finalState.canonical, null);
    assert.equal(release.finalState.retired, null);
    assert.deepEqual(readdirSync(path.dirname(fixture.lockDirectory)), []);
    assert.deepEqual(release.attemptSnapshots, [release.initialState.canonical, release.initialState.canonical]);
    for (const descriptors of release.ownerDescriptorsAtRename) {
      assert.equal(descriptors.length, process.platform === "win32" ? 0 : 1);
    }
    if (process.platform === "win32") {
      assert.ok(release.reopenedOwners.length > 0, "Windows must reopen the canonical owner after EBUSY");
      const { dev, ino } = release.initialState.canonical.entries[0].identity;
      for (const identity of release.reopenedOwners) assert.deepEqual(identity, { dev, ino });
    }
    assert.deepEqual(fixture.invokeHook("PreToolUse", { ...fixture.readTool, tool_use_id: "read-after-retry" }), {});
  });
});

test("persistent retirement EBUSY stays within three attempts and a monotonic budget with frozen wall time", () => {
  withActiveHookFixture((fixture) => {
    const release = runRetirementScenario(fixture, "persistent-frozen");
    assert.deepEqual(release.wallTimes, [1_700_000_000_000, 1_700_000_000_000]);
    assert.ok(release.retirementAttempts.length >= 2, "the persistent fault must exercise a retry");
    assert.ok(release.retirementAttempts.length <= 3);
    assert.equal(release.injectionCount, release.retirementAttempts.length);
    assert.ok(release.attemptTimes.at(-1) < 100, "no rename may start after the monotonic deadline");
    assert.ok(release.waits.length > 0 && release.waits.length <= 2);
    for (const wait of release.waits) {
      assert.ok(wait.requestedMs > 0 && wait.requestedMs <= 25);
      assert.ok(wait.elapsedMs + wait.requestedMs <= 101, "a wait must fit the remaining release budget");
    }
    assert.deepEqual(release.finalState, release.initialState);
    assert.match(release.output.additionalContext, /LIFECYCLE_SYSCALL_FAILURE/);
    assert.match(release.output.additionalContext, /"errorCode":"EBUSY"/);
    assert.match(release.output.additionalContext, new RegExp('"attempts":' + release.retirementAttempts.length));
  });
});

test("an expired monotonic release budget prevents a second rename after a delayed wait", () => {
  withActiveHookFixture((fixture) => {
    const release = runRetirementScenario(fixture, "deadline");
    assert.deepEqual(release.wallTimes, [1_700_000_000_000, 1_700_000_000_000]);
    assert.equal(release.waits.length, 1, "the delayed wait injection must fire");
    assert.ok(release.waits[0].requestedMs > 0 && release.waits[0].requestedMs <= 25);
    assert.ok(release.retirementElapsedMs >= 100);
    assert.equal(release.retirementAttempts.length, 1);
    assert.deepEqual(release.finalState, release.initialState);
    assert.match(release.output.additionalContext, /LIFECYCLE_SYSCALL_FAILURE/);
    assert.match(release.output.additionalContext, /"errorCode":"EBUSY"/);
  });
});

for (const [fault, errorCode] of [["permission", "EPERM"], ["unknown", "UNKNOWN"]]) {
  test(`retirement ${errorCode} is reported without retrying or changing the owner`, () => {
    withActiveHookFixture((fixture) => {
      const release = runRetirementScenario(fixture, fault);
      assert.equal(release.retirementAttempts.length, 1);
      assert.deepEqual(release.waits, []);
      assert.deepEqual(release.finalState, release.initialState);
      assert.match(release.output.additionalContext, /LIFECYCLE_SYSCALL_FAILURE/);
      assert.match(release.output.additionalContext, new RegExp('"errorCode":"' + errorCode + '"'));
      assert.match(release.output.additionalContext, /"attempts":1/);
    });
  });
}

for (const fault of ["copied-owner", "record-token", "record-pid", "token-filename", "extra-entry", "directory", "parent", "root"]) {
  test(`retirement retry rejects ${fault} replacement and preserves its bytes and identity`, () => {
    withActiveHookFixture((fixture) => {
      const release = runRetirementScenario(fixture, fault);
      assert.equal(release.mutationFired, true, "the replacement must be installed between attempts");
      assert.equal(release.waits.length, 1);
      assert.equal(release.retirementAttempts.length, 1, "a changed identity must never reach another rename");
      assert.deepEqual(release.finalState, release.protectedState);
      assert.match(release.output.additionalContext, /LIFECYCLE_IDENTITY_REJECTED/);
      const before = release.initialState.canonical;
      const replacement = release.protectedState.canonical;
      const beforeEntry = before.entries[0];
      const replacementEntry = replacement.entries[0];
      const beforeOwner = JSON.parse(Buffer.from(beforeEntry.bytes, "base64").toString("utf8"));
      const replacementOwner = JSON.parse(Buffer.from(replacementEntry.bytes, "base64").toString("utf8"));
      if (fault === "copied-owner") {
        assert.deepEqual(replacement.identity, before.identity);
        assert.notEqual(replacementEntry.identity.ino, beforeEntry.identity.ino);
        assert.equal(replacementEntry.bytes, beforeEntry.bytes);
        assert.deepEqual(release.protectedState.displaced.entries, before.entries);
      } else if (fault === "record-token" || fault === "record-pid") {
        assert.deepEqual(replacementEntry.identity, beforeEntry.identity);
        assert.equal(replacementEntry.name, beforeEntry.name);
        if (fault === "record-token") {
          assert.notEqual(replacementOwner.token, beforeOwner.token);
          assert.equal(replacementOwner.processId, beforeOwner.processId);
        } else {
          assert.equal(replacementOwner.token, beforeOwner.token);
          assert.notEqual(replacementOwner.processId, beforeOwner.processId);
        }
      } else if (fault === "token-filename") {
        assert.equal(replacement.entries.length, 1);
        assert.notEqual(replacementEntry.name, beforeEntry.name);
        assert.equal(replacementEntry.name, `${replacementOwner.token}.json`);
        assert.deepEqual(replacementEntry.identity, beforeEntry.identity);
      } else if (fault === "extra-entry") {
        assert.equal(replacement.entries.length, 2);
        assert.deepEqual(replacement.entries.find((entry) => entry.name === beforeEntry.name), beforeEntry);
      } else if (fault === "directory") {
        assert.notEqual(replacement.identity.ino, before.identity.ino);
        assert.notEqual(replacementEntry.identity.ino, beforeEntry.identity.ino);
        assert.equal(replacementEntry.bytes, beforeEntry.bytes);
        assert.deepEqual(release.protectedState.displaced, before);
      } else {
        assert.deepEqual(replacement, before, "moving the original lock must not change its own identity");
        assert.notEqual(release.protectedState[fault].ino, release.initialState[fault].ino);
      }
    });
  });
}

for (const fault of ["occupied-destination", "retired-only", "retired-replacement"]) {
  test(`retirement ${fault} ambiguity preserves both locations and forbids another rename`, () => {
    withActiveHookFixture((fixture) => {
      const release = runRetirementScenario(fixture, fault);
      assert.equal(release.mutationFired, true, "the ambiguous retirement state must actually be installed");
      assert.equal(release.retirementAttempts.length, 1);
      assert.deepEqual(release.finalState, release.protectedState);
      assert.match(release.output.additionalContext, /LIFECYCLE_IDENTITY_REJECTED/);
      const before = release.initialState.canonical;
      if (fault === "occupied-destination") {
        assert.deepEqual(release.protectedState.canonical, before);
        assert.notEqual(release.protectedState.retired.identity.ino, before.identity.ino);
        assert.equal(release.protectedState.retired.entries[0].bytes, before.entries[0].bytes);
      } else {
        assert.deepEqual(release.protectedState.retired, before);
        if (fault === "retired-only") assert.equal(release.protectedState.canonical, null);
        else {
          assert.notEqual(release.protectedState.canonical.identity.ino, before.identity.ino);
          assert.notEqual(release.protectedState.canonical.entries[0].name, before.entries[0].name);
        }
      }
    });
  });
}

function childEnvironment() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of Object.keys(env)) {
    if (["NODE_TEST_CONTEXT", "NODE_OPTIONS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"].includes(key)) delete env[key];
  }
  return env;
}

function runCli(cwd, args, request, expectedCode = 0) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd, env: childEnvironment(), encoding: "utf8", timeout: 20_000,
    input: typeof request === "string" ? request : JSON.stringify(request),
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, expectedCode, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

function fileState(filePath) {
  if (!existsSync(filePath)) return null;
  const stats = lstatSync(filePath, { bigint: true });
  assert.notEqual(stats.dev, 0n);
  assert.notEqual(stats.ino, 0n);
  return {
    dev: String(stats.dev), ino: String(stats.ino), nlink: String(stats.nlink),
    bytes: stats.isFile() ? readFileSync(filePath).toString("base64") : null,
  };
}

function lockState(directory) {
  if (!existsSync(directory)) return null;
  return { directory: fileState(directory), entries: readdirSync(directory).sort().map((name) => ({ name, ...fileState(path.join(directory, name)) })) };
}

async function withRecoveryFixture(action) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sw-explicit-recovery-")));
  try {
    const cwd = path.join(base, "repo");
    const storage = path.join(base, "storage");
    const sessionId = "explicit-recovery-session";
    const transcripts = path.join(storage, "GitHub.copilot-chat", "transcripts");
    mkdirSync(cwd);
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(path.join(storage, "workspace.json"), "{}\n");
    const transcript = path.join(transcripts, `${sessionId}.jsonl`);
    writeFileSync(transcript, "PRIVATE_TRANSCRIPT_NOT_EVIDENCE\n");
    const anchor = { session_id: sessionId, transcript_path: transcript };
    const attachmentPath = path.join(cwd, ".supervised-worker", "attachment.json");
    const routePath = path.join(storage, "supervised-worker", "session-roots", sha256(sessionId), "route.json");
    const markerPath = path.join(storage, "supervised-worker", "session-bindings", `${sha256(sessionId)}.json`);
    const planPath = path.join(cwd, ".supervised-worker", "plan.json");
    const ledgerPath = path.join(cwd, ".supervised-worker", "runs", `${sha256(sessionId)}.jsonl`);
    const evidenceDirectory = path.join(cwd, ".supervised-worker", "lifecycle-evidence");
    const canonical = (scope) => scope === "repository" ? path.join(cwd, ".supervised-worker", "locks", "lifecycle") :
      path.join(storage, "supervised-worker", "session-locks", sha256(sessionId));
    const invoke = (event, extra = {}) => JSON.parse(runChild(cwd, [launcherPath, event], JSON.stringify({ cwd, ...anchor, hook_event_name: event, ...extra })).stdout);
    const fixture = { base, cwd, storage, anchor, attachmentPath, routePath, markerPath, planPath, ledgerPath, evidenceDirectory, canonical, invoke };
    await action(fixture);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function attachFixture(fixture, kind = "routed") {
  if (kind === "routed" || kind === "checkpointed") {
    const tool = { tool_name: "Write", tool_use_id: "setup", tool_input: { file_path: fixture.planPath } };
    assert.deepEqual(fixture.invoke("PreToolUse", tool), {});
    writeFileSync(fixture.planPath, JSON.stringify({ schemaVersion: 1, mode: "active", goal: "PRIVATE_PLAN_NOT_EVIDENCE", items: [{ id: "item", title: "Item", status: "in_progress" }], completion: null }));
    assert.deepEqual(fixture.invoke("PostToolUse", tool), {});
    if (kind === "checkpointed") {
      const attachment = JSON.parse(readFileSync(fixture.attachmentPath));
      writeFileSync(fixture.attachmentPath, JSON.stringify({ ...attachment, status: "checkpointed", claimGeneration: null, checkpointHash: sha256("synthetic checkpoint, never resumed") }));
    }
  } else if (kind !== "unattached") {
    mkdirSync(path.dirname(fixture.attachmentPath), { recursive: true });
    const legacy = { schemaVersion: 1, sessionHash: sha256(fixture.anchor.session_id), attachedAt: "2026-01-01T00:00:00Z" };
    const attachment = kind === "legacy" ? legacy : {
      ...legacy, schemaVersion: 3, status: "active", routeGeneration: null, claimGeneration: randomUUID(),
      checkpointHash: null, updatedAt: legacy.attachedAt,
    };
    writeFileSync(fixture.attachmentPath, JSON.stringify(attachment));
  }
}

function seedDeadOwner(fixture, scope = "repository", location = "canonical") {
  const token = randomUUID();
  const canonical = fixture.canonical(scope);
  const directory = location === "canonical" ? canonical : `${canonical}.${token}.retired`;
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    const [directory, token] = process.argv.slice(1);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, token + ".json"), JSON.stringify({ schemaVersion: 1, token, processId: process.pid, acquiredAt: new Date().toISOString() }), { flag: "wx" });
    process.stdout.write(JSON.stringify({ processId: process.pid }));
  `;
  const child = runChild(fixture.cwd, ["--input-type=module", "--eval", script, directory, token]);
  assert.equal(JSON.parse(child.stdout).processId, child.pid);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  const before = lockState(directory);
  assert.equal(before.entries.length, 1);
  assert.equal(before.entries[0].nlink, "1");
  return { scope, location, token, directory, canonical, recovered: `${canonical}.${token}.recovered`, before, processId: child.pid };
}

function inspectedRequest(fixture, target, anchored = true) {
  const anchor = anchored ? fixture.anchor : {};
  const inspection = inspectLifecycleLock(fixture.cwd, { scope: target.scope, location: target.location, token: target.token, ...anchor });
  assert.equal(inspection.status, "inspected", JSON.stringify(inspection));
  assert.equal(inspection.diagnostics[0].code, "LIFECYCLE_OWNER_DEAD");
  assert.equal(inspection.diagnostics[0].cause, "cause-unobserved");
  assert.equal(inspection.expected.token, target.token);
  return { expected: inspection.expected, ...anchor };
}

function preservedCampaign(fixture) {
  return Object.fromEntries(["attachmentPath", "routePath", "markerPath", "planPath", "ledgerPath"].map((name) => [name, fileState(fixture[name])]));
}

function readEvidence(fixture, result) {
  const intentBytes = readFileSync(path.join(fixture.evidenceDirectory, `${result.intentHash}.intent.json`));
  const outcomeBytes = readFileSync(path.join(fixture.evidenceDirectory, `${result.outcomeHash}.outcome.json`));
  assert.equal(sha256(intentBytes), result.intentHash);
  assert.equal(sha256(outcomeBytes), result.outcomeHash);
  assert.doesNotMatch(intentBytes.toString() + outcomeBytes.toString(), /PRIVATE_|transcript_path|session_id|tool_input/);
  const intent = JSON.parse(intentBytes);
  const outcome = JSON.parse(outcomeBytes);
  assert.equal(outcome.intentHash, result.intentHash);
  assert.deepEqual(validateLifecycle(intent, "recoveryIntent"), []);
  assert.deepEqual(validateLifecycle(outcome, "recoveryOutcome"), []);
  return { intent, outcome };
}

test("CLI inspection of an absent lock creates no state", async () => {
  await withRecoveryFixture(async (fixture) => {
    const before = readdirSync(fixture.cwd);
    const result = runCli(fixture.cwd, ["lifecycle", "inspect"], { scope: "repository" });
    assert.equal(result.status, "absent");
    assert.equal(result.expected, null);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(readdirSync(fixture.cwd), before);
    assert.equal(existsSync(path.join(fixture.cwd, ".supervised-worker")), false);
  });
});

for (const kind of ["unattached", "legacy", "unrouted", "routed", "checkpointed"]) {
  test(`repository recovery preserves ${kind} ownership and its immutable evidence`, async () => {
    await withRecoveryFixture(async (fixture) => {
      attachFixture(fixture, kind);
      const target = seedDeadOwner(fixture);
      const before = preservedCampaign(fixture);
      const request = inspectedRequest(fixture, target, ["routed", "checkpointed"].includes(kind));
      assert.deepEqual(lockState(target.directory), target.before);
      assert.equal(existsSync(fixture.evidenceDirectory), false);
      if (kind === "unattached") assert.deepEqual(request.expected.attachment, { state: "absent" });
      if (kind === "legacy") {
        assert.equal(request.expected.attachment.version, 1);
        assert.equal(request.expected.attachment.routeGeneration, null);
        assert.equal(request.expected.attachment.claimGeneration, null);
      }
      const result = runCli(fixture.cwd, ["lifecycle", "recover"], request);
      assert.equal(result.status, "recovered");
      assert.equal(existsSync(target.canonical), false);
      assert.deepEqual(lockState(target.recovered), target.before);
      assert.deepEqual(preservedCampaign(fixture), before);
      const { intent, outcome } = readEvidence(fixture, result);
      assert.deepEqual(intent.expected, request.expected);
      assert.equal(intent.death.processId, target.processId);
      assert.equal(intent.destination, path.basename(target.recovered));
      assert.equal(outcome.status, "recovered");
      const evidenceBefore = Object.fromEntries(readdirSync(fixture.evidenceDirectory).map((name) => [name, fileState(path.join(fixture.evidenceDirectory, name))]));
      const again = recoverLifecycleLock(fixture.cwd, { ...request, intentHash: result.intentHash });
      assert.equal(again.status, "already-recovered", JSON.stringify(again));
      assert.equal(again.outcomeHash, result.outcomeHash);
      assert.deepEqual(Object.fromEntries(readdirSync(fixture.evidenceDirectory).map((name) => [name, fileState(path.join(fixture.evidenceDirectory, name))])), evidenceBefore);
      assert.deepEqual(lockState(target.recovered), target.before);
    });
  });
}

for (const scope of ["repository", "session"]) {
  for (const location of scope === "repository" ? ["retired"] : ["canonical", "retired"]) {
    test(`${scope} ${location} recovery holds the associated repository guard without acquiring a session lock`, async () => {
      await withRecoveryFixture(async (fixture) => {
        attachFixture(fixture);
        const target = seedDeadOwner(fixture, scope, location);
        const request = inspectedRequest(fixture, target);
        const before = preservedCampaign(fixture);
        const script = `
          import assert from "node:assert/strict";
          import fs from "node:fs";
          import path from "node:path";
          import { syncBuiltinESMExports } from "node:module";
          const [cwd, target, repositoryLock, sessionLock, requestText] = process.argv.slice(1);
          const rename = fs.renameSync;
          const mkdir = fs.mkdirSync;
          let guarded = 0;
          let sessionAcquisitions = 0;
          fs.mkdirSync = (directory, ...args) => {
            if (String(directory) === sessionLock) sessionAcquisitions += 1;
            return mkdir(directory, ...args);
          };
          fs.renameSync = (source, destination, ...args) => {
            if (String(source) === target) {
              const entries = fs.readdirSync(repositoryLock);
              assert.equal(entries.length, 1);
              assert.equal(JSON.parse(fs.readFileSync(path.join(repositoryLock, entries[0]))).processId, process.pid);
              guarded += 1;
            }
            return rename(source, destination, ...args);
          };
          syncBuiltinESMExports();
          const { recoverLifecycleLock } = await import(${JSON.stringify(coreUrl)});
          const result = recoverLifecycleLock(cwd, JSON.parse(requestText));
          process.stdout.write(JSON.stringify({ result, guarded, sessionAcquisitions }));
        `;
        const child = runChild(fixture.cwd, ["--input-type=module", "--eval", script, fixture.cwd, target.directory, fixture.canonical("repository"), fixture.canonical("session"), JSON.stringify(request)]);
        const report = JSON.parse(child.stdout);
        assert.equal(report.guarded, 1, "retirement must observe the real repository guard");
        assert.equal(report.sessionAcquisitions, 0);
        assert.equal(report.result.status, "recovered", JSON.stringify(report));
        assert.deepEqual(lockState(target.recovered), target.before);
        assert.deepEqual(preservedCampaign(fixture), before);
        assert.equal(existsSync(fixture.canonical("repository")), false);
      });
    });
  }
}

test("two dead scopes require repository recovery before guarded session recovery", async () => {
  await withRecoveryFixture(async (fixture) => {
    attachFixture(fixture);
    const repository = seedDeadOwner(fixture);
    const session = seedDeadOwner(fixture, "session");
    const before = preservedCampaign(fixture);
    const blocked = recoverLifecycleLock(fixture.cwd, inspectedRequest(fixture, session));
    assert.equal(blocked.status, "unconfirmed");
    assert.ok(blocked.diagnostics.some((entry) => entry.scope === "repository" && entry.code === "LIFECYCLE_OWNER_DEAD"));
    assert.deepEqual(lockState(repository.directory), repository.before);
    assert.deepEqual(lockState(session.directory), session.before);
    assert.equal(recoverLifecycleLock(fixture.cwd, inspectedRequest(fixture, repository)).status, "recovered");
    assert.equal(recoverLifecycleLock(fixture.cwd, inspectedRequest(fixture, session)).status, "recovered");
    assert.deepEqual(preservedCampaign(fixture), before);
  });
});

const recoveryFaultScript = `
  import assert from "node:assert/strict";
  import fs from "node:fs";
  import path from "node:path";
  import { syncBuiltinESMExports } from "node:module";
  const [cwd, requestText, fault, pathsText] = process.argv.slice(1);
  const request = JSON.parse(requestText);
  const paths = JSON.parse(pathsText);
  const original = { rename: fs.renameSync, write: fs.writeFileSync, open: fs.openSync, close: fs.closeSync,
    fsync: fs.fsyncSync, read: fs.readSync, lstat: fs.lstatSync, kill: process.kill };
  const descriptors = new Map();
  let fired = false;
  let retirementAttempts = 0;
  const fail = (syscall, code = "EIO") => { fired = true; throw Object.assign(new Error("PRIVATE_RECOVERY_FAULT"), { code, syscall }); };
  const inEvidence = (name, kind) => String(name).includes(path.sep + "lifecycle-evidence" + path.sep) && String(name).includes("." + kind + ".json");
  const mutate = () => {
    const ownerPath = path.join(paths.target, request.expected.token + ".json");
    const replaceFile = (filePath) => {
      const bytes = fs.readFileSync(filePath);
      original.rename(filePath, filePath + ".displaced");
      original.write(filePath, bytes, { flag: "wx" });
    };
    const rewrite = (filePath, values) => original.write(filePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(filePath)), ...values }));
    const replacementToken = "11111111-1111-4111-8111-111111111111";
    if (fault === "owner-copy") {
      const bytes = fs.readFileSync(ownerPath);
      original.rename(ownerPath, path.join(paths.base, "displaced-owner"));
      original.write(ownerPath, bytes, { flag: "wx" });
    } else if (fault === "owner-token") rewrite(ownerPath, { token: replacementToken });
    else if (fault === "owner-pid") rewrite(ownerPath, { processId: process.pid });
    else if (fault === "owner-name") original.rename(ownerPath, path.join(paths.target, replacementToken + ".json"));
    else if (fault === "owner-extra") original.write(path.join(paths.target, "extra.json"), "{}");
    else if (fault === "directory") {
      original.rename(paths.target, path.join(paths.base, "displaced-lock"));
      fs.mkdirSync(paths.target);
      original.write(ownerPath, fs.readFileSync(path.join(paths.base, "displaced-lock", request.expected.token + ".json")));
    } else if (fault === "parent") {
      const parent = path.dirname(paths.target);
      const displaced = path.join(paths.base, "displaced-parent");
      original.rename(parent, displaced);
      fs.mkdirSync(parent);
      original.rename(path.join(displaced, path.basename(paths.target)), paths.target);
    } else if (fault === "repository" || fault === "storage-root") {
      const root = fault === "repository" ? cwd : paths.storage;
      const displaced = path.join(paths.base, "displaced-root");
      original.rename(root, displaced);
      fs.mkdirSync(root);
      for (const name of fs.readdirSync(displaced)) original.rename(path.join(displaced, name), path.join(root, name));
    } else if (fault === "attachment-copy") replaceFile(paths.attachment);
    else if (fault === "route-copy") replaceFile(paths.route);
    else if (fault === "marker-copy") replaceFile(paths.marker);
    else if (fault === "transcript-copy") replaceFile(request.transcript_path);
    else if (fault === "workspace-copy") replaceFile(path.join(paths.storage, "workspace.json"));
    else if (fault === "attachment-generation") rewrite(paths.attachment, { routeGeneration: replacementToken });
    else if (fault === "claim-generation") rewrite(paths.attachment, { claimGeneration: replacementToken });
    else if (fault === "attachment-status") rewrite(paths.attachment, { status: "provisional" });
    else if (fault === "route-generation") rewrite(paths.route, { generation: replacementToken });
    else if (fault === "route-repository") rewrite(paths.route, { repositoryRoot: paths.base });
    else if (fault === "marker-missing") original.rename(paths.marker, path.join(paths.base, "displaced-marker"));
    else return false;
    fired = true;
    return true;
  };
  fs.openSync = (filePath, ...args) => { const descriptor = original.open(filePath, ...args); descriptors.set(descriptor, String(filePath)); return descriptor; };
  fs.closeSync = (descriptor) => { descriptors.delete(descriptor); return original.close(descriptor); };
  fs.writeFileSync = (filePath, ...args) => {
    if (!fired && fault === "intent-write" && inEvidence(filePath, "intent")) fail("write");
    if (!fired && fault === "outcome-write" && inEvidence(filePath, "outcome")) fail("write");
    if (fault === "interrupt-before-intent" && inEvidence(filePath, "intent")) process.exit(72);
    return original.write(filePath, ...args);
  };
  fs.fsyncSync = (descriptor) => {
    if (!fired && fault === "intent-fsync" && inEvidence(descriptors.get(descriptor), "intent")) fail("fsync");
    return original.fsync(descriptor);
  };
  fs.readSync = (descriptor, ...args) => {
    const name = descriptors.get(descriptor);
    if (!fired && fault === "intent-temporary-readback" && inEvidence(name, "intent") && name.endsWith(".tmp")) fail("read");
    if (!fired && fault === "intent-readback" && inEvidence(name, "intent") && name.endsWith(".json")) fail("read");
    return original.read(descriptor, ...args);
  };
  fs.lstatSync = (filePath, ...args) => {
    if (!fired && fault === "unavailable" && String(filePath) === paths.target) fail("lstat", "EACCES");
    const stats = original.lstat(filePath, ...args);
    if (fault === "zero-identity" && String(filePath) === paths.target) { fired = true; stats.ino = args[0]?.bigint ? 0n : 0; }
    return stats;
  };
  process.kill = (pid, signal) => {
    if (["pid-permission", "pid-unknown"].includes(fault) && pid === request.expected.processId) fail("kill", fault === "pid-permission" ? "EPERM" : "PRIVATE_UNKNOWN_PID");
    return original.kill(pid, signal);
  };
  fs.renameSync = (source, destination, ...args) => {
    if (String(source) === paths.target) {
      retirementAttempts += 1;
      if (fault === "rename-busy") fail("rename", "EBUSY");
    }
    if (!fired && fault === "intent-publication" && inEvidence(destination, "intent")) fail("rename");
    const result = original.rename(source, destination, ...args);
    if (inEvidence(destination, "intent")) {
      if (fault === "interrupt-after-intent") process.exit(72);
      if (!fired) mutate();
    }
    if (String(source) === paths.target && fault === "interrupt-after-rename") process.exit(72);
    if (String(source) === paths.target && fault === "retired-copy") {
      const displaced = path.join(paths.base, "unexpected-retired");
      original.rename(destination, displaced);
      fs.mkdirSync(destination);
      const name = request.expected.token + ".json";
      original.write(path.join(destination, name), fs.readFileSync(path.join(displaced, name)));
      fired = true;
    }
    return result;
  };
  syncBuiltinESMExports();
  const { recoverLifecycleLock } = await import(${JSON.stringify(coreUrl)});
  const result = recoverLifecycleLock(cwd, request);
  process.stdout.write(JSON.stringify({ result, fired, retirementAttempts, openDescriptors: [...descriptors.values()] }));
`;

function recoveryFault(fixture, target, request, fault, interrupted = false) {
  const paths = { target: target.directory, base: fixture.base, storage: fixture.storage, attachment: fixture.attachmentPath, route: fixture.routePath, marker: fixture.markerPath };
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", recoveryFaultScript, fixture.cwd, JSON.stringify(request), fault, JSON.stringify(paths)], {
    cwd: fixture.base, env: childEnvironment(), encoding: "utf8", timeout: 20_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, interrupted ? 72 : 0, child.stdout + child.stderr);
  if (interrupted) return null;
  const report = JSON.parse(child.stdout);
  assert.equal(report.fired, true, "the requested fault must fire before its outcome can be trusted");
  assert.deepEqual(report.openDescriptors, []);
  assert.doesNotMatch(JSON.stringify(report.result), /PRIVATE_/);
  return report;
}

for (const fault of ["intent-write", "intent-fsync", "intent-temporary-readback", "intent-publication", "intent-readback"]) {
  test(`recovery ${fault} failure leaves the target intact`, async () => {
    await withRecoveryFixture(async (fixture) => {
      const target = seedDeadOwner(fixture);
      const request = inspectedRequest(fixture, target, false);
      const report = recoveryFault(fixture, target, request, fault);
      assert.equal(report.retirementAttempts, 0);
      assert.equal(report.result.status, "unconfirmed");
      assert.equal(report.result.diagnostics[0].code, "LIFECYCLE_EVIDENCE_PERSISTENCE_FAILURE");
      assert.deepEqual(lockState(target.directory), target.before);
      assert.equal(existsSync(target.recovered), false);
    });
  });
}

for (const fault of ["pid-permission", "pid-unknown", "zero-identity", "unavailable"]) {
  test(`recovery rejects ${fault} without interpreting unavailable identity as absence`, async () => {
    await withRecoveryFixture(async (fixture) => {
      const target = seedDeadOwner(fixture);
      const request = inspectedRequest(fixture, target, false);
      const report = recoveryFault(fixture, target, request, fault);
      assert.equal(report.retirementAttempts, 0);
      assert.equal(report.result.status, "unconfirmed");
      if (fault.startsWith("pid-")) assert.equal(report.result.diagnostics[0].code, "LIFECYCLE_OWNER_UNKNOWN");
      assert.equal(existsSync(fixture.evidenceDirectory), false);
      assert.deepEqual(lockState(target.directory), target.before);
    });
  });
}

for (const fault of ["owner-copy", "owner-token", "owner-pid", "owner-name", "owner-extra", "directory", "parent", "repository", "storage-root", "attachment-copy", "attachment-generation", "claim-generation", "attachment-status", "route-generation", "route-copy", "route-repository", "marker-copy", "marker-missing", "transcript-copy", "workspace-copy"]) {
  test(`recovery rechecks ${fault} after intent publication and before retirement`, async () => {
    await withRecoveryFixture(async (fixture) => {
      attachFixture(fixture);
      const target = seedDeadOwner(fixture);
      const request = inspectedRequest(fixture, target);
      const report = recoveryFault(fixture, target, request, fault);
      assert.equal(report.retirementAttempts, 0, "a changed binding must not reach rename");
      assert.equal(report.result.status, "unconfirmed");
      assert.equal(existsSync(target.recovered), false);
      assert.ok(existsSync(target.directory));
      if (fault === "owner-copy") {
        const after = lockState(target.directory);
        assert.equal(after.entries[0].bytes, target.before.entries[0].bytes);
        assert.notEqual(after.entries[0].ino, target.before.entries[0].ino);
      }
      if (fault === "marker-missing") assert.equal(existsSync(fixture.markerPath), false, "inspection and recovery must not repair the marker");
    });
  });
}

test("recovery does not retry a dead owner's EBUSY and retains an unconfirmed outcome", async () => {
  await withRecoveryFixture(async (fixture) => {
    const target = seedDeadOwner(fixture);
    const report = recoveryFault(fixture, target, inspectedRequest(fixture, target, false), "rename-busy");
    assert.equal(report.retirementAttempts, 1);
    assert.equal(report.result.status, "unconfirmed");
    assert.deepEqual(lockState(target.directory), target.before);
    assert.equal(readEvidence(fixture, report.result).outcome.status, "unconfirmed");
  });
});

for (const fault of ["interrupt-before-intent", "interrupt-after-intent", "interrupt-after-rename", "outcome-write"]) {
  test(`recovery resumes the exact original expectation after ${fault}`, async () => {
    await withRecoveryFixture(async (fixture) => {
      const target = seedDeadOwner(fixture);
      const request = inspectedRequest(fixture, target, false);
      const report = recoveryFault(fixture, target, request, fault, fault.startsWith("interrupt-"));
      const renamed = ["interrupt-after-rename", "outcome-write"].includes(fault);
      assert.deepEqual(lockState(renamed ? target.recovered : target.directory), target.before);
      let replacement = null;
      if (renamed) replacement = seedDeadOwner(fixture);
      if (report !== null) {
        assert.equal(report.result.status, "unconfirmed");
        assert.equal(report.result.diagnostics[0].code, "LIFECYCLE_EVIDENCE_PERSISTENCE_FAILURE");
        request.intentHash = report.result.intentHash;
      }
      const resumed = recoverLifecycleLock(fixture.cwd, request);
      assert.equal(resumed.status, renamed ? "already-recovered" : "recovered", JSON.stringify(resumed));
      assert.deepEqual(lockState(target.recovered), target.before);
      if (replacement !== null) assert.deepEqual(lockState(replacement.directory), replacement.before);
      readEvidence(fixture, resumed);
    });
  });
}

test("a post-rename replacement is retained and is never restored over the canonical path", async () => {
  await withRecoveryFixture(async (fixture) => {
    const target = seedDeadOwner(fixture);
    const request = inspectedRequest(fixture, target, false);
    const report = recoveryFault(fixture, target, request, "retired-copy");
    assert.equal(report.retirementAttempts, 1);
    assert.equal(report.result.status, "unconfirmed");
    assert.equal(existsSync(target.canonical), false);
    assert.deepEqual(lockState(path.join(fixture.base, "unexpected-retired")), target.before);
    const unexpected = lockState(target.recovered);
    assert.notEqual(unexpected.directory.ino, target.before.directory.ino);
    assert.equal(unexpected.entries[0].bytes, target.before.entries[0].bytes);
    const replacement = seedDeadOwner(fixture);
    assert.equal(recoverLifecycleLock(fixture.cwd, { ...request, intentHash: report.result.intentHash }).status, "unconfirmed");
    assert.deepEqual(lockState(target.recovered), unexpected);
    assert.deepEqual(lockState(replacement.directory), replacement.before);
  });
});

for (const fault of ["partial", "duplicate", "extra", "invalid-pid", "hardlink", "directory-link", "empty-retired"]) {
  test(`read-only inspection rejects ${fault} ownership without repairing it`, async () => {
    await withRecoveryFixture(async (fixture) => {
      const target = seedDeadOwner(fixture, "repository", fault === "empty-retired" ? "retired" : "canonical");
      const ownerPath = path.join(target.directory, `${target.token}.json`);
      const owner = JSON.parse(readFileSync(ownerPath));
      if (fault === "partial") writeFileSync(ownerPath, "{");
      if (fault === "duplicate") writeFileSync(ownerPath, JSON.stringify(owner).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
      if (fault === "extra") writeFileSync(ownerPath, JSON.stringify({ ...owner, force: true }));
      if (fault === "invalid-pid") writeFileSync(ownerPath, JSON.stringify({ ...owner, processId: 2_147_483_648 }));
      if (fault === "hardlink") {
        linkSync(ownerPath, path.join(fixture.base, "linked-owner"));
        assert.equal(lstatSync(ownerPath).nlink, 2);
      }
      if (fault === "directory-link") {
        const displaced = path.join(fixture.base, "linked-directory");
        renameSync(target.directory, displaced);
        symlinkSync(displaced, target.directory, process.platform === "win32" ? "junction" : "dir");
        assert.equal(lstatSync(target.directory).isSymbolicLink(), true);
      }
      if (fault === "empty-retired") rmSync(ownerPath);
      const before = lockState(target.directory);
      const result = runCli(fixture.cwd, ["lifecycle", "inspect"], { scope: "repository", location: target.location, token: target.token }, 1);
      assert.equal(result.status, "unconfirmed");
      assert.equal(result.expected, null);
      assert.deepEqual(lockState(target.directory), before);
      assert.equal(existsSync(fixture.evidenceDirectory), false);
    });
  });
}

test("closed CLI requests reject duplicate keys, unknown keys and excess bytes", async () => {
  await withRecoveryFixture(async (fixture) => {
    const target = seedDeadOwner(fixture);
    const request = inspectedRequest(fixture, target, false);
    for (const [args, input] of [
      [["lifecycle", "inspect"], '{"scope":"repository","scope":"repository"}'],
      [["lifecycle", "inspect"], { scope: "repository", lockPath: target.directory }],
      [["lifecycle", "inspect"], { scope: "repository", force: true }],
      [["lifecycle", "inspect"], " ".repeat(8193)],
      [["lifecycle", "recover"], { ...request, force: true }],
      [["lifecycle", "recover"], { ...request, expected: null }],
      [["lifecycle", "recover"], { ...request, intentHash: "0".repeat(64) }],
      [["lifecycle", "recover"], JSON.stringify(request).replace('"processId":', '"token":"11111111-1111-4111-8111-111111111111","processId":')],
    ]) {
      const result = runCli(fixture.cwd, args, input, 1);
      assert.equal(result.status, "unconfirmed");
      assert.deepEqual(lockState(target.directory), target.before);
    }
    assert.equal(existsSync(fixture.evidenceDirectory), false);
  });
});

test("malformed lifecycle commands report usage without inspecting or changing locks", async () => {
  await withRecoveryFixture(async (fixture) => {
    const target = seedDeadOwner(fixture);
    for (const args of [["lifecycle"], ["lifecycle", "status"], ["lifecycle", "--force"], ["lifecycle", "inspect", "extra"], ["lifecycle", "recover", "extra"]]) {
      const child = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: fixture.cwd, env: childEnvironment(), input: "{}", encoding: "utf8",
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 1);
      assert.match(child.stdout + child.stderr, /Usage:.*lifecycle inspect\|lifecycle recover/);
      assert.doesNotMatch(child.stdout + child.stderr, /lifecycle-inspection|LIFECYCLE_IDENTITY_REJECTED/);
      assert.deepEqual(lockState(target.directory), target.before);
    }
    assert.equal(existsSync(fixture.evidenceDirectory), false);
  });
});

test("published lifecycle schema uses only constraints enforced by the runtime", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/lifecycle.schema.json", import.meta.url)));
  const supported = new Set([
    "$schema", "$id", "title", "$defs", "$ref", "anyOf", "allOf", "if", "then", "else",
    "const", "enum", "type", "minLength", "maxLength", "pattern", "minimum", "maximum",
    "minItems", "maxItems", "items", "required", "additionalProperties", "properties", "dependentRequired",
  ]);
  const pending = [schema];
  while (pending.length > 0) {
    const shape = pending.pop();
    for (const keyword of Object.keys(shape)) assert.ok(supported.has(keyword), `unsupported runtime constraint: ${keyword}`);
    for (const keyword of ["$defs", "properties"]) pending.push(...Object.values(shape[keyword] ?? {}));
    for (const keyword of ["anyOf", "allOf"]) pending.push(...(shape[keyword] ?? []));
    for (const keyword of ["if", "then", "else", "items"]) {
      if (shape[keyword] !== undefined) pending.push(shape[keyword]);
    }
    if (shape.$ref) assert.match(shape.$ref, /^#\/\$defs\/[^/]+$/);
    if (shape.additionalProperties !== undefined) assert.equal(shape.additionalProperties, false);
    if (shape.type) assert.ok(["object", "array", "string", "integer", "null"].includes(shape.type));
  }
});

test("runtime validation agrees with the closed published lifecycle schema", async () => {
  await withRecoveryFixture(async (fixture) => {
    const target = seedDeadOwner(fixture);
    const request = inspectedRequest(fixture, target, false);
    const inspection = inspectLifecycleLock(fixture.cwd, { scope: "repository" });
    const result = recoverLifecycleLock(fixture.cwd, request);
    assert.equal(result.status, "recovered", JSON.stringify(result));
    const { intent, outcome } = readEvidence(fixture, result);
    const schema = JSON.parse(readFileSync(new URL("../schemas/lifecycle.schema.json", import.meta.url)));
    const ajv = new Ajv2020({ strict: false });
    ajv.addSchema(schema);
    const cases = {
      inspectRequest: { scope: "repository" }, recoverRequest: request, inspection,
      diagnostic: inspection.diagnostics[0], recoveryIntent: intent, recoveryOutcome: outcome, recoveryResult: result,
    };
    for (const [definition, valid] of Object.entries(cases)) {
      const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
      assert.equal(validate(valid), true, JSON.stringify(validate.errors));
      assert.deepEqual(validateLifecycle(valid, definition), []);
      const invalid = [null, [], {}, { ...valid, unexpected: true }, ...Object.keys(valid).map((key) => {
        const copy = structuredClone(valid);
        delete copy[key];
        return copy;
      })];
      for (const value of invalid) assert.equal(validateLifecycle(value, definition).length === 0, validate(value), `${definition}: ${JSON.stringify(value)}`);
    }
    for (const mutate of [
      (value) => { value.expected.owner.identity.ino = "0"; },
      (value) => { value.expected.owner.extra = true; },
      (value) => { value.expected.processId = 0; },
      (value) => { value.expected.attachment = null; },
      (value) => { value.expected.location = "arbitrary"; },
      (value) => { value.expected.scope = "session"; },
      (value) => { value.session_id = "unpaired"; },
    ]) {
      const value = structuredClone(request);
      mutate(value);
      const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/recoverRequest` });
      assert.equal(validate(value), false);
      assert.notEqual(validateLifecycle(value, "recoverRequest").length, 0);
    }
  });
});

function asyncNode(cwd, args, input, ipc = false) {
  const child = spawn(process.execPath, args, { cwd, env: childEnvironment(), stdio: ["pipe", "pipe", "pipe", ...(ipc ? ["ipc"] : [])] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      try {
        assert.equal(signal, null, stderr);
        assert.equal(code, 0, stderr + stdout);
        resolve(stdout.trim() ? JSON.parse(stdout) : null);
      } catch (error) { reject(error); }
    });
  });
  done.catch(() => {});
  child.stdin.end(input);
  return { child, done };
}

function childMessage(child) {
  return new Promise((resolve, reject) => {
    const message = (value) => { cleanup(); resolve(value); };
    const exit = (code, signal) => { cleanup(); reject(new Error(`child exited before its premise observation: ${code}/${signal}`)); };
    const cleanup = () => { child.off("message", message); child.off("exit", exit); child.off("error", failure); };
    const failure = (error) => { cleanup(); reject(error); };
    child.once("message", message);
    child.once("exit", exit);
    child.once("error", failure);
  });
}

test("a real live child owner is inspectable but cannot be recovered", { timeout: 30_000 }, async () => {
  await withRecoveryFixture(async (fixture) => {
    const directory = fixture.canonical("repository");
    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { randomUUID } from "node:crypto";
      const directory = process.argv[1];
      const token = randomUUID();
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, token + ".json"), JSON.stringify({ schemaVersion: 1, token, processId: process.pid, acquiredAt: new Date().toISOString() }));
      process.on("message", () => process.disconnect());
      process.send({ token, processId: process.pid });
    `;
    const running = asyncNode(fixture.cwd, ["--input-type=module", "--eval", script, directory], undefined, true);
    try {
      const owner = await childMessage(running.child);
      assert.equal(owner.processId, running.child.pid);
      assert.doesNotThrow(() => process.kill(owner.processId, 0));
      const before = lockState(directory);
      const inspection = runCli(fixture.cwd, ["lifecycle", "inspect"], { scope: "repository" });
      assert.equal(inspection.diagnostics[0].code, "LIFECYCLE_OWNER_LIVE");
      const result = runCli(fixture.cwd, ["lifecycle", "recover"], { expected: inspection.expected }, 1);
      assert.equal(result.diagnostics[0].code, "LIFECYCLE_OWNER_LIVE");
      assert.deepEqual(lockState(directory), before);
      assert.equal(existsSync(fixture.evidenceDirectory), false);
    } finally {
      if (running.child.connected) running.child.send("exit");
      await running.done;
    }
  });
});

test("two real recoverers fence a replacement acquired after their identical old-owner checks", { timeout: 45_000 }, async () => {
  await withRecoveryFixture(async (fixture) => {
    attachFixture(fixture);
    const target = seedDeadOwner(fixture);
    const request = inspectedRequest(fixture, target);
    const script = `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import path from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      const [cwd, sourcePath, gate, mode, requestText] = process.argv.slice(1);
      const rename = fs.renameSync;
      const cell = new Int32Array(new SharedArrayBuffer(4));
      let rejection = null;
      fs.renameSync = (source, destination, ...args) => {
        if (String(source) === sourcePath && String(destination).endsWith(mode === "recover" ? ".recovered" : ".retired")) {
          const stats = fs.lstatSync(source, { bigint: true });
          const names = fs.readdirSync(source);
          assert.equal(names.length, 1);
          const owner = JSON.parse(fs.readFileSync(path.join(source, names[0])));
          process.send({ phase: "checked", dev: String(stats.dev), ino: String(stats.ino), owner });
          const deadline = performance.now() + 25000;
          while (!fs.existsSync(gate)) {
            assert.ok(performance.now() < deadline, "the parent must release the exact rename gate");
            Atomics.wait(cell, 0, 0, 5);
          }
          try { return rename(source, destination, ...args); }
          catch (error) { rejection = error.code; throw error; }
        }
        return rename(source, destination, ...args);
      };
      syncBuiltinESMExports();
      const { recoverLifecycleLock, handleHook } = await import(${JSON.stringify(coreUrl)});
      const input = JSON.parse(requestText);
      const result = mode === "recover" ? recoverLifecycleLock(cwd, input) : handleHook(input, "PreToolUse");
      process.stdout.write(JSON.stringify({ result, rejection }));
      process.disconnect();
    `;
    const children = [];
    const gates = [];
    const start = (name, mode, input) => {
      const gate = path.join(fixture.base, name);
      gates.push(gate);
      const child = asyncNode(fixture.cwd, ["--input-type=module", "--eval", script, fixture.cwd, target.canonical, gate, mode, JSON.stringify(input)], undefined, true);
      children.push(child);
      return { ...child, gate, ready: childMessage(child.child) };
    };
    try {
      const first = start("first-gate", "recover", request);
      const firstReady = await first.ready;
      const second = start("second-gate", "recover", request);
      const secondReady = await second.ready;
      for (const ready of [firstReady, secondReady]) {
        assert.equal(ready.phase, "checked");
        assert.equal(ready.ino, target.before.directory.ino);
        assert.equal(ready.dev, target.before.directory.dev);
        assert.equal(ready.owner.token, target.token);
        assert.equal(ready.owner.processId, target.processId);
      }
      writeFileSync(first.gate, "proceed");
      assert.equal((await first.done).result.status, "recovered");
      assert.deepEqual(lockState(target.recovered), target.before);
      const acquirer = start("acquirer-gate", "hook", {
        cwd: fixture.cwd, ...fixture.anchor, hook_event_name: "PreToolUse", tool_name: "read_file", tool_use_id: "replacement-acquirer",
        tool_input: { filePath: path.join(fixture.cwd, "tracked.txt") },
      });
      const ready = await acquirer.ready;
      assert.equal(ready.owner.processId, acquirer.child.pid);
      assert.notEqual(ready.owner.token, target.token);
      assert.doesNotThrow(() => process.kill(acquirer.child.pid, 0));
      const replacement = lockState(target.canonical);
      writeFileSync(second.gate, "proceed");
      const rejected = await second.done;
      assert.ok(["ENOTEMPTY", "EEXIST", "EPERM", "EACCES"].includes(rejected.rejection), JSON.stringify(rejected));
      assert.equal(rejected.result.status, "unconfirmed");
      assert.deepEqual(lockState(target.canonical), replacement);
      assert.deepEqual(lockState(target.recovered), target.before);
      writeFileSync(acquirer.gate, "proceed");
      assert.deepEqual((await acquirer.done).result, {});
      assert.equal(existsSync(target.canonical), false);
      assert.deepEqual(lockState(target.recovered), target.before);
    } finally {
      for (const gate of gates) if (!existsSync(gate)) writeFileSync(gate, "cleanup");
      await Promise.allSettled(children.map((child) => child.done));
    }
  });
});

for (const scope of ["repository", "session"]) {
  test(`all real hook envelopes and checkpoint consumers report a dead ${scope} owner`, async () => {
    await withRecoveryFixture(async (fixture) => {
      attachFixture(fixture);
      const target = seedDeadOwner(fixture, scope);
      const before = preservedCampaign(fixture);
      for (const event of ["SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "Stop"]) {
        const result = fixture.invoke(event, { tool_name: "read_file", tool_use_id: "blocked-read", tool_input: { filePath: fixture.planPath } });
        const reason = event === "PreToolUse" ? result.permissionDecisionReason : event === "Stop" ? result.reason : result.additionalContext;
        assert.match(reason, /LIFECYCLE_OWNER_DEAD/);
        assert.match(reason, /lifecycle inspect/);
        assert.equal(result.hookSpecificOutput.hookEventName, event);
        if (event === "PreToolUse") {
          assert.equal(result.permissionDecision, "deny");
          assert.equal(result.hookSpecificOutput.permissionDecisionReason, reason);
          assert.doesNotMatch(reason, /plan write/);
        } else {
          assert.equal(result.systemMessage, reason);
          assert.notEqual(result.decision, "block");
          assert.match(reason, /Do not rely on this run as queue completion/);
        }
        assert.deepEqual(preservedCampaign(fixture), before);
        const cliPayload = {
          cwd: fixture.cwd, sessionId: fixture.anchor.session_id,
          transcript_path: fixture.anchor.transcript_path, tool_name: "read_file",
          tool_use_id: "blocked-cli-read", tool_input: { filePath: fixture.planPath },
        };
        const cliResult = JSON.parse(runChild(fixture.cwd, [launcherPath, event], JSON.stringify(cliPayload)).stdout);
        assert.equal(Object.hasOwn(cliResult, "hookSpecificOutput"), false);
        const cliReason = event === "PreToolUse" ? cliResult.permissionDecisionReason : event === "Stop" ? cliResult.reason : cliResult.additionalContext;
        assert.match(cliReason, /LIFECYCLE_OWNER_DEAD/);
        assert.match(cliReason, /lifecycle inspect/);
        if (event === "PreToolUse") {
          assert.equal(cliResult.permissionDecision, "deny");
          assert.doesNotMatch(cliReason, /plan write/);
        } else {
          assert.equal(cliResult.systemMessage, cliReason);
          assert.notEqual(cliResult.decision, "block");
        }
        assert.deepEqual(preservedCampaign(fixture), before);
      }
      const planHash = canonicalPlanHash(JSON.parse(readFileSync(fixture.planPath)));
      for (const command of ["checkpoint", "resume", ...(scope === "repository" ? ["release"] : [])]) {
        const input = command === "checkpoint" ? { ...fixture.anchor, planHash, attachmentHash: sha256(readFileSync(fixture.attachmentPath)) } :
          command === "resume" ? { ...fixture.anchor, planHash, checkpointHash: null } : {};
        const result = runCli(fixture.cwd, [command], input, 1);
        assert.equal(result.status, "unconfirmed");
        assert.ok(result.lifecycleDiagnostics.some((entry) => entry.code === "LIFECYCLE_OWNER_DEAD" && entry.scope === scope));
        assert.deepEqual(preservedCampaign(fixture), before);
      }
      assert.deepEqual(lockState(target.directory), target.before);
    });
  });
}

test("Git campaign snapshots survive recovery before 16 serial hooks and two four-way batches", { timeout: 90_000 }, async () => {
  await withRecoveryFixture(async (fixture) => {
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: fixture.cwd, env: childEnvironment(), encoding: "utf8", timeout: 20_000 });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    git("init", "--quiet");
    const tracked = path.join(fixture.cwd, "tracked.txt");
    const untracked = path.join(fixture.cwd, "untracked.txt");
    writeFileSync(tracked, "committed\n");
    git("add", "tracked.txt");
    git("-c", "user.name=Recovery Fixture", "-c", "user.email=recovery@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Fixture baseline");
    git("update-ref", "refs/wip/recovery-fixture", "HEAD");
    writeFileSync(tracked, "uncommitted WIP\n");
    writeFileSync(untracked, "untracked WIP\n");
    attachFixture(fixture);
    const target = seedDeadOwner(fixture);
    const preserved = () => ({
      campaign: preservedCampaign(fixture), index: fileState(path.join(fixture.cwd, ".git", "index")),
      tracked: fileState(tracked), untracked: fileState(untracked),
      head: git("rev-parse", "HEAD"), wip: git("rev-parse", "refs/wip/recovery-fixture"), status: git("status", "--porcelain=v1", "-z"),
    });
    const before = preserved();
    const inspection = runCli(fixture.cwd, ["lifecycle", "inspect"], { scope: "repository", ...fixture.anchor });
    assert.equal(inspection.status, "inspected");
    assert.deepEqual(preserved(), before);
    const recovered = runCli(fixture.cwd, ["lifecycle", "recover"], { expected: inspection.expected, ...fixture.anchor });
    assert.equal(recovered.status, "recovered");
    assert.deepEqual(preserved(), before);
    const tool = (id) => ({ tool_name: "read_file", tool_use_id: id, tool_input: { filePath: tracked } });
    for (let index = 0; index < 8; index += 1) {
      assert.deepEqual(fixture.invoke("PreToolUse", tool(`serial-${index}`)), {});
      assert.deepEqual(fixture.invoke("PostToolUse", tool(`serial-${index}`)), {});
    }
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const batch = Array.from({ length: 4 }, (_, index) => asyncNode(fixture.cwd, [launcherPath, event], JSON.stringify({ cwd: fixture.cwd, ...fixture.anchor, hook_event_name: event, ...tool(`parallel-${index}`) })));
      for (const output of await Promise.all(batch.map((entry) => entry.done))) assert.deepEqual(output, {});
    }
    const records = readFileSync(fixture.ledgerPath, "utf8").trim().split("\n").map(JSON.parse);
    const starts = records.filter((record) => record.event === "tool_started");
    const completions = records.filter((record) => record.event === "tool_completed");
    assert.equal(starts.length, 13, "setup plus twelve post-recovery invocations must all be recorded");
    assert.equal(completions.length, 13);
    for (const start of starts) {
      const matching = completions.filter((entry) => entry.operationId === start.operationId && entry.invocationHash === start.invocationHash &&
        entry.session === start.session && entry.routeGeneration === start.routeGeneration && entry.claimGeneration === start.claimGeneration);
      assert.equal(matching.length, 1);
      assert.equal(matching[0].success, true);
    }
    const after = preserved();
    after.campaign.ledgerPath = before.campaign.ledgerPath;
    assert.deepEqual(after, before);
    assert.equal(existsSync(target.canonical), false);
    assert.deepEqual(lockState(target.recovered), target.before);
  });
});
