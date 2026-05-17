# Changelog

All notable changes to this project will be documented in this file. The
format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and the project adheres to semantic versioning once it leaves 0.x.

## 0.8.0 — 2026-05-17

### Added

- **LLM inference from a deal description** (last v2 item). New
  `--from-deal PATH` flag reads a free-form deal description and
  asks the configured T5 LLM provider to extract values for the
  schema's declared placeholders:
  ```sh
  draft nda.md --from-deal deal-notes.txt --output draft.md
  ```
  Where `deal-notes.txt` is unstructured prose:
  ```
  Mutual NDA between Acme Corporation (DE) and Globex (UK), effective
  June 1, 2026, for a 2-year term.
  ```
  The LLM is asked to fill `party_a`, `party_a_state`, `party_b`,
  `effective_date`, etc. — only the keys already detected as
  placeholders are extracted.
- **Value-resolution precedence updated:**
  `CLI flag > --params JSON > --from-deal (LLM) > --interactive > schema default > error`.
  CLI / --params always win, so users can fix or override anything
  the LLM got wrong.
- **New public API:** `inferFromDeal(dealText, placeholders, providerCfg, { fetcher })`.

### Decisions locked (V2_BRIEFS_REMAINING Q4.1–Q4.3)

- **Q4.1 Provider:** same T5 provider config — `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, or explicit `DRAFT_LLM_*`. No separate inference
  provider; one network surface, one set of env vars.
- **Q4.2 Extra keys:** keys the LLM emits that aren't in the
  detected placeholders are **warned** to stderr (not dropped
  silently). The LLM gets a fresh list of allowed keys in the
  prompt so this is rare in practice.
- **Q4.3 Auto-LLM:** `--from-deal` does **not** require an
  explicit `--llm` flag — the inference is implicit. `--no-llm`
  still disables it (the user can opt out of the network call).

### Notes

- `--from-deal` errors are fatal (`EXIT.LLM` for provider /
  network / parse failures). Users with bad provider configs see
  the issue immediately rather than silently running with no
  inferred values.
- Bundle mode (v0.7.0) does not yet thread `--from-deal` through
  per-template inference. Deferred to a follow-up; the shared
  parameter resolution makes the single-doc API already useful
  for bundles via `--params`.

## 0.7.0 — 2026-05-17

### Added

- **Multi-document bundles.** `draft --bundle <bundle.json>` reads a
  bundle definition and fills multiple templates with the same set of
  parameter values in one invocation:
  ```json
  {
    "_meta": { "schema_version": 1 },
    "outputs": [
      { "template": "msa/v3.md",        "output": "out/msa.md" },
      { "template": "order-form/v3.md", "output": "out/order-form.md" }
    ]
  }
  ```
  Each template runs through detection independently. Placeholders
  across templates are unioned by key (so a key declared in any
  template's schema applies to all — Q3.3 locked). Resolution,
  typed-parameter normalization, and computed values all run once on
  the union. Each output is then substituted using its own
  template/tier and written to its own path. `parties.json` refs
  (v0.6.0) resolve inside bundle entries too.
- **Schema-union semantics.** A key declared/detected in any bundle
  template applies to every template in the bundle. First-occurrence
  metadata wins; resolved values flow to all templates that reference
  the same key.
- **`.docx` bundle entries** round-trip through `substituteDocxXml`
  when the entry's `output` path has the `.docx` extension. Same
  runs/styles preservation as single-doc `.docx` mode.
- **New public API:** `loadBundle(path)`, `cmdBundle(opts, bundle,
  paramsObj, envObj, io)`.

### Decisions locked (V2_BRIEFS_REMAINING Q3.1–Q3.3)

- **Q3.1 Bundle file format:** JSON object with `outputs` array of
  `{template, output}` pairs. Each entry has its own output path,
  enabling per-doc overrides without inventing a custom DSL.
- **Q3.2 Partial-failure policy:** abort-all. Any pre-write error
  (no detection in an entry, missing required param across the
  union, type / computed / ref failure, positional mismatch, schema
  orphan) exits 4 before any file is written. Write failures
  mid-bundle exit 1; earlier successful writes are not rolled back
  (best-effort atomicity at the filesystem boundary).
- **Q3.3 Schema union semantics:** keys declared in any template's
  schema (or detected as canonical-key matches without a schema)
  apply across the bundle. Same value resolves into every template
  that references the key.

## 0.6.0 — 2026-05-16

### Added

- **Cross-template `parties.json` registry.** A repo-local
  `parties.json` declares known parties once; templates' schemas
  reference fields with `ref:parties.<key>.<field>`:
  ```json
  // parties.json
  { "acme_corp": { "name": "Acme Corporation", "state": "Delaware" } }
  ```
  ```json
  // <template>.params.json
  {
    "_meta": { "v": 1 },
    "party_a":       { "aliases": ["Party A"],       "default": "ref:parties.acme_corp.name" },
    "party_a_state": { "aliases": ["Party A State"], "default": "ref:parties.acme_corp.state" }
  }
  ```
  Resolution happens between `resolveValues` and typed-parameter
  normalization, so `ref:`-resolved values feed cleanly into
  `type: date | money | party` flows.
- **`--parties PATH` flag** overrides the default CWD/`parties.json`
  lookup. Missing explicit path → exit 1 with a clear error.
- **New public API:** `loadParties(path)`, `resolveRef(value, parties)`,
  `resolveRefs(resolved, sources, parties)`.

### Decisions locked (V2_BRIEFS_REMAINING Q2.1–Q2.3)

- **Q2.1 File location:** default is `./parties.json` in CWD;
  override with `--parties PATH`.
- **Q2.2 Ref scope:** refs resolve in `--params` JSON and schema
  `default` values only. CLI flag values with `ref:` prefix pass
  through **unchanged** — they're treated as literal strings.
- **Q2.3 Versioning:** out of scope for v0.6.0. When a party's
  metadata changes in `parties.json`, all drafts that ref it produce
  different output if re-run. Documented as a known property.

### Schema-contract change

`PARAM_SCHEMA.md` §5 gains a "Cross-template `parties.json` registry"
subsection. v0.6.0 schemas are forward-compatible with v0.5.x
readers — `ref:` strings just look like literal values to older
readers (and won't substitute correctly, but won't error out either
since "ref:..." is a valid string).

## 0.5.0 — 2026-05-16

### Added

- **Positional addressing** for same-text placeholders with different
  semantic roles. Long-form schema entries can declare a `positions`
  array; each position gets its own canonical key (via `role`), so the
  CLI uses standard `--<role>` flags. Validated against the YC SAFE
  `$[_____________] × 2` case (valuation cap vs. purchase amount).
  ```json
  "blank": {
    "aliases": ["_____________"],
    "type": "money", "currency": "USD",
    "positions": [
      { "role": "valuation_cap" },
      { "role": "purchase_amount" }
    ]
  }
  ```
  ```sh
  draft safe.docx \
    --valuation-cap 5000000 \
    --purchase-amount 100000
  ```
  Decisions locked (V2_BRIEFS_REMAINING Q1.1–Q1.3):
  - **Q1.1 Index base**: schema positions are 0-indexed internally;
    the CLI uses role names, not numeric indices.
  - **Q1.2 Length mismatch**: schema declares N positions but
    detection finds M ≠ N occurrences → hard error (exit 4).
  - **Q1.3 Bare-key CLI**: a `--<role>` flag targets its specific
    position; values still flow through `--params` JSON or
    `--interactive` normally.

### Constraints

- Positional addressing only works at tier T1 (bracket) and T2
  (mustache) — those tiers carry per-hit byte indices needed for
  position-specific substitution. T3 (docx-highlight), T4 (heuristic),
  T5 (LLM) raise a positional error if a positional schema entry's
  aliases are matched by them. `.docx` templates with `[X]` brackets
  that fire T1 still work; `.docx` templates that rely on T3 highlights
  for the same alias do not.

### Schema-contract change

`PARAM_SCHEMA.md` §5 gains a "Positional addressing" subsection. Long-
form entries can now include a `positions` array; short form is
unchanged. Forward-compatible with v0.4.x readers — they'll ignore the
unknown field and treat the entry as a regular non-positional
placeholder (which means the first detected occurrence wins for
substitution, and ambiguity is unresolved).

## 0.4.0 — 2026-05-16

### Added

- **Computed placeholders.** Long-form schema entries can declare a
  `computed` block referencing another key:
  ```json
  "term_end": {
    "aliases": ["Term End"],
    "type": "date",
    "format": "MMMM d, yyyy",
    "computed": { "from": "effective_date", "op": "+", "value": "2 years" }
  }
  ```
  At substitution time, if no value was supplied via CLI / `--params`
  / interactive / default, the computed entry's value is derived from
  the `from` placeholder. Explicit CLI / `--params` values still win —
  computed only fills the gap. Q2.1 locked: expression syntax lives
  in the schema only, not in template text — keeps T1 detection
  unchanged. Q2.2 locked: v0.4.0 supports date arithmetic only
  (`+` / `-` with `<n> day|week|month|year[s]` durations). Money
  math and string concat deferred to a future release.
- **Schema-time cycle detection.** `parseSchema` throws if any
  `computed.from` chain revisits a key (e.g. `a → b → a`), or if
  `computed.from` references a key that doesn't exist in the same
  schema. Catches misconfiguration before substitution starts.
- **Orphan-check exemption.** Schema entries that are referenced only
  as another entry's `computed.from` source (and never appear as
  detected aliases in the template) are no longer reported as
  orphans. They're "feeders" — declared so a computed entry can
  reference them, even though the template doesn't show them.
- **New public API:** `parseDuration(raw)`, `addDuration(date, op, dur)`,
  `computeValues(placeholders, resolved)`.

### Schema-contract change

`PARAM_SCHEMA.md` §5 gains a "Computed placeholders" section. Long-
form entries can now include a `computed: { from, op, value }` block;
short form is unchanged. v0.4.0 schemas are forward-compatible with
v0.3.x readers (which will silently ignore the `computed` field as
unrecognized long-form metadata, treating the entry as a regular
placeholder — but then the user has to supply a value, since v0.3.x
won't compute one).

## 0.3.2 — 2026-05-16

### Fixed

- **Publish auth: restored `NODE_AUTH_TOKEN` env block.** v0.3.1's
  hotfix bumped `publish.yml` Node from 20 to 22 on the hypothesis
  that npm CLI 11.5.1+ would auto-detect OIDC and ignore the
  setup-node placeholder. It didn't: Node 22's npm 11.x still sent
  the literal `XXXXX-XXXXX-XXXXX-XXXXX` placeholder and got the
  same 404 from npm. Root cause is *not* Node version; either
  `setup-node@v6` always writes the placeholder env into the
  publish step, or npm CLI prefers the `.npmrc` token over OIDC
  even when both are available. Under investigation.
- **v0.3.1 tag exists on GitHub but did NOT publish to npm.** Skip
  it. Registry latest is `0.2.0` until v0.3.2 ships.

Pragmatic call: v0.3.2 ships via the bootstrap `NPM_TOKEN` path.
Trusted Publisher stays configured on npm so the switch back to
pure OIDC is a one-line change in `publish.yml` once we understand
why npm CLI isn't using OIDC. `feedback_oidc_setup_node_v6_placeholder.md`
in memory tracks the symptom + workarounds tried.

## 0.3.1 — 2026-05-16

### Fixed

- **`publish.yml` now uses Node 22 instead of Node 20.** npm
  Trusted Publishing requires npm CLI 11.5.1 or later, which ships
  with Node 22.14+. Node 20 (npm 10.x) silently falls back to
  `NODE_AUTH_TOKEN` when configured for a registry, and to
  `setup-node@v6`'s placeholder value (`XXXXX-...`) when the env
  isn't set — producing a 404 from npm masking the actual 401.
- **v0.3.0 tag exists on GitHub but did NOT publish to npm.** v0.3.0
  was the first publish attempt without an `NPM_TOKEN` fallback
  (PR #10 reverted the bootstrap); the npm-CLI-too-old issue
  surfaced immediately. No package was uploaded. v0.3.1 is the
  rebrand of v0.3.0's typed-parameter feature with the workflow
  fix applied. Skip v0.3.0.

## 0.3.0 — 2026-05-16

### Added

- **Typed parameters (`type: date | money | party`).** Long-form
  schema entries can declare a `type`, with optional `format` (date)
  or `currency` (money). Inputs are validated and normalized between
  value resolution and substitution; bad inputs hard-error with a
  per-key message (exit 4). See `PARAM_SCHEMA.md` §5 for the accepted
  shapes per type, the rejected ambiguous forms (Q3.1: US
  `MM/DD/YYYY` and European `DD/MM/YYYY` are rejected as ambiguous),
  and the v2 currency scope (Q3.2: USD only).
- **`--validate` now catches type errors** before draft runs. With
  `--json`, errors are emitted as a `type_errors` array on the
  result payload.
- **New public API:** `parseDateValue(raw)`, `formatDateValue(date, fmt)`,
  `parseMoneyValue(raw)` → minor units, `formatMoneyValue(minor, currency)`,
  `normalizeTypedValue(raw, placeholder)`, `normalizeTypedValues(placeholders, resolved)`.

### Schema-contract change

`PARAM_SCHEMA.md` §5 gains a "Typed parameters" section. Long-form
entries can now include `type`, `format`, and `currency` fields; short
form is unchanged. v0.3.0 schemas are forward-compatible with v0.2.x
readers (which will silently ignore the new fields, since they're
opt-in metadata on the long-form entry).

## 0.2.0 — 2026-05-16

### Added

- **`.docx` output round-trip.** Templates read from `.docx` (tier 3
  highlight detection) now write back as `.docx`, preserving runs,
  styles, paragraph breaks, and every non-document part of the package
  (`[Content_Types].xml`, relationships, images, headers, etc.).
  Default output filename is `<basename>-filled.docx` next to the
  input; override with `--output PATH.docx`. Schema-rescue, T1/T2
  bracket/mustache detection, and T4/T5 substitution all benefit
  too — any tier that detects a placeholder in a `.docx` template
  now substitutes back into the same runs.
- **`--output -` writes plain text to stdout** (Unix `-` convention).
  Use this on a `.docx` input to get the substituted body as text
  instead of a `.docx` file: `draft contract.docx --output -`.
- **`writeDocxBuffer(originalPath, newDocumentXml)`**, **`makeDocxOutputPath(inputPath)`**,
  **`substituteDocxXml(xml, placeholders, values, tier)`**, **`decideDocxOutput(opts, input)`**,
  and **`encodeXml(s)`** added to the public API for programmatic
  drivers. Same import surface as `substitute` and `extractDocxText`.

### Changed

- **Default output for `.docx` input is now `<basename>-filled.docx`,
  not stdout text.** Previously, `draft contract.docx` (no
  `--output`) extracted text and wrote substituted plain text to
  stdout. v0.2.0 writes `contract-filled.docx` next to the input.
  Pipelines that depended on the stdout-text behavior should pass
  `--output -` to opt back in.

### Split-run handling

When a placeholder's text spans multiple `<w:t>` runs in the source
`.docx` (Word sometimes splits runs at punctuation, auto-correct
boundaries, or comment anchors), v0.2.0 emits a warning and skips
that substitution rather than merging the runs and losing run-level
styling. The warning explains how to fix the source: open the
document, retype the placeholder so it lives in one run, save, and
retry. This decision is logged in `PARAM_SCHEMA.md` §2.

## 0.1.1 — 2026-05-16

### Fixed

- **Globally-installed `draft` binary now runs `main()`.** The
  entrypoint check at the bottom of `draft-cli.mjs` compared
  `fileURLToPath(import.meta.url)` against `resolve(process.argv[1])`.
  `resolve` only resolves relative → absolute; it does not resolve
  symlinks. When `npm install -g` creates a bin symlink (e.g.
  `/opt/homebrew/bin/draft → ../lib/node_modules/@drbaher/draft-cli/draft-cli.mjs`),
  `process.argv[1]` is the symlink path, so the comparison failed,
  `main()` was never called, and `draft --version` / `draft --demo`
  silently exited 0 with no output. The fix wraps `resolve(...)` in
  `realpathSync(...)` to canonicalize through symlinks.

### Hardened

- **CI smoke step asserts on stdout.** Previously the workflow ran
  `draft --version` and `draft --demo` but did not check exit code or
  expected output. Since the v0.1.0 bug made the bin a silent no-op
  with exit 0, smoke passed. The step now greps `draft --version`
  stdout for the `draft-cli ` prefix and `draft --demo` stdout for
  the substituted Party A value (`Acme Corporation`) — proving both
  that the bin runs and that substitution happens end-to-end. A
  regression of either shape would now fail CI.

## 0.1.0 — 2026-05-16

Initial release. Single-file Node.js CLI for deterministic placeholder
substitution in legal-document templates. Part of the contract-operations
suite ([cli.drbaher.com](https://cli.drbaher.com)).

### Added

- **Five-tier sequential-with-stop detection cascade.** First non-empty
  tier wins.
  - T1: `[Title Case]` brackets. Common Paper / YC SAFE / Bonterms.
  - T2: `{{Title Case}}` or `{{snake_case}}` mustache (opt-in via
    `--syntax mustache`).
  - T3: `.docx` highlight runs (yellow / green / cyan / magenta) via
    `jszip` + regex on `word/document.xml`.
  - T4: Heuristic dictionary (`Acme Corporation`, `John Doe`,
    `example@example.com`, `MM/DD/YYYY`, etc.). Warn-only by default;
    requires interactive confirmation or `--yes-heuristic` to substitute.
  - T5: LLM (Anthropic / OpenAI / explicit `DRAFT_LLM_*`). Auto-runs only
    when `.env` or process env configures a provider. `--no-llm` disables.
- **Schema file `<template>.params.json`** in short or long form.
  Auto-selected by presence of a top-level `_meta` key. Short form is
  `{ key: [aliases…] }`; long form supports `required` and `default`.
- **Value resolution precedence**: CLI flag > `--params` JSON >
  `--interactive` prompt > schema `default` > error.
- **Three modes**: main `draft`, `--list-placeholders`, `--validate`.
  All three support `--json` and `--why` structured explanation.
- **Composable I/O**: stdin (`-`), stdout default, `--output PATH`,
  `template-vault get` integration for `<category>/<name>[@version]` refs.
- **ANSI color** honors `NO_COLOR` and `FORCE_COLOR`; auto-disables off-TTY.
- **`--demo`** flag for a zero-file 30-second first run (`npx @drbaher/draft-cli@latest --demo`).
- **`--completion bash|zsh`** flag that emits a hand-rolled shell completion
  script to stdout. Completes top-level flags, the `--syntax` value
  (`bracket`/`mustache`), the `--completion` shell name, and file paths
  for `--params`/`--output`/`--dictionary`. No third-party generator.
- **`--check-llm`** runs a one-token roundtrip against the configured LLM
  provider — verifies env, auth, and reachability without sending any
  template content. Exits `0` on success, `1` if no provider is configured,
  `4` on provider error. Useful for CI / startup health checks in agent
  pipelines.
- **`--diff`** prints a per-placeholder substitution table to stdout and
  exits — never writes output. With `--json`, emits a structured `diff`
  array. Unresolved placeholders appear as `(unresolved)` / `to: null`
  rather than erroring, so the caller can decide what to do.
- **`-q` / `--silent`** suppresses all stderr (warnings, `--why` block,
  notes, heuristic confirmations) for fully-quiet pipeline use. Argument-
  parse errors still surface on the real stderr.
- **Schema-rescue for T1/T2 detection.** Bracketed runs whose inner text
  matches a schema-declared alias are admitted by detection even when
  the heuristic rule would reject them. Lets all-caps signature-block
  markers (`[COMPANY]`) and fill-in markers (`[_____________]`) be
  brought into the alias map without loosening the heuristic itself.
- **Typo guard** on `--<param-name>` flags. Unused flags are surfaced
  as warnings and named in the missing-required error, so a typo'd
  `--party-bb` doesn't silently fall through to a "missing party_b"
  error with no connection.
- **Exit codes**: `0` ok, `1` i/o, `2` validation, `3` template-vault failure,
  `4` LLM failure.
- **GitHub Actions CI**: Ubuntu × macOS × Node 18 / 20 / 22 test matrix,
  coverage gate at 80% line, and smoke job that packs + installs + runs
  `--version` + `--demo`.
- **GitHub Actions publish**: npm Trusted Publishing on `v*` tag push,
  with version-vs-tag check and `--provenance` attestation.
- **Test suite**: 106 tests across 13 files (`unittest`-style per concern),
  87.2% line coverage on `draft-cli.mjs`.

### Notes

- One runtime dependency only: `jszip` (MIT, zero transitive deps).
- The LLM tier sends template text only — no params, no `.env` contents,
  no other data. No network call by default.
- Configuration contract is captured in
  [PARAM_SCHEMA.md](PARAM_SCHEMA.md), reviewed and locked before code.
- **T1 bracket rule is permissive**, not strict Title-Case. Real
  Common Paper / YC SAFE / Bonterms templates use sentence-shaped
  placeholders with full punctuation (`[Today’s date]`, `[1 year(s)]`,
  `[Fill in city or county and state, i.e. "courts located in New Castle, DE"]`).
  The rule rejects markdown links (`[label](url)`), checkbox markers
  (`[x]`, `[ ]`), pure section refs (`[3.1]`), all-caps headings, and
  punctuation-only brackets — but otherwise admits anything bracketed
  that contains at least one letter. False positives are filtered with
  the schema file; false negatives in this domain are higher-cost.

## Deferred (post-v0.4.0 candidates)

Three of the original seven v1 "Deferred" entries shipped in v0.2.0,
v0.3.2, and v0.4.0 (see entries above). The four remaining items are
the next chunk of design work, with briefs in `V2_BRIEFS_REMAINING.md`:

- **Positional addressing.** Disambiguate same-text placeholders by
  index in the schema. The validated case: YC SAFE has
  `$[_____________]` twice — once for the valuation cap, once for
  the purchase amount. Smallest of the four (~150 LOC).
- **Cross-template `parties.json` registry.** Declare parties once
  with `ref:parties.<key>.<field>` references from schemas. Eliminates
  duplicating party metadata across every template (~250 LOC).
- **Multi-document bundles.** Resolve placeholders once and emit
  multiple documents in one call (MSA + Order Form + DPA with shared
  parameter values) (~250 LOC).
- **LLM inference from a deal description.** `--from-deal <path>`
  reads free-form deal text and asks the T5 LLM provider to fill the
  schema's parameters. Inverse of the existing T5 detection (~250 LOC).
- **`.docx` highlight detection beyond yellow/green/cyan/magenta.** v1
  ignores other colors (black/white/none) by design. Backlog, not in
  V2_BRIEFS_REMAINING (low priority).
