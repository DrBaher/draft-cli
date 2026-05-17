# PARAM_SCHEMA — v1 contract (locked)

This doc is the source of truth for how `draft-cli` discovers placeholders,
maps them to parameters, validates inputs, and reports results. Locked
after Q1–Q4 and D1–D4 review. Reviewer: DrBaher.

---

## 1. Stack & posture

- **Runtime:** Node.js ≥ 18 (global `fetch`, `node:test`, `--env-file`-style behavior re-implemented inline so we don't require ≥ 20.6).
- **Distribution:** `npm install -g @drbaher/draft-cli`, single-file `draft-cli.mjs` shebang executable.
- **Runtime dependencies (v1):** exactly one — `jszip` (MIT, zero transitive) for `.docx` unzip. Everything else uses Node's stdlib. LLM tier uses global `fetch` directly; no SDK dep.
- **Local-first.** No telemetry. The only network call is the optional LLM tier and only when explicitly configured (see §3 T5).

## 2. Inputs and outputs

```
draft <template> [flags]
draft - [flags]                  # template body from stdin
draft <cat>/<name>[@ver] ...     # pulls via `template-vault get`
```

- **Input forms accepted:** `path/to/file.md`, `path/to/file.txt`, `path/to/file.docx`, stdin (`-`), or a `template-vault` ref shaped `<category>/<name>[@version]`. Vault refs shell out to `template-vault get` — no library import.
- **Output:** depends on input kind and `--output` target.

  | Input        | `--output`          | Output                                |
  | ------------ | ------------------- | ------------------------------------- |
  | text (any)   | absent              | plain text on stdout                  |
  | text (any)   | `-`                 | plain text on stdout                  |
  | text (any)   | `PATH` (any ext)    | plain text written to `PATH`          |
  | `.docx`      | absent              | `.docx` to `<basename>-filled.docx`   |
  | `.docx`      | `PATH.docx`         | `.docx` to `PATH.docx`                |
  | `.docx`      | `-`                 | plain text (substituted body) on stdout |
  | `.docx`      | `PATH` (non-`.docx`)| plain text written to `PATH`          |

  `.docx` output is a round-trip: the original `.docx` package is reopened, the substituted text is written back into the same `<w:t>` runs that detection found, and all other parts of the package (relationships, images, headers, `[Content_Types].xml`, etc.) pass through unchanged. Run-level styling is preserved for placeholders that live in a single run. When a placeholder spans multiple `<w:t>` runs in the source (common with bracketed templates like Common Paper, where `[` carries different styling from the inner text) and `--strict-runs` is **not** set, v0.9.0 merges the contributing runs into one that uses the **first** run's `<w:rPr>`; in-placeholder styling variations are lost but flanking text keeps its styling, and a `warning: docx run merge applied for "<key>"` is emitted. With `--strict-runs`, cross-run placeholders are skipped (v0.2.0 behavior) and the user is told to retype the placeholder in Word. Placeholders that span a `<w:p>` paragraph boundary are always skipped — locked decision Q1.1 (revised in v0.9.0).
- `--json`, `--diff`, `--validate`, and `--list-placeholders` all override the `.docx` round-trip and produce text/JSON to stdout (or to `--output PATH`, when provided).
- **Encoding:** UTF-8 in, UTF-8 out. No BOM written; BOM tolerated on read.

## 3. Detection cascade (sequential-with-stop)

The cascade runs each tier in order. The first tier that returns **≥ 1 placeholder** wins and the others are skipped. The active tier is reported in `--why` and in `--json` output.

| Tier | Name           | Deterministic | Default | Trigger to skip                  |
| ---- | -------------- | ------------- | ------- | -------------------------------- |
| T1   | Bracket        | ✅            | on      | `--syntax mustache` selected     |
| T2   | Mustache       | ✅            | opt-in  | not selected via `--syntax`      |
| T3   | DOCX highlight | ✅            | auto    | input not `.docx`                |
| T4   | Heuristic      | ✅            | on      | `--no-heuristic`                 |
| T5   | LLM            | ❌            | env-gated | no LLM provider configured     |

### T1 — Bracket `[...]`

A bracketed run is treated as a placeholder when **all** of:

1. `[...]`, no nested brackets, length 1–200.
2. **Not** immediately followed by `(` — i.e. not a markdown link
   (`[label](url)` is skipped).
3. **Not** a checkbox marker — inner matches `[ xX]{1,3}` is skipped
   (`[x]`, `[ ]`, `[X]`, etc.).
4. **Not** a pure section reference — inner matches `\d+(\.\d+)*$` is
   skipped (`[3.1]`, `[4.2.1]`).
5. Inner contains **at least one letter** (excludes `[___]`, `[---]`).
6. Inner is **not entirely uppercase letters** (excludes
   `[CONFIDENTIALITY]`, `[ARTICLE I]`).

Examples that match: `[Party A]`, `[Effective Date]`,
`[State of California]`, `[Today’s date]`, `[1 year(s)]`,
`[Fill in state]`,
`[Evaluating whether to enter into a business relationship with the other party.]`.

Examples that don't: `[3.1]`, `[ARTICLE I]`, `[CONFIDENTIALITY]`,
`[x]`, `[ ]`, `[the docs](https://example.com)`.

The rule is intentionally permissive because real legal templates
(Common Paper, YC SAFE, Bonterms) use sentence-shaped placeholders
with full punctuation. False positives are filtered via the
`<template>.params.json` schema (§5); false negatives in this domain
are higher-cost than false positives.

**Canonical key derivation** (when no schema is present): inner →
lowercase → non-alphanumeric runs collapsed to `_` → leading/trailing
`_` stripped → prefix `_` if leading char is a digit → truncated at 60
chars. So `[Party A]` → `party_a`, `[1 year(s)]` → `_1_year_s`,
`[Today’s date]` → `today_s_date`. Templates with long sentence-shaped
placeholders should ship a schema file to give them clean keys.

Cross-references like `[See Section 4]` *do* match T1 by design. The
**schema file** (§5) is the disambiguation tool: when present, only declared
keys substitute and other bracketed runs are left untouched.

### T2 — Mustache `{{...}}`

Opt-in via `--syntax mustache`. Matches `{{<inner>}}` where `<inner>` is
either Title Case (same rule as T1 inner) or snake_case `[a-z][a-z0-9_]{0,78}`.

Mixed-convention templates (both `[X]` and `{{X}}` present) emit a
`doctor`-style stderr warning. The selected `--syntax` family is the only
one substituted; the other is left untouched in output.

### T3 — DOCX highlight

Triggered only when input is `.docx`. Unzip with `jszip`, read
`word/document.xml`, regex-scan for highlight runs:

```xml
<w:r>
  <w:rPr><w:highlight w:val="yellow"/></w:rPr>
  <w:t>Acme Corporation</w:t>
</w:r>
```

Highlight colors recognized as placeholders: `yellow`, `green`, `cyan`,
`magenta` (Word's "highlight as TODO" colors). Black/white/auto highlights
are ignored.

The captured text becomes the bracket-equivalent. So `Acme Corporation`
in a yellow highlight is treated identically to `[Acme Corporation]` from
T1 — same canonical-key derivation, same alias machinery.

Output for .docx input is plain markdown: the text is extracted in
document order (one paragraph per `<w:p>`), highlights are replaced, and
the result is written to stdout or `--output`. Round-trip to `.docx`
is **v2**.

### T4 — Generic-name heuristic

A bundled dictionary (`config/heuristic.json` shipped in the wheel) lists
known generic placeholder values: `Acme Corporation`, `Acme Inc`,
`Foo Corp`, `John Doe`, `Jane Roe`, `123 Main Street`, `example@example.com`,
`555-555-1234`, `MM/DD/YYYY`, `TBD`, `[INSERT ___]`, etc. Curated, not
inferred.

Matches against the **untemplated body** (after T1–T3 ran and found
nothing). Case-sensitive whole-word matching.

**Safety gate (D3 locked):** T4 matches **never substitute silently**.
Behavior:

- In a TTY without `--yes-heuristic`: print each match, prompt `y/N`.
- In a non-TTY without `--yes-heuristic`: print a warning block and
  **leave matches untouched**. Substitution requires explicit opt-in.
- With `--yes-heuristic`: substitute non-interactively (the user
  has taken ownership).
- `--no-heuristic` disables T4 entirely.

Dictionary override: `--dictionary PATH` replaces (not extends) the bundled list.

### T5 — LLM (last resort, env-gated)

Runs only when **both** are true:
- T1–T4 produced zero placeholders.
- A provider is configured via env (read from `.env` in the working
  directory or process env — process env wins).

Provider env vars (any one suffices):
- `ANTHROPIC_API_KEY` → Anthropic Messages API (default model: claude-sonnet-4-6).
- `OPENAI_API_KEY` → OpenAI Responses API (default model: gpt-4o-mini).
- `DRAFT_LLM_PROVIDER` + `DRAFT_LLM_API_KEY` (+ optional `DRAFT_LLM_MODEL`) → explicit override.

If no provider env is present, the cascade **stops at T4** and the CLI
errors with a clear message: `no placeholders detected by deterministic
tiers; set ANTHROPIC_API_KEY (or equivalent) in .env to enable LLM
detection, or pass --syntax mustache if your template uses {{...}}.`

The LLM call sends template text **only**, no params file, no user data.
Prompt asks for a JSON array of placeholder spans with `start`, `end`,
`suggested_key`. Result is validated against the same canonical-key
rules; invalid entries are dropped with a warning.

`--no-llm` disables T5 even when env is configured (the cascade ends at
T4). `--llm` asserts that an LLM provider should be available and
fail-fasts with a clear error if none is configured; it does **not**
override the sequential-with-stop semantics. Running T5 on top of an
earlier-tier hit (the "find missed generics in a bracketed template"
workflow) is a v2 candidate, not v1 behavior.

## 4. Key conventions

Three surfaces, one canonical key per parameter.

| Surface       | Form                  | Example          |
| ------------- | --------------------- | ---------------- |
| Match source  | Title Case w/ spaces  | `Party A Name`   |
| Canonical key | snake_case            | `party_a_name`   |
| CLI flag      | kebab-case            | `--party-a-name` |
| JSON file key | snake_case            | `"party_a_name"` |

Derivation when no schema is present: match text → lowercase, spaces → underscores. `Party A Name` → `party_a_name`. The original match text is preserved in output (case/spacing intact); we replace byte-for-byte.

Disallowed in placeholders (will error if found in a schema file): dots, slashes, leading digits, hyphens inside the match text. Reserved schema-file keys: `_meta`, `_aliases`, `_required`, `_defaults`.

## 5. Schema file: `<template>.params.json`

Sibling file, opt-in. If absent, placeholders are inferred by the active
cascade tier; every inferred placeholder is treated as required; keys are
auto-derived.

If present, the schema is **authoritative**: only declared parameters
substitute. Anything else the cascade detects is left untouched and
listed in `--why` as `unmapped`.

**Schema rescue (T1/T2 only).** When a schema declares a phrase that the
heuristic detection rule would reject (e.g. all-caps `[COMPANY]`, all-
underscore `[_____________]`, snake_case `[party_a]`), the schema's
alias list is consulted during detection and rescues that phrase.
Without this, a schema-declared alias would be silently dropped before
ever reaching the resolution step. The rescue applies only to bracket
(T1) and mustache (T2) tiers; T3/T4/T5 use text-based detection that
doesn't need rescuing.

### Short form (default in docs)

```json
{
  "party_a": ["Party A", "Disclosing Party"],
  "party_b": ["Party B", "Receiving Party"],
  "effective_date": ["Effective Date"]
}
```

Each value is a list of phrase forms (bracket inner text, mustache inner
text, or highlighted text). The canonical key is **NOT** implicitly in
its own alias list (Q3 locked) — list it explicitly if needed.

### Long form (with `_meta`)

```json
{
  "_meta": { "schema_version": 1 },
  "party_a":        { "aliases": ["Party A"], "required": true },
  "effective_date": { "aliases": ["Effective Date"], "required": false, "default": "the date first written above" }
}
```

Parser selects long form iff a top-level `_meta` key is present. Short
and long are not mixable within one file.

### Typed parameters (v0.3.0, opt-in)

Long-form entries can declare `type`, with optional `format` (`date`)
or `currency` (`money`). Inputs are validated and normalized between
value resolution and substitution. Bad input → exit 4
(`EXIT.VALIDATION`) with a per-key error message; all type errors are
collected before exit so the user sees every issue at once.

```json
{
  "_meta": { "schema_version": 1 },
  "effective_date":  { "aliases": ["Effective Date"],  "type": "date",  "format": "MMMM d, yyyy" },
  "purchase_amount": { "aliases": ["Purchase Amount"], "type": "money", "currency": "USD" },
  "party_a":         { "aliases": ["Party A"],         "type": "party" }
}
```

| `type`   | Accepts                                                              | Normalizes to                          | Notes |
| -------- | -------------------------------------------------------------------- | -------------------------------------- | ----- |
| `date`   | ISO (`2027-01-15`) or spelled (`January 15, 2027`, `Jan 15 2027`)    | `format` field (default `MMMM d, yyyy`) | Q3.1 locked: US (`MM/DD/YYYY`) and European (`DD/MM/YYYY`) numeric forms are **rejected** as ambiguous. |
| `money`  | `$5,000`, `5000.50`, `$5M`, `2.5K`, `1B`; rejects `$$5`, `5,00`, etc. | `currency`-formatted (e.g. `$5,000,000.00`) | Q3.2 locked: v0.3.0 supports `currency: "USD"` only. |
| `party`  | Non-empty after trim; no markdown links `[text](url)`; no trailing punctuation `.,;:!?` | Trimmed string | Q3.3 locked: hard error on bad input — typed params are opt-in. |

`format` for `date` supports `yyyy`, `MMMM`, `MM`, `d` tokens (matched
in a single pass — `MM` doesn't accidentally consume `MMMM`, `d`
doesn't leak into month names). Other literal characters pass through
unchanged. Other tokens (e.g. `HH:mm`, `dd`, `EEEE`) are deferred to
future versions.

Programmatic API for drivers: `parseDateValue`, `formatDateValue`,
`parseMoneyValue`, `formatMoneyValue`, `normalizeTypedValue`,
`normalizeTypedValues`.

### Computed placeholders (v0.4.0, opt-in)

Long-form entries can declare a `computed` block referencing another
key in the same schema. At substitution time, if no value was
supplied via CLI / `--params` / interactive / default, the computed
entry's value is derived from the `from` placeholder via simple
date arithmetic. Explicit user-supplied values still win — computed
only fills the gap.

```json
{
  "_meta": { "schema_version": 1 },
  "effective_date": {
    "aliases": ["Effective Date"],
    "type": "date", "format": "MMMM d, yyyy"
  },
  "term_end": {
    "aliases": ["Term End"],
    "type": "date", "format": "MMMM d, yyyy",
    "computed": { "from": "effective_date", "op": "+", "value": "2 years" }
  }
}
```

| Field   | Type     | Required | Notes |
| ------- | -------- | -------- | ----- |
| `from`  | string   | yes      | Key of another entry in the same schema. Schema validation rejects unknown references. |
| `op`    | `"+"`/`"-"` | yes   | Add or subtract the duration from the `from` value. |
| `value` | string   | yes      | Duration in `<n> <unit>` form, where `<unit>` is `day`, `week`, `month`, or `year` (singular or plural; case-insensitive). |

**Q2.1 locked:** Expression syntax lives in the schema, **not** in
template text. T1 bracket detection treats `[Term End]` as an
ordinary placeholder; the schema-level `computed` block decides how
its value is derived.

**Q2.2 locked:** v0.4.0 supports **date arithmetic only**. Money
math (`+ 10%`) and string concat (`Party A + " Inc."`) are deferred
to a future release once the date-arithmetic design is proven against
real templates.

**Resolution order:** value resolution → typed-parameter normalization
(§ above) → computed-placeholder evaluation → substitution.

**Cycle and reference safety:** `parseSchema` walks every
`computed.from` chain and throws at load time if a chain revisits a
key (e.g. `a → b → a`) or references a non-existent key. Caught
before substitution.

**Orphan-check exemption:** an entry that's referenced only as
another entry's `computed.from` (never appears in the template) is
**not** an orphan. It's a feeder used solely for computation.

**Format inheritance:** the computed entry's `format` field is used
to render the result. If the computed entry doesn't declare `format`,
the default `MMMM d, yyyy` applies. The `from` entry's `format` is
used for parsing the source value (since by then it's normalized to
that format).

Programmatic API for drivers: `parseDuration`, `addDuration`,
`computeValues`.

### Positional addressing (v0.5.0, opt-in)

Some templates have the same placeholder text appearing multiple times
with *different* semantic roles. The validated YC SAFE case:
`$[_____________]` appears twice — once as valuation cap, once as
purchase amount. Long-form entries can declare a `positions` array
that splits each occurrence into its own canonical-keyed placeholder.

```json
{
  "_meta": { "schema_version": 1 },
  "blank": {
    "aliases": ["_____________"],
    "type": "money", "currency": "USD",
    "positions": [
      { "role": "valuation_cap" },
      { "role": "purchase_amount" }
    ]
  }
}
```

CLI uses standard `--<role>` flags (no special `@N` grammar):

```sh
draft safe.docx --valuation-cap 5000000 --purchase-amount 100000
```

**Q1.1 locked:** index base is 0 internally; the CLI uses role names,
not numeric indices.

**Q1.2 locked:** count mismatch (schema declares N positions but
detection finds M ≠ N occurrences of the alias) is a **hard error**
(exit 4). The schema and the template are out of sync; silently filling
or trimming hides the bug.

**Q1.3 locked:** there is no bare-key CLI variant (`--<parent-key>
VALUE` with no role). The CLI uses role-named flags. Bare `--<role>`
targets that role's position; values can also come from `--params`
JSON keyed by role, or `--interactive`.

**Tier constraint:** positional addressing only works at T1 (bracket)
or T2 (mustache). T3/T4/T5 detection paths don't carry per-hit byte
indices needed for position-specific substitution; if a positional
schema entry's aliases are matched by those tiers, the command exits 4
with a clear error.

**Validation:** at schema parse time, positions must be a non-empty
array of `{role: string}` objects; roles must be valid snake_case keys
and unique within the entry.

Programmatic API: positions flow through detection and resolution as
normal `Placeholder` objects with `position_parent` (parent schema key)
and `position_index` (0-based) fields. `substitute` switches to
byte-index substitution for these, which `substituteDocxXml` does not
currently support.

### Cross-template `parties.json` registry (v0.6.0, opt-in)

A repo-local `parties.json` declares known parties once; templates'
schemas reference fields with `ref:parties.<party_key>.<field>`.
Eliminates duplicating party metadata (name, state, CIK, signing
contact) across every template.

```json
// parties.json
{
  "acme_corp": {
    "name": "Acme Corporation",
    "state": "Delaware",
    "cik": "0001234567"
  }
}
```

```json
// <template>.params.json
{
  "_meta": { "schema_version": 1 },
  "party_a":       { "aliases": ["Party A"],       "default": "ref:parties.acme_corp.name" },
  "party_a_state": { "aliases": ["Party A State"], "default": "ref:parties.acme_corp.state" }
}
```

**Q2.1 locked:** default file location is `./parties.json` in the
process CWD. Override with `--parties PATH`. Missing explicit path
is exit 1 (`EXIT.IO`); missing default file silently means "no
registry loaded" (refs then fail at resolution time with a clear hint).

**Q2.2 locked:** refs resolve in `--params` JSON values and schema
`default` values only. **CLI flag values pass through unchanged** —
`--party-a "ref:parties.acme.name"` is treated as a literal string
that happens to start with `ref:`. This keeps CLI parsing
unambiguous and avoids users accidentally leaking parties data on
the command line.

**Q2.3 locked:** versioning is out of scope for v0.6.0. When a
party's metadata changes in `parties.json`, all drafts that ref it
produce different output if re-run. This is by design (single source
of truth for party info), but worth knowing — historical drafts may
diverge from their original `parties.json` values.

**Ref syntax:** `ref:parties.<party_key>.<field>` where both
`<party_key>` and `<field>` match `[A-Za-z_][A-Za-z0-9_]*`. Malformed
refs, unknown party keys, and unknown fields all surface as hard
errors before substitution (exit 4).

**Resolution order:** value resolution → ref expansion → typed-param
normalization → computed values → substitute. Refs run before typed
normalization so a ref returning `"2027-01-15"` can still flow
through `type: date` formatting.

**Field-value coercion:** ref'd fields are coerced to strings via
`String(value)` (e.g. `cik: 1234567` becomes `"1234567"`). The
parties registry can store non-string values for ergonomics, but
substitution always uses string output.

Programmatic API: `loadParties(path)`, `resolveRef(value, parties)`,
`resolveRefs(resolved, sources, parties)`.

### Multi-document bundles (v0.7.0, opt-in)

`draft --bundle <bundle.json>` reads a bundle definition and fills
multiple templates with one shared set of parameter values:

```json
{
  "_meta": { "schema_version": 1 },
  "outputs": [
    { "template": "msa/v3.md",        "output": "out/msa.md" },
    { "template": "order-form/v3.md", "output": "out/order-form.md" },
    { "template": "dpa/v2.docx",      "output": "out/dpa.docx" }
  ]
}
```

```sh
draft --bundle deal.bundle.json --params deal.json --parties parties.json
```

**Q3.1 locked:** the bundle file is a JSON object with an `outputs`
array of `{template, output}` pairs. Each entry has its own
`template` (filesystem path or `template-vault get` ref) and own
`output` path. No alternative shorter DSL — JSON is unambiguous and
extensible.

**Q3.2 locked:** abort-all. Any pre-write error (no detection in an
entry, missing required param across the union, type validation
failure, computed-value failure, ref-resolution failure, positional
mismatch, schema orphan) returns exit 4 **before any file is
written**. The bundle either writes all `outputs` or writes none.
Filesystem write errors mid-bundle exit 1; earlier successful
writes are not rolled back (best-effort atomicity at the filesystem
boundary).

**Q3.3 locked:** schema union. A key declared in any template's
schema, or detected as a canonical-key match without a schema,
applies across the entire bundle. The same resolved value flows to
every template that references the key. First-occurrence metadata
wins (`type`, `format`, `currency`, `computed`, `positions`, etc.);
templates with richer aliases for the same key contribute their
aliases for detection in their own body but don't redefine the key.

**Per-template detection independence:** each bundle entry runs the
full T1–T5 cascade against its own body. Different entries can land
on different tiers (e.g. MSA on T1 brackets, DPA on T3 highlights).
Positional addressing on T1/T2 still works per entry.

**`.docx` entries** with a `.docx` output path round-trip via
`substituteDocxXml` + `writeDocxBuffer`, preserving runs/styles.
Mixing text and `.docx` entries in the same bundle works.

**`parties.json` refs** (v0.6.0) resolve inside bundles too — load
the same parties file once via `--parties PATH` (or the CWD
default), and ref strings in any bundle template's schema default
or in shared `--params` expand against it.

**`--json`** for bundles emits a structured result listing each
entry's template, output path, and tier, plus the union of resolved
keys and their sources.

Programmatic API: `loadBundle(path)` parses + validates; `cmdBundle`
runs the orchestration with the same IO contract as `cmdDraft`.

### LLM inference from a deal description (v0.8.0, opt-in)

`--from-deal PATH` reads a free-form deal description and asks the
configured T5 LLM provider to extract values for the schema's
declared placeholders. The inverse of T5 detection — instead of
inferring *where* placeholders are in a template, infer *what
values* they should take from the deal prose:

```sh
draft nda.md --from-deal deal-notes.txt --output draft.md
```

```
# deal-notes.txt
Mutual NDA between Acme Corporation (DE) and Globex (UK),
effective June 1, 2026, for a 2-year term.
```

Then `[Party A]` → `Acme Corporation`, `[Effective Date]` →
`June 1, 2026`, etc., without any `--party-a` / `--effective-date`
flags.

**Value-resolution precedence** with `--from-deal`:

```
CLI flag  >  --params JSON  >  --from-deal (LLM)  >  --interactive  >  schema default  >  error
```

CLI / --params always win, so users can fix or override anything the
LLM got wrong without re-running inference.

**Q4.1 locked:** same T5 provider config (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, or explicit `DRAFT_LLM_*`). One network surface,
one set of env vars.

**Q4.2 locked:** extra keys (LLM emits keys not in the detected
placeholder list) are **warned** to stderr, not silently dropped.
The LLM gets the allowed-key list in the prompt so this is rare in
practice.

**Q4.3 locked:** `--from-deal` does **not** require explicit
`--llm` — the inference is implicit when the flag is present.
`--no-llm` still disables the inference call (the user can opt
out of the network).

**Provider missing:** if no LLM provider is configured (no
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DRAFT_LLM_*` in env),
`--from-deal` errors immediately with `EXIT.LLM` (exit 5) and a
clear message. Same for network / HTTP errors / non-JSON LLM
responses.

**Resolution interaction with typed parameters:** inferred values
go through the same typed-normalization step as user-supplied
values. So an LLM that returns `"June 1, 2026"` for a `type: date`
parameter with `format: yyyy-MM-d` gets normalized to `2026-06-1`
before substitution.

**Bundle mode (v0.7.0) interaction:** bundles do not currently
thread `--from-deal` through per-template inference. The shared
parameter resolution already accepts `--params` JSON, which is the
simpler structured-data path for bundle workflows. Deferred to a
future release.

Programmatic API: `inferFromDeal(dealText, placeholders, providerCfg, { fetcher })`.

### Orphan handling (Q4 locked)

Schema declares a key whose alias list matches no detected phrase →
**error**, exit 2. Catches drift early.

## 6. Precedence

CLI flag > JSON `--params` file > `--interactive` prompt > schema `default` > error.

- CLI flag present (even `""`) wins.
- JSON value present wins over prompt and default.
- `--interactive` set AND still missing → prompt.
- Schema `default` present AND still missing → use the default.
- Still missing → error, exit 2.

## 7. Validation, modes, errors

### `draft --validate <template> --params FILE`

Same lookup, never writes output. Exits 0 if every required key resolves;
2 otherwise. Honors all five cascade tiers and the schema if present.

### `draft --list-placeholders <template>`

Prints detected placeholders in first-appearance order, deduplicated.
With `--json`:

```json
{
  "template": "nda/house-mutual",
  "tier": "bracket",
  "placeholders": [
    { "key": "party_a", "first_seen_as": "Party A",
      "aliases": ["Party A", "Disclosing Party"],
      "required": true, "occurrences": 4, "tier": "bracket" }
  ],
  "warnings": []
}
```

### Error shapes (stderr, red on TTY, honors `NO_COLOR`/`FORCE_COLOR`)

```
error: missing required parameter(s):
  - party_a   (matched: [Party A], [Disclosing Party])
      supply --party-a or set "party_a" in --params
  - effective_date (matched: [Effective Date])
      supply --effective-date or set "effective_date" in --params
hint: run `draft --list-placeholders nda/house-mutual` to see all parameters.
```

```
error: mixed placeholder conventions in template (4 bracket, 2 mustache).
note: pass --syntax bracket or --syntax mustache; the other family is left untouched.
```

```
error: schema declares "party_c" with aliases ["Party C","Third Party"],
       but no matching phrase was detected by tier 'bracket'.
hint: remove the entry from the schema, or add the phrase to the template.
```

```
error: no placeholders detected by deterministic tiers (bracket, mustache,
       docx-highlight, heuristic).
hint: set ANTHROPIC_API_KEY in .env to enable LLM detection,
      or pass --syntax mustache if your template uses {{...}}.
```

Exit codes: `0` success, `1` template/input I/O error, `2` validation
failure, `3` template-vault subprocess failure, `4` LLM tier failure
(network, auth, malformed response).

## 8. `--why` output

Structured stderr block (or stdout under `--json`):

```
draft: substituted 7 placeholders in nda/house-mutual → draft.md
why:
  input         = nda/house-mutual (via template-vault get)
  tier          = bracket
  schema        = nda/house-mutual.params.json (short form)
  placeholders  = 4 distinct, 12 occurrences
  resolved      = 4 (3 from CLI, 1 from --params, 0 interactive, 0 default)
  defaulted     = 0
  unresolved    = 0
  unmapped      = 1 ([See Section 4] — not in schema)
  warnings      = 0
```

## 9. Out of scope for v1 (deferred — schema is forward-compatible)

- Computed placeholders (`[Effective Date + 2 years]`). Long-form schema reserves a future `"computed"` key.
- Typed parameters (`party`, `date`, `money`). Reserves a future `"type"` key.
- Cross-template parameter registry (`parties.json`). Additive; would layer underneath `--params` in precedence.
- `.docx` output round-trip.
- LLM-assisted suggestion *from a deal description* (current T5 only suggests from template text).

---

## Locked decisions (audit trail)

| ID  | Question                                | Decision |
| --- | --------------------------------------- | -------- |
| Q1  | Cross-references like [See Section 4]   | Subsumed: schema file disambiguates; T4/T5 expand coverage. |
| Q2  | Short-form vs long-form schema          | Both supported; `_meta` selects long form. |
| Q3  | Canonical key implicit-alias            | No — explicit list only. |
| Q4  | Orphan schema declarations              | Error, exit 2. |
| D1  | Cascade semantics                       | Sequential-with-stop. |
| D2  | LLM default behavior                    | Env-gated auto-fallback at T4 boundary. |
| D3  | Heuristic safety gate                   | Warn-only, requires `--yes-heuristic` or interactive confirm. |
| D4  | .docx parsing                           | `jszip` + regex on `word/document.xml`. |

*End of contract. Code begins once approved.*
