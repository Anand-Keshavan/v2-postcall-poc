/**
 * Schema++ GraphQL Index Builder
 *
 * Reads a Schema++ YAML file (GraphQL variant), generates natural language
 * queries using OpenAI (same approach as build-doc-aware-index.js), embeds
 * them, and APPENDS the entries to the existing .rag-index-docs.json so the
 * agent's RAG matcher automatically covers GraphQL operations alongside REST.
 *
 * Usage:  node scripts/build-graphql-index.js [path-to-schema-plus.yaml]
 *
 * Default input:  specs/forge-schema-plus.yaml
 * Output merged into: .rag-index-docs.json
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('yaml');
const axios = require('axios');
require('dotenv').config();

const DEFAULT_SPEC  = path.join(__dirname, '../specs/forge-schema-plus.yaml');
const INDEX_OUTPUT  = path.join(__dirname, '../.rag-index-docs.json');

// ── OpenAI helpers ────────────────────────────────────────────────────────────

function getOpenAIKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) { console.error('❌ OPENAI_API_KEY not found'); process.exit(1); }
  return key;
}

async function createEmbedding(text, apiKey) {
  try {
    const r = await axios.post(
      'https://api.openai.com/v1/embeddings',
      { model: 'text-embedding-3-small', input: text },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );
    return r.data.data[0].embedding;
  } catch (e) {
    console.error(`   ✗ Embedding error: ${e.message}`);
    return null;
  }
}

// ── Documentation extraction from Schema++ ────────────────────────────────────

/**
 * Convert a Schema++ operation into a documentation object that mirrors
 * the structure produced by build-doc-aware-index.js for REST operations.
 * This lets the same RAG matcher and doc-aware planner handle both.
 */
function extractOperationDoc(apiName, operationId, opDef, schemaPlusInfo) {
  const hasGrounding = !!opDef['x-postcall-grounding']?.steps?.length;

  // Represent Schema++ variables as "parameters" in the standard doc format
  const parameters = Object.entries(opDef.variables || {}).map(([name, def]) => ({
    name,
    in: 'variable',
    required: typeof def === 'object' ? def.type?.endsWith('!') : false,
    description: typeof def === 'object' ? (def.description || '') : String(def),
    schema: { type: typeof def === 'object' ? (def.type || 'String').replace('!', '') : 'String' },
  }));

  return {
    api: apiName,
    path: schemaPlusInfo.server?.url || '/graphql',
    method: 'GRAPHQL',
    operationId,
    summary: opDef.summary || '',
    description: opDef.description || '',
    tags: [opDef.type || 'query'],
    parameters,
    requestBody: null,
    responses: {
      '200': {
        description: 'GraphQL response',
        content: { 'application/json': { schema: opDef.response?.schema || {} } },
      },
    },
    examples: (opDef['x-agent-guidance'] || []).map(g => ({ type: 'query', value: g })),
    extensions: {
      agentGuidance: opDef['x-agent-guidance'] || [],
      grounding: opDef['x-postcall-grounding'] || null,
      authDiscovery: schemaPlusInfo.info?.['x-postcall-auth-discovery'] || null,
      // GraphQL-specific
      graphql: opDef.graphql || '',
      variables: opDef.variables || {},
      protocol: 'graphql',
    },
    security: [{ apiKey: [] }],
  };
}

// ── Query generation (same formula as REST builder) ───────────────────────────

async function generateQueries(doc, apiKey) {
  const paramSummary = doc.parameters.map(p => {
    const parts = [`  • ${p.name} (${p.in}): ${p.description || p.name}`];
    return parts.join('\n');
  }).join('\n');

  const guidanceExamples = doc.extensions?.agentGuidance || [];
  const guidanceSection = guidanceExamples.length > 0
    ? `\nExample intents from spec author (use as inspiration, not verbatim):\n${guidanceExamples.map(g => `  - ${g}`).join('\n')}`
    : '';

  const prompt = `You are generating search queries for a vector similarity index that maps USER REQUESTS to API operations.

API: ${doc.api}
Operation: ${doc.operationId}
Protocol: GraphQL
Summary: ${doc.summary}
Description: ${doc.description}
${guidanceSection}

Variables/Parameters this operation accepts:
${paramSummary || '  (none)'}

YOUR TASK: Generate 10 diverse natural language queries that a NON-TECHNICAL user would type
to invoke this operation. Think about every different REASON someone might call this operation.

STRICT RULES:
1. Write from the USER's perspective ("show me…", "find all…", "what are…", "list…")
2. Use SEMANTIC placeholder names in {curly_braces} that describe the USER's concept:
     GOOD: {team_name}, {member_name}, {project_name}, {task_title}
     BAD:  {teamId}, {memberId}, {variables}   ← internal API names, never use
3. Cover ALL the different intents this operation can serve
4. Vary the phrasing: casual, formal, question form, imperative form
5. Do NOT repeat the same intent with slightly different words

Respond with JSON: { "queries": ["...", "...", ...] }`;

  try {
    const r = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.4',
        messages: [
          { role: 'system', content: 'You generate diverse user-intent search queries for API indexing. Respond only with valid JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.9,
        response_format: { type: 'json_object' },
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );
    const result = JSON.parse(r.data.choices[0].message.content);
    return result.queries || [];
  } catch (e) {
    console.error(`   ✗ OpenAI error: ${e.message}`);
    // Fallback: use the agent guidance seeds directly
    return guidanceExamples.slice(0, 5);
  }
}

// ── Load / save index ─────────────────────────────────────────────────────────

function loadExistingIndex() {
  if (!fs.existsSync(INDEX_OUTPUT)) {
    return { version: '2.0.0-docs', created_at: new Date().toISOString(), index: [], total_operations: 0, total_queries: 0 };
  }
  return JSON.parse(fs.readFileSync(INDEX_OUTPUT, 'utf8'));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function buildGraphQLIndex(specFile = DEFAULT_SPEC) {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║       Schema++ GraphQL Index Builder                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const apiKey = getOpenAIKey();

  // 1. Load Schema++
  console.log('[1/4] Loading Schema++ spec...');
  const raw = fs.readFileSync(specFile, 'utf8');
  const schemaPlus = yaml.parse(raw);
  const apiName = path.basename(specFile, '.yaml').split('-')[0]; // "forge"
  console.log(`      ✓ ${schemaPlus.info?.title}`);
  console.log(`      API: ${apiName}, Server: ${schemaPlus.server?.url}\n`);

  // 2. Extract operations
  console.log('[2/4] Extracting operations...');
  const operations = [];
  for (const [opId, opDef] of Object.entries(schemaPlus.operations || {})) {
    const doc = extractOperationDoc(apiName, opId, opDef, schemaPlus);
    operations.push(doc);
  }
  console.log(`      ✓ ${operations.length} operations extracted\n`);

  // 3. Generate queries + embeddings
  console.log('[3/4] Generating queries and embeddings...');
  const newEntries = [];
  let totalQueries = 0;

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    process.stdout.write(`      [${i + 1}/${operations.length}] ${op.operationId}...`);

    const queries = await generateQueries(op, apiKey);
    totalQueries += queries.length;

    for (const query of queries) {
      const embedding = await createEmbedding(query, apiKey);
      if (embedding) {
        newEntries.push({
          query,
          embedding,
          api: op.api,
          operationId: op.operationId,
          path: op.path,
          method: op.method,
          summary: op.summary,
          documentation: op,
        });
      }
      await new Promise(r => setTimeout(r, 80));
    }

    process.stdout.write(` ${queries.length} queries\n`);
  }

  console.log(`      ✓ Generated ${totalQueries} queries\n`);

  // 4. Merge into existing index
  console.log('[4/4] Merging into index...');
  const existingIndex = loadExistingIndex();

  // Remove any previous forge entries (allow re-running without duplicates)
  const cleaned = existingIndex.index.filter(e => e.api !== apiName);
  const merged = [...cleaned, ...newEntries];

  const output = {
    version: existingIndex.version || '2.0.0-docs',
    created_at: new Date().toISOString(),
    total_operations: [...new Set(merged.map(e => `${e.api}/${e.operationId}`))].length,
    total_queries: merged.length,
    has_full_documentation: true,
    index: merged,
  };

  fs.writeFileSync(INDEX_OUTPUT, JSON.stringify(output, null, 2), 'utf8');
  const sizeKB = (fs.statSync(INDEX_OUTPUT).size / 1024).toFixed(2);

  console.log(`      ✓ Index saved to ${path.basename(INDEX_OUTPUT)}`);
  console.log(`      Previous entries: ${existingIndex.index?.length || 0}`);
  console.log(`      New GraphQL entries: ${newEntries.length}`);
  console.log(`      Total entries: ${merged.length}`);
  console.log(`      File size: ${sizeKB} KB\n`);
  console.log('✅ GraphQL index built and merged successfully!\n');
}

buildGraphQLIndex(process.argv[2] || DEFAULT_SPEC).catch(err => {
  console.error('\n❌ Failed:', err.message);
  process.exit(1);
});
