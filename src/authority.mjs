import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { resolvePluginSourceIdentity } from "./install.mjs";
import { parseWorkflowJson } from "./workflow.mjs";

const verifiedAuthorities = new WeakMap();
const MAX_AUTHORITY_BYTES = 16_384;
const MAX_AUTHORITY_LIFETIME_MS = 86_400_000;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pathKey = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

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

export function verifyWorkerAuthority(cwd, input, pluginRoot, inventoryPath = process.env.SUPERVISED_WORKER_HOST_AUTHORITY) {
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