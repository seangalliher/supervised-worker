import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildInstalledHookManifest,
  defaultInstallBase,
  installLocalPlugin,
} from "../src/install.mjs";
import { spawnProcessTreeSync } from "./process-tree.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_SOURCE_ENTRIES = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "agents",
  "com.github.copilot",
  "hooks.json",
  "plugin.json",
  "policy",
  "schemas",
  "skills",
  "src",
];

function temporaryDirectory(prefix) {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function copyInstallSource(target, omittedEntry = null) {
  for (const entry of INSTALL_SOURCE_ENTRIES) {
    if (entry === omittedEntry) continue;
    cpSync(path.join(root, entry), path.join(target, entry), { recursive: true });
  }
}

function hookPayload(cwd) {
  return JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: "installed-hook-session",
    cwd,
  });
}

function installedTreeHash(installRoot) {
  const files = [];
  function walk(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relativePath === "install-record.json") continue;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relativePath);
      else if (entry.isFile()) files.push(relativePath);
    }
  }
  walk(installRoot);
  files.sort();
  const hash = createHash("sha256");
  hash.update("supervised-worker-file-tree-v1\0");
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(files.length));
  hash.update(count);
  for (const relativePath of files) {
    const pathBytes = Buffer.from(relativePath, "utf8");
    const contentBytes = readFileSync(path.join(installRoot, ...relativePath.split("/")));
    const pathLength = Buffer.alloc(8);
    const contentLength = Buffer.alloc(8);
    pathLength.writeBigUInt64BE(BigInt(pathBytes.length));
    contentLength.writeBigUInt64BE(BigInt(contentBytes.length));
    hash.update(pathLength);
    hash.update(pathBytes);
    hash.update(contentLength);
    hash.update(contentBytes);
  }
  return hash.digest("hex");
}

test("default install base stays in per-user application data", () => {
  assert.equal(
    defaultInstallBase({
      platform: "win32",
      environment: { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" },
    }),
    "C:\\Users\\example\\AppData\\Local\\SupervisedWorker\\plugins",
  );
  assert.equal(
    defaultInstallBase({
      platform: "linux",
      environment: { XDG_DATA_HOME: "/home/example/.data" },
      homeDirectory: "/home/example",
    }),
    "/home/example/.data/supervised-worker/plugins",
  );
  assert.equal(
    defaultInstallBase({
      platform: "darwin",
      environment: {},
      homeDirectory: "/Users/example",
    }),
    "/Users/example/Library/Application Support/SupervisedWorker/plugins",
  );
});

test("installed Unix launchers use absolute trusted paths without cwd fallback", () => {
  const manifest = buildInstalledHookManifest({
    installRoot: "/home/example/.local/share/supervised-worker/plugins/release",
    nodePath: "/usr/bin/node",
    platform: "linux",
    environment: {},
  });
  for (const [eventName, [entry]] of Object.entries(manifest.hooks)) {
    assert.equal(entry.timeoutSec, 5, eventName);
    assert.match(entry.bash, /^unset NODE_OPTIONS COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN;/);
    assert.match(entry.bash, /'\/usr\/bin\/node'/);
    assert.match(entry.bash, /'\/home\/example\/\.local\/share\/supervised-worker\/plugins\/release\/src\/hook-launcher\.mjs'/);
    assert.ok(entry.bash.endsWith(`'${eventName}'`));
    assert.doesNotMatch(entry.bash, /PLUGIN_ROOT|\$PWD/);
  }
});

test("content-addressed Windows install runs trusted hooks outside the workspace", {
  skip: process.platform !== "win32",
}, () => {
  const installBase = temporaryDirectory("supervised-worker-install-");
  const untrustedWorkspace = temporaryDirectory("supervised-worker-untrusted-");
  const trustedTools = temporaryDirectory("supervised-worker-trusted-tools-");
  try {
    const nodeShim = path.join(trustedTools, "node-shim.cmd");
    writeFileSync(
      nodeShim,
      [
        "@echo off",
        "if defined NODE_OPTIONS exit /b 80",
        "if defined COPILOT_GITHUB_TOKEN exit /b 81",
        "if defined GH_TOKEN exit /b 82",
        "if defined GITHUB_TOKEN exit /b 83",
        "> \"%CAPTURE_FILE%\" echo clean",
        `\"${process.execPath}\" %*`,
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n"),
    );
    const result = installLocalPlugin(root, {
      baseDirectory: installBase,
      nodePath: nodeShim,
    });
    assert.equal(result.reused, false);
    assert.ok(result.installRoot.startsWith(installBase));
    assert.equal(existsSync(path.join(result.installRoot, "src", "hook-launcher.mjs")), true);
    const rootHooks = readFileSync(path.join(result.installRoot, "hooks.json"));
    const namespacedHooks = readFileSync(
      path.join(result.installRoot, "com.github.copilot", "hooks", "hooks.json"),
    );
    assert.deepEqual(namespacedHooks, rootHooks);
    const hooks = JSON.parse(rootHooks.toString("utf8")).hooks;
    for (const [eventName, [entry]] of Object.entries(hooks)) {
      assert.equal(entry.timeoutSec, 10, eventName);
    }

    const plantedSource = path.join(untrustedWorkspace, "src");
    const plantedMarker = path.join(untrustedWorkspace, "planted-ran.txt");
    mkdirSync(plantedSource);
    writeFileSync(
      path.join(plantedSource, "hook-launcher.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(plantedMarker)}, "ran");\n`,
    );
    const capturePath = path.join(untrustedWorkspace, "clean-environment.txt");
    const preloadMarker = path.join(untrustedWorkspace, "preload-ran.txt");
    const preloadPath = path.join(untrustedWorkspace, "untrusted-preload.cjs");
    writeFileSync(
      preloadPath,
      `require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'ran');\n`,
    );
    const environment = {
      ...process.env,
      CAPTURE_FILE: capturePath,
      COPILOT_GITHUB_TOKEN: "copilot-secret",
      GH_TOKEN: "gh-secret",
      GITHUB_TOKEN: "github-secret",
      NODE_OPTIONS: `--require=${preloadPath}`,
      PLUGIN_ROOT: "",
    };
    const command = hooks.SessionStart[0].powershell;
    for (const [shell, args] of [
      ["pwsh", ["-NoProfile", "-NonInteractive", "-Command", command]],
      [process.env.ComSpec, ["/d", "/s", "/c", command]],
    ]) {
      rmSync(capturePath, { force: true });
      const execution = spawnProcessTreeSync(shell, args, {
        cwd: untrustedWorkspace,
        env: environment,
        input: hookPayload(untrustedWorkspace),
        timeout: 15_000,
      });
      assert.equal(execution.error, undefined, execution.error?.message);
      assert.equal(execution.signal, null, execution.stderr);
      assert.equal(execution.status, 0, execution.stderr);
      assert.deepEqual(JSON.parse(execution.stdout.trim()), {});
      assert.equal(readFileSync(capturePath, "utf8").trim(), "clean");
      assert.equal(existsSync(preloadMarker), false);
      assert.equal(existsSync(plantedMarker), false);
      assert.ok(
        execution.elapsedMs < hooks.SessionStart[0].timeoutSec * 1_000,
        `${shell} exceeded the installed hook timeout: ${execution.elapsedMs}ms`,
      );
    }

    const reused = installLocalPlugin(root, {
      baseDirectory: installBase,
      nodePath: nodeShim,
    });
    assert.equal(reused.reused, true);
    assert.equal(reused.installRoot, result.installRoot);
    assert.equal(reused.sourceHash, result.sourceHash);

    const launcherPath = path.join(result.installRoot, "src", "hook-launcher.mjs");
    writeFileSync(launcherPath, `${readFileSync(launcherPath, "utf8")}\n// tampered\n`);
    assert.throws(
      () => installLocalPlugin(root, { baseDirectory: installBase, nodePath: nodeShim }),
      /does not match its record/,
    );
  } finally {
    rmSync(trustedTools, { recursive: true, force: true });
    rmSync(untrustedWorkspace, { recursive: true, force: true });
    rmSync(installBase, { recursive: true, force: true });
  }
});

test("Windows installer rejects hostile or noncanonical SystemRoot values", {
  skip: process.platform !== "win32",
}, () => {
  for (const systemRoot of [
    "C:\\Windows&C:\\evil.exe&rem",
    "C:\\Windows|C:\\evil.exe",
    "C:\\Windows;C:\\evil.exe",
    "C:\\Windows with space",
    "C:\\Windows\\System32\\..",
    "C:\\Windows\\.\\System32",
  ]) {
    assert.throws(
      () => buildInstalledHookManifest({
        installRoot: "C:\\trusted\\plugin",
        nodePath: process.execPath,
        platform: "win32",
        environment: { ...process.env, SystemRoot: systemRoot, WINDIR: systemRoot },
      }),
      /SystemRoot/,
    );
  }
});

test("generated Windows launcher fails nonzero when Node cannot start", {
  skip: process.platform !== "win32",
}, () => {
  const cwd = temporaryDirectory("supervised-worker-missing-node-");
  try {
    const hooks = buildInstalledHookManifest({
      installRoot: path.join(cwd, "installed plugin"),
      nodePath: path.join(cwd, "missing node.exe"),
      platform: "win32",
      environment: process.env,
    }).hooks;
    const command = hooks.SessionStart[0].powershell;
    for (const [shell, args] of [
      ["pwsh", ["-NoProfile", "-NonInteractive", "-Command", command]],
      [process.env.ComSpec, ["/d", "/s", "/c", command]],
    ]) {
      const execution = spawnProcessTreeSync(shell, args, {
        cwd,
        input: hookPayload(cwd),
        timeout: 15_000,
      });
      assert.equal(execution.error, undefined, execution.error?.message);
      assert.notEqual(execution.status, 0, `${shell}: ${execution.stderr}`);
      assert.match(execution.stderr, /not recognized|not found|cannot find/i);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("changed launch configuration produces a different installation identity", {
  skip: process.platform !== "win32",
}, () => {
  const installBase = temporaryDirectory("supervised-worker-launch-identity-");
  try {
    const first = installLocalPlugin(root, {
      baseDirectory: installBase,
      nodePath: "C:\\trusted-a\\node.exe",
    });
    const second = installLocalPlugin(root, {
      baseDirectory: installBase,
      nodePath: "C:\\trusted-b\\node.exe",
    });
    assert.notEqual(first.installRoot, second.installRoot);
    const firstRecord = JSON.parse(
      readFileSync(path.join(first.installRoot, "install-record.json"), "utf8"),
    );
    const secondRecord = JSON.parse(
      readFileSync(path.join(second.installRoot, "install-record.json"), "utf8"),
    );
    assert.equal(firstRecord.nodePath, "C:\\trusted-a\\node.exe");
    assert.equal(secondRecord.nodePath, "C:\\trusted-b\\node.exe");
    assert.notEqual(firstRecord.installIdentityHash, secondRecord.installIdentityHash);
    assert.equal(firstRecord.installFormatVersion, 5);
    assert.equal(secondRecord.installFormatVersion, 5);
    assert.equal(firstRecord.baseDirectory, installBase.toLowerCase());
    assert.equal(secondRecord.baseDirectory, installBase.toLowerCase());
  } finally {
    rmSync(installBase, { recursive: true, force: true });
  }
});

test("relocated installation bytes cannot be reused at a different base", {
  skip: process.platform !== "win32",
}, () => {
  const firstBase = temporaryDirectory("supervised-worker-first-base-");
  const secondBase = temporaryDirectory("supervised-worker-second-base-");
  try {
    const first = installLocalPlugin(root, { baseDirectory: firstBase });
    const relocatedRoot = path.join(secondBase, path.basename(first.installRoot));
    cpSync(first.installRoot, relocatedRoot, { recursive: true });

    const second = installLocalPlugin(root, { baseDirectory: secondBase });
    assert.equal(second.reused, false);
    assert.notEqual(second.installRoot, relocatedRoot);
    assert.notEqual(path.basename(second.installRoot), path.basename(first.installRoot));
    const secondRecord = JSON.parse(
      readFileSync(path.join(second.installRoot, "install-record.json"), "utf8"),
    );
    assert.equal(secondRecord.baseDirectory, secondBase.toLowerCase());
    const command = JSON.parse(
      readFileSync(path.join(second.installRoot, "hooks.json"), "utf8"),
    ).hooks.SessionStart[0].powershell;
    const encoded = command.match(/-EncodedCommand\s+(\S+)$/)?.[1];
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    assert.match(decoded, new RegExp(second.installRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    assert.doesNotMatch(decoded, new RegExp(first.installRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  } finally {
    rmSync(firstBase, { recursive: true, force: true });
    rmSync(secondBase, { recursive: true, force: true });
  }
});

test("installer rejects unsafe plugin versions before escaping its base", () => {
  const source = temporaryDirectory("supervised-worker-version-source-");
  const installBase = temporaryDirectory("supervised-worker-version-base-");
  try {
    copyInstallSource(source);
    const pluginPath = path.join(source, "plugin.json");
    const baseline = JSON.parse(readFileSync(pluginPath, "utf8"));
    for (const version of ["../escaped", "1.2.3/escaped", "1.2.3\\escaped", "1.2", null]) {
      writeFileSync(
        pluginPath,
        `${JSON.stringify({ ...baseline, version }, null, 2)}\n`,
      );
      assert.throws(
        () => installLocalPlugin(source, { baseDirectory: installBase }),
        /safe semantic version/,
      );
      assert.deepEqual(readdirSync(installBase), []);
    }
    const missingVersion = { ...baseline };
    delete missingVersion.version;
    writeFileSync(pluginPath, `${JSON.stringify(missingVersion, null, 2)}\n`);
    assert.throws(
      () => installLocalPlugin(source, { baseDirectory: installBase }),
      /safe semantic version/,
    );
    assert.deepEqual(readdirSync(installBase), []);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(installBase, { recursive: true, force: true });
  }
});

test("content addressing distinguishes file boundaries from embedded delimiters", () => {
  const firstSource = temporaryDirectory("supervised-worker-collision-a-");
  const secondSource = temporaryDirectory("supervised-worker-collision-b-");
  const installBase = temporaryDirectory("supervised-worker-collision-base-");
  try {
    copyInstallSource(firstSource);
    copyInstallSource(secondSource);
    writeFileSync(path.join(firstSource, "src", "zz-a"), "A");
    writeFileSync(path.join(firstSource, "src", "zz-b"), "B");
    writeFileSync(path.join(secondSource, "src", "zz-a"), Buffer.from("A\0src/zz-b\0B"));

    const first = installLocalPlugin(firstSource, { baseDirectory: installBase });
    const second = installLocalPlugin(secondSource, { baseDirectory: installBase });
    assert.notEqual(first.sourceHash, second.sourceHash);
    assert.notEqual(first.installRoot, second.installRoot);
    assert.equal(second.reused, false);
  } finally {
    rmSync(firstSource, { recursive: true, force: true });
    rmSync(secondSource, { recursive: true, force: true });
    rmSync(installBase, { recursive: true, force: true });
  }
});

test("installer rejects links in the source package", () => {
  const source = temporaryDirectory("supervised-worker-linked-source-");
  const installBase = temporaryDirectory("supervised-worker-linked-source-base-");
  try {
    copyInstallSource(source, "skills");
    symlinkSync(
      path.join(root, "skills"),
      path.join(source, "skills"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () => installLocalPlugin(source, { baseDirectory: installBase }),
      /install source contains a link/,
    );
    assert.deepEqual(readdirSync(installBase), []);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(installBase, { recursive: true, force: true });
  }
});

test("installer rejects a linked intermediate source directory", () => {
  const source = temporaryDirectory("supervised-worker-linked-parent-");
  const external = temporaryDirectory("supervised-worker-linked-parent-external-");
  const installBase = temporaryDirectory("supervised-worker-linked-parent-base-");
  try {
    copyInstallSource(source, "com.github.copilot");
    cpSync(
      path.join(root, "com.github.copilot"),
      path.join(external, "com.github.copilot"),
      { recursive: true },
    );
    symlinkSync(
      path.join(external, "com.github.copilot"),
      path.join(source, "com.github.copilot"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () => installLocalPlugin(source, { baseDirectory: installBase }),
      /install source contains a link/,
    );
    assert.deepEqual(readdirSync(installBase), []);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
    rmSync(installBase, { recursive: true, force: true });
  }
});

test("installer rejects a linked install base", () => {
  const realBase = temporaryDirectory("supervised-worker-real-base-");
  const aliasBase = temporaryDirectory("supervised-worker-alias-base-");
  rmSync(aliasBase, { recursive: true, force: true });
  symlinkSync(realBase, aliasBase, process.platform === "win32" ? "junction" : "dir");
  try {
    assert.throws(
      () => installLocalPlugin(root, { baseDirectory: aliasBase }),
      /canonical directory without links/,
    );
    assert.deepEqual(readdirSync(realBase), []);
  } finally {
    rmSync(aliasBase, { recursive: true, force: true });
    rmSync(realBase, { recursive: true, force: true });
  }
});

test("installer rejects a linked install-base ancestor before creating children", () => {
  const realParent = temporaryDirectory("supervised-worker-real-parent-");
  const aliasParent = temporaryDirectory("supervised-worker-alias-parent-");
  rmSync(aliasParent, { recursive: true, force: true });
  symlinkSync(realParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
  const nestedBase = path.join(aliasParent, "missing", "plugins");
  try {
    assert.throws(
      () => installLocalPlugin(root, { baseDirectory: nestedBase }),
      /canonical directory without links/,
    );
    assert.equal(existsSync(path.join(realParent, "missing")), false);
  } finally {
    rmSync(aliasParent, { recursive: true, force: true });
    rmSync(realParent, { recursive: true, force: true });
  }
});

test("CLI install returns a reusable content-addressed plugin root", {
  skip: process.platform !== "win32",
}, () => {
  const localAppData = temporaryDirectory("supervised-worker-cli-install-");
  try {
    const cli = path.join(root, "src", "cli.mjs");
    const environment = { ...process.env, LOCALAPPDATA: localAppData };
    const first = spawnSync(process.execPath, [cli, "install"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(first.error, undefined, first.error?.message);
    assert.equal(first.status, 0, first.stderr);
    const installed = JSON.parse(first.stdout);
    assert.equal(installed.reused, false);
    assert.ok(installed.installRoot.startsWith(localAppData));
    assert.equal(existsSync(path.join(installed.installRoot, "install-record.json")), true);

    const second = spawnSync(process.execPath, [cli, "install"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(second.error, undefined, second.error?.message);
    assert.equal(second.status, 0, second.stderr);
    const reused = JSON.parse(second.stdout);
    assert.equal(reused.reused, true);
    assert.equal(reused.installRoot, installed.installRoot);
    assert.equal(reused.sourceHash, installed.sourceHash);
  } finally {
    rmSync(localAppData, { recursive: true, force: true });
  }
});

test("installer rejects source bytes swapped after hashing", () => {
  const source = temporaryDirectory("supervised-worker-source-swap-");
  const installBase = temporaryDirectory("supervised-worker-source-swap-base-");
  const require = createRequire(import.meta.url);
  const fs = require("node:fs");
  const originalCpSync = fs.cpSync;
  try {
    copyInstallSource(source);
    const readmePath = path.join(source, "README.md");
    const originalReadme = readFileSync(readmePath, "utf8");
    let swapped = false;
    fs.cpSync = (sourcePath, targetPath, options) => {
      if (!swapped) {
        swapped = true;
        writeFileSync(readmePath, `${originalReadme}\nINJECTED AFTER HASH\n`);
      }
      return originalCpSync(sourcePath, targetPath, options);
    };
    syncBuiltinESMExports();
    assert.throws(
      () => installLocalPlugin(source, { baseDirectory: installBase }),
      /staged installation bytes differ/,
    );
    assert.equal(swapped, true);
    assert.deepEqual(readdirSync(installBase), []);
  } finally {
    fs.cpSync = originalCpSync;
    syncBuiltinESMExports();
    rmSync(source, { recursive: true, force: true });
    rmSync(installBase, { recursive: true, force: true });
  }
});

test("installer rejects staged file-list additions before reading or generating output", () => {
  const source = temporaryDirectory("supervised-worker-file-list-swap-");
  const installBase = temporaryDirectory("supervised-worker-file-list-base-");
  const require = createRequire(import.meta.url);
  const fs = require("node:fs");
  const originalCpSync = fs.cpSync;
  const originalReadFileSync = fs.readFileSync;
  const originalWriteFileSync = fs.writeFileSync;
  try {
    copyInstallSource(source);
    let injectedPath = null;
    let injectedRead = false;
    const generatedWrites = [];
    fs.cpSync = (sourcePath, targetPath, options) => {
      const result = originalCpSync(sourcePath, targetPath, options);
      if (path.basename(String(sourcePath)) === "src" && injectedPath === null) {
        injectedPath = path.join(String(targetPath), "unexpected-after-copy.mjs");
        originalWriteFileSync(injectedPath, "throw new Error('must not be read');\n");
      }
      return result;
    };
    fs.readFileSync = (filePath, ...args) => {
      if (injectedPath !== null && path.resolve(String(filePath)) === path.resolve(injectedPath)) {
        injectedRead = true;
      }
      return originalReadFileSync(filePath, ...args);
    };
    fs.writeFileSync = (filePath, ...args) => {
      if (
        path.resolve(String(filePath)).startsWith(path.resolve(installBase)) &&
        ["hooks.json", "install-record.json"].includes(path.basename(String(filePath)))
      ) {
        generatedWrites.push(path.basename(String(filePath)));
      }
      return originalWriteFileSync(filePath, ...args);
    };
    syncBuiltinESMExports();

    assert.throws(
      () => installLocalPlugin(source, { baseDirectory: installBase }),
      /staged installation bytes differ/,
    );
    assert.notEqual(injectedPath, null);
    assert.equal(injectedRead, false);
    assert.deepEqual(generatedWrites, []);
    assert.deepEqual(readdirSync(installBase), []);
  } finally {
    fs.cpSync = originalCpSync;
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync = originalWriteFileSync;
    syncBuiltinESMExports();
    rmSync(source, { recursive: true, force: true });
    rmSync(installBase, { recursive: true, force: true });
  }
});

test("installer rejects reuse when identity fields in the record drift", () => {
  const installBase = temporaryDirectory("supervised-worker-record-drift-");
  try {
    const installed = installLocalPlugin(root, { baseDirectory: installBase });
    const recordPath = path.join(installed.installRoot, "install-record.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    for (const mutate of [
      (value) => { value.baseDirectory = `${value.baseDirectory}-other`; },
      (value) => { value.installFormatVersion += 1; },
    ]) {
      const changed = structuredClone(record);
      mutate(changed);
      writeFileSync(recordPath, `${JSON.stringify(changed, null, 2)}\n`);
      assert.throws(
        () => installLocalPlugin(root, { baseDirectory: installBase }),
        /does not match its record/,
      );
      writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      assert.equal(
        installLocalPlugin(root, { baseDirectory: installBase }).reused,
        true,
      );
    }
  } finally {
    rmSync(installBase, { recursive: true, force: true });
  }
});

test("installer rejects tampered bytes after the mutable record hash is resealed", () => {
  const installBase = temporaryDirectory("supervised-worker-resealed-record-");
  try {
    const installed = installLocalPlugin(root, { baseDirectory: installBase });
    const launcherPath = path.join(installed.installRoot, "src", "hook-launcher.mjs");
    writeFileSync(launcherPath, `${readFileSync(launcherPath, "utf8")}\n// tampered\n`);
    const recordPath = path.join(installed.installRoot, "install-record.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.installedHash = installedTreeHash(installed.installRoot);
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

    assert.throws(
      () => installLocalPlugin(root, { baseDirectory: installBase }),
      /does not match its record/,
    );
  } finally {
    rmSync(installBase, { recursive: true, force: true });
  }
});

test("installer rejects staged plugin metadata drift before generated writes", () => {
  const source = temporaryDirectory("supervised-worker-metadata-swap-");
  const installBase = temporaryDirectory("supervised-worker-metadata-swap-base-");
  const require = createRequire(import.meta.url);
  const fs = require("node:fs");
  const originalReadFileSync = fs.readFileSync;
  const originalWriteFileSync = fs.writeFileSync;
  const originalCpSync = fs.cpSync;
  try {
    copyInstallSource(source);
    const pluginPath = path.join(source, "plugin.json");
    let stagedPluginReads = 0;
    let copyCalls = 0;
    let copyComplete = false;
    const generatedWrites = [];
    fs.readFileSync = (filePath, ...args) => {
      const value = originalReadFileSync(filePath, ...args);
      const resolvedPath = path.resolve(String(filePath));
      if (
        resolvedPath !== path.resolve(pluginPath) &&
        resolvedPath.startsWith(path.resolve(installBase)) &&
        path.basename(resolvedPath) === "plugin.json"
      ) {
        stagedPluginReads += 1;
        if (stagedPluginReads === 2) {
          const plugin = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value);
          plugin.version = "9.9.9";
          const replacement = `${JSON.stringify(plugin, null, 2)}\n`;
          return Buffer.isBuffer(value) ? Buffer.from(replacement) : replacement;
        }
      }
      return value;
    };
    fs.cpSync = (sourcePath, targetPath, options) => {
      const result = originalCpSync(sourcePath, targetPath, options);
      copyCalls += 1;
      if (copyCalls === INSTALL_SOURCE_ENTRIES.length) copyComplete = true;
      return result;
    };
    fs.writeFileSync = (filePath, ...args) => {
      if (copyComplete && path.resolve(String(filePath)).startsWith(path.resolve(installBase))) {
        generatedWrites.push(path.basename(String(filePath)));
      }
      return originalWriteFileSync(filePath, ...args);
    };
    syncBuiltinESMExports();

    assert.throws(
      () => installLocalPlugin(source, { baseDirectory: installBase }),
      /staged plugin version differs/,
    );
    assert.equal(stagedPluginReads, 2);
    assert.deepEqual(generatedWrites, []);
    assert.deepEqual(readdirSync(installBase), []);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync = originalWriteFileSync;
    fs.cpSync = originalCpSync;
    syncBuiltinESMExports();
    rmSync(source, { recursive: true, force: true });
    rmSync(installBase, { recursive: true, force: true });
  }
});
