#!/usr/bin/env node
/**
 * OAS → OAS++ Converter
 *
 * Converts a standard OpenAPI 3.x spec to a PostCall OAS++ spec by:
 *   1. Analyzing the full API with GPT-4o to discover auth, resolvers, and grounding chains
 *   2. Enriching each operation with natural language agent guidance and entity hints
 *   3. Writing the annotated OAS++ YAML to output-specs/
 *
 * Usage:
 *   node oas-plus-tool/convert.js                                  # all files in input-specs/
 *   node oas-plus-tool/convert.js path/to/spec.yaml                # specific file
 *   node oas-plus-tool/convert.js path/to/spec.yaml --verbose      # verbose logging
 *   node oas-plus-tool/convert.js --help
 */

'use strict';

const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { loadSpec }          = require('./lib/spec-loader');
const { analyzeSpec }       = require('./lib/global-analyzer');
const { enrichOperations }  = require('./lib/operation-enricher');
const { writeOasPlus }      = require('./lib/oas-writer');

const INPUT_DIR  = path.join(__dirname, 'input-specs');
const OUTPUT_DIR = path.join(__dirname, 'output-specs');

// ── Helpers ────────────────────────────────────────────────────────────────────

function getOpenAIKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error('\n❌ OPENAI_API_KEY not found in environment or .env file.');
    process.exit(1);
  }
  return key;
}

function banner() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║          OAS → OAS++ Converter (PostCall)                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  node oas-plus-tool/convert.js <filename> [--verbose]
  node oas-plus-tool/convert.js *           [--verbose]

Arguments:
  filename    Name of a YAML or JSON file inside oas-plus-tool/input-specs/
              (e.g. "Postman-API.yaml"). A full path also works.
  *           Convert all files in oas-plus-tool/input-specs/.
              If omitted, defaults to * (all files).

Options:
  --verbose   Print detailed progress including prompt sizes and match details.
  --help      Show this help message.

Output:
  Writes OAS++ YAML to oas-plus-tool/output-specs/<filename>-oas-plus.yaml
`);
    process.exit(0);
  }

  const verbose = args.includes('--verbose');
  const files = args.filter(a => !a.startsWith('--'));

  return { verbose, files };
}

function resolveInputFiles(files) {
  const allInInputDir = () => {
    if (!fs.existsSync(INPUT_DIR)) {
      console.error(`❌ input-specs directory not found: ${INPUT_DIR}`);
      process.exit(1);
    }
    return fs.readdirSync(INPUT_DIR)
      .filter(f => /\.(ya?ml|json)$/i.test(f))
      .map(f => path.join(INPUT_DIR, f));
  };

  // No args or explicit * → all files in input-specs/
  if (files.length === 0 || (files.length === 1 && files[0] === '*')) {
    return allInInputDir();
  }

  return files.map(f => {
    // Plain filename (no path separator) → resolve against INPUT_DIR
    if (!f.includes(path.sep) && !f.includes('/')) {
      const candidate = path.join(INPUT_DIR, f);
      if (!fs.existsSync(candidate)) {
        console.error(`❌ File not found in input-specs/: ${f}`);
        process.exit(1);
      }
      return candidate;
    }
    // Full or relative path
    return path.resolve(f);
  });
}

function outputPath(inputFile) {
  const base = path.basename(inputFile, path.extname(inputFile));
  return path.join(OUTPUT_DIR, `${base}-oas-plus.yaml`);
}

// ── Core conversion ────────────────────────────────────────────────────────────

async function convertFile(inputFile, apiKey, verbose) {
  const out = outputPath(inputFile);
  console.log(`\n▶  Input:  ${path.relative(process.cwd(), inputFile)}`);
  console.log(`   Output: ${path.relative(process.cwd(), out)}`);

  // ── Step 1: Load spec ──────────────────────────────────────────────────────
  console.log('\n[1/3] Loading spec...');
  const { spec, summaries, apiName } = loadSpec(inputFile);
  const apiTitle = spec.info?.title || apiName;
  console.log(`      ✓ ${apiTitle}`);
  console.log(`      ${summaries.length} operations found across ${Object.keys(spec.paths || {}).length} paths`);

  // ── Step 2: Global analysis ────────────────────────────────────────────────
  console.log('\n[2/3] Running global analysis (web doc search + grounding + auth)...');
  const analysis = await analyzeSpec(spec, summaries, apiName, apiKey, verbose);
  console.log(`      ✓ Auth type: ${analysis.authDiscovery?.type || 'unknown'}`);
  console.log(`      ✓ Resolvers: ${(analysis.resolvers || []).length}`);
  const chainCount = Object.keys(analysis.groundingChains || {}).length;
  console.log(`      ✓ Grounding chains: ${chainCount}`);

  if (verbose && chainCount > 0) {
    for (const [opId, chain] of Object.entries(analysis.groundingChains)) {
      console.log(`        → ${opId}: ${chain.intentParam} via ${chain.resolverOperationId}`);
    }
  }

  // ── Step 3: Per-operation enrichment ──────────────────────────────────────
  console.log('\n[3/3] Enriching operations (Pass 2 — agent guidance + entity hints)...');
  const enrichments = await enrichOperations(
    summaries,
    analysis.groundingChains || {},
    apiTitle,
    apiKey,
    verbose
  );
  const totalGuidance = Object.values(enrichments)
    .reduce((sum, e) => sum + (e.agentGuidance?.length || 0), 0);
  console.log(`      ✓ Generated ${totalGuidance} guidance queries across ${Object.keys(enrichments).length} operations`);

  // ── Step 4: Write output ───────────────────────────────────────────────────
  writeOasPlus(spec, analysis, enrichments, out);
  const sizekb = (fs.statSync(out).size / 1024).toFixed(1);
  console.log(`\n✅ Written: ${path.relative(process.cwd(), out)} (${sizekb} KB)`);

  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  banner();

  const { verbose, files } = parseArgs(process.argv);
  const inputFiles = resolveInputFiles(files);

  if (inputFiles.length === 0) {
    console.error('❌ No input files found.');
    process.exit(1);
  }

  const apiKey = getOpenAIKey();

  console.log(`Processing ${inputFiles.length} file(s)...\n`);

  const results = [];
  for (const f of inputFiles) {
    try {
      const out = await convertFile(f, apiKey, verbose);
      results.push({ file: f, output: out, ok: true });
    } catch (err) {
      console.error(`\n❌ Failed to convert ${path.basename(f)}: ${err.message}`);
      if (verbose) console.error(err.stack);
      results.push({ file: f, ok: false, error: err.message });
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Summary: ${results.filter(r => r.ok).length}/${results.length} converted successfully`);
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    const label = r.ok ? path.basename(r.output) : r.error;
    console.log(`  ${icon} ${path.basename(r.file)} → ${label}`);
  }
  console.log('══════════════════════════════════════════════════════════════\n');

  if (results.some(r => !r.ok)) process.exit(1);
}

main().catch(err => {
  console.error('\n❌ Unexpected error:', err.message);
  process.exit(1);
});
