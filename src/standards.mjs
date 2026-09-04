import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parseDocument } from "yaml";

import { validateLocalCampaignReceipt } from "./campaign.mjs";
import { validateHandoffValue } from "./handoff.mjs";
import { validateWorkflowValue } from "./workflow.mjs";

const PLUGIN_SCHEMA_ID = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const PLUGIN_KEYS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);
const SKILL_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);
const SCHEMA_FILES = [
  "episode.schema.json",
  "local-campaign-receipt.schema.json",
  "model-receipt.schema.json",
  "plan.schema.json",
  "policy-proposal.schema.json",
  "procedure.schema.json",
  "role-handoff.schema.json",
  "workflow.schema.json",
];
const EXAMPLE_SCHEMAS = [
  ["examples/workflow.json", "workflow.schema.json"],
  ["examples/workflow.specialized.json", "workflow.schema.json"],
  ["examples/plan.active.json", "plan.schema.json"],
  ["examples/plan.complete.json", "plan.schema.json"],
  ["examples/handoff.build-contract.json", "role-handoff.schema.json"],
  ["examples/handoff.build-report.json", "role-handoff.schema.json"],
  ["examples/handoff.review-report.json", "role-handoff.schema.json"],
  ["examples/local-campaign-receipt.json", "local-campaign-receipt.schema.json"],
];

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function formatAjvErrors(label, errors) {
  return (errors ?? []).map(
    (error) => `${label}${error.instancePath || "/"} ${error.message ?? error.keyword}`,
  );
}

export function validatePluginManifest(plugin) {
  const errors = [];
  if (!isRecord(plugin)) return ["plugin.json must contain an object"];
  for (const key of Object.keys(plugin)) {
    if (!PLUGIN_KEYS.has(key)) errors.push(`plugin.json contains unknown property: ${key}`);
  }
  if (plugin.$schema !== PLUGIN_SCHEMA_ID) {
    errors.push("plugin.json targets an unsupported Agent Plugins schema");
  }
  if (
    typeof plugin.name !== "string" ||
    plugin.name.length < 1 ||
    plugin.name.length > 64 ||
    !/^[a-z0-9](?!.*(?:--|\.\.))[a-z0-9.-]*[a-z0-9]$|^[a-z0-9]$/.test(plugin.name)
  ) {
    errors.push("plugin.json name violates Agent Plugins 1.0 constraints");
  }
  for (const key of ["version", "description", "homepage", "repository", "license"]) {
    if (plugin[key] !== undefined && typeof plugin[key] !== "string") {
      errors.push(`plugin.json ${key} must be a string`);
    }
  }
  if (plugin.author !== undefined) {
    if (!isRecord(plugin.author)) {
      errors.push("plugin.json author must be an object");
    } else {
      for (const [key, value] of Object.entries(plugin.author)) {
        if (!["name", "email", "url"].includes(key)) {
          errors.push(`plugin.json author contains unknown property: ${key}`);
        } else if (typeof value !== "string") {
          errors.push(`plugin.json author.${key} must be a string`);
        }
      }
    }
  }
  if (
    plugin.keywords !== undefined &&
    (!Array.isArray(plugin.keywords) || plugin.keywords.some((value) => typeof value !== "string"))
  ) {
    errors.push("plugin.json keywords must be an array of strings");
  }
  if (plugin.extensions !== undefined) {
    if (!isRecord(plugin.extensions)) {
      errors.push("plugin.json extensions must be an object");
    } else if (Object.values(plugin.extensions).some((value) => !isRecord(value))) {
      errors.push("plugin.json extension values must be objects");
    }
  }
  return errors;
}

export function validateSkillDocument(text, directoryName) {
  const errors = [];
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!frontmatter) return [`skills/${directoryName}/SKILL.md has no YAML frontmatter`];
  const document = parseDocument(frontmatter[1], { uniqueKeys: true });
  if (document.errors.length > 0) {
    return document.errors.map(
      (error) => `skills/${directoryName}/SKILL.md has invalid YAML: ${error.message}`,
    );
  }
  const metadata = document.toJS();
  if (!isRecord(metadata)) return [`skills/${directoryName}/SKILL.md frontmatter must be a map`];
  for (const key of Object.keys(metadata)) {
    if (!SKILL_KEYS.has(key)) {
      errors.push(`skills/${directoryName}/SKILL.md contains unsupported field: ${key}`);
    }
  }
  if (
    typeof metadata.name !== "string" ||
    metadata.name.length < 1 ||
    metadata.name.length > 64 ||
    !/^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(metadata.name)
  ) {
    errors.push(`skills/${directoryName}/SKILL.md name violates Agent Skills constraints`);
  } else if (metadata.name !== directoryName) {
    errors.push(`skills/${directoryName}/SKILL.md name must match its directory`);
  }
  if (
    typeof metadata.description !== "string" ||
    metadata.description.length < 1 ||
    metadata.description.length > 1_024
  ) {
    errors.push(`skills/${directoryName}/SKILL.md description must contain 1-1024 characters`);
  }
  if (metadata.license !== undefined && typeof metadata.license !== "string") {
    errors.push(`skills/${directoryName}/SKILL.md license must be a string`);
  }
  if (
    metadata.compatibility !== undefined &&
    (typeof metadata.compatibility !== "string" ||
      metadata.compatibility.length < 1 ||
      metadata.compatibility.length > 500)
  ) {
    errors.push(`skills/${directoryName}/SKILL.md compatibility must contain 1-500 characters`);
  }
  if (metadata.metadata !== undefined) {
    if (!isRecord(metadata.metadata)) {
      errors.push(`skills/${directoryName}/SKILL.md metadata must be a map`);
    } else if (Object.values(metadata.metadata).some((value) => typeof value !== "string")) {
      errors.push(`skills/${directoryName}/SKILL.md metadata values must be strings`);
    }
  }
  if (metadata["allowed-tools"] !== undefined && typeof metadata["allowed-tools"] !== "string") {
    errors.push(`skills/${directoryName}/SKILL.md allowed-tools must be a string`);
  }
  return errors;
}

function approvedPolicyProposal() {
  return {
    schemaVersion: 1,
    id: "proposal-1",
    target: "policy/constitution.json",
    baseHash: "a".repeat(64),
    effectClass: "workflow",
    rationale: "Verified change",
    typedDiff: [{ operation: "replace", path: "/rule", value: "new value" }],
    evidence: ["evaluation-1"],
    replay: { status: "passed", cases: 1 },
    review: { status: "approved", reviewer: "independent-reviewer" },
    humanApproval: {
      status: "approved",
      approvedBy: "human-owner",
      approvedAt: "2026-09-01T00:00:00Z",
    },
    status: "approved",
  };
}

function validatePolicyGates(validate, errors) {
  const baseline = approvedPolicyProposal();
  if (!validate(baseline)) {
    errors.push(...formatAjvErrors("policy-proposal valid baseline", validate.errors));
    return;
  }
  const mutants = [
    ["empty typedDiff", (value) => { value.typedDiff = []; }],
    ["replay not passed", (value) => { value.replay = { status: "not-run", cases: 0 }; }],
    ["review not approved", (value) => { value.review = { status: "pending" }; }],
    ["human approval absent", (value) => { value.humanApproval = { status: "required" }; }],
  ];
  for (const [name, mutate] of mutants) {
    const value = structuredClone(baseline);
    mutate(value);
    if (validate(value)) errors.push(`policy-proposal schema accepted unsafe state: ${name}`);
  }
}

function validateWorkflowGates(validate, workflow, errors) {
  const rejectBoth = (name, value) => {
    if (validate(value)) errors.push(`workflow schema accepted unsafe state: ${name}`);
    if (validateWorkflowValue(value).length === 0) {
      errors.push(`workflow runtime accepted unsafe state: ${name}`);
    }
  };
  for (const field of ["required", "independent"]) {
    const value = structuredClone(workflow);
    value.review[field] = false;
    rejectBoth(`review.${field}=false`, value);
  }
  for (const [name, mutate] of [
    ["blank tracker scope", (value) => { value.tracker.scope = "   "; }],
    ["blank authority boundary", (value) => { value.authority.boundaries = [" "]; }],
    ["blank focused command", (value) => { value.validation.focused = "\t"; }],
    ["blank receipt glob", (value) => { value.validation.receiptGlobs = [" "]; }],
    ["partial reviewer model policy", (value) => {
      value.review.requiredModel = "gpt-5.6-sol";
    }],
    ["invalid model-family requirement", (value) => {
      value.review.requireDifferentModelFamily = "true";
    }],
    ["separation without reviewer model policy", (value) => {
      value.review.requireDifferentModelFamily = true;
    }],
  ]) {
    const value = structuredClone(workflow);
    mutate(value);
    rejectBoth(name, value);
  }
  for (const [name, mutate] of [
    ["duplicate role selectors", (value) => { value.roles.builder = value.roles.architect; }],
    ["Worker as companion", (value) => { value.roles.architect = "supervised-worker"; }],
    ["qualified Worker as companion", (value) => {
      value.roles.architect = "supervised-worker:seangalliher-supervised-worker";
    }],
    ["conflicting reviewer aliases", (value) => { value.review.agent = "other-reviewer"; }],
    ["legacy reviewer duplicates Architect", (value) => {
      delete value.roles;
      value.review.agent = "supervised-worker:seangalliher-supervised-architect";
    }],
  ]) {
    const value = structuredClone(workflow);
    mutate(value);
    if (validateWorkflowValue(value).length === 0) {
      errors.push(`workflow runtime accepted unsafe state: ${name}`);
    }
  }
}

function validateRoleHandoffGates(validate, root, errors) {
  const reject = (name, value) => {
    if (validate(value)) errors.push(`role-handoff schema accepted unsafe state: ${name}`);
    if (validateHandoffValue(value, root).length === 0) {
      errors.push(`role-handoff runtime accepted unsafe state: ${name}`);
    }
  };
  const contract = readJson(root, "examples/handoff.build-contract.json");
  contract.targetFiles = [];
  reject("empty approved footprint", contract);

  for (const target of [".git/config", ".supervised-worker/plan.json", "../outside.js"]) {
    const protectedContract = readJson(root, "examples/handoff.build-contract.json");
    protectedContract.targetFiles = [target];
    reject(`protected target ${target}`, protectedContract);
  }

  const build = readJson(root, "examples/handoff.build-report.json");
  build.checks[0].outcome = "skipped";
  reject("skipped implemented check", build);

  const cleanReview = readJson(root, "examples/handoff.review-report.json");
  cleanReview.findings.push({
    severity: "medium",
    summary: "Consumer rejected the value.",
    consumer: "consumer",
    evidence: [{ kind: "probe", locator: "local:probe" }],
    blocksCommit: true,
  });
  reject("finding in clean review", cleanReview);

  const requiredReview = readJson(root, "examples/handoff.review-report.json");
  requiredReview.verdict = "changes-required";
  reject("changes-required without findings", requiredReview);

  const nonBlockingReview = readJson(root, "examples/handoff.review-report.json");
  nonBlockingReview.verdict = "changes-required";
  nonBlockingReview.findings.push({
    severity: "low",
    summary: "Follow-up available.",
    consumer: "maintainer",
    evidence: [{ kind: "reading", locator: "src/module.js" }],
    blocksCommit: false,
  });
  reject("changes-required without commit blocker", nonBlockingReview);

  const undeclared = readJson(root, "examples/handoff.build-contract.json");
  undeclared.selectedApproach = "not-declared";
  if (validateHandoffValue(undeclared, root).length === 0) {
    errors.push("role-handoff runtime accepted an undeclared selectedApproach");
  }
}

function validateLocalCampaignGates(validate, root, errors) {
  const baseline = readJson(root, "examples/local-campaign-receipt.json");
  const reject = (name, mutate, schemaMustReject = true) => {
    const value = structuredClone(baseline);
    mutate(value);
    if (schemaMustReject && validate(value)) {
      errors.push(`local campaign receipt schema accepted unsafe state: ${name}`);
    }
    if (validateLocalCampaignReceipt(value).length === 0) {
      errors.push(`local campaign receipt runtime accepted unsafe state: ${name}`);
    }
  };
  reject("non-null provider fact", (value) => {
    value.providerFacts.ci.value = { conclusion: "success" };
  });
  reject("unavailable plan carrying zero metrics", (value) => {
    value.localDataStatus = "partial";
    value.plan.status = "unavailable";
    value.plan.reason = "plan-invalid";
    value.plan.hash = null;
    value.plan.mode = null;
    value.plan.localCompletionShape = null;
    value.plan.items = null;
  });
  reject("inconsistent localDataStatus", (value) => {
    value.localDataStatus = "partial";
  });
  reject("unsorted item hashes", (value) => {
    value.plan.items.reverse();
  }, false);
  reject("duplicate item hashes", (value) => {
    value.plan.items[1].itemHash = value.plan.items[0].itemHash;
  }, false);
  reject("event totals differ from recordCount", (value) => {
    value.runLedger.eventCounts[0].count += 1;
  }, false);
  const wrapped = [
    ["plugin.version", (value) => { value.plugin.version = [value.plugin.version]; }],
    ["plugin.sourceHash", (value) => { value.plugin.sourceHash = [value.plugin.sourceHash]; }],
    ["plan.hash", (value) => { value.plan.hash = [value.plan.hash]; }],
    ["plan item hash", (value) => { value.plan.items[0].itemHash = [value.plan.items[0].itemHash]; }],
    ["runLedger.hash", (value) => { value.runLedger.hash = [value.runLedger.hash]; }],
  ];
  for (const [field, mutate] of wrapped) {
    reject(`non-string ${field}`, mutate);
  }
}

export function validatePublishedSchemas(root) {
  const errors = [];
  const discovered = readdirSync(path.join(root, "schemas"))
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
  if (JSON.stringify(discovered) !== JSON.stringify(SCHEMA_FILES)) {
    errors.push(`expected exactly these published schemas: ${SCHEMA_FILES.join(", ")}`);
    return errors;
  }

  const ajv = new Ajv2020({
    allErrors: true,
    strictSchema: true,
    strictTypes: false,
    strictRequired: false,
  });
  addFormats(ajv);
  const schemas = new Map();
  for (const fileName of SCHEMA_FILES) {
    try {
      const schema = readJson(root, `schemas/${fileName}`);
      if (!ajv.validateSchema(schema)) {
        errors.push(...formatAjvErrors(`schemas/${fileName}`, ajv.errors));
        continue;
      }
      ajv.addSchema(schema);
      schemas.set(fileName, schema.$id);
    } catch (error) {
      errors.push(`schemas/${fileName} could not be compiled: ${error.message}`);
    }
  }

  for (const [examplePath, schemaFile] of EXAMPLE_SCHEMAS) {
    const schemaId = schemas.get(schemaFile);
    const validate = schemaId ? ajv.getSchema(schemaId) : null;
    if (!validate) {
      errors.push(`${examplePath} has no compiled schema`);
      continue;
    }
    try {
      const example = readJson(root, examplePath);
      if (!validate(example)) errors.push(...formatAjvErrors(examplePath, validate.errors));
      if (schemaFile === "role-handoff.schema.json") {
        const runtimeErrors = validateHandoffValue(example, root);
        errors.push(...runtimeErrors.map((error) => `${examplePath} runtime: ${error}`));
      } else if (schemaFile === "workflow.schema.json") {
        const runtimeErrors = validateWorkflowValue(example);
        errors.push(...runtimeErrors.map((error) => `${examplePath} runtime: ${error}`));
      } else if (schemaFile === "local-campaign-receipt.schema.json") {
        const runtimeErrors = validateLocalCampaignReceipt(example);
        errors.push(...runtimeErrors.map((error) => `${examplePath} runtime: ${error}`));
      }
    } catch (error) {
      errors.push(`${examplePath} could not be validated: ${error.message}`);
    }
  }

  const policySchemaId = schemas.get("policy-proposal.schema.json");
  const policyValidate = policySchemaId ? ajv.getSchema(policySchemaId) : null;
  if (policyValidate) validatePolicyGates(policyValidate, errors);
  else errors.push("policy-proposal schema safety gates could not be exercised");
  const workflowSchemaId = schemas.get("workflow.schema.json");
  const workflowValidate = workflowSchemaId ? ajv.getSchema(workflowSchemaId) : null;
  if (workflowValidate) {
    validateWorkflowGates(workflowValidate, readJson(root, "examples/workflow.json"), errors);
  } else errors.push("workflow schema review gates could not be exercised");
  const roleHandoffSchemaId = schemas.get("role-handoff.schema.json");
  const roleHandoffValidate = roleHandoffSchemaId ? ajv.getSchema(roleHandoffSchemaId) : null;
  if (roleHandoffValidate) validateRoleHandoffGates(roleHandoffValidate, root, errors);
  else errors.push("role-handoff safety gates could not be exercised");
  const campaignSchemaId = schemas.get("local-campaign-receipt.schema.json");
  const campaignValidate = campaignSchemaId ? ajv.getSchema(campaignSchemaId) : null;
  if (campaignValidate) validateLocalCampaignGates(campaignValidate, root, errors);
  else errors.push("local campaign receipt safety gates could not be exercised");
  return errors;
}

export function validateStandards(root) {
  const errors = [];
  try {
    errors.push(...validatePluginManifest(readJson(root, "plugin.json")));
  } catch (error) {
    errors.push(`plugin.json could not be validated: ${error.message}`);
  }

  const skillsRoot = path.join(root, "skills");
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsRoot, entry.name, "SKILL.md");
    try {
      errors.push(...validateSkillDocument(readFileSync(skillPath, "utf8"), entry.name));
    } catch (error) {
      errors.push(`skills/${entry.name}/SKILL.md could not be validated: ${error.message}`);
    }
  }

  const rootAgents = path.join(root, "agents");
  const copilotAgents = path.join(root, "com.github.copilot", "agents");
  try {
    const rootNames = readdirSync(rootAgents)
      .filter((name) => name.endsWith(".agent.md"))
      .sort();
    const copilotNames = readdirSync(copilotAgents)
      .filter((name) => name.endsWith(".agent.md"))
      .sort();
    if (JSON.stringify(copilotNames) !== JSON.stringify(rootNames)) {
      errors.push("com.github.copilot/agents must mirror the root agent filename set");
    }
    for (const name of rootNames) {
      const source = readFileSync(path.join(rootAgents, name));
      const copy = readFileSync(path.join(copilotAgents, name));
      if (!source.equals(copy)) {
        errors.push(`com.github.copilot/agents/${name} differs from agents/${name}`);
      }
    }
  } catch (error) {
    errors.push(`Copilot agent compatibility copies could not be validated: ${error.message}`);
  }

  try {
    const source = readFileSync(path.join(root, "hooks.json"));
    const copy = readFileSync(path.join(root, "com.github.copilot", "hooks", "hooks.json"));
    if (!source.equals(copy)) {
      errors.push("com.github.copilot/hooks/hooks.json differs from hooks.json");
    }
  } catch (error) {
    errors.push(`Copilot hook compatibility copy could not be validated: ${error.message}`);
  }
  errors.push(...validatePublishedSchemas(root));
  return errors;
}