import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createLocalCampaignReceipt,
  inspectLocalCampaignReceiptFile,
  renderLocalCampaignReceiptMarkdown,
  serializeLocalCampaignReceipt,
  validateLocalCampaignReceipt,
} from "../src/campaign.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function temporaryWorkspace() {
  return mkdtempSync(path.join(os.tmpdir(), "supervised-worker-campaign-"));
}

function writeCampaignPlan(cwd, overrides = {}) {
  const state = path.join(cwd, ".supervised-worker");
  mkdirSync(state, { recursive: true });
  const plan = {
    schemaVersion: 1,
    mode: "active",
    goal: "SECRET GOAL",
    items: [{ id: "secret-item-id", title: "SECRET TITLE", status: "pending" }],
    completion: null,
    ...overrides,
  };
  writeFileSync(path.join(state, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

function createCampaignWorkspace() {
  const cwd = temporaryWorkspace();
  writeCampaignPlan(cwd);
  mkdirSync(path.join(cwd, ".supervised-worker", "runs"), { recursive: true });
  return cwd;
}

function ledgerRecord(session, event, at, detail = {}) {
  return { schemaVersion: 1, at, event, session, ...detail };
}

function writeLedger(cwd, session, content) {
  const runs = path.join(cwd, ".supervised-worker", "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(path.join(runs, `${session}.jsonl`), content);
}

function expectedLedgerHash(entries) {
  const hash = createHash("sha256");
  hash.update("supervised-worker-run-ledger-v1\0");
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(entries.length));
  hash.update(count);
  for (const [name, content] of entries.sort(([left], [right]) => left < right ? -1 : 1)) {
    const nameBytes = Buffer.from(name, "utf8");
    const contentBytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const nameLength = Buffer.alloc(8);
    const contentLength = Buffer.alloc(8);
    nameLength.writeBigUInt64BE(BigInt(nameBytes.length));
    contentLength.writeBigUInt64BE(BigInt(contentBytes.length));
    hash.update(nameLength);
    hash.update(nameBytes);
    hash.update(contentLength);
    hash.update(contentBytes);
  }
  return hash.digest("hex");
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map((entry) => reverseObjectKeys(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).reverse().map((key) => [key, reverseObjectKeys(value[key])]),
  );
}

test("local campaign receipt deterministically summarizes a valid plan and empty ledger", () => {
  const cwd = temporaryWorkspace();
  try {
    const state = path.join(cwd, ".supervised-worker");
    mkdirSync(path.join(state, "runs"), { recursive: true });
    writeFileSync(
      path.join(state, "plan.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        mode: "active",
        goal: "SECRET GOAL",
        items: [{
          id: "secret-item-id",
          title: "SECRET TITLE",
          status: "pending",
        }],
        completion: null,
      }, null, 2)}\n`,
    );

    const first = createLocalCampaignReceipt(cwd, root);
    const second = createLocalCampaignReceipt(cwd, root);
    assert.deepEqual(validateLocalCampaignReceipt(first), []);
    assert.equal(first.localDataStatus, "available");
    assert.equal(first.plan.counts.pending, 1);
    assert.equal(first.runLedger.sessionCount, 0);
    assert.equal(first.runLedger.recordCount, 0);
    assert.deepEqual(first.runLedger.eventCounts, []);
    assert.equal(first.runLedger.hash, expectedLedgerHash([]));
    assert.equal(
      first.plan.items[0].itemHash,
      createHash("sha256")
        .update(Buffer.from("supervised-worker-item-v1\0secret-item-id", "utf8"))
        .digest("hex"),
    );
    assert.equal(serializeLocalCampaignReceipt(first), serializeLocalCampaignReceipt(second));
    assert.equal(
      renderLocalCampaignReceiptMarkdown(first),
      renderLocalCampaignReceiptMarkdown(second),
    );
    const exported = serializeLocalCampaignReceipt(first);
    assert.doesNotMatch(exported, /SECRET|secret-item-id/);
    assert.match(
      renderLocalCampaignReceiptMarkdown(first),
      /Local-only, not Provider-Verified Completion/,
    );
    assert.match(
      renderLocalCampaignReceiptMarkdown(first),
      /First observed at: `null`/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("ledger summary accepts only emitted variants and excludes record details", () => {
  const cwd = createCampaignWorkspace();
  const session = "d".repeat(64);
  try {
    writeCampaignPlan(cwd, {
      mode: "complete",
      items: [{
        id: "secret-item-id",
        title: "SECRET TITLE",
        status: "banked",
        resumeWhen: "SECRET RESUME CONDITION",
      }],
      completion: {
        enumeration: {
          status: "complete",
          source: "SECRET PROVIDER ENUMERATION",
          checkedAt: "2026-09-04T11:00:00Z",
          remainingActionable: 0,
        },
        evidence: [{ kind: "SECRET EVIDENCE KIND", locator: "SECRET EVIDENCE LOCATOR" }],
      },
    });
    const records = [
      ledgerRecord(session, "plan_inactive", "2026-09-04T12:00:00Z"),
      ledgerRecord(session, "completion_verified", "2026-09-04T12:01:00Z", {
        planHash: "1".repeat(64),
      }),
      ledgerRecord(session, "completion_unverified_release", "2026-09-04T12:02:00Z", {
        progressHash: "2".repeat(64),
        reason: "bounded_stop_limit",
      }),
      ledgerRecord(session, "stop_blocked", "2026-09-04T12:03:00Z", {
        progressHash: "3".repeat(64),
        sameProgressBlocks: 1,
        totalBlocks: 2,
      }),
      ledgerRecord(session, "tool_completed", "2026-09-04T12:04:00Z", {
        toolName: "SECRET_TOOL_NAME",
        success: true,
      }),
      ledgerRecord(session, "pre_compact", "2026-09-04T12:05:00Z", {
        trigger: "SECRET_TRANSCRIPT_TRIGGER",
      }),
      ledgerRecord(session, "provisional_claim_released", "2026-09-04T12:06:00Z"),
      ledgerRecord(session, "ownership_cleanup_failed", "2026-09-04T12:07:00Z", {
        attemptedEvent: "SECRET_ATTEMPT_DETAIL",
      }),
    ];
    const ledgerContent = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    writeLedger(cwd, session, ledgerContent);

    const receipt = createLocalCampaignReceipt(cwd, root);
    assert.deepEqual(validateLocalCampaignReceipt(receipt), []);
    assert.equal(receipt.runLedger.recordCount, 8);
    assert.equal(receipt.runLedger.sessionCount, 1);
    assert.equal(receipt.plan.localCompletionShape, true);
    assert.equal(
      receipt.runLedger.hash,
      expectedLedgerHash([[`${session}.jsonl`, ledgerContent]]),
    );
    assert.deepEqual(
      receipt.runLedger.eventCounts.map(({ event }) => event),
      [
        "completion_unverified_release",
        "completion_verified",
        "ownership_cleanup_failed",
        "plan_inactive",
        "pre_compact",
        "provisional_claim_released",
        "stop_blocked",
        "tool_completed",
      ],
    );
    assert.equal(receipt.runLedger.firstObservedAt, "2026-09-04T12:00:00.000Z");
    assert.equal(receipt.runLedger.lastObservedAt, "2026-09-04T12:07:00.000Z");
    const json = serializeLocalCampaignReceipt(receipt);
    const markdown = renderLocalCampaignReceiptMarkdown(receipt);
    for (const secret of [
      "SECRET GOAL",
      "SECRET TITLE",
      "SECRET RESUME CONDITION",
      "SECRET PROVIDER ENUMERATION",
      "SECRET EVIDENCE KIND",
      "SECRET EVIDENCE LOCATOR",
      "secret-item-id",
      "SECRET_TOOL_NAME",
      "SECRET_TRANSCRIPT_TRIGGER",
      "SECRET_ATTEMPT_DETAIL",
      session,
    ]) {
      assert.doesNotMatch(json, new RegExp(secret));
      assert.doesNotMatch(markdown, new RegExp(secret));
    }
    for (const value of [
      receipt.plugin.sourceHash,
      receipt.plan.hash,
      receipt.runLedger.hash,
      ...receipt.runLedger.eventCounts.map(({ event }) => event),
      ...Object.values(receipt.providerFacts).map(({ reason }) => reason),
    ]) {
      assert.match(markdown, new RegExp(value));
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("absent and invalid local sources produce partial receipts with null metrics", () => {
  const absent = temporaryWorkspace();
  const invalid = temporaryWorkspace();
  try {
    const absentReceipt = createLocalCampaignReceipt(absent, root);
    assert.equal(absentReceipt.localDataStatus, "partial");
    assert.equal(absentReceipt.plan.reason, "plan-absent");
    assert.equal(absentReceipt.plan.counts, null);
    assert.equal(absentReceipt.runLedger.reason, "run-ledger-absent");
    assert.equal(absentReceipt.runLedger.recordCount, null);

    const state = path.join(invalid, ".supervised-worker");
    mkdirSync(path.join(state, "runs"), { recursive: true });
    writeFileSync(path.join(state, "plan.json"), "{\"goal\":\"secret\",\"goal\":\"other\"}\n");
    const invalidReceipt = createLocalCampaignReceipt(invalid, root);
    assert.equal(invalidReceipt.localDataStatus, "partial");
    assert.equal(invalidReceipt.plan.reason, "plan-invalid");
    assert.equal(invalidReceipt.plan.hash, null);
    assert.equal(invalidReceipt.plan.items, null);
    assert.equal(invalidReceipt.runLedger.status, "available");
    assert.equal(invalidReceipt.runLedger.recordCount, 0);
  } finally {
    rmSync(absent, { recursive: true, force: true });
    rmSync(invalid, { recursive: true, force: true });
  }
});

test("malformed, truncated, duplicate, and unknown ledger records expose no false zeros", () => {
  const session = "e".repeat(64);
  const valid = ledgerRecord(session, "plan_inactive", "2026-09-04T12:00:00Z");
  const duplicateKey =
    `{"schemaVersion":1,"at":"2026-09-04T12:00:00Z","event":"plan_inactive","event":"plan_inactive","session":"${session}"}\n`;
  const cases = [
    ["truncated", JSON.stringify(valid)],
    ["malformed", "{not-json}\n"],
    ["duplicate key", duplicateKey],
    ["duplicate canonical record", `${JSON.stringify(valid)}\n${JSON.stringify(valid)}\n`],
    ["unknown event", `${JSON.stringify({ ...valid, event: "unknown" })}\n`],
    ["unknown field", `${JSON.stringify({ ...valid, detail: "SECRET" })}\n`],
    ["empty file", ""],
    ["invalid UTF-8", Buffer.from([0xff, 0x0a])],
  ];
  for (const [name, content] of cases) {
    const cwd = createCampaignWorkspace();
    try {
      writeLedger(cwd, session, content);
      const receipt = createLocalCampaignReceipt(cwd, root);
      assert.equal(receipt.localDataStatus, "partial", name);
      assert.equal(receipt.runLedger.reason, "run-ledger-invalid", name);
      assert.equal(receipt.runLedger.hash, null, name);
      assert.equal(receipt.runLedger.sessionCount, null, name);
      assert.equal(receipt.runLedger.recordCount, null, name);
      assert.equal(receipt.runLedger.eventCounts, null, name);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("ledger limits and filename-session mismatches fail closed", () => {
  const session = "f".repeat(64);
  for (const [name, content] of [
    [
      "oversized record",
      `${JSON.stringify(ledgerRecord(session, "tool_completed", "2026-09-04T12:00:00Z", {
        toolName: "x".repeat(17_000),
        success: true,
      }))}\n`,
    ],
    [
      "session mismatch",
      `${JSON.stringify(ledgerRecord("a".repeat(64), "plan_inactive", "2026-09-04T12:00:00Z"))}\n`,
    ],
  ]) {
    const cwd = createCampaignWorkspace();
    try {
      writeLedger(cwd, session, content);
      const ledger = createLocalCampaignReceipt(cwd, root).runLedger;
      assert.equal(
        ledger.reason,
        name === "oversized record" ? "run-ledger-limit-exceeded" : "run-ledger-invalid",
      );
      assert.equal(ledger.recordCount, null);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  const cwd = createCampaignWorkspace();
  try {
    writeFileSync(path.join(cwd, ".supervised-worker", "runs", "unexpected.txt"), "SECRET\n");
    const ledger = createLocalCampaignReceipt(cwd, root).runLedger;
    assert.equal(ledger.reason, "run-ledger-invalid");
    assert.equal(ledger.recordCount, null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("canonical serialization ignores object insertion order and provider claims stay fixed", () => {
  const example = JSON.parse(
    readFileSync(path.join(root, "examples", "local-campaign-receipt.json"), "utf8"),
  );
  const reversed = reverseObjectKeys(example);
  assert.deepEqual(validateLocalCampaignReceipt(example), []);
  assert.deepEqual(validateLocalCampaignReceipt(reversed), []);
  assert.equal(serializeLocalCampaignReceipt(example), serializeLocalCampaignReceipt(reversed));

  for (const mutate of [
    (value) => { value.providerFacts.ci.status = "verified"; },
    (value) => { value.providerFacts.ci.value = "success"; },
    (value) => { value.providerFacts.ci.reason = "provider said success"; },
    (value) => { value.localDataStatus = "partial"; },
    (value) => { value.plan.items.reverse(); },
    (value) => { value.runLedger.eventCounts[0].count += 1; },
  ]) {
    const candidate = structuredClone(example);
    mutate(candidate);
    assert.notDeepEqual(validateLocalCampaignReceipt(candidate), []);
    assert.throws(() => serializeLocalCampaignReceipt(candidate), /invalid/);
    assert.throws(() => renderLocalCampaignReceiptMarkdown(candidate), /invalid/);
  }
});

test("published string fields reject coercible non-string values", () => {
  const example = JSON.parse(
    readFileSync(path.join(root, "examples", "local-campaign-receipt.json"), "utf8"),
  );
  assert.deepEqual(validateLocalCampaignReceipt(example), []);
  for (const [field, mutate] of [
    ["plugin.version", (value) => { value.plugin.version = [value.plugin.version]; }],
    ["plugin.sourceHash", (value) => { value.plugin.sourceHash = [value.plugin.sourceHash]; }],
    ["plan.hash", (value) => { value.plan.hash = [value.plan.hash]; }],
    ["plan.items[0].itemHash", (value) => {
      value.plan.items[0].itemHash = [value.plan.items[0].itemHash];
    }],
    ["runLedger.hash", (value) => { value.runLedger.hash = [value.runLedger.hash]; }],
  ]) {
    const candidate = structuredClone(example);
    mutate(candidate);
    assert.notDeepEqual(validateLocalCampaignReceipt(candidate), [], field);
    assert.throws(() => serializeLocalCampaignReceipt(candidate), /invalid/, field);
    assert.throws(() => renderLocalCampaignReceiptMarkdown(candidate), /invalid/, field);
  }
});

test("saved receipt validation reconciles exact current state and rejects staleness", () => {
  const cwd = createCampaignWorkspace();
  try {
    const receiptPath = path.join(cwd, "receipt.json");
    const receipt = createLocalCampaignReceipt(cwd, root);
    const serialized = serializeLocalCampaignReceipt(receipt);
    writeFileSync(receiptPath, serialized);

    const valid = inspectLocalCampaignReceiptFile(cwd, "receipt.json", root);
    assert.deepEqual(Object.keys(valid), ["ok", "receiptHash", "matchesCurrentWorkspace", "errors"]);
    assert.equal(valid.ok, true);
    assert.equal(valid.matchesCurrentWorkspace, true);
    const compactCanonical = JSON.stringify(JSON.parse(serialized));
    assert.equal(
      valid.receiptHash,
      createHash("sha256").update(compactCanonical).digest("hex"),
    );

    writeCampaignPlan(cwd, {
      items: [{ id: "secret-item-id", title: "SECRET TITLE", status: "banked" }],
    });
    const stale = inspectLocalCampaignReceiptFile(cwd, "receipt.json", root);
    assert.equal(stale.ok, false);
    assert.equal(stale.matchesCurrentWorkspace, false);
    assert.match(stale.errors.join("\n"), /does not match current workspace/);
    assert.doesNotMatch(JSON.stringify(stale), /secret-item-id|SECRET TITLE/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("saved receipt inspection rejects outside, multiply-linked, and duplicate-key inputs generically", () => {
  const cwd = createCampaignWorkspace();
  const outside = temporaryWorkspace();
  try {
    const receipt = serializeLocalCampaignReceipt(createLocalCampaignReceipt(cwd, root));
    const receiptPath = path.join(cwd, "TOPSECRET-receipt.json");
    writeFileSync(receiptPath, receipt);
    const linkedPath = path.join(cwd, "linked-receipt.json");
    linkSync(receiptPath, linkedPath);
    const linked = inspectLocalCampaignReceiptFile(cwd, linkedPath, root);
    assert.equal(linked.ok, false);
    assert.equal(linked.receiptHash, null);
    assert.doesNotMatch(JSON.stringify(linked), /TOPSECRET|linked-receipt/);

    const outsidePath = path.join(outside, "outside-secret.json");
    writeFileSync(outsidePath, receipt);
    const escaped = inspectLocalCampaignReceiptFile(cwd, outsidePath, root);
    assert.equal(escaped.ok, false);
    assert.doesNotMatch(JSON.stringify(escaped), /outside-secret/);

    rmSync(linkedPath);
    writeFileSync(receiptPath, "{\"schemaVersion\":1,\"schemaVersion\":1}\n");
    const duplicate = inspectLocalCampaignReceiptFile(cwd, receiptPath, root);
    assert.equal(duplicate.ok, false);
    assert.deepEqual(duplicate.errors, ["Receipt could not be inspected safely."]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("matching partial receipts remain non-authoritative", () => {
  const cwd = temporaryWorkspace();
  try {
    mkdirSync(path.join(cwd, ".supervised-worker", "runs"), { recursive: true });
    const receipt = createLocalCampaignReceipt(cwd, root);
    const receiptPath = path.join(cwd, "partial.json");
    writeFileSync(receiptPath, serializeLocalCampaignReceipt(receipt));
    const report = inspectLocalCampaignReceiptFile(cwd, receiptPath, root);
    assert.equal(report.ok, false);
    assert.equal(report.matchesCurrentWorkspace, true);
    assert.match(report.errors.join("\n"), /partial/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cross-file ledger changes invalidate the full snapshot", () => {
  const cwd = createCampaignWorkspace();
  const firstSession = "a".repeat(64);
  const secondSession = "b".repeat(64);
  const firstPath = path.join(cwd, ".supervised-worker", "runs", `${firstSession}.jsonl`);
  const secondPath = path.join(cwd, ".supervised-worker", "runs", `${secondSession}.jsonl`);
  const fs = require("node:fs");
  const originalOpenSync = fs.openSync;
  let injected = false;
  try {
    writeFileSync(
      firstPath,
      `${JSON.stringify(ledgerRecord(firstSession, "plan_inactive", "2026-09-04T12:00:00Z"))}\n`,
    );
    writeFileSync(
      secondPath,
      `${JSON.stringify(ledgerRecord(secondSession, "plan_inactive", "2026-09-04T12:01:00Z"))}\n`,
    );
    fs.openSync = (filePath, ...args) => {
      if (!injected && path.resolve(String(filePath)) === path.resolve(secondPath)) {
        injected = true;
        appendFileSync(
          firstPath,
          `${JSON.stringify(ledgerRecord(firstSession, "plan_inactive", "2026-09-04T12:02:00Z"))}\n`,
        );
      }
      return originalOpenSync(filePath, ...args);
    };
    syncBuiltinESMExports();

    const receipt = createLocalCampaignReceipt(cwd, root);
    assert.equal(injected, true);
    assert.equal(receipt.localDataStatus, "partial");
    assert.equal(receipt.runLedger.reason, "run-ledger-changed-during-read");
    assert.equal(receipt.runLedger.hash, null);
    assert.equal(receipt.runLedger.recordCount, null);
  } finally {
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
    rmSync(cwd, { recursive: true, force: true });
  }
});