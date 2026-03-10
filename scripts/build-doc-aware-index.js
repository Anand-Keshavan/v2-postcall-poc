/**
 * Documentation-Aware RAG Index Builder
 *
 * This enhanced version extracts COMPLETE API documentation:
 * - Full parameter descriptions with constraints
 * - Request/response examples from specs
 * - Response schemas
 * - Error documentation
 * - Related operations
 *
 * The planner uses this documentation to understand APIs before calling them.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const axios = require('axios');
require('dotenv').config();

const { detectAndInjectGrounding } = require('../lib/grounding-detector');

const SPECS_DIR = path.join(__dirname, '../specs');
const INDEX_OUTPUT = path.join(__dirname, '../.rag-index-docs.json');

/**
 * Get OpenAI API key
 */
function getOpenAIKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error('❌ OPENAI_API_KEY not found in .env');
    console.error('   This script requires OpenAI to generate query variations.');
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
    if (!file.endsWith('.yaml') && !file.endsWith('.yml') && !file.endsWith('.json')) {
      continue;
    }

    const filepath = path.join(SPECS_DIR, file);
    try {
      const content = fs.readFileSync(filepath, 'utf8');
      let spec;
      if (file.endsWith('.json')) {
        spec = JSON.parse(content);
      } else {
        spec = yaml.parse(content);
      }

      const apiName = file.split('-')[0];

      // Auto-detect and inject grounding chains for *_id parameters
      const groundingReport = detectAndInjectGrounding(spec);
      if (groundingReport.detected.length > 0) {
        console.log(`  ↳ Auto-grounding detected:`);
        groundingReport.detected.forEach(d => console.log(`      + ${d}`));
      }
      if (groundingReport.skipped.length > 0) {
        console.log(`  ↳ Manual grounding kept: ${groundingReport.skipped.join(', ')}`);
      }

      specs[apiName] = spec;
      console.log(`✓ Loaded ${file}`);
    } catch (error) {
      console.error(`✗ Failed to load ${file}:`, error.message);
    }
  }

  return specs;
}

/**
 * Extract comprehensive documentation for an operation
 */
function extractOperationDocumentation(api, pathStr, method, operation, spec) {
  const doc = {
    api,
    path: pathStr,
    method: method.toUpperCase(),
    operationId: operation.operationId || `${method}_${pathStr}`,

    // Basic info
    summary: operation.summary || '',
    description: operation.description || '',
    tags: operation.tags || [],

    // Parameters with full details
    parameters: extractParameters(operation.parameters || []),

    // Request body if applicable
    requestBody: extractRequestBody(operation.requestBody),

    // Response schemas
    responses: extractResponses(operation.responses || {}),

    // Examples from spec
    examples: extractExamples(operation),

    // Special extensions (OAS++)
    extensions: {
      agentGuidance: operation['x-agent-guidance'] || [],
      grounding: operation['x-postcall-grounding'] || null,
      authDiscovery: operation['x-postcall-auth-discovery'] || null,
    },

    // Security requirements
    security: operation.security || spec.security || [],
  };

  return doc;
}

/**
 * Extract detailed parameter information
 */
function extractParameters(parameters) {
  return parameters.map(param => {
    const paramDoc = {
      name: param.name,
      in: param.in,
      required: param.required || false,
      description: param.description || '',
      deprecated: param.deprecated || false,
    };

    // Schema information
    if (param.schema) {
      paramDoc.schema = {
        type: param.schema.type,
        format: param.schema.format,
        enum: param.schema.enum,
        pattern: param.schema.pattern,
        minimum: param.schema.minimum,
        maximum: param.schema.maximum,
        minLength: param.schema.minLength,
        maxLength: param.schema.maxLength,
        default: param.schema.default,
      };

      // Clean up undefined values
      Object.keys(paramDoc.schema).forEach(key => {
        if (paramDoc.schema[key] === undefined) {
          delete paramDoc.schema[key];
        }
      });
    }

    // Examples
    if (param.example) {
      paramDoc.example = param.example;
    }
    if (param.examples) {
      paramDoc.examples = param.examples;
    }

    return paramDoc;
  });
}

/**
 * Extract request body documentation
 */
function extractRequestBody(requestBody) {
  if (!requestBody) return null;

  const body = {
    required: requestBody.required || false,
    description: requestBody.description || '',
    content: {},
  };

  if (requestBody.content) {
    Object.entries(requestBody.content).forEach(([mediaType, mediaTypeObj]) => {
      body.content[mediaType] = {
        schema: simplifySchema(mediaTypeObj.schema),
        examples: mediaTypeObj.examples || {},
      };
    });
  }

  return body;
}

/**
 * Extract response documentation
 */
function extractResponses(responses) {
  const responseDocs = {};

  Object.entries(responses).forEach(([statusCode, responseObj]) => {
    responseDocs[statusCode] = {
      description: responseObj.description || '',
      content: {},
    };

    if (responseObj.content) {
      Object.entries(responseObj.content).forEach(([mediaType, mediaTypeObj]) => {
        responseDocs[statusCode].content[mediaType] = {
          schema: simplifySchema(mediaTypeObj.schema),
        };
      });
    }
  });

  return responseDocs;
}

/**
 * Simplify schema for documentation (avoid deep nesting)
 */
function simplifySchema(schema, depth = 0) {
  if (!schema || depth > 2) return null;

  const simplified = {
    type: schema.type,
    format: schema.format,
    description: schema.description,
  };

  if (schema.type === 'object' && schema.properties) {
    simplified.properties = {};
    Object.entries(schema.properties).forEach(([prop, propSchema]) => {
      simplified.properties[prop] = simplifySchema(propSchema, depth + 1);
    });
  }

  if (schema.type === 'array' && schema.items) {
    simplified.items = simplifySchema(schema.items, depth + 1);
  }

  if (schema.enum) {
    simplified.enum = schema.enum;
  }

  // Clean up undefined
  Object.keys(simplified).forEach(key => {
    if (simplified[key] === undefined) {
      delete simplified[key];
    }
  });

  return simplified;
}

/**
 * Extract examples from operation
 */
function extractExamples(operation) {
  const examples = [];

  // From x-agent-guidance
  if (operation['x-agent-guidance']) {
    operation['x-agent-guidance'].forEach(guidance => {
      examples.push({
        type: 'query',
        value: guidance,
      });
    });
  }

  // From parameters
  if (operation.parameters) {
    operation.parameters.forEach(param => {
      if (param.example) {
        examples.push({
          type: 'parameter',
          name: param.name,
          value: param.example,
        });
      }
    });
  }

  return examples;
}

/**
 * Generate natural language queries with context about parameters.
 *
 * KEY DESIGN RULE:
 * Queries must be written from the USER's point of view, using everyday language
 * and semantic placeholder names (e.g. {creator_name}, {space_name}, {repo_name})
 * — never the raw API parameter names (e.g. {cql}, {q}, {space_key}).
 * This ensures semantic embedding similarity with real user queries.
 */
async function generateQueriesWithDocs(operation, documentation, apiKey) {
  // Build a compact but informative description of what the endpoint does
  const paramSummary = documentation.parameters.map(p => {
    const parts = [`  • ${p.name} (${p.in}): ${p.description || p.name}`];
    if (p.schema?.enum) parts.push(`    values: ${p.schema.enum.join(' | ')}`);
    if (p.example) parts.push(`    example: ${p.example}`);
    return parts.join('\n');
  }).join('\n');

  const guidanceExamples = (documentation.extensions?.agentGuidance || []);
  const guidanceSection = guidanceExamples.length > 0
    ? `\nExample intents from spec author (use as inspiration, not verbatim):\n${guidanceExamples.map(g => `  - ${g}`).join('\n')}`
    : '';

  const prompt = `You are generating search queries for a vector similarity index that maps USER REQUESTS to API operations.

API: ${documentation.api}
Operation: ${documentation.operationId}
HTTP: ${documentation.method} ${documentation.path}
Summary: ${documentation.summary}
Description: ${documentation.description}
${guidanceSection}

Parameters this operation accepts:
${paramSummary || '  (none)'}

YOUR TASK: Generate 10 diverse natural language queries that a NON-TECHNICAL user would type
to invoke this operation. Think about every different REASON someone might call this endpoint.

STRICT RULES — violations will break the system:
1. Write from the USER's perspective ("show me…", "find all…", "what are…", "list…")
2. Use SEMANTIC placeholder names in {curly_braces} that describe the USER's concept:
     GOOD: {creator_name}, {space_name}, {repo_name}, {product_name}, {search_term}
     BAD:  {cql}, {q}, {space_key}, {user_id}   ← these are internal API param names, never use them
3. Cover ALL the different intents this operation can serve — not just one
   Example: a search endpoint could be used to find by author, by date, by title, by space, etc.
   Generate queries for EACH distinct use case.
4. Vary the phrasing: casual, formal, question form, imperative form
5. Do NOT repeat the same intent with slightly different words — each query must cover a new use case

Respond with JSON: { "queries": ["...", "...", ...] }`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.4',
        messages: [
          {
            role: 'system',
            content: 'You generate diverse user-intent search queries for API operation indexing. Respond only with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.9,
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
    return result.queries || [];

  } catch (error) {
    console.error(`   ✗ OpenAI error: ${error.message}`);
    return generateBasicQueries(operation);
  }
}

/**
 * Fallback query generation
 */
function generateBasicQueries(operation) {
  const queries = [];
  const summary = operation.summary?.toLowerCase() || '';

  if (summary) {
    queries.push(summary);
    queries.push(summary.replace('get ', 'show '));
    queries.push(summary.replace('list ', 'get all '));
  }

  if (operation.operationId) {
    const sentence = operation.operationId
      .replace(/([A-Z])/g, ' $1')
      .toLowerCase()
      .trim();
    queries.push(sentence);
  }

  return queries.slice(0, 5);
}

/**
 * Create embedding
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
 * Build the documentation-aware index
 */
async function buildIndex() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║       Documentation-Aware RAG Index Builder               ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const apiKey = getOpenAIKey();

  // 1. Load specs
  console.log('[1/4] Loading OpenAPI specs...');
  const specs = loadSpecs();
  console.log(`      ✓ Loaded ${Object.keys(specs).length} API spec(s)\n`);

  // 2. Extract operations with full documentation
  console.log('[2/4] Extracting operations and documentation...');
  const operations = [];

  for (const [api, spec] of Object.entries(specs)) {
    if (!spec.paths) continue;

    for (const [pathStr, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;

        const doc = extractOperationDocumentation(api, pathStr, method, operation, spec);
        operations.push(doc);
      }
    }
  }

  console.log(`      ✓ Extracted ${operations.length} operation(s) with documentation\n`);

  // 3. Generate queries and embeddings
  console.log('[3/4] Generating queries and embeddings...');
  const index = [];
  let totalQueries = 0;

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    process.stdout.write(`      [${i + 1}/${operations.length}] ${op.api} / ${op.operationId}...`);

    const queries = await generateQueriesWithDocs(op, op, apiKey);
    totalQueries += queries.length;

    // Create embeddings for each query
    for (const query of queries) {
      const embedding = await createEmbedding(query, apiKey);

      if (embedding) {
        index.push({
          query,
          embedding,

          // Basic operation info
          api: op.api,
          operationId: op.operationId,
          path: op.path,
          method: op.method,
          summary: op.summary,

          // FULL DOCUMENTATION stored in index
          documentation: op,
        });
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    process.stdout.write(` ${queries.length} queries\n`);
  }

  console.log(`      ✓ Generated ${totalQueries} total queries\n`);

  // 4. Save index
  console.log('[4/4] Saving documentation-aware index...');
  const indexData = {
    version: '2.0.0-docs',
    created_at: new Date().toISOString(),
    total_operations: operations.length,
    total_queries: totalQueries,
    has_full_documentation: true,
    index,
  };

  fs.writeFileSync(INDEX_OUTPUT, JSON.stringify(indexData, null, 2), 'utf8');
  const sizeKB = (fs.statSync(INDEX_OUTPUT).size / 1024).toFixed(2);
  console.log(`      ✓ Index saved to ${path.basename(INDEX_OUTPUT)}`);
  console.log(`      Size: ${sizeKB} KB\n`);

  console.log('✅ Documentation-aware index built successfully!\n');
  console.log('Key Features:');
  console.log('  ✓ Full parameter documentation with constraints');
  console.log('  ✓ Request/response schemas');
  console.log('  ✓ Examples and usage patterns');
  console.log('  ✓ Security requirements');
  console.log('  ✓ OAS++ extensions\n');
  console.log('The agent will now understand APIs before calling them!\n');
}

buildIndex().catch(error => {
  console.error('\n❌ Failed to build index:', error.message);
  if (process.env.DEBUG === 'true') {
    console.error(error.stack);
  }
  process.exit(1);
});
