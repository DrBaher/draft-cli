import { test } from "node:test";
import assert from "node:assert/strict";
import { substitute, resolveValues, parseArgs, canonicalKey, kebabToSnake } from "../draft-cli.mjs";

test("substitute replaces bracketed placeholders", () => {
  const body = "Between [Party A] and [Party B].";
  const placeholders = [
    { key: "party_a", hits: [{ match: "[Party A]", inner: "Party A" }] },
    { key: "party_b", hits: [{ match: "[Party B]", inner: "Party B" }] },
  ];
  const result = substitute(body, placeholders, { party_a: "Acme", party_b: "Vendor" }, "bracket");
  assert.equal(result, "Between Acme and Vendor.");
});

test("substitute replaces repeating placeholders", () => {
  const body = "[Party A] x [Party A] x [Party A].";
  const placeholders = [
    { key: "party_a", hits: [{ match: "[Party A]", inner: "Party A" }] },
  ];
  const result = substitute(body, placeholders, { party_a: "Acme" }, "bracket");
  assert.equal(result, "Acme x Acme x Acme.");
});

test("substitute replaces mustache placeholders", () => {
  const body = "{{Party A}} agrees with {{Party B}}.";
  const placeholders = [
    { key: "party_a", hits: [{ match: "{{Party A}}", inner: "Party A" }] },
    { key: "party_b", hits: [{ match: "{{Party B}}", inner: "Party B" }] },
  ];
  const result = substitute(body, placeholders, { party_a: "X", party_b: "Y" }, "mustache");
  assert.equal(result, "X agrees with Y.");
});

test("substitute for heuristic/docx tiers uses whole-word regex", () => {
  const body = "Acme Corp here. AcmeCorp elsewhere. Acme Corp again.";
  const placeholders = [
    { key: "acme_corp", hits: [{ match: "Acme Corp", inner: "Acme Corp" }] },
  ];
  const result = substitute(body, placeholders, { acme_corp: "REAL" }, "heuristic");
  // Only the whole-word matches replace; AcmeCorp survives.
  assert.match(result, /AcmeCorp elsewhere/);
  assert.match(result, /REAL here\. AcmeCorp elsewhere\. REAL again/);
});

test("substitute: bracket value with $ patterns is inserted literally", () => {
  // Regression: replaceAll uses split/join so it was already safe, but assert
  // the contract — `$&`/`$$` in the value must not be interpreted.
  const body = "Pay [amount].";
  const placeholders = [{ key: "amount", hits: [{ match: "[amount]", inner: "amount" }] }];
  const value = "$5 ($& $$ done)";
  const result = substitute(body, placeholders, { amount: value }, "bracket");
  assert.equal(result, `Pay ${value}.`);
});

test("substitute: heuristic/docx value with $ patterns is inserted literally", () => {
  // Regression: the tier-3/4/5 `out.replace(re, v)` treated `v` as a
  // replacement pattern; `$&` expanded to the matched phrase. Now a function
  // replacer inserts the value verbatim.
  const body = "Acme Corp signs.";
  const placeholders = [{ key: "acme_corp", hits: [{ match: "Acme Corp", inner: "Acme Corp" }] }];
  const value = "$& $$ $` $' Ltd";
  const result = substitute(body, placeholders, { acme_corp: value }, "heuristic");
  assert.equal(result, `${value} signs.`);
});

test("resolveValues: CLI flag wins over JSON file", async () => {
  const opts = parseArgs(["x", "--party-a", "FromCLI"]);
  const placeholders = [{ key: "party_a", required: true, default: null, aliases: ["Party A"] }];
  const r = await resolveValues(placeholders, opts, { party_a: "FromJSON" });
  assert.equal(r.resolved.party_a, "FromCLI");
  assert.equal(r.sources.party_a, "cli");
});

test("resolveValues: JSON file wins over schema default", async () => {
  const opts = parseArgs(["x"]);
  const placeholders = [{ key: "party_a", required: false, default: "FromDefault", aliases: ["Party A"] }];
  const r = await resolveValues(placeholders, opts, { party_a: "FromJSON" });
  assert.equal(r.resolved.party_a, "FromJSON");
  assert.equal(r.sources.party_a, "params");
});

test("resolveValues: schema default used when nothing else supplied", async () => {
  const opts = parseArgs(["x"]);
  const placeholders = [{ key: "effective_date", required: false, default: "the date first written above", aliases: ["Effective Date"] }];
  const r = await resolveValues(placeholders, opts, {});
  assert.equal(r.resolved.effective_date, "the date first written above");
  assert.equal(r.sources.effective_date, "default");
});

test("resolveValues: empty-string CLI flag still counts as supplied", async () => {
  const opts = parseArgs(["x", "--party-a", ""]);
  const placeholders = [{ key: "party_a", required: true, default: null, aliases: ["Party A"] }];
  const r = await resolveValues(placeholders, opts, {});
  assert.equal(r.resolved.party_a, "");
  assert.equal(r.sources.party_a, "cli");
  assert.equal(r.missing.length, 0);
});

test("resolveValues: missing required reported", async () => {
  const opts = parseArgs(["x"]);
  const placeholders = [
    { key: "party_a", required: true, default: null, aliases: ["Party A"] },
    { key: "party_b", required: true, default: null, aliases: ["Party B"] },
  ];
  const r = await resolveValues(placeholders, opts, { party_a: "X" });
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].key, "party_b");
});

test("resolveValues: interactive prompter consulted when value missing", async () => {
  const opts = parseArgs(["x", "--interactive"]);
  const placeholders = [{ key: "party_a", required: true, default: null, aliases: ["Party A"] }];
  const prompter = async () => "FromPrompt";
  const r = await resolveValues(placeholders, opts, {}, { prompter });
  assert.equal(r.resolved.party_a, "FromPrompt");
  assert.equal(r.sources.party_a, "interactive");
});

test("kebabToSnake & canonicalKey", () => {
  assert.equal(kebabToSnake("party-a-name"), "party_a_name");
  assert.equal(canonicalKey("Party A Name"), "party_a_name");
  assert.equal(canonicalKey("State of California"), "state_of_california");
});
