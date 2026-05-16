#!/usr/bin/env node
// draft-cli — fill placeholders in legal-document templates.
// Part of the contract-operations suite. MIT. See LICENSE.
// Single-file Node.js CLI. Stdlib-only except `jszip` for .docx unzip.

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, basename, extname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";

// ─── EXIT CODES ─────────────────────────────────────────────────────────────
export const EXIT = { OK: 0, IO: 1, VALIDATION: 2, VAULT: 3, LLM: 4 };

// ─── COLOR (honors NO_COLOR / FORCE_COLOR) ──────────────────────────────────
const ANSI = {
  reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m", bold: "\x1b[1m",
};

export function colorEnabled(stream) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream && stream.isTTY);
}

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

export function effectiveEnv(cwd = process.cwd(), processEnv = process.env) {
  const fileEnv = readDotenv(join(cwd, ".env"));
  return { ...fileEnv, ...processEnv };
}

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
  "--no-llm", "--llm",
]);

const KNOWN_VALUE = new Set([
  "--params", "--output", "-o", "--syntax", "--dictionary",
]);

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
    noHeuristic: false,
    yesHeuristic: false,
    noLlm: false,
    forceLlm: false,
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
    if (a === "--params") { opts.params = argv[++i]; continue; }
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
export function kebabToSnake(s) { return s.replace(/-/g, "_"); }

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
  --no-heuristic        Disable tier 4.
  --yes-heuristic       Substitute tier-4 matches without confirmation.
  --no-llm              Disable tier 5 even when env is configured.
  --llm                 Run tier 5 even if earlier tiers found placeholders.
  --dictionary PATH     Override the bundled heuristic dictionary.
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
    const e = new Error("the 'jszip' package is required for .docx input.\nrun: npm install -g jszip  (or reinstall draft-cli)");
    e.exitCode = EXIT.IO;
    throw e;
  }
}

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

// Walk the XML in document order. For each <w:p> emit a line; concatenate
// <w:t> contents within. Decode XML entities. Used for both output body and
// T1/T2 detection on docx input.
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

export function decodeXml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

const RECOGNIZED_HIGHLIGHTS = new Set(["yellow", "green", "cyan", "magenta"]);

// Scan the XML for highlighted runs. Returns an array of { text, color }.
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

// Returns array of { match: "[Party A]", inner: "Party A", index }
export function detectBracket(body) {
  const out = [];
  let m;
  BRACKET_RE.lastIndex = 0;
  while ((m = BRACKET_RE.exec(body)) !== null) {
    if (isBracketPlaceholder(m[1])) {
      out.push({ match: m[0], inner: m[1], index: m.index });
    }
  }
  return out;
}

// ─── TIER 2: MUSTACHE ───────────────────────────────────────────────────────
const MUSTACHE_RE = /\{\{\s*([^{}\n]{1,80}?)\s*\}\}/g;
const SNAKE_RE = /^[a-z][a-z0-9_]{0,78}$/;

export function isMustachePlaceholder(inner) {
  if (SNAKE_RE.test(inner)) return true;
  return isBracketPlaceholder(inner);
}

export function detectMustache(body) {
  const out = [];
  let m;
  MUSTACHE_RE.lastIndex = 0;
  while ((m = MUSTACHE_RE.exec(body)) !== null) {
    if (isMustachePlaceholder(m[1])) {
      out.push({ match: m[0], inner: m[1].trim(), index: m.index });
    }
  }
  return out;
}

export function hasBothConventions(body) {
  return detectBracket(body).length > 0 && detectMustache(body).length > 0;
}

// ─── TIER 3: DOCX HIGHLIGHT ─────────────────────────────────────────────────
// Returns { match: text, inner: text, color } per unique highlighted phrase.
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
  return parseSchema(parsed, file);
}

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
      entries[k] = {
        aliases: v.aliases.slice(),
        required: v.required !== false,
        default: Object.prototype.hasOwnProperty.call(v, "default") ? v.default : null,
      };
    } else {
      if (!Array.isArray(v)) {
        const e = new Error(`${sourceLabel}: short-form entry '${k}' must be an array of phrase strings`);
        e.exitCode = EXIT.IO;
        throw e;
      }
      entries[k] = { aliases: v.slice(), required: true, default: null };
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

  // Tier 1 / 2 (sequenced by --syntax; only the selected family runs).
  if (opts.syntax === "bracket") {
    const hits = detectBracket(body);
    if (hits.length > 0) {
      return assemble("bracket", hits, schema, body, warnings);
    }
  } else {
    const hits = detectMustache(body);
    if (hits.length > 0) {
      return assemble("mustache", hits, schema, body, warnings);
    }
  }

  // Tier 3 (docx-highlight) — only if input is .docx.
  if (input.kind === "docx") {
    const hits = detectDocxHighlight(input.docxXml);
    if (hits.length > 0) {
      return assemble("docx-highlight", hits, schema, body, warnings);
    }
  }

  // Tier 4 (heuristic).
  if (!opts.noHeuristic) {
    const dict = opts.dictionary ? readDictionary(opts.dictionary) : DEFAULT_HEURISTIC_DICT;
    const hits = detectHeuristic(body, dict);
    if (hits.length > 0) {
      const r = assemble("heuristic", hits, schema, body, warnings);
      r.heuristicGate = true; // signal: requires confirmation
      return r;
    }
  }

  // Tier 5 (LLM) — auto-runs when a provider is configured and --no-llm is absent.
  if (provider && !opts.noLlm) {
    const hits = await detectLlm(body, provider, { fetcher });
    if (hits.length > 0) {
      return assemble("llm", hits, schema, body, warnings, /*fromLlm=*/true);
    }
  }

  return { tier: "none", placeholders: [], warnings, unmapped: [] };
}

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

function assemble(tier, hits, schema, body, warnings, fromLlm = false) {
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
        hits: [],
      });
    }
    const entry = byKey.get(resolved.key);
    entry.occurrences += 1;
    entry.hits.push(h);
  }
  return { tier, placeholders: [...byKey.values()], warnings, unmapped };
}

function resolveKey(hit, schema, fromLlm) {
  if (schema) {
    for (const [key, entry] of Object.entries(schema.entries)) {
      if (entry.aliases.includes(hit.inner)) {
        return { key, required: entry.required, default: entry.default, aliases: entry.aliases };
      }
    }
    return null;
  }
  const key = fromLlm && hit.suggested_key ? hit.suggested_key : canonicalKey(hit.inner);
  if (!validKey(key)) return null;
  return { key, required: true, default: null, aliases: [hit.inner] };
}

// ─── VALUE RESOLUTION (CLI > JSON > prompt > default) ───────────────────────
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

export async function resolveValues(placeholders, opts, paramsObj, { prompter = nodePrompter } = {}) {
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
    if (p.required) missing.push(p);
  }
  return { resolved, missing, sources };
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
export function findOrphans(schema, placeholders) {
  if (!schema) return [];
  const present = new Set(placeholders.map((p) => p.key));
  const orphans = [];
  for (const [key, entry] of Object.entries(schema.entries)) {
    if (!present.has(key)) orphans.push({ key, aliases: entry.aliases.slice() });
  }
  return orphans;
}

// ─── SUBSTITUTION ───────────────────────────────────────────────────────────
export function substitute(body, placeholders, values, tier) {
  let out = body;
  for (const p of placeholders) {
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

// ─── --why BUILDER ──────────────────────────────────────────────────────────
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

export async function cmdValidate(opts, input, schema, paramsObj, envObj, { fetcher, out, err } = {}) {
  const result = await runCascade(input, opts, schema, envObj, { fetcher });
  if (result.tier === "none") {
    err.write(paint("error: no placeholders detected by any tier\n", "red", err));
    return EXIT.VALIDATION;
  }
  const orphans = findOrphans(schema, result.placeholders);
  if (orphans.length > 0) {
    for (const o of orphans) {
      err.write(paint(`error: schema declares "${o.key}" with aliases [${o.aliases.map(a => `"${a}"`).join(",")}], but no matching phrase was detected by tier '${result.tier}'.\n`, "red", err));
    }
    return EXIT.VALIDATION;
  }
  const { resolved, missing, sources } = await resolveValues(result.placeholders, opts, paramsObj);
  if (missing.length > 0) {
    printMissing(missing, err);
    if (opts.json) {
      out.write(JSON.stringify({ ok: false, missing: missing.map(m => m.key) }, null, 2) + "\n");
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

export async function cmdDraft(opts, input, schema, paramsObj, envObj, { fetcher, out, err } = {}) {
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

  // Orphan check.
  const orphans = findOrphans(schema, result.placeholders);
  if (orphans.length > 0) {
    for (const o of orphans) {
      err.write(paint(`error: schema declares "${o.key}" with aliases [${o.aliases.map(a => `"${a}"`).join(",")}], but no matching phrase was detected by tier '${result.tier}'.\n`, "red", err));
      err.write(`hint: remove the entry from the schema, or add the phrase to the template.\n`);
    }
    return EXIT.VALIDATION;
  }

  const { resolved, missing, sources } = await resolveValues(result.placeholders, opts, paramsObj);
  if (missing.length > 0) {
    printMissing(missing, err);
    return EXIT.VALIDATION;
  }

  const output = substitute(input.body, result.placeholders, resolved, result.tier);

  // Write output.
  if (opts.output) {
    try { writeFileSync(opts.output, output, "utf8"); }
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
      output_path: opts.output || null,
      output: opts.output ? null : output,
      placeholders: publicPlaceholders(result.placeholders),
      sources,
      warnings: result.warnings,
      unmapped: result.unmapped,
    }, null, 2) + "\n");
  }

  if (opts.why && !opts.json) {
    err.write(buildWhyBlock({
      inputDescriptor: describeInput(input),
      schemaDescriptor: schema ? `${schema.form} form` : "(none, inferred)",
      tier: result.tier,
      placeholders: result.placeholders,
      sources,
      missing,
      unmapped: result.unmapped,
      warnings: result.warnings,
      outputPath: opts.output,
    }) + "\n");
  }
  for (const w of result.warnings) err.write(paint(`warning: ${w}\n`, "yellow", err));
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
export async function main(argv, io = {}) {
  const out = io.out || process.stdout;
  const err = io.err || process.stderr;
  const cwd = io.cwd || process.cwd();
  const fetcher = io.fetcher;
  const spawner = io.spawner || spawnSync;
  const stdinReader = io.stdinReader || readStdin;
  const processEnv = io.env || process.env;

  let opts;
  try { opts = parseArgs(argv); }
  catch (e) {
    err.write(paint(`error: ${e.message}\n`, "red", err));
    err.write(`run \`draft --help\` for usage.\n`);
    return EXIT.IO;
  }

  if (opts.help) { out.write(HELP_TEXT); return EXIT.OK; }
  if (opts.version) { out.write(`draft-cli ${VERSION}\n`); return EXIT.OK; }
  if (opts.demo) { return runDemo(out, err); }

  if (opts.positional.length === 0) {
    err.write(paint(`error: no template given\n`, "red", err));
    err.write(`run \`draft --help\` for usage.\n`);
    return EXIT.IO;
  }
  if (opts.positional.length > 1) {
    err.write(paint(`error: expected one template (got ${opts.positional.length})\n`, "red", err));
    return EXIT.IO;
  }

  let input, schema, paramsObj, envObj;
  try {
    input = await resolveInput(opts.positional[0], { spawner, stdinReader });
    schema = loadSchema(input.path);
    paramsObj = loadParamsFile(opts.params);
    envObj = effectiveEnv(cwd, processEnv);
  } catch (e) {
    err.write(paint(`error: ${e.message}\n`, "red", err));
    return e.exitCode || EXIT.IO;
  }

  try {
    if (opts.listPlaceholders) {
      return await cmdListPlaceholders(opts, input, schema, envObj, { fetcher, out, err });
    }
    if (opts.validate) {
      return await cmdValidate(opts, input, schema, paramsObj, envObj, { fetcher, out, err });
    }
    return await cmdDraft(opts, input, schema, paramsObj, envObj, { fetcher, out, err });
  } catch (e) {
    err.write(paint(`error: ${e.message}\n`, "red", err));
    return e.exitCode || EXIT.IO;
  }
}

// Entry point: only run when invoked directly (not when imported by tests).
const isMain = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]); }
  catch { return false; }
})();
if (isMain) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => {
    process.stderr.write(`fatal: ${e && e.stack || e}\n`);
    process.exit(1);
  });
}
