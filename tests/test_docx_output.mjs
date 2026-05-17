// .docx round-trip output (v0.2.0): substituteDocxXml, decideDocxOutput,
// makeDocxOutputPath, encodeXml, writeDocxBuffer.
//
// Coverage: tier-1 brackets inside <w:t>, tier-3 highlights, XML entity
// encoding of substituted values, split-run warning, end-to-end through
// main(), output-path resolution.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import {
  main,
  substituteDocxXml,
  decideDocxOutput,
  makeDocxOutputPath,
  encodeXml,
  decodeXml,
  docxXmlToText,
  writeDocxBuffer,
} from "../draft-cli.mjs";
import { tmp, makeDocx, runMain } from "./_helpers.mjs";

// Re-open a .docx buffer (or file) and return word/document.xml as a string.
async function readDocxXml(pathOrBuffer) {
  const { default: JSZip } = await import("jszip");
  const data = typeof pathOrBuffer === "string" ? readFileSync(pathOrBuffer) : pathOrBuffer;
  const zip = await JSZip.loadAsync(data);
  return await zip.file("word/document.xml").async("string");
}

test("encodeXml is the inverse of decodeXml for the three structural chars", () => {
  const raw = `A & B < c > d`;
  assert.equal(decodeXml(encodeXml(raw)), raw);
  assert.equal(encodeXml(raw), `A &amp; B &lt; c &gt; d`);
});

test("makeDocxOutputPath appends -filled before the extension", () => {
  assert.equal(makeDocxOutputPath("contract.docx"), "contract-filled.docx");
  assert.equal(makeDocxOutputPath("/tmp/deal.docx"), "/tmp/deal-filled.docx");
  assert.equal(makeDocxOutputPath("a.b.docx"), "a.b-filled.docx");
  assert.equal(makeDocxOutputPath("nameless"), "nameless-filled.docx");
});

test("decideDocxOutput: defaults to <basename>-filled.docx for .docx input", () => {
  const input = { kind: "docx", path: "/x/y.docx" };
  const got = decideDocxOutput({}, input);
  assert.deepEqual(got, { path: "/x/y-filled.docx" });
});

test("decideDocxOutput: text input always returns null", () => {
  const input = { kind: "text", path: "/x/y.md" };
  assert.equal(decideDocxOutput({}, input), null);
  assert.equal(decideDocxOutput({ output: "x.docx" }, input), null);
});

test("decideDocxOutput: --output - means stdout text (null)", () => {
  const input = { kind: "docx", path: "/x/y.docx" };
  assert.equal(decideDocxOutput({ output: "-" }, input), null);
});

test("decideDocxOutput: --output PATH.docx writes docx to PATH", () => {
  const input = { kind: "docx", path: "/x/y.docx" };
  assert.deepEqual(decideDocxOutput({ output: "/o/z.docx" }, input), { path: "/o/z.docx" });
});

test("decideDocxOutput: --output PATH.md writes text (null)", () => {
  const input = { kind: "docx", path: "/x/y.docx" };
  assert.equal(decideDocxOutput({ output: "/o/z.md" }, input), null);
});

test("decideDocxOutput: --json/--diff/--validate/--list-placeholders override docx", () => {
  const input = { kind: "docx", path: "/x/y.docx" };
  assert.equal(decideDocxOutput({ json: true }, input), null);
  assert.equal(decideDocxOutput({ diff: true }, input), null);
  assert.equal(decideDocxOutput({ validate: true }, input), null);
  assert.equal(decideDocxOutput({ listPlaceholders: true }, input), null);
});

test("substituteDocxXml: tier-1 bracket inside a single run", () => {
  const xml = `<w:p><w:r><w:t xml:space="preserve">Between [Party A] and Vendor.</w:t></w:r></w:p>`;
  const placeholders = [{
    key: "party_a",
    hits: [{ match: "[Party A]", inner: "Party A" }],
    occurrences: 1,
  }];
  const { xml: out, merged, skipped } = substituteDocxXml(xml, placeholders, { party_a: "Acme Corp" }, "bracket");
  assert.deepEqual(merged, []);
  assert.deepEqual(skipped, []);
  assert.match(out, /Between Acme Corp and Vendor\./);
  assert.doesNotMatch(out, /\[Party A\]/);
});

test("substituteDocxXml: tier-3 highlight in its own run, preserves rPr", () => {
  const xml = `<w:p>
    <w:r><w:t xml:space="preserve">Between </w:t></w:r>
    <w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>Acme Corp</w:t></w:r>
    <w:r><w:t xml:space="preserve"> and Vendor.</w:t></w:r>
  </w:p>`;
  const placeholders = [{
    key: "party_a",
    hits: [{ match: "Acme Corp", inner: "Acme Corp" }],
    occurrences: 1,
  }];
  const { xml: out, merged, skipped } = substituteDocxXml(xml, placeholders, { party_a: "Globex" }, "docx-highlight");
  assert.deepEqual(merged, []);
  assert.deepEqual(skipped, []);
  // Substituted value present.
  assert.match(out, /Globex/);
  // Highlight rPr preserved (we only touched <w:t> content).
  assert.match(out, /<w:highlight w:val="yellow"\/>/);
  // Original text replaced.
  assert.doesNotMatch(out, />Acme Corp</);
});

test("substituteDocxXml: encodes XML special chars in substituted values", () => {
  const xml = `<w:p><w:r><w:t>Owner: [Party A]</w:t></w:r></w:p>`;
  const placeholders = [{
    key: "party_a",
    hits: [{ match: "[Party A]", inner: "Party A" }],
    occurrences: 1,
  }];
  const { xml: out } = substituteDocxXml(xml, placeholders, { party_a: `Smith & <Co.>` }, "bracket");
  // The < > & chars must be encoded, not raw — else the XML is invalid.
  assert.match(out, /Smith &amp; &lt;Co\.&gt;/);
  assert.doesNotMatch(out, /<Co\.>/);
});

test("substituteDocxXml: merges across runs by default (v0.9.0)", () => {
  // [Party A] is split across two <w:t> elements (Word does this).
  const xml = `<w:p>
    <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Between [Party </w:t></w:r>
    <w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">A] and Vendor.</w:t></w:r>
  </w:p>`;
  const placeholders = [{
    key: "party_a",
    hits: [{ match: "[Party A]", inner: "Party A" }],
    occurrences: 1,
  }];
  const { xml: out, merged, skipped } = substituteDocxXml(xml, placeholders, { party_a: "Acme" }, "bracket");
  assert.deepEqual(merged, ["party_a"]);
  assert.deepEqual(skipped, []);
  // Substitution happened, original split text gone.
  assert.match(out, /Acme/);
  assert.doesNotMatch(out, /\[Party /);
  assert.doesNotMatch(out, /A\]/);
  // The merged run carries the FIRST contributing run's rPr (bold).
  // Trailing text from the LAST contributing run keeps italic.
  assert.match(out, /<w:b\/>/);
  assert.match(out, /<w:i\/>/);
});

test("substituteDocxXml: paragraph-boundary split is invisible to detection (no-op)", () => {
  // When a placeholder's text spans a <w:p> boundary, the concatenated
  // document text contains a newline between the halves, so the literal
  // "[Party A]" string isn't present in either paragraph's run text nor
  // in docxXmlToText output. Substitution makes no change and there is
  // nothing to merge OR skip — the placeholder is effectively invisible.
  // In practice Word doesn't split placeholders this way.
  const xml = `<w:p>
    <w:r><w:t xml:space="preserve">Between [Party </w:t></w:r>
  </w:p>
  <w:p>
    <w:r><w:t xml:space="preserve">A] and Vendor.</w:t></w:r>
  </w:p>`;
  const placeholders = [{
    key: "party_a",
    hits: [{ match: "[Party A]", inner: "Party A" }],
    occurrences: 1,
  }];
  const { xml: out, merged, skipped } = substituteDocxXml(xml, placeholders, { party_a: "Acme" }, "bracket");
  assert.deepEqual(merged, []);
  assert.deepEqual(skipped, []);
  // Original text intact.
  assert.match(out, /\[Party /);
  assert.match(out, /A\]/);
  assert.doesNotMatch(out, /Acme/);
});

test("substituteDocxXml: --strict-runs (mergeRuns:false) restores v0.2.0 skip", () => {
  const xml = `<w:p>
    <w:r><w:t xml:space="preserve">Between [Party </w:t></w:r>
    <w:r><w:t xml:space="preserve">A] and Vendor.</w:t></w:r>
  </w:p>`;
  const placeholders = [{
    key: "party_a",
    hits: [{ match: "[Party A]", inner: "Party A" }],
    occurrences: 1,
  }];
  const { xml: out, merged, skipped } = substituteDocxXml(
    xml, placeholders, { party_a: "Acme" }, "bracket", { mergeRuns: false },
  );
  assert.deepEqual(merged, []);
  assert.deepEqual(skipped, ["party_a"]);
  // Original runs intact.
  assert.match(out, /Between \[Party /);
  assert.match(out, /A\] and Vendor\./);
  assert.doesNotMatch(out, /Acme/);
});

test("substituteDocxXml: Common Paper-style three-run split ([, inner, ])", () => {
  // Reproduces the real-world split: brackets in one rPr, inner highlighted text in another.
  const xml = `<w:p>
    <w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>[</w:t></w:r>
    <w:r><w:rPr><w:highlight w:val="yellow"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">Fill in: today's date</w:t></w:r>
    <w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>]</w:t></w:r>
  </w:p>`;
  const placeholders = [{
    key: "effective_date",
    hits: [{ match: "[Fill in: today's date]", inner: "Fill in: today's date" }],
    occurrences: 1,
  }];
  const { xml: out, merged, skipped } = substituteDocxXml(
    xml, placeholders, { effective_date: "June 1, 2026" }, "bracket",
  );
  assert.deepEqual(merged, ["effective_date"]);
  assert.deepEqual(skipped, []);
  assert.match(out, /June 1, 2026/);
  assert.doesNotMatch(out, /\[Fill in/);
  assert.doesNotMatch(out, /today's date\]/);
  // First run's rPr (just highlight) wins for the merged region.
  assert.match(out, /<w:highlight w:val="yellow"\/>/);
});

test("substituteDocxXml: multiple cross-run placeholders in one paragraph", () => {
  const xml = `<w:p>
    <w:r><w:t xml:space="preserve">Hello [Party </w:t></w:r>
    <w:r><w:t xml:space="preserve">A], meet [Party </w:t></w:r>
    <w:r><w:t xml:space="preserve">B].</w:t></w:r>
  </w:p>`;
  const placeholders = [
    { key: "party_a", hits: [{ match: "[Party A]", inner: "Party A" }], occurrences: 1 },
    { key: "party_b", hits: [{ match: "[Party B]", inner: "Party B" }], occurrences: 1 },
  ];
  const { xml: out, merged, skipped } = substituteDocxXml(
    xml, placeholders, { party_a: "Acme", party_b: "Globex" }, "bracket",
  );
  assert.deepEqual(merged.sort(), ["party_a", "party_b"]);
  assert.deepEqual(skipped, []);
  // The merged document, read as plain text, has both substitutions in
  // place. Run boundaries between them are an XML artifact.
  assert.equal(docxXmlToText(out).trim(), "Hello Acme, meet Globex.");
});

test("substituteDocxXml: multiple occurrences of the same placeholder", () => {
  const xml = `<w:p>
    <w:r><w:t>[Party A] and [Party A] again.</w:t></w:r>
  </w:p>`;
  const placeholders = [{
    key: "party_a",
    hits: [{ match: "[Party A]", inner: "Party A" }],
    occurrences: 2,
  }];
  const { xml: out } = substituteDocxXml(xml, placeholders, { party_a: "Acme" }, "bracket");
  assert.match(out, /Acme and Acme again\./);
});

test("substituteDocxXml: tier-3 word-boundary match excludes substrings", () => {
  // "Acme" should match "Acme" but NOT "Acmeville".
  const xml = `<w:p>
    <w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>Acme</w:t></w:r>
    <w:r><w:t> Acmeville</w:t></w:r>
  </w:p>`;
  const placeholders = [{
    key: "party",
    hits: [{ match: "Acme", inner: "Acme" }],
    occurrences: 1,
  }];
  const { xml: out } = substituteDocxXml(xml, placeholders, { party: "Globex" }, "docx-highlight");
  // Globex replaces Acme (word boundary on the highlighted run).
  assert.match(out, /Globex/);
  // But Acmeville stays intact — the "Acme" prefix is NOT a word-boundary match.
  assert.match(out, /Acmeville/);
});

test("writeDocxBuffer: round-trip preserves all parts except document.xml", async () => {
  const dir = tmp();
  const inPath = await makeDocx(dir, "in.docx", ["original"]);
  const newXml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>replaced</w:t></w:r></w:p></w:body></w:document>`;
  const buf = await writeDocxBuffer(inPath, newXml);
  const roundTripped = await readDocxXml(buf);
  assert.match(roundTripped, /<w:t>replaced<\/w:t>/);
});

test("end-to-end: .docx input writes .docx to <basename>-filled.docx by default", async () => {
  const dir = tmp();
  const inPath = await makeDocx(dir, "deal.docx", [
    [{ text: "Hello " }, { text: "Acme Corp", highlight: "yellow" }, { text: "." }],
  ]);
  const { code, out, err } = await runMain(main, [
    inPath, "--acme-corp", "Globex",
  ]);
  assert.equal(code, 0, `expected exit 0; got ${code}; stderr: ${err}`);
  // Default output filename, next to input.
  const expectedOut = join(dir, "deal-filled.docx");
  assert.equal(existsSync(expectedOut), true, `expected output at ${expectedOut}`);
  // Nothing on stdout (file was written, not piped).
  assert.equal(out, "");
  // The written .docx has substituted values inside the same w:t runs.
  const xml = await readDocxXml(expectedOut);
  assert.match(xml, /Globex/);
});

test("end-to-end: .docx input writes substituted .docx round-trip with values", async () => {
  const dir = tmp();
  const inPath = await makeDocx(dir, "deal.docx", [
    [{ text: "Between " }, { text: "Acme Corp", highlight: "yellow" }, { text: " and Vendor." }],
  ]);
  const { code, err } = await runMain(main, [
    inPath,
    "--acme-corp", "Globex Industries",
  ]);
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  const outPath = join(dir, "deal-filled.docx");
  assert.equal(existsSync(outPath), true);
  const xml = await readDocxXml(outPath);
  assert.match(xml, /Globex Industries/);
  assert.doesNotMatch(xml, />Acme Corp</);
  // Yellow highlight rPr preserved on the substituted run.
  assert.match(xml, /<w:highlight w:val="yellow"\/>/);
});

test("end-to-end: --output - on .docx input writes substituted text to stdout", async () => {
  const dir = tmp();
  const inPath = await makeDocx(dir, "deal.docx", [
    [{ text: "Between " }, { text: "Acme Corp", highlight: "yellow" }, { text: " and Vendor." }],
  ]);
  const { code, out, err } = await runMain(main, [
    inPath,
    "--output", "-",
    "--acme-corp", "Globex",
  ]);
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  assert.match(out, /Between Globex and Vendor\./);
  // No file written, since output was stdout.
  assert.equal(existsSync(join(dir, "deal-filled.docx")), false);
});

test("end-to-end: --output PATH.docx writes substituted .docx to PATH", async () => {
  const dir = tmp();
  const inPath = await makeDocx(dir, "deal.docx", [
    [{ text: "Between " }, { text: "Acme Corp", highlight: "yellow" }, { text: " and Vendor." }],
  ]);
  const customOut = join(dir, "renamed.docx");
  const { code, err } = await runMain(main, [
    inPath,
    "--output", customOut,
    "--acme-corp", "Globex",
  ]);
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  assert.equal(existsSync(customOut), true);
  const xml = await readDocxXml(customOut);
  assert.match(xml, /Globex/);
  // The default-named file should NOT exist (--output was explicit).
  assert.equal(existsSync(join(dir, "deal-filled.docx")), false);
});

test("end-to-end: --output PATH.md on .docx input writes text to PATH", async () => {
  const dir = tmp();
  const inPath = await makeDocx(dir, "deal.docx", [
    [{ text: "Between " }, { text: "Acme Corp", highlight: "yellow" }, { text: " and Vendor." }],
  ]);
  const textOut = join(dir, "result.md");
  const { code, err } = await runMain(main, [
    inPath,
    "--output", textOut,
    "--acme-corp", "Globex",
  ]);
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  assert.equal(existsSync(textOut), true);
  const text = readFileSync(textOut, "utf8");
  assert.match(text, /Between Globex and Vendor\./);
});

test("end-to-end: split-run docx substitutes by default (v0.9.0)", async () => {
  const dir = tmp();
  // Build a docx that has [Party A] split across two runs with different rPr.
  // makeDocx helper escapes the brackets when building, so we craft the
  // document.xml directly via a custom paragraph composition.
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  zip.file("word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p>
          <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Between [Party </w:t></w:r>
          <w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">A] and Vendor.</w:t></w:r>
        </w:p>
      </w:body>
    </w:document>`);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const inPath = join(dir, "split.docx");
  const fs = await import("node:fs");
  fs.writeFileSync(inPath, buf);

  const { code, err } = await runMain(main, [
    inPath, "--party-a", "Acme",
  ]);
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  const outPath = join(dir, "split-filled.docx");
  assert.equal(existsSync(outPath), true);
  const xml = await readDocxXml(outPath);
  // The split runs collapse: the merged document text reads continuously.
  assert.equal(docxXmlToText(xml).trim(), "Between Acme and Vendor.");
  // Merge warning surfaced.
  assert.match(err, /docx run merge applied for "party_a"/);
});

test("end-to-end: --strict-runs skips split-run placeholders (v0.2.0 behavior)", async () => {
  const dir = tmp();
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  zip.file("word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p>
          <w:r><w:t xml:space="preserve">Between [Party </w:t></w:r>
          <w:r><w:t xml:space="preserve">A] and Vendor.</w:t></w:r>
        </w:p>
      </w:body>
    </w:document>`);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const inPath = join(dir, "split.docx");
  const fs = await import("node:fs");
  fs.writeFileSync(inPath, buf);

  const { code, err } = await runMain(main, [
    inPath, "--strict-runs", "--party-a", "Acme",
  ]);
  assert.equal(code, 0, `expected exit 0; stderr: ${err}`);
  const outPath = join(dir, "split-filled.docx");
  const xml = await readDocxXml(outPath);
  // Substitution did NOT happen — original split text intact.
  assert.match(xml, /Between \[Party /);
  assert.match(xml, /A\] and Vendor\./);
  assert.doesNotMatch(xml, /Acme/);
  // Skip warning surfaced.
  assert.match(err, /docx substitution skipped for "party_a"/);
});

test("end-to-end: --json on .docx input returns json (no .docx file written)", async () => {
  const dir = tmp();
  const inPath = await makeDocx(dir, "deal.docx", [
    [{ text: "Between " }, { text: "Acme Corp", highlight: "yellow" }, { text: " and Vendor." }],
  ]);
  const { code, out } = await runMain(main, [
    inPath, "--json",
    "--acme-corp", "Globex",
  ]);
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tier, "docx-highlight");
  // No .docx written; output_path is null and output text is in the payload.
  assert.equal(parsed.output_path, null);
  assert.match(parsed.output, /Between Globex and Vendor\./);
  assert.equal(existsSync(join(dir, "deal-filled.docx")), false);
});
