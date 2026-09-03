import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const testFiles = readdirSync(testDirectory)
  .filter((fileName) => fileName.endsWith(".test.mjs"))
  .sort();

if (testFiles.length === 0) {
  process.stderr.write("No test files were found.\n");
  process.exitCode = 1;
} else {
  for (const fileName of testFiles) {
    const result = spawnSync(
      process.execPath,
      ["--test", path.join(testDirectory, fileName)],
      { stdio: "inherit" },
    );
    if (result.error) {
      process.stderr.write(`Unable to run ${fileName}: ${result.error.message}\n`);
      process.exitCode = 1;
      break;
    }
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}