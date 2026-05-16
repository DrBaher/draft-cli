// v2 #7: positional addressing.
// Coverage: parseSchema validation, assemble expansion + errors, substitute
// index-based for positional, findOrphans exemption, end-to-end via main().

import { test } from "node:test";
import assert from "node:assert/strict";
import { main, parseSchema, findOrphans, substitute, EXIT } from "../draft-cli.mjs";
import { tmp, makeFile, runMain } from "./_helpers.mjs";

// ── parseSchema validation ──────────────────────────────────────────────────

test("parseSchema accepts positions array of {role}", () => {
  const schema = parseSchema({
    _meta: { v: 1 },
    blank: {
      aliases: ["_____________"],
      positions: [{ role: "valuation_cap" }, { role: "purchase_amount" }],
    },
  });
  assert.equal(schema.entries.blank.positions.length, 2);
  assert.equal(schema.entries.blank.positions[0].role, "valuation_cap");
  assert.equal(schema.entries.blank.positions[1].role, "purchase_amount");
});

test("parseSchema rejects empty positions array", () => {
  assert.throws(() =>
    parseSchema({ _meta: { v: 1 }, blank: { aliases: ["X"], positions: [] } })
  , /positions must be a non-empty array/);
});

test("parseSchema rejects positions with duplicate roles", () => {
  assert.throws(() =>
    parseSchema({
      _meta: { v: 1 },
      blank: { aliases: ["X"], positions: [{ role: "a" }, { role: "a" }] },
    })
  , /duplicate role 'a'/);
});

test("parseSchema rejects non-snake_case role", () => {
  assert.throws(() =>
    parseSchema({
      _meta: { v: 1 },
      blank: { aliases: ["X"], positions: [{ role: "ValuationCap" }] },
    })
  , /must be a valid snake_case key/);
});

test("parseSchema rejects positions[i] without role", () => {
  assert.throws(() =>
    parseSchema({
      _meta: { v: 1 },
      blank: { aliases: ["X"], positions: [{ name: "missing role" }] },
    })
  , /must be a valid snake_case key/);
});

test("parseSchema short-form entries have positions=null", () => {
  const schema = parseSchema({ party_a: ["[Party A]"] });
  assert.equal(schema.entries.party_a.positions, null);
});

// ── findOrphans exemption ───────────────────────────────────────────────────

test("findOrphans: positional entry with NO detected hits → orphan", () => {
  const schema = parseSchema({
    _meta: { v: 1 },
    blank: { aliases: ["_____________"], positions: [{ role: "x" }, { role: "y" }] },
  });
  // detected_schema_keys = [] means no hits for "blank"
  const orphans = findOrphans(schema, [], []);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].key, "blank");
});

test("findOrphans: positional entry WITH detected hits (parent key in detected) → not orphan", () => {
  const schema = parseSchema({
    _meta: { v: 1 },
    blank: { aliases: ["_____________"], positions: [{ role: "x" }, { role: "y" }] },
  });
  // Even though `placeholders` shows role keys (x, y) not "blank",
  // detected_schema_keys=["blank"] tells us it WAS detected pre-expansion.
  const placeholders = [
    { key: "x", aliases: ["_____________"] },
    { key: "y", aliases: ["_____________"] },
  ];
  const orphans = findOrphans(schema, placeholders, ["blank"]);
  assert.equal(orphans.length, 0);
});

// ── substitute (index-based positional path) ────────────────────────────────

test("substitute: positional T1 hits substitute at exact byte positions", () => {
  const body = "Cap $[X] and pay $[X].";
  // Hand-built placeholders mimicking assemble's output for a positional entry:
  // both share alias `[X]` but each targets one specific index.
  const placeholders = [
    {
      key: "valuation_cap",
      tier: "bracket",
      position_index: 0,
      hits: [{ match: "[X]", inner: "X", index: 5 }],
    },
    {
      key: "purchase_amount",
      tier: "bracket",
      position_index: 1,
      hits: [{ match: "[X]", inner: "X", index: 18 }],
    },
  ];
  const out = substitute(body, placeholders, {
    valuation_cap: "5M",
    purchase_amount: "100K",
  }, "bracket");
  assert.equal(out, "Cap $5M and pay $100K.");
});

test("substitute: positional + non-positional mixed in same body", () => {
  // [Y] is normal (replaces all occurrences), [X] is positional.
  const body = "[Y] caps $[X] and $[X] for [Y].";
  const placeholders = [
    {
      key: "buyer",
      tier: "bracket",
      hits: [
        { match: "[Y]", inner: "Y", index: 0 },
        { match: "[Y]", inner: "Y", index: 27 },
      ],
    },
    {
      key: "cap_a",
      tier: "bracket",
      position_index: 0,
      hits: [{ match: "[X]", inner: "X", index: 10 }],
    },
    {
      key: "cap_b",
      tier: "bracket",
      position_index: 1,
      hits: [{ match: "[X]", inner: "X", index: 19 }],
    },
  ];
  const out = substitute(body, placeholders, {
    buyer: "Acme",
    cap_a: "5M",
    cap_b: "100K",
  }, "bracket");
  assert.match(out, /Acme caps \$5M and \$100K for Acme\./);
});

// ── End-to-end via main() ──────────────────────────────────────────────────

test("end-to-end: YC-SAFE-style positional addressing on bracketed underscores", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "safe.md",
    "Valuation cap of $[_____________] and purchase amount of $[_____________].\n");
  makeFile(dir, "safe.params.json", JSON.stringify({
    _meta: { v: 1 },
    blank: {
      aliases: ["_____________"],
      positions: [
        { role: "valuation_cap" },
        { role: "purchase_amount" },
      ],
    },
  }));
  const { code, out, err } = await runMain(main, [
    tmpl,
    "--valuation-cap", "5,000,000",
    "--purchase-amount", "100,000",
  ]);
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  assert.match(out, /Valuation cap of \$5,000,000 and purchase amount of \$100,000\./);
});

test("end-to-end: missing positional CLI flag → standard missing-required error", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "safe.md", "$[X] and $[X].\n");
  makeFile(dir, "safe.params.json", JSON.stringify({
    _meta: { v: 1 },
    blank: {
      aliases: ["X"],
      positions: [{ role: "first" }, { role: "second" }],
    },
  }));
  // Only --first is supplied.
  const { code, err } = await runMain(main, [tmpl, "--first", "Apple"]);
  assert.equal(code, EXIT.VALIDATION);
  assert.match(err, /missing required parameter/);
  assert.match(err, /second/);
});

test("end-to-end: count mismatch (2 positions, 3 detected) → clear error", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "safe.md", "[X] and [X] and [X].\n");
  makeFile(dir, "safe.params.json", JSON.stringify({
    _meta: { v: 1 },
    blank: {
      aliases: ["X"],
      positions: [{ role: "first" }, { role: "second" }],
    },
  }));
  const { code, err } = await runMain(main, [tmpl, "--first", "A", "--second", "B"]);
  assert.equal(code, EXIT.VALIDATION);
  assert.match(err, /positional placeholder "blank"/);
  assert.match(err, /schema declares 2 position\(s\) but detected 3 occurrence\(s\)/);
});

test("end-to-end: count mismatch (2 positions, 1 detected) → clear error", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "safe.md", "Only one: [X].\n");
  makeFile(dir, "safe.params.json", JSON.stringify({
    _meta: { v: 1 },
    blank: {
      aliases: ["X"],
      positions: [{ role: "first" }, { role: "second" }],
    },
  }));
  const { code, err } = await runMain(main, [tmpl]);
  assert.equal(code, EXIT.VALIDATION);
  assert.match(err, /schema declares 2 position\(s\) but detected 1 occurrence/);
});

test("end-to-end: positional + typed parameters compose (date type on each position)", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "From [Date] to [Date].\n");
  makeFile(dir, "deal.params.json", JSON.stringify({
    _meta: { v: 1 },
    placeholder_date: {
      aliases: ["Date"],
      type: "date",
      format: "yyyy-MM-d",
      positions: [{ role: "start_date" }, { role: "end_date" }],
    },
  }));
  const { code, out, err } = await runMain(main, [
    tmpl,
    "--start-date", "January 1, 2026",
    "--end-date", "December 31, 2026",
  ]);
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  // Both typed normalized to yyyy-MM-d and substituted at correct positions.
  assert.match(out, /From 2026-01-1 to 2026-12-31\./);
});

test("end-to-end: positional placeholder NOT in template → orphan error", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "No placeholders here.\n");
  makeFile(dir, "deal.params.json", JSON.stringify({
    _meta: { v: 1 },
    blank: {
      aliases: ["X"],
      positions: [{ role: "first" }, { role: "second" }],
    },
  }));
  const { code, err } = await runMain(main, [tmpl]);
  // Tier "none" since no placeholders detected.
  assert.equal(code, EXIT.VALIDATION);
  assert.match(err, /no placeholders detected/);
});
