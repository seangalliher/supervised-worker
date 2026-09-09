import path from "node:path";

import { canonicalPlanHash, sha256, validateCampaignRelease, validateCheckpoint, validatePlan } from "./core.mjs";
import { validateLocalCampaignReceipt } from "./campaign.mjs";
import { doctorHash } from "./doctor-state.mjs";
import { validateDoctorMatrix } from "./doctor-promotion.mjs";
import { validateGitHubQueueObservation } from "./github-queue.mjs";
import { inspectHandoffFile, runTrustedGit, validateModelReceiptValue, verifyCommittedHandoffChain } from "./handoff.mjs";
import { openWorkerReleaseInputs, summarizeReleaseDoctor, useWorkerReleaseInputs } from "./release-inputs.mjs";

const factNames = ["plan", "checkpoint", "local-receipt", "queue-start", "queue-final", "handoff", "models", "commit", "ref", "remote", "ci", "closures", "recovery", "provider-verification"];
const localVerified = new Set(["plan", "checkpoint", "local-receipt", "handoff", "commit", "ref"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function requireRelease(value, definition) {
  if (validateCampaignRelease(value, definition).length > 0) throw new Error("RELEASE_RECORD_INVALID");
  return value;
}

function verifyCandidate(root, candidate) {
  const git = (args) => runTrustedGit(root, args).trim();
  git(["check-ref-format", candidate.ref]);
  if (git(["rev-parse", "HEAD"]) !== candidate.commit || git(["rev-parse", "HEAD^{tree}"]) !== candidate.tree ||
    git(["write-tree"]) !== candidate.tree || git(["rev-parse", "--verify", candidate.ref]) !== candidate.commit ||
    git(["diff", "--no-ext-diff", "--no-textconv", "--name-only"]) !== "") throw new Error("RELEASE_CANDIDATE_CHANGED");
  git(["merge-base", "--is-ancestor", candidate.baseCommit, candidate.commit]);
  const untracked = runTrustedGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  if (untracked.some((file) => !file.replaceAll("\\", "/").startsWith(".supervised-worker/"))) throw new Error("RELEASE_SOURCE_UNTRACKED");
}

function validateInputs(captured) {
  const byRole = new Map(captured.artifacts.map((entry) => [entry.role, entry]));
  for (const entry of captured.artifacts) {
    const { role, value, reference } = entry;
    let errors = [];
    if (role === "plan") errors = validatePlan(value);
    else if (role === "checkpoint") errors = validateCheckpoint(value);
    else if (role === "local-receipt") errors = validateLocalCampaignReceipt(value);
    else if (["queue-start", "queue-final"].includes(role)) errors = validateGitHubQueueObservation(value);
    else if (["build-contract", "build-report", "review-report"].includes(role)) {
      const inspected = inspectHandoffFile(captured.root, path.join(captured.root, reference.locator));
      if (!inspected.ok || inspected.kind !== role || inspected.sha256 !== reference.sha256) errors = ["handoff mismatch"];
    } else if (["model-builder", "model-reviewer"].includes(role)) errors = validateModelReceiptValue(value);
    else errors = validateCampaignRelease(value, role === "provider" ? "provider" : "timing");
    if (errors.length > 0) throw new Error(`RELEASE_${role.toUpperCase().replaceAll("-", "_")}_INVALID`);
    const metadataRole = ["local-receipt", "queue-start", "queue-final", "provider", "timing"].includes(role);
    if (metadataRole && reference.locator !== `.supervised-worker/release-inputs/${reference.sha256}.json`) throw new Error("RELEASE_METADATA_LOCATOR_INVALID");
  }
  return byRole;
}

function compileOpened(captured) {
  const { manifest, root, observation, workflow } = captured;
  verifyCandidate(root, manifest.candidate);
  const inputs = validateInputs(captured);
  const plan = inputs.get("plan").value;
  const planHash = canonicalPlanHash(plan);
  if (planHash !== observation.planHash) throw new Error("RELEASE_PLAN_CHANGED");
  const fact = (name, status = "unavailable", provenance = "unavailable", roles = []) => ({ name, status, provenance,
    references: roles.map((role) => inputs.get(role)?.reference).filter(Boolean) });
  const facts = new Map(factNames.map((name) => [name, fact(name)]));
  facts.set("plan", fact("plan", "verified", "plugin-verified-local", ["plan"]));
  facts.set("commit", fact("commit", "verified", "plugin-verified-local"));
  facts.set("ref", fact("ref", "verified", "plugin-verified-local"));
  if (inputs.has("checkpoint")) {
    const checkpoint = inputs.get("checkpoint");
    if (checkpoint.value.planHash !== planHash || checkpoint.reference.locator !== `.supervised-worker/checkpoints/${checkpoint.reference.sha256}.json`) throw new Error("RELEASE_CHECKPOINT_BINDING_INVALID");
    facts.set("checkpoint", fact("checkpoint", "verified", "plugin-verified-local", ["checkpoint"]));
  }
  if (inputs.has("local-receipt")) {
    if (inputs.get("local-receipt").value.plan.hash !== planHash) throw new Error("RELEASE_LOCAL_RECEIPT_PLAN_MISMATCH");
    facts.set("local-receipt", fact("local-receipt", "verified", "plugin-verified-local", ["local-receipt"]));
  }
  const queues = ["queue-start", "queue-final"].map((role) => inputs.get(role)).filter(Boolean);
  if (queues.length === 1) throw new Error("RELEASE_QUEUE_PAIR_REQUIRED");
  for (const queue of queues) {
    if (queue.value.status === "complete") facts.set(queue.role, fact(queue.role, "recorded", "unattested-provider-observation", [queue.role]));
    else facts.set(queue.role, fact(queue.role, "unavailable", "unavailable", [queue.role]));
  }
  if (queues.length === 2 && queues.every((entry) => entry.value.status === "complete")) {
    const [start, end] = queues.map((entry) => entry.value);
    if (doctorHash(start.scope) !== doctorHash(end.scope) || start.repository.id !== end.repository.id || start.actor.id !== end.actor.id ||
      Date.parse(start.finishedAt) > Date.parse(end.finishedAt)) throw new Error("RELEASE_QUEUE_BINDING_INVALID");
  }
  const handoffRoles = ["build-contract", "build-report", "review-report", "model-builder", "model-reviewer"];
  const hasHandoff = handoffRoles.some((role) => inputs.has(role));
  let itemHash = null;
  let itemDisposition = "inapplicable";
  let verifyChain = null;
  if (hasHandoff) {
    if (!handoffRoles.every((role) => inputs.has(role))) throw new Error("RELEASE_HANDOFF_INCOMPLETE");
    const contract = inputs.get("build-contract").value;
    const review = inputs.get("review-report").value;
    if (!plan.items.some((item) => item.id === contract.itemId)) throw new Error("RELEASE_ITEM_NOT_IN_PLAN");
    for (const role of ["builder", "reviewer"]) {
      const declared = inputs.get(`model-${role}`).reference;
      const actual = review.modelResolution?.[role]?.evidence;
      if (!actual || declared.locator !== actual.locator || declared.sha256 !== actual.sha256) throw new Error("RELEASE_MODEL_BINDING_INVALID");
    }
    const attemptLocator = `.supervised-worker/runtime/review-attempts/${sha256(contract.itemId)}.json`;
    const attemptReference = captured.dependencyAt(attemptLocator).reference;
    verifyChain = () => {
      const verified = verifyCommittedHandoffChain(root, ...["build-contract", "build-report", "review-report"].map((role) => path.join(root, inputs.get(role).reference.locator)), manifest.candidate);
      if (!verified.ok || verified.stagedTreeHash !== manifest.candidate.tree) throw new Error("RELEASE_HANDOFF_VERIFICATION_FAILED");
    };
    verifyChain();
    const handoff = fact("handoff", "verified", "plugin-verified-local", ["build-contract", "build-report", "review-report"]);
    handoff.references.push(attemptReference);
    facts.set("handoff", handoff);
    facts.set("models", fact("models", "recorded", "worker-recorded", ["model-builder", "model-reviewer"]));
    itemHash = sha256(`supervised-worker-item-v1\0${contract.itemId}`);
    itemDisposition = plan.items.find((item) => item.id === contract.itemId).status === "banked" ? "recorded-complete" : "incomplete";
  }
  if (inputs.has("provider")) {
    const provider = inputs.get("provider").value;
    if (provider.commit !== manifest.candidate.commit || provider.ref !== manifest.candidate.ref ||
      (provider.remoteCommit !== null && provider.remoteCommit !== manifest.candidate.commit)) throw new Error("RELEASE_PROVIDER_BINDING_INVALID");
    for (const queue of queues.filter((entry) => entry.value.status === "complete")) {
      if (provider.repositoryHash !== sha256(queue.value.repository.id) || provider.actorHash !== sha256(queue.value.actor.id)) throw new Error("RELEASE_PROVIDER_QUEUE_MISMATCH");
    }
    if (provider.ci !== null) {
      try {
        void validateDoctorMatrix(provider.ci, manifest.candidate.commit);
      } catch {
        throw new Error("RELEASE_CI_OBSERVATION_INVALID");
      }
    }
    if (new Set(provider.closures.map((entry) => entry.itemHash)).size !== provider.closures.length) throw new Error("RELEASE_CLOSURES_DUPLICATED");
    const planItems = new Set(plan.items.map((item) => sha256(`supervised-worker-item-v1\0${item.id}`)));
    if (provider.closures.some((entry) => !planItems.has(entry.itemHash))) throw new Error("RELEASE_CLOSURE_NOT_IN_PLAN");
    for (const name of ["ci", "closures"]) {
      const present = name === "ci" ? provider.ci !== null : provider.closures.length > 0;
      facts.set(name, fact(name, provider.complete && present ? "recorded" : "unavailable",
        provider.complete && present ? "unattested-provider-observation" : "unavailable", ["provider"]));
    }
    facts.set("remote", fact("remote", provider.complete && provider.remoteCommit !== null ? "recorded" : "unavailable",
      provider.complete && provider.remoteCommit !== null ? "unattested-provider-observation" : "unavailable", ["provider"]));
  }
  const doctor = summarizeReleaseDoctor(captured);
  const recoveryReferences = captured.doctor.files.filter((entry) => !entry.reference.locator.startsWith(".supervised-worker/doctor/")).map((entry) => entry.reference);
  facts.set("recovery", { name: "recovery", status: recoveryReferences.length > 0 ? "recorded" : "inapplicable",
    provenance: recoveryReferences.length > 0 ? "worker-recorded" : "inapplicable", references: recoveryReferences });
  const timing = { status: "unavailable", provenance: "unavailable", basis: "measured-activity-durations-not-wall-time", durationsMs: null, references: [] };
  if (inputs.has("timing")) {
    const entry = inputs.get("timing");
    if (entry.value.planHash !== planHash || entry.value.commit !== manifest.candidate.commit) throw new Error("RELEASE_TIMING_BINDING_INVALID");
    timing.references.push(entry.reference);
    if (entry.value.complete && entry.value.durationsMs !== null && (doctor.status === "inapplicable" || entry.value.doctorIncluded)) {
      Object.assign(timing, { status: "recorded", provenance: "worker-recorded", durationsMs: entry.value.durationsMs });
    }
  }
  const receipt = requireRelease({ schemaVersion: 1, kind: "campaign-release-receipt", scope: "compiled-local-evidence", inputHash: doctorHash(manifest),
    candidate: manifest.candidate, planHash, itemHash, workflowHash: workflow.workflowHash,
    facts: factNames.map((name) => facts.get(name)), doctor,
    dispositions: { item: itemDisposition, hostSession: inputs.has("checkpoint") ? "checkpoint-recorded" : "unavailable",
      campaign: plan.mode === "complete" ? "recorded-complete" : "incomplete",
      doctor: doctor.status === "inapplicable" ? "inapplicable" : doctor.incidents.length > 0 && doctor.incidents.every((entry) => entry.state === "resolved" && entry.coverage === "complete") ? "recorded-resolved" : "unresolved", provider: "unavailable" },
    timing, authority: { grantsPermissions: false, satisfiesStop: false, providerSealed: false } }, "receipt");
  verifyCandidate(root, manifest.candidate);
  if (verifyChain !== null) verifyChain();
  if (validateCompiledRelease(receipt).length > 0) throw new Error("RELEASE_RECEIPT_INVALID");
  return receipt;
}

export function compileOpenedCampaignRelease(token) {
  try {
    return useWorkerReleaseInputs(token, compileOpened);
  } catch (error) {
    if (/^RELEASE_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error("RELEASE_CAPTURE_OR_VERIFICATION_FAILED");
  }
}

export function compileCampaignRelease(cwd, input, manifest, authority) {
  try {
    return compileOpenedCampaignRelease(openWorkerReleaseInputs(cwd, input, manifest, authority));
  } catch (error) {
    if (/^RELEASE_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error("RELEASE_CAPTURE_OR_VERIFICATION_FAILED");
  }
}

export function validateCompiledRelease(receipt) {
  const errors = validateCampaignRelease(receipt, "receipt");
  if (errors.length > 0) return errors;
  if (JSON.stringify(receipt.facts.map((fact) => fact.name)) !== JSON.stringify(factNames)) errors.push("receipt fact inventory is invalid");
  for (const fact of receipt.facts) {
    const providerFact = ["queue-start", "queue-final", "remote", "ci", "closures"].includes(fact.name);
    const recordedFact = ["models", "recovery"].includes(fact.name);
    const valid = (fact.status === "verified" && localVerified.has(fact.name) && fact.provenance === "plugin-verified-local") ||
      (fact.status === "recorded" && fact.references.length > 0 && fact.provenance === (providerFact ? "unattested-provider-observation" : recordedFact ? "worker-recorded" : null)) ||
      (fact.status === "unavailable" && fact.provenance === "unavailable") ||
      (fact.name === "recovery" && fact.status === "inapplicable" && fact.provenance === "inapplicable" && fact.references.length === 0);
    if (!valid) errors.push("receipt fact provenance is invalid");
    if (fact.name === "provider-verification" && (fact.status !== "unavailable" || fact.provenance !== "unavailable" || fact.references.length !== 0)) errors.push("provider verification is unavailable");
  }
  if (receipt.timing.status === "unavailable" && (receipt.timing.durationsMs !== null || receipt.timing.provenance !== "unavailable")) errors.push("unavailable timing must not contain inferred measurements");
  if (receipt.timing.status === "recorded" && (receipt.timing.durationsMs === null || receipt.timing.provenance !== "worker-recorded" || receipt.timing.references.length !== 1)) errors.push("recorded timing requires measured input");
  if (receipt.doctor.status === "inapplicable" && (receipt.doctor.provenance !== "inapplicable" || receipt.doctor.incidents.length !== 0 || receipt.doctor.references.length !== 0)) errors.push("inapplicable Doctor evidence must be empty");
  if (receipt.doctor.status === "recorded" && (receipt.doctor.provenance !== "worker-recorded" || receipt.doctor.incidents.length === 0 || receipt.doctor.references.length === 0)) errors.push("recorded Doctor evidence is incomplete");
  for (const incident of receipt.doctor.incidents) {
    if (incident.coverage !== (incident.dependencies.some((entry) => entry.status === "unavailable") ? "partial" : "complete")) errors.push("Doctor coverage is inconsistent");
    for (const entry of incident.dependencies) {
      if (entry.status === "unavailable" ? entry.reference !== null : entry.reference?.sha256 !== entry.sha256 ||
        !receipt.doctor.references.some((reference) => reference.locator === entry.reference.locator && reference.sha256 === entry.sha256)) errors.push("Doctor dependency provenance is invalid");
    }
  }
  const doctorDisposition = receipt.doctor.status === "inapplicable" ? "inapplicable" : receipt.doctor.incidents.length > 0 &&
    receipt.doctor.incidents.every((entry) => entry.state === "resolved" && entry.coverage === "complete") ? "recorded-resolved" : "unresolved";
  if (receipt.dispositions.doctor !== doctorDisposition) errors.push("Doctor disposition exceeds its evidence");
  return errors;
}

export function serializeCampaignRelease(receipt) {
  if (validateCompiledRelease(receipt).length > 0) throw new Error("RELEASE_RECEIPT_INVALID");
  return `${JSON.stringify(canonical(receipt), null, 2)}\n`;
}

export function renderCampaignReleaseMarkdown(receipt) {
  if (validateCompiledRelease(receipt).length > 0) throw new Error("RELEASE_RECEIPT_INVALID");
  return ["# Campaign Release Evidence", "", "Local compiled evidence. Not Provider-Verified Completion. Grants no authority.", "",
    `Receipt: ${sha256(serializeCampaignRelease(receipt))}`,
    `Inputs: ${receipt.inputHash}`, `Plan: ${receipt.planHash}`, `Item: ${receipt.itemHash ?? "inapplicable"}`,
    `Workflow: ${receipt.workflowHash ?? "bundled-defaults"}`,
    `Commit: ${receipt.candidate.commit}`, `Tree: ${receipt.candidate.tree}`, "",
    ...["item", "hostSession", "campaign", "doctor", "provider"].map((name) => `- ${name}: ${receipt.dispositions[name]}`), "",
    ...receipt.facts.map((fact) => `- ${fact.name}: ${fact.status} (${fact.provenance}; ${fact.references.length} references)`), "",
    `Doctor incidents: ${receipt.doctor.incidents.length}; inventory: ${receipt.doctor.inventoryHash}`,
    ...receipt.doctor.incidents.map((incident) => `- Doctor ${incident.incidentId}: recorded ${incident.state}; ${incident.coverage} coverage; ${incident.dependencies.filter((entry) => entry.status === "unavailable").length} unavailable dependencies`),
    `Timing: ${receipt.timing.status}; observed activity durations, not additive wall-clock time.`, ""].join("\n");
}