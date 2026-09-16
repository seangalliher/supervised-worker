import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { canonicalPlanHash, readRecoveryTip, sha256, summarizeRunLedger } from "../src/core.mjs";
import { JournalOperationIndex, JOURNAL_LIMITS, RECOVERY_LIMITS } from "../src/journal-capacity.mjs";
import { serializeRecovery } from "../src/recovery-state.mjs";
import { failureFromError } from "../src/supervisor-diagnostics.mjs";
import { withReliabilityFixture } from "./reliability-fixture.mjs";

function journalUsage(fixture) {
  const directory = path.join(fixture.cwd, ".supervised-worker", "runs");
  const files = fs.readdirSync(directory).sort();
  return { files, bytes: files.reduce((total, name) => total + fs.statSync(path.join(directory, name)).size, 0) };
}

function seedFrontiers(fixture, count) {
  let selected = fixture.frontier();
  const root = path.join(fixture.cwd, ".supervised-worker", "recovery");
  const directory = path.join(root, "frontiers");
  while (selected.frontier.sequence + 1 < count) {
    const frontier = { ...selected.frontier, sequence: selected.frontier.sequence + 1,
      previousHash: selected.frontierHash, transitionId: randomUUID(), cause: "tool-observation" };
    const bytes = serializeRecovery(frontier, "frontier");
    const frontierHash = sha256(bytes);
    fs.writeFileSync(path.join(directory, `${frontierHash}.json`), bytes, { flag: "wx" });
    selected = { frontier, frontierHash };
  }
  fs.writeFileSync(path.join(root, "head.json"), serializeRecovery({ schemaVersion: 1, kind: "recovery-head",
    campaignId: selected.frontier.campaignId, sequence: selected.frontier.sequence, frontierHash: selected.frontierHash }, "head"));
  assert.equal(fs.readdirSync(directory).length, count);
  assert.equal(fixture.frontier().hashes.length, count, "the seeded ancestry must really be valid");
  assert.ok(count + 1 + RECOVERY_LIMITS.controlRecords + 2 <= RECOVERY_LIMITS.records);
  return selected;
}

function seedReportedHistory(fixture) {
  const existing = summarizeRunLedger(fixture.cwd);
  assert.equal(existing.status, "available");
  const session = sha256("F2-reported-history");
  const directory = path.join(fixture.cwd, ".supervised-worker", "runs");
  let chunks = [];
  let size = 0;
  let segment = 0;
  const flush = () => {
    const name = `${session}${segment ? `.${String(segment).padStart(6, "0")}` : ""}.jsonl`;
    fs.writeFileSync(path.join(directory, name), Buffer.concat(chunks), { flag: "wx" });
    segment += 1;
    chunks = [];
    size = 0;
  };
  for (let index = existing.recordCount; index < 22_900; index += 1) {
    const line = Buffer.from(`${JSON.stringify({ schemaVersion: 1, at: new Date(1_700_000_000_000 + index).toISOString(),
      event: "pre_compact", session, trigger: `historical-${index}-${"x".repeat(340)}` })}\n`);
    if (size + line.length > JOURNAL_LIMITS.fileBytes) flush();
    chunks.push(line);
    size += line.length;
  }
  if (chunks.length) flush();
  const usage = journalUsage(fixture);
  assert.ok(usage.bytes > 11_900_000 && usage.bytes < 12_000_000);
  assert.equal(summarizeRunLedger(fixture.cwd).recordCount, 22_900);
  return usage;
}

function operationPair(session, number) {
  const start = { schemaVersion: 1, at: new Date(1_700_000_000_000 + number * 2).toISOString(), event: "tool_started", session,
    toolName: "read_file", operationId: `11111111-1111-4111-8111-${String(number).padStart(12, "0")}`,
    invocationHash: sha256(`dense-${number}`), requestHash: sha256("dense-request"), routeGeneration: null, claimGeneration: null };
  const { requestHash, ...identity } = start;
  const complete = { ...identity, at: new Date(1_700_000_000_001 + number * 2).toISOString(),
    event: "tool_completed", observationId: `22222222-2222-4222-8222-${String(number).padStart(12, "0")}`, success: true };
  return [start, complete];
}

function seedDenseMaximumHistory(fixture, operations = true) {
  const target = JOURNAL_LIMITS.totalBytes - JOURNAL_LIMITS.controlBytes -
    JOURNAL_LIMITS.terminalRecords * JOURNAL_LIMITS.recordBytes - 4_096;
  const directory = path.join(fixture.cwd, ".supervised-worker", "runs");
  const session = sha256("F2-dense-history");
  let remaining = target - journalUsage(fixture).bytes;
  let number = 0;
  for (let segment = 0; segment < 251; segment += 1) {
    const size = Math.floor(remaining / (251 - segment));
    const chunks = [];
    let bytes = 0;
    while (true) {
      const records = operations ? operationPair(session, number) : [{ schemaVersion: 1,
        at: new Date(1_700_000_000_000 + number).toISOString(), event: "plan_inactive", session }];
      const pair = records.map((record) => Buffer.from(`${JSON.stringify(record)}\n`));
      const pairBytes = pair.reduce((sum, line) => sum + line.length, 0);
      if (bytes + pairBytes > size) break;
      chunks.push(...pair);
      bytes += pairBytes;
      number += 1;
    }
    assert.ok(chunks.length > 0);
    const last = chunks.pop();
    assert.ok(last.length + size - bytes <= JOURNAL_LIMITS.recordBytes);
    chunks.push(Buffer.concat([last.subarray(0, -1), Buffer.from(" ".repeat(size - bytes) + "\n")]));
    const name = `${session}${segment ? `.${String(segment).padStart(6, "0")}` : ""}.jsonl`;
    fs.writeFileSync(path.join(directory, name), Buffer.concat(chunks), { flag: "wx" });
    remaining -= size;
  }
  const usage = journalUsage(fixture);
  assert.equal(usage.bytes, target);
  assert.equal(usage.files.length, JOURNAL_LIMITS.files - JOURNAL_LIMITS.controlFiles);
  const summary = summarizeRunLedger(fixture.cwd);
  assert.equal(summary.status, "available");
  assert.ok(summary.recordCount > (operations ? 30_000 : 80_000),
    "the maximum fixture must exercise dense records, not mostly padding");
  return { ...usage, recordCount: summary.recordCount };
}

function measuredHook(fixture, event, request = {}, replacement = null, missingIdentity = null) {
  const launcher = path.join(fixture.installRoot, "src", "hook-launcher.mjs");
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const originals = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync,
      lstatSync: fs.lstatSync, fstatSync: fs.fstatSync };
    const journal = ${JSON.stringify(path.join(fixture.cwd, ".supervised-worker", "runs"))};
    const frontiers = ${JSON.stringify(path.join(fixture.cwd, ".supervised-worker", "recovery", "frontiers"))};
    const replacement = ${JSON.stringify(replacement)};
    const missingIdentity = ${JSON.stringify(missingIdentity)};
    const descriptors = new Map();
    const metrics = { journal: {}, frontiers: {}, replacements: 0, missingIdentities: 0 };
    let replacementBytes = null;
    const withoutIdentity = (target, stats) => {
      if (!missingIdentity || path.dirname(target ?? "") !== journal || !target.endsWith(".jsonl")) return stats;
      metrics.missingIdentities += 1;
      const changed = Object.create(stats);
      Object.defineProperty(changed, missingIdentity, { value: typeof stats[missingIdentity] === "bigint" ? 0n : 0 });
      return changed;
    };
    fs.lstatSync = (target, ...args) => withoutIdentity(typeof target === "string" ? target : "", originals.lstatSync(target, ...args));
    fs.fstatSync = (fd, ...args) => withoutIdentity(descriptors.get(fd), originals.fstatSync(fd, ...args));
    fs.openSync = (target, ...args) => {
      const fd = originals.openSync(target, ...args);
      const name = typeof target === "string" ? target : "";
      descriptors.set(fd, name);
      const group = path.dirname(name) === journal && /^[0-9a-f]{64}(?:\\.[0-9]{6})?\\.jsonl$/.test(path.basename(name))
        ? metrics.journal : path.dirname(name) === frontiers && /^[0-9a-f]{64}\\.json$/.test(path.basename(name)) ? metrics.frontiers : null;
      if (group) group[path.basename(name)] = (group[path.basename(name)] ?? 0) + 1;
      return fd;
    };
    fs.closeSync = (fd) => {
      const target = descriptors.get(fd);
      descriptors.delete(fd);
      const result = originals.closeSync(fd);
      if (replacementBytes && target === replacement && metrics.replacements === 0) {
        const before = fs.statSync(replacement, { bigint: true });
        assert.equal(replacementBytes.length, Number(before.size), "the replacement must preserve the complete captured payload");
        const temporary = replacement + ".replacement";
        fs.writeFileSync(temporary, replacementBytes, { flag: "wx" });
        fs.utimesSync(temporary, before.atime, before.mtime);
        fs.renameSync(temporary, replacement);
        assert.notEqual(fs.statSync(replacement, { bigint: true }).ino, before.ino);
        metrics.replacements += 1;
      }
      return result;
    };
    fs.readSync = (fd, ...args) => {
      const count = originals.readSync(fd, ...args);
      if (replacement && count > 0 && descriptors.get(fd) === replacement && metrics.replacements === 0) {
        replacementBytes = Buffer.from(args[0].subarray(args[1], args[1] + count));
      }
      return count;
    };
    syncBuiltinESMExports();
    try {
      process.argv = [process.execPath, ${JSON.stringify(launcher)}, ${JSON.stringify(event)}];
      await import(${JSON.stringify(pathToFileURL(launcher).href)});
    } finally {
      Object.assign(fs, originals);
      syncBuiltinESMExports();
      process.stderr.write("SW_HOOK_MEASURE " + JSON.stringify(metrics) + "\\n");
    }
  `;
  const timeout = fixture.hookTimeoutMs(event);
  assert.equal(timeout, process.platform === "win32" ? 15_000 : 5_000);
  const started = performance.now();
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: fixture.cwd, input: JSON.stringify({ cwd: fixture.cwd, ...fixture.input, ...request }), encoding: "utf8", timeout,
  });
  const elapsedMs = performance.now() - started;
  assert.equal(child.error, undefined, JSON.stringify({ elapsedMs, timeout, error: child.error?.code }));
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.ok(elapsedMs < timeout, JSON.stringify({ elapsedMs, timeout }));
  const matched = /^SW_HOOK_MEASURE (.+)$/m.exec(child.stderr);
  assert.ok(matched, "the installed launcher instrumentation must actually run");
  return { output: JSON.parse(child.stdout), metrics: JSON.parse(matched[1]), elapsedMs, timeout };
}

for (const profile of ["reported", "dense-maximum", "record-dense-maximum"]) {
  test(`reliability: F2 ${profile} history fits the installed launcher budget with one capture and no per-tool frontier`, (t) =>
    withReliabilityFixture((fixture) => {
      fixture.tool("positive-before-history");
      const usage = profile === "reported" ? seedReportedHistory(fixture) : seedDenseMaximumHistory(fixture, profile === "dense-maximum");
      const selected = seedFrontiers(fixture, profile === "reported" ? 902 : 1013);
      const recovery = path.join(fixture.cwd, ".supervised-worker", "recovery");
      const head = fs.readFileSync(path.join(recovery, "head.json"));
      const runtimePath = path.join(fixture.cwd, ".supervised-worker", "runtime", `${sha256(fixture.input.session_id)}.json`);
      const runtime = fs.readFileSync(runtimePath);
      const current = `${sha256(fixture.input.session_id)}.jsonl`;
      const request = { tool_name: "read_file", tool_use_id: `F2-${profile}`, tool_input: { filePath: path.join(fixture.cwd, "README.md") } };
      const timings = {};
      for (const event of ["PreToolUse", "PostToolUse"]) {
        const measured = measuredHook(fixture, event, request);
        assert.notEqual(measured.output.permissionDecision, "deny", JSON.stringify(measured.output));
        assert.equal(measured.output.additionalContext, undefined, JSON.stringify(measured.output));
        assert.deepEqual(Object.keys(measured.metrics.frontiers), [`${selected.frontierHash}.json`], "no predecessor payload may be read");
        assert.ok(measured.metrics.frontiers[`${selected.frontierHash}.json`] > 0);
        assert.deepEqual(Object.keys(measured.metrics.journal).sort(), usage.files);
        for (const name of usage.files) assert.equal(measured.metrics.journal[name], name === current ? 2 : 1,
          `${name}: one cold capture, plus only the own published tail readback`);
        assert.deepEqual(fs.readFileSync(path.join(recovery, "head.json")), head);
        assert.deepEqual(fs.readFileSync(runtimePath), runtime);
        assert.equal(fs.readdirSync(path.join(recovery, "frontiers")).length, selected.frontier.sequence + 1);
        if (event === "PreToolUse") assert.match(fs.readFileSync(request.tool_input.filePath, "utf8"), /Benign/);
        timings[event] = measured.elapsedMs;
      }
      const stopped = measuredHook(fixture, "Stop");
      assert.equal(stopped.output.decision, "block", JSON.stringify(stopped.output));
      assert.equal(fs.readdirSync(path.join(recovery, "frontiers")).length, selected.frontier.sequence + 2);
      assert.deepEqual(new Set(Object.keys(stopped.metrics.frontiers)),
        new Set([`${selected.frontierHash}.json`, `${stopped.output.frontierHash}.json`]),
        "Stop publication checks current tips, not the predecessor chain or historical payloads for accounting");
      for (const name of usage.files) assert.equal(stopped.metrics.journal[name], name === current ? 2 : 1);
      timings.Stop = stopped.elapsedMs;
      const directRequest = { ...request, tool_use_id: `F2-direct-${profile}` };
      const directHead = fs.readFileSync(path.join(recovery, "head.json"));
      for (const event of ["PreToolUse", "PostToolUse"]) {
        const started = performance.now();
        const output = fixture.hook(event, directRequest);
        const elapsed = performance.now() - started;
        assert.ok(elapsed < fixture.hookTimeoutMs(event));
        if (event === "PreToolUse") {
          assert.notEqual(output.permissionDecision, "deny", JSON.stringify(output));
          assert.match(fs.readFileSync(directRequest.tool_input.filePath, "utf8"), /Benign/);
        } else assert.deepEqual(output, {});
        assert.deepEqual(fs.readFileSync(path.join(recovery, "head.json")), directHead);
        timings[`Direct${event}`] = elapsed;
      }
      for (const event of ["SessionStart", "PreCompact"]) {
        const started = performance.now();
        const output = fixture.hook(event, event === "PreCompact" ? { trigger: "manual" } : {});
        const elapsed = performance.now() - started;
        assert.ok(elapsed < fixture.hookTimeoutMs(event));
        if (event === "SessionStart") assert.match(output.additionalContext, /A durable Supervised Worker plan is active/);
        else assert.deepEqual(output, {});
        assert.deepEqual(fs.readFileSync(path.join(recovery, "head.json")), directHead);
        timings[`Direct${event}`] = elapsed;
      }
      t.diagnostic(JSON.stringify({ profile, frontierCount: selected.frontier.sequence + 1, journalBytes: usage.bytes,
        journalFiles: usage.files.length, recordCount: usage.recordCount ?? 22_900, timeoutMs: stopped.timeout, timings }));
    }));
}

test("reliability: F2 same-byte file replacement during capture denies without a second historical capture", () =>
  withReliabilityFixture((fixture) => {
    fixture.tool("positive-before-replacement");
    const current = path.join(fixture.cwd, ".supervised-worker", "runs", `${sha256(fixture.input.session_id)}.jsonl`);
    const before = fs.readFileSync(current);
    const measured = measuredHook(fixture, "PreToolUse", { tool_name: "read_file", tool_use_id: "replacement",
      tool_input: { filePath: path.join(fixture.cwd, "README.md") } }, current);
    assert.equal(measured.metrics.replacements, 1, `same-byte/different-inode fault must fire: ${JSON.stringify(measured)}`);
    assert.equal(measured.output.permissionDecision, "deny", JSON.stringify(measured.output));
    assert.equal(measured.metrics.journal[path.basename(current)], 1);
    assert.deepEqual(fs.readFileSync(current), before);
    fixture.tool("fresh-guard-after-replacement");
  }));

for (const field of ["dev", "ino"]) {
  test(`reliability: F2 a journal without usable ${field} identity cannot become cached authority`, () => withReliabilityFixture((fixture) => {
    fixture.tool(`positive-before-zero-${field}`);
    const before = journalUsage(fixture);
    const measured = measuredHook(fixture, "PreToolUse", { tool_name: "read_file", tool_use_id: `zero-${field}`,
      tool_input: { filePath: path.join(fixture.cwd, "README.md") } }, null, field);
    assert.ok(measured.metrics.missingIdentities > 1, "the journal path and descriptor identities must actually be unavailable");
    assert.equal(measured.output.permissionDecision, "deny", JSON.stringify(measured.output));
    assert.deepEqual(journalUsage(fixture), before);
  }));
}

test("reliability: F2 correlation is linear for completed and ambiguous invocation histories", () => {
  const measure = (count, ambiguous) => {
    let accesses = 0;
    const records = Array.from({ length: count }, (_, index) => operationPair(sha256("linear-history"), index))
      .flatMap((pair) => ambiguous ? [{ ...pair[0], invocationHash: null }] : pair)
      .map((record) => new Proxy(record, { get(target, key) { accesses += 1; return target[key]; } }));
    const index = new JournalOperationIndex(records);
    if (ambiguous) assert.throws(() => index.project(), (error) => failureFromError(error, "observation")?.code === "RECOVERY_OPERATION_LIMIT");
    else assert.equal(index.project().orphans.length, 0);
    assert.ok(accesses > count, "the field-access probe must observe correlation work");
    return accesses;
  };
  for (const ambiguous of [false, true]) {
    const first = measure(2_000, ambiguous);
    const second = measure(4_000, ambiguous);
    assert.ok(second <= first * 2.05, JSON.stringify({ ambiguous, first, second }));
  }
});

for (const binding of ["campaign", "sequence", "owner", "plan", "canonical-head"]) {
  test(`reliability: F2 owned hooks reject a changed ${binding} tip binding`, () => withReliabilityFixture((fixture) => {
    fixture.tool(`positive-before-${binding}`);
    const selected = readRecoveryTip(fixture.cwd);
    const root = path.join(fixture.cwd, ".supervised-worker", "recovery");
    const before = journalUsage(fixture);
    const value = { ...selected.frontier, sequence: selected.frontier.sequence + 1,
      previousHash: selected.frontierHash, cause: "tool-observation", transitionId: randomUUID() };
    if (binding === "campaign") value.campaignId = randomUUID();
    if (binding === "owner") value.owner = { ...value.owner, claimGeneration: randomUUID() };
    if (binding === "plan") value.planHash = sha256("different-plan");
    const bytes = serializeRecovery(value, "frontier");
    const frontierHash = sha256(bytes);
    fs.writeFileSync(path.join(root, "frontiers", `${frontierHash}.json`), bytes, { flag: "wx" });
    const head = serializeRecovery({ schemaVersion: 1, kind: "recovery-head", campaignId: value.campaignId,
      sequence: value.sequence + (binding === "sequence" ? 1 : 0), frontierHash }, "head");
    fs.writeFileSync(path.join(root, "head.json"), binding === "canonical-head" ? Buffer.concat([head, Buffer.from(" ")]) : head);
    assert.notEqual(frontierHash, selected.frontierHash, "the binding fault must reach a different exact tip");
    const output = fixture.hook("PreToolUse", { tool_name: "read_file", tool_use_id: `changed-${binding}`,
      tool_input: { filePath: path.join(fixture.cwd, "README.md") } });
    assert.equal(output.permissionDecision, "deny", JSON.stringify(output));
    assert.equal(output.supervisorFailure.code, "RECOVERY_LINEAGE_AMBIGUOUS");
    assert.deepEqual(journalUsage(fixture), before);
  }));
}

test("reliability: F2 the last journaled start survives process death, checkpoint and resume without a per-tool frontier", () =>
  withReliabilityFixture((fixture) => {
    fixture.tool("positive-before-death");
    const tip = readRecoveryTip(fixture.cwd);
    const target = path.join(fixture.cwd, "effect-once.txt");
    const request = { tool_name: "Write", tool_use_id: "crash-after-effect", tool_input: { file_path: target, content: "one effect\n" } };
    assert.notEqual(fixture.hook("PreToolUse", request).permissionDecision, "deny");
    const died = spawnSync(process.execPath, ["--eval", "require('node:fs').writeFileSync(process.argv[1], 'one effect\\n', {flag:'wx'});process.exit(23)", target],
      { cwd: fixture.cwd, encoding: "utf8", timeout: 5_000 });
    assert.equal(died.status, 23, "the effect process must actually exit before any PostToolUse");
    assert.equal(fs.readFileSync(target, "utf8"), "one effect\n");
    assert.equal(readRecoveryTip(fixture.cwd).frontierHash, tip.frontierHash);
    assert.deepEqual(readRecoveryTip(fixture.cwd).frontier.operations.orphans, []);
    const operations = fixture.operations();
    assert.equal(operations.orphans.length, 1);
    assert.equal(operations.orphans[0].invocationHash, sha256("supervised-worker-tool-invocation-v1\0crash-after-effect"));
    const checkpoint = fixture.native(["checkpoint"], { ...fixture.input, planHash: canonicalPlanHash(fixture.plan),
      attachmentHash: fixture.observe().attachmentHash });
    fixture.select("after-effect-death");
    const resumed = fixture.native(["resume"], { ...fixture.input, ...checkpoint.resume });
    assert.deepEqual(resumed.context.operations, operations);
    assert.equal(fs.readFileSync(target, "utf8"), "one effect\n");
  }));
