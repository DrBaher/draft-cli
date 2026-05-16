# Changelog

All notable changes to this project will be documented in this file. The
format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and the project adheres to semantic versioning once it leaves 0.x.

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
- **`--demo`** flag for a zero-file 30-second first run (`npx draft-cli@latest --demo`).
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
