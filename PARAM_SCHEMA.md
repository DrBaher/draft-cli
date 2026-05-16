# PARAM_SCHEMA — proposal (v1)

Locking the parameter contract before code. One page. Reviewer: DrBaher.

---

## 1. Placeholder syntax

**Primary:** `[Title Case Bracketed]` — Common Paper, YC SAFE, Bonterms.
**Opt-in:** `--syntax mustache` switches matching to `{{Title Case}}` (or
`{{snake_case}}` — both accepted inside mustache).

A bracketed run is treated as a placeholder when **all** of:

1. Starts with `[`, ends with `]`, no nested brackets.
2. Inner text matches `^[A-Z][A-Za-z0-9 ]{0,78}[A-Za-z0-9]$` (length 2–80,
   starts uppercase, ends letter/digit, only letters/digits/spaces inside).
3. Inner text is **not** entirely uppercase (excludes headings like
   `[CONFIDENTIALITY]`, `[ARTICLE I]`).
4. First character of the inner text is a letter (excludes `[3.1]`,
   `[4.a]`, etc.).

Examples that **match**: `[Party A]`, `[Party A Name]`, `[Effective Date]`,
`[State of California]`, `[Term]`, `[Disclosing Party]`.
Examples that **don't**: `[3.1]`, `[ARTICLE I]`, `[CONFIDENTIALITY]`,
`[See Section 4]` *(actually this would match — see open question Q3)*.

Mixed-convention templates (both `[X]` and `{{X}}` present) emit a
`doctor`-style warning on stderr but do not error. The active `--syntax`
wins; the other family's matches are left untouched in the output.

## 2. Key conventions

Three surfaces, one canonical key per parameter.

| Surface       | Form                  | Example         |
| ------------- | --------------------- | --------------- |
| Bracket text  | Title Case w/ spaces  | `[Party A Name]` |
| Canonical key | snake_case            | `party_a_name`  |
| CLI flag      | kebab-case            | `--party-a-name` |
| JSON file key | snake_case            | `"party_a_name"` |

**Derivation** (when no schema file is present): bracket text → lowercase
→ spaces become underscores. `[Party A Name]` → `party_a_name`.
Reverse direction is informational only — we never re-render a key as
bracket text in output; the original bracket text from the template is
preserved exactly (case, spacing) and replaced byte-for-byte.

Disallowed in placeholders (will error with a clear message if found in
a `<template>.params.json`): dots, slashes, leading digits, hyphens
inside the bracket text. Reserved key names: `_meta`, `_aliases`,
`_required`, `_defaults` (the schema container reserves these for its
own keys; see §3).

## 3. Schema file: `<template>.params.json`

Sibling file, opt-in. If absent, placeholders are **inferred** from the
template by the rule in §1, every inferred placeholder is treated as
required, and CLI/JSON keys are auto-derived.

If present, the schema is **authoritative**: only declared parameters
are substituted, anything else bracketed is left in place (with a
`doctor` warning naming the orphans).

**Short form** (matches the example DrBaher gave in the brief):

```json
{
  "party_a": ["Party A", "Party A Name", "Disclosing Party"],
  "party_b": ["Party B", "Receiving Party"],
  "effective_date": ["Effective Date"]
}
```

Each value is a list of bracketed phrase forms (without the `[` `]`)
that all map to the canonical key. The canonical key is **not**
implicitly added to its own alias list — list it explicitly if you want
`[party_a]` to match.

**Long form** (when you need `required: false` or a default):

```json
{
  "_meta": { "schema_version": 1 },
  "party_a":        { "aliases": ["Party A", "Disclosing Party"], "required": true },
  "party_b":        { "aliases": ["Party B"], "required": true },
  "effective_date": { "aliases": ["Effective Date"], "required": false, "default": "the date first written above" }
}
```

The two forms are mutually exclusive within a file — short OR long, not
mixed. A `_meta` key at the top level switches the parser into long
form; otherwise it's short form.

## 4. Precedence

Per the brief: **CLI flags > JSON params file > interactive prompt >
schema default > error**.

- CLI flag present → wins, even if the value is the empty string.
- JSON file value present → wins over the prompt and schema default.
- `--interactive` set AND value still missing → prompt for it.
- Schema declares a `default` AND value still missing → use the default.
- Still missing → error (see §5), exit 2.

## 5. Validation & errors

**`draft --validate <template> --params FILE`** runs the same lookup
but never writes output. Exits 0 if every required placeholder is
resolved, 2 otherwise.

**`draft --list-placeholders <template>`** prints every detected
placeholder, deduplicated, in order of first appearance. With `--json`,
emits:

```json
{
  "template": "nda/house-mutual",
  "syntax": "bracket",
  "placeholders": [
    {"key": "party_a", "first_seen_as": "Party A", "aliases": ["Party A", "Disclosing Party"], "required": true, "occurrences": 4},
    {"key": "party_b", "first_seen_as": "Party B", "aliases": ["Party B"], "required": true, "occurrences": 4}
  ]
}
```

**Error shapes** (stderr, colorized red when TTY):

```
error: missing required parameter(s):
  - party_a   ([Party A], [Disclosing Party])  — supply via --party-a or "party_a" in --params
  - effective_date ([Effective Date])          — supply via --effective-date or "effective_date" in --params
hint: run `draft --list-placeholders nda/house-mutual` to see all parameters.
```

```
error: mixed placeholder conventions in template (found 4 bracket, 2 mustache).
note: pass --syntax bracket or --syntax mustache to choose; the other family is left untouched.
```

```
error: schema file nda/house-mutual.params.json declares "party_c" but no bracketed phrase
       in the template matches its alias list ["Party C", "Third Party"].
hint: remove the entry from the schema, or add the phrase to the template.
```

Exit codes: `0` success, `1` template/input I/O error, `2` validation
failure (missing/unknown params, mixed syntax without `--syntax`,
schema-template mismatch), `3` template-vault subprocess failure.

## 6. `--why` shape

Structured stderr block (or stdout if `--json`), shown when `--why` is set:

```
draft: substituted 7 placeholders in nda/house-mutual → draft.md
why:
  syntax        = bracket
  schema        = nda/house-mutual.params.json (long form)
  placeholders  = 4 distinct, 12 occurrences
  resolved      = 4 (3 from CLI, 1 from --params)
  defaulted     = 0
  unresolved    = 0
  warnings      = 0
```

## 7. Out of scope for v1 (deferred to v2; called out so the schema is
   forward-compatible)

- Computed placeholders (`[Effective Date + 2 years]`). Schema reserves
  a future `"computed"` key on long-form entries.
- Typed parameters (`party`, `date`, `money`). Schema reserves a future
  `"type"` key.
- Cross-template parameter registry (`parties.json`). Additive — would
  layer underneath the JSON params file in precedence.

---

## Open questions for review (please decide before code)

**Q1 — cross-reference false positives.** `[See Section 4]` passes
the §1 rule today and would be treated as a parameter. Three options:

- (a) **Accept it as a parameter.** If users don't supply
  `see_section_4`, validation fails loudly and they fix the template
  (the user's own legal text shouldn't read `[See Section 4]` anyway —
  they'd write `See Section 4` without brackets). Simplest rule, no
  special cases. ← **my recommendation**
- (b) Add a stoplist of leading words (`See`, `See also`, `As`,
  `Per`) that disqualify a bracketed run.
- (c) Require a schema file when the template has any bracketed
  Title-Case strings, no inference path. Safest but heaviest UX.

**Q2 — short-form vs long-form schema, pick one or keep both?** I
proposed both above. Both is friendly but doubles the parser surface
and the test matrix. Pick:

- (a) **Keep both, short-form is the default in docs.** ← my rec
- (b) Long-form only. Simpler implementation, slightly more verbose
  schema files.
- (c) Short-form only; ship long-form features (`required:false`,
  defaults) in v2.

**Q3 — does the canonical key match itself implicitly?** If schema
says `{"party_a": ["Party A"]}`, should the literal `[party_a]`
(bracketed snake_case) in the template also resolve? I proposed
**no** (explicit list wins). Alternative: **yes**, always add the
canonical key to the implicit alias set.

**Q4 — orphan handling.** When the schema declares a parameter but
no bracketed phrase matches, is that:

- (a) An **error** (exit 2). ← my rec — catches schema drift early.
- (b) A **warning** — substitute nothing, leave the user a note.

---

*End of proposal. No code written yet. Awaiting review.*
