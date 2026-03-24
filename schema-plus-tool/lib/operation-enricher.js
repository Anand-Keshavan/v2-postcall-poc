/**
 * operation-enricher.js  (schema-plus-tool)
 *
 * Pass 2: For each GraphQL Query field, generates:
 *   - summary / description
 *   - x-agent-guidance: 8-10 concrete natural language queries
 *   - x-postcall-entity-hints: entity input descriptions
 *   - graphqlQuery: the actual GraphQL query document string
 *   - variables: Schema++ variable definitions
 *   - responseDataPath: top-level field name in the GraphQL response
 *
 * Batches 3 operations per OpenAI call (smaller than OAS++ tool since
 * we need richer per-operation output including query documents).
 */

'use strict';

const axios = require('axios');

const BATCH_SIZE = 3;
const DELAY_MS   = 300;

const CONCRETE_EXAMPLES = `Use CONCRETE REALISTIC EXAMPLE NAMES — not placeholder syntax like {character_name}.
Examples to draw from:
  • Characters: "Rick Sanchez", "Morty Smith", "Beth Smith", "Summer Smith", "Jerry Smith"
  • Locations: "Earth", "Citadel of Ricks", "Anatomy Park", "Interdimensional Cable"
  • Episodes: "Pilot", "Ricklantis Mixup", "The Rickshank Rickdemption", "Close Rick-counters"
Vary the example names across queries.`;

/**
 * Build the enrichment prompt for a batch of operations.
 */
function buildBatchPrompt(batch, groundingChains, typeMap, apiTitle) {
  const typeContext = Object.entries(typeMap)
    .filter(([, t]) => t.kind === 'type')
    .map(([name, t]) => `  type ${name} { ${t.fields.join(', ')} }`)
    .join('\n');

  const ops = batch.map(op => {
    const args = op.args.map(a =>
      `  ${a.name}: ${a.type}${a.description ? ` # ${a.description.slice(0, 60)}` : ''}`
    ).join('\n') || '  (none)';

    const groundingInfo = groundingChains[op.operationId];
    const groundingNote = groundingInfo
      ? `\n  NOTE: This operation is grounded — user provides "${groundingInfo.intentParam}" by name, resolved to an ID.`
      : '';

    const returnNote = op.isPaginated
      ? `Returns paginated ${op.itemFields.slice(0, 5).join(', ')} ... (use results[0..N])`
      : `Returns: ${(op.itemFields.length ? op.itemFields : op.responseFields).slice(0, 8).join(', ')}`;

    return `OPERATION: ${op.operationId}
  Description: ${op.description || '(none)'}
  Arguments:
${args}
  ${returnNote}${groundingNote}`;
  }).join('\n\n---\n\n');

  return `You are generating Schema++ metadata for the "${apiTitle}" GraphQL API.

TYPES AVAILABLE:
${typeContext}

${CONCRETE_EXAMPLES}

For each operation below, generate ALL of the following:

1. "summary": 1-sentence plain-English summary (max 80 chars)
2. "description": 2-3 sentence description explaining when and why to use it
3. "agentGuidance": 8-10 diverse natural language queries a NON-TECHNICAL user would type.
   - Use CONCRETE EXAMPLE NAMES (see above) — no {placeholder} syntax
   - Cover different phrasings: casual, formal, question form, imperative
4. "entityHints": For entity parameters the user provides by name (if any).
   Keys are semantic intent names (e.g. "character_name"), not arg names (e.g. "id").
   Only include if the operation requires a user-provided entity name.
5. "graphqlQuery": The complete GraphQL query document string (with operation name in PascalCase).
   - Select all commonly useful fields (id, name, and key attributes)
   - For nested types (origin, location, episode), select id and name only
   - For paginated queries, wrap in the connection type but include info { count pages }
   - For grounded operations (need ID resolved), use the ID variable directly
6. "variables": Schema++ variable definitions map. For each variable:
   - type: GraphQL type string (e.g. "ID!", "Int", "FilterCharacter")
   - source: "intent" | "grounding" | "literal"
   - intentParam: (if source=intent) semantic param name from user
   - groundingParam: (if source=grounding) extracted param name from grounding chain
   - description: human-readable description of what this variable is
7. "responseDataPath": The top-level field name in the GraphQL response data (same as operationId)

${ops}

Respond with JSON:
{
  "operationId1": {
    "summary": "...",
    "description": "...",
    "agentGuidance": ["...", "..."],
    "entityHints": { "entity_name": "description" },
    "graphqlQuery": "query OperationName($var: Type) { ... }",
    "variables": {
      "varName": { "type": "Type!", "source": "grounding", "groundingParam": "id", "description": "..." }
    },
    "responseDataPath": "operationId"
  }
}`;
}

/**
 * Process one batch via OpenAI.
 */
async function processBatch(batch, groundingChains, typeMap, apiTitle, apiKey) {
  const prompt = buildBatchPrompt(batch, groundingChains, typeMap, apiTitle);

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You generate Schema++ metadata for GraphQL APIs. Respond only with valid JSON, no markdown fences.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 90000,
      }
    );

    return JSON.parse(response.data.choices[0].message.content);
  } catch (err) {
    console.error(`      [Pass 2] ✗ Batch error: ${err.message}`);
    return Object.fromEntries(
      batch.map(op => [op.operationId, {
        summary: op.description || op.operationId,
        description: op.description || '',
        agentGuidance: [`${op.operationId} in the ${apiTitle} API`],
        entityHints: {},
        graphqlQuery: `query ${op.operationId.charAt(0).toUpperCase() + op.operationId.slice(1)} {\n  ${op.operationId} {\n    id\n    name\n  }\n}`,
        variables: {},
        responseDataPath: op.operationId,
      }])
    );
  }
}

/**
 * Enrich all operations.
 *
 * @param {Array}  summaries       - From schema-loader
 * @param {Object} groundingChains - From global-analyzer
 * @param {Object} typeMap         - From schema-loader
 * @param {string} apiTitle        - Human-readable API name
 * @param {string} apiKey          - OpenAI API key
 * @param {boolean} verbose
 * @returns {Object} operationId → enrichment data
 */
async function enrichOperations(summaries, groundingChains, typeMap, apiTitle, apiKey, verbose = false) {
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
    process.stdout.write(`      [Pass 2] Batch ${i + 1}/${batches.length}: ${opIds}...`);

    const batchResults = await processBatch(batch, groundingChains, typeMap, apiTitle, apiKey);
    Object.assign(results, batchResults);

    const count = Object.values(batchResults).reduce((s, r) => s + (r.agentGuidance?.length || 0), 0);
    process.stdout.write(` ${count} queries\n`);

    if (i < batches.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  return results;
}

module.exports = { enrichOperations };
