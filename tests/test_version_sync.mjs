// The exported VERSION constant must match package.json. It drifted to 0.10.0
// once while the package shipped 0.10.1, making --version/--catalog under-report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION } from "../draft-cli.mjs";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);

test("VERSION matches package.json version", () => {
  assert.equal(VERSION, pkg.version);
});
