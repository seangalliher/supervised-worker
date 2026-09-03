import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const testModuleUrl = import.meta.url;
const coreUrl = new URL("../src/core.mjs", testModuleUrl).href;

function runIsolated(script, timeout = 10_000) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function filesystemPrelude(sessionId) {
  return `
    import assert from "node:assert/strict";
    import { createRequire, syncBuiltinESMExports } from "node:module";
    import os from "node:os";
    import path from "node:path";
    const require = createRequire(${JSON.stringify(testModuleUrl)});
    const fs = require("node:fs");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "supervised-worker-fault-"));
    const pluginRoot = path.join(base, "plugin");
    const repositoryRoot = path.join(base, "repository");
    const storageRoot = path.join(base, "storage");
    for (const directory of [pluginRoot, repositoryRoot, storageRoot]) {
      fs.mkdirSync(directory);
    }
    const sessionId = ${JSON.stringify(sessionId)};
    const transcriptDirectory = path.join(storageRoot, "GitHub.copilot-chat", "transcripts");
    fs.mkdirSync(transcriptDirectory, { recursive: true });
    fs.writeFileSync(path.join(storageRoot, "workspace.json"), "{}\\n");
    const transcriptPath = path.join(transcriptDirectory, sessionId + ".jsonl");
    fs.writeFileSync(transcriptPath, "");
    const originalRenameSync = fs.renameSync;
    const originalAppendFileSync = fs.appendFileSync;
    const originalRmSync = fs.rmSync;
  `;
}

function filesystemCleanup() {
  return `
    } finally {
      fs.renameSync = originalRenameSync;
      fs.appendFileSync = originalAppendFileSync;
      fs.rmSync = originalRmSync;
      syncBuiltinESMExports();
      fs.rmSync(base, { recursive: true, force: true });
    }
  `;
}

test("stale locks are never automatically renamed or replaced", () => {
  runIsolated(`
    ${filesystemPrelude("aba-lock-session")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const lockDirectory = path.join(
        storageRoot,
        "supervised-worker",
        "session-locks",
        sha256(sessionId),
      );
      fs.mkdirSync(lockDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(lockDirectory, "owner.json"),
        JSON.stringify({
          schemaVersion: 1,
          token: "stale-owner",
          processId: 1,
          acquiredAt: "2000-01-01T00:00:00Z",
        }) + "\\n",
      );
      const expired = new Date(Date.now() - 60_000);
      fs.utimesSync(lockDirectory, expired, expired);
      let renameAttempted = false;
      fs.renameSync = (source, destination) => {
        if (path.resolve(source) === path.resolve(lockDirectory)) {
          renameAttempted = true;
        }
        return originalRenameSync(source, destination);
      };
      syncBuiltinESMExports();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.equal(output.permissionDecision, "deny");
      assert.equal(renameAttempted, false);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(lockDirectory, "owner.json"), "utf8")).token,
        "stale-owner",
      );
      assert.equal(
        fs.existsSync(path.join(repositoryRoot, ".supervised-worker", "attachment.json")),
        false,
      );
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      assert.equal(fs.existsSync(routePath), false);
    ${filesystemCleanup()}
  `);
});

for (const failurePoint of ["attachment-migration", "route-promotion"]) {
  test(`v1 migration fault at ${failurePoint} releases the claimed route`, () => {
    runIsolated(`
      ${filesystemPrelude(`migration-${failurePoint}`)}
      try {
        const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
        const stateDirectory = path.join(repositoryRoot, ".supervised-worker");
        fs.mkdirSync(stateDirectory);
        fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({
          schemaVersion: 1,
          mode: "active",
          goal: "Exercise migration rollback.",
          items: [{ id: "one", title: "One", status: "in_progress" }],
          completion: null,
        }) + "\\n");
        const attachmentPath = path.join(stateDirectory, "attachment.json");
        const legacyAttachment = JSON.stringify({
          schemaVersion: 1,
          sessionHash: sha256(sessionId),
          attachedAt: "2026-09-01T00:00:00Z",
        }, null, 2) + "\\n";
        fs.writeFileSync(attachmentPath, legacyAttachment);
        const routePath = path.join(
          storageRoot,
          "supervised-worker",
          "session-roots",
          sha256(sessionId),
          "route.json",
        );
        let injected = false;
        fs.renameSync = (source, destination) => {
          const isAttachmentMigration = path.resolve(destination) === path.resolve(attachmentPath);
          const isRoutePromotion = path.resolve(destination) === path.resolve(routePath);
          if (!injected && (
            (${JSON.stringify(failurePoint)} === "attachment-migration" && isAttachmentMigration) ||
            (${JSON.stringify(failurePoint)} === "route-promotion" && isRoutePromotion)
          )) {
            injected = true;
            const error = new Error("injected rename failure");
            error.code = "EIO";
            throw error;
          }
          return originalRenameSync(source, destination);
        };
        syncBuiltinESMExports();
        const output = handleHook({
          hook_event_name: "PreToolUse",
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: pluginRoot,
          tool_name: "Write",
          tool_input: { file_path: planPath(repositoryRoot) },
        }, "PreToolUse");
        assert.equal(output.permissionDecision, "deny");
        assert.equal(injected, true);
        assert.equal(fs.readFileSync(attachmentPath, "utf8"), legacyAttachment);
        assert.equal(JSON.parse(fs.readFileSync(routePath, "utf8")).status, "released");
        assert.equal(
          fs.readdirSync(stateDirectory).some((name) => name.endsWith(".tmp")),
          false,
        );
      ${filesystemCleanup()}
    `);
  });
}

test("v1 migration restoration failure still leaves a recoverable released route", () => {
  runIsolated(`
    ${filesystemPrelude("migration-restore-failure")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const stateDirectory = path.join(repositoryRoot, ".supervised-worker");
      fs.mkdirSync(stateDirectory);
      fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({
        schemaVersion: 1,
        mode: "active",
        goal: "Exercise restoration recovery.",
        items: [{ id: "one", title: "One", status: "in_progress" }],
        completion: null,
      }) + "\\n");
      const attachmentPath = path.join(stateDirectory, "attachment.json");
      fs.writeFileSync(attachmentPath, JSON.stringify({
        schemaVersion: 1,
        sessionHash: sha256(sessionId),
        attachedAt: "2026-09-01T00:00:00Z",
      }, null, 2) + "\\n");
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      let attachmentWrites = 0;
      let routeWrites = 0;
      fs.renameSync = (source, destination) => {
        if (path.resolve(destination) === path.resolve(attachmentPath)) {
          attachmentWrites += 1;
          if (attachmentWrites === 2) {
            const error = new Error("injected restoration failure");
            error.code = "EIO";
            throw error;
          }
        }
        if (path.resolve(destination) === path.resolve(routePath)) {
          routeWrites += 1;
          if (routeWrites === 1) {
            const error = new Error("injected route promotion failure");
            error.code = "EIO";
            throw error;
          }
        }
        return originalRenameSync(source, destination);
      };
      syncBuiltinESMExports();
      const common = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
      };
      const output = handleHook({
        ...common,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      assert.equal(output.permissionDecision, "deny");
      assert.equal(attachmentWrites, 2);
      assert.equal(JSON.parse(fs.readFileSync(routePath, "utf8")).status, "released");
      fs.renameSync = originalRenameSync;
      syncBuiltinESMExports();
      assert.deepEqual(
        handleHook({ ...common, hook_event_name: "SessionStart" }, "SessionStart"),
        {},
      );
      assert.equal(fs.existsSync(attachmentPath), false);
    ${filesystemCleanup()}
  `);
});

for (const eventName of ["PostToolUse", "PostToolUseFailure"]) {
  test(`${eventName} reports route-release failure without claiming cleanup`, () => {
    runIsolated(`
      ${filesystemPrelude(`detach-${eventName}`)}
      try {
        const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
        const common = {
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: pluginRoot,
          tool_name: "Write",
          tool_input: { file_path: planPath(repositoryRoot) },
        };
        assert.deepEqual(
          handleHook({ ...common, hook_event_name: "PreToolUse" }, "PreToolUse"),
          {},
        );
        const routePath = path.join(
          storageRoot,
          "supervised-worker",
          "session-roots",
          sha256(sessionId),
          "route.json",
        );
        const attachmentPath = path.join(
          repositoryRoot,
          ".supervised-worker",
          "attachment.json",
        );
        let injected = false;
        fs.renameSync = (source, destination) => {
          if (!injected && path.resolve(destination) === path.resolve(routePath)) {
            injected = true;
            const error = new Error("injected route release failure");
            error.code = "EIO";
            throw error;
          }
          return originalRenameSync(source, destination);
        };
        syncBuiltinESMExports();
        const output = handleHook(
          { ...common, hook_event_name: ${JSON.stringify(eventName)} },
          ${JSON.stringify(eventName)},
        );
        assert.equal(injected, true);
        assert.match(output.additionalContext, /cleanup.*failed/i);
        assert.doesNotMatch(output.additionalContext, /released its provisional claim/);
        assert.equal(JSON.parse(fs.readFileSync(routePath, "utf8")).status, "provisional");
        assert.equal(JSON.parse(fs.readFileSync(attachmentPath, "utf8")).status, "provisional");
        const runsDirectory = path.join(repositoryRoot, ".supervised-worker", "runs");
        const records = fs.readdirSync(runsDirectory).flatMap((name) =>
          fs.readFileSync(path.join(runsDirectory, name), "utf8")
            .trim()
            .split("\\n")
            .map((line) => JSON.parse(line)),
        );
        assert.equal(records.some((record) => record.event === "provisional_claim_released"), false);
        assert.equal(records.some((record) => record.event === "completion_unverified_release"), false);
        assert.equal(records.at(-1).event, "ownership_cleanup_failed");
      ${filesystemCleanup()}
    `);
  });
}

test("bounded Stop reports route-release failure without claiming cleanup", () => {
  runIsolated(`
    ${filesystemPrelude("detach-stop")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const common = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
      };
      const tool = {
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      };
      handleHook({ ...common, ...tool, hook_event_name: "PreToolUse" }, "PreToolUse");
      fs.writeFileSync(planPath(repositoryRoot), JSON.stringify({
        schemaVersion: 1,
        mode: "active",
        goal: "Exercise Stop cleanup failure.",
        items: [{ id: "one", title: "One", status: "in_progress" }],
        completion: null,
      }) + "\\n");
      handleHook({ ...common, ...tool, hook_event_name: "PostToolUse" }, "PostToolUse");
      assert.equal(handleHook({ ...common, hook_event_name: "Stop" }, "Stop").decision, "block");
      assert.equal(
        handleHook({ ...common, hook_event_name: "Stop", stop_hook_active: true }, "Stop").decision,
        "block",
      );
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
      let injected = false;
      fs.renameSync = (source, destination) => {
        if (!injected && path.resolve(destination) === path.resolve(routePath)) {
          injected = true;
          const error = new Error("injected Stop release failure");
          error.code = "EIO";
          throw error;
        }
        return originalRenameSync(source, destination);
      };
      syncBuiltinESMExports();
      const output = handleHook(
        { ...common, hook_event_name: "Stop", stop_hook_active: true },
        "Stop",
      );
      assert.equal(injected, true);
      assert.equal(output.decision, "allow");
      assert.match(output.systemMessage, /cleanup failed/);
      assert.doesNotMatch(output.systemMessage, /released the Stop gate/);
      assert.equal(JSON.parse(fs.readFileSync(routePath, "utf8")).status, "active");
      assert.equal(JSON.parse(fs.readFileSync(attachmentPath, "utf8")).status, "active");
      const runsDirectory = path.join(repositoryRoot, ".supervised-worker", "runs");
      const records = fs.readdirSync(runsDirectory).flatMap((name) =>
        fs.readFileSync(path.join(runsDirectory, name), "utf8")
          .trim()
          .split("\\n")
          .map((line) => JSON.parse(line)),
      );
      assert.equal(records.some((record) => record.event === "completion_unverified_release"), false);
      assert.equal(records.at(-1).event, "ownership_cleanup_failed");
    ${filesystemCleanup()}
  `);
});

for (const eventName of ["PostToolUse", "PostToolUseFailure"]) {
  test(`${eventName} reports cleanup failure when its attachment disappears`, () => {
    runIsolated(`
      ${filesystemPrelude(`missing-attachment-${eventName}`)}
      try {
        const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
        const common = {
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: pluginRoot,
          tool_name: "Write",
          tool_input: { file_path: planPath(repositoryRoot) },
        };
        handleHook({ ...common, hook_event_name: "PreToolUse" }, "PreToolUse");
        const routePath = path.join(
          storageRoot,
          "supervised-worker",
          "session-roots",
          sha256(sessionId),
          "route.json",
        );
        const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
        let removed = false;
        fs.appendFileSync = (filePath, ...args) => {
          const result = originalAppendFileSync(filePath, ...args);
          if (!removed && String(filePath).includes(path.join(".supervised-worker", "runs"))) {
            removed = true;
            originalRmSync(attachmentPath, { force: true });
          }
          return result;
        };
        syncBuiltinESMExports();
        const output = handleHook(
          { ...common, hook_event_name: ${JSON.stringify(eventName)} },
          ${JSON.stringify(eventName)},
        );
        assert.equal(removed, true);
        assert.match(output.additionalContext, /cleanup.*failed/i);
        assert.equal(JSON.parse(fs.readFileSync(routePath, "utf8")).status, "provisional");
        assert.equal(fs.existsSync(attachmentPath), false);
        const runsDirectory = path.join(repositoryRoot, ".supervised-worker", "runs");
        const records = fs.readdirSync(runsDirectory).flatMap((name) =>
          fs.readFileSync(path.join(runsDirectory, name), "utf8")
            .trim()
            .split("\\n")
            .map((line) => JSON.parse(line)),
        );
        assert.equal(records.some((record) => record.event === "provisional_claim_released"), false);
        assert.equal(records.at(-1).event, "ownership_cleanup_failed");
      ${filesystemCleanup()}
    `);
  });
}

test("Stop reports cleanup failure when its attachment disappears", () => {
  runIsolated(`
    ${filesystemPrelude("missing-attachment-stop")}
    try {
      const { handleHook, planPath, sha256 } = await import(${JSON.stringify(coreUrl)});
      const common = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: pluginRoot,
      };
      handleHook({
        ...common,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: planPath(repositoryRoot) },
      }, "PreToolUse");
      const routePath = path.join(
        storageRoot,
        "supervised-worker",
        "session-roots",
        sha256(sessionId),
        "route.json",
      );
      const attachmentPath = path.join(repositoryRoot, ".supervised-worker", "attachment.json");
      let removed = false;
      fs.rmSync = (filePath, ...args) => {
        if (!removed && String(filePath).includes(path.join(".supervised-worker", "runtime"))) {
          removed = true;
          originalRmSync(attachmentPath, { force: true });
        }
        return originalRmSync(filePath, ...args);
      };
      syncBuiltinESMExports();
      const output = handleHook({ ...common, hook_event_name: "Stop" }, "Stop");
      assert.equal(removed, true);
      assert.equal(output.decision, "allow");
      assert.match(output.systemMessage, /cleanup failed/);
      assert.equal(JSON.parse(fs.readFileSync(routePath, "utf8")).status, "provisional");
      assert.equal(fs.existsSync(attachmentPath), false);
      const runsDirectory = path.join(repositoryRoot, ".supervised-worker", "runs");
      const records = fs.readdirSync(runsDirectory).flatMap((name) =>
        fs.readFileSync(path.join(runsDirectory, name), "utf8")
          .trim()
          .split("\\n")
          .map((line) => JSON.parse(line)),
      );
      assert.equal(records.some((record) => record.event === "provisional_claim_released"), false);
      assert.equal(records.at(-1).event, "ownership_cleanup_failed");
    ${filesystemCleanup()}
  `);
});

test("aggregate Windows drive checks remain bounded with slow child commands", {
  skip: process.platform !== "win32",
}, () => {
  runIsolated(`
    import assert from "node:assert/strict";
    import { createRequire, syncBuiltinESMExports } from "node:module";
    import path from "node:path";
    const require = createRequire(${JSON.stringify(testModuleUrl)});
    const childProcess = require("node:child_process");
    const originalSpawnSync = childProcess.spawnSync;
    let substCalls = 0;
    let netCalls = 0;
    try {
      childProcess.spawnSync = (executable, ...args) => {
        const name = path.basename(String(executable)).toLowerCase();
        if (name === "subst.exe") {
          substCalls += 1;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (name === "net.exe") {
          netCalls += 1;
          const end = Date.now() + 440;
          while (Date.now() < end) {}
          return { status: 2, stdout: "", stderr: "" };
        }
        return originalSpawnSync(executable, ...args);
      };
      syncBuiltinESMExports();
      const { handleHook } = await import(${JSON.stringify(coreUrl)});
      const replacements = [..."EFGHIJKLMNOPQ"].map((drive, index) => ({
        filePath: drive + ":\\\\repository-" + index + "\\\\.git\\\\config",
      }));
      const started = Date.now();
      const output = handleHook({
        hook_event_name: "PreToolUse",
        session_id: "slow-drive-session",
        cwd: "D:\\\\supervised-worker",
        tool_name: "multi_replace_string_in_file",
        tool_input: { replacements },
      }, "PreToolUse");
      const elapsed = Date.now() - started;
      assert.equal(output.permissionDecision, "deny");
      assert.equal(substCalls, 1);
      assert.equal(netCalls, 3);
      assert.ok(elapsed < 2_200, "aggregate drive checks took " + elapsed + "ms");
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      syncBuiltinESMExports();
    }
  `, 5_000);
});
