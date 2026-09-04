import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { ALL_TOOL_MATCHER } from "./core.mjs";
import { EXPECTED_HOOK_EVENTS } from "./hook-manifest.mjs";
import { parseWorkflowJson } from "./workflow.mjs";

const INSTALL_ENTRIES = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "agents",
  "com.github.copilot/agents",
  "hooks.json",
  "plugin.json",
  "policy",
  "schemas",
  "skills",
  "src",
];
const INSTALL_FORMAT_VERSION = 5;
const INSTALL_RECORD_KEYS = new Set([
  "schemaVersion",
  "installFormatVersion",
  "version",
  "sourceHash",
  "installedHash",
  "installIdentityHash",
  "installedAt",
  "nodePath",
  "platform",
  "powerShellPath",
  "baseDirectory",
]);

function quotedBash(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quotedPowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsPowerShellPath(environment = process.env) {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  const normalizedRoot = typeof systemRoot === "string"
    ? systemRoot.replaceAll("/", "\\")
    : "";
  const rootSegments = normalizedRoot.split("\\").filter(Boolean).slice(1);
  if (
    !/^[A-Za-z]:\\(?:[A-Za-z0-9._-]+\\?)*$/.test(normalizedRoot) ||
    rootSegments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("SystemRoot is required for a Windows hook installation");
  }
  const rootStats = lstatSync(normalizedRoot);
  if (
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink() ||
    !pathEquals(normalizedRoot, realpathSync(normalizedRoot))
  ) {
    throw new Error("SystemRoot must be a canonical local directory");
  }
  const executable = path.win32.join(
    normalizedRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const executableStats = lstatSync(executable);
  if (
    !executableStats.isFile() ||
    executableStats.isSymbolicLink() ||
    !pathEquals(executable, realpathSync(executable))
  ) {
    throw new Error("Windows system PowerShell executable is not canonical");
  }
  return realpathSync(executable);
}

function installedCommand(eventName, installRoot, nodePath, platform, environment) {
  const targetPath = platform === "win32" ? path.win32 : path.posix;
  const launcherPath = targetPath.join(installRoot, "src", "hook-launcher.mjs");
  if (platform === "win32") {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$env:NODE_OPTIONS=$null",
      "$env:COPILOT_GITHUB_TOKEN=$null",
      "$env:GH_TOKEN=$null",
      "$env:GITHUB_TOKEN=$null",
      `try { & ${quotedPowerShell(nodePath)} ${quotedPowerShell(launcherPath)} ${quotedPowerShell(eventName)}; if ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE } catch { Write-Error $_; exit 1 }`,
    ].join("; ");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return `${windowsPowerShellPath(environment)} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  }
  return `unset NODE_OPTIONS COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN; ${quotedBash(nodePath)} ${quotedBash(launcherPath)} ${quotedBash(eventName)}`;
}

export function buildInstalledHookManifest({
  installRoot,
  nodePath = process.execPath,
  platform = process.platform,
  environment = process.env,
}) {
  const hooks = {};
  for (const eventName of EXPECTED_HOOK_EVENTS) {
    const command = installedCommand(eventName, installRoot, nodePath, platform, environment);
    hooks[eventName] = [{
      type: "command",
      ...(eventName === "PreToolUse" ? { matcher: ALL_TOOL_MATCHER } : {}),
      bash: platform === "win32"
        ? `printf '%s\\n' 'Supervised Worker Windows installation requires the PowerShell launcher.' >&2; exit 1`
        : command,
      powershell: platform === "win32"
        ? command
        : `Write-Error 'Supervised Worker installation requires the Bash launcher on this platform.'; exit 1`,
      timeoutSec: platform === "win32" ? 15 : 5,
    }];
  }
  return { version: 1, hooks };
}

function walkFiles(root, relativePath, files) {
  const absolutePath = path.join(root, relativePath);
  const stats = lstatSync(absolutePath);
  if (stats.isSymbolicLink()) throw new Error(`install source contains a link: ${relativePath}`);
  if (stats.isFile()) {
    files.push(relativePath.replaceAll(path.sep, "/"));
    return;
  }
  if (!stats.isDirectory()) throw new Error(`install source is not a file or directory: ${relativePath}`);
  for (const entry of readdirSync(absolutePath).sort()) {
    walkFiles(root, path.join(relativePath, entry), files);
  }
}

function validateSourcePathComponents(root, relativePath) {
  let currentPath = root;
  for (const segment of relativePath.split(/[\\/]+/).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const stats = lstatSync(currentPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`install source contains a link: ${relativePath}`);
    }
    const resolved = realpathSync(currentPath);
    if (!isStrictDescendant(root, resolved) && !pathEquals(root, resolved)) {
      throw new Error(`install source resolves outside its root: ${relativePath}`);
    }
  }
}

function sourceFiles(sourceRoot) {
  const files = [];
  for (const relativePath of INSTALL_ENTRIES) {
    validateSourcePathComponents(sourceRoot, relativePath);
    walkFiles(sourceRoot, relativePath, files);
  }
  return files.sort();
}

function sourceHash(sourceRoot, files) {
  return hashFileEntries(
    files,
    (relativePath) => readFileSync(path.join(sourceRoot, ...relativePath.split("/"))),
  );
}

function hashFileEntries(files, readBytes) {
  const hash = createHash("sha256");
  hash.update("supervised-worker-file-tree-v1\0");
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(files.length));
  hash.update(count);
  for (const relativePath of files) {
    const pathBytes = Buffer.from(relativePath, "utf8");
    const contentBytes = readBytes(relativePath);
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

function sourceByteMap(sourceRoot, files) {
  return new Map(
    files.map((relativePath) => [
      relativePath,
      readFileSync(path.join(sourceRoot, ...relativePath.split("/"))),
    ]),
  );
}

function expectedInstalledTree(files, sourceBytes, hooksText) {
  const hookBytes = Buffer.from(hooksText);
  const installedPaths = [...new Set([
    ...files,
    "com.github.copilot/hooks/hooks.json",
  ])].sort();
  const installedBytes = new Map(sourceBytes);
  installedBytes.set("hooks.json", hookBytes);
  installedBytes.set("com.github.copilot/hooks/hooks.json", hookBytes);
  return {
    files: installedPaths,
    hash: hashFileEntries(installedPaths, (relativePath) => installedBytes.get(relativePath)),
  };
}

function installIdentityHash(fields) {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function installIdentity({ sourceHash: contentHash, nodePath, platform, environment, baseDirectory }) {
  const targetPath = platform === "win32" ? path.win32 : path.posix;
  const normalizedNodePath = targetPath.normalize(nodePath);
  const normalizedBaseDirectory = platform === "win32"
    ? path.win32.normalize(baseDirectory).toLowerCase()
    : path.posix.normalize(baseDirectory);
  const powerShellPath = platform === "win32" ? windowsPowerShellPath(environment) : null;
  const fields = {
    installFormatVersion: INSTALL_FORMAT_VERSION,
    sourceHash: contentHash,
    platform,
    nodePath: normalizedNodePath,
    powerShellPath,
    baseDirectory: normalizedBaseDirectory,
  };
  return {
    hash: installIdentityHash(fields),
    nodePath: normalizedNodePath,
    platform,
    powerShellPath,
    baseDirectory: normalizedBaseDirectory,
  };
}

function isStrictDescendant(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function pathEquals(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function ensureCanonicalDirectory(directoryPath) {
  const absolutePath = path.resolve(directoryPath);
  const parsed = path.parse(absolutePath);
  let currentPath = parsed.root;
  const segments = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const validate = (candidatePath) => {
    const stats = lstatSync(candidatePath);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      !pathEquals(candidatePath, realpathSync(candidatePath))
    ) {
      throw new Error("install base must be a canonical directory without links");
    }
  };
  validate(currentPath);
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    if (!existsSync(currentPath)) mkdirSync(currentPath, { mode: 0o700 });
    validate(currentPath);
  }
  return absolutePath;
}

function installedFiles(installRoot) {
  const files = [];
  for (const entry of readdirSync(installRoot).sort()) {
    if (entry === "install-record.json") continue;
    walkFiles(installRoot, entry, files);
  }
  return files.sort();
}

function validateExistingInstall(installRoot, baseDirectory) {
  if (!isStrictDescendant(baseDirectory, installRoot)) {
    throw new Error("existing installation is outside the configured base directory");
  }
  const rootStats = lstatSync(installRoot);
  if (
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink() ||
    !pathEquals(installRoot, realpathSync(installRoot))
  ) {
    throw new Error("existing installation root is not a canonical directory");
  }
  const recordPath = path.join(installRoot, "install-record.json");
  const recordStats = lstatSync(recordPath);
  if (
    !recordStats.isFile() ||
    recordStats.isSymbolicLink() ||
    recordStats.nlink > 1
  ) {
    throw new Error("existing installation record is not a safe regular file");
  }
  return recordPath;
}

function pluginVersion(pluginRoot) {
  const pluginPath = path.join(pluginRoot, "plugin.json");
  const stats = lstatSync(pluginPath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink > 1 ||
    stats.size > 65_536
  ) {
    throw new Error("plugin manifest is not a safe bounded regular file");
  }
  const plugin = parseWorkflowJson(readFileSync(pluginPath));
  if (
    typeof plugin?.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(plugin.version) ||
    plugin.version.includes("..")
  ) {
    throw new Error("plugin version must be a safe semantic version");
  }
  return plugin.version;
}

export function resolvePluginSourceIdentity(pluginRoot) {
  const resolvedRoot = path.resolve(pluginRoot);
  const rootStats = lstatSync(resolvedRoot);
  if (
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink() ||
    !pathEquals(resolvedRoot, realpathSync(resolvedRoot))
  ) {
    throw new Error("plugin root must be a canonical directory without links");
  }
  const version = pluginVersion(resolvedRoot);
  const recordPath = path.join(resolvedRoot, "install-record.json");
  if (!existsSync(recordPath)) {
    const files = sourceFiles(resolvedRoot);
    return {
      version,
      sourceHash: sourceHash(resolvedRoot, files),
      sourceKind: "checkout-tree",
      provenance: "plugin-verified-local",
    };
  }

  const recordStats = lstatSync(recordPath);
  if (
    !recordStats.isFile() ||
    recordStats.isSymbolicLink() ||
    recordStats.nlink > 1 ||
    recordStats.size > 65_536
  ) {
    throw new Error("installation record is not a safe bounded regular file");
  }
  const record = parseWorkflowJson(readFileSync(recordPath));
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).some((key) => !INSTALL_RECORD_KEYS.has(key)) ||
    [...INSTALL_RECORD_KEYS].some((key) => !Object.hasOwn(record, key)) ||
    record.schemaVersion !== 1 ||
    record.installFormatVersion !== INSTALL_FORMAT_VERSION ||
    record.version !== version ||
    !/^[0-9a-f]{64}$/.test(record.sourceHash ?? "") ||
    !/^[0-9a-f]{64}$/.test(record.installedHash ?? "") ||
    !/^[0-9a-f]{64}$/.test(record.installIdentityHash ?? "") ||
    typeof record.installedAt !== "string" ||
    Number.isNaN(new Date(record.installedAt).valueOf()) ||
    new Date(record.installedAt).toISOString() !== record.installedAt ||
    record.platform !== process.platform
  ) {
    throw new Error("installation record is invalid");
  }
  const targetPath = record.platform === "win32" ? path.win32 : path.posix;
  const normalizedNodePath = targetPath.normalize(record.nodePath ?? "");
  const normalizedBaseDirectory = record.platform === "win32"
    ? path.win32.normalize(record.baseDirectory ?? "").toLowerCase()
    : path.posix.normalize(record.baseDirectory ?? "");
  if (
    !targetPath.isAbsolute(normalizedNodePath) ||
    record.nodePath !== normalizedNodePath ||
    !targetPath.isAbsolute(normalizedBaseDirectory) ||
    record.baseDirectory !== normalizedBaseDirectory ||
    (record.platform === "win32") !== (typeof record.powerShellPath === "string") ||
    (record.platform !== "win32" && record.powerShellPath !== null)
  ) {
    throw new Error("installation identity fields are invalid");
  }
  const baseDirectory = path.resolve(record.baseDirectory);
  const baseStats = lstatSync(baseDirectory);
  if (
    !baseStats.isDirectory() ||
    baseStats.isSymbolicLink() ||
    !pathEquals(baseDirectory, realpathSync(baseDirectory))
  ) {
    throw new Error("installation base is not canonical");
  }
  validateExistingInstall(resolvedRoot, baseDirectory);
  const identityHash = installIdentityHash({
    installFormatVersion: INSTALL_FORMAT_VERSION,
    sourceHash: record.sourceHash,
    platform: record.platform,
    nodePath: record.nodePath,
    powerShellPath: record.powerShellPath,
    baseDirectory: record.baseDirectory,
  });
  const expectedRoot = path.resolve(
    baseDirectory,
    `${version}-${identityHash.slice(0, 16)}`,
  );
  if (
    record.installIdentityHash !== identityHash ||
    !pathEquals(expectedRoot, resolvedRoot)
  ) {
    throw new Error("installation identity does not match its canonical root");
  }
  const files = installedFiles(resolvedRoot);
  for (const relativePath of files) {
    const stats = lstatSync(path.join(resolvedRoot, ...relativePath.split("/")));
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink > 1) {
      throw new Error("installed tree contains an unsafe file");
    }
  }
  if (sourceHash(resolvedRoot, files) !== record.installedHash) {
    throw new Error("installed tree does not match its immutable record");
  }
  return {
    version,
    sourceHash: record.sourceHash,
    sourceKind: "immutable-install-record",
    provenance: "plugin-verified-local",
  };
}

export function defaultInstallBase({
  platform = process.platform,
  environment = process.env,
  homeDirectory = os.homedir(),
} = {}) {
  if (platform === "win32") {
    if (!environment.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required for installation");
    return path.win32.join(environment.LOCALAPPDATA, "SupervisedWorker", "plugins");
  }
  if (platform === "darwin") {
    return path.posix.join(
      homeDirectory,
      "Library",
      "Application Support",
      "SupervisedWorker",
      "plugins",
    );
  }
  return path.posix.join(
    environment.XDG_DATA_HOME || path.posix.join(homeDirectory, ".local", "share"),
    "supervised-worker",
    "plugins",
  );
}

export function installLocalPlugin(sourceRoot, options = {}) {
  const source = path.resolve(sourceRoot);
  const sourceStats = lstatSync(source);
  if (
    !sourceStats.isDirectory() ||
    sourceStats.isSymbolicLink() ||
    !pathEquals(source, realpathSync(source))
  ) {
    throw new Error("install source root must be a canonical directory without links");
  }
  const files = sourceFiles(source);
  const sourceBytes = sourceByteMap(source, files);
  const hash = hashFileEntries(files, (relativePath) => sourceBytes.get(relativePath));
  const plugin = JSON.parse(sourceBytes.get("plugin.json").toString("utf8"));
  if (
    typeof plugin.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(plugin.version) ||
    plugin.version.includes("..")
  ) {
    throw new Error("plugin version must be a safe semantic version");
  }
  const baseDirectory = ensureCanonicalDirectory(
    options.baseDirectory ?? defaultInstallBase(options),
  );
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const identity = installIdentity({
    sourceHash: hash,
    nodePath: options.nodePath ?? process.execPath,
    platform,
    environment,
    baseDirectory,
  });
  const installRoot = path.resolve(
    baseDirectory,
    `${plugin.version}-${identity.hash.slice(0, 16)}`,
  );
  if (!isStrictDescendant(baseDirectory, installRoot)) {
    throw new Error("install root must remain inside the configured base directory");
  }
  const hooks = buildInstalledHookManifest({
    installRoot,
    nodePath: identity.nodePath,
    platform,
    environment,
  });
  const hooksText = `${JSON.stringify(hooks, null, 2)}\n`;
  const expectedInstalled = expectedInstalledTree(files, sourceBytes, hooksText);
  const recordPath = path.join(installRoot, "install-record.json");
  if (existsSync(recordPath)) {
    validateExistingInstall(installRoot, baseDirectory);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    const actualFiles = installedFiles(installRoot);
    const installedHash = sourceHash(installRoot, actualFiles);
    if (
      record.sourceHash !== hash ||
      JSON.stringify(actualFiles) !== JSON.stringify(expectedInstalled.files) ||
      installedHash !== expectedInstalled.hash ||
      record.installedHash !== expectedInstalled.hash ||
      record.installFormatVersion !== INSTALL_FORMAT_VERSION ||
      record.installIdentityHash !== identity.hash ||
      record.nodePath !== identity.nodePath ||
      record.platform !== identity.platform ||
      record.powerShellPath !== identity.powerShellPath ||
      record.baseDirectory !== identity.baseDirectory ||
      record.version !== plugin.version
    ) {
      throw new Error("existing content-addressed installation does not match its record");
    }
    return { installRoot, sourceHash: hash, reused: true };
  }
  if (existsSync(installRoot)) {
    throw new Error("content-addressed installation exists without a valid record");
  }

  const temporaryRoot = path.join(baseDirectory, `.install-${randomUUID()}`);
  mkdirSync(temporaryRoot, { mode: 0o700 });
  try {
    for (const relativePath of INSTALL_ENTRIES) {
      validateSourcePathComponents(source, relativePath);
      const sourcePath = path.join(source, ...relativePath.split("/"));
      const targetPath = path.join(temporaryRoot, ...relativePath.split("/"));
      cpSync(sourcePath, targetPath, { recursive: true, errorOnExist: true });
    }
    const stagedFiles = sourceFiles(temporaryRoot);
    if (
      JSON.stringify(stagedFiles) !== JSON.stringify(files) ||
      sourceHash(temporaryRoot, stagedFiles) !== hash
    ) {
      throw new Error("staged installation bytes differ from the content-addressed source");
    }
    const stagedPlugin = JSON.parse(
      readFileSync(path.join(temporaryRoot, "plugin.json"), "utf8"),
    );
    if (stagedPlugin.version !== plugin.version) {
      throw new Error("staged plugin version differs from the content-addressed source");
    }
    writeFileSync(path.join(temporaryRoot, "hooks.json"), hooksText, { mode: 0o600 });
    const namespacedHooks = path.join(temporaryRoot, "com.github.copilot", "hooks");
    mkdirSync(namespacedHooks, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(namespacedHooks, "hooks.json"), hooksText, { mode: 0o600 });
    const installedHash = sourceHash(temporaryRoot, installedFiles(temporaryRoot));
    if (installedHash !== expectedInstalled.hash) {
      throw new Error("staged installation differs from the expected installed tree");
    }
    writeFileSync(
      path.join(temporaryRoot, "install-record.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        installFormatVersion: INSTALL_FORMAT_VERSION,
        version: plugin.version,
        sourceHash: hash,
        installedHash: expectedInstalled.hash,
        installIdentityHash: identity.hash,
        installedAt: new Date().toISOString(),
        nodePath: identity.nodePath,
        platform: identity.platform,
        powerShellPath: identity.powerShellPath,
        baseDirectory: identity.baseDirectory,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temporaryRoot, installRoot);
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  return { installRoot, sourceHash: hash, reused: false };
}
