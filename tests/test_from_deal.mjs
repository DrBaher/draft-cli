// v2 #4: LLM inference from a free-form deal description.
// Coverage: inferFromDeal happy path / extras / missing provider / malformed
// LLM response, end-to-end via main() including CLI override > inferred,
// --no-llm disables, extra-keys warn, missing file errors.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, inferFromDeal, EXIT } from "../draft-cli.mjs";
import { tmp, makeFile, runMain, fakeFetcher } from "./_helpers.mjs";

const PLACEHOLDERS = [
  { key: "party_a", first_seen_as: "Party A", aliases: ["Party A"] },
  { key: "party_b", first_seen_as: "Party B", aliases: ["Party B"] },
  { key: "effective_date", first_seen_as: "Effective Date", aliases: ["Effective Date"] },
];

const ANTHROPIC = (text) => ({
  match: "anthropic.com",
  json: { content: [{ text }] },
});

// ── inferFromDeal unit tests ────────────────────────────────────────────────

test("inferFromDeal: happy path returns values for known keys", async () => {
  const fetcher = fakeFetcher([ANTHROPIC(JSON.stringify({
    values: {
      party_a: "Acme Corporation",
      party_b: "Globex Inc",
      effective_date: "January 1, 2027",
    },
  }))]);
  const { values, extraKeys, warnings } = await inferFromDeal(
    "Deal between Acme and Globex effective 1/1/27.",
    PLACEHOLDERS,
    { provider: "anthropic", apiKey: "k" },
    { fetcher }
  );
  assert.deepEqual(values, {
    party_a: "Acme Corporation",
    party_b: "Globex Inc",
    effective_date: "January 1, 2027",
  });
  assert.deepEqual(extraKeys, []);
  assert.deepEqual(warnings, []);
});

test("inferFromDeal: omits unknown keys to extraKeys (Q4.2)", async () => {
  const fetcher = fakeFetcher([ANTHROPIC(JSON.stringify({
    values: {
      party_a: "Acme",
      noise_key: "should be reported as extra",
      another_noise: "ditto",
    },
  }))]);
  const { values, extraKeys } = await inferFromDeal(
    "x", PLACEHOLDERS, { provider: "anthropic", apiKey: "k" }, { fetcher }
  );
  assert.deepEqual(values, { party_a: "Acme" });
  assert.deepEqual(extraKeys.sort(), ["another_noise", "noise_key"]);
});

test("inferFromDeal: numeric LLM values coerced to strings", async () => {
  const fetcher = fakeFetcher([ANTHROPIC(JSON.stringify({
    values: { party_a: "Acme", effective_date: 2027 },
  }))]);
  const { values } = await inferFromDeal(
    "x", PLACEHOLDERS, { provider: "anthropic", apiKey: "k" }, { fetcher }
  );
  assert.equal(values.effective_date, "2027");
});

test("inferFromDeal: non-string non-number values produce warnings + skip", async () => {
  const fetcher = fakeFetcher([ANTHROPIC(JSON.stringify({
    values: { party_a: { nested: "obj" }, party_b: "ok" },
  }))]);
  const { values, warnings } = await inferFromDeal(
    "x", PLACEHOLDERS, { provider: "anthropic", apiKey: "k" }, { fetcher }
  );
  assert.equal(values.party_a, undefined);
  assert.equal(values.party_b, "ok");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"party_a".*was object/);
});

test("inferFromDeal: missing provider throws", async () => {
  await assert.rejects(
    () => inferFromDeal("x", PLACEHOLDERS, null, { fetcher: () => {} }),
    /--from-deal requires an LLM provider/
  );
});

test("inferFromDeal: malformed LLM response throws", async () => {
  const fetcher = fakeFetcher([ANTHROPIC("not json at all")]);
  await assert.rejects(
    () => inferFromDeal("x", PLACEHOLDERS, { provider: "anthropic", apiKey: "k" }, { fetcher }),
    /non-JSON response/
  );
});

test("inferFromDeal: empty placeholders list short-circuits without calling LLM", async () => {
  let called = false;
  const fetcher = (...args) => { called = true; return { ok: true, async json() { return {}; } }; };
  const { values, extraKeys, warnings } = await inferFromDeal(
    "x", [], { provider: "anthropic", apiKey: "k" }, { fetcher }
  );
  assert.equal(called, false);
  assert.deepEqual(values, {});
  assert.deepEqual(extraKeys, []);
  assert.deepEqual(warnings, []);
});

// ── End-to-end through main() with fake fetcher ─────────────────────────────

const TEST_ENV = { ANTHROPIC_API_KEY: "sk-test" };

test("end-to-end: --from-deal fills missing params via LLM", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "Between [Party A] and [Party B].\n");
  const deal = makeFile(dir, "deal.txt", "Mutual NDA between Acme and Globex.\n");
  const fetcher = fakeFetcher([ANTHROPIC(JSON.stringify({
    values: { party_a: "Acme", party_b: "Globex" },
  }))]);
  const { code, out, err } = await runMain(main, [tmpl, "--from-deal", deal], {
    fetcher, cwd: dir, env: TEST_ENV,
  });
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  assert.match(out, /Between Acme and Globex\./);
});

test("end-to-end: CLI override wins over --from-deal inference", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "Between [Party A] and [Party B].\n");
  const deal = makeFile(dir, "deal.txt", "Mutual NDA between Acme and Globex.\n");
  const fetcher = fakeFetcher([ANTHROPIC(JSON.stringify({
    values: { party_a: "Acme", party_b: "Globex" },
  }))]);
  const { code, out } = await runMain(main, [
    tmpl, "--from-deal", deal,
    "--party-a", "CLI Wins Inc",
  ], { fetcher, cwd: dir, env: TEST_ENV });
  assert.equal(code, 0);
  // CLI overrides Acme for party_a; LLM still fills party_b.
  assert.match(out, /Between CLI Wins Inc and Globex\./);
});

test("end-to-end: --from-deal extra keys produce warnings (Q4.2)", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "Between [Party A] and [Party B].\n");
  const deal = makeFile(dir, "deal.txt", "x");
  const fetcher = fakeFetcher([ANTHROPIC(JSON.stringify({
    values: { party_a: "A", party_b: "B", random_noise: "n", another_one: "y" },
  }))]);
  const { code, err } = await runMain(main, [tmpl, "--from-deal", deal], {
    fetcher, cwd: dir, env: TEST_ENV,
  });
  assert.equal(code, 0);
  assert.match(err, /unknown key "random_noise"/);
  assert.match(err, /unknown key "another_one"/);
});

test("end-to-end: --from-deal + --no-llm disables inference", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "Between [Party A] and [Party B].\n");
  const deal = makeFile(dir, "deal.txt", "x");
  let fetcherCalled = false;
  const fetcher = () => {
    fetcherCalled = true;
    return { ok: true, async json() { return { content: [{ text: "{}" }] }; } };
  };
  // No CLI values + --no-llm → missing required.
  const { code, err } = await runMain(main, [
    tmpl, "--from-deal", deal, "--no-llm",
  ], { fetcher, cwd: dir, env: TEST_ENV });
  assert.equal(code, EXIT.VALIDATION);
  assert.equal(fetcherCalled, false, "fetcher should not have been called with --no-llm");
  assert.match(err, /missing required/);
});

test("end-to-end: --from-deal with missing file errors clearly", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "[Party A]\n");
  const { code, err } = await runMain(main, [
    tmpl, "--from-deal", "/nope/deal.txt", "--party-a", "anything",
  ], { cwd: dir, env: TEST_ENV });
  assert.equal(code, EXIT.IO);
  assert.match(err, /deal description file not found/);
});

test("end-to-end: --from-deal without provider configured errors", async () => {
  const dir = tmp();
  const tmpl = makeFile(dir, "deal.md", "[Party A]\n");
  const deal = makeFile(dir, "deal.txt", "x");
  // Empty env so no provider detected.
  const { code, err } = await runMain(main, [tmpl, "--from-deal", deal], {
    cwd: dir, env: {},
  });
  assert.equal(code, EXIT.LLM);
  assert.match(err, /--from-deal requires an LLM provider/);
});
