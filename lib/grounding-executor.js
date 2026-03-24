/**
 * Grounding Chain Executor
 * Executes resolver chains to map natural language to technical IDs
 *
 * This is the core of PostCall's grounding feature:
 * - Reads x-postcall-grounding from OAS++ spec
 * - Executes each resolver operation in sequence
 * - Extracts values and passes to next step
 * - Returns resolved parameters for the primary operation
 */

const axios = require('axios');

/**
 * Normalize errors so message is always a meaningful string.
 * Axios ECONNREFUSED errors on some Node versions have empty .message.
 */
function normalizeError(error) {
  if (error.message) return error;
  if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
    error.message = `Cannot connect to API server (${error.code}). Is the mock server running?`;
  } else if (error.code) {
    error.message = `Network error: ${error.code}`;
  } else {
    error.message = 'Unknown grounding error';
  }
  return error;
}

/**
 * Ask OpenAI to suggest alternative search terms when a grounding step
 * returns no results or fails to extract the required value.
 *
 * @param {string} stepOperationId - e.g. "searchProducts"
 * @param {Object} failedParams    - params that were tried, e.g. { name: "iPhone" }
 * @param {Object} intent          - full user intent object
 * @param {string} errorDetail     - description of what failed
 * @returns {Promise<string[]>}    array of alternative search terms to try
 */
async function reformulateGroundingQuery(stepOperationId, failedParams, intent, errorDetail) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  const prompt = `A grounding step failed to find a result.

Operation: ${stepOperationId}
Parameters tried: ${JSON.stringify(failedParams)}
User intent: ${JSON.stringify(intent)}
Failure: ${errorDetail}

The search returned no matching records. Suggest up to 3 alternative values for the "name"
search parameter that might find what the user is looking for.
Consider: partial names, common short forms, alternative spellings, adding/removing model numbers.

Respond with JSON: { "alternatives": ["term1", "term2", "term3"], "reasoning": "..." }`;

  try {
    const r = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.4',
        messages: [
          { role: 'system', content: 'You suggest alternative search terms for a failed lookup. Respond only with JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );
    const result = JSON.parse(r.data.choices[0].message.content);
    return result.alternatives || [];
  } catch (e) {
    return [];
  }
}

/**
 * Replace template variables in a string
 * @param {string} template - Template string with {{variable}} syntax
 * @param {Object} context - Context object with variables
 * @returns {string} resolved string
 */
function resolveTemplate(template, context) {
  if (typeof template !== 'string') return template;

  return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const keys = path.trim().split('.');
    let value = context;

    for (const key of keys) {
      // Handle array indexing like steps[0]
      const arrayMatch = key.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        value = value?.[arrayMatch[1]]?.[parseInt(arrayMatch[2])];
      } else {
        value = value?.[key];
      }

      if (value === undefined) {
        console.warn(`[Grounding] Template variable not found: ${path}`);
        return match; // Return original if not found
      }
    }

    return value;
  });
}

/**
 * Extract value from response using path notation
 * @param {Object} response - API response data
 * @param {string} path - Path like "items[0].owner.login"
 * @returns {any} extracted value
 */
function extractValue(response, path) {
  const keys = path.split('.');
  let value = response;

  for (const key of keys) {
    // Handle array indexing
    const arrayMatch = key.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      value = value?.[arrayMatch[1]]?.[parseInt(arrayMatch[2])];
    } else {
      value = value?.[key];
    }

    if (value === undefined) {
      throw new Error(`Grounding extraction failed: path '${path}' not found in response`);
    }
  }

  return value;
}

/**
 * Filter array results based on condition
 * @param {Array} results - Array to filter
 * @param {string} condition - Condition like "name contains 'Engineering'"
 * @returns {Array} filtered results
 */
function filterResults(results, condition) {
  if (!Array.isArray(results)) return results;
  if (!condition) return results;

  // Simple filter implementation - can be enhanced
  const match = condition.match(/(\w+)\s+(contains|equals)\s+'([^']+)'/);
  if (!match) return results;

  const [, field, operator, value] = match;

  return results.filter(item => {
    const fieldValue = String(item[field] || '').toLowerCase();
    const searchValue = value.toLowerCase();

    if (operator === 'contains') {
      return fieldValue.includes(searchValue);
    } else if (operator === 'equals') {
      return fieldValue === searchValue;
    }
    return true;
  });
}

/**
 * Execute a single grounding step
 * @param {Object} step - Grounding step definition
 * @param {Object} spec - OAS++ spec
 * @param {Object} client - API client (axios instance)
 * @param {Object} context - Current context (intent, steps)
 * @returns {Promise<Object>} step result
 */
async function executeStep(step, spec, client, context) {
  console.log(`[Grounding] Executing step: ${step.operationId}`);

  // Find the operation in the spec
  const operation = findOperation(spec, step.operationId);
  if (!operation) {
    throw new Error(`Operation not found: ${step.operationId}`);
  }

  // Resolve parameters with templates
  const params = {};
  if (step.parameters) {
    for (const [key, value] of Object.entries(step.parameters)) {
      params[key] = resolveTemplate(value, context);
    }
  }

  // Build request config
  const requestConfig = {
    method: operation.method.toLowerCase(),
    url: resolveTemplate(operation.path, context),
  };

  if (['get', 'delete'].includes(operation.method.toLowerCase())) {
    requestConfig.params = params;
  } else {
    requestConfig.data = params;
  }

  console.log(`[Grounding]   ${operation.method} ${requestConfig.url}`, params);

  // Execute the request
  const response = await client.request(requestConfig);

  // Apply filter if specified (resolve templates first)
  let data = response.data;
  if (step.filter && data.results) {
    const resolvedFilter = resolveTemplate(step.filter, context);
    data.results = filterResults(data.results, resolvedFilter);
  }

  // Check for empty collections before extraction to give a clear error
  if (step.extract) {
    for (const path of Object.values(step.extract)) {
      // path like "products[0].id" — check if the array is empty
      const arrayMatch = path.match(/^(\w+)\[0\]/);
      if (arrayMatch) {
        const collectionName = arrayMatch[1];
        const collection = data[collectionName];
        if (Array.isArray(collection) && collection.length === 0) {
          const searchedFor = params[Object.keys(params)[0]] || JSON.stringify(params);
          const message = step.error_message
            ? resolveTemplate(step.error_message, context)
            : `No ${collectionName} found matching "${searchedFor}"`;
          throw new Error(message);
        }
      }
    }
  }

  // Extract values
  const extracted = {};
  if (step.extract) {
    for (const [key, path] of Object.entries(step.extract)) {
      try {
        extracted[key] = extractValue(data, path);
        console.log(`[Grounding]   Extracted ${key}: ${extracted[key]}`);
      } catch (error) {
        const message = step.error_message
          ? resolveTemplate(step.error_message, context)
          : error.message;
        console.error(`[Grounding]   Failed to extract ${key}:`, message);
        throw new Error(message);
      }
    }
  }

  return extracted;
}

/**
 * Find an operation in the OAS++ spec by operationId
 * @param {Object} spec - OAS++ spec
 * @param {string} operationId - Operation ID
 * @returns {Object|null} operation details
 */
function findOperation(spec, operationId) {
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (operation.operationId === operationId) {
        return {
          operationId,
          path,
          method: method.toUpperCase(),
          operation,
        };
      }
    }
  }
  return null;
}

/**
 * Execute complete grounding chain
 * @param {string} api - 'github' or 'confluence'
 * @param {string} operationId - Primary operation ID
 * @param {Object} intent - User intent (natural language inputs)
 * @param {Object} spec - OAS++ spec
 * @param {Object} client - API client
 * @returns {Promise<Object>} resolved parameters
 */
async function executeGroundingChain(api, operationId, intent, spec, client) {
  console.log(`\n[Grounding] Starting grounding chain for ${operationId}`);
  console.log(`[Grounding] Intent:`, intent);

  // Find the target operation
  const targetOp = findOperation(spec, operationId);
  if (!targetOp) {
    throw new Error(`Operation not found: ${operationId}`);
  }

  // Get grounding steps
  const groundingSteps = targetOp.operation['x-postcall-grounding']?.steps || [];

  if (groundingSteps.length === 0) {
    console.log(`[Grounding] No grounding steps for ${operationId}`);
    return {};
  }

  // Build context
  const context = {
    intent,
    steps: [],
  };

  // Execute each step (with OpenAI-powered retry on failure)
  for (let i = 0; i < groundingSteps.length; i++) {
    const step = groundingSteps[i];
    console.log(`\n[Grounding] Step ${i + 1}/${groundingSteps.length}: ${step.description || step.operationId}`);

    let result = null;
    let lastError = null;

    // ── Attempt 1: try with the original intent values ─────────────────────
    try {
      result = await executeStep(step, spec, client, context);
    } catch (error) {
      normalizeError(error);
      lastError = error;
    }

    // ── If failed: ask OpenAI for alternative search terms and retry ────────
    if (!result && lastError) {
      const isConnectionError = lastError.code === 'ECONNREFUSED' || lastError.code === 'ENOTFOUND';
      if (isConnectionError) {
        // No point retrying a connection failure — surface it immediately
        console.error(`[Grounding] Step ${i + 1} failed:`, lastError.message);
        throw new Error(`Grounding failed at step ${i + 1} (${step.operationId}): ${lastError.message}`);
      }

      // Derive what was searched for (value of the first template param)
      const resolvedParams = {};
      for (const [k, v] of Object.entries(step.parameters || {})) {
        resolvedParams[k] = resolveTemplate(v, context);
      }

      console.log(`      ✗ Grounding step failed: ${lastError.message}`);
      console.log(`      → Asking OpenAI to reformulate search query...`);

      const alternatives = await reformulateGroundingQuery(
        step.operationId, resolvedParams, intent, lastError.message
      );

      if (alternatives.length > 0) {
        console.log(`      → Trying ${alternatives.length} alternative(s): ${alternatives.map(a => `"${a}"`).join(', ')}`);
      }

      for (const altTerm of alternatives) {
        // Build a modified context with the alternative name substituted
        const altIntent = { ...context.intent };
        // Replace intent values that look like the failed search term
        for (const [k] of Object.entries(step.parameters || {})) {
          if (k === 'name') {
            // Override the name-mapped intent key
            const nameKey = Object.keys(intent).find(ik => ik.endsWith('_name'));
            if (nameKey) altIntent[nameKey] = altTerm;
          }
        }
        const altContext = { ...context, intent: altIntent };

        try {
          result = await executeStep(step, spec, client, altContext);
          console.log(`      ✓ Alternative "${altTerm}" succeeded`);
          lastError = null;
          break;
        } catch (altError) {
          normalizeError(altError);
          console.log(`      ✗ Alternative "${altTerm}" also failed: ${altError.message}`);
          lastError = altError;
        }
      }
    }

    if (!result) {
      if (step.required === false) {
        console.log(`[Grounding] Step ${i + 1} optional — skipping (${lastError?.message})`);
        context.steps.push({});
        continue;
      }
      const message = step.error_message
        ? resolveTemplate(step.error_message, context)
        : `Grounding failed at step ${i + 1} (${step.operationId}): ${lastError?.message}`;
      console.error(`[Grounding] Step ${i + 1} failed:`, message);
      throw new Error(message);
    }

    context.steps.push(result);
  }

  // Get final resolved parameters
  const resolved = context.steps[context.steps.length - 1] || {};

  console.log(`\n[Grounding] Chain complete. Resolved parameters:`, resolved);
  return resolved;
}

module.exports = {
  executeGroundingChain,
  findOperation,
  resolveTemplate,
  extractValue,
};
