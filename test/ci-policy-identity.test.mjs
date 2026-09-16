import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sha256 } from "../src/core.mjs";
import { installLocalPlugin } from "../src/install.mjs";

test("handoff capture rejects CI-validator drift and binds a fresh implementation identity", () => {
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), "supervised-worker-ci-identity-")));
  try {
    const workspace = path.join(temporary, "workspace");
    mkdirSync(workspace);
    const source = fileURLToPath(new URL("../", import.meta.url));
    const installed = installLocalPlugin(source, { baseDirectory: path.join(temporary, "installation") }).installRoot;
    const contract = JSON.parse(readFileSync(new URL("../examples/handoff.build-contract.json", import.meta.url)));
    const directory = path.join(workspace, ".supervised-worker", "handoffs", sha256(contract.itemId));
    mkdirSync(directory, { recursive: true });
    const artifact = path.join(directory, "build-contract.json");
    writeFileSync(artifact, JSON.stringify(contract));
    const setup = `
      import assert from 'node:assert/strict';
      import { appendFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const { captureHandoffValidation } = await import(pathToFileURL(${JSON.stringify(path.join(installed, "src", "handoff.mjs"))}).href);
      const snapshot = captureHandoffValidation(${JSON.stringify(workspace)}, ${JSON.stringify(artifact)});
      snapshot.requireUnchanged();
    `;
    const run = script => execFileSync(process.execPath, ["--input-type=module", "-e", script],
      { cwd: workspace, encoding: "utf8" }).trim();
    const before = run(`${setup}
      appendFileSync(${JSON.stringify(path.join(installed, "src", "ci-policy.mjs"))}, '\\n// isolated implementation drift\\n');
      assert.throws(() => snapshot.requireUnchanged(), /helper implementation/);
      console.log(snapshot.implementationHash);
    `);
    const after = run(`${setup} console.log(snapshot.implementationHash);`);
    assert.match(before, /^[0-9a-f]{64}$/);
    assert.match(after, /^[0-9a-f]{64}$/);
    assert.notEqual(after, before, "only the isolated CI-validator bytes changed");
  } finally {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
