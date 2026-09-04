import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(testDirectory, "run-tests.mjs");

function harness() {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "supervised-worker-runner-")));
  copyFileSync(runner, path.join(directory, "run-tests.mjs"));
  return directory;
}

function writeCase(directory, name, body) {
  writeFileSync(
    path.join(directory, name),
    `import test from "node:test";\ntest(${JSON.stringify(name)}, () => {\n${body}\n});\n`,
  );
}

function runHarness(directory) {
  // Node refuses a nested --test run, so the inherited test context must not reach the harness.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, [path.join(directory, "run-tests.mjs")], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

test("a failing test file does not stop later files from running", () => {
  const directory = harness();
  try {
    writeCase(directory, "a-fails.test.mjs", "  throw new Error(\"DELIBERATE_FAILURE\");");
    writeCase(directory, "b-passes.test.mjs", "  // no assertion needed");
    writeCase(directory, "c-fails.test.mjs", "  throw new Error(\"DELIBERATE_FAILURE\");");

    const result = runHarness(directory);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /a-fails\.test\.mjs/, "first failing file must run");
    assert.match(output, /b-passes\.test\.mjs/, "file after a failure must still run");
    assert.match(output, /c-fails\.test\.mjs/, "later failing file must still run");
    assert.match(
      result.stderr,
      /Failing test files \(2 of 3\): a-fails\.test\.mjs, c-fails\.test\.mjs/,
      "summary must name every failing file",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an all-passing suite exits zero without a failure summary", () => {
  const directory = harness();
  try {
    writeCase(directory, "a-passes.test.mjs", "  // no assertion needed");
    writeCase(directory, "b-passes.test.mjs", "  // no assertion needed");

    const result = runHarness(directory);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0, output);
    assert.match(output, /a-passes\.test\.mjs/);
    assert.match(output, /b-passes\.test\.mjs/);
    assert.doesNotMatch(result.stderr, /Failing test files/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an empty test directory fails closed", () => {
  const directory = harness();
  try {
    const result = runHarness(directory);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /No test files were found\./);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
