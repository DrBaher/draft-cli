// v2 #6: multi-document bundles.
// Coverage: loadBundle (valid, missing file, invalid JSON, structural
// errors), cmdBundle via main() (happy path with 2 docs sharing
// params, schema union semantics, abort-all on missing required,
// abort-all on type error, no-detection in one entry aborts, --json
// output shape).

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { main, loadBundle, EXIT } from "../draft-cli.mjs";
import { tmp, makeFile, runMain } from "./_helpers.mjs";

// ── loadBundle ──────────────────────────────────────────────────────────────

test("loadBundle accepts a valid bundle", () => {
  const dir = tmp();
  const p = makeFile(dir, "bundle.json", JSON.stringify({
    _meta: { v: 1 },
    outputs: [
      { template: "a.md", output: "out/a.md" },
      { template: "b.md", output: "out/b.md" },
    ],
  }));
  const bundle = loadBundle(p);
  assert.equal(bundle.outputs.length, 2);
  assert.equal(bundle.outputs[0].template, "a.md");
});

test("loadBundle errors on missing file", () => {
  assert.throws(() => loadBundle("/nope/bundle.json"), /bundle file not found/);
});

test("loadBundle errors on invalid JSON", () => {
  const dir = tmp();
  const p = makeFile(dir, "bad.json", "not json");
  assert.throws(() => loadBundle(p), /could not parse bundle/);
});

test("loadBundle errors on non-object top-level", () => {
  const dir = tmp();
  const p = makeFile(dir, "arr.json", "[1, 2]");
  assert.throws(() => loadBundle(p), /must be a JSON object/);
});

test("loadBundle errors when outputs array is missing or empty", () => {
  const dir = tmp();
  const p1 = makeFile(dir, "no-outputs.json", JSON.stringify({ _meta: { v: 1 } }));
  assert.throws(() => loadBundle(p1), /missing or empty "outputs" array/);
  const p2 = makeFile(dir, "empty.json", JSON.stringify({ outputs: [] }));
  assert.throws(() => loadBundle(p2), /missing or empty "outputs" array/);
});

test("loadBundle errors when an entry is missing template or output", () => {
  const dir = tmp();
  const p1 = makeFile(dir, "no-template.json", JSON.stringify({
    outputs: [{ output: "out.md" }],
  }));
  assert.throws(() => loadBundle(p1), /outputs\[0\]\.template must be a non-empty string/);
  const p2 = makeFile(dir, "no-output.json", JSON.stringify({
    outputs: [{ template: "in.md" }],
  }));
  assert.throws(() => loadBundle(p2), /outputs\[0\]\.output must be a non-empty string/);
});

test("loadBundle errors on duplicate output paths", () => {
  const dir = tmp();
  const p = makeFile(dir, "dup.json", JSON.stringify({
    outputs: [
      { template: "a.md", output: "out/x.md" },
      { template: "b.md", output: "out/x.md" },
    ],
  }));
  assert.throws(() => loadBundle(p), /outputs\[1\]\.output "out\/x\.md" is duplicated/);
});

// ── End-to-end through main() ──────────────────────────────────────────────

test("end-to-end: bundle fills two docs with shared parameters", async () => {
  const dir = tmp();
  const msa = makeFile(dir, "msa.md", "MSA between [Party A] and [Party B].\n");
  const sow = makeFile(dir, "sow.md", "SOW for [Party A].\n");
  const bundle = makeFile(dir, "deal.bundle.json", JSON.stringify({
    _meta: { v: 1 },
    outputs: [
      { template: msa, output: join(dir, "out/msa.md") },
      { template: sow, output: join(dir, "out/sow.md") },
    ],
  }));
  // Pre-create the output dir; cmdBundle doesn't mkdir.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "out"));
  const { code, err } = await runMain(main, [
    "--bundle", bundle,
    "--party-a", "Acme",
    "--party-b", "Vendor",
  ]);
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  assert.match(readFileSync(join(dir, "out/msa.md"), "utf8"), /MSA between Acme and Vendor\./);
  assert.match(readFileSync(join(dir, "out/sow.md"), "utf8"), /SOW for Acme\./);
});

test("end-to-end: bundle aborts before writing any output if a required param is missing", async () => {
  const dir = tmp();
  const msa = makeFile(dir, "msa.md", "[Party A] [Party B]\n");
  const sow = makeFile(dir, "sow.md", "[Party A]\n");
  const bundle = makeFile(dir, "b.json", JSON.stringify({
    outputs: [
      { template: msa, output: join(dir, "out/msa.md") },
      { template: sow, output: join(dir, "out/sow.md") },
    ],
  }));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "out"));
  // Only --party-a given; party_b missing → abort all.
  const { code, err } = await runMain(main, [
    "--bundle", bundle, "--party-a", "Acme",
  ]);
  assert.equal(code, EXIT.VALIDATION);
  assert.match(err, /missing required/);
  // No output written.
  assert.equal(existsSync(join(dir, "out/msa.md")), false);
  assert.equal(existsSync(join(dir, "out/sow.md")), false);
});

test("end-to-end: bundle aborts if any entry has no detected placeholders", async () => {
  const dir = tmp();
  const a = makeFile(dir, "a.md", "Has [Party A] here.\n");
  const b = makeFile(dir, "b.md", "Nothing to substitute.\n");
  const bundle = makeFile(dir, "b.json", JSON.stringify({
    outputs: [
      { template: a, output: join(dir, "out/a.md") },
      { template: b, output: join(dir, "out/b.md") },
    ],
  }));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "out"));
  const { code, err } = await runMain(main, [
    "--bundle", bundle, "--party-a", "Acme",
  ]);
  assert.equal(code, EXIT.VALIDATION);
  assert.match(err, /bundle entry 1.*no placeholders detected/);
  assert.equal(existsSync(join(dir, "out/a.md")), false);
});

test("end-to-end: bundle with --json emits structured result", async () => {
  const dir = tmp();
  const a = makeFile(dir, "a.md", "[Party A]\n");
  const b = makeFile(dir, "b.md", "[Party A] x [Party B]\n");
  const bundle = makeFile(dir, "b.json", JSON.stringify({
    outputs: [
      { template: a, output: join(dir, "out/a.md") },
      { template: b, output: join(dir, "out/b.md") },
    ],
  }));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "out"));
  const { code, out } = await runMain(main, [
    "--bundle", bundle, "--json", "--party-a", "Acme", "--party-b", "Vendor",
  ]);
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.outputs.length, 2);
  assert.deepEqual(parsed.outputs.map(o => o.tier), ["bracket", "bracket"]);
  assert.deepEqual(parsed.resolved_keys.sort(), ["party_a", "party_b"]);
});

test("end-to-end: --bundle PATH is mutually exclusive with positional template", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "x.md", "[Y]\n");
  const bundle = makeFile(dir, "b.json", JSON.stringify({
    outputs: [{ template: tmpl, output: join(dir, "out.md") }],
  }));
  const { code, err } = await runMain(main, [tmpl, "--bundle", bundle]);
  assert.equal(code, EXIT.IO);
  assert.match(err, /--bundle does not take a positional/);
});

test("end-to-end: bundle schema union — a schema in template A applies to template B", async () => {
  const dir = tmp();
  // Template A has [Party A], template B has [Party A] AND [Party Buyer].
  // A's schema declares party_a; B's schema declares party_a + party_buyer.
  // Union: both keys flow through one shared resolve.
  const a = makeFile(dir, "a.md", "Party A: [Party A].\n");
  const b = makeFile(dir, "b.md", "Buyer: [Party Buyer], A: [Party A].\n");
  makeFile(dir, "a.params.json", JSON.stringify({
    _meta: { v: 1 },
    party_a: { aliases: ["Party A"], required: true },
  }));
  makeFile(dir, "b.params.json", JSON.stringify({
    _meta: { v: 1 },
    party_a:     { aliases: ["Party A"], required: true },
    party_buyer: { aliases: ["Party Buyer"], required: true },
  }));
  const bundle = makeFile(dir, "bd.json", JSON.stringify({
    outputs: [
      { template: a, output: join(dir, "out/a.md") },
      { template: b, output: join(dir, "out/b.md") },
    ],
  }));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "out"));
  const { code, err } = await runMain(main, [
    "--bundle", bundle, "--party-a", "Acme", "--party-buyer", "Vendor",
  ]);
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  assert.match(readFileSync(join(dir, "out/a.md"), "utf8"), /Party A: Acme\./);
  assert.match(readFileSync(join(dir, "out/b.md"), "utf8"), /Buyer: Vendor, A: Acme\./);
});

test("end-to-end: bundle aborts on type validation failure (across union)", async () => {
  const dir = tmp();
  const a = makeFile(dir, "a.md", "From [Date].\n");
  const b = makeFile(dir, "b.md", "Until [Date].\n");
  makeFile(dir, "a.params.json", JSON.stringify({
    _meta: { v: 1 },
    date: { aliases: ["Date"], type: "date" },
  }));
  makeFile(dir, "b.params.json", JSON.stringify({
    _meta: { v: 1 },
    date: { aliases: ["Date"], type: "date" },
  }));
  const bundle = makeFile(dir, "bd.json", JSON.stringify({
    outputs: [
      { template: a, output: join(dir, "out/a.md") },
      { template: b, output: join(dir, "out/b.md") },
    ],
  }));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "out"));
  const { code, err } = await runMain(main, [
    "--bundle", bundle, "--date", "tomorrow",
  ]);
  assert.equal(code, EXIT.VALIDATION);
  assert.match(err, /type validation failed for "date"/);
  assert.equal(existsSync(join(dir, "out/a.md")), false);
  assert.equal(existsSync(join(dir, "out/b.md")), false);
});
