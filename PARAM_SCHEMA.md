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

  `.docx` output is a round-trip: the original `.docx` package is reopened, the substituted text is written back into the same `<w:t>` runs that detection found, and all other parts of the package (relationships, images, headers, `[Content_Types].xml`, etc.) pass through unchanged. Run-level styling is preserved. If a placeholder's text spans multiple `<w:t>` runs in the source (Word sometimes splits runs at punctuation or auto-correct boundaries), that placeholder is **skipped**, not substituted, and a warning is emitted explaining how to fix the source — locked decision Q1.1.
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
