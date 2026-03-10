/**
 * GraphQL Protocol Plugin (Schema++)
 *
 * Handles execution of GraphQL operations described in Schema++ specs.
 * Supports:
 *   - x-postcall-grounding chains for parameter resolution
 *   - Session context resolution (prior results)
 *   - Variable injection from intent / grounding results
 *   - dataPath extraction from GraphQL responses
 */

const {
  executeGroundingChain: execGQLGrounding,
  buildGraphQLRequest,
  executeGraphQL,
} = require('../graphql-executor');
const { tryResolveFromContext } = require('../context-resolver');

// ── Protocol identity ─────────────────────────────────────────────────────────

const name = 'graphql';

/**
 * This plugin handles specs that have a Schema++ (GraphQL) definition.
 * Note: graphql-protocol is registered first in index.js so it takes
 * precedence when both spec and schemaSpec are present (future-proof).
 */
function detect(_spec, schemaSpec) {
  return !!schemaSpec;
}

// ── Step execution ─────────────────────────────────────────────────────────────

/**
 * Execute one plan step via GraphQL.
 *
 * @param {Object} opts.step        - Plan step (api, operationId, parameters, …)
 * @param {Object} opts.client      - Authenticated axios instance pointing to /graphql
 * @param {Object} opts.intent      - Parsed user intent
 * @param {string} opts.userQuery   - Original user query string
 * @param {Object} opts.schemaSpecs - All Schema++ specs keyed by api name
 * @returns {Promise<{ operationId: string, data: any }>}
 */
async function executeStep({ step, client, intent, userQuery, schemaSpecs }) {
  const schemaPlusSpec = schemaSpecs[step.api];
  const opDef = schemaPlusSpec.operations?.[step.operationId];
  if (!opDef) {
    throw new Error(`GraphQL operation not found in Schema++: ${step.operationId}`);
  }

  // Merge entityValues extracted by the doc-aware planner
  const mergedIntent = { ...intent, ...(step.entityValues || {}) };

  // ── Parameter resolution ────────────────────────────────────────────────────
  let resolvedParams = {};
  const grounding = opDef['x-postcall-grounding'];

  // Safety net: if the grounding chain needs {{intent.xxx}} vars that are still
  // missing from mergedIntent, try to extract them from the raw user query.
  // This covers cases where the doc-aware planner failed to populate entityValues.
  if (grounding && userQuery) {
    const tplRe = /\{\{intent\.(\w+)\}\}/g;
    const neededVars = new Set();
    for (const gStep of grounding.steps || []) {
      for (const tpl of Object.values(gStep.variables || {})) {
        let m;
        while ((m = tplRe.exec(String(tpl))) !== null) neededVars.add(m[1]);
      }
    }
    const missingVars = [...neededVars].filter(v => mergedIntent[v] === undefined);
    if (missingVars.length > 0) {
      // 1. Prefer quoted strings: 'Foo Bar' or "Foo Bar"
      const quoted = [...userQuery.matchAll(/['"]([^'"]{2,})['"]/g)].map(m => m[1]);
      // 2. Fallback: runs of consecutive title-cased words (proper nouns)
      if (quoted.length === 0) {
        const properNouns = userQuery.match(/(?:[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)+)/g) || [];
        quoted.push(...properNouns);
      }
      missingVars.forEach((varName, idx) => {
        if (quoted[idx] !== undefined) {
          mergedIntent[varName] = quoted[idx];
          console.log(`      → Fallback extraction: ${varName} = "${quoted[idx]}"`);
        }
      });
    }
  }

  if (grounding) {
    // Priority 1: session context
    const contextResult = await tryResolveFromContext(grounding, userQuery, mergedIntent);

    if (contextResult) {
      resolvedParams = contextResult.params;
      console.log(`      ✓ Parameters found in session context (${contextResult.source})`);
      console.log(`      ✓ Resolved:`, resolvedParams);
    } else {
      // Priority 2: GraphQL grounding chain
      console.log(`      → Not found in context — executing GraphQL grounding chain...`);
      resolvedParams = await execGQLGrounding(grounding, mergedIntent, schemaPlusSpec, client);
      console.log(`      ✓ Grounding resolved:`, resolvedParams);
    }
  }

  // ── Build and execute request ──────────────────────────────────────────────
  const stepParams = { ...(step.parameters || {}) };
  const request = buildGraphQLRequest(opDef, mergedIntent, resolvedParams, stepParams);
  console.log(`      → GRAPHQL ${step.operationId}`);

  const gqlData = await executeGraphQL(client, request.data.query, request.data.variables);

  // ── Data extraction via dataPath ───────────────────────────────────────────
  const dataPath = opDef.response?.dataPath;
  const data = dataPath ? (gqlData[dataPath] ?? gqlData) : gqlData;

  return { operationId: step.operationId, data };
}

module.exports = { name, detect, executeStep };
