import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import tty from "node:tty";
import { pathToFileURL } from "node:url";

// Only the console device is simulated. The installed CLI, provenance, proposal,
// re-observation, authorization publication and guarded state writer are real.
const [installation, cwd, proposalPath, proposalHash, answer, mutation = "none", offsetText = "0"] = process.argv.slice(2);
const clockOffset = Number(offsetText);
assert.ok(Number.isSafeInteger(clockOffset) && clockOffset >= 0);
const realNow = Date.now;
Date.now = () => realNow() + clockOffset;
assert.ok(path.isAbsolute(installation) && path.isAbsolute(cwd) && path.isAbsolute(proposalPath));
const originalOpen = fs.openSync;
const originalIsatty = tty.isatty;
let consoleInput;
let prompted = false;
let readOpened = false;
let writeOpened = false;
fs.openSync = (target, ...args) => {
  if (target === "CONIN$" || (target === "/dev/tty" && args[0] === "r")) { readOpened = true; return 91001; }
  if (target === "CONOUT$" || (target === "/dev/tty" && args[0] === "w")) { writeOpened = true; return 91002; }
  return originalOpen(target, ...args);
};
tty.isatty = (descriptor) => [91001, 91002].includes(descriptor) || originalIsatty(descriptor);
tty.ReadStream = class extends PassThrough {
  constructor(descriptor) {
    super();
    assert.equal(descriptor, 91001);
    this.isTTY = true;
    this.isRaw = false;
    consoleInput = this;
  }
  setRawMode(value) { this.isRaw = value; return this; }
};
tty.WriteStream = class extends Writable {
  constructor(descriptor) {
    super();
    assert.equal(descriptor, 91002);
    this.isTTY = true;
    this.columns = 100;
    this.rows = 30;
  }
  _write(chunk, _encoding, callback) {
    if (!prompted && chunk.toString().includes(`Type AUTHORIZE ${proposalHash}`)) {
      prompted = true;
      if (mutation === "replace-plan") {
        const target = path.join(cwd, ".supervised-worker", "plan.json");
        const replacement = `${target}.operator-fixture`;
        fs.writeFileSync(replacement, fs.readFileSync(target));
        fs.renameSync(replacement, target);
      } else assert.equal(mutation, "none");
      setImmediate(() => consoleInput.end(`${answer}\n`));
    }
    callback();
  }
};
syncBuiltinESMExports();
process.chdir(cwd);
process.argv = [process.execPath, path.join(installation, "src", "cli.mjs"), "recovery", "authorize", proposalPath, proposalHash];
await import(pathToFileURL(process.argv[1]).href);
assert.equal(readOpened && writeOpened && prompted, true, "the direct console boundary must actually fire");
process.stderr.write("fixture-operator-console-confirmation-exercised\n");
