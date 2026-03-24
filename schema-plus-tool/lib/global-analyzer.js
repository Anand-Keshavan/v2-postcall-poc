/**
 * global-analyzer.js  (schema-plus-tool)
 *
 * Pass 1: Sends a condensed GraphQL schema summary to GPT-4o and asks it to:
 *   1. Identify auth discovery config
 *   2. Identify resolver operations (name-search → id)
 *   3. Map grounding chains for operations that need IDs resolved
 *
 * Before the main analysis, a web search step fetches official documentation
 * for the GraphQL API using the OpenAI Responses API with web_search_preview.
 * The documentation summary is injected into the analysis prompt to improve
 * accuracy of auth, resolver detection, and grounding chains.
 *
 * Mirrors oas-plus-tool/lib/global-analyzer.js but adapted for GraphQL.
 */

'use strict';

const axios = require('axios');

/**
 * Format operation summaries into a concise text block for the OpenAI prompt.
 */
function formatSummariesForPrompt(summaries) {
  return summaries.map(op => {
    const args = op.args.map(a => {
      const detail = a.isInputObject ? `(input object with fields for filtering)` : '';
      return `${a.name}:${a.type}${detail}`;
    }).join(', ');
    const ret = op.isPaginated
      ? `{ info{count,pages}, results:[${op.itemFields.slice(0, 6).join(',')},...] }`
      : `{ ${(op.itemFields.length ? op.itemFields : op.responseFields).slice(0, 8).join(', ')} }`;
    return `  ${op.operationId}(${args}): ${op.returnTypeName}  → ${ret}  // ${op.description.slice(0, 100)}`;
  }).join('\n');
}

/**
 * Produce a compact type summary for context.
 */
function formatTypeMap(typeMap) {
  return Object.entries(typeMap)
    .filter(([, t]) => t.kind === 'input')
    .map(([name, t]) => `  input ${name} { ${t.fields.join(', ')} }`)
    .join('\n');
}

/**
 * Search the web for official GraphQL API documentation using the OpenAI
 * Responses API with the web_search_preview tool. Returns a plain-text summary,
 * or null if the search fails or finds nothing useful.
 */
async function searchWebForDocs(apiTitle, serverUrl, apiKey, verbose) {
  const searchInstruction = `Search for official documentation for the "${apiTitle}" GraphQL API (endpoint: ${serverUrl}). Find and summarize:
1. Authentication methods (API keys, OAuth, bearer tokens, required headers, scopes)
2. Key query types and their purpose (what entities are queryable, how filters work)
3. Any queries that require prior ID resolution (e.g. get character by ID requires searching by name first)
4. Pagination patterns (cursor-based, page/limit info objects)
5. Official documentation, schema explorer, or developer portal URL

Return a concise 300-500 word summary focused on auth setup and resolver/grounding opportunities.`;

  try {
    if (verbose) process.stdout.write('      [Pass 0] Searching web for API documentation... ');

    const response = await axios.post(
      'https://api.openai.com/v1/responses',
      {
        model: 'gpt-4o',
        tools: [{ type: 'web_search_preview' }],
        input: searchInstruction,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );

    // Responses API returns an output array of content blocks
    const output = response.data.output || [];
    const text = output
      .filter(item => item.type === 'message')
      .flatMap(item => item.content || [])
      .filter(c => c.type === 'output_text')
      .map(c => c.text)
      .join('\n')
      .trim();

    if (verbose) console.log(text ? '✓' : '(no results)');
    return text || null;
  } catch (err) {
    // Web search is best-effort — don't fail the whole analysis
    if (verbose) console.log(`(skipped: ${err.message})`);
    return null;
  }
}

/**
 * Call GPT-4o to analyze the schema globally.
 */
async function analyzeSchema(summaries, typeMap, apiName, apiTitle, serverUrl, apiKey, verbose = false) {
  const opList   = formatSummariesForPrompt(summaries);
  const inputTypes = formatTypeMap(typeMap);

  // Pre-analysis: search web for official documentation to improve analysis quality
  const docSummary = await searchWebForDocs(apiTitle, serverUrl, apiKey, verbose);

  const docContext = docSummary
    ? `\nWEB DOCUMENTATION SUMMARY (from official sources — use this to improve accuracy):\n${docSummary}\n`
    : '';

  const authLine = docSummary
    ? 'Determine authentication type based on the documentation summary above.'
    : `(no authentication — public GraphQL endpoint)`;

  const prompt = `You are an expert API architect. Analyze this GraphQL API schema for "${apiTitle}" and produce PostCall Schema++ extension metadata.
${docContext}
SERVER: ${serverUrl}
API: ${apiTitle} — ${authLine}

QUERY OPERATIONS (${summaries.length} total):
${opList}

INPUT TYPES (for filtering):
${inputTypes}

YOUR TASKS:

1. AUTH DISCOVERY: Determine authentication type. For public APIs with no auth, use type "none".
   For APIs requiring API keys, bearer tokens, etc., describe them appropriately.
   For env_vars, use SCREAMING_SNAKE_CASE: e.g. ${apiName.toUpperCase()}_API_KEY

2. RESOLVER OPERATIONS: Identify operations that act as "resolvers" — they accept a filter
   (like name) and return a list of objects containing IDs. These can ground other operations.
   For each resolver: what entity type? what filter field resolves names? what path extracts the ID?
   Extract paths for paginated results use format: "results[0].id"
   Extract paths for direct results use: "items[0].id" or just "[0].id" for arrays

3. GROUNDING CHAINS: For single-item lookup operations (e.g. character(id: ID!), location(id: ID!)),
   identify which list/search operation can resolve the name to an ID.
   The "intentParam" is what the user would say (e.g. "character_name", "location_name").
   The "groundingParam" is the exact argument name in the target operation (e.g. "id").
   The "searchVariables" describes how to call the resolver (e.g. filter.name = intent value).

Respond ONLY with valid JSON:
{
  "authDiscovery": {
    "type": "none"
  },
  "provisioningUrl": null,
  "authNotes": null,
  "resolvers": [
    {
      "operationId": "characters",
      "entityType": "character",
      "filterField": "filter.name",
      "extractPath": "results[0].id",
      "extractAs": "characterId",
      "description": "Resolves character name to ID via name filter"
    }
  ],
  "groundingChains": {
    "character": {
      "intentParam": "character_name",
      "entityHint": "The name of the Rick and Morty character",
      "resolverOperationId": "characters",
      "groundingParam": "id",
      "searchVariables": { "filter": { "name": "{{intent.character_name}}" } },
      "extractPath": "results[0].id",
      "errorMessage": "Could not find a character named '{{intent.character_name}}'.",
      "required": true
    }
  }
}`;

  if (verbose) {
    console.log(`      [Pass 1] Analyzing ${summaries.length} operations with GPT-4o...`);
    console.log(`      [Pass 1] Prompt size: ~${prompt.length} chars`);
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are an expert API architect generating PostCall Schema++ metadata for GraphQL APIs. Respond ONLY with valid JSON, no markdown fences.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 120000,
      }
    );

    const result = JSON.parse(response.data.choices[0].message.content);

    if (verbose) {
      console.log(`      [Pass 1] ✓ Auth: ${result.authDiscovery?.type || 'none'}`);
      console.log(`      [Pass 1] ✓ Resolvers: ${(result.resolvers || []).length}`);
      console.log(`      [Pass 1] ✓ Grounding chains: ${Object.keys(result.groundingChains || {}).length}`);
    }

    return result;
  } catch (err) {
    console.error(`      [Pass 1] ✗ OpenAI error: ${err.message}`);
    return {
      authDiscovery: { type: 'none' },
      provisioningUrl: null,
      authNotes: null,
      resolvers: [],
      groundingChains: {},
    };
  }
}

module.exports = { analyzeSchema };
