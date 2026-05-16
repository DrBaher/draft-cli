import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMustache, hasBothConventions, isMustachePlaceholder } from "../draft-cli.mjs";

test("isMustachePlaceholder accepts snake_case", () => {
  assert.equal(isMustachePlaceholder("party_a"), true);
  assert.equal(isMustachePlaceholder("effective_date"), true);
});

test("isMustachePlaceholder accepts Title Case", () => {
  assert.equal(isMustachePlaceholder("Party A"), true);
});

test("detectMustache finds {{Title}} and {{snake}} forms", () => {
  const body = "{{Party A}} agrees with {{party_b}}, effective {{Effective Date}}.";
  const hits = detectMustache(body);
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map(h => h.inner), ["Party A", "party_b", "Effective Date"]);
});

test("detectMustache trims interior whitespace", () => {
  const body = "Hello {{  Party A  }} world.";
  const hits = detectMustache(body);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].inner, "Party A");
});

test("hasBothConventions detects mixed templates", () => {
  assert.equal(hasBothConventions("[Party A] and {{Party B}}"), true);
  assert.equal(hasBothConventions("[Party A] only"), false);
  assert.equal(hasBothConventions("{{Party A}} only"), false);
});

test("detectMustache: schema aliases rescue heuristic-rejected runs", () => {
  // {{COMPANY}} is all-caps so isMustachePlaceholder rejects it by default.
  const body = "Hi {{COMPANY}}, welcome.";
  assert.equal(detectMustache(body).length, 0);
  assert.equal(detectMustache(body, new Set(["COMPANY"])).length, 1);
});
