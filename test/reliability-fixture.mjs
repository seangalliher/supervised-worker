import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyWorkerAuthority } from "../src/authority.mjs";
import { applyCampaignPlan, observeCampaignTransition, readRecoveryFrontier, summarizePlan } from "../src/core.mjs";
import { installLocalPlugin } from "../src/install.mjs";
import { formatDoctorInvocation } from "../src/doctor-invocation.mjs";
import { acceptWorkflowRoles, resolveWorkflowRoles } from "../src/workflow.mjs";

export const reliabilitySourceRoot = fileURLToPath(new URL("../", import.meta.url));

export function withReliabilityFixture(action, options = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sw-reliability-fixture-")));
  let pending = false;
  const cleanup = () => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  try {
    const cwd = path.join(base, "repository");
    const workflowPath = path.join(cwd, ".github", "supervised-worker.json");
    mkdirSync(path.dirname(workflowPath), { recursive: true });
    const workflow = JSON.parse(readFileSync(path.join(reliabilitySourceRoot, "examples", "workflow.json")));
    workflow.authority.assurance = "local-scoped";
    options.configureWorkflow?.(workflow);
    writeFileSync(workflowPath, JSON.stringify(workflow));
    assert.equal(acceptWorkflowRoles(cwd, resolveWorkflowRoles(cwd).workflowHash).ok, true);
    writeFileSync(path.join(cwd, "README.md"), "Benign recovery qualification fixture.\n");
    const storage = path.join(base, "storage");
    const transcripts = path.join(storage, "GitHub.copilot-chat", "transcripts");
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(path.join(storage, "workspace.json"), "{}\n");
    const { installRoot } = installLocalPlugin(reliabilitySourceRoot, { baseDirectory: path.join(base, "installation") });
    let input;
    const plan = { schemaVersion: 1, mode: "active", goal: "Qualify bounded local recovery.",
      items: [{ id: "one", title: "One bounded fixture item", status: "in_progress" }], completion: null };
    const fixture = {
      base, cwd, storage, transcripts, installRoot, plan, workflow, workflowPath,
      get input() { return { ...input }; },
      authority() { return verifyWorkerAuthority(cwd, input, installRoot, ""); },
      select(session_id) {
        input = { session_id, transcript_path: path.join(transcripts, `${session_id}.jsonl`) };
        if (!existsSync(input.transcript_path)) writeFileSync(input.transcript_path, "");
        return fixture.input;
      },
      observe() { return observeCampaignTransition(cwd, input); },
      frontier() { return readRecoveryFrontier(cwd); },
      operations() { return summarizePlan(cwd).operations; },
      hookTimeoutMs(event) {
        const manifest = JSON.parse(readFileSync(path.join(installRoot, "com.github.copilot", "hooks", "hooks.json")));
        return manifest.hooks[event][0].timeoutSec * 1_000;
      },
      native(args, request, expectedExit = 0) {
        const hook = args[0] === "hook";
        const command = hook ? [path.join(installRoot, "src", "hook-launcher.mjs"), args[1]]
          : [path.join(installRoot, "src", "cli.mjs"), ...args];
        const result = spawnSync(process.execPath, command,
          { cwd, input: JSON.stringify(request), encoding: "utf8",
            timeout: hook ? fixture.hookTimeoutMs(args[1]) : options.commandTimeout ?? 30_000 });
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.signal, null, result.stderr);
        assert.equal(result.status, expectedExit, result.stderr || result.stdout);
        return JSON.parse(result.stdout);
      },
      hook(event, extra = {}) { return fixture.native(["hook", event], { cwd, ...input, ...extra }); },
      doctor(request, expectedExit = 0) {
        const invocation = formatDoctorInvocation(cwd, { ...input, ...request }, installRoot);
        return fixture.executeDoctorInvocation(invocation, expectedExit);
      },
      executeDoctorInvocation(invocation, expectedExit = 0) {
        assert.equal(invocation.status, "formatted", JSON.stringify(invocation));
        const pre = fixture.hook("PreToolUse", { tool_name: "run_in_terminal", tool_input: { command: invocation.command } });
        assert.equal(pre.permissionDecision, "allow", JSON.stringify(pre));
        const encoded = /--request-base64 '([A-Za-z0-9+/=]+)'$/.exec(invocation.command)?.[1];
        assert.ok(encoded);
        const result = spawnSync(process.execPath, [path.join(installRoot, "src", "doctor-rescue.mjs"), "--request-base64", encoded],
          { cwd, encoding: "utf8", timeout: 30_000 });
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.signal, null, result.stderr);
        assert.equal(result.status, expectedExit, result.stderr || result.stdout);
        return JSON.parse(result.stdout);
      },
      tool(id) {
        const request = { tool_name: "read_file", tool_use_id: id, tool_input: { filePath: path.join(cwd, "README.md") } };
        const before = fixture.hook("PreToolUse", request);
        assert.notEqual(before.permissionDecision ?? before.hookSpecificOutput?.permissionDecision, "deny", JSON.stringify(before));
        assert.match(readFileSync(request.tool_input.filePath, "utf8"), /Benign/);
        const after = fixture.hook("PostToolUse", request);
        assert.equal(after.additionalContext, undefined, JSON.stringify(after));
        return { before, after };
      },
    };
    fixture.select("source-worker");
    if (options.admit !== false) assert.equal(applyCampaignPlan(cwd, { ...input, expected: fixture.observe(), plan }, fixture.authority()).status, "applied");
    const result = action(fixture);
    if (result instanceof Promise) {
      pending = true;
      return result.finally(cleanup);
    }
    return result;
  } finally {
    if (!pending) cleanup();
  }
}
