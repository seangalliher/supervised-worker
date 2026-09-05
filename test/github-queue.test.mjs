import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectGitHubQueue, validateGitHubQueueObservation } from "../src/github-queue.mjs";

const INPUT = { repository: "Example/Queue", state: "all" };
const WALL = Date.parse("2026-09-04T12:00:00.000Z");
const QUERY = `query QueueInspection($owner: String!, $name: String!, $states: [IssueState!]!, $cursor: String) {
  viewer { id }
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    issues(first: 100, after: $cursor, states: $states, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      nodes { id number state updatedAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

function issue(number, state = "OPEN") {
  return { id: `issue:${number}`, number, state, updatedAt: "2026-09-04T11:59:00Z" };
}

function page(nodes = [], { totalCount = nodes.length, hasNextPage = false, endCursor = nodes.length ? `cursor:${nodes.at(-1).number}` : null } = {}) {
  return {
    data: {
      viewer: { id: "viewer:1" },
      repository: { id: "repository:1", nameWithOwner: "Example/Queue", issues: { totalCount, nodes, pageInfo: { hasNextPage, endCursor } } },
    },
  };
}

function result(value) {
  return { status: 0, signal: null, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0) };
}

function inspectResponses(responses, { input = INPUT, clock } = {}) {
  const calls = [];
  let wallCalls = 0;
  const observation = inspectGitHubQueue(input, {
    clock: clock ?? { wall: () => WALL + wallCalls++, monotonic: () => 0 },
    transport: (request) => {
      calls.push(structuredClone(request));
      assert.ok(calls.length <= responses.length, "the requested page has a deterministic fixture");
      const response = responses[calls.length - 1];
      return typeof response === "function" ? response(request) : response;
    },
  });
  assert.deepEqual(validateGitHubQueueObservation(observation), []);
  return { observation, calls };
}

function inspect(pages, input = INPUT) {
  return inspectResponses(pages.map(result), { input });
}

function unavailable(observation, reason) {
  assert.equal(observation.status, "unavailable");
  assert.equal(observation.reason, reason);
  for (const key of ["actor", "repository", "totalCount", "pageCount", "issues"]) assert.equal(observation[key], null, key);
  assert.deepEqual(validateGitHubQueueObservation(observation), []);
}

for (const [state, states] of [["open", ["OPEN"]], ["closed", ["CLOSED"]], ["all", ["OPEN", "CLOSED"]]]) {
  test(`inspect ${state} authenticates, fixes the query and variables, and sorts metadata`, () => {
    const { observation, calls } = inspect([page([issue(3, states[0]), issue(1, states.at(-1))])], { ...INPUT, state });
    assert.equal(observation.status, "complete");
    assert.deepEqual(calls, [{ query: QUERY, variables: { owner: "Example", name: "Queue", states, cursor: null }, timeout: 10_000 }]);
    assert.deepEqual(observation.issues.map((entry) => entry.number), [1, 3]);
    assert.equal(observation.startedAt, "2026-09-04T12:00:00.000Z");
    assert.equal(observation.finishedAt, "2026-09-04T12:00:00.001Z");
    assert.equal(observation.consistency, "interval-observation");
    assert.equal(observation.integrity, "unattested");
    assert.equal(observation.reason, null);
    assert.deepEqual(Object.keys(observation.issues[0]), ["id", "number", "state", "updatedAt"]);
  });
}

test("empty success requires one authenticated terminal page", () => {
  const { observation, calls } = inspect([page()]);
  assert.equal(calls.length, 1);
  assert.equal(observation.status, "complete");
  assert.deepEqual(observation.actor, { id: "viewer:1" });
  assert.deepEqual(observation.repository, { id: "repository:1", nameWithOwner: "Example/Queue" });
  assert.equal(observation.totalCount, 0);
  assert.equal(observation.pageCount, 1);
  assert.deepEqual(observation.issues, []);
});

test("multiple pages preserve opaque cursors without ordering or base64 assumptions", () => {
  const first = page([issue(3)], { totalCount: 2, hasNextPage: true, endCursor: "z:cursor /+? =" });
  const second = page([issue(1, "CLOSED")], { totalCount: 2, endCursor: "a:cursor" });
  const { observation, calls } = inspect([first, second], { ...INPUT, repository: "eXAMPLE/qUEUE" });
  assert.equal(observation.status, "complete");
  assert.equal(observation.pageCount, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].variables.cursor, "z:cursor /+? =");
  assert.deepEqual(observation.issues, [issue(1, "CLOSED"), issue(3)]);
});

test("invalid input cannot reach transport or disclose rejected values", () => {
  let calls = 0;
  for (const input of [
    undefined, null, [], {}, { ...INPUT, extra: "PRIVATE_INPUT" },
    ...["", "owner", "https://github.com/owner/repo", "../repo", "owner/..", "owner/.", "owner/repo/extra",
      " owner/repo", "owner/repo ", "owner/repo\n", "owner\\repo", "owner/repo;PRIVATE_INPUT", "-owner/repo",
      "owner-/repo", `owner/${"r".repeat(101)}`, `${"o".repeat(40)}/repo`].map((repository) => ({ ...INPUT, repository })),
    ...[undefined, null, "", "OPEN", "--all", "constructor", "all\n"].map((state) => ({ ...INPUT, state })),
  ]) {
    const observation = inspectGitHubQueue(input, { transport: () => { calls += 1; throw new Error("PRIVATE_INPUT"); } });
    unavailable(observation, "invalid-input");
    assert.equal(observation.scope, null);
    assert.doesNotMatch(JSON.stringify(observation), /PRIVATE_INPUT/);
  }
  assert.equal(calls, 0);
});

test("second-page failures discard the validated first page", () => {
  const first = page([issue(1)], { totalCount: 2, hasNextPage: true });
  const second = page([issue(2)], { totalCount: 2 });
  assert.equal(inspect([first, second]).observation.status, "complete");
  for (const [reason, change] of [
    ["authentication-unavailable", (value) => { value.data.viewer = null; }],
    ["identity-invalid", (value) => { value.data.viewer.id = "viewer:other"; }],
    ["identity-invalid", (value) => { value.data.repository.id = "repository:other"; }],
    ["identity-invalid", (value) => { value.data.repository.nameWithOwner = "Another/Queue"; }],
    ["pagination-invalid", (value) => { value.data.repository.issues.totalCount = 3; }],
    ["pagination-invalid", (value) => { value.data.repository.issues.nodes[0].id = "issue:1"; }],
    ["pagination-invalid", (value) => { value.data.repository.issues.nodes[0].number = 1; }],
    ["pagination-invalid", (value) => { value.data.repository.issues.pageInfo.endCursor = "cursor:1"; }],
    ["response-invalid", (value) => { value.data.repository.issues.nodes[0].state = "MERGED"; }],
    ["provider-error", (value) => { value.errors = [{ message: "PRIVATE_PROVIDER_ERROR" }]; }],
  ]) {
    const mutated = structuredClone(second);
    change(mutated);
    const { observation, calls } = inspect([first, mutated]);
    assert.equal(calls.length, 2, reason);
    unavailable(observation, reason);
    assert.doesNotMatch(JSON.stringify(observation), /PRIVATE_PROVIDER_ERROR|viewer:1|issue:1/);
  }
});

test("validator rejects versions, unknown metadata, authority claims, and partial unavailable data", () => {
  const good = inspect([page([issue(1)])]).observation;
  assert.deepEqual(validateGitHubQueueObservation(good), []);
  for (const change of [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.kind = "local-campaign-receipt"; },
    (value) => { value.title = "PRIVATE_TITLE"; },
    (value) => { value.integrity = "signed"; },
    (value) => { value.consistency = "atomic"; },
    (value) => { value.reason = "none"; },
    (value) => { value.actor.login = "PRIVATE_LOGIN"; },
    (value) => { value.repository.url = "https://github.com/Example/Queue"; },
    (value) => { value.scope.host = "example.com"; },
    (value) => { value.startedAt = "2026-02-30T00:00:00Z"; },
    (value) => { value.finishedAt = "2026-09-03T00:00:00Z"; },
    (value) => { value.totalCount = 2; },
    (value) => { value.pageCount = 0; },
    (value) => { value.issues[0].body = "PRIVATE_BODY"; },
    (value) => { value.status = "unavailable"; value.reason = "transport-failed"; },
  ]) {
    const invalid = structuredClone(good);
    change(invalid);
    const errors = validateGitHubQueueObservation(invalid);
    assert.ok(errors.length > 0);
    assert.ok(errors.every((error) => /^[a-z-]+-invalid$/.test(error)));
    assert.doesNotMatch(JSON.stringify(errors), /PRIVATE_/);
  }
});

test("provider names match case-insensitively without relaxing immutable identity", () => {
  const first = page([issue(1)], { totalCount: 2, hasNextPage: true });
  const second = page([issue(2)], { totalCount: 2 });
  second.data.repository.nameWithOwner = "example/QUEUE";
  const observed = inspect([first, second]);
  assert.equal(observed.calls.length, 2);
  assert.equal(observed.observation.status, "complete");
  assert.equal(observed.observation.repository.nameWithOwner, "Example/Queue");
  second.data.viewer.id = "VIEWER:1";
  const changed = inspect([first, second]);
  assert.equal(changed.calls.length, 2);
  unavailable(changed.observation, "identity-invalid");
});

test("transport failures use only typed process facts and discard all raw output", () => {
  const good = result(page([issue(1)]));
  assert.equal(inspectResponses([good]).observation.status, "complete");
  for (const [reason, response] of [
    ...["ENOENT", "EACCES", "EPERM", "ENOEXEC"].map((code) => ["gh-unavailable", { ...good, error: { code, message: "PRIVATE_ERROR" } }]),
    ["timeout", { ...good, error: { code: "ETIMEDOUT", message: "PRIVATE_ERROR" }, signal: "SIGKILL" }],
    ["limit-exceeded", { ...good, error: { code: "ENOBUFS", message: "PRIVATE_ERROR" } }],
    ["transport-failed", { ...good, error: { code: "EIO", message: "authentication PRIVATE_ERROR" } }],
    ["authentication-unavailable", { ...good, status: 4, stdout: Buffer.alloc(0), stderr: Buffer.from("PRIVATE_CREDENTIAL") }],
    ["transport-failed", { ...good, status: 1, stderr: Buffer.from("authentication PRIVATE_CREDENTIAL") }],
    ["transport-failed", { ...good, status: 2 }],
    ["transport-failed", { ...good, status: null, signal: "SIGTERM" }],
    ["transport-failed", { ...good, status: null }],
    ["transport-failed", { ...good, stdout: "PRIVATE_RAW_TEXT" }],
    ["transport-failed", { ...good, stderr: "PRIVATE_RAW_TEXT" }],
    ["transport-failed", undefined],
    ["transport-failed", () => { throw new Error("authentication PRIVATE_CREDENTIAL"); }],
  ]) {
    const observed = inspectResponses([response]);
    assert.equal(observed.calls.length, 1, reason);
    unavailable(observed.observation, reason);
    assert.doesNotMatch(JSON.stringify(observed.observation), /PRIVATE_|authentication PRIVATE/);
  }
});

test("strict JSON parsing rejects malformed, duplicate, escaped duplicate, and non-UTF8 responses", () => {
  const good = result(page([issue(1)]));
  assert.equal(inspectResponses([good]).observation.status, "complete");
  const text = good.stdout.toString("utf8");
  assert.ok(text.includes('"id":"viewer:1"'));
  for (const stdout of [
    Buffer.alloc(0), Buffer.from("{PRIVATE_RAW"), Buffer.from("null"), Buffer.from("[]"),
    Buffer.from(`${text} PRIVATE_RAW`),
    Buffer.from(text.replace('"id":"viewer:1"', '"id":"viewer:1","id":"PRIVATE_DUPLICATE"')),
    Buffer.from(text.replace('"id":"viewer:1"', '"id":"viewer:1","i\\u0064":"PRIVATE_DUPLICATE"')),
    Buffer.concat([good.stdout, Buffer.from([0xff])]),
    Buffer.from(text.replace("viewer:1", "\\ud800")),
  ]) {
    const observed = inspectResponses([{ ...good, stdout }]);
    assert.equal(observed.calls.length, 1);
    unavailable(observed.observation, stdout.toString().includes("\\ud800") ? "identity-invalid" : "response-invalid");
    assert.doesNotMatch(JSON.stringify(observed.observation), /PRIVATE_/);
  }
});

test("GraphQL error responses, including exit-one partial data, never become observations", () => {
  const good = page([issue(1)]);
  assert.equal(inspect([good]).observation.status, "complete");
  for (const status of [0, 1]) {
    for (const data of [undefined, null, good.data]) {
      const payload = { errors: [{ message: "PRIVATE_ERROR", type: "FORBIDDEN", path: ["repository", 0], locations: [{ line: 1, column: 1 }], extensions: { code: "PRIVATE_DETAIL" } }] };
      if (data !== undefined) payload.data = data;
      const observed = inspectResponses([{ ...result(payload), status }]);
      assert.equal(observed.calls.length, 1);
      unavailable(observed.observation, "provider-error");
      assert.doesNotMatch(JSON.stringify(observed.observation), /PRIVATE_/);
    }
  }
  for (const errors of [null, [], {}, [null], [{ message: 1 }], [{ message: "" }],
    [{ message: "PRIVATE_ERROR", extra: true }], [{ message: "PRIVATE_ERROR", type: 3 }],
    [{ message: "PRIVATE_ERROR", path: [-1] }], [{ message: "PRIVATE_ERROR", locations: [{ line: 0, column: 1 }] }],
    [{ message: "PRIVATE_ERROR", extensions: [] }]]) {
    const observed = inspect([{ ...good, errors }]);
    assert.equal(observed.calls.length, 1);
    unavailable(observed.observation, "response-invalid");
  }
});

test("response shapes and field types are strict at every selected boundary", () => {
  const good = page([issue(1)]);
  assert.equal(inspect([good]).observation.status, "complete");
  for (const [reason, change] of [
    ["response-invalid", (value) => { value.extra = true; }],
    ["response-invalid", (value) => { value.data.extra = true; }],
    ["response-invalid", (value) => { value.data = null; }],
    ["response-invalid", (value) => { delete value.data.viewer; }],
    ["identity-invalid", (value) => { value.data.viewer.extra = true; }],
    ["identity-invalid", (value) => { value.data.viewer.id = " "; }],
    ["identity-invalid", (value) => { value.data.repository = null; }],
    ["identity-invalid", (value) => { value.data.repository.extra = true; }],
    ["identity-invalid", (value) => { value.data.repository.id = 1; }],
    ["identity-invalid", (value) => { value.data.repository.nameWithOwner = "Example/Queue\n"; }],
    ["response-invalid", (value) => { value.data.repository.issues.extra = true; }],
    ["response-invalid", (value) => { value.data.repository.issues.nodes = null; }],
    ["response-invalid", (value) => { value.data.repository.issues.nodes[0].extra = "PRIVATE_TITLE"; }],
    ["response-invalid", (value) => { value.data.repository.issues.pageInfo.extra = true; }],
    ["response-invalid", (value) => { value.data.repository.issues.pageInfo.hasNextPage = "false"; }],
    ["response-invalid", (value) => { delete value.data.repository.issues.pageInfo.endCursor; }],
  ]) {
    const invalid = structuredClone(good);
    change(invalid);
    const observed = inspect([invalid]);
    assert.equal(observed.calls.length, 1, reason);
    unavailable(observed.observation, reason);
  }
  for (const totalCount of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    const observed = inspect([page([issue(1)], { totalCount })]);
    assert.equal(observed.calls.length, 1);
    unavailable(observed.observation, "response-invalid");
  }
  for (const number of [-1, 0, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    const observed = inspect([page([{ ...issue(1), number }])]);
    assert.equal(observed.calls.length, 1);
    unavailable(observed.observation, "response-invalid");
  }
  for (const state of ["open", "MERGED", null]) {
    const observed = inspect([page([issue(1, state)])]);
    assert.equal(observed.calls.length, 1);
    unavailable(observed.observation, "response-invalid");
  }
  for (const [state, wrongState] of [["open", "CLOSED"], ["closed", "OPEN"]]) {
    assert.equal(inspect([page([issue(1, state.toUpperCase())])], { ...INPUT, state }).observation.status, "complete");
    const observed = inspect([page([issue(1, wrongState)])], { ...INPUT, state });
    assert.equal(observed.calls.length, 1);
    unavailable(observed.observation, "response-invalid");
  }
});

test("valid timestamp calendars and safe issue numbers do not inherit narrower provider assumptions", () => {
  for (const updatedAt of ["2024-02-29T23:59:59Z", "2026-09-04t12:00:00z", "2026-09-04T12:00:00.123456789+01:30"]) {
    const observed = inspect([page([{ ...issue(Number.MAX_SAFE_INTEGER), updatedAt }])]);
    assert.equal(observed.calls.length, 1);
    assert.equal(observed.observation.status, "complete");
  }
  for (const updatedAt of [null, 0, "", "2026-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-04-31T00:00:00Z",
    "0000-01-01T00:00:00Z", "2026-09-04T24:00:00Z", "2026-09-04T12:60:00Z", "2026-09-04T12:00:61Z",
    "2026-09-04T12:00:00+24:00", "2026-09-04T12:00:00+00:60", "2026-09-04T12:00:00", "2026-09-04T12:00:00Z\n"]) {
    const observed = inspect([page([{ ...issue(1), updatedAt }])]);
    assert.equal(observed.calls.length, 1);
    unavailable(observed.observation, "response-invalid");
  }
});

test("opaque ID and cursor limits are character bounds, not invented encoding grammars", () => {
  const good = page([issue(1)], { endCursor: "?+/=: ".repeat(682) + "abcd" });
  assert.equal(good.data.repository.issues.pageInfo.endCursor.length, 4096);
  good.data.viewer.id = "a".repeat(512);
  good.data.repository.id = "b".repeat(512);
  good.data.repository.issues.nodes[0].id = String.fromCodePoint(0x1f700).repeat(512);
  assert.equal(inspect([good]).observation.status, "complete");
  for (const [reason, change] of [
    ["identity-invalid", (value) => { value.data.viewer.id += "a"; }],
    ["identity-invalid", (value) => { value.data.repository.id += "b"; }],
    ["response-invalid", (value) => { value.data.repository.issues.nodes[0].id += "c"; }],
    ["pagination-invalid", (value) => { value.data.repository.issues.pageInfo.endCursor += "d"; }],
    ["identity-invalid", (value) => { value.data.viewer.id = "\u0000PRIVATE"; }],
    ["response-invalid", (value) => { value.data.repository.issues.nodes[0].id = ""; }],
    ["pagination-invalid", (value) => { value.data.repository.issues.pageInfo.endCursor = " "; }],
    ["pagination-invalid", (value) => { value.data.repository.issues.pageInfo.endCursor = "cursor\n"; }],
    ["pagination-invalid", (value) => { value.data.repository.issues.pageInfo.endCursor = 1; }],
  ]) {
    const invalid = structuredClone(good);
    change(invalid);
    const observed = inspect([invalid]);
    assert.equal(observed.calls.length, 1);
    unavailable(observed.observation, reason);
  }
});

test("pagination validates terminal counts, both duplicate keys, empty pages, and nonadvancing cursors", () => {
  const good = page([issue(1), issue(2)]);
  assert.equal(inspect([good]).observation.status, "complete");
  for (const invalid of [
    page([issue(1)], { totalCount: 2 }),
    page([issue(1)], { totalCount: 0 }),
    page([issue(1)], { hasNextPage: true }),
    page([], { totalCount: 1, hasNextPage: true }),
    page([], { endCursor: "unexpected" }),
    page([issue(1)], { endCursor: null }),
    page([issue(1)], { totalCount: 2, hasNextPage: true, endCursor: null }),
    page([issue(1), { ...issue(2), id: "issue:1" }]),
    page([issue(1), { ...issue(2), number: 1 }]),
  ]) {
    const observed = inspect([invalid]);
    assert.equal(observed.calls.length, 1);
    unavailable(observed.observation, "pagination-invalid");
  }
  const first = page([issue(1)], { totalCount: 3, hasNextPage: true });
  const second = page([issue(2)], { totalCount: 3, hasNextPage: true });
  const third = page([issue(3)], { totalCount: 3 });
  assert.equal(inspect([first, second, third]).observation.status, "complete");
  third.data.repository.issues.pageInfo.endCursor = "cursor:1";
  const looped = inspect([first, second, third]);
  assert.equal(looped.calls.length, 3);
  unavailable(looped.observation, "pagination-invalid");
});

function pagesOf(count, perPage = 1, total = count * perPage) {
  return Array.from({ length: count }, (_, index) => page(
    Array.from({ length: perPage }, (_, offset) => issue(index * perPage + offset + 1)),
    { totalCount: total, hasNextPage: (index + 1) * perPage < total },
  ));
}

function paddedResponse(value, bytes) {
  const response = result(value);
  assert.ok(response.stdout.length <= bytes, "padding preserves a complete valid response");
  response.stdout = Buffer.concat([response.stdout, Buffer.alloc(bytes - response.stdout.length, 0x20)]);
  assert.equal(response.stdout.length, bytes);
  return response;
}

test("100 pages and 10000 issues succeed only with validated termination", () => {
  const maximum = inspect(pagesOf(100, 100));
  assert.equal(maximum.calls.length, 100);
  assert.equal(maximum.observation.status, "complete");
  assert.equal(maximum.observation.pageCount, 100);
  assert.equal(maximum.observation.totalCount, 10_000);
  assert.equal(maximum.observation.issues.length, 10_000);
  const capped = inspect(pagesOf(100, 1, 101));
  assert.equal(capped.calls.length, 100);
  unavailable(capped.observation, "limit-exceeded");
  const tooMany = inspect([page([issue(1)], { totalCount: 10_001, hasNextPage: true })]);
  assert.equal(tooMany.calls.length, 1);
  unavailable(tooMany.observation, "limit-exceeded");
  const oversizedPage = inspect([page(Array.from({ length: 101 }, (_, index) => issue(index + 1)))]);
  assert.equal(oversizedPage.calls.length, 1);
  unavailable(oversizedPage.observation, "response-invalid");
});

test("per-stream and aggregate byte caps accept exact boundaries and reject one extra byte", () => {
  const megabyte = 1_048_576;
  const exact = paddedResponse(page(), megabyte);
  exact.stderr = Buffer.alloc(megabyte, 0x20);
  const good = inspectResponses([exact]);
  assert.equal(good.calls.length, 1);
  assert.equal(good.observation.status, "complete");
  for (const key of ["stdout", "stderr"]) {
    const observed = inspectResponses([{ ...exact, [key]: Buffer.concat([exact[key], Buffer.from(" ")]) }]);
    assert.equal(observed.calls.length, 1);
    unavailable(observed.observation, "limit-exceeded");
  }
  const responses = pagesOf(8).map((value) => paddedResponse(value, megabyte));
  const aggregate = inspectResponses(responses);
  assert.equal(aggregate.calls.length, 8);
  assert.equal(aggregate.observation.status, "complete");
  const over = pagesOf(9).map((value, index) => index < 8 ? paddedResponse(value, megabyte) : result(value));
  const capped = inspectResponses(over);
  assert.equal(capped.calls.length, 8, "exhausted stdout budget must not initiate another request");
  unavailable(capped.observation, "limit-exceeded");
  const near = pagesOf(9).map(result);
  const finalBytes = near[8].stdout.length;
  for (let index = 0; index < 8; index += 1) near[index] = paddedResponse(pagesOf(9)[index], megabyte - (index === 7 ? finalBytes : 0));
  assert.equal(near.reduce((sum, response) => sum + response.stdout.length, 0), 8 * megabyte);
  assert.equal(inspectResponses(near).observation.status, "complete");
  near[8].stdout = Buffer.concat([near[8].stdout, Buffer.from(" ")]);
  const oneOver = inspectResponses(near);
  assert.equal(oneOver.calls.length, 9);
  unavailable(oneOver.observation, "limit-exceeded");
});

test("request and overall deadlines use monotonic readings, including parsing and finalization", () => {
  const good = result(page([issue(1)]));
  for (const [ticks, reason, count] of [
    [[0, 0, 9999, 9999, 9999], null, 1],
    [[0, 0, 10_000], "timeout", 1],
    [[0, 0, 10_001], "timeout", 1],
    [[0, 59_999, 59_999, 59_999, 59_999], null, 1],
    [[0, 59_999.5], "timeout", 0],
    [[0, 60_000], "timeout", 0],
    [[0, 0, 0, 60_000], "timeout", 1],
    [[0, 0, 0, 0, 60_000], "timeout", 1],
    [[1, 0], "internal-error", 0],
    [[NaN], "internal-error", 0],
    [[Infinity], "internal-error", 0],
    [["0"], "internal-error", 0],
  ]) {
    let readings = 0;
    const observed = inspectResponses([good], { clock: { wall: () => WALL, monotonic: () => ticks[readings++] } });
    assert.equal(readings, ticks.length, "the intended deadline reading was reached");
    assert.equal(observed.calls.length, count);
    if (reason) unavailable(observed.observation, reason);
    else assert.equal(observed.observation.status, "complete");
    if (ticks[1] === 59_999) assert.equal(observed.calls[0].timeout, 1);
  }
  for (const lastDuration of [5999, 6000]) {
    let now = 0;
    const responses = pagesOf(7).map((value, index) => () => {
      now += index < 6 ? 9000 : lastDuration;
      return result(value);
    });
    const observed = inspectResponses(responses, { clock: { wall: () => WALL, monotonic: () => now } });
    assert.equal(observed.calls.length, 7);
    assert.deepEqual(observed.calls.map((request) => request.timeout), [...Array(6).fill(10_000), 6000]);
    if (lastDuration === 5999) assert.equal(observed.observation.status, "complete");
    else unavailable(observed.observation, "timeout");
  }
});

test("wall time supplies real UTC timestamps but cannot set the timeout budget", () => {
  let wallCalls = 0;
  const observed = inspectResponses([result(page())], { clock: { wall: () => WALL + wallCalls++ * 120_000, monotonic: () => 0 } });
  assert.equal(observed.calls.length, 1);
  assert.equal(observed.observation.status, "complete");
  assert.equal(observed.observation.finishedAt, "2026-09-04T12:02:00.000Z");
  let calls = 0;
  const before = Date.now();
  const real = inspectGitHubQueue(INPUT, { transport: () => { calls += 1; return result(page()); } });
  const after = Date.now();
  assert.equal(calls, 1);
  assert.equal(real.status, "complete");
  assert.ok(Date.parse(real.startedAt) >= before && Date.parse(real.finishedAt) <= after);
  for (const wall of [() => NaN, () => "PRIVATE_CLOCK", () => { throw new Error("PRIVATE_CLOCK"); }]) {
    const invalid = inspectResponses([result(page())], { clock: { wall, monotonic: () => 0 } });
    assert.equal(invalid.calls.length, 0);
    unavailable(invalid.observation, "internal-error");
    assert.doesNotMatch(JSON.stringify(invalid.observation), /PRIVATE_CLOCK/);
  }
  let backwards = 0;
  const invalid = inspectResponses([result(page())], { clock: { wall: () => WALL - backwards++, monotonic: () => 0 } });
  assert.equal(invalid.calls.length, 1);
  unavailable(invalid.observation, "internal-error");
});

test("validator fails closed for missing keys, invalid nullable combinations, bounds, and unsorted identities", () => {
  const good = inspect([page([issue(1), issue(2)])]).observation;
  assert.deepEqual(validateGitHubQueueObservation(good), []);
  for (const key of Object.keys(good)) {
    const missing = structuredClone(good);
    delete missing[key];
    assert.deepEqual(validateGitHubQueueObservation(missing), ["shape-invalid"]);
  }
  for (const invalid of [undefined, null, [], "PRIVATE", 0]) assert.deepEqual(validateGitHubQueueObservation(invalid), ["shape-invalid"]);
  for (const change of [
    (value) => { value.status = "pending"; },
    (value) => { value.actor = null; },
    (value) => { value.actor.id = ""; },
    (value) => { value.repository.nameWithOwner = "Other/Queue"; },
    (value) => { value.scope.extra = true; },
    (value) => { value.startedAt = "2026-09-04T12:00:00+00:00"; },
    (value) => { value.totalCount = 10_001; },
    (value) => { value.totalCount = -1; },
    (value) => { value.totalCount = 1.5; },
    (value) => { value.pageCount = 101; },
    (value) => { value.pageCount = 3; },
    (value) => { value.issues.reverse(); },
    (value) => { value.issues[1].id = value.issues[0].id; },
    (value) => { value.issues[1].number = value.issues[0].number; },
    (value) => { value.issues[1].state = "closed"; },
    (value) => { value.issues = null; },
  ]) {
    const invalid = structuredClone(good);
    change(invalid);
    assert.ok(validateGitHubQueueObservation(invalid).length > 0);
  }
  const failed = inspectResponses([{ ...result(page()), status: 4 }]).observation;
  for (const key of ["actor", "repository", "totalCount", "pageCount", "issues"]) {
    const invalid = structuredClone(failed);
    invalid[key] = good[key];
    assert.ok(validateGitHubQueueObservation(invalid).includes("unavailable-data-invalid"));
  }
  for (const reason of [null, "PRIVATE_REASON", "invalid-input"]) {
    assert.ok(validateGitHubQueueObservation({ ...failed, reason }).length > 0);
  }
  assert.ok(validateGitHubQueueObservation({ ...failed, scope: null }).includes("scope-invalid"));
});

function defaultTransportFixture(context, action) {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "supervised-worker-queue-")));
  const cwd = path.join(directory, "workspace");
  const bin = path.join(directory, "bin");
  const executableName = process.platform === "win32" ? "gh.exe" : "gh";
  const executable = path.join(bin, executableName);
  const previousCwd = process.cwd();
  const environment = { ...process.env };
  const calls = [];
  mkdirSync(cwd);
  mkdirSync(bin);
  copyFileSync(process.execPath, executable);
  chmodSync(executable, 0o755);
  context.mock.method(childProcess, "spawnSync", (...parameters) => {
    calls.push(parameters);
    return result(page());
  });
  syncBuiltinESMExports();
  try {
    process.chdir(cwd);
    process.env.PATH = bin;
    action({ directory, cwd, bin, executable, executableName, calls });
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, environment);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("default transport resolves native gh outside the workspace and fixes argv, cwd, environment, and budgets", (context) => {
  defaultTransportFixture(context, ({ bin, executable, calls }) => {
    Object.assign(process.env, {
      PATH: `"${bin}"`, GH_TOKEN: "PRIVATE_GH_TOKEN", GITHUB_TOKEN: "PRIVATE_GITHUB_TOKEN",
      GH_HOST: "PRIVATE_HOST", GH_REPO: "PRIVATE_REPO", GH_DEBUG: "api", DEBUG: "PRIVATE_DEBUG",
      GH_HTTP_UNIX_SOCKET: "PRIVATE_SOCKET", GITHUB_API_URL: "PRIVATE_ENDPOINT", GITHUB_SERVER_URL: "PRIVATE_ENDPOINT",
      GH_ENTERPRISE_TOKEN: "PRIVATE_ENTERPRISE", HTTPS_PROXY: "PRIVATE_PROXY", NODE_OPTIONS: "PRIVATE_NODE",
      GH_PAGER: "PRIVATE_PAGER", PAGER: "PRIVATE_PAGER", GH_FORCE_TTY: "1",
    });
    const observed = inspectGitHubQueue(INPUT);
    assert.equal(observed.status, "complete");
    assert.equal(calls.length, 1, "the actual adapter reached the intercepted subprocess");
    const [command, args, options] = calls[0];
    assert.equal(command, realpathSync(executable));
    assert.deepEqual(args, ["api", "graphql", "--hostname", "github.com", "--method", "POST", "--input", "-"]);
    assert.equal(options.cwd, realpathSync(bin));
    assert.equal(options.shell, false);
    assert.equal(options.killSignal, "SIGKILL");
    assert.equal(options.timeout, 10_000);
    assert.equal(options.maxBuffer, 2_097_152);
    assert.equal(options.encoding, null);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    assert.deepEqual(JSON.parse(options.input), { query: QUERY, variables: { owner: "Example", name: "Queue", states: ["OPEN", "CLOSED"], cursor: null } });
    assert.equal(options.env.GH_TOKEN, "PRIVATE_GH_TOKEN");
    assert.equal(options.env.GITHUB_TOKEN, "PRIVATE_GITHUB_TOKEN");
    for (const key of ["GH_PROMPT_DISABLED", "GH_NO_UPDATE_NOTIFIER", "GH_NO_EXTENSION_UPDATE_NOTIFIER", "GH_NO_ANALYTICS"]) assert.equal(options.env[key], "1");
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(options.env.PATH, realpathSync(bin));
    assert.equal(options.env.GH_PAGER, "");
    assert.equal(options.env.PAGER, "");
    for (const key of ["GH_HOST", "GH_REPO", "GH_DEBUG", "DEBUG", "GH_HTTP_UNIX_SOCKET", "GITHUB_API_URL", "GITHUB_SERVER_URL", "GH_ENTERPRISE_TOKEN", "HTTPS_PROXY", "NODE_OPTIONS", "GH_FORCE_TTY"]) {
      assert.equal(Object.hasOwn(options.env, key), false, key);
    }
    assert.equal(process.env.GH_DEBUG, "api");
    assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_/);
  });
});

test("default transport options produce real subprocess buffer streams", (context) => {
  const realSpawn = childProcess.spawnSync;
  defaultTransportFixture(context, ({ calls }) => {
    assert.equal(inspectGitHubQueue(INPUT).status, "complete");
    assert.equal(calls.length, 1, "the adapter must supply the actual transport options");
    const options = calls[0][2];
    const actual = realSpawn(process.execPath, [
      "--input-type=module", "--eval",
      'process.stdin.on("data", () => {}); process.stdin.on("end", () => process.stdout.write("BINARY_PROBE"));',
    ], options);
    assert.equal(actual.error, undefined);
    assert.equal(actual.status, 0);
    assert.equal(Buffer.isBuffer(actual.stdout), true);
    assert.equal(Buffer.isBuffer(actual.stderr), true);
    assert.equal(actual.stdout.toString("utf8"), "BINARY_PROBE");
    assert.equal(actual.stderr.length, 0);
  });
});

test("missing, relative, workspace, linked workspace, directory, and wrapper executables never spawn", (context) => {
  defaultTransportFixture(context, ({ directory, cwd, bin, executable, executableName, calls }) => {
    assert.equal(inspectGitHubQueue(INPUT).status, "complete");
    assert.equal(calls.length, 1);
    const nativeBytes = readFileSync(executable);
    const workspaceBin = path.join(cwd, "bin");
    mkdirSync(workspaceBin);
    copyFileSync(executable, path.join(workspaceBin, executableName));
    const alias = path.join(directory, "linked-workspace");
    symlinkSync(workspaceBin, alias, process.platform === "win32" ? "junction" : "dir");
    for (const searchPath of ["", ".", "bin", cwd, workspaceBin, alias]) {
      process.env.PATH = searchPath;
      unavailable(inspectGitHubQueue(INPUT), "gh-unavailable");
      assert.equal(calls.length, 1, `unsafe search path must not launch: ${searchPath}`);
    }
    process.env.PATH = bin;
    rmSync(executable);
    for (const suffix of [".cmd", ".bat", ".sh", ".ps1"]) writeFileSync(path.join(bin, `gh${suffix}`), "PRIVATE_WRAPPER");
    unavailable(inspectGitHubQueue(INPUT), "gh-unavailable");
    mkdirSync(executable);
    unavailable(inspectGitHubQueue(INPUT), "gh-unavailable");
    rmSync(executable, { recursive: true });
    for (const content of ["#!/bin/sh\nPRIVATE_WRAPPER\n", "PRIVATE_WRAPPER\n", "@echo PRIVATE_WRAPPER\r\n", "MZ"]) {
      writeFileSync(executable, content, { mode: 0o755 });
      unavailable(inspectGitHubQueue(INPUT), "gh-unavailable");
    }
    assert.equal(calls.length, 1, "no wrapper or directory reached spawn");
    writeFileSync(executable, nativeBytes, { mode: 0o755 });
    process.env.PATH = [workspaceBin, alias, bin].join(path.delimiter);
    assert.equal(inspectGitHubQueue(INPUT).status, "complete");
    assert.equal(calls.length, 2);
    assert.equal(calls[1][0], realpathSync(executable));
  });
});

test("Unix executable permissions and resolved wrapper suffixes are enforced", { skip: process.platform === "win32" }, (context) => {
  defaultTransportFixture(context, ({ bin, executable, calls }) => {
    assert.equal(inspectGitHubQueue(INPUT).status, "complete");
    assert.equal(calls.length, 1);
    chmodSync(executable, 0o644);
    unavailable(inspectGitHubQueue(INPUT), "gh-unavailable");
    assert.equal(calls.length, 1);
    chmodSync(executable, 0o755);
    const wrapper = path.join(bin, "wrapped.cmd");
    copyFileSync(executable, wrapper);
    rmSync(executable);
    symlinkSync(wrapper, executable);
    unavailable(inspectGitHubQueue(INPUT), "gh-unavailable");
    assert.equal(calls.length, 1);
  });
});