# draft-cli

A **deterministic placeholder-filler** for legal-document templates. Reads
bracketed (`[Party A]`) or mustache (`{{Party A}}`) markup, `.docx` yellow
highlights, or generic-name heuristics; substitutes from CLI flags, a JSON
params file, or an interactive prompt; writes a ready-to-review draft.

Single-file Node.js. One runtime dependency (`jszip`, for `.docx`). Local-first,
no telemetry, MIT-licensed. Part of the contract-operations suite (see
[cli.drbaher.com](https://cli.drbaher.com)).

---

## What it does

You have a template. You have a deal. You want a draft you can review and
send. The middle step — finding every `[Party A]`, `[Effective Date]`, and
`[State of California]` and replacing them with real values — is mechanical,
deterministic work that doesn't need an LLM and shouldn't need to leave your
machine.

```
template-vault get nda/house-mutual | draft - \
    --party-a "Acme Corporation" \
    --party-b "Vendor Inc." \
    --effective-date 2026-06-01 \
    --output draft.md
```

Or via a params file:

```
draft nda/house-mutual --params deal-acme.json --output draft.md
```

`draft` does **only** that step. Templates come from `template-vault-cli` or
any markdown / .docx / stdin source. Review and red-line happens in
`nda-review-cli`. Conversion to PDF goes through `docx2pdf-cli`. Signing
goes through `sign-cli`. Each tool stays small and composable.

---

## Install

```sh
npm install -g @drbaher/draft-cli
```

Or run without installing:

```sh
npx @drbaher/draft-cli@latest --demo
```

Requires Node.js ≥ 18. Tested on Ubuntu and macOS, Node 18 / 20 / 22.

### Shell completion

```sh
# bash
draft --completion bash >> ~/.bashrc

# zsh
draft --completion zsh > ~/.zsh/completions/_draft
# ensure ~/.zsh/completions is in fpath, then: autoload -U compinit && compinit
```

Completes flags, the `--syntax bracket|mustache` value, `--completion bash|zsh`,
and file paths for `--params`, `--output`, and `--dictionary`.

---

## 30-second first run

No file authoring required. The bundled demo runs end-to-end:

```sh
npx @drbaher/draft-cli@latest --demo
```

```
demo: substituting [Party A], [Party B], [Effective Date]
# Mutual Non-Disclosure Agreement (demo)

This Agreement is entered into on 2026-06-01 between Acme Corporation
and Vendor Inc. (collectively, the "Parties").

1. Confidentiality. Acme Corporation and Vendor Inc. agree to keep confidential
   any information disclosed under this Agreement.

2. Term. This Agreement remains in effect for two years from the
   2026-06-01.
```

What just happened: `draft-cli` detected three bracketed placeholders
(`[Party A]`, `[Party B]`, `[Effective Date]`), mapped them to the
canonical keys `party_a`, `party_b`, `effective_date`, and substituted
in pre-canned demo values. Real runs use your own template and your own
values.

---

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

---

## Detection cascade

`draft-cli` finds placeholders by trying five strategies in order. The
**first non-empty tier wins** and the others are skipped.

| Tier | Strategy             | When                                      |
| ---- | -------------------- | ----------------------------------------- |
| 1    | `[Title Case]`       | Default. Matches Common Paper / YC SAFE / Bonterms convention. |
| 2    | `{{Title Case}}`     | Opt-in with `--syntax mustache`.          |
| 3    | `.docx` highlights   | Auto on `.docx` input. Yellow / green / cyan / magenta runs. |
| 4    | Heuristic dictionary | Bundled list of generic names (`Acme Corporation`, `John Doe`, `example@example.com`, etc.). Warn-only by default. |
| 5    | LLM                  | Last resort. Runs only when `.env` or process env configures `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `DRAFT_LLM_*`. |

The cascade is **deterministic through tier 4**. Tier 5 is the only
non-deterministic step and runs only when you've explicitly configured a
provider key. Pass `--no-llm` to disable it even when configured. Pass
`--no-heuristic` to skip tier 4.

See [PARAM_SCHEMA.md](PARAM_SCHEMA.md) for the full contract.

---

## Schema file (optional)

A sibling `<template>.params.json` lets you declare canonical keys, alias
phrases, defaults, and whether each parameter is required.

**Short form:**

```json
{
  "party_a": ["Party A", "Disclosing Party"],
  "party_b": ["Party B", "Receiving Party"],
  "effective_date": ["Effective Date"]
}
```

**Long form** (gates on `_meta`):

```json
{
  "_meta": { "schema_version": 1 },
  "party_a":        { "aliases": ["Party A"], "required": true },
  "effective_date": { "aliases": ["Effective Date"], "required": false, "default": "the date first written above" }
}
```

With a schema, `draft-cli` substitutes **only** declared parameters and
leaves other bracketed text untouched. Without one, every detected
bracketed phrase is treated as a required parameter.

---

## Command reference

```
draft <template>              fill placeholders and emit the result
draft <category>/<name>       pull via `template-vault get`
draft -                       template body on stdin
draft --demo                  bundled demo, no file needed
draft --list-placeholders <t> enumerate placeholders and exit
draft --validate <t> --params completeness check, no output

OPTIONS
  --params FILE          JSON file of param values (snake_case keys)
  -o, --output PATH      write to PATH (default: stdout)
  --syntax bracket|mustache
  -i, --interactive      prompt for missing required parameters
  --why                  structured explanation to stderr
  --json                 machine-readable result on stdout
  -q, --silent           suppress all stderr (warnings, --why, notes)
  --no-heuristic         disable tier 4
  --yes-heuristic        substitute tier-4 matches without confirmation
  --no-llm               disable tier 5 even when env is configured
  --llm                  assert that env is configured (fail-fast if not)
  --check-llm            one-token roundtrip to verify provider config
  --diff                 show substitution table without writing output
  --dictionary PATH      override the bundled heuristic dictionary
  --<param-name> VALUE   set a parameter directly (kebab → snake_case)
  -h, --help             show full help
  -V, --version          show version
```

Exit codes: `0` ok · `1` i/o · `2` validation · `3` template-vault failure
· `4` llm failure.

---

## LLM tier (env-gated, opt-in)

When tiers 1–4 all find nothing, `draft-cli` falls back to a language model
**only if** a provider key is in the environment. Read order: `.env` in
the working directory, then `process.env` (process wins).

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-…' >> .env
draft some-freeform-draft.md          # tier 5 auto-runs when 1-4 empty
```

Supported providers: Anthropic (`ANTHROPIC_API_KEY`), OpenAI
(`OPENAI_API_KEY`), or explicit (`DRAFT_LLM_PROVIDER` + `DRAFT_LLM_API_KEY`
+ optional `DRAFT_LLM_MODEL`). The LLM receives template text only — no
params file, no `.env` contents, no other data. Pass `--no-llm` to disable
even when configured.

---

## Composability

`draft-cli` reads from stdin, writes to stdout by default, and exits with
distinct codes for each failure class. It composes with `template-vault-cli`
on the read side and `nda-review-cli` / `docx2pdf-cli` / `sign-cli` on
the write side:

```sh
template-vault get nda/house-mutual \
  | draft - --params deal-acme.json \
  | nda-review review - --playbook house \
  | docx2pdf - draft.pdf
```

The `--why` and `--json` flags make every step inspectable by agents and
shell pipelines.

---

## Part of the contract-operations suite

`draft-cli` is one of a small set of single-purpose CLIs for contract
operations. See [cli.drbaher.com](https://cli.drbaher.com) for the suite
landing page.

- **[nda-review-cli](https://github.com/DrBaher/nda-review-cli)** —
  draft, review, and negotiate NDAs against your own house playbook.
  Deterministic by default; opt-in LLM augmentation.
- **[docx2pdf-cli](https://github.com/DrBaher/docx2pdf-cli)** —
  honest DOCX → PDF conversion with batch processing, parallel runs,
  font validation.
- **[sign-cli](https://github.com/DrBaher/sign-cli)** —
  fully-offline PAdES e-signature with hash-chained audit events,
  RFC 3161 timestamps.

`template-vault-cli` (a Git-backed, clause-aware package manager for
legal-document templates) is the natural upstream of `draft-cli` and
will join the suite when it ships.

---

## Documentation

- [GETTING_STARTED.md](GETTING_STARTED.md) — 10-minute walk-through of every flow.
- [AGENTS.md](AGENTS.md) — JSON shapes, exit codes, library use; everything an LLM agent driving `draft-cli` needs.
- [PARAM_SCHEMA.md](PARAM_SCHEMA.md) — locked v1 contract: cascade, schema file, precedence.
- [ARCHITECTURE.md](ARCHITECTURE.md) — single-file rationale, substitution model, .docx parsing.
- [FAQ.md](FAQ.md) — design questions and trade-offs.
- [SECURITY.md](SECURITY.md) — threat model and how to report a vulnerability.
- [CHANGELOG.md](CHANGELOG.md) — release notes and the v2 "Deferred" list.
- [CONTRIBUTING.md](CONTRIBUTING.md) — scope rules and release flow.

## License

MIT. See [LICENSE](LICENSE).
