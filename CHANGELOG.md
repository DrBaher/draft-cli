# Changelog

All notable changes to this project will be documented in this file. The
format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and the project adheres to semantic versioning once it leaves 0.x.

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

## Deferred (v2 candidates)

- **`.docx` output round-trip.** v1 writes plain markdown even from a
  `.docx` input. Re-writing back into a `.docx` (preserving styles,
  numbering, and run formatting) is a separate problem.
- **Computed placeholders** (`[Effective Date + 2 years]`). The long-form
  schema reserves a future `"computed"` field.
- **Typed parameters** (`party`, `date`, `money` with format validation).
  Schema reserves a future `"type"` field.
- **LLM-assisted parameter inference from a deal description.** v1's T5
  only suggests placeholders from template text — not from external prose
  describing the deal.
- **Cross-template parameter registry** (`parties.json` remembering
  addresses, e-signature contacts, etc.). Additive — would layer
  underneath `--params` in precedence.
- **Multi-document bundles** (MSA + SOW sharing parameters in one call).
  v1 is one document per invocation.
- **`.docx` highlight detection beyond yellow/green/cyan/magenta.** v1
  ignores other colors (black/white/none) by design.
