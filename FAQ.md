# FAQ

## Why `[Bracketed Title Case]` as the primary syntax instead of mustache?

The legal templates `draft-cli` targets — Common Paper, YC SAFE,
Bonterms, most house templates — use square-bracket placeholders. That's
the de-facto convention in the legal-tech corner of the world. Mustache
(`{{...}}`) is the engineering-template convention; it's supported via
`--syntax mustache` for cases where you've already written a template
in that flavor.

We deliberately don't auto-detect mixed conventions, only warn about
them. Auto-detection would surprise users whose template includes a
`{{quote}}` inside a code block.

## Why no computed placeholders like `[Effective Date + 2 years]`?

Deferred to v2. The hard part isn't the arithmetic — it's the date
parsing (handling `2026-06-01`, `June 1, 2026`, `the first business
day of Q3`, etc.) and the locale/timezone surface. v1 keeps the
substitution model trivially auditable: each placeholder is replaced
with the literal string the user supplied. No transformations, no
locale, no surprises.

The schema's long form reserves a future `"computed"` field for this.

## How is this different from a real templating engine like Handlebars or Jinja?

Three differences that matter for legal-doc workflows:

1. **Detection cascade.** A templating engine assumes the template
   already has explicit markup (`{{name}}`). `draft-cli` also handles
   `.docx` yellow highlights, generic-name heuristics, and an LLM
   fallback. You can hand it a contract that has *no* markup and get
   a list of likely placeholders.
2. **Alias-aware schema.** `[Party A]` and `[Disclosing Party]` and
   `[Originating Party]` are the same role with three names. The schema
   file maps multiple bracketed phrase forms to one canonical key.
   Most templating engines don't have this.
3. **Agent-friendly surface.** Every command emits a structured `--why`
   block and supports `--json`. The CLI is built for both humans and
   LLM agents to call.

If you're filling in `{{name}}` in an email template, Handlebars is
fine. If you're filling in `[Party A]` in an NDA and want to know
which of seven bracketed phrases got substituted from where, this is
the tool.

## Why is the LLM tier env-gated instead of a CLI flag?

Two reasons:

1. **Configuration vs invocation.** Whether you have an LLM provider
   available is a property of your environment, not of any individual
   `draft` invocation. Env is the right surface.
2. **Friction-as-consent.** Setting `ANTHROPIC_API_KEY=...` in `.env`
   takes a few seconds and is a deliberate act. Passing `--llm` on the
   command line is easy to muscle-memory into a one-liner without
   thinking about the network call. The env gate forces you to opt in
   once and re-affirm by leaving the key configured.

`--no-llm` exists so a script can disable T5 even when env happens to
be set. `--llm` exists so a script can fail-fast if env is not set
(instead of silently falling through to T4).

## Why does `--yes-heuristic` even exist? Can't draft-cli just substitute?

The heuristic dictionary contains generic-sounding values like
`Acme Corporation`, `John Doe`, `example@example.com`. If your real
counterparty happens to be named "Acme Corporation," substituting
silently would replace their actual name with whatever value you
supplied for `acme_corporation` — possibly the new party's name, but
possibly something worse.

The default behavior in non-interactive mode is **warn and do
nothing** — list the matches but leave them untouched. You either
add the matches to your template's `.params.json` (promoting them to
declared parameters) or pass `--yes-heuristic` to accept the risk
non-interactively.

In interactive mode, you get a `y/N` prompt per run.

## Why is `draft-cli` Node.js and not Python? The other Python CLI uses pipx.

The contract-operations suite has two Python CLIs (`template-vault-cli`,
`nda-review-cli` — both `pipx`-installed) and two JS CLIs (`docx2pdf-cli`,
`sign-cli` — both `npm`/`npx`-installed). `draft-cli` joined the JS lane
during the v1 design conversation, mirroring `docx2pdf-cli`'s posture
(single-file Node, npm-installed, stdlib + one carefully-chosen dep).
The decision lives in [CHANGELOG.md](CHANGELOG.md) v0.1.0.

The CLI is provider-and-runtime-agnostic from a user perspective: it
reads stdin, writes stdout, has clear exit codes, and integrates with
the Python siblings via subprocess (`template-vault get | draft -`).

## Why don't you ship `.docx` output?

Round-tripping back to `.docx` (preserving styles, numbered lists, run
formatting, and the original run boundaries) is its own problem domain.
The substituted text might be longer or shorter than the original;
Word's run-and-paragraph model means the substituted text either has
to inherit the entire surrounding run's formatting, or split itself
across runs in a way that respects the document's style table. None of
this is hard, but it's a different feature from "find and replace."

For now, `.docx` is **input-only** in v1 — you get text out. If you
need `.docx` out, run the text through `docx2pdf-cli` first, or open
the markdown output in Word.

## Why does the canonical key for `[1 year(s)]` look like `_1_year_s`?

Because the v1 bracket rule had to handle real Common Paper templates
(see the v0.1.0 CHANGELOG entry), it admits sentence-shaped placeholders
with full punctuation. The canonical-key derivation is a permissive slug
to make sure inferred keys are always valid snake_case identifiers:
non-alphanumeric runs collapse to `_`, leading digits get a `_` prefix,
and the result is capped at 60 chars.

Real templates with sentence-shaped placeholders should ship a
`<template>.params.json` schema that maps to clean keys. That's what
the Common Paper fixture in `tests/fixtures/cp-mutual-nda-coverpage.params.json`
does — `[1 year(s)]` maps to the clean key `term`.

## Can I extend the heuristic dictionary?

Yes. Pass `--dictionary path/to/your.json` — the file must be a JSON
array of strings. Your file **replaces** the bundled list (not extends
it). Copy `DEFAULT_HEURISTIC_DICT` out of `draft-cli.mjs` and edit if
you want a superset.

## What if a template has two `[_____________]` placeholders that should hold different values?

The YC SAFE has this exact problem: one `$[_____________]` is the
purchase amount, another `$[_____________]` is the post-money valuation
cap. Same bracketed text, different roles.

v1's alias-based matching treats them as one parameter. Substituting
`100000` for `purchase_amount` will replace **both** occurrences.

Workarounds for v1:

1. Edit the template before running draft-cli to make the placeholders
   distinguishable: `[Purchase Amount]` and `[Valuation Cap]`. Then
   the schema can map them independently.
2. Substitute the first, then run draft-cli again with a different
   value to substitute the second. Awkward but works for two-occurrence
   cases.
3. Run draft-cli, then manually fix the second occurrence in the output.

Positional-aware placeholder addressing (`[___1]`, `[___2]`) is a v2
candidate.

## My template has `[COMPANY]` in the signature block. draft-cli ignores it. Why?

`draft-cli`'s default detection rule rejects all-caps bracketed runs to
avoid false positives on section headings like `[CONFIDENTIALITY]`. But
all-caps signature-block placeholders are real, especially in older
templates and ones converted from `.docx`.

The fix: declare it in the schema file with the all-caps phrase as an
alias.

```json
{ "company": ["Company Name", "COMPANY"] }
```

`draft-cli` consults the schema's alias union during detection and
**rescues** otherwise-rejected runs that are explicitly declared. This
is documented in [PARAM_SCHEMA.md §5](PARAM_SCHEMA.md). Without the
schema, the run is silently skipped — which is intentional, but visible
when you run `--list-placeholders` and don't see the placeholder you
expected.

## How do I integrate with `template-vault-cli`?

`template-vault-cli` ships templates by category and name. `draft-cli`
recognizes `<category>/<name>[@version]` as a vault ref and shells out
to `template-vault get`:

```sh
draft nda/house-mutual --params deal.json
```

If `template-vault` isn't on `$PATH` or returns non-zero, `draft-cli`
exits with code `3` and surfaces the vault's error message. You can
also pipe explicitly:

```sh
template-vault get nda/house-mutual | draft - --params deal.json
```
