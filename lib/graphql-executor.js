/**
 * GraphQL Operation Executor
 *
 * Handles execution of Schema++ GraphQL operations including:
 * - Grounding chain resolution (teamName → teamId, etc.)
 * - Variable injection from intent / grounding results
 * - Template resolution ({{intent.x}}, {{grounding.y}})
 *
 * Used by reasoning-planner.js when the matched operation has
 * documentation.extensions.protocol === 'graphql'
 */

const axios = require('axios');

// ── Template resolution ───────────────────────────────────────────────────────

function resolveTemplate(template, context) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const keys = path.trim().split('.');
    let val = context;
    for (const k of keys) {
      val = val?.[k];
      if (val === undefined) return match;
    }
    return val;
  });
}

// ── Response value extractor (dot-path into GraphQL data) ────────────────────

function extractFromData(data, path) {
  return path.split('.').reduce((cur, key) => cur?.[key], data);
}

// ── Execute a single GraphQL operation ───────────────────────────────────────

async function executeGraphQL(client, graphqlQuery, variables) {
  const response = await client.request({
    method: 'post',
    url: '',      // client baseURL points to the /graphql endpoint
    data: { query: graphqlQuery, variables },
  });

  const body = response.data;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`GraphQL error: ${body.errors.map(e => e.message).join('; ')}`);
  }
  return body.data;
}

// ── Grounding chain executor for GraphQL ─────────────────────────────────────

/**
 * Execute a Schema++ grounding chain.
 *
 * Each step calls another named Schema++ operation (resolver), resolves
 * variables from intent or prior steps, and extracts the target parameters.
 *
 * @param {Object} grounding      – x-postcall-grounding block with .steps
 * @param {Object} intent         – intent from RAG (e.g. { team_name: "Engineering" })
 * @param {Object} schemaPlus     – full Schema++ spec (to look up resolver graphql queries)
 * @param {Object} client         – axios client for the GraphQL endpoint
 * @returns {Promise<Object>}     resolved parameters (e.g. { teamId: "1" })
 */
async function executeGroundingChain(grounding, intent, schemaPlus, client) {
  console.log('\n[GraphQL Grounding] Starting grounding chain');
  console.log('[GraphQL Grounding] Intent:', intent);

  const context = { intent, steps: [] };
  const resolved = {};

  for (let i = 0; i < grounding.steps.length; i++) {
    const step = grounding.steps[i];
    console.log(`[GraphQL Grounding] Step ${i + 1}: ${step.operationId}`);

    // Look up the resolver operation in Schema++
    const resolverOp = schemaPlus.operations?.[step.operationId];
    if (!resolverOp) {
      throw new Error(`Grounding resolver operation not found: ${step.operationId}`);
    }

    // Resolve variables for the resolver call
    const variables = {};
    for (const [varName, template] of Object.entries(step.variables || {})) {
      const resolved = resolveTemplate(template, context);
      if (typeof resolved === 'string' && /\{\{[^}]+\}\}/.test(resolved)) {
        throw new Error(
          `Unresolved template in grounding variable "${varName}": ${resolved}. ` +
          `Check that the required intent value is being extracted from the user query.`
        );
      }
      variables[varName] = resolved;
    }

    console.log(`[GraphQL Grounding]   Variables:`, variables);

    // Execute the resolver query
    const data = await executeGraphQL(client, resolverOp.graphql, variables);
    console.log(`[GraphQL Grounding]   Response:`, JSON.stringify(data).slice(0, 200));

    // Extract values from the response
    const stepResult = {};
    for (const [paramName, extractPath] of Object.entries(step.extract || {})) {
      const value = extractFromData(data, extractPath);
      if (value === undefined || value === null) {
        throw new Error(
          `Grounding extraction failed: '${extractPath}' not found in response for step ${step.operationId}`
        );
      }
      stepResult[paramName] = value;
      resolved[paramName] = value;
      console.log(`[GraphQL Grounding]   Extracted ${paramName}=${value}`);
    }

    context.steps.push(stepResult);
  }

  console.log('[GraphQL Grounding] Resolved:', resolved);
  return resolved;
}

// ── Build a GraphQL request from a Schema++ operation ────────────────────────

/**
 * Construct the request body for executing a Schema++ GraphQL operation.
 * Variable values are taken from:
 *   1. grounding results (source: grounding)
 *   2. intent values     (source: intent)
 *   3. explicit step parameters
 *
 * @param {Object} operation     – Schema++ operation definition
 * @param {Object} intent        – intent from RAG
 * @param {Object} resolvedParams – parameters resolved by grounding chain
 * @param {Object} stepParams    – parameters from the plan step
 */
function buildGraphQLRequest(operation, intent, resolvedParams, stepParams) {
  const variables = {};

  for (const [varName, varDef] of Object.entries(operation.variables || {})) {
    if (typeof varDef === 'object') {
      if (varDef.source === 'grounding' && resolvedParams[varDef.groundingParam] !== undefined) {
        variables[varName] = resolvedParams[varDef.groundingParam];
      } else if (varDef.source === 'intent' && intent[varDef.intentParam] !== undefined) {
        variables[varName] = intent[varDef.intentParam];
      } else if (stepParams[varName] !== undefined) {
        variables[varName] = stepParams[varName];
      } else if (resolvedParams[varName] !== undefined) {
        variables[varName] = resolvedParams[varName];
      } else if (intent[varName] !== undefined) {
        variables[varName] = intent[varName];
      }
    } else if (typeof varDef === 'string') {
      variables[varName] = resolveTemplate(varDef, { intent, grounding: resolvedParams });
    }
  }

  return {
    method: 'post',
    url: '',
    data: {
      query: operation.graphql,
      variables,
    },
  };
}

module.exports = {
  executeGroundingChain,
  buildGraphQLRequest,
  executeGraphQL,
};
