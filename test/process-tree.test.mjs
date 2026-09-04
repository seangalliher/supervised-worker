import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { canonicalWindowsTaskkill, spawnProcessTreeSync } from "./process-tree.mjs";

test("process watchdog kills a descendant before returning", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-process-tree-"));
  const readinessPath = path.join(directory, "descendant-started.txt");
  const markerPath = path.join(directory, "descendant-survived.txt");
  const descendant = [
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(readinessPath)}, "started");`,
    `setTimeout(() => writeFileSync(${JSON.stringify(markerPath)}, "survived"), 1_500);`,
  ].join("\n");
  const parent = [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit"] });`,
    "setTimeout(() => process.exit(0), 3_000);",
  ].join("\n");
  try {
    const started = performance.now();
    const result = spawnProcessTreeSync(process.execPath, ["-e", parent], {
      timeout: 750,
      cleanupTimeout: 5_000,
    });
    const elapsed = performance.now() - started;
    assert.equal(result.error?.code, "ETIMEDOUT");
    assert.ok(elapsed < 2_500, `process-tree watchdog returned after ${elapsed}ms`);
    assert.equal(existsSync(readinessPath), true, "descendant must start before timeout cleanup");
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    assert.equal(existsSync(markerPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows watchdog rejects a linked system root", {
  skip: process.platform !== "win32",
}, () => {
  const target = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-system-root-"));
  const alias = mkdtempSync(path.join(os.tmpdir(), "supervised-worker-system-alias-"));
  rmSync(alias, { recursive: true, force: true });
  symlinkSync(target, alias, "junction");
  try {
    assert.throws(
      () => canonicalWindowsTaskkill({ SystemRoot: alias, WINDIR: alias }),
      /canonical local directory/,
    );
  } finally {
    rmSync(alias, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("Windows watchdog accepts a canonical system root containing spaces", {
  skip: process.platform !== "win32",
}, () => {
  const systemRoot = mkdtempSync(path.join(os.tmpdir(), "supervised worker system root "));
  const systemDirectory = path.join(systemRoot, "System32");
  const executable = path.join(systemDirectory, "taskkill.exe");
  try {
    mkdirSync(systemDirectory);
    writeFileSync(executable, "fixture\n");
    assert.equal(
      canonicalWindowsTaskkill({ SystemRoot: systemRoot, WINDIR: systemRoot }),
      realpathSync(executable),
    );
  } finally {
    rmSync(systemRoot, { recursive: true, force: true });
  }
});