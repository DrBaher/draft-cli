#!/usr/bin/env node
// draft-cli — fill placeholders in legal-document templates.
// Part of the contract-operations suite. MIT. See LICENSE.
// Single-file Node.js CLI. Stdlib-only except `jszip` for .docx unzip.

import { readFileSync, writeFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { resolve, dirname, basename, extname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * @typedef {"bracket"|"mustache"|"docx-highlight"|"heuristic"|"llm"|"none"} Tier
 *
 * @typedef {Object} DetectionHit
 *   A single raw detection from one of the cascade tiers.
 * @property {string} match — the full matched span (e.g. "[Party A]").
 * @property {string} inner — the text inside the delimiters (e.g. "Party A").
 * @property {number} [index] — byte offset into the body, if known.
 * @property {string} [suggested_key] — only on T5/LLM hits.
 * @property {string} [color] — only on T3/docx-highlight hits.
 *
 * @typedef {Object} Placeholder
 *   An assembled placeholder — one canonical key, all its hits, schema metadata.
 * @property {string} key — canonical snake_case identifier.
 * @property {string} first_seen_as — the inner text of the first hit.
 * @property {number} occurrences — number of hits for this key.
 * @property {Tier} tier — which cascade tier produced this.
 * @property {boolean} required — whether the user MUST supply a value.
 * @property {string|null} default — schema-supplied fallback, or null.
 * @property {string[]} aliases — phrase forms that map to this key.
 * @property {DetectionHit[]} hits — every detection for this key.
 *
 * @typedef {Object} SchemaEntry
 * @property {string[]} aliases — phrase forms accepted for this key.
 * @property {boolean} required
 * @property {string|null} default
 *
 * @typedef {Object} Schema
 * @property {"short"|"long"} form
 * @property {Object<string, SchemaEntry>} entries
 * @property {string} [sourcePath] — file the schema was loaded from, if any.
 *
 * @typedef {Object} ParsedArgs
 *   Result of parseArgs(argv). See parseArgs() for shape.
 *
 * @typedef {Object} CascadeResult
 * @property {Tier} tier
 * @property {Placeholder[]} placeholders
 * @property {string[]} warnings
 * @property {Array<{phrase: string, tier: Tier}>} unmapped
 * @property {boolean} [heuristicGate] — true iff tier='heuristic' and
 *   substitution requires explicit confirmation.
 *
 * @typedef {Object} ResolvedValues
 * @property {Object<string, string>} resolved — key -> value.
 * @property {Placeholder[]} missing — unresolved required placeholders.
 * @property {Object<string, "cli"|"params"|"interactive"|"default">} sources
 *
 * @typedef {Object} Input
 * @property {"text"|"docx"} kind
 * @property {string} body — the template text (extracted for docx).
 * @property {string|null} path — filesystem path, or null for stdin/vault.
 * @property {string} [docxXml] — raw word/document.xml for docx inputs.
 *
 * @typedef {Object} LlmProvider
 * @property {string} provider — "anthropic" | "openai" | custom.
 * @property {string} apiKey
 * @property {string|null} model
 */

/** @type {string} */
export const VERSION = "0.9.0";

// ─── EXIT CODES ─────────────────────────────────────────────────────────────
/**
 * Stable exit codes. Documented in AGENTS.md and never re-numbered without
 * a major-version bump.
 * @type {Readonly<{OK: 0, IO: 1, VALIDATION: 2, VAULT: 3, LLM: 4}>}
 */
export const EXIT = Object.freeze({ OK: 0, IO: 1, VALIDATION: 2, VAULT: 3, LLM: 4 });

// ─── COLOR (honors NO_COLOR / FORCE_COLOR) ──────────────────────────────────
const ANSI = {
  reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m", bold: "\x1b[1m",
};

/**
 * Whether ANSI color should be emitted to `stream`. Honors the no-color.org
 * convention: `NO_COLOR` (any value) → off, `FORCE_COLOR` (any value) → on,
 * otherwise on iff `stream.isTTY`.
 *
 * @param {{isTTY?: boolean} | null | undefined} stream
 * @returns {boolean}
 */
export function colorEnabled(stream) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream && stream.isTTY);
}

/**
 * Wrap `s` with an ANSI color code if {@link colorEnabled} for `stream`.
 *
 * @param {string} s
 * @param {"red"|"green"|"yellow"|"cyan"|"dim"|"bold"} color
 * @param {{isTTY?: boolean} | null | undefined} stream
 * @returns {string}
 */
export function paint(s, color, stream) {
  return colorEnabled(stream) ? `${ANSI[color] || ""}${s}${ANSI.reset}` : String(s);
}

// ─── BUNDLED HEURISTIC DICTIONARY ───────────────────────────────────────────
export const DEFAULT_HEURISTIC_DICT = [
  "John Doe", "Jane Doe", "Jane Roe", "John Smith", "John Q. Public",
  "Acme Corporation", "Acme Corp.", "Acme Corp", "Acme Inc.", "Acme Inc",
  "Acme Co.", "Acme Co", "Acme LLC", "Acme, Inc.",
  "Foo Corp", "Foo Corp.", "Foo Inc.", "Foo Inc", "Foo LLC",
  "FooBar LLC", "FooBar, Inc.",
  "Example Inc.", "Example Inc", "Example Corporation", "Example Corp",
  "Sample Company", "Sample Corp", "Sample Inc.",
  "Newco", "Newco Inc.", "Newco Inc",
  "123 Main Street", "123 Main St.", "123 Main St",
  "1 First Avenue", "1 First Ave", "1 First Ave.",
  "Anytown, USA", "Anytown, US",
  "example@example.com", "user@example.com", "john@example.com",
  "jane@example.com", "test@test.com",
  "555-555-5555", "(555) 555-5555", "+1-555-555-5555",
  "555-5555", "555-1234",
  "January 1, 20XX", "MM/DD/YYYY", "DD/MM/YYYY",
  "YYYY-MM-DD", "20XX-XX-XX",
  "TBD", "TBC", "TBA",
];

// ─── .env READER (tiny inline parser) ───────────────────────────────────────
/**
 * Read a `.env` file. Tiny inline parser — handles `KEY=VALUE`, comments,
 * blanks, and matched single/double quotes around values. Returns `{}` if
 * the file doesn't exist.
 *
 * @param {string} path — usually `join(cwd, ".env")`.
 * @returns {Object<string, string>}
 */
export function readDotenv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Merge `.env` file contents with the process environment. Process env
 * always wins where both define a key.
 *
 * @param {string} [cwd]
 * @param {Object<string, string>} [processEnv]
 * @returns {Object<string, string>}
 */
export function effectiveEnv(cwd = process.cwd(), processEnv = process.env) {
  const fileEnv = readDotenv(join(cwd, ".env"));
  return { ...fileEnv, ...processEnv };
}

/**
 * Pick an LLM provider configuration from a merged env object. Order:
 * explicit `DRAFT_LLM_*` triple > `ANTHROPIC_API_KEY` > `OPENAI_API_KEY`.
 *
 * @param {Object<string, string>} envObj
 * @returns {LlmProvider | null} null if no provider is configured.
 */
export function llmProviderFromEnv(envObj) {
  if (envObj.DRAFT_LLM_PROVIDER && envObj.DRAFT_LLM_API_KEY) {
    return {
      provider: envObj.DRAFT_LLM_PROVIDER,
      apiKey: envObj.DRAFT_LLM_API_KEY,
      model: envObj.DRAFT_LLM_MODEL || null,
    };
  }
  if (envObj.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      apiKey: envObj.ANTHROPIC_API_KEY,
      model: envObj.DRAFT_LLM_MODEL || "claude-sonnet-4-6",
    };
  }
  if (envObj.OPENAI_API_KEY) {
    return {
      provider: "openai",
      apiKey: envObj.OPENAI_API_KEY,
      model: envObj.DRAFT_LLM_MODEL || "gpt-4o-mini",
    };
  }
  return null;
}

// ─── ARG PARSING ────────────────────────────────────────────────────────────
// Two-phase: known flags first, unknown --x VALUE pairs collected for later
// param resolution. Boolean flags listed in KNOWN_BOOLEAN; value flags in
// KNOWN_VALUE. Everything else --x is treated as a param flag.
const KNOWN_BOOLEAN = new Set([
  "--help", "-h", "--version", "-V", "--demo",
  "--validate", "--list-placeholders",
  "--why", "--json", "--interactive", "-i",
  "--no-heuristic", "--yes-heuristic",
  "--no-llm", "--llm", "--check-llm",
  "--silent", "-q",
  "--diff",
  "--strict-runs",
]);

const KNOWN_VALUE = new Set([
  "--params", "--output", "-o", "--syntax", "--dictionary", "--completion",
]);

/**
 * Parse argv into a structured options object. Two-phase: known flags are
 * recognized explicitly; everything else of the form `--xxx VALUE` is
 * collected into `paramFlags` (canonical_key → value).
 *
 * @param {string[]} argv — typically `process.argv.slice(2)`.
 * @returns {ParsedArgs}
 * @throws {UsageError} on invalid `--syntax`, `--completion`, missing values.
 */
export function parseArgs(argv) {
  const opts = {
    positional: [],
    params: null,
    output: null,
    syntax: "bracket",
    dictionary: null,
    interactive: false,
    validate: false,
    listPlaceholders: false,
    why: false,
    json: false,
    demo: false,
    completion: null,
    silent: false,
    checkLlm: false,
    diff: false,
    noHeuristic: false,
    yesHeuristic: false,
    noLlm: false,
    forceLlm: false,
    strictRuns: false,
    help: false,
    version: false,
    paramFlags: {}, // canonical_key -> value (set from --kebab-name VALUE)
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { opts.help = true; continue; }
    if (a === "--version" || a === "-V") { opts.version = true; continue; }
    if (a === "--demo") { opts.demo = true; continue; }
    if (a === "--validate") { opts.validate = true; continue; }
    if (a === "--list-placeholders") { opts.listPlaceholders = true; continue; }
    if (a === "--why") { opts.why = true; continue; }
    if (a === "--json") { opts.json = true; continue; }
    if (a === "--interactive" || a === "-i") { opts.interactive = true; continue; }
    if (a === "--no-heuristic") { opts.noHeuristic = true; continue; }
    if (a === "--yes-heuristic") { opts.yesHeuristic = true; continue; }
    if (a === "--no-llm") { opts.noLlm = true; continue; }
    if (a === "--llm") { opts.forceLlm = true; continue; }
    if (a === "--check-llm") { opts.checkLlm = true; continue; }
    if (a === "--silent" || a === "-q") { opts.silent = true; continue; }
    if (a === "--diff") { opts.diff = true; continue; }
    if (a === "--strict-runs") { opts.strictRuns = true; continue; }
    if (a === "--params") { opts.params = argv[++i]; continue; }
    if (a === "--parties") { opts.parties = argv[++i]; continue; }
    if (a === "--bundle") { opts.bundle = argv[++i]; continue; }
    if (a === "--from-deal") { opts.fromDeal = argv[++i]; continue; }
    if (a === "--output" || a === "-o") { opts.output = argv[++i]; continue; }
    if (a === "--syntax") {
      const v = argv[++i];
      if (v !== "bracket" && v !== "mustache") {
        throw new UsageError(`--syntax must be 'bracket' or 'mustache' (got '${v}')`);
      }
      opts.syntax = v;
      continue;
    }
    if (a === "--dictionary") { opts.dictionary = argv[++i]; continue; }
    if (a === "--completion") {
      const v = argv[++i];
      if (v !== "bash" && v !== "zsh") {
        throw new UsageError(`--completion must be 'bash' or 'zsh' (got '${v}')`);
      }
      opts.completion = v;
      continue;
    }
    if (a.startsWith("--")) {
      // Unknown --x — treat as param flag with the next token as value.
      const key = kebabToSnake(a.slice(2));
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new UsageError(`flag ${a} requires a value`);
      }
      opts.paramFlags[key] = argv[++i];
      continue;
    }
    opts.positional.push(a);
  }
  return opts;
}

export class UsageError extends Error {
  constructor(msg) { super(msg); this.name = "UsageError"; }
}

// ─── KEY DERIVATION ─────────────────────────────────────────────────────────
/** @param {string} s @returns {string} kebab-case → snake_case. */
export function kebabToSnake(s) { return s.replace(/-/g, "_"); }

/**
 * Derive a canonical snake_case key from arbitrary placeholder text.
 * Permissive: non-alphanumerics collapse to `_`, leading-digit inputs get
 * an `_` prefix, length capped at 60. Always produces a valid snake_case
 * key for any non-empty input that contains at least one alphanumeric.
 *
 * @param {string} matchText — e.g. "Party A Name", "Today's date", "1 year(s)".
 * @returns {string} e.g. "party_a_name", "today_s_date", "_1_year_s".
 */
export function canonicalKey(matchText) {
  // Permissive slug: lowercase, non-alphanum runs become single "_",
  // strip leading/trailing "_", prefix "_" if leading char is a digit.
  let k = matchText.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (/^[0-9]/.test(k)) k = "_" + k;
  // Cap at 60 chars to keep CLI flags usable.
  if (k.length > 60) k = k.slice(0, 60).replace(/_+$/, "");
  return k;
}

const VALID_KEY_RE = /^[a-z_][a-z0-9_]*$/;
/** @param {string} key @returns {boolean} */
export function validKey(key) { return VALID_KEY_RE.test(key); }

// ─── HELP ───────────────────────────────────────────────────────────────────
export const HELP_TEXT = `\
draft — fill placeholders in a legal-document template.

USAGE
  draft <template>          [--params FILE] [--<PARAM> VALUE]... [options]
  draft <category>/<name>   (pulls via \`template-vault get\`)
  draft -                   (template body on stdin)
  draft --list-placeholders <template> [--json]
  draft --validate <template> --params FILE
  draft --demo              (bundled demo, no file needed)
  draft --completion bash   (emit shell completion script)

DETECTION CASCADE  (sequential-with-stop; first non-empty tier wins)
  1. bracket        [Title Case]              deterministic, default on
  2. mustache       {{Title Case}}            opt-in via --syntax mustache
  3. docx-highlight yellow / green / cyan     auto when input is .docx
  4. heuristic      generic-name dictionary   --no-heuristic to skip;
                                              warn-only without --yes-heuristic
  5. llm            last resort               runs only if .env or process env
                                              configures a provider; --no-llm
                                              disables; --llm forces

OPTIONS
  --params FILE         JSON file of param values (snake_case keys).
  -o, --output PATH     Write result to PATH (default: stdout).
  --syntax KIND         'bracket' (default) or 'mustache'.
  -i, --interactive     Prompt for any missing required parameters.
  --validate            Validate completeness; never writes output.
  --list-placeholders   Enumerate placeholders and exit.
  --why                 Print a structured explanation to stderr.
  --json                Emit JSON to stdout (suppresses human messages).
  -q, --silent          Suppress all stderr output (warnings, --why, notes).
  --no-heuristic        Disable tier 4.
  --yes-heuristic       Substitute tier-4 matches without confirmation.
  --no-llm              Disable tier 5 even when env is configured.
  --llm                 Assert env-configured LLM; fail-fast if not.
  --check-llm           One-token roundtrip to the configured provider.
  --diff                Show substitution table without writing output.
  --strict-runs         .docx only: skip placeholders that span multiple
                        runs (v0.2.0 behavior). Default is to merge runs
                        and emit a note for each merge.
  --dictionary PATH     Override the bundled heuristic dictionary.
  --completion bash|zsh Emit a shell completion script to stdout.
  --<param-name> VALUE  Set a parameter directly. Kebab -> snake_case.
  -h, --help            Show this help.
  -V, --version         Show version.

EXIT CODES
  0 ok   1 i/o error   2 validation   3 template-vault failure   4 llm failure

Part of the contract-operations suite. See cli.drbaher.com.
`;

// ─── INPUT RESOLUTION ───────────────────────────────────────────────────────
// Returns { kind: "text"|"docx", body: string, docxXml?: string, path: string|null }
const VAULT_REF_RE = /^[a-z][a-z0-9-]*\/[a-z0-9-]+(?:@[A-Za-z0-9._-]+)?$/;

/**
 * Resolve a positional template argument into a usable {@link Input}.
 * Handles three forms: stdin (`-`), a `template-vault get` ref
 * (`<category>/<name>[@version]`), or a filesystem path (text or `.docx`).
 *
 * @param {string} arg
 * @param {{ spawner?: typeof spawnSync, stdinReader?: () => Promise<string> }} [opts]
 *   Injectable spawn / stdin reader for tests.
 * @returns {Promise<Input>}
 * @throws {Error} with `.exitCode` set to one of {@link EXIT}'s values on
 *   I/O failure (1), vault subprocess failure (3), or `.docx` parse failure (1).
 */
export async function resolveInput(arg, { spawner = spawnSync, stdinReader = readStdin } = {}) {
  if (arg === "-") {
    return { kind: "text", body: await stdinReader(), path: null };
  }
  if (VAULT_REF_RE.test(arg)) {
    const r = spawner("template-vault", ["get", arg], { encoding: "utf8" });
    if (r.error || r.status !== 0) {
      const msg = (r.stderr || "").toString().trim() || (r.error && r.error.message) ||
                  `template-vault get ${arg} failed`;
      const e = new Error(msg);
      e.exitCode = EXIT.VAULT;
      throw e;
    }
    return { kind: "text", body: (r.stdout || "").toString(), path: null };
  }
  if (!existsSync(arg)) {
    const e = new Error(`template not found: ${arg}`);
    e.exitCode = EXIT.IO;
    throw e;
  }
  const ext = extname(arg).toLowerCase();
  if (ext === ".docx") {
    const { body, xml } = await extractDocxText(arg);
    return { kind: "docx", body, docxXml: xml, path: arg };
  }
  return { kind: "text", body: readFileSync(arg, "utf8"), path: arg };
}

/**
 * Read stdin to completion as a UTF-8 string.
 * @returns {Promise<string>}
 */
export async function readStdin() {
  return await new Promise((res, rej) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => res(s));
    process.stdin.on("error", rej);
  });
}

// ─── DOCX EXTRACTION (jszip + regex on word/document.xml) ───────────────────
async function loadJSZip() {
  try { return (await import("jszip")).default; }
  catch {
    const e = new Error("the 'jszip' package is required for .docx input.\nrun: npm install -g jszip  (or reinstall @drbaher/draft-cli)");
    e.exitCode = EXIT.IO;
    throw e;
  }
}

/**
 * Open a `.docx`, return its extracted plain-text body and the raw XML
 * (the XML is needed for tier-3 highlight detection).
 *
 * @param {string} path
 * @returns {Promise<{ body: string, xml: string }>}
 * @throws {Error} with `.exitCode = EXIT.IO` on missing jszip, invalid
 *   `.docx`, or missing `word/document.xml`.
 */
export async function extractDocxText(path) {
  const JSZip = await loadJSZip();
  let zip;
  try { zip = await JSZip.loadAsync(readFileSync(path)); }
  catch (err) {
    const e = new Error(`could not open .docx (${err.message})`);
    e.exitCode = EXIT.IO;
    throw e;
  }
  const docFile = zip.file("word/document.xml");
  if (!docFile) {
    const e = new Error("invalid .docx: missing word/document.xml");
    e.exitCode = EXIT.IO;
    throw e;
  }
  const xml = await docFile.async("string");
  return { body: docxXmlToText(xml), xml };
}

/**
 * Re-read the original `.docx`, swap in a new `word/document.xml`, and
 * return the resulting `.docx` as a `Buffer`. All other parts of the
 * package (`[Content_Types].xml`, relationships, images, headers, etc.)
 * pass through unchanged.
 *
 * @param {string} originalPath — filesystem path to the source `.docx`.
 * @param {string} newDocumentXml — replacement content for `word/document.xml`.
 * @returns {Promise<Buffer>}
 * @throws {Error} with `.exitCode = EXIT.IO` on missing jszip or invalid source.
 */
export async function writeDocxBuffer(originalPath, newDocumentXml) {
  const JSZip = await loadJSZip();
  let zip;
  try { zip = await JSZip.loadAsync(readFileSync(originalPath)); }
  catch (err) {
    const e = new Error(`could not re-open source .docx (${err.message})`);
    e.exitCode = EXIT.IO;
    throw e;
  }
  zip.file("word/document.xml", newDocumentXml);
  return await zip.generateAsync({ type: "nodebuffer" });
}

/**
 * Derive the default `.docx` output filename from an input path. Appends
 * `-filled` before the extension: `contract.docx` → `contract-filled.docx`.
 * If the input has no extension, appends `-filled.docx`.
 * @param {string} inputPath
 * @returns {string}
 */
export function makeDocxOutputPath(inputPath) {
  const ext = extname(inputPath);
  if (!ext) return `${inputPath}-filled.docx`;
  return `${inputPath.slice(0, -ext.length)}-filled${ext}`;
}

// Walk the XML in document order. For each <w:p> emit a line; concatenate
// <w:t> contents within. Decode XML entities. Used for both output body and
// T1/T2 detection on docx input.
/**
 * Walk Word's document XML in paragraph order and produce plain text.
 * One line per `<w:p>`; text-run contents concatenated within. XML entities
 * are decoded via {@link decodeXml}.
 *
 * @param {string} xml
 * @returns {string}
 */
export function docxXmlToText(xml) {
  const paragraphs = xml.split(/<w:p[\s>]/i).slice(1);
  const lines = [];
  for (const p of paragraphs) {
    const para = p.split(/<\/w:p>/i)[0];
    const texts = [];
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(para)) !== null) texts.push(decodeXml(m[1]));
    lines.push(texts.join(""));
  }
  return lines.join("\n");
}

/**
 * Decode the five XML entities that appear in Word's `<w:t>` runs.
 * @param {string} s
 * @returns {string}
 */
export function decodeXml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/**
 * Inverse of {@link decodeXml}. Used when writing substituted text back into
 * a Word document's `<w:t>` runs. Only encodes the three structural
 * characters; double- and single-quotes don't need encoding inside element
 * text content.
 * @param {string} s
 * @returns {string}
 */
export function encodeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const RECOGNIZED_HIGHLIGHTS = new Set(["yellow", "green", "cyan", "magenta"]);

// Scan the XML for highlighted runs. Returns an array of { text, color }.
/**
 * Find every highlighted text run in a Word document's XML. Unlike
 * {@link detectDocxHighlight}, does NOT dedupe — multiple occurrences of
 * the same highlighted text appear multiple times.
 *
 * @param {string} xml
 * @returns {Array<{ text: string, color: string }>}
 */
export function extractDocxHighlights(xml) {
  const out = [];
  const runRe = /<w:r\b[\s\S]*?<\/w:r>/g;
  let m;
  while ((m = runRe.exec(xml)) !== null) {
    const run = m[0];
    const hm = /<w:highlight\s+w:val="([^"]+)"/.exec(run);
    if (!hm) continue;
    const color = hm[1].toLowerCase();
    if (!RECOGNIZED_HIGHLIGHTS.has(color)) continue;
    const texts = [];
    const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let tm;
    while ((tm = tRe.exec(run)) !== null) texts.push(decodeXml(tm[1]));
    const text = texts.join("").trim();
    if (text) out.push({ text, color });
  }
  return out;
}

// ─── TIER 1: BRACKET ────────────────────────────────────────────────────────
// Match [...] runs that are NOT immediately followed by '(' (markdown link).
const BRACKET_RE = /\[([^\[\]\n]{1,200})\](?!\()/g;
const SECTION_REF_RE = /^\d+(?:\.\d+)*$/;
const CHECKBOX_RE = /^[ xX]{1,3}$/;

/**
 * The locked T1 admission rule. Rejects markdown links, checkbox markers,
 * pure section refs, punctuation-only runs, and all-uppercase headings.
 * Permissive otherwise — accepts sentence-shaped placeholders with full
 * punctuation, as real legal templates use.
 *
 * @param {string} inner — bracket contents (no `[` `]`).
 * @returns {boolean}
 */
export function isBracketPlaceholder(inner) {
  if (!inner) return false;
  if (CHECKBOX_RE.test(inner)) return false;
  if (SECTION_REF_RE.test(inner)) return false;
  // Must contain at least one letter so we don't catch [___] or [---].
  if (!/[A-Za-z]/.test(inner)) return false;
  // Reject all-caps headings ([CONFIDENTIALITY], [ARTICLE I]).
  if (inner === inner.toUpperCase() && /[A-Z]/.test(inner)) return false;
  return true;
}

/**
 * Tier 1 detection: bracketed `[...]` placeholders.
 *
 * `schemaAliases` (optional) is a Set of phrase strings declared in the
 * schema file; bracketed runs whose inner matches a schema alias are
 * admitted even if the heuristic rule {@link isBracketPlaceholder} would
 * reject them (lets a schema rescue `[COMPANY]`, `[_____________]`, etc.).
 *
 * @param {string} body
 * @param {Set<string>} [schemaAliases]
 * @returns {DetectionHit[]}
 */
export function detectBracket(body, schemaAliases = new Set()) {
  const out = [];
  let m;
  BRACKET_RE.lastIndex = 0;
  while ((m = BRACKET_RE.exec(body)) !== null) {
    if (isBracketPlaceholder(m[1]) || schemaAliases.has(m[1])) {
      out.push({ match: m[0], inner: m[1], index: m.index });
    }
  }
  return out;
}

// ─── TIER 2: MUSTACHE ───────────────────────────────────────────────────────
const MUSTACHE_RE = /\{\{\s*([^{}\n]{1,80}?)\s*\}\}/g;
const SNAKE_RE = /^[a-z][a-z0-9_]{0,78}$/;

/**
 * T2 admission rule. Accepts snake_case or Title-Case inner text.
 * @param {string} inner
 * @returns {boolean}
 */
export function isMustachePlaceholder(inner) {
  if (SNAKE_RE.test(inner)) return true;
  return isBracketPlaceholder(inner);
}

/**
 * Tier 2 detection: `{{Title Case}}` or `{{snake_case}}` mustache placeholders.
 * Only invoked when `--syntax mustache` is selected. Schema-rescue same as T1.
 *
 * @param {string} body
 * @param {Set<string>} [schemaAliases]
 * @returns {DetectionHit[]}
 */
export function detectMustache(body, schemaAliases = new Set()) {
  const out = [];
  let m;
  MUSTACHE_RE.lastIndex = 0;
  while ((m = MUSTACHE_RE.exec(body)) !== null) {
    const inner = m[1].trim();
    if (isMustachePlaceholder(inner) || schemaAliases.has(inner)) {
      out.push({ match: m[0], inner, index: m.index });
    }
  }
  return out;
}

/**
 * Whether `body` contains both bracket and mustache placeholders.
 * Triggers the mixed-convention `--why`/stderr warning.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function hasBothConventions(body) {
  return detectBracket(body).length > 0 && detectMustache(body).length > 0;
}

// ─── TIER 3: DOCX HIGHLIGHT ─────────────────────────────────────────────────
/**
 * Tier 3 detection: scan a Word document's XML for highlighted text runs.
 * Recognizes yellow / green / cyan / magenta highlights as placeholders;
 * other colors are ignored. Dedupes by exact text match.
 *
 * @param {string} xml — content of `word/document.xml`.
 * @returns {DetectionHit[]}
 */
export function detectDocxHighlight(xml) {
  if (!xml) return [];
  const hits = extractDocxHighlights(xml);
  const seen = new Map();
  for (const { text, color } of hits) {
    if (!seen.has(text)) seen.set(text, { match: text, inner: text, color });
  }
  return [...seen.values()];
}

// ─── TIER 4: HEURISTIC ──────────────────────────────────────────────────────
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * Tier 4 detection: scan body for known generic-placeholder phrases from a
 * curated dictionary. Whole-word matching only. Returns one entry per
 * phrase that appears (dedupe by phrase).
 *
 * Note: substitute() does a global regex replace on T4 hits, so a single
 * detection may correspond to multiple substitutions in the output.
 *
 * @param {string} body
 * @param {string[]} [dict] — phrases to look for. Defaults to {@link DEFAULT_HEURISTIC_DICT}.
 * @returns {DetectionHit[]}
 */
export function detectHeuristic(body, dict = DEFAULT_HEURISTIC_DICT) {
  const out = [];
  const seen = new Set();
  for (const phrase of dict) {
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegex(phrase)}(?![A-Za-z0-9])`, "g");
    let m;
    while ((m = re.exec(body)) !== null) {
      if (!seen.has(phrase)) {
        seen.add(phrase);
        out.push({ match: phrase, inner: phrase, index: m.index });
      }
      break; // count once per phrase for detection; substitution replaces all
    }
  }
  return out;
}

// ─── TIER 5: LLM ────────────────────────────────────────────────────────────
/**
 * Tier 5 detection: ask an LLM to suggest placeholders in the body.
 *
 * Sends template text ONLY. Does not include params, schema, or env. The
 * provider's response is parsed as `{ placeholders: [{text, suggested_key}] }`;
 * malformed entries are dropped silently. Tests inject a `fetcher` so they
 * never make real network calls.
 *
 * @param {string} body
 * @param {LlmProvider} providerCfg
 * @param {{ fetcher?: typeof fetch | null }} [opts]
 * @returns {Promise<DetectionHit[]>}
 * @throws {Error} with `.exitCode = EXIT.LLM` on auth, transport, or
 *   parse failure.
 */
export async function detectLlm(body, providerCfg, { fetcher = (typeof fetch !== "undefined" ? fetch : null) } = {}) {
  if (!fetcher) {
    const e = new Error("fetch is not available; Node 18+ is required for the LLM tier");
    e.exitCode = EXIT.LLM;
    throw e;
  }
  const prompt = `You are a placeholder detector for a legal-document drafting tool.
Given the document text below, identify spans that look like placeholders — names, dates, or
party-identifier text that a drafter would replace before sending. Do NOT detect cross-references
or section labels. Output JSON ONLY in this exact shape:
{"placeholders":[{"text":"<verbatim span>","suggested_key":"<snake_case_key>"}]}

If you find nothing, output {"placeholders":[]}.

DOCUMENT:
${body.slice(0, 12000)}`;
  const raw = await callLlm(providerCfg, prompt, fetcher);
  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    const e = new Error(`LLM returned non-JSON response`);
    e.exitCode = EXIT.LLM;
    throw e;
  }
  const items = Array.isArray(parsed.placeholders) ? parsed.placeholders : [];
  const out = [];
  const seen = new Set();
  for (const it of items) {
    if (!it || typeof it.text !== "string" || typeof it.suggested_key !== "string") continue;
    if (!validKey(it.suggested_key)) continue;
    if (seen.has(it.suggested_key)) continue;
    seen.add(it.suggested_key);
    out.push({ match: it.text, inner: it.text, suggested_key: it.suggested_key });
  }
  return out;
}

/**
 * v2 #4: LLM inference from a free-form deal description.
 *
 * Takes the prose deal description (the user's notes about parties, dates,
 * amounts, etc.) and asks the configured T5 LLM provider to extract values
 * for the placeholders the cascade has already detected. Returns
 * `{values, extraKeys, warnings}`:
 *
 *   - values: `{key: string}` for every placeholder key the LLM filled
 *   - extraKeys: any keys the LLM emitted that aren't in the placeholders list (Q4.2 → warn)
 *   - warnings: human-readable messages for malformed entries
 *
 * Throws on missing provider config, missing `fetch`, network/HTTP error, or
 * non-JSON LLM response — same failure boundaries as `detectLlm`.
 *
 * @param {string} dealText — free-form deal description
 * @param {Placeholder[]} placeholders — the post-detection placeholder list
 * @param {ReturnType<llmProviderFromEnv>} providerCfg
 * @param {{ fetcher?: typeof fetch | null }} [opts]
 * @returns {Promise<{ values: Object<string,string>, extraKeys: string[], warnings: string[] }>}
 */
export async function inferFromDeal(dealText, placeholders, providerCfg, { fetcher = (typeof fetch !== "undefined" ? fetch : null) } = {}) {
  if (!fetcher) {
    const e = new Error("fetch is not available; Node 18+ is required for --from-deal");
    e.exitCode = EXIT.LLM;
    throw e;
  }
  if (!providerCfg) {
    const e = new Error("--from-deal requires an LLM provider; set ANTHROPIC_API_KEY / OPENAI_API_KEY / DRAFT_LLM_* in .env");
    e.exitCode = EXIT.LLM;
    throw e;
  }
  const wantedKeys = placeholders.map((p) => ({
    key: p.key,
    aliases: (p.aliases || []).slice(0, 4),
    first_seen_as: p.first_seen_as,
  }));
  if (wantedKeys.length === 0) {
    return { values: {}, extraKeys: [], warnings: [] };
  }
  const fieldList = wantedKeys.map((w) =>
    `  - ${w.key} (template placeholder: "${w.first_seen_as}"${w.aliases.length > 1 ? `; aliases: ${w.aliases.join(", ")}` : ""})`
  ).join("\n");
  const prompt = `You are filling parameters for a legal-document drafting tool.
A user has written prose describing a deal. Extract values for the following
fields from the deal description. Output JSON ONLY in this exact shape, with
no commentary:

{"values":{"<key>":"<extracted_value>",...}}

If a field can't be confidently extracted from the description, omit it (do
NOT guess). Do not invent additional fields not in the list. Match the deal's
language verbatim — don't reformat dates, currencies, or names.

FIELDS:
${fieldList}

DEAL DESCRIPTION:
${dealText.slice(0, 12000)}`;
  const raw = await callLlm(providerCfg, prompt, fetcher);
  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    const e = new Error(`LLM returned non-JSON response for --from-deal`);
    e.exitCode = EXIT.LLM;
    throw e;
  }
  const rawValues = (parsed && typeof parsed.values === "object" && parsed.values) ? parsed.values : {};
  const knownKeys = new Set(placeholders.map((p) => p.key));
  const values = {};
  const extraKeys = [];
  const warnings = [];
  for (const [k, v] of Object.entries(rawValues)) {
    if (!knownKeys.has(k)) {
      extraKeys.push(k);
      continue;
    }
    if (v === null || v === undefined) continue;
    if (typeof v !== "string" && typeof v !== "number") {
      warnings.push(`--from-deal: value for "${k}" was ${typeof v}, expected string; skipped`);
      continue;
    }
    values[k] = String(v);
  }
  return { values, extraKeys, warnings };
}

async function callLlm(cfg, prompt, fetcher) {
  if (cfg.provider === "anthropic") {
    const r = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model || "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) {
      const e = new Error(`LLM call failed: ${r.status} ${await safeText(r)}`);
      e.exitCode = EXIT.LLM;
      throw e;
    }
    const j = await r.json();
    return (j.content && j.content[0] && j.content[0].text) || "";
  }
  if (cfg.provider === "openai") {
    const r = await fetcher("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model || "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) {
      const e = new Error(`LLM call failed: ${r.status} ${await safeText(r)}`);
      e.exitCode = EXIT.LLM;
      throw e;
    }
    const j = await r.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  }
  const e = new Error(`unsupported LLM provider: ${cfg.provider}`);
  e.exitCode = EXIT.LLM;
  throw e;
}

async function safeText(r) { try { return await r.text(); } catch { return ""; } }

// ─── SCHEMA LOADING ─────────────────────────────────────────────────────────
// Returns { form: "short"|"long", entries: { [key]: { aliases, required, default } } }
// or null if no schema file exists.
/**
 * Look for a sibling `<template>.params.json` and parse it.
 *
 * @param {string|null} templatePath — pass null for stdin / vault input.
 * @returns {Schema|null} Parsed schema (with `.sourcePath` set) or null if no file.
 * @throws {Error} with `.exitCode = EXIT.IO` on malformed JSON or invalid structure.
 */
export function loadSchema(templatePath) {
  if (!templatePath) return null;
  const candidate = templatePath.replace(/\.[^./]+$/, "") + ".params.json";
  const alt = templatePath + ".params.json";
  const file = existsSync(candidate) ? candidate : existsSync(alt) ? alt : null;
  if (!file) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch (err) {
    const e = new Error(`schema file ${file} is not valid JSON: ${err.message}`);
    e.exitCode = EXIT.IO;
    throw e;
  }
  const out = parseSchema(parsed, file);
  out.sourcePath = file;
  return out;
}

/**
 * Validate and normalize a parsed JSON schema object. Auto-selects short vs
 * long form based on the presence of a top-level `_meta` key.
 *
 * @param {Object} parsed — JSON.parse output of the schema file.
 * @param {string} [sourceLabel] — used in error messages.
 * @returns {Schema}
 * @throws {Error} with `.exitCode = EXIT.IO` on invalid structure.
 */
export function parseSchema(parsed, sourceLabel = "<schema>") {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const e = new Error(`${sourceLabel}: top-level must be an object`);
    e.exitCode = EXIT.IO;
    throw e;
  }
  const long = Object.prototype.hasOwnProperty.call(parsed, "_meta");
  const entries = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k.startsWith("_")) continue;
    if (!validKey(k)) {
      const e = new Error(`${sourceLabel}: invalid key '${k}' (must be snake_case)`);
      e.exitCode = EXIT.IO;
      throw e;
    }
    if (long) {
      if (!v || typeof v !== "object" || !Array.isArray(v.aliases)) {
        const e = new Error(`${sourceLabel}: long-form entry '${k}' must have an aliases array`);
        e.exitCode = EXIT.IO;
        throw e;
      }
      // v2 #7: positional addressing. Optional `positions` array; each
      // element declares a role (its own canonical key) for the Nth detected
      // occurrence of this entry's aliases. Roles must be valid keys and
      // unique within the entry.
      let positions = null;
      if (v.positions !== undefined) {
        if (!Array.isArray(v.positions) || v.positions.length === 0) {
          const e = new Error(`${sourceLabel}: long-form entry '${k}' positions must be a non-empty array`);
          e.exitCode = EXIT.IO;
          throw e;
        }
        const roleSet = new Set();
        positions = [];
        for (let pi = 0; pi < v.positions.length; pi++) {
          const pos = v.positions[pi];
          if (!pos || typeof pos !== "object" || Array.isArray(pos)) {
            const e = new Error(`${sourceLabel}: '${k}'.positions[${pi}] must be an object with a 'role' string`);
            e.exitCode = EXIT.IO;
            throw e;
          }
          if (typeof pos.role !== "string" || !validKey(pos.role)) {
            const e = new Error(`${sourceLabel}: '${k}'.positions[${pi}].role must be a valid snake_case key`);
            e.exitCode = EXIT.IO;
            throw e;
          }
          if (roleSet.has(pos.role)) {
            const e = new Error(`${sourceLabel}: '${k}'.positions has duplicate role '${pos.role}'`);
            e.exitCode = EXIT.IO;
            throw e;
          }
          roleSet.add(pos.role);
          positions.push({ role: pos.role });
        }
      }
      // v2 #2: computed placeholders. Optional `computed` block on long-form
      // entries; { from: <other-key>, op: "+"|"-", value: "<n> <unit>" }.
      let computed = null;
      if (v.computed !== undefined) {
        if (!v.computed || typeof v.computed !== "object" || Array.isArray(v.computed)) {
          const e = new Error(`${sourceLabel}: long-form entry '${k}' has invalid 'computed' (must be an object)`);
          e.exitCode = EXIT.IO;
          throw e;
        }
        if (typeof v.computed.from !== "string") {
          const e = new Error(`${sourceLabel}: long-form entry '${k}' computed.from must be a string (key of another schema entry)`);
          e.exitCode = EXIT.IO;
          throw e;
        }
        if (v.computed.op !== "+" && v.computed.op !== "-") {
          const e = new Error(`${sourceLabel}: long-form entry '${k}' computed.op must be "+" or "-"`);
          e.exitCode = EXIT.IO;
          throw e;
        }
        if (typeof v.computed.value !== "string") {
          const e = new Error(`${sourceLabel}: long-form entry '${k}' computed.value must be a string (duration like "2 years")`);
          e.exitCode = EXIT.IO;
          throw e;
        }
        computed = { from: v.computed.from, op: v.computed.op, value: v.computed.value };
      }
      entries[k] = {
        aliases: v.aliases.slice(),
        required: v.required !== false,
        default: Object.prototype.hasOwnProperty.call(v, "default") ? v.default : null,
        // v2 #3: typed parameters. `type` is one of `date|money|party` (or
        // absent → no validation/normalization). `format` (date) and
        // `currency` (money) are optional.
        type: typeof v.type === "string" ? v.type : null,
        format: typeof v.format === "string" ? v.format : null,
        currency: typeof v.currency === "string" ? v.currency : null,
        computed,
        positions,
      };
    } else {
      if (!Array.isArray(v)) {
        const e = new Error(`${sourceLabel}: short-form entry '${k}' must be an array of phrase strings`);
        e.exitCode = EXIT.IO;
        throw e;
      }
      entries[k] = { aliases: v.slice(), required: true, default: null, type: null, format: null, currency: null, computed: null, positions: null };
    }
  }
  // v2 #2: validate computed references (point to existing keys; no cycles).
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry.computed) continue;
    if (!entries[entry.computed.from]) {
      const e = new Error(`${sourceLabel}: '${key}'.computed.from = "${entry.computed.from}" does not match any other key in this schema`);
      e.exitCode = EXIT.IO;
      throw e;
    }
    // Walk the computed.from chain from this key; bail if we revisit.
    const visited = [key];
    let cursor = entry.computed.from;
    while (cursor) {
      if (visited.includes(cursor)) {
        const e = new Error(`${sourceLabel}: computed cycle detected: ${[...visited, cursor].join(" → ")}`);
        e.exitCode = EXIT.IO;
        throw e;
      }
      visited.push(cursor);
      const next = entries[cursor];
      if (!next || !next.computed) break;
      cursor = next.computed.from;
    }
  }
  return { form: long ? "long" : "short", entries };
}

// ─── DETECTION ORCHESTRATOR ─────────────────────────────────────────────────
// Returns:
// {
//   tier: "bracket"|"mustache"|"docx-highlight"|"heuristic"|"llm",
//   placeholders: [ { key, first_seen_as, occurrences, tier, hits:[{match,inner,index?}] } ],
//   warnings: string[],
//   unmapped: [{ phrase, tier }],
// }
/**
 * Run the five-tier sequential-with-stop detection cascade on an input.
 * The first tier to return ≥1 hit wins; subsequent tiers are skipped.
 * Always emits a mixed-convention warning when both `[...]` and `{{...}}`
 * appear in the body, regardless of which tier wins.
 *
 * @param {Input} input
 * @param {ParsedArgs} opts
 * @param {Schema|null} schema
 * @param {Object<string, string>} envObj — merged file + process env.
 * @param {{ fetcher?: typeof fetch }} [io] — for LLM tier mocking.
 * @returns {Promise<CascadeResult>}
 * @throws {Error} with `.exitCode = EXIT.LLM` if `--llm` was set but no
 *   provider is configured.
 */
export async function runCascade(input, opts, schema, envObj, { fetcher } = {}) {
  const warnings = [];
  const body = input.body;
  const provider = llmProviderFromEnv(envObj);

  // Validate --llm up-front: if user asserts --llm, env must configure a provider.
  if (opts.forceLlm && !provider) {
    const e = new Error("--llm requires an LLM provider configured in .env or process env (ANTHROPIC_API_KEY, OPENAI_API_KEY, or DRAFT_LLM_*)");
    e.exitCode = EXIT.LLM;
    throw e;
  }

  // Mixed-convention warning regardless of cascade outcome.
  if (hasBothConventions(body)) {
    const b = detectBracket(body).length;
    const m = detectMustache(body).length;
    warnings.push(`mixed placeholder conventions: ${b} bracket, ${m} mustache (using --syntax ${opts.syntax})`);
  }

  // Pre-compute the schema's union of declared phrase forms so detection can
  // rescue placeholders the heuristic rule would otherwise reject (e.g. all-
  // caps signature-block markers like [COMPANY], or fill-in markers like
  // [_____________]). Without this, a schema-declared alias is silently
  // dropped during detection and never reaches the alias-resolution step.
  const schemaAliasSet = new Set();
  if (schema) {
    for (const entry of Object.values(schema.entries)) {
      for (const a of entry.aliases) schemaAliasSet.add(a);
    }
  }

  // Tier 1 / 2 (sequenced by --syntax; only the selected family runs).
  if (opts.syntax === "bracket") {
    const hits = detectBracket(body, schemaAliasSet);
    if (hits.length > 0) {
      return assemble("bracket", hits, schema, warnings);
    }
  } else {
    const hits = detectMustache(body, schemaAliasSet);
    if (hits.length > 0) {
      return assemble("mustache", hits, schema, warnings);
    }
  }

  // Tier 3 (docx-highlight) — only if input is .docx.
  if (input.kind === "docx") {
    const hits = detectDocxHighlight(input.docxXml);
    if (hits.length > 0) {
      return assemble("docx-highlight", hits, schema, warnings);
    }
  }

  // Tier 4 (heuristic).
  if (!opts.noHeuristic) {
    const dict = opts.dictionary ? readDictionary(opts.dictionary) : DEFAULT_HEURISTIC_DICT;
    const hits = detectHeuristic(body, dict);
    if (hits.length > 0) {
      const r = assemble("heuristic", hits, schema, warnings);
      r.heuristicGate = true; // signal: requires confirmation
      return r;
    }
  }

  // Tier 5 (LLM) — auto-runs when a provider is configured and --no-llm is absent.
  if (provider && !opts.noLlm) {
    const hits = await detectLlm(body, provider, { fetcher });
    if (hits.length > 0) {
      return assemble("llm", hits, schema, warnings, /*fromLlm=*/true);
    }
  }

  return { tier: "none", placeholders: [], warnings, unmapped: [] };
}

/**
 * Read a custom heuristic dictionary file. Must be a JSON array of strings.
 *
 * @param {string} path
 * @returns {string[]}
 * @throws {Error} with `.exitCode = EXIT.IO` on read or parse failure.
 */
export function readDictionary(path) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(j)) throw new Error("dictionary file must be a JSON array of strings");
    return j;
  } catch (err) {
    const e = new Error(`could not read dictionary ${path}: ${err.message}`);
    e.exitCode = EXIT.IO;
    throw e;
  }
}

function assemble(tier, hits, schema, warnings, fromLlm = false) {
  // Group hits by canonical key (schema-aware).
  const byKey = new Map();
  const unmapped = [];
  for (const h of hits) {
    const resolved = resolveKey(h, schema, fromLlm);
    if (!resolved) {
      unmapped.push({ phrase: h.inner, tier });
      continue;
    }
    if (!byKey.has(resolved.key)) {
      byKey.set(resolved.key, {
        key: resolved.key,
        first_seen_as: h.inner,
        occurrences: 0,
        tier,
        required: resolved.required,
        default: resolved.default,
        aliases: resolved.aliases,
        type: resolved.type,
        format: resolved.format,
        currency: resolved.currency,
        computed: resolved.computed,
        positions: resolved.positions,
        hits: [],
      });
    }
    const entry = byKey.get(resolved.key);
    entry.occurrences += 1;
    entry.hits.push(h);
  }
  // v2 #7: expand positional entries. Each detected occurrence becomes a
  // separate role-keyed placeholder. Count mismatch → positional_errors;
  // tier T3/T4/T5 (no per-hit index) → positional_errors (not supported).
  const placeholders = [];
  const positional_errors = [];
  const detected_schema_keys = [...byKey.keys()];
  for (const p of byKey.values()) {
    if (!p.positions) {
      placeholders.push(p);
      continue;
    }
    if (tier !== "bracket" && tier !== "mustache") {
      positional_errors.push({
        key: p.key,
        reason: `tier '${tier}' does not carry per-hit index info; positional addressing requires T1 (bracket) or T2 (mustache) detection`,
      });
      continue;
    }
    if (p.hits.length !== p.positions.length) {
      positional_errors.push({
        key: p.key,
        reason: `schema declares ${p.positions.length} position(s) but detected ${p.hits.length} occurrence(s) of "${p.aliases[0] || p.key}"`,
      });
      continue;
    }
    for (let i = 0; i < p.positions.length; i++) {
      placeholders.push({
        key: p.positions[i].role,
        first_seen_as: p.hits[i].inner,
        occurrences: 1,
        tier,
        required: true,
        default: null,
        aliases: p.aliases.slice(),
        type: p.type,
        format: p.format,
        currency: p.currency,
        computed: null,
        positions: null, // expanded; no further re-expansion
        hits: [p.hits[i]],
        position_parent: p.key,
        position_index: i,
      });
    }
  }
  return { tier, placeholders, warnings, unmapped, positional_errors, detected_schema_keys };
}

function resolveKey(hit, schema, fromLlm) {
  if (schema) {
    for (const [key, entry] of Object.entries(schema.entries)) {
      if (entry.aliases.includes(hit.inner)) {
        return {
          key,
          required: entry.required,
          default: entry.default,
          aliases: entry.aliases,
          type: entry.type || null,
          format: entry.format || null,
          currency: entry.currency || null,
          computed: entry.computed || null,
          positions: entry.positions || null,
        };
      }
    }
    return null;
  }
  const key = fromLlm && hit.suggested_key ? hit.suggested_key : canonicalKey(hit.inner);
  if (!validKey(key)) return null;
  return { key, required: true, default: null, aliases: [hit.inner], type: null, format: null, currency: null, computed: null, positions: null };
}

// ─── VALUE RESOLUTION (CLI > JSON > prompt > default) ───────────────────────
/**
 * Read the JSON `--params` file. Returns `{}` if path is null.
 *
 * @param {string | null} path
 * @returns {Object<string, *>}
 * @throws {Error} with `.exitCode = EXIT.IO` on missing or invalid file.
 */
export function loadParamsFile(path) {
  if (!path) return {};
  if (!existsSync(path)) {
    const e = new Error(`params file not found: ${path}`);
    e.exitCode = EXIT.IO;
    throw e;
  }
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) {
      const e = new Error(`params file ${path} must be a JSON object`);
      e.exitCode = EXIT.IO;
      throw e;
    }
    return j;
  } catch (err) {
    if (err.exitCode) throw err;
    const e = new Error(`could not parse ${path}: ${err.message}`);
    e.exitCode = EXIT.IO;
    throw e;
  }
}

/**
 * Load a `parties.json` registry (v2 #5). Returns the parsed object or
 * `null` if no file is present. Explicit `--parties PATH` errors if
 * the path doesn't exist; the default `./parties.json` is treated as
 * absent if the file isn't there (no error).
 *
 * @param {string | null} explicitPath — value of `--parties PATH`, or null
 *   to auto-detect `./parties.json` in CWD.
 * @returns {Object<string, Object<string, *>> | null}
 * @throws {Error} with `.exitCode = EXIT.IO` on missing explicit file or invalid JSON.
 */
export function loadParties(explicitPath) {
  const fallback = "parties.json";
  const path = explicitPath || (existsSync(fallback) ? fallback : null);
  if (!path) return null;
  if (!existsSync(path)) {
    const e = new Error(`parties file not found: ${path}`);
    e.exitCode = EXIT.IO;
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const e = new Error(`could not parse ${path}: ${err.message}`);
    e.exitCode = EXIT.IO;
    throw e;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const e = new Error(`parties file ${path} must be a JSON object`);
    e.exitCode = EXIT.IO;
    throw e;
  }
  // Reject non-object party entries early so downstream `ref:` resolution
  // can safely lookup fields without a per-call shape check.
  for (const [partyKey, party] of Object.entries(parsed)) {
    if (!party || typeof party !== "object" || Array.isArray(party)) {
      const e = new Error(`parties file ${path}: entry "${partyKey}" must be a JSON object`);
      e.exitCode = EXIT.IO;
      throw e;
    }
  }
  return parsed;
}

/**
 * Resolve a `ref:parties.<party>.<field>` reference against a loaded
 * parties object. Throws on malformed ref, missing parties registry,
 * unknown party, or unknown field. Non-`ref:` strings pass through
 * unchanged.
 *
 * @param {string} value
 * @param {Object<string, Object<string, *>> | null} parties
 * @returns {string}
 * @throws {Error} on malformed or unresolvable reference.
 */
export function resolveRef(value, parties) {
  if (typeof value !== "string" || !value.startsWith("ref:")) return value;
  if (!parties) {
    throw new Error(`reference "${value}" but no parties.json loaded (pass --parties PATH or put parties.json in cwd)`);
  }
  const m = /^ref:parties\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (!m) {
    throw new Error(`malformed reference "${value}" (expected "ref:parties.<party_key>.<field>")`);
  }
  const [, partyKey, fieldKey] = m;
  const party = parties[partyKey];
  if (!party) {
    throw new Error(`unknown party "${partyKey}" in reference "${value}"`);
  }
  if (!(fieldKey in party)) {
    throw new Error(`unknown field "${fieldKey}" on party "${partyKey}" in reference "${value}"`);
  }
  const out = party[fieldKey];
  return out == null ? "" : String(out);
}

/**
 * Walk a resolved-values map and replace any `ref:` strings with their
 * resolved values from the parties registry. CLI-sourced values are
 * left alone (Q2.2: refs are params/default only, never CLI). Collects
 * all errors before returning so the user sees every failure at once.
 *
 * @param {Object<string,string>} resolved — mutated in place.
 * @param {Object<string,string>} sources — from `resolveValues`.
 * @param {Object<string, Object<string, *>> | null} parties
 * @returns {{ ok: boolean, errors: Array<{ key: string, message: string }> }}
 */
export function resolveRefs(resolved, sources, parties) {
  const errors = [];
  for (const [key, value] of Object.entries(resolved)) {
    if (sources[key] === "cli") continue; // Q2.2: CLI values pass through
    if (typeof value !== "string" || !value.startsWith("ref:")) continue;
    try {
      resolved[key] = resolveRef(value, parties);
    } catch (e) {
      errors.push({ key, message: e.message });
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Load and validate a bundle definition (v2 #6). Bundles describe
 * multiple templates that should be filled with the same set of
 * parameter values in one invocation:
 *
 *   {
 *     "_meta": { "schema_version": 1 },
 *     "outputs": [
 *       { "template": "msa/v3.md",        "output": "out/msa.md" },
 *       { "template": "order-form/v3.md", "output": "out/order-form.md" }
 *     ]
 *   }
 *
 * Returns the parsed bundle. Throws on missing file, invalid JSON, no
 * `outputs` array, empty `outputs`, missing `template`/`output` on an
 * entry, or duplicate output paths.
 *
 * @param {string} path
 * @returns {{ outputs: Array<{ template: string, output: string }> }}
 * @throws {Error} with `.exitCode = EXIT.IO`
 */
export function loadBundle(path) {
  if (!existsSync(path)) {
    const e = new Error(`bundle file not found: ${path}`);
    e.exitCode = EXIT.IO;
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const e = new Error(`could not parse bundle ${path}: ${err.message}`);
    e.exitCode = EXIT.IO;
    throw e;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const e = new Error(`bundle ${path} must be a JSON object`);
    e.exitCode = EXIT.IO;
    throw e;
  }
  if (!Array.isArray(parsed.outputs) || parsed.outputs.length === 0) {
    const e = new Error(`bundle ${path}: missing or empty "outputs" array`);
    e.exitCode = EXIT.IO;
    throw e;
  }
  const seenOutputs = new Set();
  for (let i = 0; i < parsed.outputs.length; i++) {
    const o = parsed.outputs[i];
    if (!o || typeof o !== "object" || Array.isArray(o)) {
      const e = new Error(`bundle ${path}: outputs[${i}] must be an object`);
      e.exitCode = EXIT.IO;
      throw e;
    }
    if (typeof o.template !== "string" || !o.template) {
      const e = new Error(`bundle ${path}: outputs[${i}].template must be a non-empty string`);
      e.exitCode = EXIT.IO;
      throw e;
    }
    if (typeof o.output !== "string" || !o.output) {
      const e = new Error(`bundle ${path}: outputs[${i}].output must be a non-empty string`);
      e.exitCode = EXIT.IO;
      throw e;
    }
    if (seenOutputs.has(o.output)) {
      const e = new Error(`bundle ${path}: outputs[${i}].output "${o.output}" is duplicated`);
      e.exitCode = EXIT.IO;
      throw e;
    }
    seenOutputs.add(o.output);
  }
  return { outputs: parsed.outputs.map(o => ({ template: o.template, output: o.output })) };
}

/**
 * Resolve a value for every placeholder using the locked precedence chain:
 * CLI flag > `--params` JSON > `--interactive` prompt > schema default >
 * (missing). Empty-string CLI values are considered supplied (not missing).
 *
 * @param {Placeholder[]} placeholders
 * @param {ParsedArgs} opts
 * @param {Object<string, *>} paramsObj — parsed JSON params file.
 * @param {{ prompter?: (p: Placeholder) => Promise<string|null> }} [io]
 * @returns {Promise<ResolvedValues>}
 */
export async function resolveValues(placeholders, opts, paramsObj, { prompter = nodePrompter, inferred = null } = {}) {
  const resolved = {};
  const missing = [];
  const sources = {};
  for (const p of placeholders) {
    if (Object.prototype.hasOwnProperty.call(opts.paramFlags, p.key)) {
      resolved[p.key] = opts.paramFlags[p.key];
      sources[p.key] = "cli";
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(paramsObj, p.key)) {
      resolved[p.key] = String(paramsObj[p.key]);
      sources[p.key] = "params";
      continue;
    }
    // v2 #4: --from-deal LLM-inferred values, between --params and --interactive.
    if (inferred && Object.prototype.hasOwnProperty.call(inferred, p.key)) {
      resolved[p.key] = String(inferred[p.key]);
      sources[p.key] = "deal-llm";
      continue;
    }
    if (opts.interactive) {
      const v = await prompter(p);
      if (v !== null && v !== undefined && v !== "") {
        resolved[p.key] = String(v);
        sources[p.key] = "interactive";
        continue;
      }
    }
    if (p.default !== null && p.default !== undefined) {
      resolved[p.key] = String(p.default);
      sources[p.key] = "default";
      continue;
    }
    // v2 #2: computed placeholders auto-resolve later via `computeValues`.
    // Don't count them as missing here even though no source supplied a value.
    if (p.required && !p.computed) missing.push(p);
  }
  return { resolved, missing, sources };
}

// ─── TYPED-PARAMETER NORMALIZATION (v2 #3) ──────────────────────────────────
// Schema entries can declare `type: date | money | party` with optional
// `format` (date) or `currency` (money). Inputs are validated and normalized
// after value resolution and before substitution. Hard error (exit 4) on
// invalid input — typed params are opt-in; the user asked for validation.

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];
const MONTH_INDEX = (() => {
  const m = {};
  MONTH_NAMES.forEach((name, i) => {
    m[name.toLowerCase()] = i;
    m[name.slice(0, 3).toLowerCase()] = i;
  });
  // "Sept" is a common 4-letter abbrev.
  m.sept = 8;
  return m;
})();

/**
 * Parse a date input. Accepts ISO `YYYY-MM-DD` or spelled
 * `Month D, YYYY` / `Mon D YYYY`. Returns a UTC `Date` on success or `null`
 * on failure. Q3.1: US (`MM/DD/YYYY`) and European (`DD/MM/YYYY`) numeric
 * formats are NOT accepted — they're ambiguous and footgun-y. Use ISO for
 * machine input, spelled for human input.
 *
 * @param {string} raw
 * @returns {Date | null}
 */
export function parseDateValue(raw) {
  const s = String(raw).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    const date = new Date(Date.UTC(+y, +m - 1, +d));
    // Reject impossible dates (e.g. 2026-02-31 round-trips to 2026-03-03).
    if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +m - 1 || date.getUTCDate() !== +d) return null;
    return date;
  }
  const spelled = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (spelled) {
    const month = MONTH_INDEX[spelled[1].toLowerCase()];
    if (month === undefined) return null;
    const date = new Date(Date.UTC(+spelled[3], month, +spelled[2]));
    if (date.getUTCMonth() !== month || date.getUTCDate() !== +spelled[2]) return null;
    return date;
  }
  return null;
}

/**
 * Format a `Date` per a simple format string. Supported tokens:
 * `yyyy` (year), `MMMM` (full month name), `MM` (2-digit month), `d` (day).
 * Order doesn't matter; tokens are matched in a single pass so MMMM doesn't
 * accidentally consume MM, and `d` doesn't leak into month names.
 *
 * @param {Date} date
 * @param {string} format
 * @returns {string}
 */
export function formatDateValue(date, format) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  return format.replace(/yyyy|MMMM|MM|d/g, (token) => {
    if (token === "yyyy") return String(y);
    if (token === "MMMM") return MONTH_NAMES[m];
    if (token === "MM") return String(m + 1).padStart(2, "0");
    if (token === "d") return String(d);
    return token;
  });
}

/**
 * Parse a duration string for computed placeholders (v2 #2).
 * Accepts `<n> <unit>` where unit is one of `day | week | month | year`
 * (singular or plural). Returns an object with the unit as plural key.
 * Returns `null` on parse failure.
 *
 * @param {string} raw
 * @returns {{ days?: number, weeks?: number, months?: number, years?: number } | null}
 */
export function parseDuration(raw) {
  const m = /^(\d+)\s+(day|week|month|year)s?$/i.exec(String(raw).trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!isFinite(n) || n < 0) return null;
  const unit = m[2].toLowerCase();
  return { [`${unit}s`]: n };
}

/**
 * Add or subtract a duration from a Date. Uses UTC field manipulation
 * via `setUTC*` methods, so day/month/year overflow follows JavaScript's
 * default behavior (e.g. Jan 31 + 1 month = Mar 3, not Feb 28). For
 * legal-doc use cases ("2 years from effective date") this is the
 * expected behavior; anniversary dates are unambiguous.
 *
 * @param {Date} date
 * @param {"+"|"-"} op
 * @param {{ days?: number, weeks?: number, months?: number, years?: number }} dur
 * @returns {Date}
 */
export function addDuration(date, op, dur) {
  const sign = op === "-" ? -1 : 1;
  const d = new Date(date.getTime());
  if (dur.years) d.setUTCFullYear(d.getUTCFullYear() + sign * dur.years);
  if (dur.months) d.setUTCMonth(d.getUTCMonth() + sign * dur.months);
  if (dur.weeks) d.setUTCDate(d.getUTCDate() + sign * dur.weeks * 7);
  if (dur.days) d.setUTCDate(d.getUTCDate() + sign * dur.days);
  return d;
}

/**
 * Parse a money input. Accepts `$5,000`, `5000.50`, `$5M`, `2.5K`, etc.
 * Handles `K`/`M`/`B` suffixes (case-insensitive). Returns the value in
 * minor units (cents for USD) as an integer, or `null` on failure.
 *
 * @param {string} raw
 * @returns {number | null}
 */
export function parseMoneyValue(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  // Strict shape: optional minus, optional single $, digits (with optional
  // thousand-comma groups), optional decimal, optional K/M/B. Rejects
  // doubled `$`, ad-hoc comma placement, multiple decimals, words.
  if (!/^-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?[KMB]?$/i.test(s)) return null;
  let core = s.replace(/[$,\s]/g, "");
  let mult = 1;
  if (/[KMB]$/i.test(core)) {
    mult = { K: 1e3, M: 1e6, B: 1e9 }[core.slice(-1).toUpperCase()];
    core = core.slice(0, -1);
  }
  const n = parseFloat(core);
  if (!isFinite(n)) return null;
  return Math.round(n * mult * 100);
}

/**
 * Format a money value (in minor units, e.g. cents for USD) per a currency.
 * Q3.2: v2 supports USD only. Adds thousand separators and always renders
 * two decimal places.
 *
 * @param {number} minor — value in minor units (cents).
 * @param {string} currency — currency code (only "USD" supported in v2).
 * @returns {string}
 * @throws {Error} on unsupported currency.
 */
export function formatMoneyValue(minor, currency) {
  if (currency !== "USD") {
    throw new Error(`only USD is supported in v0.3.0; got currency="${currency}"`);
  }
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const dollars = Math.floor(abs / 100);
  const cents = abs % 100;
  const intPart = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${intPart}.${String(cents).padStart(2, "0")}`;
}

/**
 * Normalize a raw value per a placeholder's schema-declared type. Returns
 * the normalized string. Throws on invalid input (Q3.3 → hard error).
 * If no `type` is declared on the placeholder, returns the raw value
 * unchanged.
 *
 * @param {string} rawValue
 * @param {{ type?: string|null, format?: string|null, currency?: string|null, key?: string }} placeholder
 * @returns {string}
 * @throws {Error} with `.exitCode = EXIT.VALIDATION` on bad input.
 */
export function normalizeTypedValue(rawValue, placeholder) {
  const type = placeholder && placeholder.type;
  if (!type) return rawValue;
  if (type === "date") {
    const date = parseDateValue(rawValue);
    if (!date) {
      const e = new Error(
        `could not parse "${rawValue}" as a date. expected ISO ` +
        `(2027-01-15) or spelled ("January 15, 2027"). ` +
        `US ("01/15/2027") and European ("15/01/2027") forms are not ` +
        `accepted — they're ambiguous.`
      );
      e.exitCode = EXIT.VALIDATION;
      throw e;
    }
    return formatDateValue(date, placeholder.format || "MMMM d, yyyy");
  }
  if (type === "money") {
    const minor = parseMoneyValue(rawValue);
    if (minor === null) {
      const e = new Error(
        `could not parse "${rawValue}" as money. expected like ` +
        `"$5,000", "5000.50", "$5M", "2.5K".`
      );
      e.exitCode = EXIT.VALIDATION;
      throw e;
    }
    return formatMoneyValue(minor, placeholder.currency || "USD");
  }
  if (type === "party") {
    const s = String(rawValue).trim();
    if (!s) {
      const e = new Error(`party value must be non-empty`);
      e.exitCode = EXIT.VALIDATION;
      throw e;
    }
    if (/\]\(/.test(s)) {
      const e = new Error(`party value "${rawValue}" contains a markdown link; pass the bare party name instead.`);
      e.exitCode = EXIT.VALIDATION;
      throw e;
    }
    if (/[.!?,;:]$/.test(s)) {
      const e = new Error(`party value "${rawValue}" has trailing punctuation; remove it before passing.`);
      e.exitCode = EXIT.VALIDATION;
      throw e;
    }
    return s;
  }
  const e = new Error(`unknown type "${type}" on placeholder${placeholder.key ? ` "${placeholder.key}"` : ""}. expected one of: date, money, party.`);
  e.exitCode = EXIT.IO;
  throw e;
}

/**
 * Run {@link normalizeTypedValue} across every resolved placeholder value.
 * Mutates `resolved` in place with normalized strings. Collects all errors
 * before returning so the user sees every type failure at once.
 *
 * @param {Placeholder[]} placeholders
 * @param {Object<string,string>} resolved
 * @returns {{ ok: boolean, errors: Array<{ key: string, message: string }>, normalized: Object<string,{from: string, to: string, type: string}> }}
 */
export function normalizeTypedValues(placeholders, resolved) {
  const errors = [];
  const normalized = {};
  for (const p of placeholders) {
    if (!p.type) continue;
    if (resolved[p.key] === undefined) continue;
    const raw = resolved[p.key];
    try {
      const norm = normalizeTypedValue(raw, p);
      if (norm !== raw) normalized[p.key] = { from: raw, to: norm, type: p.type };
      resolved[p.key] = norm;
    } catch (e) {
      errors.push({ key: p.key, message: e.message });
    }
  }
  return { ok: errors.length === 0, errors, normalized };
}

// ─── COMPUTED PLACEHOLDERS (v2 #2) ──────────────────────────────────────────
// Schema entries can declare a `computed` block referencing another key in
// the same schema:
//
//   "term_end": { "aliases": ["Term End"], "type": "date",
//                 "computed": { "from": "effective_date", "op": "+", "value": "2 years" } }
//
// At substitution time, if no value was supplied via CLI/--params/interactive/
// default, the computed entry's value is derived from its `from` placeholder.
// CLI/--params explicit values still win — computed only fills the gap.
//
// Cycles in `from` references are detected at parseSchema time. Missing-`from`
// errors and bad-duration errors surface at compute time with a per-key
// message; like typed-param errors, all errors are collected before returning
// so the user sees every failure at once.

/**
 * Run computed-placeholder evaluation on already-resolved values. Mutates
 * `resolved` in place with computed values for any placeholder that has a
 * `computed` block and no existing value. Iterative — handles chains
 * (B from A, C from B) without an explicit topological sort.
 *
 * @param {Placeholder[]} placeholders
 * @param {Object<string,string>} resolved
 * @returns {{ ok: boolean, errors: Array<{ key: string, message: string }>, computed: Object<string,{from: string, op: string, value: string, to: string}> }}
 */
export function computeValues(placeholders, resolved) {
  const errors = [];
  const computed = {};
  const pending = placeholders.filter(
    (p) => p.computed && resolved[p.key] === undefined
  );
  if (pending.length === 0) return { ok: true, errors: [], computed: {} };

  let progress = true;
  while (progress && pending.length > 0) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      const fromKey = p.computed.from;
      const fromValue = resolved[fromKey];
      if (fromValue === undefined) continue;
      try {
        const result = computeOneValue(p, fromValue);
        resolved[p.key] = result;
        computed[p.key] = { from: fromKey, op: p.computed.op, value: p.computed.value, to: result };
        pending.splice(i, 1);
        progress = true;
      } catch (e) {
        errors.push({ key: p.key, message: e.message });
        pending.splice(i, 1);
      }
    }
  }
  for (const p of pending) {
    errors.push({
      key: p.key,
      message: `cannot compute: depends on "${p.computed.from}" which is unresolved`,
    });
  }
  return { ok: errors.length === 0, errors, computed };
}

function computeOneValue(p, fromValue) {
  // v2: dates only. Future expansions (money math, string concat) would
  // dispatch on placeholder type here.
  const date = parseDateValue(fromValue);
  if (!date) {
    throw new Error(
      `cannot parse "${fromValue}" as a date (from "${p.computed.from}"). ` +
      `Computed placeholders need a date-shaped source value.`
    );
  }
  const dur = parseDuration(p.computed.value);
  if (!dur) {
    throw new Error(
      `cannot parse duration "${p.computed.value}". Expected ` +
      `"<n> <unit>" where unit is day, week, month, or year (singular ` +
      `or plural).`
    );
  }
  const result = addDuration(date, p.computed.op, dur);
  return formatDateValue(result, p.format || "MMMM d, yyyy");
}

async function nodePrompter(placeholder) {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return await new Promise((res) => {
    rl.question(`${placeholder.key} (${placeholder.first_seen_as}): `, (a) => {
      rl.close(); res(a.trim());
    });
  });
}

// Schema declares params not present in the template → orphan error.
/**
 * Find schema-declared keys whose alias list matches no detected placeholder.
 * Orphans are exit-2 errors by design (catch schema drift early).
 *
 * @param {Schema|null} schema
 * @param {Placeholder[]} placeholders
 * @returns {Array<{key: string, aliases: string[]}>}
 */
export function findOrphans(schema, placeholders, detectedSchemaKeys = null) {
  if (!schema) return [];
  // v2 #7: for positional entries we check `detectedSchemaKeys` (the
  // pre-expansion key set) since the placeholders list shows role keys,
  // not the parent positional key. When detectedSchemaKeys is not given
  // (older callers / no schema-expansion path), fall back to the
  // placeholders list — same behavior as before v0.5.0.
  const presentForPositional = detectedSchemaKeys
    ? new Set(detectedSchemaKeys)
    : new Set(placeholders.map((p) => p.key));
  const presentForRegular = new Set(placeholders.map((p) => p.key));
  // v2 #2: an entry that another entry's `computed.from` points at is
  // legitimately not in the template — it's a "feeder" used only for
  // computation. Exempt those from the orphan check.
  const computedFromTargets = new Set();
  for (const entry of Object.values(schema.entries)) {
    if (entry.computed && entry.computed.from) computedFromTargets.add(entry.computed.from);
  }
  const orphans = [];
  for (const [key, entry] of Object.entries(schema.entries)) {
    if (computedFromTargets.has(key)) continue;
    const present = entry.positions ? presentForPositional : presentForRegular;
    if (present.has(key)) continue;
    orphans.push({ key, aliases: entry.aliases.slice() });
  }
  return orphans;
}

// ─── SUBSTITUTION ───────────────────────────────────────────────────────────
/**
 * Substitute resolved values into the template body. For T1/T2 (bracket /
 * mustache) we replace the literal match span; for T3/T4/T5 we do a
 * whole-word regex replace on the matched phrase. The original body is
 * preserved byte-for-byte except at substitution sites.
 *
 * @param {string} body
 * @param {Placeholder[]} placeholders
 * @param {Object<string, string>} values — key -> value, from {@link resolveValues}.
 * @param {Tier} tier
 * @returns {string} the substituted body.
 */
export function substitute(body, placeholders, values, tier) {
  // v2 #7: positional placeholders (`position_index !== undefined`) substitute
  // at a specific byte index, not by global replace. Collect them first,
  // apply in reverse-index order so earlier hits' indices stay stable. Then
  // the remaining (non-positional) placeholders use the original
  // replaceAll/regex logic, which is safe because positional hits all share
  // the same alias text — and after the index-based substitution, only the
  // exact bytes at each position have been replaced.
  let out = body;
  const positionalSubs = [];
  for (const p of placeholders) {
    if (p.position_index === undefined) continue;
    const v = values[p.key];
    if (v === undefined) continue;
    for (const h of p.hits) {
      if (typeof h.index !== "number") continue;
      positionalSubs.push({ index: h.index, length: h.match.length, value: v });
    }
  }
  positionalSubs.sort((a, b) => b.index - a.index);
  for (const s of positionalSubs) {
    out = out.slice(0, s.index) + s.value + out.slice(s.index + s.length);
  }
  for (const p of placeholders) {
    if (p.position_index !== undefined) continue; // already handled above
    const v = values[p.key];
    if (v === undefined) continue;
    for (const h of p.hits) {
      if (tier === "bracket" || tier === "mustache") {
        out = replaceAll(out, h.match, v);
      } else {
        // Tier 3/4/5: replace literal phrase (whole-word) globally.
        const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegex(h.inner)}(?![A-Za-z0-9])`, "g");
        out = out.replace(re, v);
      }
    }
  }
  return out;
}

function replaceAll(s, find, repl) {
  return s.split(find).join(repl);
}

/**
 * Substitute placeholder values *inside the Word XML*, preserving runs
 * and styling.
 *
 * Two-phase strategy (v0.9.0):
 *   1. Single-run pass — substitute when the placeholder text lives
 *      entirely inside one `<w:t>` element. Styling is fully preserved.
 *   2. Cross-run merge pass (default, opt out with `mergeRuns: false`) —
 *      walk each `<w:p>` paragraph and, for placeholders that span
 *      multiple runs inside the same paragraph, collapse the contributing
 *      runs into one with the *first* contributing run's `<w:rPr>`. Mid-
 *      placeholder styling variations are lost; styling on the runs
 *      flanking the placeholder is preserved.
 *
 * For T1 (bracket) / T2 (mustache) the search text is the literal match
 * (e.g. `[Party A]` or `{{party_a}}`). For T3 (docx-highlight), T4
 * (heuristic), T5 (llm) the search text is the run's inner content with
 * whole-word boundaries — same semantics as {@link substitute}.
 *
 * @param {string} xml — original `word/document.xml`.
 * @param {Placeholder[]} placeholders
 * @param {Object<string,string>} values — `{ key: resolvedValue }`.
 * @param {Tier} tier
 * @param {{ mergeRuns?: boolean }} [opts] — when `mergeRuns` is `false`,
 *   skip phase 2 and emit `skipped` warnings for cross-run placeholders
 *   (v0.2.0 behavior, exposed via `--strict-runs`).
 * @returns {{ xml: string, merged: string[], skipped: string[] }} —
 *   `merged` lists placeholder keys whose cross-run substitution lost
 *   in-placeholder styling; `skipped` lists keys that could not be
 *   substituted (cross-run with `mergeRuns: false`, or crossing a
 *   paragraph boundary even with merge enabled).
 */
export function substituteDocxXml(xml, placeholders, values, tier, opts = {}) {
  const mergeRuns = opts.mergeRuns !== false;
  const merged = new Set();
  const skipped = new Set();
  const originalText = docxXmlToText(xml);

  // Phase 1: single-run substitution (lossless, identical to v0.2.0).
  let out = xml;
  const remaining = []; // { key, find, value, literal } still needing cross-run work
  for (const p of placeholders) {
    const v = values[p.key];
    if (v === undefined) continue;
    for (const h of p.hits) {
      const literal = (tier === "bracket" || tier === "mustache");
      const find = literal ? h.match : h.inner;
      const buildRe = (global) => literal
        ? new RegExp(escapeRegex(find), global ? "g" : "")
        : new RegExp(`(?<![A-Za-z0-9])${escapeRegex(find)}(?![A-Za-z0-9])`, global ? "g" : "");
      const replaceRe = buildRe(true);
      let madeSubstitution = false;
      out = out.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (match, attrs, content) => {
        const decoded = decodeXml(content);
        replaceRe.lastIndex = 0;
        const replaced = decoded.replace(replaceRe, v);
        if (replaced === decoded) return match;
        madeSubstitution = true;
        return `<w:t${attrs || ""}>${encodeXml(replaced)}</w:t>`;
      });
      if (!madeSubstitution && buildRe(false).test(originalText)) {
        remaining.push({ key: p.key, find, value: v, literal });
      }
    }
  }

  // Phase 2: cross-run merge (opt out with mergeRuns:false).
  if (remaining.length === 0) {
    return { xml: out, merged: [], skipped: [] };
  }
  if (!mergeRuns) {
    for (const r of remaining) skipped.add(r.key);
    return { xml: out, merged: [], skipped: [...skipped] };
  }
  out = mergeAcrossRuns(out, remaining, merged, skipped);
  return { xml: out, merged: [...merged], skipped: [...skipped] };
}

// Phase 2 helper for substituteDocxXml. Walks each <w:p> and, for each
// remaining placeholder, finds occurrences in the concatenated run text
// and rewrites the contributing runs into one merged run that uses the
// FIRST contributing run's <w:rPr>. Non-run XML between merged runs
// (bookmarks, proof markers, etc.) is dropped — the surrounding flanks
// keep their non-run markup.
function mergeAcrossRuns(xml, remaining, merged, skipped) {
  const paraRe = /(<w:p\b[^>]*>)([\s\S]*?)(<\/w:p>)/g;
  const replacedXml = xml.replace(paraRe, (full, open, body, close) => {
    const parsed = parseParaParts(body);
    if (parsed.runs.length === 0) return full;
    let parts = parsed.parts; // mutable list of { type: "run", text, rPr, xml } | { type: "raw", xml }

    for (const r of remaining) {
      const re = r.literal
        ? new RegExp(escapeRegex(r.find), "g")
        : new RegExp(`(?<![A-Za-z0-9])${escapeRegex(r.find)}(?![A-Za-z0-9])`, "g");
      // Collect ALL match ranges in the current text in one pass, then
      // apply them right-to-left so earlier offsets remain valid. This
      // mirrors the non-overlapping semantics of String#replace and
      // prevents re-matching a substituted region.
      const text = partsToText(parts);
      const ranges = [];
      let m;
      while ((m = re.exec(text)) !== null) {
        ranges.push({ start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) re.lastIndex++; // defensive
      }
      if (ranges.length === 0) continue;
      for (let i = ranges.length - 1; i >= 0; i--) {
        const range = findContributingRunsInParts(parts, ranges[i].start, ranges[i].end);
        if (!range) continue;
        parts = buildMergedParts(parts, range, r.value);
        merged.add(r.key);
      }
    }

    return open + parts.map((p) => p.xml).join("") + close;
  });

  // Any placeholder we never managed to substitute (crosses paragraph
  // boundary, etc.) goes into skipped — unless it was merged elsewhere
  // (partial substitution still counts as merged).
  for (const r of remaining) {
    if (!merged.has(r.key)) skipped.add(r.key);
  }
  for (const k of merged) skipped.delete(k);

  return replacedXml;
}

// Parse a paragraph body into an ordered list of parts. Run parts carry
// decoded text + rPr; raw parts (non-run XML between runs) pass through
// verbatim.
function parseParaParts(body) {
  const parts = [];
  const runs = [];
  const runRe = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
  let lastIdx = 0;
  let m;
  while ((m = runRe.exec(body)) !== null) {
    if (m.index > lastIdx) {
      parts.push({ type: "raw", xml: body.slice(lastIdx, m.index) });
    }
    const runXml = m[0];
    const rprMatch = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(runXml);
    const rPr = rprMatch ? rprMatch[0] : "";
    const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    const texts = [];
    let tm;
    while ((tm = tRe.exec(runXml)) !== null) texts.push(decodeXml(tm[1]));
    const text = texts.join("");
    const part = { type: "run", xml: runXml, text, rPr };
    parts.push(part);
    runs.push(part);
    lastIdx = m.index + runXml.length;
  }
  if (lastIdx < body.length) {
    parts.push({ type: "raw", xml: body.slice(lastIdx) });
  }
  return { parts, runs };
}

function partsToText(parts) {
  let s = "";
  for (const p of parts) if (p.type === "run") s += p.text;
  return s;
}

// Find the run-parts that contribute to the text range [start, end).
// Returns { firstIdx, lastIdx, prefix, suffix } where firstIdx/lastIdx
// are indices into `parts` (NOT into a runs-only list), and prefix/suffix
// are the leading/trailing text of the first/last run outside the match.
function findContributingRunsInParts(parts, start, end) {
  let cursor = 0;
  let firstIdx = -1;
  let lastIdx = -1;
  let prefix = "";
  let suffix = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type !== "run") continue;
    const runStart = cursor;
    const runEnd = cursor + p.text.length;
    if (firstIdx === -1 && runEnd > start) {
      firstIdx = i;
      prefix = p.text.slice(0, start - runStart);
    }
    if (firstIdx !== -1 && runEnd >= end) {
      lastIdx = i;
      suffix = p.text.slice(end - runStart);
      break;
    }
    cursor = runEnd;
  }
  if (firstIdx === -1 || lastIdx === -1) return null;
  return { firstIdx, lastIdx, prefix, suffix };
}

// Splice parts: replace parts[firstIdx..lastIdx] (and intervening raw
// parts) with new run parts for the merged region. The merged run uses
// the FIRST contributing run's rPr for prefix+replacement; if there's a
// suffix from the LAST contributing run, it becomes a second run with
// the LAST contributing run's rPr (so styling flanking the placeholder
// is preserved).
function buildMergedParts(parts, range, replacementValue) {
  const first = parts[range.firstIdx];
  const last = parts[range.lastIdx];
  const newText = range.prefix + replacementValue;
  const mergedXml = `<w:r>${first.rPr}<w:t xml:space="preserve">${encodeXml(newText)}</w:t></w:r>`;
  const newParts = [
    ...parts.slice(0, range.firstIdx),
    { type: "run", xml: mergedXml, text: newText, rPr: first.rPr },
  ];
  if (range.suffix.length > 0) {
    const suffixXml = `<w:r>${last.rPr}<w:t xml:space="preserve">${encodeXml(range.suffix)}</w:t></w:r>`;
    newParts.push({ type: "run", xml: suffixXml, text: range.suffix, rPr: last.rPr });
  }
  for (let i = range.lastIdx + 1; i < parts.length; i++) newParts.push(parts[i]);
  return newParts;
}

/**
 * Decide whether to write `.docx` output (round-trip) versus plain text.
 * Returns `{ path }` for `.docx`, or `null` for text. Rules:
 *   - input must be `.docx`;
 *   - `--json`, `--diff`, `--validate`, `--list-placeholders` force text;
 *   - `--output PATH.docx` writes `.docx` to PATH;
 *   - `--output -` writes plain text to stdout (Unix `-` convention);
 *   - `--output PATH` with any other extension writes plain text;
 *   - no `--output` defaults to `<basename>-filled.docx`.
 *
 * @param {Object} opts — parsed CLI args.
 * @param {{kind: "text"|"docx", path: string|null}} input
 * @returns {{ path: string } | null}
 */
export function decideDocxOutput(opts, input) {
  if (input.kind !== "docx") return null;
  if (opts.json || opts.diff || opts.listPlaceholders || opts.validate) return null;
  if (opts.output === "-") return null;
  if (opts.output) {
    return extname(opts.output) === ".docx" ? { path: opts.output } : null;
  }
  return { path: makeDocxOutputPath(input.path || "out.docx") };
}

// ─── --why BUILDER ──────────────────────────────────────────────────────────
/**
 * Format the `--why` stderr block. Stable shape across minor versions; see
 * the `tier`, `placeholders`, `resolved`, `defaulted`, `unresolved`,
 * `unmapped`, and `warnings` keys.
 *
 * @param {{
 *   inputDescriptor: string,
 *   schemaDescriptor: string,
 *   tier: Tier,
 *   placeholders: Placeholder[],
 *   sources: Object<string, string>,
 *   missing: Placeholder[],
 *   unmapped: Array<{phrase: string, tier: Tier}>,
 *   warnings: string[],
 *   outputPath: string | null,
 * }} args
 * @returns {string}
 */
export function buildWhyBlock({ inputDescriptor, schemaDescriptor, tier, placeholders, sources, missing, unmapped, warnings, outputPath }) {
  const counts = { cli: 0, params: 0, interactive: 0, default: 0 };
  for (const s of Object.values(sources)) counts[s] = (counts[s] || 0) + 1;
  const distinct = placeholders.length;
  const occurrences = placeholders.reduce((acc, p) => acc + p.occurrences, 0);
  const lines = [
    `draft: substituted ${distinct - missing.length} of ${distinct} placeholders${outputPath ? ` → ${outputPath}` : ""}`,
    `why:`,
    `  input         = ${inputDescriptor}`,
    `  tier          = ${tier}`,
    `  schema        = ${schemaDescriptor}`,
    `  placeholders  = ${distinct} distinct, ${occurrences} occurrences`,
    `  resolved      = ${distinct - missing.length} (${counts.cli || 0} from CLI, ${counts.params || 0} from --params, ${counts.interactive || 0} interactive, ${counts.default || 0} default)`,
    `  defaulted     = ${counts.default || 0}`,
    `  unresolved    = ${missing.length}`,
    `  unmapped      = ${unmapped.length}${unmapped.length ? ` (${unmapped.map(u => u.phrase).join(", ")})` : ""}`,
    `  warnings      = ${warnings.length}`,
  ];
  return lines.join("\n");
}

// ─── COMMANDS ───────────────────────────────────────────────────────────────
function publicPlaceholders(placeholders) {
  return placeholders.map((p) => ({
    key: p.key,
    first_seen_as: p.first_seen_as,
    aliases: p.aliases,
    required: p.required,
    occurrences: p.occurrences,
    tier: p.tier,
  }));
}

export async function cmdListPlaceholders(opts, input, schema, envObj, { fetcher, out, err } = {}) {
  const result = await runCascade(input, opts, schema, envObj, { fetcher });
  const placeholders = publicPlaceholders(result.placeholders);
  if (opts.json) {
    out.write(JSON.stringify({
      template: input.path || (input.kind === "text" ? "-" : "<docx>"),
      tier: result.tier,
      placeholders,
      warnings: result.warnings,
      unmapped: result.unmapped,
    }, null, 2) + "\n");
  } else {
    if (placeholders.length === 0) {
      err.write(paint("no placeholders detected.\n", "yellow", err));
    } else {
      for (const p of placeholders) {
        out.write(`${p.key}  (${p.first_seen_as})${p.aliases.length > 1 ? `  aliases: ${p.aliases.join(", ")}` : ""}  ×${p.occurrences}  [tier=${p.tier}]\n`);
      }
    }
    for (const w of result.warnings) err.write(paint(`warning: ${w}\n`, "yellow", err));
  }
  return EXIT.OK;
}

export async function cmdValidate(opts, input, schema, paramsObj, envObj, { fetcher, out, err, parties = null, dealText = null } = {}) {
  const result = await runCascade(input, opts, schema, envObj, { fetcher });
  if (result.tier === "none") {
    err.write(paint("error: no placeholders detected by any tier\n", "red", err));
    return EXIT.VALIDATION;
  }
  // v2 #7: positional addressing errors (count mismatch, unsupported tier).
  if (result.positional_errors && result.positional_errors.length > 0) {
    for (const pe of result.positional_errors) {
      err.write(paint(`error: positional placeholder "${pe.key}": ${pe.reason}\n`, "red", err));
    }
    return EXIT.VALIDATION;
  }
  const orphans = findOrphans(schema, result.placeholders, result.detected_schema_keys);
  if (orphans.length > 0) {
    for (const o of orphans) {
      err.write(paint(`error: schema declares "${o.key}" with aliases [${o.aliases.map(a => `"${a}"`).join(",")}], but no matching phrase was detected by tier '${result.tier}'.\n`, "red", err));
    }
    return EXIT.VALIDATION;
  }
  // v2 #4: --from-deal LLM inference (when dealText is present and
  // --no-llm not set). Provider config comes from env. Errors are fatal
  // to keep the user from running with partial inferred values.
  let inferred = null;
  if (dealText && !opts.noLlm) {
    try {
      const r = await inferFromDeal(dealText, result.placeholders, llmProviderFromEnv(envObj), { fetcher });
      inferred = r.values;
      for (const k of r.extraKeys) {
        err.write(paint(`warning: --from-deal LLM emitted unknown key "${k}" (not in template/schema)\n`, "yellow", err));
      }
      for (const w of r.warnings) err.write(paint(`warning: ${w}\n`, "yellow", err));
    } catch (e) {
      err.write(paint(`error: ${e.message}\n`, "red", err));
      return e.exitCode || EXIT.LLM;
    }
  }
  const { resolved, missing, sources } = await resolveValues(result.placeholders, opts, paramsObj, { inferred });
  if (missing.length > 0) {
    printMissing(missing, err);
    if (opts.json) {
      out.write(JSON.stringify({ ok: false, missing: missing.map(m => m.key) }, null, 2) + "\n");
    }
    return EXIT.VALIDATION;
  }
  // v2 #5: parties.json ref resolution. Refs like
  // `ref:parties.acme_corp.name` in --params or schema defaults expand
  // before typed normalization. CLI values pass through unchanged.
  const refCheck = resolveRefs(resolved, sources, parties);
  if (!refCheck.ok) {
    for (const re of refCheck.errors) {
      err.write(paint(`error: parties reference failed for "${re.key}": ${re.message}\n`, "red", err));
    }
    if (opts.json) {
      out.write(JSON.stringify({
        ok: false,
        ref_errors: refCheck.errors.map(({ key, message }) => ({ key, message })),
      }, null, 2) + "\n");
    }
    return EXIT.VALIDATION;
  }
  // v2 #3: typed-parameter validation. Mirror what cmdDraft does so
  // `--validate` catches type errors before the user runs draft.
  const typeCheck = normalizeTypedValues(result.placeholders, resolved);
  if (!typeCheck.ok) {
    for (const te of typeCheck.errors) {
      err.write(paint(`error: type validation failed for "${te.key}": ${te.message}\n`, "red", err));
    }
    if (opts.json) {
      out.write(JSON.stringify({
        ok: false,
        type_errors: typeCheck.errors.map(({ key, message }) => ({ key, message })),
      }, null, 2) + "\n");
    }
    return EXIT.VALIDATION;
  }
  // v2 #2: computed-placeholder validation (same gate as cmdDraft).
  const computeCheck = computeValues(result.placeholders, resolved);
  if (!computeCheck.ok) {
    for (const ce of computeCheck.errors) {
      err.write(paint(`error: computed value failed for "${ce.key}": ${ce.message}\n`, "red", err));
    }
    if (opts.json) {
      out.write(JSON.stringify({
        ok: false,
        computed_errors: computeCheck.errors.map(({ key, message }) => ({ key, message })),
      }, null, 2) + "\n");
    }
    return EXIT.VALIDATION;
  }
  if (opts.json) {
    out.write(JSON.stringify({ ok: true, resolved: Object.keys(resolved), sources }, null, 2) + "\n");
  } else {
    err.write(paint(`ok: ${Object.keys(resolved).length} parameter(s) resolved\n`, "green", err));
  }
  return EXIT.OK;
}

export async function cmdDraft(opts, input, schema, paramsObj, envObj, { fetcher, out, err, parties = null, dealText = null } = {}) {
  const result = await runCascade(input, opts, schema, envObj, { fetcher });
  if (result.tier === "none") {
    const hasProvider = Boolean(llmProviderFromEnv(envObj));
    err.write(paint(
      `error: no placeholders detected by deterministic tiers (bracket, mustache, docx-highlight, heuristic).\n` +
      (hasProvider
        ? `hint: pass --llm to invoke LLM detection explicitly.\n`
        : `hint: set ANTHROPIC_API_KEY in .env to enable LLM detection,\n      or pass --syntax mustache if your template uses {{...}}.\n`),
      "red", err
    ));
    return EXIT.VALIDATION;
  }

  // Heuristic safety gate.
  if (result.heuristicGate && !opts.yesHeuristic) {
    if (process.stdin.isTTY && process.stderr.isTTY && !opts.json) {
      err.write(paint(`note: tier 'heuristic' found these generic phrases:\n`, "yellow", err));
      for (const p of result.placeholders) err.write(`  - ${p.first_seen_as}\n`);
      const ok = await confirmTty("substitute these? [y/N] ");
      if (!ok) {
        err.write(paint("aborted (heuristic not confirmed). Pass --yes-heuristic to skip this prompt.\n", "yellow", err));
        return EXIT.VALIDATION;
      }
    } else {
      err.write(paint(
        `warning: heuristic tier found ${result.placeholders.length} match(es) but --yes-heuristic was not given.\n` +
        `nothing was substituted. matches: ${result.placeholders.map(p => p.first_seen_as).join(", ")}\n`,
        "yellow", err
      ));
      return EXIT.VALIDATION;
    }
  }

  // v2 #7: positional addressing errors (count mismatch, unsupported tier).
  if (result.positional_errors && result.positional_errors.length > 0) {
    for (const pe of result.positional_errors) {
      err.write(paint(`error: positional placeholder "${pe.key}": ${pe.reason}\n`, "red", err));
    }
    return EXIT.VALIDATION;
  }
  // Orphan check.
  const orphans = findOrphans(schema, result.placeholders, result.detected_schema_keys);
  if (orphans.length > 0) {
    for (const o of orphans) {
      err.write(paint(`error: schema declares "${o.key}" with aliases [${o.aliases.map(a => `"${a}"`).join(",")}], but no matching phrase was detected by tier '${result.tier}'.\n`, "red", err));
      err.write(`hint: remove the entry from the schema, or add the phrase to the template.\n`);
    }
    return EXIT.VALIDATION;
  }

  // v2 #4: --from-deal LLM inference (when dealText is present and
  // --no-llm not set). Provider config comes from env. Errors are fatal
  // to keep the user from running with partial inferred values.
  let inferred = null;
  if (dealText && !opts.noLlm) {
    try {
      const r = await inferFromDeal(dealText, result.placeholders, llmProviderFromEnv(envObj), { fetcher });
      inferred = r.values;
      for (const k of r.extraKeys) {
        err.write(paint(`warning: --from-deal LLM emitted unknown key "${k}" (not in template/schema)\n`, "yellow", err));
      }
      for (const w of r.warnings) err.write(paint(`warning: ${w}\n`, "yellow", err));
    } catch (e) {
      err.write(paint(`error: ${e.message}\n`, "red", err));
      return e.exitCode || EXIT.LLM;
    }
  }

  const { resolved, missing, sources } = await resolveValues(result.placeholders, opts, paramsObj, { inferred });
  // Footgun guard: flag --typo'd-key VALUE that didn't match any detected
  // placeholder. Without this warning, a typo'd flag is silently dropped and
  // the user sees only a "missing required" error without the connection.
  const declaredKeys = new Set(result.placeholders.map((p) => p.key));
  const unusedFlags = Object.keys(opts.paramFlags).filter((k) => !declaredKeys.has(k));
  for (const u of unusedFlags) {
    result.warnings.push(`flag --${u.replace(/_/g, "-")} did not match any detected placeholder (possible typo?)`);
  }
  if (missing.length > 0) {
    printMissing(missing, err);
    if (unusedFlags.length > 0) {
      err.write(paint(`note: you also passed ${unusedFlags.map(u => `--${u.replace(/_/g, "-")}`).join(", ")} which did not match any placeholder.\n`, "yellow", err));
    }
    return EXIT.VALIDATION;
  }

  // v2 #5: parties.json ref resolution. Refs like
  // `ref:parties.acme_corp.name` in --params or schema defaults expand
  // before typed normalization. CLI values pass through unchanged
  // (Q2.2 lock).
  const refCheck = resolveRefs(resolved, sources, parties);
  if (!refCheck.ok) {
    for (const re of refCheck.errors) {
      err.write(paint(`error: parties reference failed for "${re.key}": ${re.message}\n`, "red", err));
    }
    return EXIT.VALIDATION;
  }

  // v2 #3: typed-parameter normalization. Schema entries can declare
  // `type: date | money | party`. Inputs are validated and normalized
  // before substitution. Hard error on bad input (Q3.3 decision).
  const typeCheck = normalizeTypedValues(result.placeholders, resolved);
  if (!typeCheck.ok) {
    for (const te of typeCheck.errors) {
      err.write(paint(`error: type validation failed for "${te.key}": ${te.message}\n`, "red", err));
    }
    return EXIT.VALIDATION;
  }

  // v2 #2: computed placeholders. Fill any computed entries whose value
  // wasn't already supplied via CLI / --params / --interactive / default.
  // Runs after typed normalization so the source values are in canonical
  // form (e.g. a "date" type is already in the format string before we
  // parse it back for arithmetic).
  const computeCheck = computeValues(result.placeholders, resolved);
  if (!computeCheck.ok) {
    for (const ce of computeCheck.errors) {
      err.write(paint(`error: computed value failed for "${ce.key}": ${ce.message}\n`, "red", err));
    }
    return EXIT.VALIDATION;
  }

  // Diff mode: print a substitution table and exit without writing output.
  if (opts.diff) {
    if (opts.json) {
      out.write(JSON.stringify({
        ok: true,
        tier: result.tier,
        diff: result.placeholders.map((p) => ({
          key: p.key,
          from: `[${p.first_seen_as}]`,
          to: resolved[p.key] !== undefined ? resolved[p.key] : null,
          occurrences: p.occurrences,
        })),
      }, null, 2) + "\n");
    } else {
      out.write(buildDiffBlock(result.placeholders, resolved, { stream: out }));
    }
    return EXIT.OK;
  }

  const output = substitute(input.body, result.placeholders, resolved, result.tier);

  // Write output. Three paths:
  //   (a) docx round-trip: input is .docx and target is .docx (default for .docx
  //       inputs, unless --output is set to a non-.docx extension or `-`).
  //   (b) write text to a file (--output PATH, where PATH ≠ "-").
  //   (c) write text to stdout (no --output, or --output "-").
  // --json suppresses (c) so it doesn't collide with the JSON payload.
  const docxOut = decideDocxOutput(opts, input);
  let writtenPath = null;
  if (docxOut) {
    try {
      const { xml: newXml, merged, skipped } = substituteDocxXml(
        input.docxXml, result.placeholders, resolved, result.tier,
        { mergeRuns: !opts.strictRuns }
      );
      for (const key of merged) {
        result.warnings.push(
          `docx run merge applied for "${key}": placeholder spanned multiple runs; ` +
          `surrounding styling kept, in-placeholder styling collapsed to the first run's. ` +
          `Use --strict-runs to skip cross-run substitution instead.`
        );
      }
      for (const key of skipped) {
        result.warnings.push(
          `docx substitution skipped for "${key}": placeholder spans multiple runs` +
          `${opts.strictRuns ? " and --strict-runs is set" : " across a paragraph boundary"}. ` +
          `Open the document, retype the placeholder so it lives in a single run, and retry.`
        );
      }
      const buf = await writeDocxBuffer(input.path, newXml);
      writeFileSync(docxOut.path, buf);
      writtenPath = docxOut.path;
    } catch (e) {
      err.write(paint(`error: could not write ${docxOut.path}: ${e.message}\n`, "red", err));
      return EXIT.IO;
    }
  } else if (opts.output && opts.output !== "-") {
    try { writeFileSync(opts.output, output, "utf8"); writtenPath = opts.output; }
    catch (e) {
      err.write(paint(`error: could not write ${opts.output}: ${e.message}\n`, "red", err));
      return EXIT.IO;
    }
  } else if (!opts.json) {
    out.write(output);
  }

  if (opts.json) {
    out.write(JSON.stringify({
      ok: true,
      tier: result.tier,
      output_path: writtenPath,
      output: writtenPath ? null : output,
      placeholders: publicPlaceholders(result.placeholders),
      sources,
      warnings: result.warnings,
      unmapped: result.unmapped,
    }, null, 2) + "\n");
  }

  if (opts.why && !opts.json) {
    err.write(buildWhyBlock({
      inputDescriptor: describeInput(input),
      schemaDescriptor: schema ? `${schema.sourcePath || "(parsed)"} (${schema.form} form)` : "(none, inferred)",
      tier: result.tier,
      placeholders: result.placeholders,
      sources,
      missing,
      unmapped: result.unmapped,
      warnings: result.warnings,
      outputPath: writtenPath,
    }) + "\n");
  }
  for (const w of result.warnings) err.write(paint(`warning: ${w}\n`, "yellow", err));
  return EXIT.OK;
}

/**
 * cmdBundle — orchestrate filling multiple templates with one shared
 * parameter set (v2 #6). For each bundle entry:
 *   1. resolveInput + loadSchema (per template)
 *   2. runCascade (per template)
 *   3. union placeholders by key
 * Then resolve values once across the union (CLI/--params/interactive/
 * default), run typed-param normalization + computed values, and write
 * each output. Q3.2 locked: any pre-write error (no-detection in an
 * entry, missing required param across the union, type / computed
 * failure) aborts the whole bundle before any file is written.
 *
 * @param {Object} opts
 * @param {{outputs: Array<{template: string, output: string}>}} bundle
 * @param {Object} paramsObj
 * @param {Object} envObj
 * @returns {Promise<number>} exit code
 */
export async function cmdBundle(opts, bundle, paramsObj, envObj, { fetcher, out, err, spawner, stdinReader, parties = null } = {}) {
  // Phase 1: load each template + schema, run detection.
  const entries = [];
  for (let i = 0; i < bundle.outputs.length; i++) {
    const o = bundle.outputs[i];
    let input, schema, cascade;
    try {
      input = await resolveInput(o.template, { spawner, stdinReader });
      schema = loadSchema(input.path);
    } catch (e) {
      err.write(paint(`error: bundle entry ${i} "${o.template}": ${e.message}\n`, "red", err));
      return e.exitCode || EXIT.IO;
    }
    cascade = await runCascade(input, opts, schema, envObj, { fetcher });
    if (cascade.tier === "none") {
      err.write(paint(`error: bundle entry ${i} "${o.template}": no placeholders detected by any tier\n`, "red", err));
      return EXIT.VALIDATION;
    }
    // v2 #7 positional errors per template — abort early.
    if (cascade.positional_errors && cascade.positional_errors.length > 0) {
      for (const pe of cascade.positional_errors) {
        err.write(paint(`error: bundle entry ${i} "${o.template}" positional placeholder "${pe.key}": ${pe.reason}\n`, "red", err));
      }
      return EXIT.VALIDATION;
    }
    // Orphan check per template (schema declares something not detected here).
    const orphans = findOrphans(schema, cascade.placeholders, cascade.detected_schema_keys);
    if (orphans.length > 0) {
      for (const oo of orphans) {
        err.write(paint(`error: bundle entry ${i} "${o.template}" schema declares "${oo.key}" but no matching phrase was detected by tier '${cascade.tier}'.\n`, "red", err));
      }
      return EXIT.VALIDATION;
    }
    entries.push({ output: o.output, input, schema, cascade });
  }

  // Phase 2: union placeholders by key. Q3.3 locked: union semantics —
  // a key declared/detected in any template applies to all. First
  // occurrence's metadata wins (required, default, type, format, etc.);
  // a per-template later occurrence may have richer aliases but we keep
  // the first canonical entry.
  const unionPlaceholders = [];
  const seenKeys = new Set();
  for (const e of entries) {
    for (const p of e.cascade.placeholders) {
      if (seenKeys.has(p.key)) continue;
      seenKeys.add(p.key);
      unionPlaceholders.push(p);
    }
  }

  // Phase 3: shared value resolution + footgun guard.
  const { resolved, missing, sources } = await resolveValues(unionPlaceholders, opts, paramsObj);
  const declaredKeys = new Set(unionPlaceholders.map((p) => p.key));
  const unusedFlags = Object.keys(opts.paramFlags).filter((k) => !declaredKeys.has(k));
  for (const u of unusedFlags) {
    err.write(paint(`warning: flag --${u.replace(/_/g, "-")} did not match any placeholder in any bundle template (possible typo?)\n`, "yellow", err));
  }
  if (missing.length > 0) {
    printMissing(missing, err);
    return EXIT.VALIDATION;
  }

  // v2 #5: parties.json refs resolve across the union before typed
  // normalization (same order as cmdDraft / cmdValidate).
  const refCheck = resolveRefs(resolved, sources, parties);
  if (!refCheck.ok) {
    for (const re of refCheck.errors) {
      err.write(paint(`error: parties reference failed for "${re.key}": ${re.message}\n`, "red", err));
    }
    return EXIT.VALIDATION;
  }

  // Phase 4: typed-parameter + computed pipelines (same as cmdDraft).
  const typeCheck = normalizeTypedValues(unionPlaceholders, resolved);
  if (!typeCheck.ok) {
    for (const te of typeCheck.errors) {
      err.write(paint(`error: type validation failed for "${te.key}": ${te.message}\n`, "red", err));
    }
    return EXIT.VALIDATION;
  }
  const computeCheck = computeValues(unionPlaceholders, resolved);
  if (!computeCheck.ok) {
    for (const ce of computeCheck.errors) {
      err.write(paint(`error: computed value failed for "${ce.key}": ${ce.message}\n`, "red", err));
    }
    return EXIT.VALIDATION;
  }

  // Phase 5: substitute per template + write. Q3.2: any write failure
  // exits with EXIT.IO; earlier successful writes are NOT rolled back
  // (atomicity at the filesystem is best-effort).
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const outputText = substitute(e.input.body, e.cascade.placeholders, resolved, e.cascade.tier);
    try {
      // For .docx input with .docx output: round-trip via substituteDocxXml.
      if (e.input.kind === "docx" && extname(e.output) === ".docx") {
        const { xml: newXml, merged, skipped } = substituteDocxXml(
          e.input.docxXml, e.cascade.placeholders, resolved, e.cascade.tier,
          { mergeRuns: !opts.strictRuns }
        );
        for (const key of merged) {
          err.write(paint(
            `warning (entry ${i}): docx run merge applied for "${key}": placeholder spanned multiple runs; ` +
            `surrounding styling kept, in-placeholder styling collapsed to the first run's.\n`,
            "yellow", err,
          ));
        }
        for (const key of skipped) {
          err.write(paint(
            `warning (entry ${i}): docx substitution skipped for "${key}": placeholder spans multiple runs` +
            `${opts.strictRuns ? " and --strict-runs is set" : " across a paragraph boundary"}.\n`,
            "yellow", err,
          ));
        }
        const buf = await writeDocxBuffer(e.input.path, newXml);
        writeFileSync(e.output, buf);
      } else {
        writeFileSync(e.output, outputText, "utf8");
      }
    } catch (writeErr) {
      err.write(paint(`error: bundle entry ${i} could not write ${e.output}: ${writeErr.message}\n`, "red", err));
      return EXIT.IO;
    }
  }

  if (!opts.silent && !opts.json) {
    err.write(paint(`ok: wrote ${entries.length} document(s) — ${entries.map(e => e.output).join(", ")}\n`, "green", err));
  }
  if (opts.json) {
    out.write(JSON.stringify({
      ok: true,
      outputs: entries.map(e => ({ template: e.input.path, output: e.output, tier: e.cascade.tier })),
      resolved_keys: Object.keys(resolved),
      sources,
    }, null, 2) + "\n");
  }
  return EXIT.OK;
}

function describeInput(input) {
  if (input.path) return input.path;
  if (input.kind === "text") return "stdin";
  return "<docx>";
}

function printMissing(missing, err) {
  err.write(paint("error: missing required parameter(s):\n", "red", err));
  for (const m of missing) {
    const flag = `--${m.key.replace(/_/g, "-")}`;
    err.write(`  - ${m.key}   (matched: ${m.aliases.map(a => `[${a}]`).join(", ")})\n      supply ${flag} or set "${m.key}" in --params\n`);
  }
}

async function confirmTty(prompt) {
  return await new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (a) => {
      rl.close();
      const v = a.trim().toLowerCase();
      res(v === "y" || v === "yes");
    });
  });
}

// ─── COMPLETION ─────────────────────────────────────────────────────────────
// Hand-rolled bash/zsh completion. No third-party generator. Install with:
//   draft --completion bash >> ~/.bashrc        # bash
//   draft --completion zsh  > ~/.zsh/_draft     # zsh (then add to fpath)

const BOOLEAN_FLAGS_FOR_COMPLETION = [
  "--help", "--version", "--demo", "--check-llm",
  "--validate", "--list-placeholders", "--diff",
  "--why", "--json", "--silent", "--interactive",
  "--no-heuristic", "--yes-heuristic",
  "--no-llm", "--llm",
  "--strict-runs",
];

const VALUE_FLAGS_FOR_COMPLETION = [
  "--params", "--output", "--syntax", "--dictionary", "--completion",
];

/**
 * Emit a shell completion script for the given shell.
 *
 * @param {"bash"|"zsh"} shell
 * @returns {string} the completion script body.
 * @throws {Error} with `.exitCode = EXIT.IO` for unsupported shells.
 */
export function completionScript(shell) {
  if (shell === "bash") return bashCompletion();
  if (shell === "zsh") return zshCompletion();
  const e = new Error(`unsupported shell for completion: ${shell}`);
  e.exitCode = EXIT.IO;
  throw e;
}

function bashCompletion() {
  const allFlags = [...BOOLEAN_FLAGS_FOR_COMPLETION, ...VALUE_FLAGS_FOR_COMPLETION].join(" ");
  return `# bash completion for draft-cli — install with:
#   draft --completion bash >> ~/.bashrc
# or, for a single session:
#   eval "$(draft --completion bash)"

_draft_completion() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
    --syntax)
      COMPREPLY=( $(compgen -W "bracket mustache" -- "$cur") )
      return 0
      ;;
    --completion)
      COMPREPLY=( $(compgen -W "bash zsh" -- "$cur") )
      return 0
      ;;
    --params|--dictionary)
      COMPREPLY=( $(compgen -f -X '!*.json' -- "$cur") $(compgen -d -- "$cur") )
      return 0
      ;;
    --output|-o)
      COMPREPLY=( $(compgen -f -- "$cur") )
      return 0
      ;;
  esac
  if [[ "$cur" == --* ]]; then
    COMPREPLY=( $(compgen -W "${allFlags}" -- "$cur") )
  elif [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "-h -V -i -o -q ${allFlags}" -- "$cur") )
  else
    COMPREPLY=( $(compgen -f -- "$cur") )
  fi
  return 0
}
complete -F _draft_completion draft
`;
}

function zshCompletion() {
  return `#compdef draft
# zsh completion for draft-cli — install with:
#   draft --completion zsh > ~/.zsh/completions/_draft
# and ensure ~/.zsh/completions is in fpath:
#   fpath=(~/.zsh/completions $fpath)
#   autoload -U compinit && compinit

_draft() {
  local -a flags
  flags=(
    '--help[show help]'
    '-h[show help]'
    '--version[show version]'
    '-V[show version]'
    '--demo[bundled demo, no file needed]'
    '--validate[completeness check, never writes output]'
    '--list-placeholders[enumerate placeholders and exit]'
    '--why[structured explanation to stderr]'
    '--json[machine-readable output on stdout]'
    '--silent[suppress all stderr output]'
    '-q[suppress all stderr output]'
    '--interactive[prompt for missing required params]'
    '-i[prompt for missing required params]'
    '--no-heuristic[disable tier 4]'
    '--yes-heuristic[substitute tier-4 matches without confirmation]'
    '--no-llm[disable tier 5 even when env is configured]'
    '--llm[assert env-configured LLM, fail-fast if missing]'
    '--check-llm[one-token roundtrip to verify provider config]'
    '--diff[show substitution table without writing output]'
    '--strict-runs[docx: skip placeholders that span multiple runs]'
    '--params[JSON params file]:params file:_files -g "*.json"'
    '--output[output path]:output:_files'
    '-o[output path]:output:_files'
    '--syntax[placeholder convention]:syntax:(bracket mustache)'
    '--dictionary[heuristic dictionary override]:dict:_files -g "*.json"'
    '--completion[emit shell completion script]:shell:(bash zsh)'
    '*:template:_files'
  )
  _arguments -s -S $flags
}

_draft "$@"
`;
}

// ─── DOCTOR: --check-llm ────────────────────────────────────────────────────
/**
 * One-token roundtrip to the configured LLM provider. Confirms env, auth,
 * and provider reachability without sending any template content. Useful in
 * CI / startup health checks for agent-driven pipelines.
 *
 * Returns EXIT.OK on success, EXIT.LLM on provider error, EXIT.IO if no
 * provider is configured.
 *
 * @param {Object<string, string>} envObj
 * @param {NodeJS.WritableStream} out
 * @param {NodeJS.WritableStream} err
 * @param {{ fetcher?: typeof fetch }} [io]
 * @returns {Promise<number>}
 */
export async function runCheckLlm(envObj, out, err, { fetcher } = {}) {
  const provider = llmProviderFromEnv(envObj);
  if (!provider) {
    err.write(paint("error: no LLM provider configured in .env or process env.\n", "red", err));
    err.write(`hint: set ANTHROPIC_API_KEY, OPENAI_API_KEY, or the DRAFT_LLM_* triple.\n`);
    return EXIT.IO;
  }
  err.write(paint(`checking ${provider.provider} (${provider.model || "default model"})…\n`, "cyan", err));
  try {
    const hits = await detectLlm("ping", provider, { fetcher });
    // Regardless of what detectLlm returns, getting through the parse step
    // without throwing means: auth ok, transport ok, response parseable.
    out.write(`ok: ${provider.provider} reachable, ${provider.model || "default model"}\n`);
    return EXIT.OK;
  } catch (e) {
    err.write(paint(`error: ${e.message}\n`, "red", err));
    return e.exitCode || EXIT.LLM;
  }
}

// ─── DIFF MODE ──────────────────────────────────────────────────────────────
/**
 * Build a per-placeholder substitution table for `--diff` mode. One line per
 * placeholder showing what would change, plus a summary footer.
 *
 * @param {Placeholder[]} placeholders
 * @param {Object<string, string>} resolved
 * @param {{stream?: {isTTY?: boolean}}} [io]
 * @returns {string}
 */
export function buildDiffBlock(placeholders, resolved, { stream } = {}) {
  if (placeholders.length === 0) return "no changes (no placeholders detected).\n";
  const maxFrom = Math.max(...placeholders.map((p) => `[${p.first_seen_as}]`.length));
  const lines = [];
  let totalSubstitutions = 0;
  let unresolvedCount = 0;
  for (const p of placeholders) {
    const from = `[${p.first_seen_as}]`.padEnd(maxFrom);
    const to = resolved[p.key];
    if (to === undefined) {
      lines.push(`  ${paint(from, "red", stream)}  →  ${paint("(unresolved)", "red", stream)}` +
                 (p.occurrences > 1 ? `   ×${p.occurrences}` : ""));
      unresolvedCount += 1;
    } else {
      lines.push(`  ${paint(from, "yellow", stream)}  →  ${paint(to, "green", stream)}` +
                 (p.occurrences > 1 ? `   ×${p.occurrences}` : ""));
      totalSubstitutions += p.occurrences;
    }
  }
  lines.unshift("changes that would be made:");
  lines.push("");
  lines.push(`${placeholders.length} placeholder(s), ${totalSubstitutions} substitution(s), ${unresolvedCount} unresolved.`);
  return lines.join("\n") + "\n";
}

// ─── DEMO (bundled fixture for the 30-second first run) ────────────────────
export const DEMO_TEMPLATE = `# Mutual Non-Disclosure Agreement (demo)

This Agreement is entered into on [Effective Date] between [Party A]
and [Party B] (collectively, the "Parties").

1. Confidentiality. [Party A] and [Party B] agree to keep confidential
   any information disclosed under this Agreement.

2. Term. This Agreement remains in effect for two years from the
   [Effective Date].
`;

export const DEMO_VALUES = {
  party_a: "Acme Corporation",
  party_b: "Vendor Inc.",
  effective_date: "2026-06-01",
};

export function runDemo(out, err) {
  const hits = detectBracket(DEMO_TEMPLATE);
  const byKey = new Map();
  for (const h of hits) {
    const key = canonicalKey(h.inner);
    if (!byKey.has(key)) byKey.set(key, { key, hits: [] });
    byKey.get(key).hits.push(h);
  }
  const placeholders = [...byKey.values()];
  const output = substitute(DEMO_TEMPLATE, placeholders, DEMO_VALUES, "bracket");
  err.write(paint("demo: substituting [Party A], [Party B], [Effective Date]\n", "cyan", err));
  out.write(output);
  err.write(paint("\nthis is what a real run looks like. try:\n", "dim", err));
  err.write(`  draft your-template.md --party-a "Acme" --party-b "Vendor" --effective-date 2026-06-01\n`);
  return EXIT.OK;
}

// ─── MAIN ───────────────────────────────────────────────────────────────────
// A stderr-like sink that drops everything. Used when --silent is set so
// downstream pipelines see zero stderr noise. Note: parse-time errors still
// go to the real stderr (--silent isn't honored until args are parsed).
const SILENT_STREAM = { write() {}, isTTY: false };

/**
 * The CLI entry point. Parses argv, resolves the input, runs the selected
 * mode (draft / list-placeholders / validate / demo / completion), and
 * returns the exit code.
 *
 * @param {string[]} argv — typically `process.argv.slice(2)`.
 * @param {{
 *   out?: NodeJS.WritableStream,
 *   err?: NodeJS.WritableStream,
 *   cwd?: string,
 *   env?: Object<string, string>,
 *   fetcher?: typeof fetch,
 *   spawner?: typeof spawnSync,
 *   stdinReader?: () => Promise<string>,
 * }} [io] — injection seam for tests.
 * @returns {Promise<number>} one of {@link EXIT}'s values.
 */
export async function main(argv, io = {}) {
  const out = io.out || process.stdout;
  const realErr = io.err || process.stderr;
  const cwd = io.cwd || process.cwd();
  const fetcher = io.fetcher;
  const spawner = io.spawner || spawnSync;
  const stdinReader = io.stdinReader || readStdin;
  const processEnv = io.env || process.env;

  let opts;
  try { opts = parseArgs(argv); }
  catch (e) {
    realErr.write(paint(`error: ${e.message}\n`, "red", realErr));
    realErr.write(`run \`draft --help\` for usage.\n`);
    return EXIT.IO;
  }

  const err = opts.silent ? SILENT_STREAM : realErr;

  if (opts.help) { out.write(HELP_TEXT); return EXIT.OK; }
  if (opts.version) { out.write(`draft-cli ${VERSION}\n`); return EXIT.OK; }
  if (opts.completion) { out.write(completionScript(opts.completion)); return EXIT.OK; }
  if (opts.demo) { return runDemo(out, err); }
  if (opts.checkLlm) {
    const envObj = effectiveEnv(cwd, processEnv);
    return await runCheckLlm(envObj, out, err, { fetcher });
  }

  // v2 #6: bundle mode. `--bundle PATH` reads a bundle definition and
  // orchestrates filling each entry's template with shared parameters.
  // In bundle mode, no positional template arg is required (the bundle
  // declares them).
  if (opts.bundle) {
    if (opts.positional.length > 0) {
      err.write(paint(`error: --bundle does not take a positional template arg (the bundle declares them)\n`, "red", err));
      return EXIT.IO;
    }
    let bundle, paramsObj, envObj, parties;
    try {
      bundle = loadBundle(opts.bundle);
      paramsObj = loadParamsFile(opts.params);
      envObj = effectiveEnv(cwd, processEnv);
      parties = loadParties(opts.parties || null);
    } catch (e) {
      err.write(paint(`error: ${e.message}\n`, "red", err));
      return e.exitCode || EXIT.IO;
    }
    try {
      return await cmdBundle(opts, bundle, paramsObj, envObj, { fetcher, out, err, spawner, stdinReader, parties });
    } catch (e) {
      err.write(paint(`error: ${e.message}\n`, "red", err));
      return e.exitCode || EXIT.IO;
    }
  }

  if (opts.positional.length === 0) {
    err.write(paint(`error: no template given\n`, "red", err));
    err.write(`run \`draft --help\` for usage.\n`);
    return EXIT.IO;
  }
  if (opts.positional.length > 1) {
    err.write(paint(`error: expected one template (got ${opts.positional.length})\n`, "red", err));
    return EXIT.IO;
  }

  let input, schema, paramsObj, envObj, parties, dealText;
  try {
    input = await resolveInput(opts.positional[0], { spawner, stdinReader });
    schema = loadSchema(input.path);
    paramsObj = loadParamsFile(opts.params);
    envObj = effectiveEnv(cwd, processEnv);
    parties = loadParties(opts.parties || null);
    // v2 #4: --from-deal PATH reads a free-form deal description.
    if (opts.fromDeal) {
      if (!existsSync(opts.fromDeal)) {
        const e = new Error(`deal description file not found: ${opts.fromDeal}`);
        e.exitCode = EXIT.IO;
        throw e;
      }
      dealText = readFileSync(opts.fromDeal, "utf8");
    }
  } catch (e) {
    err.write(paint(`error: ${e.message}\n`, "red", err));
    return e.exitCode || EXIT.IO;
  }

  try {
    if (opts.listPlaceholders) {
      return await cmdListPlaceholders(opts, input, schema, envObj, { fetcher, out, err });
    }
    if (opts.validate) {
      return await cmdValidate(opts, input, schema, paramsObj, envObj, { fetcher, out, err, parties, dealText });
    }
    return await cmdDraft(opts, input, schema, paramsObj, envObj, { fetcher, out, err, parties, dealText });
  } catch (e) {
    err.write(paint(`error: ${e.message}\n`, "red", err));
    return e.exitCode || EXIT.IO;
  }
}

// Entry point: only run when invoked directly (not when imported by tests).
const isMain = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); }
  catch { return false; }
})();
if (isMain) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => {
    process.stderr.write(`fatal: ${e && e.stack || e}\n`);
    process.exit(1);
  });
}
