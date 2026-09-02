#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  handleHook,
  PLAN_WRITER_MATCHER,
  releaseAttachment,
  summarizePlan,
  validatePlan,
} from "./core.mjs";
import { inspectHandoffFile, verifyBuildHandoff, verifyHandoffChain } from "./handoff.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_STDIN_BYTES = 1_048_576;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    let exceeded = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_STDIN_BYTES) exceeded = true;
      else data += chunk;
    });
    process.stdin.on("end", () => {
      if (exceeded) reject(new Error("hook input exceeds the size limit"));
      else resolve(data);
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
    "hooks.json",
    "docs/architecture.md",
    "docs/evaluation.md",
    "docs/roadmap.md",
    "examples/plan.active.json",
    "examples/plan.complete.json",
    "examples/workflow.json",
    "examples/handoff.build-contract.json",
    "examples/handoff.build-report.json",
    "examples/handoff.review-report.json",
    "policy/constitution.json",
    "schemas/episode.schema.json",
    "schemas/plan.schema.json",
    "schemas/policy-proposal.schema.json",
    "schemas/procedure.schema.json",
    "schemas/role-handoff.schema.json",
    "schemas/workflow.schema.json",
    "skills/governed-queue/SKILL.md",
    "src/core.mjs",
    "src/cli.mjs",
    "src/handoff.mjs",
    "src/standards.mjs",
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
    if (hooks.version !== 1) errors.push("hooks.json version must be 1");
    const expectedEvents = [
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PreCompact",
      "Stop",
    ];
    if (JSON.stringify(Object.keys(hooks.hooks ?? {})) !== JSON.stringify(expectedEvents)) {
      errors.push("hooks.json event set or ordering is invalid");
    }
    if (hooks.hooks?.PreToolUse?.[0]?.matcher !== PLAN_WRITER_MATCHER) {
      errors.push("PreToolUse matcher differs from the case-sensitive writer vocabulary");
    }
    for (const event of expectedEvents) {
      for (const entry of hooks.hooks?.[event] ?? []) {
        if (!entry.bash?.includes("${PLUGIN_ROOT}/src/cli.mjs")) {
          errors.push(`${event} bash command must use PLUGIN_ROOT`);
        }
        if (!entry.powershell?.includes("$env:PLUGIN_ROOT/src/cli.mjs")) {
          errors.push(`${event} PowerShell command must use PLUGIN_ROOT`);
        }
        if (!Number.isFinite(entry.timeoutSec) || entry.timeoutSec <= 0) {
          errors.push(`${event} timeoutSec must be positive`);
        }
      }
    }
  } catch (error) {
    errors.push(`hooks.json is invalid: ${error.message}`);
  }
  for (const relativePath of [
    ...expectedAgentFiles.map((fileName) => `agents/${fileName}`),
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
    "A `Supervised Worker` custom agent that owns queue and release state.",
    "Supervised Architect`, `Supervised Builder`, and `Supervised Diff",
    "--agent=supervised-worker",
    "Copilot CLI 1.0.74 or newer",
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
  if (!architectureText.includes("root `hooks.json`")) {
    errors.push("architecture.md must describe Copilot's implemented hook discovery path");
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
  if (command === "hook") {
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
      input = JSON.parse(text || "{}");
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
  if (command === "status") {
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
  if (command === "release") {
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
    } else if (argument === "verify" && argumentsAfter.length === 3) {
      report = verifyHandoffChain(process.cwd(), ...argumentsAfter);
    } else {
      report = {
        ok: false,
        errors: [
          "Usage: handoff validate <artifact> | handoff pre-review <contract> <build-report> | handoff verify <contract> <build-report> <review-report>",
        ],
      };
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "validate" || command === "doctor") {
    const errors = await validateRepository();
    const report = {
      ok: errors.length === 0,
      node: process.version,
      pluginRoot: root,
      plan: summarizePlan(process.cwd()),
      errors,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (errors.length > 0) process.exitCode = 1;
    return;
  }
  process.stdout.write(
    "Usage: node src/cli.mjs <validate|doctor|status|release|handoff|hook EVENT>\n",
  );
}

await main();