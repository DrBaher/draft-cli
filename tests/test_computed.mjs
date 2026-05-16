// v2 #2: computed placeholders.
// Coverage: parseDuration, addDuration, computeValues (single + chains +
// cycles), schema validation (good and bad), end-to-end through main().

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  main,
  parseDuration,
  addDuration,
  computeValues,
  parseSchema,
  parseDateValue,
  EXIT,
} from "../draft-cli.mjs";
import { tmp, makeFile, runMain } from "./_helpers.mjs";

// ── parseDuration ──────────────────────────────────────────────────────────

test("parseDuration accepts plural and singular units", () => {
  assert.deepEqual(parseDuration("2 years"), { years: 2 });
  assert.deepEqual(parseDuration("1 year"), { years: 1 });
  assert.deepEqual(parseDuration("6 months"), { months: 6 });
  assert.deepEqual(parseDuration("30 days"), { days: 30 });
  assert.deepEqual(parseDuration("3 weeks"), { weeks: 3 });
});

test("parseDuration is case-insensitive", () => {
  assert.deepEqual(parseDuration("2 YEARS"), { years: 2 });
  assert.deepEqual(parseDuration("1 Month"), { months: 1 });
});

test("parseDuration rejects garbage", () => {
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration("forever"), null);
  assert.equal(parseDuration("two years"), null);
  assert.equal(parseDuration("2 hours"), null); // unsupported unit
  assert.equal(parseDuration("-1 year"), null); // negative
  assert.equal(parseDuration("2years"), null); // missing space
});

// ── addDuration ────────────────────────────────────────────────────────────

test("addDuration: + 2 years from Jan 1, 2026", () => {
  const start = parseDateValue("2026-01-01");
  const out = addDuration(start, "+", { years: 2 });
  assert.equal(out.getUTCFullYear(), 2028);
  assert.equal(out.getUTCMonth(), 0);
  assert.equal(out.getUTCDate(), 1);
});

test("addDuration: - 6 months from Jul 15, 2027", () => {
  const start = parseDateValue("2027-07-15");
  const out = addDuration(start, "-", { months: 6 });
  assert.equal(out.getUTCFullYear(), 2027);
  assert.equal(out.getUTCMonth(), 0); // January
  assert.equal(out.getUTCDate(), 15);
});

test("addDuration: 30 days crosses month boundary correctly", () => {
  const start = parseDateValue("2026-01-31");
  const out = addDuration(start, "+", { days: 30 });
  // Jan 31 + 30 days = Mar 2 (Feb has 28 days in 2026)
  assert.equal(out.getUTCMonth(), 2); // March
  assert.equal(out.getUTCDate(), 2);
});

test("addDuration: 3 weeks = 21 days", () => {
  const start = parseDateValue("2026-06-01");
  const out = addDuration(start, "+", { weeks: 3 });
  assert.equal(out.getUTCMonth(), 5); // still June
  assert.equal(out.getUTCDate(), 22);
});

// ── computeValues (single, chain, errors) ───────────────────────────────────

test("computeValues: single computed placeholder", () => {
  const placeholders = [
    { key: "effective_date", computed: null },
    {
      key: "term_end",
      type: "date",
      format: "MMMM d, yyyy",
      computed: { from: "effective_date", op: "+", value: "2 years" },
    },
  ];
  const resolved = { effective_date: "June 1, 2026" };
  const { ok, errors, computed } = computeValues(placeholders, resolved);
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
  assert.equal(resolved.term_end, "June 1, 2028");
  assert.equal(computed.term_end.to, "June 1, 2028");
});

test("computeValues: chain (C from B from A)", () => {
  const placeholders = [
    { key: "a", computed: null },
    { key: "b", type: "date", format: "MMMM d, yyyy", computed: { from: "a", op: "+", value: "1 year" } },
    { key: "c", type: "date", format: "MMMM d, yyyy", computed: { from: "b", op: "+", value: "1 year" } },
  ];
  const resolved = { a: "January 1, 2026" };
  const { ok } = computeValues(placeholders, resolved);
  assert.equal(ok, true);
  assert.equal(resolved.b, "January 1, 2027");
  assert.equal(resolved.c, "January 1, 2028");
});

test("computeValues: user-supplied value wins over computed", () => {
  const placeholders = [
    { key: "effective_date", computed: null },
    { key: "term_end", computed: { from: "effective_date", op: "+", value: "2 years" } },
  ];
  // Both already in resolved (user gave both via CLI).
  const resolved = { effective_date: "June 1, 2026", term_end: "December 31, 2099" };
  const { ok } = computeValues(placeholders, resolved);
  assert.equal(ok, true);
  // term_end should NOT be overwritten.
  assert.equal(resolved.term_end, "December 31, 2099");
});

test("computeValues: unresolved 'from' produces clear error", () => {
  const placeholders = [
    { key: "term_end", computed: { from: "effective_date", op: "+", value: "2 years" } },
  ];
  const resolved = {}; // nothing supplied
  const { ok, errors } = computeValues(placeholders, resolved);
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /depends on "effective_date" which is unresolved/);
});

test("computeValues: bad duration in schema → per-key error", () => {
  const placeholders = [
    { key: "a", computed: null },
    { key: "b", computed: { from: "a", op: "+", value: "two years" } },
  ];
  const resolved = { a: "January 1, 2026" };
  const { ok, errors } = computeValues(placeholders, resolved);
  assert.equal(ok, false);
  assert.equal(errors[0].key, "b");
  assert.match(errors[0].message, /cannot parse duration "two years"/);
});

test("computeValues: non-date 'from' value → clear error", () => {
  const placeholders = [
    { key: "a", computed: null },
    { key: "b", computed: { from: "a", op: "+", value: "1 year" } },
  ];
  const resolved = { a: "Acme Corporation" }; // not a date
  const { ok, errors } = computeValues(placeholders, resolved);
  assert.equal(ok, false);
  assert.match(errors[0].message, /cannot parse "Acme Corporation" as a date/);
});

// ── parseSchema validation ─────────────────────────────────────────────────

test("parseSchema reads computed block from long form", () => {
  const schema = parseSchema({
    _meta: { v: 1 },
    a: { aliases: ["A"] },
    b: { aliases: ["B"], computed: { from: "a", op: "+", value: "1 year" } },
  });
  assert.deepEqual(schema.entries.b.computed, { from: "a", op: "+", value: "1 year" });
});

test("parseSchema rejects computed.from pointing to unknown key", () => {
  assert.throws(() =>
    parseSchema({
      _meta: { v: 1 },
      b: { aliases: ["B"], computed: { from: "nonexistent", op: "+", value: "1 year" } },
    })
  , /computed\.from = "nonexistent" does not match any other key/);
});

test("parseSchema detects direct cycle A → B → A", () => {
  assert.throws(() =>
    parseSchema({
      _meta: { v: 1 },
      a: { aliases: ["A"], computed: { from: "b", op: "+", value: "1 day" } },
      b: { aliases: ["B"], computed: { from: "a", op: "+", value: "1 day" } },
    })
  , /computed cycle detected/);
});

test("parseSchema detects three-node cycle A → B → C → A", () => {
  assert.throws(() =>
    parseSchema({
      _meta: { v: 1 },
      a: { aliases: ["A"], computed: { from: "b", op: "+", value: "1 day" } },
      b: { aliases: ["B"], computed: { from: "c", op: "+", value: "1 day" } },
      c: { aliases: ["C"], computed: { from: "a", op: "+", value: "1 day" } },
    })
  , /computed cycle detected/);
});

test("parseSchema rejects malformed computed block", () => {
  for (const bad of [
    { aliases: ["X"], computed: "not an object" },
    { aliases: ["X"], computed: { op: "+", value: "1 day" } }, // no from
    { aliases: ["X"], computed: { from: "y", value: "1 day" } }, // no op
    { aliases: ["X"], computed: { from: "y", op: "*", value: "1 day" } }, // bad op
    { aliases: ["X"], computed: { from: "y", op: "+" } }, // no value
  ]) {
    assert.throws(() =>
      parseSchema({ _meta: { v: 1 }, x: bad, y: { aliases: ["Y"] } })
    );
  }
});

test("parseSchema short form: computed is always null", () => {
  const schema = parseSchema({ a: ["A"] });
  assert.equal(schema.entries.a.computed, null);
});

// ── End-to-end via main() ──────────────────────────────────────────────────

test("end-to-end: term_end is computed from effective_date + 2 years", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md",
    "Effective [Effective Date]. Expires [Term End].\n");
  makeFile(dir, "deal.params.json", JSON.stringify({
    _meta: { v: 1 },
    effective_date: { aliases: ["Effective Date"], type: "date", format: "MMMM d, yyyy" },
    term_end: {
      aliases: ["Term End"],
      type: "date", format: "MMMM d, yyyy",
      computed: { from: "effective_date", op: "+", value: "2 years" },
    },
  }));
  const { code, out, err } = await runMain(main, [
    tmpl,
    "--effective-date", "2026-06-01",
  ]);
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  // The substituted output should contain both the source date and the computed date.
  assert.match(out, /Effective June 1, 2026\./);
  assert.match(out, /Expires June 1, 2028\./);
});

test("end-to-end: CLI override of a computed value wins", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "Term ends [Term End].\n");
  makeFile(dir, "deal.params.json", JSON.stringify({
    _meta: { v: 1 },
    effective_date: { aliases: ["Effective Date"], type: "date" },
    term_end: {
      aliases: ["Term End"],
      type: "date",
      computed: { from: "effective_date", op: "+", value: "2 years" },
    },
  }));
  // Template doesn't even reference [Effective Date], so missing effective_date
  // shouldn't matter — only [Term End] is detected, and CLI provides it.
  const { code, out, err } = await runMain(main, [
    tmpl,
    "--term-end", "December 31, 2099",
  ]);
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  assert.match(out, /Term ends December 31, 2099\./);
});

test("end-to-end: missing 'from' value (when computed depends on it) gives clear error", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "Expires [Term End].\n");
  makeFile(dir, "deal.params.json", JSON.stringify({
    _meta: { v: 1 },
    effective_date: { aliases: ["Effective Date"], type: "date" },
    term_end: {
      aliases: ["Term End"],
      type: "date",
      computed: { from: "effective_date", op: "+", value: "2 years" },
    },
  }));
  // Template only has [Term End], no [Effective Date]. effective_date is
  // declared in schema but never detected → orphan error before compute runs.
  const { code, err } = await runMain(main, [tmpl]);
  assert.equal(code, EXIT.VALIDATION);
  // The orphan check fires first (effective_date declared but not detected).
  assert.match(err, /effective_date/);
});

test("end-to-end: --validate catches bad-duration in schema", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "From [Start]. To [End].\n");
  makeFile(dir, "deal.params.json", JSON.stringify({
    _meta: { v: 1 },
    start: { aliases: ["Start"], type: "date" },
    end: {
      aliases: ["End"],
      type: "date",
      computed: { from: "start", op: "+", value: "forever" }, // invalid
    },
  }));
  const { code, err } = await runMain(main, [
    tmpl, "--validate", "--start", "2026-01-01",
  ]);
  assert.equal(code, EXIT.VALIDATION);
  assert.match(err, /computed value failed for "end"/);
  assert.match(err, /cannot parse duration "forever"/);
});

test("end-to-end: schema with cycle errors at load time", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "[A] [B]\n");
  makeFile(dir, "deal.params.json", JSON.stringify({
    _meta: { v: 1 },
    a: { aliases: ["A"], type: "date", computed: { from: "b", op: "+", value: "1 day" } },
    b: { aliases: ["B"], type: "date", computed: { from: "a", op: "+", value: "1 day" } },
  }));
  const { code, err } = await runMain(main, [tmpl]);
  // Schema-level cycle → parseSchema throws → exit IO.
  assert.equal(code, EXIT.IO);
  assert.match(err, /computed cycle detected/);
});
