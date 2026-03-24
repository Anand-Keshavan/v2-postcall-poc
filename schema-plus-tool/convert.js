#!/usr/bin/env node
/**
 * GraphQL Schema → Schema++ Converter
 *
 * Converts a GraphQL SDL file to a PostCall Schema++ YAML spec by:
 *   1. Parsing the SDL and extracting Query operations
 *   2. Analyzing with GPT-4o to discover resolvers, grounding chains, and auth
 *   3. Enriching each operation with guidance, query documents, and variable definitions
 *   4. Writing a Schema++ YAML to output-schemas/
 *
 * Usage:
 *   node schema-plus-tool/convert.js                             # all .graphql in input-schemas/
 *   node schema-plus-tool/convert.js path/to/schema.graphql      # specific file
 *   node schema-plus-tool/convert.js schema.graphql --server-url https://api.example.com/graphql
 *   node schema-plus-tool/convert.js --verbose
 *   node schema-plus-tool/convert.js --help
 */

'use strict';

const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { loadSchema }          = require('./lib/schema-loader');
const { analyzeSchema }       = require('./lib/global-analyzer');
const { enrichOperations }    = require('./lib/operation-enricher');
const { writeSchemaPlusYaml } = require('./lib/schema-plus-writer');

const INPUT_DIR  = path.join(__dirname, 'input-schemas');
const OUTPUT_DIR = path.join(__dirname, 'output-schemas');

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
  console.log('║      GraphQL Schema → Schema++ Converter (PostCall)       ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  node schema-plus-tool/convert.js <filename> [options]
  node schema-plus-tool/convert.js *           [options]

Arguments:
  filename               Name of a .graphql/.sdl file inside schema-plus-tool/input-schemas/
                         (e.g. "rick-and-morty.graphql"). A full path also works.
  *                      Convert all files in schema-plus-tool/input-schemas/.
                         If omitted, defaults to * (all files).

Options:
  --server-url <url>     GraphQL endpoint URL (default: http://localhost:4000/graphql)
  --api-title <name>     Override human-readable API name
  --verbose              Print detailed progress
  --help                 Show this help

Output:
  Writes Schema++ YAML to schema-plus-tool/output-schemas/<filename>-schema-plus.yaml
`);
    process.exit(0);
  }

  const verbose = args.includes('--verbose');
  const serverUrlIdx = args.indexOf('--server-url');
  const serverUrl = serverUrlIdx >= 0 ? args[serverUrlIdx + 1] : null;
  const apiTitleIdx = args.indexOf('--api-title');
  const apiTitle = apiTitleIdx >= 0 ? args[apiTitleIdx + 1] : null;

  // Strip flag names and their values, URLs, then collect remaining positional args
  const flagsWithValues = new Set();
  if (serverUrlIdx >= 0) flagsWithValues.add(args[serverUrlIdx + 1]);
  if (apiTitleIdx >= 0)  flagsWithValues.add(args[apiTitleIdx + 1]);
  const files = args.filter(a => !a.startsWith('--') && !flagsWithValues.has(a));

  return { verbose, files, serverUrl, apiTitle };
}

function resolveInputFiles(files) {
  const allInInputDir = () => {
    if (!fs.existsSync(INPUT_DIR)) {
      console.error(`❌ input-schemas directory not found: ${INPUT_DIR}`);
      process.exit(1);
    }
    return fs.readdirSync(INPUT_DIR)
      .filter(f => /\.(graphql|gql|sdl)$/i.test(f))
      .map(f => path.join(INPUT_DIR, f));
  };

  // No args or explicit * → all files in input-schemas/
  if (files.length === 0 || (files.length === 1 && files[0] === '*')) {
    return allInInputDir();
  }

  return files.map(f => {
    // Plain filename (no path separator) → resolve against INPUT_DIR
    if (!f.includes(path.sep) && !f.includes('/')) {
      const candidate = path.join(INPUT_DIR, f);
      if (!fs.existsSync(candidate)) {
        console.error(`❌ File not found in input-schemas/: ${f}`);
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
  return path.join(OUTPUT_DIR, `${base}-schema-plus.yaml`);
}

// ── Known server URLs for common APIs ─────────────────────────────────────────
const KNOWN_SERVERS = {
  'rick-and-morty':    'https://rickandmortyapi.com/graphql',
  'rick_and_morty':    'https://rickandmortyapi.com/graphql',
  'rickandmorty':      'https://rickandmortyapi.com/graphql',
  'github':            'https://api.github.com/graphql',
  'spacex':            'https://spacex-production.up.railway.app/',
  'countries':         'https://countries.trevorblades.com/graphql',
};

function inferServerUrl(apiName, cliServerUrl) {
  if (cliServerUrl) return cliServerUrl;
  return KNOWN_SERVERS[apiName] || `http://localhost:4000/graphql`;
}

function inferApiTitle(apiName, cliTitle) {
  if (cliTitle) return cliTitle;
  return apiName
    .split(/[_-]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Core conversion ────────────────────────────────────────────────────────────

async function convertFile(inputFile, apiKey, options) {
  const { verbose, serverUrl: cliServerUrl, apiTitle: cliTitle } = options;
  const out = outputPath(inputFile);

  console.log(`\n▶  Input:  ${path.relative(process.cwd(), inputFile)}`);
  console.log(`   Output: ${path.relative(process.cwd(), out)}`);

  // ── Step 1: Load schema ────────────────────────────────────────────────────
  console.log('\n[1/3] Loading GraphQL schema...');
  const { schema, sdl, summaries, typeMap, apiName } = loadSchema(inputFile);
  const serverUrl = inferServerUrl(apiName, cliServerUrl);
  const apiTitle  = inferApiTitle(apiName, cliTitle);

  console.log(`      ✓ ${apiTitle}`);
  console.log(`      ${summaries.length} query operations found`);
  console.log(`      ${Object.keys(typeMap).length} types/inputs/enums`);
  console.log(`      Server: ${serverUrl}`);

  // ── Step 2: Global analysis ────────────────────────────────────────────────
  console.log('\n[2/3] Running global analysis (web doc search + grounding + auth)...');
  const analysis = await analyzeSchema(summaries, typeMap, apiName, apiTitle, serverUrl, apiKey, verbose);
  console.log(`      ✓ Auth type: ${analysis.authDiscovery?.type || 'none'}`);
  console.log(`      ✓ Resolvers: ${(analysis.resolvers || []).length}`);
  const chainCount = Object.keys(analysis.groundingChains || {}).length;
  console.log(`      ✓ Grounding chains: ${chainCount}`);

  if (verbose && chainCount > 0) {
    for (const [opId, chain] of Object.entries(analysis.groundingChains)) {
      console.log(`        → ${opId}: ${chain.intentParam} via ${chain.resolverOperationId}`);
    }
  }

  // ── Step 3: Enrich operations ──────────────────────────────────────────────
  console.log('\n[3/3] Enriching operations (Pass 2 — guidance + query documents)...');
  const enrichments = await enrichOperations(
    summaries,
    analysis.groundingChains || {},
    typeMap,
    apiTitle,
    apiKey,
    verbose
  );
  const totalGuidance = Object.values(enrichments)
    .reduce((s, e) => s + (e.agentGuidance?.length || 0), 0);
  console.log(`      ✓ Generated ${totalGuidance} guidance queries across ${Object.keys(enrichments).length} operations`);

  // ── Step 4: Write Schema++ YAML ────────────────────────────────────────────
  writeSchemaPlusYaml(sdl, summaries, analysis, enrichments, apiTitle, serverUrl, apiName, out);
  const sizekb = (fs.statSync(out).size / 1024).toFixed(1);
  console.log(`\n✅ Written: ${path.relative(process.cwd(), out)} (${sizekb} KB)`);

  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  banner();

  const options = parseArgs(process.argv);
  const inputFiles = resolveInputFiles(options.files);

  if (inputFiles.length === 0) {
    console.error('❌ No .graphql files found in input-schemas/');
    process.exit(1);
  }

  const apiKey = getOpenAIKey();
  console.log(`Processing ${inputFiles.length} schema file(s)...\n`);

  const results = [];
  for (const f of inputFiles) {
    try {
      const out = await convertFile(f, apiKey, options);
      results.push({ file: f, output: out, ok: true });
    } catch (err) {
      console.error(`\n❌ Failed to convert ${path.basename(f)}: ${err.message}`);
      if (options.verbose) console.error(err.stack);
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
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
