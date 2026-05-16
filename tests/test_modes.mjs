import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../draft-cli.mjs";
import { tmp, makeFile, runMain } from "./_helpers.mjs";

const FIXTURE = "tests/fixtures/bracket-template.md";

test("draft substitutes from CLI flags and writes to stdout", async () => {
  const { code, out, err } = await runMain(main, [
    FIXTURE,
    "--party-a", "Acme",
    "--party-b", "Vendor Inc.",
    "--effective-date", "2026-06-01",
    "--state-of-california", "Delaware",
  ]);
  assert.equal(code, 0, `stderr: ${err}`);
  assert.match(out, /Acme/);
  assert.match(out, /Vendor Inc\./);
  assert.match(out, /2026-06-01/);
  assert.match(out, /Delaware/);
});

test("draft substitutes from --params JSON file", async () => {
  const { code, out } = await runMain(main, [
    FIXTURE,
    "--params", "tests/fixtures/deal-acme.json",
  ]);
  assert.equal(code, 0);
  assert.match(out, /Acme Corporation/);
  assert.match(out, /Vendor Inc\./);
});

test("draft: CLI flag wins over --params file when both supplied", async () => {
  const { code, out } = await runMain(main, [
    FIXTURE,
    "--params", "tests/fixtures/deal-acme.json",
    "--party-a", "FromCLI",
  ]);
  assert.equal(code, 0);
  assert.match(out, /FromCLI/);
  assert.doesNotMatch(out, /^.*Acme Corporation.*$/m); // CLI overrides
});

test("draft: alias-aware lookup matches multiple phrase forms", async () => {
  // Build a template that uses both "Party A" and "Disclosing Party".
  const dir = tmp();
  const tpl = makeFile(dir, "x.md", "Between [Party A] (aka [Disclosing Party]) and [Party B].");
  makeFile(dir, "x.params.json", JSON.stringify({
    party_a: ["Party A", "Disclosing Party"],
    party_b: ["Party B"],
  }));
  const { code, out } = await runMain(main, [tpl, "--party-a", "Acme", "--party-b", "Vendor"]);
  assert.equal(code, 0);
  assert.match(out, /Between Acme \(aka Acme\) and Vendor/);
});

test("draft: missing required parameter errors with exit 2 and lists the missing keys", async () => {
  const { code, err } = await runMain(main, [FIXTURE, "--party-a", "Acme"]);
  assert.equal(code, 2);
  assert.match(err, /missing required parameter/);
  assert.match(err, /party_b/);
});

test("--validate never writes output", async () => {
  const dir = tmp();
  const outPath = join(dir, "should-not-exist.md");
  const { code, out } = await runMain(main, [
    FIXTURE, "--validate", "--params", "tests/fixtures/deal-acme.json",
    "--output", outPath,
  ]);
  assert.equal(code, 0);
  assert.equal(existsSync(outPath), false);
  assert.equal(out, "");
});

test("--validate exits 2 with --json {ok:false} when params missing", async () => {
  const { code, out } = await runMain(main, [
    FIXTURE, "--validate", "--json",
  ]);
  assert.equal(code, 2);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.missing.includes("party_a"));
});

test("--list-placeholders prints all detected keys", async () => {
  const { code, out } = await runMain(main, [FIXTURE, "--list-placeholders"]);
  assert.equal(code, 0);
  assert.match(out, /party_a/);
  assert.match(out, /party_b/);
  assert.match(out, /effective_date/);
});

test("--list-placeholders --json emits structured report", async () => {
  const { code, out } = await runMain(main, [FIXTURE, "--list-placeholders", "--json"]);
  assert.equal(code, 0);
  const j = JSON.parse(out);
  assert.equal(j.tier, "bracket");
  const keys = j.placeholders.map(p => p.key);
  assert.ok(keys.includes("party_a"));
  assert.ok(keys.includes("party_b"));
});

test("--list-placeholders works on stdin (-)", async () => {
  const stdinReader = async () => "Between [Party A] and [Party B].";
  const { code, out } = await runMain(main, ["-", "--list-placeholders"], { stdinReader });
  assert.equal(code, 0);
  assert.match(out, /party_a/);
  assert.match(out, /party_b/);
});

test("mixed-convention template emits a doctor-style warning", async () => {
  const dir = tmp();
  const tpl = makeFile(dir, "mixed.md", "[Party A] and {{Party B}}");
  const { code, err } = await runMain(main, [
    tpl, "--party-a", "Acme",
  ]);
  // Tier 1 wins; only [Party A] needs to be supplied. Warning still printed.
  assert.equal(code, 0);
  assert.match(err, /mixed placeholder conventions/);
});

test("typo'd param flag surfaces as a warning (footgun guard)", async () => {
  const dir = tmp();
  const tpl = makeFile(dir, "x.md", "[Party A]");
  const { code, err } = await runMain(main, [
    tpl, "--party-a", "Acme", "--random-typo", "x", "--why",
  ]);
  assert.equal(code, 0);
  assert.match(err, /flag --random-typo did not match any detected placeholder/);
});

test("typo'd param flag named in the missing-required error", async () => {
  const dir = tmp();
  const tpl = makeFile(dir, "x.md", "[Party A] [Party B]");
  // User typos --party-b as --party-bb. Should see both the missing error
  // AND a note pointing at the typo.
  const { code, err } = await runMain(main, [
    tpl, "--party-a", "Acme", "--party-bb", "Vendor",
  ]);
  assert.equal(code, 2);
  assert.match(err, /missing required parameter/);
  assert.match(err, /party_b/);
  assert.match(err, /you also passed --party-bb which did not match/);
});

test("--why schema descriptor includes the schema file path", async () => {
  const { code, err } = await runMain(main, [
    "tests/fixtures/bracket-template.md", "--why",
    "--party-a", "A", "--party-b", "B",
    "--effective-date", "D", "--state-of-california", "S",
  ]);
  assert.equal(code, 0);
  assert.match(err, /schema +=.*bracket-template\.params\.json.*short form/);
});

test("--syntax mustache opts into mustache detection", async () => {
  const dir = tmp();
  const tpl = makeFile(dir, "m.md", "{{Party A}} and {{Party B}}");
  const { code, out } = await runMain(main, [
    tpl, "--syntax", "mustache",
    "--party-a", "Acme", "--party-b", "Vendor",
  ]);
  assert.equal(code, 0);
  assert.match(out, /Acme and Vendor/);
});
