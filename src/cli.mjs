#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createLocalCampaignReceipt,
  inspectLocalCampaignReceiptFile,
  renderLocalCampaignReceiptMarkdown,
  serializeLocalCampaignReceipt,
} from "./campaign.mjs";
import {
  checkpointSession,
  handleHook,
  MAX_CHECKPOINT_REQUEST_BYTES,
  releaseAttachment,
  resumeSession,
  summarizePlan,
  validatePlan,
} from "./core.mjs";
import { inspectGitHubQueue, validateGitHubQueueObservation } from "./github-queue.mjs";
import {
  inspectHandoffFile,
  issueReviewAttempt,
  verifyBuildHandoff,
  verifyHandoffChain,
} from "./handoff.mjs";
import { validateHookManifest } from "./hook-manifest.mjs";
import { installLocalPlugin } from "./install.mjs";
import { acceptWorkflowRoles, parseWorkflowJson, resolveWorkflowRoles } from "./workflow.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_STDIN_BYTES = 1_048_576;

function readStdin(maximumBytes = MAX_STDIN_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let exceeded = false;
    process.stdin.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        exceeded = true;
        chunks.length = 0;
      } else chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      if (exceeded) reject(new Error("hook input exceeds the size limit"));
      else resolve(Buffer.concat(chunks));
    });
    process.stdin.on("error", reject);
  });
}

function hookInputFailure(eventName, message) {
  if (eventName === "PreToolUse") {
    return {
      permissionDecision: "deny",
      permissionDecisionReason: message,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: message,
      },
    };
  }
  if (eventName === "Stop") {
    return {
      decision: "allow",
      reason: message,
      systemMessage: message,
      hookSpecificOutput: {
        hookEventName: "Stop",
        decision: "allow",
        reason: message,
      },
    };
  }
  return {
    additionalContext: message,
    systemMessage: message,
    hookSpecificOutput: { hookEventName: eventName, additionalContext: message },
  };
}

async function validateRepository() {
  const expectedAgentFiles = [
    "seangalliher-supervised-architect.agent.md",
    "seangalliher-supervised-builder.agent.md",
    "seangalliher-supervised-diff-reviewer.agent.md",
    "seangalliher-supervised-worker.agent.md",
    "supervised-worker.agent.md",
  ];
  const required = [
    ".github/copilot-instructions.md",
    ".github/workflows/ci.yml",
    ".gitignore",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "NOTICE",
    "README.md",
    "plugin.json",
    "package.json",
    "package-lock.json",
    ...expectedAgentFiles.map((fileName) => `agents/${fileName}`),
    ...expectedAgentFiles.map((fileName) => `com.github.copilot/agents/${fileName}`),
    "hooks.json",
    "com.github.copilot/hooks/hooks.json",
    "docs/architecture.md",
    "docs/customizing-roles.md",
    "docs/evaluation.md",
    "docs/roadmap.md",
    "examples/plan.active.json",
    "examples/plan.complete.json",
    "examples/workflow.json",
    "examples/workflow.specialized.json",
    "examples/handoff.build-contract.json",
    "examples/handoff.build-report.json",
    "examples/handoff.review-report.json",
    "examples/local-campaign-receipt.json",
    "policy/constitution.json",
    "schemas/checkpoint.schema.json",
    "schemas/episode.schema.json",
    "schemas/local-campaign-receipt.schema.json",
    "schemas/model-receipt.schema.json",
    "schemas/plan.schema.json",
    "schemas/policy-proposal.schema.json",
    "schemas/procedure.schema.json",
    "schemas/role-handoff.schema.json",
    "schemas/workflow.schema.json",
    "skills/governed-queue/SKILL.md",
    "src/core.mjs",
    "src/campaign.mjs",
    "src/cli.mjs",
    "src/github-queue.mjs",
    "src/handoff.mjs",
    "src/hook-manifest.mjs",
    "src/hook-launcher.mjs",
    "src/install.mjs",
    "src/standards.mjs",
    "src/workflow.mjs",
  ];
  const errors = required
    .filter((relativePath) => !existsSync(path.join(root, relativePath)))
    .map((relativePath) => `missing ${relativePath}`);
  try {
    const actualAgentFiles = readdirSync(path.join(root, "agents"))
      .filter((fileName) => fileName.endsWith(".agent.md"))
      .sort();
    if (JSON.stringify(actualAgentFiles) !== JSON.stringify(expectedAgentFiles)) {
      errors.push(`agent role pack differs: ${actualAgentFiles.join(", ")}`);
    }
  } catch (error) {
    errors.push(`agent role pack cannot be enumerated: ${error.message}`);
  }
  let pluginVersion = null;
  try {
    const plugin = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8"));
    if (plugin.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
      errors.push("plugin.json uses the wrong Agent Plugins schema");
    }
    if (plugin.name !== "supervised-worker") errors.push("plugin name must be supervised-worker");
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(plugin.version ?? "")) {
      errors.push("plugin version must be semantic");
    }
    pluginVersion = plugin.version;
  } catch (error) {
    errors.push(`plugin.json is invalid: ${error.message}`);
  }
  try {
    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    if (packageJson.version !== pluginVersion) {
      errors.push("package.json and plugin.json versions differ");
    }
  } catch (error) {
    errors.push(`package.json is invalid: ${error.message}`);
  }
  try {
    const hooks = JSON.parse(
      readFileSync(path.join(root, "hooks.json"), "utf8"),
    );
    errors.push(...validateHookManifest(hooks));
  } catch (error) {
    errors.push(`hooks.json is invalid: ${error.message}`);
  }
  for (const relativePath of [
    ...expectedAgentFiles.map((fileName) => `agents/${fileName}`),
    ...expectedAgentFiles.map((fileName) => `com.github.copilot/agents/${fileName}`),
    "skills/governed-queue/SKILL.md",
  ]) {
    try {
      const text = readFileSync(path.join(root, relativePath), "utf8");
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      if (!frontmatter) {
        errors.push(`${relativePath} has no YAML frontmatter`);
        continue;
      }
      for (const key of ["name", "description"]) {
        if (!new RegExp(`^${key}:\\s*.+$`, "m").test(frontmatter[1])) {
          errors.push(`${relativePath} frontmatter has no ${key}`);
        }
      }
    } catch (error) {
      errors.push(`${relativePath} cannot be validated: ${error.message}`);
    }
  }

  const ignoredDirectories = new Set([".git", ".supervised-worker", "coverage", "node_modules"]);
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  walk(root);

  const jsonDocuments = new Map();
  for (const filePath of files.filter((candidate) => candidate.endsWith(".json"))) {
    try {
      jsonDocuments.set(filePath, JSON.parse(readFileSync(filePath, "utf8")));
    } catch (error) {
      errors.push(`${path.relative(root, filePath)} is invalid JSON: ${error.message}`);
    }
  }

  const schemaIds = new Set();
  for (const relativePath of required.filter((candidate) => candidate.endsWith(".schema.json"))) {
    const filePath = path.join(root, relativePath);
    const schema = jsonDocuments.get(filePath);
    if (!schema) continue;
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      errors.push(`${relativePath} must use JSON Schema 2020-12`);
    }
    if (!nonEmpty(schema.$id)) errors.push(`${relativePath} has no $id`);
    if (schemaIds.has(schema.$id)) errors.push(`duplicate schema $id: ${schema.$id}`);
    schemaIds.add(schema.$id);
  }

  for (const relativePath of ["examples/plan.active.json", "examples/plan.complete.json"]) {
    const plan = jsonDocuments.get(path.join(root, relativePath));
    if (!plan) continue;
    for (const error of validatePlan(plan)) errors.push(`${relativePath}: ${error}`);
  }

  const constitution = jsonDocuments.get(path.join(root, "policy/constitution.json"));
  if (constitution) {
    if (constitution.version !== pluginVersion) {
      errors.push("constitutional policy and plugin versions differ");
    }
    const ruleIds = constitution.immutableRules?.map((rule) => rule.id) ?? [];
    if (new Set(ruleIds).size !== ruleIds.length) {
      errors.push("constitutional policy contains duplicate rule IDs");
    }
  }

  const markdownLink = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
  for (const filePath of files.filter((candidate) => candidate.endsWith(".md"))) {
    const text = readFileSync(filePath, "utf8");
    for (const match of text.matchAll(markdownLink)) {
      let target = match[1].trim();
      if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
      target = target.split(/\s+["']/)[0].split("#")[0];
      if (!target || target.startsWith("#") || /^(?:https?|mailto):/i.test(target)) continue;
      const resolved = path.resolve(path.dirname(filePath), decodeURIComponent(target));
      if (!existsSync(resolved)) {
        errors.push(`${path.relative(root, filePath)} has broken link: ${match[1]}`);
      }
    }
  }

  const workflowText = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  if (workflowText.includes("\t")) errors.push("ci.yml contains a tab character");
  for (const operatingSystem of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    if (!workflowText.includes(operatingSystem)) errors.push(`ci.yml does not test ${operatingSystem}`);
  }
  for (const match of workflowText.matchAll(/^\s*-\s+uses:\s+[^@\s]+@([^\s#]+)/gm)) {
    if (!/^[0-9a-f]{40}$/.test(match[1])) {
      errors.push(`ci.yml action is not pinned to an immutable commit: ${match[0].trim()}`);
    }
  }

  const licenseText = readFileSync(path.join(root, "LICENSE"), "utf8");
  for (let section = 1; section <= 9; section += 1) {
    if (!licenseText.includes(`   ${section}.`)) errors.push(`LICENSE is missing section ${section}`);
  }
  const readmeText = readFileSync(path.join(root, "README.md"), "utf8");
  for (const phrase of [
    "`supervised-worker:seangalliher-supervised-worker`",
    "`supervised-worker` compatibility definition",
    "Supervised Architect`, `Supervised Builder`, and `Supervised Diff",
    "--agent=supervised-worker:seangalliher-supervised-worker",
    "--agent=supervised-worker",
    "Copilot CLI 1.0.74 or newer",
    ".github/supervised-worker.json",
    "workflowHash",
    "Customizing Companion Roles",
    "metadata-only lifecycle records",
    "does not yet capture outcome episodes or activate learned procedures",
  ]) {
    if (!readmeText.includes(phrase)) errors.push(`README.md is missing required alpha claim: ${phrase}`);
  }
  const architectureText = readFileSync(path.join(root, "docs/architecture.md"), "utf8");
  if (!architectureText.includes("metadata-only lifecycle ledger")) {
    errors.push("architecture.md must describe the implemented ledger as lifecycle metadata");
  }
  if (!architectureText.includes("future episode and lesson consolidation")) {
    errors.push("architecture.md must distinguish future episodic learning");
  }
  if (!architectureText.includes("`com.github.copilot/hooks/hooks.json`")) {
    errors.push("architecture.md must describe Copilot's implemented hook discovery path");
  }
  if (!architectureText.includes("self-declared `producedBy`")) {
    errors.push("architecture.md must describe dynamic handoff producer binding");
  }
  try {
    const { validateStandards } = await import("./standards.mjs");
    errors.push(...validateStandards(root));
  } catch (error) {
    errors.push(`standards validation could not run: ${error.message}`);
  }
  return errors;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function main() {
  const [command = "help", argument, ...argumentsAfter] = process.argv.slice(2);
  const hasNoArguments = argument === undefined && argumentsAfter.length === 0;
  const usage =
    "Usage: node src/cli.mjs <validate|doctor|install|status|checkpoint|resume|release|queue inspect OWNER/REPO --state open|closed|all|campaign export [--format json|markdown]|campaign validate PATH|workflow roles|workflow accept HASH|handoff|hook EVENT>\n";
  if (command === "help" && hasNoArguments) {
    process.stdout.write(usage);
    return;
  }
  if (command === "queue") {
    const input = argument === "inspect" && argumentsAfter.length === 3 && argumentsAfter[1] === "--state"
      ? { repository: argumentsAfter[0], state: argumentsAfter[2] }
      : null;
    let observation = inspectGitHubQueue(input);
    if (validateGitHubQueueObservation(observation).length > 0) {
      const now = new Date().toISOString();
      observation = {
        schemaVersion: 1, kind: "github-queue-observation", status: "unavailable", reason: "internal-error",
        scope: null, startedAt: now, finishedAt: now, consistency: "interval-observation", integrity: "unattested",
        actor: null, repository: null, totalCount: null, pageCount: null, issues: null,
      };
    }
    process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
    if (observation.status !== "complete") process.exitCode = 1;
    return;
  }
  if (command === "hook" && argument !== undefined && argumentsAfter.length === 0) {
    let text;
    try {
      text = await readStdin();
    } catch {
      process.stdout.write(
        `${JSON.stringify(hookInputFailure(
          argument,
          argument === "PreToolUse"
            ? "Supervised Worker denied a plan write because the hook input exceeded its size limit."
            : "Supervised Worker ignored oversized hook input and failed open visibly.",
        ))}\n`,
      );
      return;
    }
    let input;
    try {
      input = text.length === 0 ? {} : parseWorkflowJson(text);
    } catch {
      process.stdout.write(
        `${JSON.stringify(hookInputFailure(
          argument,
          argument === "PreToolUse"
            ? "Supervised Worker denied a plan write because the hook input was malformed."
            : "Supervised Worker ignored malformed hook input and failed open visibly.",
        ))}\n`,
      );
      return;
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      process.stdout.write(
        `${JSON.stringify(hookInputFailure(
          argument,
          argument === "PreToolUse"
            ? "Supervised Worker denied a plan write because the hook input was not a JSON object."
            : "Supervised Worker ignored non-object hook input and failed open visibly.",
        ))}\n`,
      );
      return;
    }
    process.stdout.write(`${JSON.stringify(handleHook(input, argument, input.cwd))}\n`);
    return;
  }
  if (["checkpoint", "resume"].includes(command) && hasNoArguments) {
    let request;
    try {
      request = parseWorkflowJson(await readStdin(MAX_CHECKPOINT_REQUEST_BYTES));
    } catch {
      process.stdout.write(`${JSON.stringify({ status: "unconfirmed", error: `${command} requires bounded, duplicate-key-free JSON stdin.` })}\n`);
      process.exitCode = 1;
      return;
    }
    try {
      const result = command === "checkpoint" ? checkpointSession(process.cwd(), request) : resumeSession(process.cwd(), request);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status !== (command === "checkpoint" ? "checkpointed" : "resumed")) process.exitCode = 1;
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ status: "unconfirmed", error: error.message })}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (command === "campaign") {
    const exportFormat = argument === "export" && argumentsAfter.length === 0
      ? "json"
      : argument === "export" &&
          argumentsAfter.length === 2 &&
          argumentsAfter[0] === "--format" &&
          ["json", "markdown"].includes(argumentsAfter[1])
        ? argumentsAfter[1]
        : null;
    if (exportFormat !== null) {
      try {
        const receipt = createLocalCampaignReceipt(process.cwd(), root);
        process.stdout.write(
          exportFormat === "markdown"
            ? renderLocalCampaignReceiptMarkdown(receipt)
            : serializeLocalCampaignReceipt(receipt),
        );
        if (receipt.localDataStatus !== "available") process.exitCode = 1;
      } catch {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            error: "Local campaign receipt could not be created safely.",
          }, null, 2)}\n`,
        );
        process.exitCode = 1;
      }
      return;
    }
    if (argument === "validate" && argumentsAfter.length === 1) {
      const report = inspectLocalCampaignReceiptFile(
        process.cwd(),
        argumentsAfter[0],
        root,
      );
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.ok) process.exitCode = 1;
      return;
    }
    process.stdout.write(usage);
    process.exitCode = 1;
    return;
  }
  if (command === "install" && hasNoArguments) {
    try {
      process.stdout.write(`${JSON.stringify(installLocalPlugin(root), null, 2)}\n`);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ installed: false, error: error.message }, null, 2)}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (command === "status" && hasNoArguments) {
    try {
      process.stdout.write(`${JSON.stringify(summarizePlan(process.cwd()), null, 2)}\n`);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ active: false, valid: false, error: "Local state could not be verified." }, null, 2)}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (command === "release" && hasNoArguments) {
    try {
      process.stdout.write(`${JSON.stringify(releaseAttachment(process.cwd()), null, 2)}\n`);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ released: false, message: "Local attachment could not be released safely." }, null, 2)}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (command === "handoff") {
    let report;
    if (argument === "validate" && argumentsAfter.length === 1) {
      report = inspectHandoffFile(process.cwd(), argumentsAfter[0]);
    } else if (argument === "pre-review" && argumentsAfter.length === 2) {
      report = verifyBuildHandoff(process.cwd(), ...argumentsAfter);
    } else if (argument === "issue-review" && argumentsAfter.length === 2) {
      report = issueReviewAttempt(process.cwd(), ...argumentsAfter);
    } else if (argument === "verify" && argumentsAfter.length === 3) {
      report = verifyHandoffChain(process.cwd(), ...argumentsAfter);
    } else {
      report = {
        ok: false,
        errors: [
          "Usage: handoff validate <artifact> | handoff pre-review <contract> <build-report> | handoff issue-review <contract> <build-report> | handoff verify <contract> <build-report> <review-report>",
        ],
      };
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "workflow" && argument === "roles" && argumentsAfter.length === 0) {
    const report = resolveWorkflowRoles(process.cwd());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "workflow" && argument === "accept" && argumentsAfter.length === 1) {
    const report = acceptWorkflowRoles(process.cwd(), argumentsAfter[0]);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if ((command === "validate" || command === "doctor") && hasNoArguments) {
    const errors = await validateRepository();
    let plan;
    try {
      plan = summarizePlan(process.cwd());
    } catch {
      const error = "Local state could not be verified.";
      plan = { active: false, valid: false, error };
      errors.push(error);
    }
    const report = {
      ok: errors.length === 0,
      node: process.version,
      pluginRoot: root,
      plan,
      errors,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (errors.length > 0) process.exitCode = 1;
    return;
  }
  process.stdout.write(usage);
  process.exitCode = 1;
}

await main();