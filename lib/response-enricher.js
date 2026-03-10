/**
 * Response Enricher
 *
 * After an API call returns data containing opaque IDs (e.g. product_id, user_id),
 * this module:
 *
 *   Pass 1 — Detect:    Ask OpenAI which ID fields in the response can be resolved
 *                        to human-readable values using available spec operations.
 *
 *   Pass 2 — Resolve:   Execute the corresponding getById-style operations (in parallel)
 *                        for every unique ID value found.
 *
 *   Pass 3 — Summarize: Ask OpenAI to write a concise human-readable summary using
 *                        the resolved names in place of raw IDs.
 *
 * Generic: works for any API onboarded via OAS++ or Schema++.
 * No field names, operation IDs, or API names are hardcoded here.
 */

const axios = require('axios');

const MAX_LOOKUPS_PER_FIELD = 5; // cap per ID field to avoid excessive API calls

// ─── Pass 1: Detect ──────────────────────────────────────────────────────────

/**
 * Ask OpenAI which ID fields in the response can be resolved using available ops.
 *
 * @param {*}     data          - API response data (any shape)
 * @param {Array} allOperations - All available operations from loaded specs
 * @returns {Promise<Array>}    - Array of { fieldPath, uniqueValues, operationId, api, pathParam }
 */
async function detectResolvableIds(data, allOperations) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  // Only include operations that have at least one path parameter — these are the
  // lookup candidates (getById-style). Query/list ops are not useful for resolution.
  const opsContext = allOperations
    .map(op => {
      const pathParams = (op.operation?.parameters || [])
        .filter(p => p.in === 'path')
        .map(p => p.name);
      return {
        api: op.api,
        operationId: op.operationId,
        summary: op.summary || op.operation?.summary || '',
        pathParams,
      };
    })
    .filter(op => op.pathParams.length > 0);

  const prompt = `You are analyzing an API response to find ID fields that can be resolved to human-readable values.

RESPONSE DATA:
${JSON.stringify(data, null, 2)}

AVAILABLE LOOKUP OPERATIONS (only ops with path parameters):
${JSON.stringify(opsContext, null, 2)}

Find every field in the response that is an ID (e.g. user_id, product_id, order_id, repo_id, page_id) and can be looked up using one of the available operations.

For each resolvable ID field:
- Collect all unique values present in the response (including inside arrays)
- Match to the operation that resolves that entity by ID
- Identify the exact path parameter name for that operation

Respond with JSON:
{
  "resolvable": [
    {
      "fieldPath": "reviews[*].product_id",
      "uniqueValues": [101],
      "operationId": "getProductById",
      "api": "nile",
      "pathParam": "product_id"
    }
  ]
}

Return { "resolvable": [] } if no resolvable IDs are found.`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.4',
        messages: [
          {
            role: 'system',
            content: 'You are an API response analyzer. Respond only with valid JSON.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const result = JSON.parse(response.data.choices[0].message.content);
    return result.resolvable || [];
  } catch (err) {
    console.error('[Enricher] ID detection failed:', err.message);
    return [];
  }
}

// ─── Pass 2: Resolve ─────────────────────────────────────────────────────────

/**
 * Execute getById-style lookups for every unique ID value detected.
 * Runs all lookups in parallel.
 *
 * @returns {Object} resolved  - Map of "pathParam:value" → entity data
 *                               e.g. { "product_id:101": { id:101, name:"iPhone", ... } }
 */
async function executeLookups(mappings, clients, specs, schemaSpecs) {
  const { forSpec } = require('./protocols');
  const resolved = {};

  await Promise.all(
    mappings.map(async mapping => {
      const { operationId, api, pathParam, uniqueValues } = mapping;

      const client = clients[api];
      if (!client) {
        console.log(`      ⚠ [Enricher] No client for "${api}" — skipping ${operationId}`);
        return;
      }

      let protocol;
      try {
        protocol = forSpec(specs[api], schemaSpecs[api]);
      } catch {
        console.log(`      ⚠ [Enricher] No protocol for "${api}" — skipping ${operationId}`);
        return;
      }

      const values = uniqueValues.slice(0, MAX_LOOKUPS_PER_FIELD);

      await Promise.all(
        values.map(async id => {
          const key = `${pathParam}:${id}`;
          if (resolved[key]) return; // already resolved (shared across mappings)

          try {
            const step = {
              stepNumber: 0,
              api,
              operationId,
              purpose: `Resolve ${pathParam}=${id}`,
              parameters: {},
              pathParameters: { [pathParam]: String(id) },
              entityValues: {},
              needsGrounding: false,
            };

            const result = await protocol.executeStep({
              step,
              client,
              intent: {},
              userQuery: '',
              specs,
              schemaSpecs,
            });

            resolved[key] = result.data;
          } catch (err) {
            console.log(`      ⚠ [Enricher] Failed to resolve ${key}: ${err.message}`);
          }
        })
      );
    })
  );

  return resolved;
}

// ─── Pass 3: Summarize ───────────────────────────────────────────────────────

/**
 * Ask OpenAI to produce a concise human-readable summary of the response,
 * substituting resolved entity names for raw IDs.
 *
 * @returns {Promise<string|null>} summary text, or null on failure
 */
async function generateSummary(data, mappings, resolved, operationId, query) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const hasResolved = Object.keys(resolved).length > 0;

  // Build a readable entity reference only when we have resolved lookups
  const entitySection = hasResolved
    ? (() => {
        const entityRef = mappings.flatMap(m =>
          m.uniqueValues.map(id => {
            const key = `${m.pathParam}:${id}`;
            const entity = resolved[key];
            return entity ? { [key]: entity } : null;
          }).filter(Boolean)
        );
        return `\nRESOLVED ENTITIES (ID → details):\n${JSON.stringify(entityRef, null, 2)}\n`;
      })()
    : '';

  const prompt = `You are summarizing an API response for a user.

OPERATION: ${operationId}
USER'S ORIGINAL QUERY: "${query}"

RESPONSE DATA:
${JSON.stringify(data, null, 2)}
${entitySection}
Instructions:
- Directly answer what the user asked for.
- If the user asked for URLs or links: construct the full absolute URLs. Many APIs return a base URL (e.g. data._links.base or similar) plus relative paths (e.g. _links.webui). Combine them to produce absolute URLs. Use OpenAI's best judgement to identify the correct URL fields in the response.
- If there are multiple results, use this exact list format:
    Found the following for <topic from query>:
    1. <title or name> — <the specific value the user asked for, e.g. full URL>
    2. ...
- For a single result, use 1–2 plain sentences.
- If resolved entity names are available, use them instead of raw IDs.
- Do NOT include raw internal IDs, unexpanded paths, or fields the user did not ask for.

Respond with JSON: { "summary": "..." }`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.4',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful API response summarizer. Respond only with valid JSON.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const result = JSON.parse(response.data.choices[0].message.content);
    return result.summary || null;
  } catch (err) {
    console.error('[Enricher] Summary generation failed:', err.message);
    return null;
  }
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Enrich a response by resolving ID fields and printing a human-readable summary.
 * The raw JSON response is NOT modified — the summary is purely additive output.
 *
 * @param {*}     data          - The API response data to enrich
 * @param {string} operationId  - The operation that produced the data
 * @param {Array}  allOperations - All available operations from loaded specs
 * @param {Object} clients      - API clients keyed by api name
 * @param {Object} specs        - REST OAS++ specs
 * @param {Object} schemaSpecs  - GraphQL Schema++ specs
 */
async function enrichResponse(data, operationId, allOperations, clients, specs, schemaSpecs, query = '') {
  // Pass 1: detect resolvable ID fields
  const mappings = await detectResolvableIds(data, allOperations);
  let resolved = {};

  if (mappings.length > 0) {
    console.log(`\n[Enricher] Resolving ${mappings.length} ID field(s):`);
    mappings.forEach(m =>
      console.log(`   • ${m.fieldPath} (${m.uniqueValues.join(', ')}) → ${m.operationId}`)
    );
    // Pass 2: execute lookups in parallel
    resolved = await executeLookups(mappings, clients, specs, schemaSpecs);
  }

  // Pass 3: generate summary — always, even with no resolved IDs
  return generateSummary(data, mappings, resolved, operationId, query);
}

module.exports = { enrichResponse };
