import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBracket, isBracketPlaceholder } from "../draft-cli.mjs";

test("isBracketPlaceholder accepts Title Case", () => {
  assert.equal(isBracketPlaceholder("Party A"), true);
  assert.equal(isBracketPlaceholder("Effective Date"), true);
  assert.equal(isBracketPlaceholder("State of California"), true);
});

test("isBracketPlaceholder rejects all-caps", () => {
  assert.equal(isBracketPlaceholder("CONFIDENTIALITY"), false);
  assert.equal(isBracketPlaceholder("ARTICLE I"), false);
});

test("isBracketPlaceholder rejects numeric-leading", () => {
  assert.equal(isBracketPlaceholder("3.1"), false);
});

test("isBracketPlaceholder rejects too-short", () => {
  assert.equal(isBracketPlaceholder("A"), false);
});

test("detectBracket finds multiple placeholders", () => {
  const body = "Between [Party A] and [Party B], effective [Effective Date].";
  const hits = detectBracket(body);
  assert.equal(hits.length, 3);
  assert.equal(hits[0].inner, "Party A");
  assert.equal(hits[1].inner, "Party B");
  assert.equal(hits[2].inner, "Effective Date");
});

test("detectBracket finds the same form repeatedly", () => {
  const body = "[Party A] does X. [Party A] also does Y. [Party B] watches.";
  const hits = detectBracket(body);
  assert.equal(hits.length, 3);
  assert.equal(hits.filter(h => h.inner === "Party A").length, 2);
});

test("detectBracket includes [See Section 4] (schema is the disambiguation tool)", () => {
  const body = "Confidentiality. See [See Section 4] for survival.";
  const hits = detectBracket(body);
  // Per Q1: the bracketed Title Case matches; the schema is what filters.
  assert.equal(hits.length, 1);
  assert.equal(hits[0].inner, "See Section 4");
});

test("detectBracket ignores headings and numeric refs", () => {
  const body = "[ARTICLE I]\n[3.1] Confidentiality. Party [A] obligation.";
  const hits = detectBracket(body);
  assert.equal(hits.length, 0);
});

test("detectBracket skips markdown links", () => {
  const body = "See [the docs](https://example.com) and [CC BY 4.0](https://creativecommons.org).";
  const hits = detectBracket(body);
  assert.equal(hits.length, 0);
});

test("detectBracket skips checkbox markers", () => {
  const body = "- [x] Option A\n- [ ] Option B\n- [X] Option C";
  const hits = detectBracket(body);
  assert.equal(hits.length, 0);
});

test("detectBracket accepts sentence-shaped placeholders with punctuation", () => {
  const body = "Effective: [Today’s date]. Term: [1 year(s)] from start.";
  const hits = detectBracket(body);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].inner, "Today’s date");
  assert.equal(hits[1].inner, "1 year(s)");
});

test("detectBracket accepts long sentence-shaped placeholders", () => {
  const body = "[Evaluating whether to enter into a business relationship with the other party.]";
  const hits = detectBracket(body);
  assert.equal(hits.length, 1);
});

test("detectBracket on real Common Paper coverpage finds all 5 placeholders", async () => {
  const { readFileSync } = await import("node:fs");
  const body = readFileSync("tests/fixtures/cp-mutual-nda-coverpage.md", "utf8");
  const hits = detectBracket(body);
  // Dedup by inner text (template repeats [1 year(s)])
  const innerSet = new Set(hits.map(h => h.inner));
  assert.ok(innerSet.has("Evaluating whether to enter into a business relationship with the other party."));
  assert.ok(innerSet.has("Today’s date"));
  assert.ok(innerSet.has("1 year(s)"));
  assert.ok(innerSet.has("Fill in state"));
  assert.ok(innerSet.has("Fill in city or county and state, i.e. “courts located in New Castle, DE”"));
});

test("detectBracket: schema aliases rescue heuristic-rejected runs (YC SAFE [COMPANY] and [_____________])", () => {
  const body = "Signed by [COMPANY] for the amount of $[_____________] on [Effective Date].";
  // Without schema rescue: [COMPANY] (all-caps) and [_____________] (all underscores) are dropped.
  const withoutSchema = detectBracket(body);
  assert.equal(withoutSchema.length, 1);
  assert.equal(withoutSchema[0].inner, "Effective Date");
  // With schema aliases: both rescued and now reach the alias-resolution step.
  const aliases = new Set(["COMPANY", "_____________"]);
  const withSchema = detectBracket(body, aliases);
  assert.equal(withSchema.length, 3);
  assert.deepEqual(withSchema.map(h => h.inner), ["COMPANY", "_____________", "Effective Date"]);
});
