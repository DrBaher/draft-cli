// v2 #3: typed parameter normalization (date, money, party).
// Coverage: parsers, formatters, normalizer dispatch, batch
// normalizeTypedValues, schema integration through parseSchema, end-to-end
// through main() including --validate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  main,
  parseDateValue,
  formatDateValue,
  parseMoneyValue,
  formatMoneyValue,
  normalizeTypedValue,
  normalizeTypedValues,
  parseSchema,
  EXIT,
} from "../draft-cli.mjs";
import { tmp, makeFile, runMain } from "./_helpers.mjs";

// ── parseDateValue ──────────────────────────────────────────────────────────

test("parseDateValue accepts ISO YYYY-MM-DD", () => {
  const d = parseDateValue("2027-01-15");
  assert.notEqual(d, null);
  assert.equal(d.getUTCFullYear(), 2027);
  assert.equal(d.getUTCMonth(), 0);
  assert.equal(d.getUTCDate(), 15);
});

test("parseDateValue accepts spelled forms", () => {
  for (const s of ["January 15, 2027", "January 15 2027", "Jan 15 2027", "Sept 3, 2026"]) {
    const d = parseDateValue(s);
    assert.notEqual(d, null, `expected ${s} to parse`);
  }
});

test("parseDateValue rejects ambiguous numeric forms (US and EU)", () => {
  // Q3.1: US (MM/DD/YYYY) and European (DD/MM/YYYY) are NOT accepted.
  assert.equal(parseDateValue("01/15/2027"), null);
  assert.equal(parseDateValue("15/01/2027"), null);
  assert.equal(parseDateValue("1/15/2027"), null);
});

test("parseDateValue rejects impossible dates (Feb 31)", () => {
  assert.equal(parseDateValue("2027-02-31"), null);
  assert.equal(parseDateValue("February 31, 2027"), null);
});

test("parseDateValue rejects garbage", () => {
  assert.equal(parseDateValue("tomorrow"), null);
  assert.equal(parseDateValue(""), null);
  assert.equal(parseDateValue("January Twenty 2026"), null);
});

// ── formatDateValue ─────────────────────────────────────────────────────────

test("formatDateValue formats with default-style pattern", () => {
  const d = parseDateValue("2027-01-15");
  assert.equal(formatDateValue(d, "MMMM d, yyyy"), "January 15, 2027");
});

test("formatDateValue handles tokens in any order without leaking", () => {
  const d = parseDateValue("2027-01-15");
  assert.equal(formatDateValue(d, "yyyy-MM-d"), "2027-01-15");
  // MMMM must not collide with MM, d must not leak into MMMM
  assert.equal(formatDateValue(d, "MMMM/MM"), "January/01");
  assert.equal(formatDateValue(d, "d MMMM yyyy"), "15 January 2027");
});

// ── parseMoneyValue ─────────────────────────────────────────────────────────

test("parseMoneyValue handles $, commas, decimals", () => {
  assert.equal(parseMoneyValue("$5,000"), 500000);
  assert.equal(parseMoneyValue("5000.50"), 500050);
  assert.equal(parseMoneyValue("$1,234,567.89"), 123456789);
});

test("parseMoneyValue handles K/M/B suffixes", () => {
  assert.equal(parseMoneyValue("$5M"), 500000000); // $5,000,000 = 500,000,000 cents
  assert.equal(parseMoneyValue("2.5K"), 250000); // $2,500 = 250,000 cents
  assert.equal(parseMoneyValue("1B"), 100000000000); // $1B = 100,000,000,000 cents
});

test("parseMoneyValue rejects garbage", () => {
  assert.equal(parseMoneyValue("five thousand"), null);
  assert.equal(parseMoneyValue(""), null);
  assert.equal(parseMoneyValue("$"), null);
  assert.equal(parseMoneyValue("$$5"), null);
});

// ── formatMoneyValue ────────────────────────────────────────────────────────

test("formatMoneyValue: USD adds thousand separators + 2 decimals", () => {
  assert.equal(formatMoneyValue(500000, "USD"), "$5,000.00");
  assert.equal(formatMoneyValue(500000000, "USD"), "$5,000,000.00");
  assert.equal(formatMoneyValue(99, "USD"), "$0.99");
  assert.equal(formatMoneyValue(0, "USD"), "$0.00");
});

test("formatMoneyValue: handles negatives", () => {
  assert.equal(formatMoneyValue(-12345, "USD"), "-$123.45");
});

test("formatMoneyValue: non-USD throws (Q3.2)", () => {
  assert.throws(() => formatMoneyValue(100, "EUR"), /only USD/);
});

// ── normalizeTypedValue dispatch ────────────────────────────────────────────

test("normalizeTypedValue: type=date with custom format", () => {
  assert.equal(
    normalizeTypedValue("2027-01-15", { type: "date", format: "yyyy-MM-d" }),
    "2027-01-15"
  );
  assert.equal(
    normalizeTypedValue("January 15, 2027", { type: "date", format: "MMMM d, yyyy" }),
    "January 15, 2027"
  );
});

test("normalizeTypedValue: type=date normalizes US-like spelled input", () => {
  // Default format. Different spelled inputs all converge to the same output.
  assert.equal(
    normalizeTypedValue("Jan 15 2027", { type: "date" }),
    "January 15, 2027"
  );
});

test("normalizeTypedValue: type=money normalizes various inputs", () => {
  assert.equal(normalizeTypedValue("$5M", { type: "money", currency: "USD" }), "$5,000,000.00");
  assert.equal(normalizeTypedValue("5000.5", { type: "money" }), "$5,000.50");
});

test("normalizeTypedValue: type=party strips whitespace, rejects markdown links", () => {
  assert.equal(normalizeTypedValue("  Acme Corp  ", { type: "party" }), "Acme Corp");
  assert.throws(
    () => normalizeTypedValue("[Acme](https://acme.com)", { type: "party" }),
    /markdown link/
  );
});

test("normalizeTypedValue: type=party rejects empty + trailing punctuation", () => {
  assert.throws(() => normalizeTypedValue("", { type: "party" }), /non-empty/);
  assert.throws(() => normalizeTypedValue("   ", { type: "party" }), /non-empty/);
  assert.throws(() => normalizeTypedValue("Acme.", { type: "party" }), /trailing punctuation/);
  assert.throws(() => normalizeTypedValue("Acme,", { type: "party" }), /trailing punctuation/);
});

test("normalizeTypedValue: no type → returns raw", () => {
  assert.equal(normalizeTypedValue("anything", { type: null }), "anything");
  assert.equal(normalizeTypedValue("anything", {}), "anything");
});

test("normalizeTypedValue: unknown type → throws", () => {
  assert.throws(
    () => normalizeTypedValue("x", { type: "phone" }),
    /unknown type "phone"/
  );
});

test("normalizeTypedValue: invalid date → throws with helpful message", () => {
  try {
    normalizeTypedValue("01/15/2027", { type: "date" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.match(e.message, /could not parse "01\/15\/2027" as a date/);
    assert.match(e.message, /US.*European.*not.*accepted/);
    assert.equal(e.exitCode, EXIT.VALIDATION);
  }
});

// ── normalizeTypedValues batch ──────────────────────────────────────────────

test("normalizeTypedValues: mutates resolved in place, collects errors", () => {
  const placeholders = [
    { key: "effective_date", type: "date", format: "MMMM d, yyyy" },
    { key: "purchase_amount", type: "money", currency: "USD" },
    { key: "party_a", type: "party" },
    { key: "untyped", type: null },
  ];
  const resolved = {
    effective_date: "2027-06-01",
    purchase_amount: "$5M",
    party_a: "  Acme Corp  ",
    untyped: "leave me alone",
  };
  const { ok, errors, normalized } = normalizeTypedValues(placeholders, resolved);
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
  assert.equal(resolved.effective_date, "June 1, 2027");
  assert.equal(resolved.purchase_amount, "$5,000,000.00");
  assert.equal(resolved.party_a, "Acme Corp");
  assert.equal(resolved.untyped, "leave me alone");
  // Three entries normalized (untyped not in `normalized`).
  assert.equal(Object.keys(normalized).length, 3);
});

test("normalizeTypedValues: collects all errors instead of bailing on first", () => {
  const placeholders = [
    { key: "date1", type: "date" },
    { key: "money1", type: "money" },
    { key: "party1", type: "party" },
  ];
  const resolved = {
    date1: "tomorrow",
    money1: "five thousand",
    party1: "",
  };
  const { ok, errors } = normalizeTypedValues(placeholders, resolved);
  assert.equal(ok, false);
  assert.equal(errors.length, 3);
  assert.equal(errors[0].key, "date1");
  assert.equal(errors[1].key, "money1");
  assert.equal(errors[2].key, "party1");
});

// ── parseSchema picks up type/format/currency ───────────────────────────────

test("parseSchema reads type/format/currency from long form", () => {
  const schema = parseSchema({
    _meta: { version: 1 },
    effective_date: { aliases: ["[Effective Date]"], type: "date", format: "yyyy-MM-d" },
    purchase_amount: { aliases: ["[Purchase Amount]"], type: "money", currency: "USD" },
    party_a: { aliases: ["[Party A]"], type: "party" },
  });
  assert.equal(schema.form, "long");
  assert.equal(schema.entries.effective_date.type, "date");
  assert.equal(schema.entries.effective_date.format, "yyyy-MM-d");
  assert.equal(schema.entries.purchase_amount.type, "money");
  assert.equal(schema.entries.purchase_amount.currency, "USD");
  assert.equal(schema.entries.party_a.type, "party");
});

test("parseSchema short form has null type fields", () => {
  const schema = parseSchema({
    party_a: ["[Party A]"],
  });
  assert.equal(schema.form, "short");
  assert.equal(schema.entries.party_a.type, null);
  assert.equal(schema.entries.party_a.format, null);
  assert.equal(schema.entries.party_a.currency, null);
});

// ── End-to-end through main() ───────────────────────────────────────────────

test("end-to-end: typed schema normalizes date and money on cmdDraft", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md",
    "Effective [Effective Date], for [Purchase Amount], between [Party A] and Acme Corp.\n");
  const schema = makeFile(dir, "deal.params.json", JSON.stringify({
    _meta: { version: 1 },
    effective_date: { aliases: ["Effective Date"], type: "date", format: "MMMM d, yyyy" },
    purchase_amount: { aliases: ["Purchase Amount"], type: "money", currency: "USD" },
    party_a: { aliases: ["Party A"], type: "party" },
  }));
  const { code, out, err } = await runMain(main, [
    tmpl,
    "--effective-date", "2027-06-01",
    "--purchase-amount", "$5M",
    "--party-a", "  Globex Industries  ",
  ]);
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  assert.match(out, /Effective June 1, 2027, for \$5,000,000\.00, between Globex Industries and Acme Corp/);
});

test("end-to-end: bad date input exits with VALIDATION and clear error", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "Effective [Effective Date].\n");
  makeFile(dir, "deal.params.json", JSON.stringify({
    _meta: { version: 1 },
    effective_date: { aliases: ["Effective Date"], type: "date" },
  }));
  const { code, err } = await runMain(main, [
    tmpl, "--effective-date", "01/15/2027",
  ]);
  assert.equal(code, EXIT.VALIDATION);
  assert.match(err, /type validation failed for "effective_date"/);
  assert.match(err, /could not parse "01\/15\/2027" as a date/);
});

test("end-to-end: --validate catches type errors", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "For [Purchase Amount].\n");
  makeFile(dir, "deal.params.json", JSON.stringify({
    _meta: { version: 1 },
    purchase_amount: { aliases: ["Purchase Amount"], type: "money" },
  }));
  const { code, err } = await runMain(main, [
    tmpl, "--validate", "--purchase-amount", "five thousand",
  ]);
  assert.equal(code, EXIT.VALIDATION);
  assert.match(err, /type validation failed for "purchase_amount"/);
  assert.match(err, /could not parse "five thousand" as money/);
});

test("end-to-end: --validate --json reports type_errors", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "For [Purchase Amount].\n");
  makeFile(dir, "deal.params.json", JSON.stringify({
    _meta: { version: 1 },
    purchase_amount: { aliases: ["Purchase Amount"], type: "money" },
  }));
  const { code, out } = await runMain(main, [
    tmpl, "--validate", "--json", "--purchase-amount", "five thousand",
  ]);
  assert.equal(code, EXIT.VALIDATION);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.type_errors.map((e) => e.key), ["purchase_amount"]);
});
