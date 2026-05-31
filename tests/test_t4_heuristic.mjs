import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHeuristic, DEFAULT_HEURISTIC_DICT, readDictionary, EXIT } from "../draft-cli.mjs";
import { tmp, makeFile } from "./_helpers.mjs";

test("detectHeuristic finds bundled-dictionary phrases", () => {
  const body = "This document is between Acme Corporation and John Doe.";
  const hits = detectHeuristic(body);
  const phrases = hits.map(h => h.inner);
  assert.ok(phrases.includes("Acme Corporation"));
  assert.ok(phrases.includes("John Doe"));
});

test("detectHeuristic respects word boundaries", () => {
  // "Acme Corp." should match, "Acmecorporation" should not.
  const body = "We have Acmecorporation as a vendor.";
  const hits = detectHeuristic(body);
  assert.equal(hits.length, 0);
});

test("detectHeuristic dedupes phrases (one detection per phrase)", () => {
  const body = "John Doe and John Doe and John Doe again.";
  const hits = detectHeuristic(body);
  assert.equal(hits.filter(h => h.inner === "John Doe").length, 1);
});

test("detectHeuristic returns empty for clean text", () => {
  const body = "This is a perfectly normal sentence with no generics.";
  assert.equal(detectHeuristic(body).length, 0);
});

test("detectHeuristic accepts a custom dictionary", () => {
  const body = "We use Frobnicator Co. for our widgets.";
  const hits = detectHeuristic(body, ["Frobnicator Co."]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].inner, "Frobnicator Co.");
});

test("readDictionary reads a JSON array", () => {
  const dir = tmp();
  const path = makeFile(dir, "dict.json", `["Foo Co.", "Bar Inc."]`);
  const dict = readDictionary(path);
  assert.deepEqual(dict, ["Foo Co.", "Bar Inc."]);
});

test("readDictionary errors on non-array JSON", () => {
  const dir = tmp();
  const path = makeFile(dir, "dict.json", `{"not": "an array"}`);
  assert.throws(() => readDictionary(path), /array/);
});

test("readDictionary rejects non-string elements with a clear EXIT.IO error", () => {
  // Regression: only Array.isArray was checked, so a numeric entry reached
  // escapeRegex(phrase) → s.replace, leaking "s.replace is not a function".
  const dir = tmp();
  const path = makeFile(dir, "dict.json", `[99, 100]`);
  assert.throws(() => readDictionary(path), (err) => {
    assert.match(err.message, /dictionary entries must be strings/);
    assert.ok(!/s\.replace is not a function/.test(err.message));
    assert.equal(err.exitCode, EXIT.IO);
    return true;
  });
});

test("DEFAULT_HEURISTIC_DICT is non-empty and includes well-known placeholders", () => {
  assert.ok(DEFAULT_HEURISTIC_DICT.length > 20);
  assert.ok(DEFAULT_HEURISTIC_DICT.includes("Acme Corporation"));
  assert.ok(DEFAULT_HEURISTIC_DICT.includes("John Doe"));
});
