// v2 #5: parties.json registry.
// Coverage: loadParties (CWD fallback + explicit path + errors), resolveRef
// (valid / non-ref / malformed / missing-party / missing-field), resolveRefs
// (params + default + CLI skip + error collection), end-to-end through main()
// for --params refs, schema-default refs, CLI value pass-through, --parties
// PATH, missing-file error, --validate catching ref errors.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import {
  main,
  loadParties,
  resolveRef,
  resolveRefs,
  EXIT,
} from "../draft-cli.mjs";
import { tmp, makeFile, runMain } from "./_helpers.mjs";

// ── loadParties ─────────────────────────────────────────────────────────────

test("loadParties returns null when no path given and no parties.json in CWD", () => {
  const cwd = process.cwd();
  const dir = tmp();
  try {
    process.chdir(dir);
    assert.equal(loadParties(null), null);
  } finally { process.chdir(cwd); }
});

test("loadParties auto-loads parties.json from CWD when present", () => {
  const cwd = process.cwd();
  const dir = tmp();
  writeFileSync(join(dir, "parties.json"), JSON.stringify({
    acme: { name: "Acme Corp", state: "DE" },
  }));
  try {
    process.chdir(dir);
    const parties = loadParties(null);
    assert.deepEqual(parties.acme, { name: "Acme Corp", state: "DE" });
  } finally { process.chdir(cwd); }
});

test("loadParties errors when explicit path doesn't exist", () => {
  assert.throws(() => loadParties("/nonexistent/parties.json"), /parties file not found/);
});

test("loadParties errors on invalid JSON", () => {
  const dir = tmp();
  const p = makeFile(dir, "broken.json", "not valid json {");
  assert.throws(() => loadParties(p), /could not parse/);
});

test("loadParties errors when top-level isn't an object", () => {
  const dir = tmp();
  const p = makeFile(dir, "arr.json", "[1, 2, 3]");
  assert.throws(() => loadParties(p), /must be a JSON object/);
});

test("loadParties errors when a party entry isn't an object", () => {
  const dir = tmp();
  const p = makeFile(dir, "bad.json", JSON.stringify({ acme: "not an object" }));
  assert.throws(() => loadParties(p), /entry "acme" must be a JSON object/);
});

// ── resolveRef ──────────────────────────────────────────────────────────────

test("resolveRef returns resolved value for valid ref", () => {
  const parties = { acme: { name: "Acme Corporation", state: "DE" } };
  assert.equal(resolveRef("ref:parties.acme.name", parties), "Acme Corporation");
  assert.equal(resolveRef("ref:parties.acme.state", parties), "DE");
});

test("resolveRef passes through non-ref strings unchanged", () => {
  const parties = { acme: { name: "Acme Corp" } };
  assert.equal(resolveRef("Acme Corp", parties), "Acme Corp");
  assert.equal(resolveRef("ref-something-else", parties), "ref-something-else");
  assert.equal(resolveRef("", parties), "");
});

test("resolveRef throws when no parties loaded", () => {
  assert.throws(() => resolveRef("ref:parties.acme.name", null),
    /no parties\.json loaded/);
});

test("resolveRef throws on malformed ref syntax", () => {
  const parties = { acme: { name: "Acme" } };
  assert.throws(() => resolveRef("ref:parties.acme", parties), /malformed reference/);
  assert.throws(() => resolveRef("ref:other.acme.name", parties), /malformed reference/);
  assert.throws(() => resolveRef("ref:parties..name", parties), /malformed reference/);
});

test("resolveRef throws on unknown party", () => {
  const parties = { acme: { name: "Acme" } };
  assert.throws(() => resolveRef("ref:parties.unknown.name", parties),
    /unknown party "unknown"/);
});

test("resolveRef throws on unknown field", () => {
  const parties = { acme: { name: "Acme" } };
  assert.throws(() => resolveRef("ref:parties.acme.cik", parties),
    /unknown field "cik" on party "acme"/);
});

test("resolveRef stringifies finite-number fields", () => {
  const parties = { acme: { name: "Acme", cik: 1234567 } };
  assert.equal(resolveRef("ref:parties.acme.cik", parties), "1234567");
});

test("resolveRef rejects non-string/non-finite-number fields with EXIT.VALIDATION", () => {
  // Regression (0.10.1 left ref: raw): an object field used to write the
  // literal "[object Object]" into the legal document at exit 0; an array
  // comma-joined; a boolean → "true"; null → "". Route through the same guard
  // as --params/--from-deal so each is rejected with a clear validation error.
  const cases = [
    [{ acme: { addr: { city: "DE" } } }, "ref:parties.acme.addr", /must be a string or number, got an object/],
    [{ acme: { tags: ["a", "b"] } }, "ref:parties.acme.tags", /must be a string or number, got an array/],
    [{ acme: { active: true } }, "ref:parties.acme.active", /must be a string or number, got a boolean/],
    [{ acme: { mid: null } }, "ref:parties.acme.mid", /must be a string or number, got null/],
  ];
  for (const [parties, ref, re] of cases) {
    let caught;
    assert.throws(() => resolveRef(ref, parties), (err) => { caught = err; return re.test(err.message); }, `${ref}`);
    assert.equal(caught.exitCode, 2, `${ref} should set EXIT.VALIDATION`);
  }
});

// ── resolveRefs (batch + sources awareness) ────────────────────────────────

test("resolveRefs resolves params + default sources, skips CLI", () => {
  const parties = { acme: { name: "Acme Corp", state: "DE" } };
  const resolved = {
    a: "ref:parties.acme.name",
    b: "ref:parties.acme.state",
    c: "literal value",
    d: "ref:parties.acme.name", // CLI source — should NOT resolve
  };
  const sources = { a: "params", b: "default", c: "cli", d: "cli" };
  const { ok, errors } = resolveRefs(resolved, sources, parties);
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
  assert.equal(resolved.a, "Acme Corp");
  assert.equal(resolved.b, "DE");
  assert.equal(resolved.c, "literal value");
  // CLI value with ref: prefix passes through unchanged per Q2.2.
  assert.equal(resolved.d, "ref:parties.acme.name");
});

test("resolveRefs collects all errors before returning", () => {
  const parties = { acme: { name: "Acme" } };
  const resolved = {
    a: "ref:parties.unknown.name",
    b: "ref:parties.acme.unknown_field",
    c: "ref:malformed",
  };
  const sources = { a: "params", b: "params", c: "params" };
  const { ok, errors } = resolveRefs(resolved, sources, parties);
  assert.equal(ok, false);
  assert.equal(errors.length, 3);
});

// ── End-to-end through main() ──────────────────────────────────────────────

test("end-to-end: --params with ref resolves against --parties file", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "Between [Party A] and Vendor.\n");
  const partiesPath = makeFile(dir, "parties.json", JSON.stringify({
    acme: { name: "Acme Corporation" },
  }));
  // params file is NOT named <template>.params.json (would trigger
  // auto-schema-load and reject our values-only JSON).
  const params = makeFile(dir, "values.json", JSON.stringify({
    party_a: "ref:parties.acme.name",
  }));
  const { code, out, err } = await runMain(main, [
    tmpl, "--params", params, "--parties", partiesPath,
  ]);
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  assert.match(out, /Between Acme Corporation and Vendor\./);
});

test("end-to-end: schema default with ref resolves transparently", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "Between [Party A] and Vendor.\n");
  makeFile(dir, "parties.json", JSON.stringify({
    acme: { name: "Acme Corporation" },
  }));
  makeFile(dir, "deal.params.json", JSON.stringify({
    _meta: { v: 1 },
    party_a: {
      aliases: ["Party A"],
      required: false,
      default: "ref:parties.acme.name",
    },
  }));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const { code, out, err } = await runMain(main, [tmpl]);
    assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
    assert.match(out, /Between Acme Corporation and Vendor\./);
  } finally { process.chdir(cwd); }
});

test("end-to-end: CLI value with ref: prefix passes through unresolved", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "Between [Party A] and Vendor.\n");
  makeFile(dir, "parties.json", JSON.stringify({
    acme: { name: "Acme Corporation" },
  }));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    // CLI value literally contains "ref:parties.acme.name" — Q2.2: must NOT resolve.
    const { code, out } = await runMain(main, [
      tmpl, "--party-a", "ref:parties.acme.name",
    ]);
    assert.equal(code, 0);
    assert.match(out, /Between ref:parties\.acme\.name and Vendor\./);
  } finally { process.chdir(cwd); }
});

test("end-to-end: --parties PATH overrides CWD fallback", async () => {
  const dir = tmp();
  const altDir = tmp();
  const tmpl = makeFile(dir, "deal.md", "[Party A].\n");
  // Local parties.json (CWD) — would say "Local Co" if it were used.
  makeFile(dir, "parties.json", JSON.stringify({
    acme: { name: "Local Co" },
  }));
  // Alt parties.json (passed via --parties) — should win.
  const altPath = makeFile(altDir, "parties.json", JSON.stringify({
    acme: { name: "Alt Corp" },
  }));
  const params = makeFile(dir, "p.json", JSON.stringify({
    party_a: "ref:parties.acme.name",
  }));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const { code, out } = await runMain(main, [
      tmpl, "--params", params, "--parties", altPath,
    ]);
    assert.equal(code, 0);
    assert.match(out, /Alt Corp\./);
    assert.doesNotMatch(out, /Local Co/);
  } finally { process.chdir(cwd); }
});

test("end-to-end: --parties at nonexistent path errors with clear message", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "[Party A].\n");
  const { code, err } = await runMain(main, [
    tmpl, "--parties", "/nope/parties.json", "--party-a", "Acme",
  ]);
  assert.equal(code, EXIT.IO);
  assert.match(err, /parties file not found/);
});

test("end-to-end: ref to unknown party errors with helpful message", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "[Party A].\n");
  const partiesPath = makeFile(dir, "parties.json", JSON.stringify({
    acme: { name: "Acme" },
  }));
  const params = makeFile(dir, "p.json", JSON.stringify({
    party_a: "ref:parties.globex.name",
  }));
  const { code, err } = await runMain(main, [
    tmpl, "--params", params, "--parties", partiesPath,
  ]);
  assert.equal(code, EXIT.VALIDATION);
  assert.match(err, /parties reference failed for "party_a"/);
  assert.match(err, /unknown party "globex"/);
});

test("end-to-end: ref without parties.json errors with helpful hint", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "[Party A].\n");
  const params = makeFile(dir, "p.json", JSON.stringify({
    party_a: "ref:parties.acme.name",
  }));
  const cwd = process.cwd();
  try {
    process.chdir(dir); // no parties.json here
    const { code, err } = await runMain(main, [tmpl, "--params", params]);
    assert.equal(code, EXIT.VALIDATION);
    assert.match(err, /no parties\.json loaded/);
  } finally { process.chdir(cwd); }
});

test("end-to-end: --validate catches ref errors", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "[Party A].\n");
  const partiesPath = makeFile(dir, "parties.json", JSON.stringify({
    acme: { name: "Acme" },
  }));
  const params = makeFile(dir, "p.json", JSON.stringify({
    party_a: "ref:parties.unknown.name",
  }));
  const { code, err } = await runMain(main, [
    tmpl, "--validate", "--params", params, "--parties", partiesPath,
  ]);
  assert.equal(code, EXIT.VALIDATION);
  assert.match(err, /parties reference failed for "party_a"/);
});

test("end-to-end: ref + typed parameters compose (ref returns raw, then normalized)", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "Effective [Effective Date].\n");
  const partiesPath = makeFile(dir, "parties.json", JSON.stringify({
    standard: { default_date: "2027-01-15" },
  }));
  makeFile(dir, "deal.params.json", JSON.stringify({
    _meta: { v: 1 },
    effective_date: {
      aliases: ["Effective Date"],
      type: "date",
      format: "MMMM d, yyyy",
      default: "ref:parties.standard.default_date",
    },
  }));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const { code, out } = await runMain(main, [tmpl, "--parties", partiesPath]);
    assert.equal(code, 0);
    // Schema default `ref:parties.standard.default_date` → "2027-01-15" → typed-normalized → "January 15, 2027".
    assert.match(out, /Effective January 15, 2027\./);
  } finally { process.chdir(cwd); }
});
