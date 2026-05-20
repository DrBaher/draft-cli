<p align="center">
  <img src="assets/icon.svg" width="120" alt="draft-cli">
</p>

# draft-cli

> Part of the contract-ops CLI suite. **draft-cli** (fill placeholders) → [**nda-review-cli**](https://github.com/DrBaher/nda-review-cli) (review, redline, negotiate) → [**docx2pdf-cli**](https://github.com/DrBaher/docx2pdf-cli) (DOCX → PDF) → [**sign-cli**](https://github.com/DrBaher/sign-cli) (signing + audit). Storage layer: [**template-vault-cli**](https://github.com/DrBaher/template-vault-cli). Drift detection: [**compare-cli**](https://github.com/DrBaher/compare-cli). [Showcase site](https://cli.drbaher.com/).

[![npm version](https://img.shields.io/npm/v/@drbaher/draft-cli.svg)](https://www.npmjs.com/package/@drbaher/draft-cli)
[![npm downloads](https://img.shields.io/npm/dw/@drbaher/draft-cli.svg)](https://www.npmjs.com/package/@drbaher/draft-cli)
[![CI](https://github.com/DrBaher/Draft-CLI/actions/workflows/ci.yml/badge.svg)](https://github.com/DrBaher/Draft-CLI/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Agent-first placeholder-filler for legal-document templates. Reads bracketed (`[Party A]`) or mustache markup, `.docx` yellow highlights, or generic-name heuristics; substitutes from CLI flags, a JSON params file, a shared `parties.json` registry, or — optionally — values extracted by an LLM from a free-form deal description; writes a ready-to-review draft as text or `.docx` (round-trip, runs and styles preserved). Schema-declared placeholders can be **typed** (`date` / `money` / `party`), **computed** (date arithmetic from another placeholder), **positional** (same text disambiguated by role), and **bundled** (fill multiple templates with one set of values).

**The asymmetry is the architecture**: every step is deterministic and machine-driven except the values themselves — which can come from a flag, a params file, a parties registry, or an LLM extracting them from a prose deal description that a human wrote.

<p align="center">
  <img src="assets/demo.svg" alt="draft-cli demo: list placeholders then substitute against the Common Paper NDA cover page" width="900">
</p>

## Run this

```bash
npx @drbaher/draft-cli@latest --demo
```

30 seconds, no file authoring required. Walks through a bracketed-template NDA with three placeholders, demoing the full cascade end-to-end. Or if you want to dive into a real template:

```bash
npm i -g @drbaher/draft-cli
draft --list-placeholders examples/cp-mutual-nda-coverpage.md
```

## Where to go next

| If you are… | Start here |
|---|---|
| **A new user** evaluating the tool | This README's [Quick start](#quick-start) and [What this gives you](#what-this-gives-you) |
| **A drafter** filling your first template | [GETTING_STARTED.md](GETTING_STARTED.md) — 10-minute walkthrough of the main flows |
| **An LLM agent** driving the CLI | [AGENTS.md](AGENTS.md) → `draft --list-placeholders --json` → [PARAM_SCHEMA.md](PARAM_SCHEMA.md) for the locked contract |
| **A schema author** declaring typed / computed / positional placeholders | [PARAM_SCHEMA.md](PARAM_SCHEMA.md) §5 |
| **A contributor** | [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md) |

Concept deep-dives live in [PARAM_SCHEMA.md](PARAM_SCHEMA.md) (the v1 + v2 contract); architecture in [ARCHITECTURE.md](ARCHITECTURE.md); FAQ in [FAQ.md](FAQ.md).

## Quick start

```bash
# Install
npm i -g @drbaher/draft-cli

# Or run without installing
npx @drbaher/draft-cli@latest --demo

# After install, the binary is named `draft`
draft --version
draft --demo
```

Requires Node.js ≥ 18. Tested on Ubuntu and macOS, Node 18 / 20 / 22.

### Shell completion

```bash
# bash
draft --completion bash >> ~/.bashrc

# zsh
draft --completion zsh > ~/.zsh/completions/_draft
# ensure ~/.zsh/completions is in fpath, then: autoload -U compinit && compinit
```

Completes flags, the `--syntax bracket|mustache` value, `--completion bash|zsh`, and file paths for `--params`, `--output`, `--dictionary`.

## What this gives you

- **Five-tier detection cascade** — `[Title Case]` brackets / `{{mustache}}` / `.docx` highlights (yellow/green/cyan/magenta) / heuristic dictionary / optional LLM. First tier with hits wins; the rest are skipped. Deterministic through tier 4.
- **`.docx` round-trip** — read a `.docx` template, fill placeholders, write `<basename>-filled.docx` with runs/styles/paragraph-breaks preserved. T3 highlight detection works against real templates (Common Paper, YC SAFE).
- **Schema file** for canonical keys, alias phrases, defaults, required-ness, and the v2 fields below (`type`, `format`, `currency`, `computed`, `positions`). Without a schema, every detected bracketed phrase is treated as a required parameter.
- **Typed parameters** — `type: date | money | party` validates and normalizes inputs before substitution. `"2027-01-15"` → `"January 15, 2027"`; `"$5M"` → `"$5,000,000.00"`. Bad inputs exit 2 with per-key error.
- **Computed placeholders** — derive one placeholder's value from another via date arithmetic: `{ "from": "effective_date", "op": "+", "value": "2 years" }`. Cycle detection at schema parse time.
- **Positional addressing** — same placeholder text with different semantic roles, addressed by position. Validated against the YC SAFE `$[_____________] × 2` case.
- **`parties.json` registry** — declare known parties once; schemas reference `ref:parties.<key>.<field>`. Eliminates duplicating party metadata across templates.
- **Multi-document bundles** — fill multiple templates with one shared set of values: `draft --bundle deal.bundle.json --params deal.json`. Abort-all on any pre-write error.
- **LLM-from-deal inference** — `--from-deal PATH` reads a free-form deal description and asks the configured T5 provider (Anthropic / OpenAI / `DRAFT_LLM_*`) to fill the schema's parameters. CLI / `--params` still win over inferred values.
- **Composable I/O** — stdin (`-`), stdout default, `--output PATH`, `template-vault get` integration for `<category>/<name>[@version]` template refs.
- **Three modes** — `draft` (substitute and emit), `--list-placeholders` (enumerate), `--validate` (completeness check). All support `--json` and `--why`.
- **Single file, stdlib + `jszip`**, no telemetry, local-first. Network only when the LLM tier is explicitly configured.

## End-to-end transcript

```sh
$ cat > nda.md <<'EOF'
This Agreement is between [Party A] and [Party B], effective [Effective Date].
[Party A] and [Party B] agree to keep confidential information confidential.
EOF

$ draft --list-placeholders nda.md
party_a  (Party A)  ×2  [tier=bracket]
party_b  (Party B)  ×2  [tier=bracket]
effective_date  (Effective Date)  ×1  [tier=bracket]

$ draft nda.md --party-a "Acme" --party-b "Vendor Inc." --effective-date 2026-06-01
This Agreement is between Acme and Vendor Inc., effective 2026-06-01.
Acme and Vendor Inc. agree to keep confidential information confidential.

$ cat > deal.json <<'EOF'
{"party_a": "Acme", "party_b": "Vendor Inc.", "effective_date": "2026-06-01"}
EOF

$ draft nda.md --params deal.json --output draft.md --why
draft: substituted 3 of 3 placeholders → draft.md
why:
  input         = nda.md
  tier          = bracket
  schema        = (none, inferred)
  placeholders  = 3 distinct, 5 occurrences
  resolved      = 3 (0 from CLI, 3 from --params, 0 interactive, 0 default)
  defaulted     = 0
  unresolved    = 0
  unmapped      = 0
  warnings      = 0

$ draft --validate nda.md --params deal.json && echo "ok"
ok: 3 parameter(s) resolved
ok
```

## Detection cascade

`draft-cli` finds placeholders by trying five strategies in order. The **first non-empty tier wins** and the others are skipped.

| Tier | Strategy             | When                                      |
| ---- | -------------------- | ----------------------------------------- |
| 1    | `[Title Case]`       | Default. Matches Common Paper / YC SAFE / Bonterms convention. |
| 2    | `{{Title Case}}`     | Opt-in with `--syntax mustache`.          |
| 3    | `.docx` highlights   | Auto on `.docx` input. Yellow / green / cyan / magenta runs. |
| 4    | Heuristic dictionary | Bundled list of generic names (`Acme Corporation`, `John Doe`, `example@example.com`, etc.). Warn-only by default. |
| 5    | LLM                  | Last resort. Runs only when `.env` or process env configures `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `DRAFT_LLM_*`. |

The cascade is **deterministic through tier 4**. Tier 5 is the only non-deterministic step and runs only when you've explicitly configured a provider key. Pass `--no-llm` to disable it even when configured. Pass `--no-heuristic` to skip tier 4.

See [PARAM_SCHEMA.md](PARAM_SCHEMA.md) for the full contract.

## Schema file (optional)

A sibling `<template>.params.json` lets you declare canonical keys, alias phrases, defaults, and required-ness. The **long form** (gated on `_meta`) unlocks the v2 fields:

```json
{
  "_meta": { "schema_version": 1 },
  "party_a":         { "aliases": ["Party A"], "required": true, "type": "party" },
  "effective_date":  { "aliases": ["Effective Date"], "type": "date", "format": "MMMM d, yyyy" },
  "term_end":        { "aliases": ["Term End"], "type": "date",
                       "computed": { "from": "effective_date", "op": "+", "value": "2 years" } },
  "purchase_amount": { "aliases": ["Purchase Amount"], "type": "money", "currency": "USD" },
  "blank":           { "aliases": ["_____________"], "type": "money", "currency": "USD",
                       "positions": [{ "role": "valuation_cap" }, { "role": "purchase_amount" }] }
}
```

With a schema, `draft-cli` substitutes **only** declared parameters and leaves other bracketed text untouched. Without one, every detected bracketed phrase is treated as a required parameter.

The **short form** is just an aliases map: `{ "party_a": ["Party A"] }`.

See [PARAM_SCHEMA.md](PARAM_SCHEMA.md) §5 for the full schema contract and the locked design decisions per v2 feature.

## Command reference

```
draft <template>              fill placeholders and emit the result
draft <category>/<name>       pull via `template-vault get`
draft -                       template body on stdin
draft --demo                  bundled demo, no file needed
draft --list-placeholders <t> enumerate placeholders and exit
draft --validate <t> --params completeness check, no output
draft --bundle <bundle.json>  multi-doc bundle mode (v0.7.0)

OPTIONS
  --params FILE          JSON file of param values (snake_case keys)
  --parties PATH         parties.json registry for ref:parties.<key>.<field>  (v0.6.0)
  --bundle PATH          fill multiple templates in one invocation             (v0.7.0)
  --from-deal PATH       LLM-extract values from a free-form deal description  (v0.8.0)
  -o, --output PATH      write to PATH (default: stdout). `-` forces stdout.
                         For .docx input, default is <basename>-filled.docx   (v0.2.0)
  --syntax bracket|mustache
  -i, --interactive      prompt for missing required parameters
  --why                  structured explanation to stderr
  --json                 machine-readable result on stdout
  -q, --silent           suppress all stderr (warnings, --why, notes)
  --no-heuristic         disable tier 4
  --yes-heuristic        substitute tier-4 matches without confirmation
  --no-llm               disable tier 5 + --from-deal even when env is configured
  --llm                  assert that env is configured (fail-fast if not)
  --check-llm            one-token roundtrip to verify provider config
  --diff                 show substitution table without writing output
  --dictionary PATH      override the bundled heuristic dictionary
  --<param-name> VALUE   set a parameter directly (kebab → snake_case)
  -h, --help             show full help
  -V, --version          show version
```

Exit codes: `0` ok · `1` i/o · `2` validation (incl. schema / typed parameter / computed / ref / positional) · `3` template-vault failure · `4` llm failure.

## LLM tier (env-gated, opt-in)

When tiers 1–4 all find nothing, `draft-cli` falls back to a language model **only if** a provider is configured. Resolution order: the environment first (`.env` in the working directory, then `process.env` — process wins), and if neither configures a provider, the suite-shared **`~/.config/contract-ops/llm.json`** (then the legacy `~/.config/draft-cli/llm.json`). Configure the shared file once and every contract-ops CLI that supports an LLM picks it up; an explicitly-exported env key always overrides it.

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-…' >> .env
draft some-freeform-draft.md          # tier 5 auto-runs when 1-4 empty
```

Supported providers: Anthropic (`ANTHROPIC_API_KEY`), OpenAI (`OPENAI_API_KEY`), or explicit (`DRAFT_LLM_PROVIDER` + `DRAFT_LLM_API_KEY` + optional `DRAFT_LLM_MODEL`) — or a `{ "provider", "api_key", "model" }` object in `~/.config/contract-ops/llm.json`. The LLM receives template text only — no params file, no `.env` contents, no other data. Pass `--no-llm` to disable even when configured.

**v0.8.0 inverse direction — `--from-deal PATH`:** feed prose deal notes and the LLM extracts values for the schema's placeholders (instead of inferring where placeholders are). Uses the same provider config. Errors on provider missing, network failure, or non-JSON response. CLI / `--params` values always win over LLM-inferred ones. See [PARAM_SCHEMA.md](PARAM_SCHEMA.md) §5.

## Composability

`draft-cli` reads from stdin, writes to stdout by default, and exits with distinct codes for each failure class. It composes with `template-vault-cli` on the read side and `nda-review-cli` / `docx2pdf-cli` / `sign-cli` on the write side:

```bash
# Read side — pull a versioned template and fill it from a free-form deal note
template-vault get nda/house-mutual@v3 \
  | draft - --from-deal deal-notes.txt --params parties.json > filled.md

# Write side — review the draft (a gate), then render the agreed .docx and sign it offline
nda-review-cli review --file filled.md --playbook policy.json --why
docx2pdf agreed.docx agreed.pdf
sign document agreed.pdf --signer "Counsel" --signer-email counsel@counterparty.com
```

Each tool stays small and replaceable. None of them know about each other beyond the standard `stdin / stdout / argv / exit codes` contract.

## Documentation

- [GETTING_STARTED.md](GETTING_STARTED.md) — 10-minute walkthrough of the main flows.
- [AGENTS.md](AGENTS.md) — JSON shapes, exit codes, library use; everything an LLM agent driving `draft-cli` needs.
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the cascade, schema, and substitution pipeline fit together.
- [PARAM_SCHEMA.md](PARAM_SCHEMA.md) — v1 + v2 schema contract; locked decisions per feature.
- [FAQ.md](FAQ.md) — common questions about detection rules, T4 heuristics, and the LLM tier.
- [V2_BRIEFS_REMAINING.md](V2_BRIEFS_REMAINING.md) — design briefs for the four v2 items shipped after v0.1.x; historical now that all four have landed.
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities.
- [CHANGELOG.md](CHANGELOG.md) — every shipped version with locked design decisions.

## License

MIT. See [LICENSE](LICENSE).
