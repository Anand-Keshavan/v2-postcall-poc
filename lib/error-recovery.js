/**
 * Error Recovery System
 *
 * When API calls fail with validation errors, this system:
 * 1. Captures the error details
 * 2. Sends error + operation documentation to OpenAI
 * 3. OpenAI analyzes what went wrong
 * 4. Generates corrected parameters
 * 5. Retries the request
 *
 * Works generically for ANY API.
 */

const axios = require('axios');

/**
 * Analyze validation error and suggest fix using OpenAI
 */
async function analyzeAndFixError(error, operation, originalRequest, intent) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('Cannot recover from error: OPENAI_API_KEY not configured');
  }

  // Extract operation documentation
  const operationDoc = extractOperationDocumentation(operation);

  const prompt = `You are an API debugging expert. An API call failed with a validation error.

**Operation:** ${operation.operationId}
**API:** ${operation.method} ${operation.path}

**Operation Documentation:**
${operationDoc}

**Original Request:**
- URL: ${originalRequest.url}
- Method: ${originalRequest.method}
- Query Parameters: ${JSON.stringify(originalRequest.params || {}, null, 2)}
- Path Parameters: ${extractPathParams(operation.path, originalRequest.url)}

**User Intent:**
${JSON.stringify(intent, null, 2)}

**Error Details:**
- Status: ${error.status || 'unknown'}
- Message: ${error.message}
- Original Error: ${JSON.stringify(error.originalError, null, 2)}

**Task:**
Analyze why the API call failed and provide corrected parameters.

Common issues:
- Missing required parameters
- Incorrect parameter format or wrong parameter values
- Special syntax not followed — read the parameter description and examples carefully;
  they often document the exact syntax or qualifiers required
- Query language / filter syntax errors — the parameter description is the source of truth;
  it lists exactly which field names are valid and may explicitly warn against others —
  follow those warnings precisely
- Invalid field names — if the description says a field does NOT exist or must NOT be used,
  never include it in the corrected value

CRITICAL CONSTRAINT — Entity Identifiers:
If the error is caused by an entity that could not be found (e.g., the API returned empty
results, a resource like a space/project/user was not found, or the search returned no
matches), do NOT attempt to guess or invent any identifier value (space key, project key,
user ID, slug, etc.). Invented identifiers will never be correct and cause silent failures.
In this case, return empty correctedParams and set the diagnosis to explain that the entity
lookup failed and cannot be recovered automatically.

Respond with JSON in this exact format:
{
  "diagnosis": "Brief explanation of what went wrong",
  "correctedParams": {
    "param1": "corrected value",
    "param2": "corrected value"
  },
  "correctedPathParams": {
    "owner": "value",
    "repo": "value"
  }
}`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.4',
        messages: [
          {
            role: 'system',
            content: 'You are an API debugging expert. Analyze errors and provide fixes. Respond only with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1, // Low temperature for precise fixes
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const fix = JSON.parse(response.data.choices[0].message.content);
    return fix;

  } catch (openaiError) {
    console.error('[ErrorRecovery] OpenAI analysis failed:', openaiError.message);
    throw error; // Re-throw original error if OpenAI fails
  }
}

/**
 * Extract comprehensive operation documentation from OpenAPI spec
 */
function extractOperationDocumentation(operation) {
  let doc = '';

  // Basic info
  if (operation.operation.summary) {
    doc += `Summary: ${operation.operation.summary}\n`;
  }

  if (operation.operation.description) {
    doc += `Description: ${operation.operation.description}\n`;
  }

  doc += '\nParameters:\n';

  // Document all parameters
  if (operation.operation.parameters && operation.operation.parameters.length > 0) {
    operation.operation.parameters.forEach(param => {
      doc += `\n- ${param.name} (${param.in}):\n`;
      doc += `  Required: ${param.required || false}\n`;

      if (param.description) {
        doc += `  Description: ${param.description}\n`;
      }

      if (param.schema) {
        if (param.schema.type) {
          doc += `  Type: ${param.schema.type}\n`;
        }
        if (param.schema.enum) {
          doc += `  Allowed values: ${param.schema.enum.join(', ')}\n`;
        }
        if (param.schema.format) {
          doc += `  Format: ${param.schema.format}\n`;
        }
        if (param.schema.pattern) {
          doc += `  Pattern: ${param.schema.pattern}\n`;
        }
      }

      if (param.example) {
        doc += `  Example: ${param.example}\n`;
      }
    });
  } else {
    doc += '  No parameters defined\n';
  }

  return doc;
}

/**
 * Extract path parameters from URL
 */
function extractPathParams(pathTemplate, actualUrl) {
  const params = {};
  const templateParts = pathTemplate.split('/');
  const urlParts = actualUrl.split('?')[0].split('/');

  templateParts.forEach((part, i) => {
    if (part.startsWith('{') && part.endsWith('}')) {
      const paramName = part.slice(1, -1);
      params[paramName] = urlParts[i] || 'NOT_SET';
    }
  });

  return JSON.stringify(params, null, 2);
}

/**
 * Apply corrected parameters to request
 */
function applyCorrections(originalRequest, fix, operation) {
  const correctedRequest = { ...originalRequest };

  // Apply corrected query parameters
  if (fix.correctedParams) {
    correctedRequest.params = {
      ...originalRequest.params,
      ...fix.correctedParams,
    };
  }

  // Apply corrected path parameters
  if (fix.correctedPathParams) {
    let url = operation.path;
    for (const [param, value] of Object.entries(fix.correctedPathParams)) {
      url = url.replace(`{${param}}`, value);
    }
    correctedRequest.url = url;
  }

  return correctedRequest;
}

/**
 * Print full API request for debugging
 */
function printRequest(request, attempt, maxRetries) {
  console.log(`\n      ┌─ API Request (Attempt ${attempt + 1}/${maxRetries + 1}) ${'─'.repeat(20)}`);
  console.log(`      │  ${(request.method || 'GET').toUpperCase()} ${request.url}`);
  if (request.params && Object.keys(request.params).length > 0) {
    console.log(`      │  Query params: ${JSON.stringify(request.params)}`);
  }
  if (request.data) {
    console.log(`      │  Body: ${JSON.stringify(request.data)}`);
  }
  if (request.headers) {
    // Only show non-sensitive headers
    const safeHeaders = Object.fromEntries(
      Object.entries(request.headers).filter(([k]) => !k.toLowerCase().includes('auth'))
    );
    if (Object.keys(safeHeaders).length > 0) {
      console.log(`      │  Headers: ${JSON.stringify(safeHeaders)}`);
    }
  }
  console.log(`      └${'─'.repeat(43)}`);
}

/**
 * Print full API response for debugging
 */
function printResponse(response) {
  console.log(`\n      ┌─ API Response ${'─'.repeat(29)}`);
  console.log(`      │  Status: ${response.status} ${response.statusText || ''}`);
  const pretty = JSON.stringify(response.data, null, 2);
  pretty.split('\n').forEach(line => console.log(`      │  ${line}`));
  console.log(`      └${'─'.repeat(43)}`);
}

/**
 * Print full API error response for debugging
 */
function printErrorResponse(error) {
  console.log(`\n      ┌─ API Error Response ${'─'.repeat(22)}`);
  console.log(`      │  Status: ${error.status || error.response?.status || 'unknown'}`);
  console.log(`      │  Message: ${error.message}`);
  const body = error.originalError ?? error.response?.data;
  if (body) {
    const pretty = JSON.stringify(body, null, 2);
    pretty.split('\n').forEach(line => console.log(`      │  ${line}`));
  }
  console.log(`      └${'─'.repeat(43)}`);
}

/**
 * Determine if an error is recoverable via OpenAI analysis
 * Returns true for 4xx/5xx client and server errors (not auth/network issues)
 */
function isRecoverableError(error) {
  const status = error.status || error.response?.status;
  // Retry on 4xx (except 401/403 which are auth issues)
  // and 5xx server errors — OpenAI can suggest payload fixes
  return status >= 400 && status !== 401 && status !== 403;
}

/**
 * Execute request with automatic error recovery
 *
 * @param {Object} client - Axios client
 * @param {Object} request - Request object { method, url, params }
 * @param {Object} operation - Operation metadata from spec
 * @param {Object} intent - User intent
 * @param {Number} maxRetries - Maximum retry attempts (default: 3)
 * @returns {Promise<Object>} Response data
 */
async function executeWithRecovery(client, request, operation, intent, maxRetries = 3) {
  const abortSignal = require('./abort-signal');
  let lastError = null;
  let currentRequest = request;

  // Track every (params + url) fingerprint we have tried.
  // If the same fingerprint appears twice we are in a retry loop — abort immediately.
  const triedFingerprints = new Set();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (abortSignal.isAborted()) {
      throw new Error('Operation aborted by user');
    }

    // ── Loop-detection guard ───────────────────────────────────────────────
    const fingerprint = JSON.stringify({
      url: currentRequest.url,
      params: currentRequest.params || {},
      data: currentRequest.data || {},
    });
    if (triedFingerprints.has(fingerprint)) {
      console.log(`\n      ✗ Retry loop detected — same request tried twice. Aborting.`);
      throw new Error(
        `API call failed: error recovery is oscillating (same parameters tried twice). ` +
        `Last error: ${lastError?.message}`
      );
    }
    triedFingerprints.add(fingerprint);
    // ──────────────────────────────────────────────────────────────────────

    try {
      printRequest(currentRequest, attempt, maxRetries);

      const response = await client.request(currentRequest);

      printResponse(response);

      if (attempt > 0) {
        console.log(`\n      ✓ Recovered after ${attempt} correction(s)!`);
      }

      return response;

    } catch (error) {
      lastError = error;

      printErrorResponse(error);

      const recoverable = isRecoverableError(error);

      if (!recoverable) {
        const status = error.status || error.response?.status;
        if (status === 401 || status === 403) {
          console.log(`      ✗ Authentication error (${status}) — cannot auto-recover. Check your credentials.`);
        } else {
          console.log(`      ✗ Non-recoverable error — aborting.`);
        }
        throw lastError;
      }

      if (attempt < maxRetries) {
        console.log(`\n      ⚠ Error on attempt ${attempt + 1}: ${error.message}`);
        console.log(`      → Sending error to OpenAI for analysis...`);

        try {
          const fix = await analyzeAndFixError(error, operation, currentRequest, intent);

          console.log(`\n      ✓ OpenAI Diagnosis: ${fix.diagnosis}`);
          console.log(`      → Applying corrections and retrying...`);

          currentRequest = applyCorrections(currentRequest, fix, operation);

          if (fix.correctedParams && Object.keys(fix.correctedParams).length > 0) {
            console.log(`      → Corrected params: ${JSON.stringify(fix.correctedParams)}`);
          }
          if (fix.correctedPathParams && Object.keys(fix.correctedPathParams).length > 0) {
            console.log(`      → Corrected path params: ${JSON.stringify(fix.correctedPathParams)}`);
          }

          continue;

        } catch (analysisError) {
          console.error(`      ✗ OpenAI analysis failed: ${analysisError.message}`);
          throw lastError;
        }
      } else {
        console.log(`\n      ✗ Max retries (${maxRetries}) exceeded.`);
      }

      throw lastError;
    }
  }

  throw lastError;
}

module.exports = {
  executeWithRecovery,
  analyzeAndFixError,
};
