/**
 * global-analyzer.js
 *
 * Pass 1: Sends a condensed spec summary to GPT-4o and asks it to:
 *   1. Identify auth discovery config
 *   2. Identify resolver operations (name → id lookups)
 *   3. Map grounding chains (which operations need which resolvers)
 *
 * Before the main analysis, a web search step fetches official documentation
 * for the API using the OpenAI Responses API with the web_search_preview tool.
 * The documentation summary is injected into the analysis prompt to improve
 * accuracy of auth, resolvers, and grounding chains.
 *
 * Returns a structured analysis object used by the writer and enricher.
 */

'use strict';

const axios = require('axios');

const MAX_SUMMARY_CHARS = 60000; // Stay well under GPT-4o context limits

/**
 * Format operation summaries into a condensed text block for the prompt.
 */
function formatSummariesForPrompt(summaries) {
  const lines = [];
  for (const op of summaries) {
    const params = op.params.map(p =>
      `${p.name}(${p.in},${p.required ? 'required' : 'optional'},${p.type})`
    ).join(', ');
    const respFields = op.responseFields.length > 0
      ? ` → {${op.responseFields.slice(0, 8).join(', ')}}`
      : '';
    lines.push(
      `[${op.method}] ${op.path} | ${op.operationId}: ${op.summary}${respFields}` +
      (params ? ` | params: ${params}` : '')
    );
  }
  const full = lines.join('\n');
  // Truncate if too long (large specs)
  return full.length > MAX_SUMMARY_CHARS ? full.slice(0, MAX_SUMMARY_CHARS) + '\n...(truncated)' : full;
}

/**
 * Format security schemes for the prompt.
 */
function formatSecuritySchemes(spec) {
  const schemes = spec.components?.securitySchemes || spec.securityDefinitions || {};
  if (Object.keys(schemes).length === 0) return 'None defined';
  return Object.entries(schemes).map(([name, s]) => {
    const parts = [name];
    if (s.type) parts.push(`type=${s.type}`);
    if (s.scheme) parts.push(`scheme=${s.scheme}`);
    if (s.in) parts.push(`in=${s.in}`);
    if (s.name) parts.push(`headerName=${s.name}`);
    if (s.flows) parts.push(`flows=${Object.keys(s.flows).join(',')}`);
    return parts.join(', ');
  }).join('\n');
}

/**
 * Search the web for official API documentation using the OpenAI Responses API
 * with the web_search_preview tool. Returns a plain-text summary, or null if
 * the search fails or finds nothing useful.
 */
async function searchWebForDocs(apiTitle, apiKey, verbose) {
  const searchInstruction = `Search for official documentation for the "${apiTitle}" REST API. Find and summarize:
1. Authentication methods (OAuth scopes, API key types, bearer token format, required env vars)
2. Key resource categories and their most important endpoints
3. Any resource IDs that require prior lookups (e.g. workspace ID needed before collection ID)
4. Pagination patterns (cursor, page/limit, etc.)
5. Official documentation or developer portal URL

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
 * Call GPT-4o to analyze the spec globally.
 */
async function analyzeSpec(spec, summaries, apiName, apiKey, verbose = false) {
  const operationList = formatSummariesForPrompt(summaries);
  const securityInfo = formatSecuritySchemes(spec);
  const serverUrl = spec.servers?.[0]?.url || 'https://api.example.com';
  const apiTitle = spec.info?.title || apiName;

  // Pre-analysis: search web for official documentation to improve analysis quality
  const docSummary = await searchWebForDocs(apiTitle, apiKey, verbose);

  const docContext = docSummary
    ? `\nWEB DOCUMENTATION SUMMARY (from official sources — use this to improve accuracy):\n${docSummary}\n`
    : '';

  const prompt = `You are an expert API architect. Analyze this OpenAPI 3.x spec for the "${apiTitle}" API and produce PostCall OAS++ extension metadata.
${docContext}
SERVER: ${serverUrl}
SECURITY SCHEMES:
${securityInfo}

ALL OPERATIONS (${summaries.length} total):
${operationList}

YOUR TASKS:

1. AUTH DISCOVERY: Determine the authentication type and generate x-postcall-auth-discovery.
   Auth types: "token" (bearer/basic), "oauth2", "api_key", or "none".
   For env_vars, use SCREAMING_SNAKE_CASE named after the API (e.g. POSTMAN_API_KEY, GITHUB_TOKEN).

2. RESOLVER OPERATIONS: Identify operations that act as "resolvers" — they take a human-readable
   search input (like a name or search query) and return a list of objects containing IDs.
   These are typically GET endpoints with a "name", "q", or "search" query param, returning arrays.
   For each resolver: what entity type does it resolve? What param does it take? What path extracts the ID?
   Example extract paths: "items[0].id", "data[0].uid", "collections[0].id", "results[0].user.accountId"

3. GROUNDING CHAINS: For operations that have required path or query parameters ending in "Id", "Uid",
   "id", or similar — identify which resolver operation should be called first to resolve the ID from
   a human-provided name. Only add grounding where a clear resolver exists.
   The "intentParam" is the semantic name for what the user would say (e.g. "collection_name", "workspace_name").
   The "groundingParam" is the exact parameter name in the target operation.

Respond ONLY with valid JSON in this exact structure:
{
  "authDiscovery": {
    "type": "token",
    "scheme": "bearer",
    "token_type": "api_key",
    "documentation_url": "https://...",
    "env_vars": { "token": "POSTMAN_API_KEY" }
  },
  "provisioningUrl": "https://...",
  "authNotes": "Optional notes about auth quirks, or null",
  "resolvers": [
    {
      "operationId": "getCollections",
      "entityType": "collection",
      "searchParam": "name",
      "extractPath": "collections[0].uid",
      "extractAs": "collectionUid",
      "description": "Resolves collection name to collection UID"
    }
  ],
  "groundingChains": {
    "getCollection": {
      "intentParam": "collection_name",
      "entityHint": "The name of the Postman collection",
      "resolverOperationId": "getCollections",
      "groundingParam": "collectionUid",
      "extractPath": "collections[0].uid",
      "errorMessage": "Could not find a collection named '{{intent.collection_name}}'.",
      "required": true
    }
  }
}`;

  if (verbose) {
    console.log(`      [Pass 1] Sending ${summaries.length} operations to GPT-4o for global analysis...`);
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
            content: 'You are an expert API architect generating PostCall OAS++ metadata. Respond ONLY with valid JSON, no markdown fences.',
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
      console.log(`      [Pass 1] ✓ Identified ${result.resolvers?.length || 0} resolvers`);
      console.log(`      [Pass 1] ✓ Mapped ${Object.keys(result.groundingChains || {}).length} grounding chains`);
    }

    return result;
  } catch (err) {
    console.error(`      [Pass 1] ✗ OpenAI error: ${err.message}`);
    // Return minimal fallback so the tool can still produce partial output
    return {
      authDiscovery: { type: 'token', scheme: 'bearer', env_vars: { token: `${apiName.toUpperCase()}_TOKEN` } },
      provisioningUrl: null,
      authNotes: null,
      resolvers: [],
      groundingChains: {},
    };
  }
}

module.exports = { analyzeSpec, formatSummariesForPrompt };
