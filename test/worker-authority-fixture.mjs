import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import { verifyWorkerAuthority } from "../src/authority.mjs";
import { applyCampaignPlan, canonicalPlanHash, observeCampaignTransition, planPath, resumeSession, sha256 } from "../src/core.mjs";
import { installLocalPlugin } from "../src/install.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoots = new Set();

afterEach(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  fixtureRoots.clear();
});

export function createWorkerAuthorityFixture(cwd, initialInput, options = {}) {
  const root = realpathSync(cwd);
  if (options.baseDirectory !== undefined) mkdirSync(options.baseDirectory, { recursive: true });
  const base = realpathSync(options.baseDirectory ?? mkdtempSync(path.join(os.tmpdir(), "supervised-worker-host-fixture-")));
  fixtureRoots.add(base);
  const installRoot = options.installRoot ?? installLocalPlugin(sourceRoot, { baseDirectory: path.join(base, "installation") }).installRoot;
  const inventoryPath = path.join(base, "host-authority.json");
  const workerPath = path.join(installRoot, "com.github.copilot", "agents", "seangalliher-supervised-worker.agent.md");
  const hookPath = path.join(installRoot, "com.github.copilot", "hooks", "hooks.json");
  let input;
  const fixture = {
    installRoot, inventoryPath,
    select(session) {
      input = { session_id: session.session_id, ...(session.transcript_path === undefined ? {} : { transcript_path: session.transcript_path }) };
      const now = Date.now();
      writeFileSync(inventoryPath, JSON.stringify({
        schemaVersion: 1, kind: "worker-host-authority", host: "vscode", complete: true,
        sessionHash: sha256(input.session_id), repositoryHash: sha256(process.platform === "win32" ? root.toLowerCase() : root),
        processId: process.pid, issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
        workers: [{ path: workerPath, hash: sha256(readFileSync(workerPath)) }],
        hooks: [{ path: hookPath, hash: sha256(readFileSync(hookPath)) }],
      }));
      return fixture;
    },
    authority() {
      return verifyWorkerAuthority(root, input, installRoot, inventoryPath);
    },
    admit(plan = null) {
      if (existsSync(planPath(root))) {
        const existing = JSON.parse(readFileSync(planPath(root)));
        return resumeSession(root, { ...input, planHash: canonicalPlanHash(existing), checkpointHash: null }, fixture.authority());
      }
      const initialPlan = plan ?? { schemaVersion: 1, mode: "active", goal: "Complete the selected queue.",
        items: [{ id: "one", title: "One", status: "in_progress" }], completion: null };
      return applyCampaignPlan(root, { ...input, expected: observeCampaignTransition(root, input), plan: initialPlan }, fixture.authority());
    },
  };
  return fixture.select(initialInput);
}