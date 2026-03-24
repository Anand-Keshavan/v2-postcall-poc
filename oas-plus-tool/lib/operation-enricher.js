/**
 * operation-enricher.js
 *
 * Pass 2: For each operation in the spec, generates:
 *   - x-agent-guidance: 8-10 concrete natural language queries
 *   - x-postcall-entity-hints: description of user-provided entity inputs
 *
 * Operations are batched 5 at a time to reduce API calls.
 * Uses concrete example names (NOT {curly_brace} placeholders) so embeddings
 * are computed over realistic queries, improving RAG matching.
 */

'use strict';

const axios = require('axios');

const BATCH_SIZE = 5;
const DELAY_MS   = 300; // polite delay between batches

const CONCRETE_EXAMPLES = `When an operation works with named entities, use CONCRETE REALISTIC EXAMPLE NAMES in your queries — not placeholder syntax like {collection_name}.
Examples to draw from:
  • Collections: "My API Tests", "Petstore", "E-commerce API"
  • Workspaces: "Team Alpha", "Backend Squad", "My Workspace"
  • APIs: "Payment Gateway", "User Service", "Inventory API"
  • Environments: "Production", "Staging", "Development"
  • Users / people: "Alice", "Bob", "John Smith"
  • IDs: use realistic-looking UIDs like "abc123", "ws-456", "col-789"
Vary the example names across your queries — don't use the same name every time.`;

/**
 * Build prompt for a batch of operations.
 */
function buildBatchPrompt(batch, groundingChains, apiTitle) {
  const ops = batch.map(op => {
    const params = op.params.map(p =>
      `  - ${p.name} (${p.in}, ${p.required ? 'required' : 'optional'}): ${p.type}`
    ).join('\n') || '  (none)';

    const groundingInfo = groundingChains[op.operationId];
    const entityNote = groundingInfo
      ? `\n  Entity resolved via grounding: user provides "${groundingInfo.intentParam}" (${groundingInfo.entityHint || ''})`
      : '';

    return `OPERATION: ${op.operationId}
  Method: ${op.method} ${op.path}
  Summary: ${op.summary}
  Description: ${op.description || '(none)'}
  Parameters:
${params}${entityNote}`;
  }).join('\n\n---\n\n');

  return `You are generating natural language search queries for an AI agent index for the "${apiTitle}" API.

${CONCRETE_EXAMPLES}

For each operation below, generate:
1. "agentGuidance": 8-10 diverse natural language queries a NON-TECHNICAL user would type to invoke this operation.
   Rules:
   - Write from the USER's perspective: "show me...", "find all...", "list...", "get..."
   - Use CONCRETE EXAMPLE NAMES as described above — no {placeholder} syntax
   - Cover different phrasings: casual, formal, question form, imperative
   - Don't repeat the same intent with slightly different words
   - For GET-all/list operations (no entity param): focus on "list all X", "show every X", "what X are there"

2. "entityHints": For each entity the user must provide (if any), a brief description of what they'd say.
   Only include if the operation has entity parameters that the user identifies by name.
   Keys should be semantic intent names (e.g. "collection_name"), not API param names (e.g. "collectionUid").

${ops}

Respond with JSON:
{
  "operationId1": {
    "agentGuidance": ["query1", "query2", ...],
    "entityHints": { "entity_name": "description" }
  },
  "operationId2": { ... }
}`;
}

/**
 * Process one batch via OpenAI.
 */
async function processBatch(batch, groundingChains, apiTitle, apiKey) {
  const prompt = buildBatchPrompt(batch, groundingChains, apiTitle);

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You generate diverse user-intent search queries for API indexing. Respond only with valid JSON, no markdown fences.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.8,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );

    return JSON.parse(response.data.choices[0].message.content);
  } catch (err) {
    console.error(`      [Pass 2] ✗ Batch error: ${err.message}`);
    // Return minimal fallback for this batch
    return Object.fromEntries(
      batch.map(op => [op.operationId, {
        agentGuidance: [`${op.method.toLowerCase()} ${op.summary || op.operationId}`],
        entityHints: {},
      }])
    );
  }
}

/**
 * Enrich all operations with agent guidance and entity hints.
 *
 * @param {Array}  summaries      - From spec-loader.extractOperationSummaries()
 * @param {Object} groundingChains - From global-analyzer (operationId → chain)
 * @param {string} apiTitle       - Human-readable API name
 * @param {string} apiKey         - OpenAI API key
 * @param {boolean} verbose
 * @returns {Object} Map of operationId → { agentGuidance, entityHints }
 */
async function enrichOperations(summaries, groundingChains, apiTitle, apiKey, verbose = false) {
  const results = {};
  const batches = [];

  for (let i = 0; i < summaries.length; i += BATCH_SIZE) {
    batches.push(summaries.slice(i, i + BATCH_SIZE));
  }

  if (verbose) {
    console.log(`      [Pass 2] Enriching ${summaries.length} operations in ${batches.length} batches of ${BATCH_SIZE}...`);
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const opIds = batch.map(op => op.operationId).join(', ');
    process.stdout.write(`      [Pass 2] Batch ${i + 1}/${batches.length}: ${opIds.slice(0, 70)}...`);

    const batchResults = await processBatch(batch, groundingChains, apiTitle, apiKey);
    Object.assign(results, batchResults);

    const count = Object.values(batchResults).reduce((sum, r) => sum + (r.agentGuidance?.length || 0), 0);
    process.stdout.write(` ${count} queries\n`);

    if (i < batches.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  return results;
}

module.exports = { enrichOperations };
