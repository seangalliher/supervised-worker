import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { compileCampaignRelease, renderCampaignReleaseMarkdown, serializeCampaignRelease, validateCompiledRelease } from "../src/campaign-release.mjs";
import { sha256 } from "../src/core.mjs";
import { doctorHash } from "../src/doctor-state.mjs";
import { doctorGit } from "../src/doctor-repair.mjs";
import { observeReleaseDoctorInventory } from "../src/release-inputs.mjs";
import { withDoctorCandidateFixture } from "./doctor-candidate-fixture.mjs";

test("real Doctor promotion history reports unresolved legacy proof hashes without upgrading provenance", () => {
  withDoctorCandidateFixture((fixture) => {
    const promoted = fixture.run(fixture.makeIntent("promote", [doctorHash(fixture.reviewed)]), fixture.adapter);
    assert.equal(promoted.status, "succeeded", JSON.stringify(promoted));
    assert.equal(fixture.run(fixture.makeIntent("continue", ["f".repeat(64)]), fixture.adapter).status, "succeeded");
    assert.equal(fixture.observe().incident.state, "resolved");
    doctorGit(fixture.campaign, ["init", "--quiet", "--initial-branch=main"]);
    doctorGit(fixture.campaign, ["add", ".github/supervised-worker.json"]);
    doctorGit(fixture.campaign, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "fixture campaign"]);
    const commit = doctorGit(fixture.campaign, ["rev-parse", "HEAD"]).trim();
    const manifest = { schemaVersion: 1, kind: "campaign-release-input", candidate: { commit,
      tree: doctorGit(fixture.campaign, ["rev-parse", "HEAD^{tree}"]).trim(), baseCommit: commit, ref: "refs/heads/main" },
      artifacts: [{ role: "plan", reference: { locator: ".supervised-worker/plan.json", sha256: sha256(readFileSync(path.join(fixture.campaign, ".supervised-worker", "plan.json"))) } }],
      doctorInventoryHash: observeReleaseDoctorInventory(fixture.campaign, fixture.input, fixture.authority).doctorInventoryHash };
    const receipt = compileCampaignRelease(fixture.campaign, fixture.input, manifest, fixture.authority);
    assert.deepEqual(validateCompiledRelease(receipt), []);
    assert.equal(receipt.doctor.provenance, "worker-recorded");
    assert.equal(receipt.doctor.incidents[0].state, "resolved");
    assert.equal(receipt.doctor.incidents[0].coverage, "partial");
    assert.equal(receipt.dispositions.doctor, "unresolved");
    for (const name of ["ci", "health", "history-replay"]) {
      assert.ok(receipt.doctor.incidents[0].dependencies.some((entry) => entry.name === name && entry.status === "unavailable" && entry.reference === null), name);
    }
    assert.ok(receipt.doctor.references.some((entry) => entry.locator.endsWith("review-report.json")));
    assert.ok(receipt.doctor.references.some((entry) => entry.locator.includes("/model-receipts/")));
    assert.equal(renderCampaignReleaseMarkdown(receipt), renderCampaignReleaseMarkdown(JSON.parse(serializeCampaignRelease(receipt))));
    const model = receipt.doctor.references.find((entry) => entry.locator.includes("/model-receipts/"));
    rmSync(path.join(fixture.campaign, model.locator));
    assert.throws(() => compileCampaignRelease(fixture.campaign, fixture.input, manifest, fixture.authority));
  });
});