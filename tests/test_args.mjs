import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, UsageError, getCatalog } from "../draft-cli.mjs";

test("parseArgs recognizes --catalog json", () => {
  assert.equal(parseArgs(["--catalog", "json"]).catalog, "json");
  assert.equal(parseArgs(["--catalog=json"]).catalog, "json");
});

test("getCatalog: machine-readable flag inventory", () => {
  const c = getCatalog();
  assert.equal(c.name, "draft-cli");
  assert.equal(c.bin, "draft");
  assert.ok(Array.isArray(c.flags) && c.flags.length > 10);
  assert.ok(c.flags.some(f => f.name === "--catalog"));
  assert.ok(c.flags.some(f => f.name === "--list-placeholders"));
  assert.equal(c.exitCodes["4"], "llm failure");
});

test("parseArgs handles all known booleans", () => {
  const o = parseArgs(["x.md", "--why", "--json", "--validate", "--no-heuristic", "--llm", "-i"]);
  assert.equal(o.why, true);
  assert.equal(o.json, true);
  assert.equal(o.validate, true);
  assert.equal(o.noHeuristic, true);
  assert.equal(o.forceLlm, true);
  assert.equal(o.interactive, true);
});

test("parseArgs handles known value flags", () => {
  const o = parseArgs(["x.md", "--params", "p.json", "-o", "out.md", "--syntax", "mustache"]);
  assert.equal(o.params, "p.json");
  assert.equal(o.output, "out.md");
  assert.equal(o.syntax, "mustache");
});

test("parseArgs errors on invalid --syntax", () => {
  assert.throws(() => parseArgs(["x.md", "--syntax", "wat"]), UsageError);
});

test("parseArgs collects unknown --flag VALUE pairs as paramFlags", () => {
  const o = parseArgs(["x.md", "--party-a", "Acme", "--effective-date", "2026-06-01"]);
  assert.equal(o.paramFlags.party_a, "Acme");
  assert.equal(o.paramFlags.effective_date, "2026-06-01");
});

test("parseArgs errors when a param flag has no value", () => {
  assert.throws(() => parseArgs(["x.md", "--party-a"]), UsageError);
});

test("parseArgs errors when a value flag is missing its value (no silent swallow)", () => {
  for (const flag of ["--params", "--output", "--parties", "--bundle", "--from-deal", "--dictionary"]) {
    // flag is the last token → must error, not consume undefined.
    assert.throws(() => parseArgs(["x.md", flag]), UsageError, `${flag} alone`);
    // followed by another flag → must error, not swallow the next flag.
    assert.throws(() => parseArgs(["x.md", flag, "--validate"]), UsageError, `${flag} then --validate`);
  }
});

test("parseArgs: --catalog only consumes the next token when it is 'json'", () => {
  // Greedy consumption used to eat the input file: `draft --catalog template.txt`
  // dropped template.txt. Now only `json` is consumed.
  const o = parseArgs(["--catalog", "template.txt"]);
  assert.equal(o.catalog, "json");
  assert.deepEqual(o.positional, ["template.txt"]);

  const j = parseArgs(["--catalog", "json"]);
  assert.equal(j.catalog, "json");
  assert.deepEqual(j.positional, []);

  const bare = parseArgs(["--catalog"]);
  assert.equal(bare.catalog, "json");
});

test("parseArgs treats positionals correctly", () => {
  const o = parseArgs(["template.md"]);
  assert.deepEqual(o.positional, ["template.md"]);
});

test("parseArgs handles --help and --version", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--version"]).version, true);
  assert.equal(parseArgs(["-V"]).version, true);
});
