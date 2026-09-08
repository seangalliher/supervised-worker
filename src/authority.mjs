import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { resolvePluginSourceIdentity } from "./install.mjs";
import { parseWorkflowJson, resolveWorkflowRoles } from "./workflow.mjs";

const verifiedAuthorities = new WeakMap();
const MAX_AUTHORITY_BYTES = 16_384;
const MAX_AUTHORITY_LIFETIME_MS = 86_400_000;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pathKey = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const pathNameEquals = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function readAuthorityFile(filePath, maximum = MAX_AUTHORITY_BYTES) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) ||
    pathKey(filePath) !== pathKey(realpathSync(filePath))) throw new Error("authority path must be canonical");
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > maximum) {
    throw new Error("authority must be a bounded regular file");
  }
  const bytes = readFileSync(filePath);
  if (bytes.length !== stats.size || bytes.length > maximum) throw new Error("authority changed while reading");
  return bytes;
}

function authorityBinding(cwd, input, pluginRoot, inventoryPath) {
  const repositoryRoot = realpathSync(cwd);
  const source = resolvePluginSourceIdentity(pluginRoot);
  if (source.sourceKind !== "immutable-install-record") throw new Error("Worker ownership requires a verified immutable installation");
  const relative = path.relative(repositoryRoot, path.resolve(inventoryPath));
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("host authority inventory must be outside the target repository");
  }
  const inventoryBytes = readAuthorityFile(inventoryPath);
  const inventory = parseWorkflowJson(inventoryBytes);
  const keys = ["schemaVersion", "kind", "host", "complete", "sessionHash", "repositoryHash", "processId", "issuedAt", "expiresAt", "workers", "hooks"];
  const sessionId = input?.session_id ?? input?.sessionId;
  const now = Date.now();
  const issuedAt = Date.parse(inventory?.issuedAt);
  const expiresAt = Date.parse(inventory?.expiresAt);
  if (!exactKeys(inventory, keys) || inventory.schemaVersion !== 1 || inventory.kind !== "worker-host-authority" ||
    !["vscode", "copilot-cli"].includes(inventory.host) || inventory.complete !== true ||
    typeof sessionId !== "string" || inventory.sessionHash !== hash(sessionId) ||
    inventory.repositoryHash !== hash(pathKey(repositoryRoot)) ||
    !Number.isSafeInteger(inventory.processId) || inventory.processId < 1 || inventory.processId > 2_147_483_647 ||
    typeof inventory.issuedAt !== "string" || typeof inventory.expiresAt !== "string" ||
    !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now || expiresAt <= now ||
    expiresAt <= issuedAt || expiresAt - issuedAt > MAX_AUTHORITY_LIFETIME_MS ||
    !Array.isArray(inventory.workers) || inventory.workers.length !== 1 ||
    !Array.isArray(inventory.hooks) || inventory.hooks.length !== 1) {
    throw new Error("host must attest one current Worker and hook authority for this repository and session");
  }
  process.kill(inventory.processId, 0);
  const worker = inventory.workers[0];
  const hooks = inventory.hooks[0];
  const workerNames = ["seangalliher-supervised-worker.agent.md", "supervised-worker.agent.md"];
  const allowedWorkers = workerNames.map((name) => pathKey(path.join(pluginRoot, "com.github.copilot", "agents", name)));
  const allowedHooks = [path.join(pluginRoot, "com.github.copilot", "hooks", "hooks.json"), path.join(pluginRoot, "hooks.json")].map(pathKey);
  for (const [entry, allowed] of [[worker, allowedWorkers], [hooks, allowedHooks]]) {
    if (!exactKeys(entry, ["path", "hash"]) || typeof entry.path !== "string" || !allowed.includes(pathKey(entry.path)) ||
      !/^[0-9a-f]{64}$/.test(entry.hash ?? "") || hash(readAuthorityFile(entry.path, 1_048_576)) !== entry.hash) {
      throw new Error("selected Worker or hook provenance does not match the immutable installation");
    }
  }
  const authority = {
    schemaVersion: 1, kind: "verified-worker-authority", sessionHash: inventory.sessionHash,
    repositoryHash: inventory.repositoryHash, sourceHash: source.sourceHash,
    workerHash: worker.hash, hooksHash: hooks.hash, host: inventory.host,
  };
  return { authority, grantHash: hash(JSON.stringify(authority)), inventoryHash: hash(inventoryBytes) };
}

function localAuthorityBinding(cwd, input, pluginRoot, workflow = resolveWorkflowRoles(cwd, { requireAcceptance: true })) {
  if (!workflow.ok || !workflow.configured || !workflow.accepted ||
      workflow.authorityAssurance !== "local-scoped") {
    throw new Error("local-scoped authority requires an explicitly accepted workflow hash");
  }
  const repositoryRoot = realpathSync(cwd);
  const source = resolvePluginSourceIdentity(pluginRoot);
  if (source.sourceKind !== "immutable-install-record") throw new Error("local-scoped authority requires an immutable installation");
  const sessionId = input?.session_id ?? input?.sessionId;
  const transcriptPath = input?.transcript_path ?? input?.transcriptPath;
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) ||
      typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath) ||
      !pathNameEquals(path.basename(transcriptPath), `${sessionId}.jsonl`)) {
    throw new Error("local-scoped authority requires a matching VS Code session transcript locator");
  }
  const transcriptDirectory = path.dirname(transcriptPath);
  const copilotDirectory = path.dirname(transcriptDirectory);
  const storageRoot = path.dirname(copilotDirectory);
    if (!pathNameEquals(path.basename(transcriptDirectory), "transcripts") ||
      !pathNameEquals(path.basename(copilotDirectory), "GitHub.copilot-chat")) {
    throw new Error("local-scoped authority requires the VS Code transcript location");
  }
  const relative = path.relative(repositoryRoot, storageRoot);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("local-scoped session storage must be outside the campaign repository");
  }
  for (const directory of [transcriptDirectory, copilotDirectory, storageRoot]) {
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory() || pathKey(directory) !== pathKey(realpathSync(directory))) {
      throw new Error("local-scoped session directories must be canonical and unlinked");
    }
  }
  const transcript = lstatSync(transcriptPath);
  if (!transcript.isFile() || transcript.isSymbolicLink() || transcript.nlink !== 1) {
    throw new Error("local-scoped session transcript must be a single-link regular file");
  }
  const workspaceBytes = readAuthorityFile(path.join(storageRoot, "workspace.json"));
  const workerPath = path.join(pluginRoot, "com.github.copilot", "agents", "seangalliher-supervised-worker.agent.md");
  const hooksPath = path.join(pluginRoot, "com.github.copilot", "hooks", "hooks.json");
  const authority = {
    schemaVersion: 1, kind: "verified-worker-authority", assurance: "local-scoped",
    provenance: "accepted-plugin-session", host: "vscode",
    sessionHash: hash(sessionId), repositoryHash: hash(pathKey(repositoryRoot)),
    sourceHash: source.sourceHash, workflowHash: workflow.workflowHash,
    workerHash: hash(readAuthorityFile(workerPath, 1_048_576)),
    hooksHash: hash(readAuthorityFile(hooksPath, 1_048_576)),
    sessionLocatorHash: hash(JSON.stringify([pathKey(transcriptPath), hash(workspaceBytes)])),
  };
  return { authority, grantHash: hash(JSON.stringify(authority)) };
}

export function verifyWorkerAuthority(cwd, input, pluginRoot, inventoryPath = process.env.SUPERVISED_WORKER_HOST_AUTHORITY) {
  const workflow = resolveWorkflowRoles(cwd);
  if (workflow.authorityAssurance === "local-scoped") {
    const binding = localAuthorityBinding(cwd, input, pluginRoot, workflow);
    const authority = Object.freeze({ ...binding.authority, grantHash: binding.grantHash });
    verifiedAuthorities.set(authority, () => {
      if (localAuthorityBinding(cwd, input, pluginRoot).grantHash !== binding.grantHash) {
        throw new Error("accepted local-scoped authority changed during the transition");
      }
    });
    return authority;
  }
  if (typeof inventoryPath !== "string" || !path.isAbsolute(inventoryPath)) {
    throw new Error("trusted host authority inventory is unavailable; Worker ownership is disabled");
  }
  const binding = authorityBinding(cwd, input, pluginRoot, inventoryPath);
  const authority = Object.freeze({ ...binding.authority, grantHash: binding.grantHash });
  verifiedAuthorities.set(authority, () => {
    const current = authorityBinding(cwd, input, pluginRoot, inventoryPath);
    if (current.grantHash !== binding.grantHash || current.inventoryHash !== binding.inventoryHash) {
      throw new Error("host authority changed during the transition");
    }
  });
  return authority;
}

export function requireVerifiedWorkerAuthority(authority, cwd, input) {
  const verify = verifiedAuthorities.get(authority);
  if (verify === undefined || authority.sessionHash !== hash(input?.session_id ?? input?.sessionId ?? "") ||
    authority.repositoryHash !== hash(pathKey(realpathSync(cwd)))) {
    throw new Error("Worker transition requires a verified repository- and session-bound authority");
  }
  verify();
}