import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleHook } from "../src/core.mjs";

function probeFixture(context, responses, check) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "windows-locality-")));
  const originalSpawn = childProcess.spawnSync;
  let clock = Date.now();
  const calls = [];
  context.mock.method(Date, "now", () => clock);
  context.mock.method(childProcess, "spawnSync", (executable, args, options) => {
    const name = path.basename(String(executable)).toLowerCase();
    if (!["net.exe", "subst.exe"].includes(name)) return originalSpawn(executable, args, options);
    assert.deepEqual(args, name === "subst.exe" ? [] : ["use", path.parse(root).root.slice(0, 2).toUpperCase()]);
    assert.equal(existsSync(path.join(root, ".supervised-worker")), false, "locality probes must precede campaign-state creation");
    assert.ok(options.timeout > 0 && options.timeout <= 500);
    calls.push({ name, args, timeout: options.timeout });
    const count = calls.filter((call) => call.name === name).length;
    const result = responses(name, count, options.timeout, root);
    clock += result.elapsedMs ?? 0;
    if (result.timeout) return { error: Object.assign(new Error("fixture timeout"), { code: "ETIMEDOUT" }), status: null, stdout: "", stderr: "" };
    if (result.error) return { error: Object.assign(new Error("fixture error"), { code: result.error }), status: null, stdout: "", stderr: "" };
    return { status: result.status ?? (name === "net.exe" ? 2 : 0), stdout: result.stdout ?? "", stderr: "" };
  });
  syncBuiltinESMExports();
  try {
    const result = handleHook({ cwd: root, session_id: "locality-fixture", tool_name: "Read",
      tool_input: { file_path: path.join(root, "readme.txt") } }, "PreToolUse");
    check(result, calls);
    assert.equal(existsSync(path.join(root, ".supervised-worker")), false);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
}

for (const target of ["subst.exe", "net.exe"]) {
  test(`Windows locality retries one timed-out ${target} without enlarging its budget`, { skip: process.platform !== "win32" }, (context) => {
    probeFixture(context, (name, count) => name === target && count === 1 ? { timeout: true, elapsedMs: 500 } : {}, (result, calls) => {
      assert.deepEqual(result, {});
      assert.equal(calls.filter((call) => call.name === target).length, 2, "timeout premise must force a second real helper invocation");
    });
  });

  test(`Windows locality never treats exhausted ${target} retries as local`, { skip: process.platform !== "win32" }, (context) => {
    probeFixture(context, (name) => name === target ? { timeout: true, elapsedMs: 500 } : {}, (result, calls) => {
      assert.equal(result.permissionDecision, "deny");
      assert.equal(calls.filter((call) => call.name === target).length, 2);
    });
  });

  test(`Windows locality does not retry non-timeout ${target} errors`, { skip: process.platform !== "win32" }, (context) => {
    probeFixture(context, (name) => name === target ? { error: "EACCES" } : {}, (result, calls) => {
      assert.equal(result.permissionDecision, "deny");
      assert.equal(calls.filter((call) => call.name === target).length, 1);
    });
  });

  test(`Windows locality rejects a ${target} network or alias result after a timeout`, { skip: process.platform !== "win32" }, (context) => {
    probeFixture(context, (name, count, timeout, root) => {
      if (name !== target) return {};
      if (count === 1) return { timeout: true, elapsedMs: timeout };
      return target === "net.exe" ? { status: 0 } : { stdout: `${path.parse(root).root.slice(0, 1).toUpperCase()}:\\: => C:\\fixture\r\n` };
    }, (result, calls) => {
      assert.equal(result.permissionDecision, "deny");
      assert.equal(calls.filter((call) => call.name === target).length, 2);
    });
  });
}

test("Windows locality retains the 1500ms aggregate ceiling across retries", { skip: process.platform !== "win32" }, (context) => {
  probeFixture(context, (name, count, timeout) => name === "subst.exe" && count === 2
    ? { elapsedMs: 500 } : { timeout: true, elapsedMs: timeout }, (result, calls) => {
    assert.equal(result.permissionDecision, "deny");
    assert.deepEqual(calls.map((call) => [call.name, call.timeout]), [["subst.exe", 500], ["subst.exe", 500], ["net.exe", 500]]);
  });
});

test("Windows locality rejects a successful but over-budget probe", { skip: process.platform !== "win32" }, (context) => {
  probeFixture(context, (name) => ({ elapsedMs: name === "subst.exe" ? 10 : 1490 }), (result, calls) => {
    assert.equal(result.permissionDecision, "deny");
    assert.deepEqual(calls.map((call) => [call.name, call.timeout]), [["subst.exe", 500], ["net.exe", 500]],
      "the final local-drive success must arrive at the total deadline, with no later probe to mask the rejection");
  });
});