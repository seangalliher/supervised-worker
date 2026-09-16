import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serializeRecovery } from "../src/recovery-state.mjs";

export function authorizeFixtureProposal(fixture, proposed, { answer = `AUTHORIZE ${proposed.proposalHash}`, mutation = "none", expectedExit = 0, clockOffset = 0 } = {}) {
  const proposalPath = path.join(fixture.base, `proposal-${proposed.proposal.actionId}.json`);
  writeFileSync(proposalPath, serializeRecovery(proposed.proposal, "proposal"));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./recovery-operator-fixture.mjs", import.meta.url)),
    fixture.installRoot, fixture.cwd, proposalPath, proposed.proposalHash, answer, mutation, String(clockOffset)],
  { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, expectedExit, child.stderr || child.stdout);
  assert.match(child.stderr, /fixture-operator-console-confirmation-exercised/);
  return JSON.parse(child.stdout);
}
