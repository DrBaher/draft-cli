# V2 Briefs — Remaining

Three of the original V2 briefs shipped in v0.2.0 (`.docx` output
round-trip), v0.3.2 (typed parameters), and v0.4.0 (computed
placeholders). The four briefs in this doc are the remaining v2
candidates, in size-ascending order. Format matches the original
V2_BRIEFS: shape, schema-contract impact, scope, open design questions
that need explicit decisions, draft CHANGELOG entry.

## Summary

| # | Item | Schema impact | Scope | Open Qs |
|---|------|--------------|-------|---------|
| 1 | Positional addressing | Significant | ~150 LOC (S) | 3 |
| 2 | `parties.json` registry | Significant | ~250 LOC (M) | 3 |
| 3 | Multi-document bundles | Medium | ~250 LOC (M) | 3 |
| 4 | LLM from deal text | Medium | ~250 LOC (M) | 3 |

Smallest first (`positional addressing`) is the recommended starting
point — it fixes a validated real-world template gap (YC SAFE) with
a contained schema change.

---

## 1. Positional addressing

**Shape.** Same placeholder text can appear multiple times in a
template with *different* semantic roles. Confirmed real case (YC
SAFE): `$[_____________]` appears twice — once as valuation cap,
once as purchase amount. Schema disambiguates by position:

```json
{
  "_meta": { "schema_version": 1 },
  "_____________": {
    "aliases": ["_____________"],
    "positions": [
      { "role": "valuation_cap",   "aliases_synonyms": ["valuation cap"] },
      { "role": "purchase_amount", "aliases_synonyms": ["purchase amount"] }
    ]
  }
}
```

CLI:

```sh
draft safe.docx \
  --value "_____________@0=$5,000,000" \
  --value "_____________@1=$100,000"
```

**Schema-contract impact.** Significant. New `positions` field on
long-form entries. Detection tier output gains a positional index
per occurrence. `PARAM_SCHEMA.md` §5 gets a new "Positional
addressing" subsection.

**Scope.** ~150 LOC. Smallest of the four. Mostly threading
positional info through detection → resolution → substitution. New
`--value KEY@N=VALUE` parsing.

**Open design questions:**

- **Q1.1 Index base.** 0 or 1? Recommend **0** (programmer
  convention; `@N` CLI grammar is geek territory anyway).
- **Q1.2 Length mismatch.** Schema declares 2 positions but
  detection finds 3 occurrences — error or fill remaining with
  default? Recommend **hard error** (schema and template are out of
  sync; silent fill hides bugs).
- **Q1.3 Bare-key CLI semantics.** `--value KEY=VALUE` (no `@N`)
  auto-applies to all positions, or is it an error when the key is
  positional? Recommend **auto-apply to all** (backward-compatible
  with existing CLI usage; less surprising for first-time positional
  users).

**Draft CHANGELOG entry:**

> **Positional addressing.** Same-text placeholders with different
> semantic roles can be disambiguated by position. Schema declares a
> `positions` array per key; CLI addresses individual positions
> with `--value "<text>@<index>=<value>"`. Bare `--value KEY=VALUE`
> still applies to all positions.

---

## 2. Cross-template `parties.json` registry

**Shape.** A repo-local `parties.json` declares known parties once:

```json
{
  "acme_corp": {
    "name": "Acme Corporation",
    "state": "Delaware",
    "cik": "0001234567"
  }
}
```

Templates' schemas reference them with `ref:`:

```json
{
  "_meta": { "schema_version": 1 },
  "party_a":       { "aliases": ["Party A"],       "default": "ref:parties.acme_corp.name" },
  "party_a_state": { "aliases": ["Party A State"], "default": "ref:parties.acme_corp.state" }
}
```

Refs resolve at value-resolution time, after CLI/`--params` (so
explicit user values still win). Failure cases: broken ref (unknown
party or unknown field) → hard error.

**Schema-contract impact.** Significant. New `ref:` value type.
New `parties.json` shape spec in `PARAM_SCHEMA.md`. New failure
mode for broken refs.

**Scope.** ~250 LOC. File loader, ref resolver, integration into
the value-resolution pipeline. Sensitive to file location.

**Open design questions:**

- **Q2.1 File location.** CWD, alongside template, or
  `~/.draft-cli/parties.json`? Recommend **CWD** by default with an
  opt-in `--parties PATH` flag.
- **Q2.2 Ref scope.** Refs only inside `.params.json` schema values,
  or also in CLI flags (`--party-a "ref:parties.acme_corp.name"`)?
  Recommend **params-only** initially; CLI flag refs add parsing
  ambiguity.
- **Q2.3 Versioning.** When Acme is renamed, `parties.json` updates
  and *all* historical drafts now produce different output if re-run.
  Defer history/versioning to v3; document the property in
  `PARAM_SCHEMA.md` as a known caveat.

**Draft CHANGELOG entry:**

> **Cross-template `parties.json` registry.** A repo-local
> `parties.json` declares known parties once; schema files reference
> them with `ref:parties.<key>.<field>`. Eliminates duplicating
> party metadata across every template. `--parties PATH` overrides
> the default location (CWD).

---

## 3. Multi-document bundles

**Shape.** Some deals span multiple templates (MSA + Order Form +
DPA). v2 lets you run `draft` once with one set of parameters and
emit all the documents:

```sh
draft bundle msa-order-dpa.json --params deal.json
```

Bundle file:

```json
{
  "_meta": { "schema_version": 1 },
  "outputs": [
    { "template": "msa/v3.md",        "output": "out/msa.md" },
    { "template": "order-form/v3.md", "output": "out/order-form.md" },
    { "template": "dpa/v2.md",        "output": "out/dpa.md" }
  ]
}
```

Each template still gets its own detection + substitution, but the
resolved parameter values are shared across documents.

**Schema-contract impact.** Medium. New "bundle" input mode. New
bundle file shape. `PARAM_SCHEMA.md` §2 (inputs/outputs) gains a
new column for bundle input.

**Scope.** ~250 LOC. Mostly orchestration over the existing
single-doc pipeline. Tricky bit: per-template schemas are unioned
so a placeholder declared in any template's schema applies to all
templates in the bundle.

**Open design questions:**

- **Q3.1 Bundle file format.** JSON or simpler `bundle.txt` (one
  template-path per line)? Recommend **JSON** to allow per-doc
  output paths and per-doc overrides.
- **Q3.2 Partial-failure policy.** 3 of 4 templates resolved, 1
  missing a required param — abort everything, or write the 3 that
  resolved? Recommend **abort-all** (atomicity is the v2 promise).
- **Q3.3 Schema union semantics.** Key declared in template A's
  schema applies to template B too? Recommend **yes** — that's the
  whole point of a bundle: one resolved value used across docs.

**Draft CHANGELOG entry:**

> **Multi-document bundles.** `draft bundle <bundle.json> --params
> deal.json` resolves placeholders once across multiple templates
> and emits each doc. Per-template schemas are unioned for detection
> and value resolution. Partial failure aborts the bundle.

---

## 4. LLM inference from a deal description

**Shape.** Today the T5 LLM tier infers placeholder values from the
*template text*. v2 adds the inverse: a `--from-deal <path>` flag
reads a free-form deal description and asks the LLM to extract
values for the schema's declared parameters:

```sh
draft nda.md --from-deal deal-notes.txt --output draft.md
```

```
# deal-notes.txt
Mutual NDA between Acme Corporation (DE) and Globex (UK), effective
June 1, 2026, for a 2-year term. Acme's counsel: Pat Smith,
psmith@acme.com.
```

LLM is asked to fill: `party_a → "Acme Corporation"`,
`party_a_state → "Delaware"`, `party_b → "Globex"`, etc.

**Schema-contract impact.** Medium. Doesn't alter detection or
substitution. New pre-substitution value-resolution step.
`PARAM_SCHEMA.md` §6 (precedence) gets a new tier:

```
CLI flag > --params JSON > --from-deal LLM > --interactive > schema default > error
```

**Scope.** ~250 LOC. New flag, new LLM prompt, integration into
value resolution. Reuses the existing T5 LLM client.

**Open design questions:**

- **Q4.1 Provider source.** Same provider as T5 (Anthropic / OpenAI
  / explicit `DRAFT_LLM_*`), or a separately-configured one?
  Recommend **same** — one network surface, one set of env vars.
- **Q4.2 Extra-key handling.** LLM returns values for keys not in
  the schema (noise). Drop silently or warn? Recommend **warn**.
- **Q4.3 Auto-implies `--llm`.** Does `--from-deal` auto-enable the
  network call, or does it require `--llm` explicitly too?
  Recommend **auto-imply** (single gesture; `--no-llm` still
  disables).

**Draft CHANGELOG entry:**

> **LLM inference from deal text.** `--from-deal <path>` reads a
> free-form deal description and asks the T5 provider to fill the
> schema's parameters. Result feeds the substitution pipeline at
> the same precedence as `--params`.

---

## Reading + ordering

Same approach as the original V2_BRIEFS:

- **Quick wins first:** #1 → #2 → #3 → #4 (size-ascending; ends with
  the most exploratory item)
- **User-value first:** #1 → #2 → #3 → #4 (positional fixes a
  validated gap; registry eliminates everyday copy-paste; bundles
  unlocks deal flows; LLM is exploratory)
- **Schema risk last:** #4 → #3 → #2 → #1 (defer the items that
  expand the locked `PARAM_SCHEMA` contract; LLM and bundles are
  more orchestration than schema)

For the next implementation pass, recommendation is quick-wins
order: #1 → #2 → #3 → #4. Each item gets its own
`claude/v2-<item>-<id>` branch + PR + schema-contract sign-off
checklist before merge.
