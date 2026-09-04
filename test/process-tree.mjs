import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const RUNNER_ARGUMENT = "--run-process-tree";
const runnerPath = fileURLToPath(import.meta.url);

function windowsPathEquals(left, right) {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

export function canonicalWindowsTaskkill(environment = process.env) {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  const rawRoot = typeof systemRoot === "string" ? systemRoot.replaceAll("/", "\\") : "";
  const rawSegments = rawRoot.split("\\").filter(Boolean).slice(1);
  const normalizedRoot = path.win32.normalize(rawRoot);
  if (
    !/^[A-Za-z]:\\/.test(normalizedRoot) ||
    rawSegments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("SystemRoot is required for the Windows process-tree watchdog");
  }
  const rootStats = lstatSync(normalizedRoot);
  const canonicalRoot = realpathSync(normalizedRoot);
  if (
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink() ||
    !windowsPathEquals(normalizedRoot, canonicalRoot)
  ) {
    throw new Error("SystemRoot must be a canonical local directory");
  }
  const executable = path.win32.join(canonicalRoot, "System32", "taskkill.exe");
  const executableStats = lstatSync(executable);
  const canonicalExecutable = realpathSync(executable);
  if (
    !executableStats.isFile() ||
    executableStats.isSymbolicLink() ||
    !windowsPathEquals(executable, canonicalExecutable)
  ) {
    throw new Error("Windows taskkill executable must be canonical");
  }
  return canonicalExecutable;
}

function errorDetails(error) {
  return {
    message: error.message,
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
  };
}

function waitForClose(child) {
  return new Promise((resolve) => {
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
}

function waitForCleanup(closed, timeoutMs) {
  return new Promise((resolve) => {
    const watchdog = setTimeout(() => resolve(null), timeoutMs);
    closed.then((result) => {
      clearTimeout(watchdog);
      resolve(result);
    });
  });
}

function killWindowsTree(processId, taskkillPath) {
  return new Promise((resolve) => {
    const killer = spawn(
      taskkillPath,
      ["/pid", String(processId), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve();
    };
    const watchdog = setTimeout(() => {
      killer.kill("SIGKILL");
      killer.unref();
      finish();
    }, 2_000);
    killer.once("error", finish);
    killer.once("close", finish);
  });
}

async function killProcessTree(child, taskkillPath) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    await killWindowsTree(child.pid, taskkillPath);
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function runProcessTree(config) {
  const started = performance.now();
  const child = spawn(config.command, config.args, {
    cwd: config.cwd,
    env: config.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let spawnError;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", () => {});
  child.once("error", (error) => { spawnError = errorDetails(error); });
  const closed = waitForClose(child);
  child.stdin.end(config.input ?? "");

  let watchdog;
  const timedOut = new Promise((resolve) => {
    watchdog = setTimeout(() => resolve(true), config.timeoutMs);
  });
  const first = await Promise.race([
    closed.then((result) => ({ result })),
    timedOut.then(() => ({ timedOut: true })),
  ]);
  if (first.result) {
    clearTimeout(watchdog);
    return {
      ...first.result,
      stdout,
      stderr,
      elapsedMs: performance.now() - started,
      ...(spawnError ? { error: spawnError } : {}),
    };
  }

  await killProcessTree(child, config.taskkillPath);
  const cleanup = await waitForCleanup(closed, config.cleanupTimeoutMs);
  if (cleanup === null) {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
  return {
    status: cleanup?.status ?? child.exitCode,
    signal: cleanup?.signal ?? child.signalCode,
    stdout,
    stderr,
    elapsedMs: performance.now() - started,
    error: {
      message: `spawn ${config.command} ETIMEDOUT`,
      code: "ETIMEDOUT",
    },
  };
}

export function spawnProcessTreeSync(command, args, options = {}) {
  const timeoutMs = options.timeout ?? 10_000;
  const cleanupTimeoutMs = options.cleanupTimeout ?? 2_000;
  const taskkillPath = process.platform === "win32" ? canonicalWindowsTaskkill() : undefined;
  const runnerEnvironment = { ...process.env };
  delete runnerEnvironment.NODE_OPTIONS;
  const execution = spawnSync(process.execPath, [runnerPath, RUNNER_ARGUMENT], {
    encoding: "utf8",
    env: runnerEnvironment,
    input: JSON.stringify({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      timeoutMs,
      cleanupTimeoutMs,
      taskkillPath,
    }),
    timeout: timeoutMs + cleanupTimeoutMs + 3_000,
    windowsHide: true,
  });
  if (execution.error) throw execution.error;
  if (execution.status !== 0) {
    throw new Error(`process-tree runner failed: ${execution.stderr.trim()}`);
  }
  return JSON.parse(execution.stdout);
}

if (process.argv[2] === RUNNER_ARGUMENT) {
  try {
    const result = await runProcessTree(JSON.parse(readFileSync(0, "utf8")));
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}