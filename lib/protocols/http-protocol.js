/**
 * HTTP Protocol Plugin (REST / OAS++)
 *
 * Handles execution of REST API operations described in OAS++ specs.
 * Supports:
 *   - x-postcall-grounding chains for parameter resolution
 *   - Session context resolution (prior results)
 *   - Automatic error recovery via OpenAI
 *   - Path/query parameter injection
 *   - Field extraction from responses
 */

const { executeGroundingChain, findOperation } = require('../grounding-executor');
const { executeWithRecovery }                  = require('../error-recovery');
const { tryResolveFromContext }                = require('../context-resolver');

// ── Protocol identity ─────────────────────────────────────────────────────────

const name = 'http';

/**
 * This plugin handles specs that have a REST OAS++ definition (spec != null).
 */
function detect(spec, _schemaSpec) {
  return !!spec;
}

// ── Step execution ─────────────────────────────────────────────────────────────

/**
 * Execute one plan step via HTTP REST.
 *
 * @param {Object} opts.step        - Plan step (api, operationId, parameters, …)
 * @param {Object} opts.client      - Authenticated axios instance
 * @param {Object} opts.intent      - Parsed user intent (entity values from planner)
 * @param {string} opts.userQuery   - Original user query string
 * @param {Object} opts.specs       - All OAS++ specs keyed by api name
 * @returns {Promise<{ operationId: string, data: any }>}
 */
async function executeStep({ step, client, intent, userQuery, specs }) {
  const targetOp = findOperation(specs[step.api], step.operationId);
  if (!targetOp) {
    throw new Error(`Operation not found in OAS++ spec: ${step.operationId}`);
  }

  // Merge entityValues extracted by the doc-aware planner (e.g. user_name, product_name)
  const mergedIntent = { ...intent, ...(step.entityValues || {}) };

  // ── Parameter resolution ────────────────────────────────────────────────────
  let resolvedParams = {};
  const grounding = targetOp.operation['x-postcall-grounding'];

  if (grounding && step.needsGrounding !== false) {
    // Priority 1: session context (prior API results in this session)
    const contextResult = await tryResolveFromContext(grounding, userQuery, mergedIntent);

    if (contextResult) {
      resolvedParams = contextResult.params;
      console.log(`      ✓ Parameters found in session context (${contextResult.source})`);
      console.log(`      ✓ Resolved:`, resolvedParams);
    } else {
      // Priority 2: grounding chain (live look-up API calls)
      console.log(`      → Not found in context — executing grounding chain...`);
      resolvedParams = await executeGroundingChain(
        step.api,
        step.operationId,
        mergedIntent,
        specs[step.api],
        client
      );
      console.log(`      ✓ Grounding resolved:`, resolvedParams);
    }
  }

  // ── Build and execute request ──────────────────────────────────────────────
  const stepParams = {
    ...(step.parameters    || {}),
    ...(step.pathParameters || {}),
  };

  // Substitute {{paramName}} placeholders in planner-generated params with grounding-resolved values.
  // This lets specs instruct the planner to use templates like cql: "creator=\"{{accountId}}\" AND type=page"
  // which get filled after grounding resolves the accountId (or any other named value).
  for (const [key, val] of Object.entries(stepParams)) {
    if (typeof val === 'string' && val.includes('{{')) {
      stepParams[key] = val.replace(/\{\{(\w+)\}\}/g,
        (_, name) => resolvedParams[name] ?? mergedIntent[name] ?? `{{${name}}}`);
    }
  }

  const request = buildRequest(targetOp, mergedIntent, resolvedParams, stepParams);
  console.log(
    `      → ${request.method.toUpperCase()} ${request.url}` +
    (request.params && Object.keys(request.params).length
      ? '?' + new URLSearchParams(request.params).toString()
      : '')
  );

  const response = await executeWithRecovery(
    client,
    request,
    targetOp,
    { ...mergedIntent, ...resolvedParams }
  );

  // ── Data extraction ────────────────────────────────────────────────────────
  let data = response.data;
  if (step.extractData && Array.isArray(step.extractData)) {
    data = extractFields(data, step.extractData);
  }

  return { operationId: step.operationId, data };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build an axios-compatible request object from an OAS++ operation.
 * Priority: stepParams > resolvedParams > intent
 */
function buildRequest(operation, intent, resolvedParams, stepParams = {}) {
  const { path, method } = operation;

  // Resolve path parameters
  const url = path.replace(/\{([^}]+)\}/g, (_match, param) =>
    stepParams[param] || resolvedParams[param] || intent[param] || _match
  );

  // Collect query parameters
  const queryParams = { ...stepParams };

  if (operation.operation.parameters) {
    for (const param of operation.operation.parameters) {
      if (param.in === 'query' && queryParams[param.name] === undefined) {
        const value = resolvedParams[param.name] ?? intent[param.name];
        if (value !== undefined) queryParams[param.name] = value;
      }
    }
  }

  return {
    method: method.toLowerCase(),
    url,
    params: Object.keys(queryParams).length > 0 ? queryParams : undefined,
  };
}

/**
 * Extract specific fields from response data (supports arrays and objects).
 */
function extractFields(data, fields) {
  if (Array.isArray(data)) {
    return data.map(item => {
      const out = {};
      fields.forEach(f => {
        const v = getNestedValue(item, f);
        if (v !== undefined) out[f] = v;
      });
      return out;
    });
  }
  if (typeof data === 'object' && data !== null) {
    const out = {};
    fields.forEach(f => {
      const v = getNestedValue(data, f);
      if (v !== undefined) out[f] = v;
    });
    return out;
  }
  return data;
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((cur, key) => cur?.[key], obj);
}

module.exports = { name, detect, executeStep };
