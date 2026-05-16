# Agents

Drive `draft-cli` from an LLM agent or non-interactive client. Same shape as the rest of the contract-operations suite.

## Output contract

- **Success**: substituted document body to **stdout** (or to `--output PATH` if given), exit `0`. With `--json`, **stdout** is a single JSON object instead.
- **Failure**: human-readable error to **stderr**, non-zero exit. With `--json`, **stdout** is `{ok: false, missing: [...]}` or similar; the error message still goes to stderr.
- Diagnostic text (`--why` block, warnings, `note:` lines, color) always goes to **stderr**. Stdout is reserved for the substituted document or the JSON report. This separation is the contract — pipelines can safely compose `template-vault get … | draft - | nda-review …` without stderr poisoning.
- `--silent` (`-q`) suppresses stderr completely after argument parsing. Use this for fully-quiet pipelines where you only want the stdout artifact.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | I/O error — template not found, unreadable, malformed `.docx`, write failure on `--output` |
| `2` | Validation — missing required parameters, orphan schema declarations, mixed-syntax without `--syntax`, no placeholders detected |
| `3` | `template-vault get` subprocess failed (vault ref like `nda/house-mutual`) |
| `4` | LLM tier failure — provider unreachable, auth rejected, non-JSON response, unsupported provider |

## Discovery

```sh
draft --help                       # human-readable help
draft --version                    # → draft-cli <semver>
draft --check-llm                  # one-token roundtrip to verify env-configured LLM provider
draft <template> --list-placeholders --json
                                   # placeholders the agent will need to supply, machine-readable
draft <template> --validate --params deal.json
                                   # completeness check; exit 2 with `--json` `{ok:false, missing:[...]}` on failure
draft <template> --diff --params deal.json --json
                                   # structured diff (substitution table); never writes output
```

Discovery flow for a fresh template:

1. `draft <template> --list-placeholders --json` to see what parameters exist, which tier matched, and the alias map.
2. Resolve each `key` to a value from the deal context.
3. `draft <template> --params deal.json --validate --json` to confirm everything resolves before generating output.
4. `draft <template> --params deal.json --output draft.md --json` to substitute and capture a structured report.

## JSON shapes

### `--list-placeholders --json`

```json
{
  "template": "nda/house-mutual",
  "tier": "bracket",
  "placeholders": [
    {
      "key": "party_a",
      "first_seen_as": "Party A",
      "aliases": ["Party A", "Disclosing Party"],
      "required": true,
      "occurrences": 4,
      "tier": "bracket"
    }
  ],
  "warnings": [],
  "unmapped": []
}
```

### `--validate --json`

On success:

```json
{ "ok": true, "resolved": ["party_a", "party_b"], "sources": { "party_a": "params", "party_b": "cli" } }
```

On failure:

```json
{ "ok": false, "missing": ["party_b"] }
```

### `--diff --json`

```json
{
  "ok": true,
  "tier": "bracket",
  "diff": [
    { "key": "party_a", "from": "[Party A]", "to": "Acme Corporation", "occurrences": 2 },
    { "key": "effective_date", "from": "[Effective Date]", "to": null, "occurrences": 1 }
  ]
}
```

`to: null` means the placeholder is unresolved — `--diff` doesn't error on missing values; it shows them so the caller can decide.

### Main draft with `--json`

```json
{
  "ok": true,
  "tier": "bracket",
  "output_path": null,
  "output": "<substituted document body>",
  "placeholders": [ /* same shape as --list-placeholders */ ],
  "sources": { "party_a": "cli", "party_b": "params" },
  "warnings": [],
  "unmapped": [
    { "phrase": "See Section 4", "tier": "bracket" }
  ]
}
```

If `--output PATH` is set, `output_path` is the path and `output` is `null` (the document was written to disk, not embedded in the JSON).

## Tier names

The `tier` field on JSON output indicates which detection strategy matched. Stable across minor versions:

| Tier value | Meaning |
|------------|---------|
| `"bracket"` | `[Title Case]` literal match |
| `"mustache"` | `{{...}}` literal match (only when `--syntax mustache`) |
| `"docx-highlight"` | Yellow / green / cyan / magenta highlighted runs in `.docx` |
| `"heuristic"` | Bundled generic-name dictionary (warn-only by default) |
| `"llm"` | LLM-suggested placeholders (only when env-configured) |
| `"none"` | Cascade found zero placeholders |

## Failure → recovery

| Symptom | Diagnose | Recover |
|---|---|---|
| exit 1, `template not found` | Check the path; if it looks like a vault ref (`nda/house-mutual`), make sure `template-vault` is on `PATH`. | Pipe the body via stdin: `template-vault get … \| draft -` |
| exit 2, `missing required parameter(s)` | `draft <template> --list-placeholders --json` | Supply the missing keys via `--<key>` flags or `--params`. Note typo warnings in `warnings[]`. |
| exit 2, `mixed placeholder conventions` | Inspect the template for both `[X]` and `{{Y}}` | Pass `--syntax bracket` or `--syntax mustache` to pick one family. The other is left untouched. |
| exit 2, `schema declares … but no matching phrase` | Schema-template drift. The schema declares a key whose alias list doesn't appear in the template body. | Remove the orphan from the schema, or add the phrase to the template. |
| exit 2, `no placeholders detected by deterministic tiers` | Template has no markup; T1–T4 all empty. | Either ship a schema with explicit aliases, opt into `.docx` highlights (already auto), or configure `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in `.env` to enable T5 LLM detection. |
| exit 3, `template-vault get … failed` | The vault subprocess returned non-zero. Stderr surfaces the vault's error. | Fix the vault ref or fall back to a local file. |
| exit 4, `LLM call failed: 401` | Provider auth rejected | Rotate `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in `.env`. |
| exit 4, `LLM returned non-JSON response` | Model didn't follow the prompt format | Try a stronger model via `DRAFT_LLM_MODEL=…`. Or pass `--no-llm` to stay deterministic. |

## Recommended defaults for agent invocations

```sh
# Discovery
draft "$TEMPLATE" --list-placeholders --json

# Validate before committing to substitution
draft "$TEMPLATE" --validate --params deal.json --json

# Substitute with structured output for downstream pipelining
draft "$TEMPLATE" --params deal.json --output draft.md --json --why

# Pipe via the suite
template-vault get nda/house-mutual \
  | draft - --params deal.json --json --no-llm \
  | jq -r '.output' \
  | nda-review review - --playbook house --json
```

`--no-llm` is recommended for agent-driven pipelines unless the agent has explicit license to invoke a network call. `draft-cli`'s T5 auto-runs only when env configures a provider; passing `--no-llm` disables it even then.

## LLM safety

- **No network by default.** T5 LLM tier runs only when `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `DRAFT_LLM_*` is configured in `.env` or the process environment.
- **Template text only.** T5 sends the template body to the provider. It does **not** send `--params` values, schema contents, `.env` contents, or any other env variables.
- **Explicit kill-switch.** `--no-llm` disables T5 even when configured. Use this in any pipeline that handles privileged contracts.
- **Fail-fast assertion.** `--llm` asserts the provider is configured; exits `4` immediately if not. Use this in scripts that *require* T5 so they don't silently fall back to a deterministic-only cascade.

Documented in [SECURITY.md](SECURITY.md).

## Heuristic safety gate

T4 (heuristic dictionary) has a higher false-positive risk than the other deterministic tiers — substituting over a real party name that happens to be `Acme Corporation` would be embarrassing. By default in non-TTY contexts T4 matches are **listed but not substituted**; the run exits `2` with a warning. Bypass with `--yes-heuristic` (the user has reviewed and accepts the risk) or disable T4 entirely with `--no-heuristic`.

Agents should default to `--no-heuristic` unless the calling context has explicitly cleared the template for heuristic substitution.

## Library use (Node.js)

`draft-cli.mjs` is an ESM module. Every meaningful function is exported:

```js
import {
  detectBracket, detectMustache, detectDocxHighlight, detectHeuristic, detectLlm,
  parseSchema, loadSchema, runCascade, substitute, resolveValues,
  parseArgs, main, completionScript, VERSION, EXIT
} from "@drbaher/draft-cli";

// Programmatic substitution
const args = parseArgs(["x.md", "--party-a", "Acme"]);
const input = { kind: "text", body: "Between [Party A] and [Party B]", path: null };
const result = await runCascade(input, args, /*schema=*/null, /*env=*/{});
// → { tier: "bracket", placeholders: [...], warnings: [], unmapped: [] }
const { resolved, missing } = await resolveValues(result.placeholders, args, /*paramsJson=*/{});
if (missing.length === 0) {
  const out = substitute(input.body, result.placeholders, resolved, result.tier);
  // out === "Between Acme and [Party B]"
}
```

Or invoke the full CLI in-process with captured I/O:

```js
import { Writable } from "node:stream";
import { main } from "@drbaher/draft-cli";

class Capture extends Writable {
  constructor() { super(); this.s = ""; }
  _write(c, _e, cb) { this.s += c; cb(); }
}
const out = new Capture(), err = new Capture();
const code = await main(["x.md", "--party-a", "Acme", "--json"], { out, err });
// out.s is the JSON report; err.s has any --why block or warnings.
```

Test fixtures (mock spawners for `template-vault`, mock fetchers for LLM, synthesized `.docx` files) are in `tests/_helpers.mjs` if you want to drive the CLI in tests of your own.

## See also

- [README.md](README.md) — install, 30-second first run, command reference.
- [GETTING_STARTED.md](GETTING_STARTED.md) — 10-minute walkthrough.
- [PARAM_SCHEMA.md](PARAM_SCHEMA.md) — locked parameter contract: cascade, schema file, precedence.
- [ARCHITECTURE.md](ARCHITECTURE.md) — single-file rationale, substitution model, `.docx` parsing.
- [SECURITY.md](SECURITY.md) — threat model + LLM data-flow disclosure.
- [FAQ.md](FAQ.md) — design questions and trade-offs.
- [CHANGELOG.md](CHANGELOG.md) — release notes + the v2 "Deferred" list.
