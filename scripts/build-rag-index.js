/**
 * RAG Index Builder
 *
 * This script:
 * 1. Reads all OpenAPI specs from specs/ directory
 * 2. For each API endpoint, uses OpenAI to generate natural language query variations
 * 3. Creates vector embeddings for all queries
 * 4. Saves the index to disk for fast loading
 *
 * Usage:
 *   node scripts/build-rag-index.js
 *
 * Requires:
 *   - OPENAI_API_KEY in .env
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const axios = require('axios');
require('dotenv').config();

const SPECS_DIR = path.join(__dirname, '../specs');
const INDEX_OUTPUT = path.join(__dirname, '../.rag-index.json');

/**
 * Get OpenAI API key
 */
function getOpenAIKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error('❌ OPENAI_API_KEY not found in .env');
    console.error('   This script requires OpenAI to generate query variations.');
    console.error('   Add your API key to .env: OPENAI_API_KEY=sk-...\n');
    process.exit(1);
  }
  return key;
}

/**
 * Load all specs from directory
 */
function loadSpecs() {
  const specs = {};
  const files = fs.readdirSync(SPECS_DIR);

  for (const file of files) {
    // Support both .yaml and .json files
    if (!file.endsWith('.yaml') && !file.endsWith('.yml') && !file.endsWith('.json')) {
      continue;
    }

    const filepath = path.join(SPECS_DIR, file);
    try {
      const content = fs.readFileSync(filepath, 'utf8');

      // Parse based on extension
      let spec;
      if (file.endsWith('.json')) {
        spec = JSON.parse(content);
      } else {
        spec = yaml.parse(content);
      }

      // Extract API name from filename (e.g., github-oas-plus.yaml -> github)
      const apiName = file.split('-')[0];
      specs[apiName] = spec;

      console.log(`✓ Loaded ${file}`);
    } catch (error) {
      console.error(`✗ Failed to load ${file}:`, error.message);
    }
  }

  return specs;
}

/**
 * Extract all operations from a spec
 */
function extractOperations(specs) {
  const operations = [];

  for (const [api, spec] of Object.entries(specs)) {
    if (!spec.paths) continue;

    for (const [pathStr, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          continue;
        }

        operations.push({
          api,
          path: pathStr,
          method: method.toUpperCase(),
          operationId: operation.operationId || `${method}_${pathStr}`,
          summary: operation.summary || '',
          description: operation.description || '',
          parameters: operation.parameters || [],
          tags: operation.tags || [],
        });
      }
    }
  }

  return operations;
}

/**
 * Generate natural language queries for an operation using OpenAI
 */
async function generateQueriesForOperation(operation, apiKey) {
  const prompt = `You are an API documentation expert. Generate natural language queries that a user would type to call this API endpoint.

API: ${operation.api}
Endpoint: ${operation.method} ${operation.path}
Summary: ${operation.summary}
Description: ${operation.description}

Parameters: ${JSON.stringify(operation.parameters.map(p => ({
  name: p.name,
  in: p.in,
  required: p.required,
  description: p.description
})), null, 2)}

Generate 8-10 diverse natural language queries that would match this endpoint. Include:
- Formal queries (e.g., "List all repositories")
- Casual queries (e.g., "show me my repos")
- Question format (e.g., "what repos do I have?")
- Action format (e.g., "get my repositories")
- Variations with different parameter values

If parameters are required, include them in the queries with placeholder values in {curly_braces}.
For example: "show issues in my {repo_name} repo"

Respond with a JSON array of strings only, no other text.`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.4',
        messages: [
          {
            role: 'system',
            content: 'You are an API query generation expert. Respond only with a valid JSON array of strings.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.8, // Higher temperature for diversity
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const result = JSON.parse(response.data.choices[0].message.content);

    // Extract array - OpenAI might wrap it in an object
    let queries = result.queries || result.variations || result;
    if (!Array.isArray(queries)) {
      queries = Object.values(result).find(v => Array.isArray(v)) || [];
    }

    return queries;

  } catch (error) {
    console.error(`   ✗ OpenAI error: ${error.message}`);

    // Fallback: generate basic queries from summary/description
    return generateBasicQueries(operation);
  }
}

/**
 * Generate basic queries as fallback (when OpenAI fails)
 */
function generateBasicQueries(operation) {
  const queries = [];
  const summary = operation.summary.toLowerCase();
  const operationId = operation.operationId;

  // Extract action verb and object
  const words = summary.split(' ');

  if (summary) {
    queries.push(summary);
    queries.push(summary.replace('get ', 'show '));
    queries.push(summary.replace('list ', 'get all '));
  }

  if (operationId) {
    // Convert camelCase to sentence
    const sentence = operationId
      .replace(/([A-Z])/g, ' $1')
      .toLowerCase()
      .trim();
    queries.push(sentence);
  }

  return queries.slice(0, 5); // Return at least a few
}

/**
 * Create embedding for text using OpenAI
 */
async function createEmbedding(text, apiKey) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/embeddings',
      {
        model: 'text-embedding-3-small',
        input: text,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data.data[0].embedding;
  } catch (error) {
    console.error(`   ✗ Embedding error: ${error.message}`);
    return null;
  }
}

/**
 * Build the complete RAG index
 */
async function buildIndex() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║              RAG Index Builder                             ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const apiKey = getOpenAIKey();

  // 1. Load specs
  console.log('[1/4] Loading OpenAPI specs...');
  const specs = loadSpecs();
  const apiCount = Object.keys(specs).length;
  console.log(`      ✓ Loaded ${apiCount} API spec(s)\n`);

  // 2. Extract operations
  console.log('[2/4] Extracting API operations...');
  const operations = extractOperations(specs);
  console.log(`      ✓ Found ${operations.length} operation(s)\n`);

  // 3. Generate queries for each operation
  console.log('[3/4] Generating natural language queries...');
  const index = [];
  let totalQueries = 0;

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    process.stdout.write(`      [${i + 1}/${operations.length}] ${op.api} / ${op.operationId}...`);

    const queries = await generateQueriesForOperation(op, apiKey);
    totalQueries += queries.length;

    // Create embeddings for each query
    for (const query of queries) {
      const embedding = await createEmbedding(query, apiKey);

      if (embedding) {
        index.push({
          query,
          embedding,
          api: op.api,
          operationId: op.operationId,
          path: op.path,
          method: op.method,
          summary: op.summary,
        });
      }

      // Rate limit: small delay between requests
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    process.stdout.write(` ${queries.length} queries\n`);
  }

  console.log(`      ✓ Generated ${totalQueries} total queries\n`);

  // 4. Save index to disk
  console.log('[4/4] Saving index to disk...');
  const indexData = {
    version: '1.0.0',
    created_at: new Date().toISOString(),
    total_operations: operations.length,
    total_queries: totalQueries,
    index,
  };

  fs.writeFileSync(INDEX_OUTPUT, JSON.stringify(indexData, null, 2), 'utf8');
  const sizeKB = (fs.statSync(INDEX_OUTPUT).size / 1024).toFixed(2);
  console.log(`      ✓ Index saved to ${path.basename(INDEX_OUTPUT)}`);
  console.log(`      Size: ${sizeKB} KB\n`);

  console.log('✅ RAG Index built successfully!\n');
  console.log('Usage:');
  console.log('  The agent will automatically load this index on startup.');
  console.log('  To rebuild the index, run this script again.\n');
}

// Run the builder
buildIndex().catch(error => {
  console.error('\n❌ Failed to build index:', error.message);
  if (process.env.DEBUG === 'true') {
    console.error(error.stack);
  }
  process.exit(1);
});
