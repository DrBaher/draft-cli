# Getting started

A 10-minute walkthrough of the main flows. Assumes you have Node 18+.

## 1. Install (or try without installing)

```sh
npm install -g @drbaher/draft-cli
draft --version    # → draft-cli 0.9.0
```

To try without installing globally:

```sh
npx @drbaher/draft-cli@latest --demo
```

## 2. The 30-second demo

```sh
draft --demo
```

This substitutes three placeholders in a bundled NDA template and
prints the result. No file authoring required.

```
demo: substituting [Party A], [Party B], [Effective Date]
# Mutual Non-Disclosure Agreement (demo)

This Agreement is entered into on 2026-06-01 between Acme Corporation
and Vendor Inc. (collectively, the "Parties").
...
```

## 3. Your first real template

Save this as `simple-nda.md`:

```markdown
This Agreement is between [Party A] and [Party B], effective [Effective Date].
[Party A] and [Party B] agree to keep confidential information confidential.
```

List the placeholders draft-cli finds:

```sh
draft --list-placeholders simple-nda.md
```

Output:

```
party_a  (Party A)  ×2  [tier=bracket]
party_b  (Party B)  ×2  [tier=bracket]
effective_date  (Effective Date)  ×1  [tier=bracket]
```

Substitute via CLI flags:

```sh
draft simple-nda.md \
  --party-a "Acme Corporation" \
  --party-b "Vendor Inc." \
  --effective-date 2026-06-01
```

Substitute via a JSON file:

```sh
cat > deal.json <<'EOF'
{"party_a": "Acme Corporation", "party_b": "Vendor Inc.", "effective_date": "2026-06-01"}
EOF

draft simple-nda.md --params deal.json --output draft.md
cat draft.md
```

## 4. The `--why` block

```sh
draft simple-nda.md --params deal.json --why
```

`--why` emits a structured stderr block describing what happened:

```
draft: substituted 3 of 3 placeholders
why:
  input         = simple-nda.md
  tier          = bracket
  schema        = (none, inferred)
  placeholders  = 3 distinct, 5 occurrences
  resolved      = 3 (0 from CLI, 3 from --params, 0 interactive, 0 default)
  defaulted     = 0
  unresolved    = 0
  unmapped      = 0
  warnings      = 0
```

The block is parseable but also human-readable. It tells you which
tier matched, where each value came from, and whether anything got
defaulted, prompted, or left unresolved.

## 5. The `--json` mode

```sh
draft simple-nda.md --params deal.json --json
```

Stdout is a single JSON object that any downstream tool can parse:

```json
{
  "ok": true,
  "tier": "bracket",
  "output_path": null,
  "output": "This Agreement is between Acme Corporation and Vendor Inc.…",
  "placeholders": [ {…}, {…}, {…} ],
  "sources": { "party_a": "params", "party_b": "params", "effective_date": "params" },
  "warnings": [],
  "unmapped": []
}
```

Combine with `--output` to write the substituted text to disk AND get
the JSON report:

```sh
draft simple-nda.md --params deal.json --output draft.md --json | jq '.placeholders[].key'
```

## 6. Validate before drafting

`--validate` runs the same lookup but never writes output. Useful in
CI / pre-commit hooks:

```sh
draft --validate simple-nda.md --params deal.json && echo "ok"
```

Exit code `0` if every required placeholder resolves, `2` otherwise.
With `--json`, you get a structured `{ok: bool, missing: [...]}` report.

## 7. Alias-aware schema

Real legal templates use multiple bracketed phrase forms for the same
role: `[Party A]` and `[Disclosing Party]` are usually the same person.
Declare aliases in a sibling `<template>.params.json`:

```sh
cat > simple-nda.params.json <<'EOF'
{
  "party_a": ["Party A", "Disclosing Party"],
  "party_b": ["Party B", "Receiving Party"],
  "effective_date": ["Effective Date"]
}
EOF
```

Now `draft simple-nda.md --party-a "Acme"` substitutes **both**
`[Party A]` and `[Disclosing Party]` everywhere in the template with
`Acme`.

Long form supports defaults:

```json
{
  "_meta": { "schema_version": 1 },
  "party_a":        { "aliases": ["Party A"], "required": true },
  "effective_date": { "aliases": ["Effective Date"], "required": false, "default": "the date first written above" }
}
```

The presence of a top-level `_meta` key tells the parser to expect long
form. With `required: false` and a `default`, a missing CLI value falls
through to the default and validation still passes.

## 8. Real-world Common Paper template

```sh
curl -fsSL https://raw.githubusercontent.com/CommonPaper/Mutual-NDA/main/Mutual-NDA-coverpage.md \
  -o coverpage.md

draft --list-placeholders coverpage.md
```

You'll see sentence-shaped placeholders like `[Today's date]`,
`[1 year(s)]`, and the full
`[Evaluating whether to enter into a business relationship with the other party.]`.
The keys are ugly because they're auto-derived. Add a schema file to
give them clean names:

```sh
cat > coverpage.params.json <<'EOF'
{
  "purpose":         ["Evaluating whether to enter into a business relationship with the other party."],
  "effective_date":  ["Today’s date"],
  "term":            ["1 year(s)"],
  "governing_state": ["Fill in state"],
  "jurisdiction":    ["Fill in city or county and state, i.e. “courts located in New Castle, DE”"]
}
EOF

draft coverpage.md \
  --purpose "Evaluating whether to acquire Vendor Inc." \
  --effective-date 2026-06-01 \
  --term "2 years" \
  --governing-state "Delaware" \
  --jurisdiction "New Castle County, Delaware" \
  --output draft.md
```

The substituted draft preserves Markdown structure (the
`### Effective Date` heading, the checkbox markers `- [x]`, the
signature table) byte-for-byte except for the substituted placeholders.

## 9. `.docx` input

Pass a `.docx` directly:

```sh
draft your-template.docx --party-a "Acme" --output draft.md
```

Tier 1 (bracket) tries first against the extracted text. If the
`.docx` has no bracketed markup, tier 3 (highlight) catches
yellow / green / cyan / magenta highlighted runs as placeholders.
Output is plain markdown; `.docx` output round-trip is a v2 feature.

## 10. Tab completion (optional)

```sh
# bash
draft --completion bash >> ~/.bashrc

# zsh
draft --completion zsh > ~/.zsh/completions/_draft
```

After reloading your shell, tab-completion fills in flags, the
`--syntax bracket|mustache` argument, and file paths for `--params`,
`--output`, and `--dictionary`. The dynamic `--<param-name>` flags
aren't completed (they depend on the template), but every static flag
is.

## 11. Compose with the rest of the suite

```sh
template-vault get nda/house-mutual \
  | draft - --params deal.json \
  | nda-review-cli review --file - --playbook house \
  | docx2pdf - draft.pdf
```

Each tool reads from stdin, writes to stdout, and exits with distinct
codes. Add `--why` or `--json` at any step to inspect what happened.

---

For the full command reference, see [README.md](README.md#command-reference).
For the parameter contract details, see [PARAM_SCHEMA.md](PARAM_SCHEMA.md).
For architectural rationale, see [ARCHITECTURE.md](ARCHITECTURE.md).
