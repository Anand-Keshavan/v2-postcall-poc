/**
 * Documentation-Aware Reasoning Planner
 *
 * This planner READS and UNDERSTANDS API documentation before creating execution plans.
 * It uses OpenAI to:
 * 1. Read parameter documentation and constraints
 * 2. Understand special syntax requirements
 * 3. Generate correct parameters from user query
 * 4. Validate parameters against schema
 */

const axios = require('axios');
const { formatForAI, getRequiredParameters, validateParameter } = require('./doc-retriever');

/**
 * Generate execution plan with documentation awareness
 *
 * @param {string} query - User query
 * @param {Object} matchedOperation - Matched operation with documentation
 * @param {Array} availableOperations - All available operations
 * @returns {Promise<Object>} Execution plan
 */
async function generateDocAwarePlan(query, matchedOperation, availableOperations = []) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey || !matchedOperation.documentation) {
    // Fall back to simple planning without documentation
    return generateSimplePlan(query, matchedOperation);
  }

  try {
    const doc = matchedOperation.documentation;
    const formattedDoc = formatForAI(doc);

    // Check if this operation has grounding rules
    const hasGrounding = doc.extensions?.grounding?.steps?.length > 0;
    const groundingInfo = hasGrounding ? formatGroundingInfo(doc.extensions.grounding) : '';

    const prompt = `You are an expert API integration engineer. You have access to complete API documentation and must create a precise execution plan.

USER QUERY: "${query}"

API DOCUMENTATION:
${formattedDoc}

${hasGrounding ? `GROUNDING CHAIN INFORMATION:
This operation uses a grounding chain to automatically resolve some parameters.
${groundingInfo}

IMPORTANT: Parameters that will be resolved by the grounding chain do NOT need to be extracted from the query.
Only extract parameters that are NOT resolved by grounding.
` : ''}

INSTRUCTIONS:
1. Read and understand the API documentation carefully
2. Identify ALL required parameters
${hasGrounding ? '3. Note which parameters will be resolved by the grounding chain (do NOT extract these from query)\n4. Extract ONLY the parameters that are NOT resolved by grounding' : '3. Extract parameter values from the user query'}
${hasGrounding ? '5' : '4'}. Apply any special syntax rules mentioned in documentation
${hasGrounding ? '6' : '5'}. Respect parameter constraints (enum values, patterns, ranges)
${hasGrounding ? '7' : '6'}. Use default values where appropriate
${hasGrounding ? '8' : '7'}. Create a precise execution plan

CRITICAL RULES:
- If documentation mentions special syntax (like "org:name" or CQL), YOU MUST use it
- Extract parameter values from user's query text
- For search endpoints, construct proper search queries using the documented syntax
- Required parameters MUST be included (unless resolved by grounding)
- Validate enum values against allowed list
- Apply format constraints (phone numbers, dates, etc.)
${hasGrounding ? '- DO NOT extract parameters that will be resolved by grounding chain' : ''}
- Set "canFulfill": false ONLY if the operation is fundamentally the wrong one for the query
  (e.g., the user asks to search by creator but this operation only fetches by ID)
- If the operation CAN fulfill the query even partially, set "canFulfill": true

Respond with JSON in this format:
{
  "canFulfill": true,
  "reasoning": "Explain your understanding of the query and why these parameters are correct",
  "parameters": {
    "param1": "value1",
    "param2": "value2"
  },
  "pathParameters": {
    "param_name": "value"
  },
  "entityValues": {
    "entity_name": "value extracted from query (only needed when grounding is used)"
  },
  "confidence": 0.95,
  "warnings": ["any concerns or assumptions"],
  "usesGrounding": ${hasGrounding}
}

When canFulfill is false:
{
  "canFulfill": false,
  "reasoning": "Explain why this operation cannot handle the query",
  "suggestedOperation": "operationId that would be better suited (if known)",
  "confidence": 0.0,
  "parameters": {},
  "pathParameters": {},
  "entityValues": {},
  "warnings": [],
  "usesGrounding": false
}

${hasGrounding ? `⚠️ CRITICAL: Do NOT include grounded parameters in "parameters" or "pathParameters".
Leave them empty - they will be resolved automatically during execution.
DO include the source entity values (like team_name, member_name, etc.) in "entityValues" so the grounding chain can look them up.` : ''}

EXAMPLES:
Query: "List repos in postman-eng organization"
Documentation shows: "Use org:name to search within organization"
→ { "canFulfill": true, "parameters": { "q": "org:postman-eng" } }

Query: "Find all pages created by Anand"
Documentation for searchContent shows CQL with creator.displayName field
→ { "canFulfill": true, "parameters": { "cql": "creator.displayName = \\"Anand\\" AND type = page" } }

Query: "Find all pages created by Anand"
Documentation for getPageById only fetches a single page by numeric ID
→ { "canFulfill": false, "reasoning": "getPageById requires a specific ID; cannot search by creator", "suggestedOperation": "searchContent" }

Now analyze the user's query and create the correct parameters:`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.4',
        messages: [
          {
            role: 'system',
            content: 'You are an expert API integration engineer. Read documentation carefully and generate precise API parameters. Respond only with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.2, // Low temperature for precise parameter extraction
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const aiResponse = JSON.parse(response.data.choices[0].message.content);

    // ── Feasibility gate ────────────────────────────────────────────────
    // If the AI says this operation cannot fulfill the query, return early
    // so the agent can try a better-matched operation.
    if (aiResponse.canFulfill === false) {
      return {
        canFulfill: false,
        reasoning: aiResponse.reasoning,
        suggestedOperation: aiResponse.suggestedOperation || null,
        documentationUsed: true,
        confidence: 0,
        warnings: [],
        steps: [],
      };
    }

    // Validate parameters against documentation
    const validationResult = validateParameters(
      { ...aiResponse.parameters, ...aiResponse.pathParameters },
      doc,
      hasGrounding
    );

    if (!validationResult.valid) {
      console.log(`      ⚠ Parameter validation warnings:`);
      validationResult.errors.forEach(err => {
        console.log(`        - ${err}`);
      });
    }

    // Create execution plan
    const plan = {
      canFulfill: true,
      reasoning: aiResponse.reasoning,
      documentationUsed: true,
      usesGrounding: hasGrounding,
      confidence: aiResponse.confidence || 0.8,
      warnings: aiResponse.warnings || [],
      steps: [
        {
          stepNumber: 1,
          api: doc.api,
          operationId: doc.operationId,
          purpose: doc.summary || 'Execute API operation',
          parameters: aiResponse.parameters || {},
          pathParameters: aiResponse.pathParameters || {},
          entityValues: aiResponse.entityValues || {},
          useResultFrom: null,
          extractData: null,
          needsGrounding: hasGrounding, // Flag to indicate grounding should be executed
        }
      ],
      expectedResult: `Response from ${doc.operationId}`,
    };

    return plan;

  } catch (error) {
    console.error('[DocAwarePlanner] OpenAI error:', error.message);
    return generateSimplePlan(query, matchedOperation);
  }
}

/**
 * Extract {{intent.xxx}} variable names from grounding step templates
 */
function extractGroundingIntentVars(grounding) {
  const intentVars = new Set();
  const templatePattern = /\{\{intent\.(\w+)\}\}/g;
  for (const step of grounding.steps || []) {
    // REST uses 'parameters', GraphQL uses 'variables'
    const stepVars = { ...(step.parameters || {}), ...(step.variables || {}) };
    for (const template of Object.values(stepVars)) {
      if (typeof template === 'string') {
        let m;
        const re = /\{\{intent\.(\w+)\}\}/g;
        while ((m = re.exec(template)) !== null) {
          intentVars.add(m[1]);
        }
      }
    }
  }
  return Array.from(intentVars);
}

/**
 * Format grounding chain information for AI understanding
 */
function formatGroundingInfo(grounding) {
  if (!grounding || !grounding.steps) return '';

  // Collect all parameters that will be resolved by grounding (the IDs)
  const resolvedParams = new Set();
  grounding.steps.forEach(step => {
    if (step.extract) {
      Object.keys(step.extract).forEach(param => resolvedParams.add(param));
    }
  });

  // Collect the entity name variables the grounding chain needs from user intent
  const intentVars = extractGroundingIntentVars(grounding);

  let info = `The following parameters will be AUTOMATICALLY RESOLVED by a grounding chain:\n`;
  info += `  ${Array.from(resolvedParams).join(', ')}\n\n`;
  info += `Grounding Chain Steps:\n`;
  grounding.steps.forEach((step, index) => {
    info += `\nStep ${index + 1}: ${step.operationId}\n`;
    if (step.description) {
      info += `  Purpose: ${step.description}\n`;
    }
    if (step.extract) {
      info += `  Will resolve: ${Object.keys(step.extract).join(', ')}\n`;
    }
  });

  info += `\n⚠️ IMPORTANT: Do NOT extract the grounded parameters (${Array.from(resolvedParams).join(', ')}) from the user query.\n`;
  info += `These will be automatically resolved by the grounding chain.\n`;

  if (intentVars.length > 0) {
    info += `\nHOWEVER, the grounding chain needs these entity values FROM the user query:\n`;
    info += `  ${intentVars.map(v => `${v}: the ${v.replace(/_/g, ' ')} mentioned in the query`).join('\n  ')}\n`;
    info += `Extract these into "entityValues" in your response.\n`;
  }

  return info;
}

/**
 * Get intent variable names needed by grounding (exported for use in planner)
 */
function getGroundingIntentVars(grounding) {
  return extractGroundingIntentVars(grounding);
}

/**
 * Validate parameters against documentation
 */
function validateParameters(parameters, doc, hasGrounding = false) {
  const errors = [];
  const requiredParams = getRequiredParameters(doc);

  // Collect parameters that will be resolved by grounding
  const groundedParams = new Set();
  if (hasGrounding && doc.extensions?.grounding?.steps) {
    doc.extensions.grounding.steps.forEach(step => {
      if (step.extract) {
        Object.keys(step.extract).forEach(param => groundedParams.add(param));
      }
    });
  }

  // Check all required parameters are present (excluding grounded ones)
  requiredParams.forEach(param => {
    if (parameters[param.name] === undefined && !groundedParams.has(param.name)) {
      errors.push(`Missing required parameter: ${param.name}`);
    }
  });

  // Validate each parameter
  Object.entries(parameters).forEach(([name, value]) => {
    const param = doc.parameters.find(p => p.name === name);
    if (param) {
      const validation = validateParameter(param, value);
      if (!validation.valid) {
        errors.push(`${name}: ${validation.error}`);
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Simple plan generation without documentation (fallback)
 */
function generateSimplePlan(query, matchedOperation) {
  // Extract basic parameters from query
  const parameters = extractBasicParameters(query, matchedOperation);

  return {
    reasoning: `Matched to ${matchedOperation.operationId} based on query`,
    documentationUsed: false,
    confidence: matchedOperation.confidence || 0.6,
    warnings: ['Generated without full documentation - parameters may be incomplete'],
    steps: [
      {
        stepNumber: 1,
        api: matchedOperation.api,
        operationId: matchedOperation.operationId,
        purpose: matchedOperation.summary || 'Execute operation',
        parameters,
        pathParameters: {},
        useResultFrom: null,
        extractData: null,
      }
    ],
    expectedResult: 'API response',
  };
}

/**
 * Extract basic parameters from query (simple heuristics)
 */
function extractBasicParameters(query, matchedOperation) {
  const parameters = {};
  const queryLower = query.toLowerCase();

  // Special handling for search operations
  if (matchedOperation.operationId && matchedOperation.operationId.includes('search')) {
    // Try to extract search term
    const searchTerm = query
      .toLowerCase()
      .replace(/^(find|search|show|get|list)\s+/, '')
      .replace(/\s+(repo|repository|repositories|in|on).*$/, '')
      .trim();

    if (searchTerm) {
      parameters.q = searchTerm;
    }
  }

  return parameters;
}

/**
 * Enhanced parameter extraction with documentation context
 *
 * @param {string} query - User query
 * @param {Object} documentation - Full operation documentation
 * @returns {Promise<Object>} Extracted parameters
 */
async function extractParametersWithDocs(query, documentation) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return extractBasicParameters(query, { operationId: documentation.operationId });
  }

  const formattedDoc = formatForAI(documentation);

  const prompt = `Extract API parameters from user query based on documentation.

USER QUERY: "${query}"

API DOCUMENTATION:
${formattedDoc}

Extract parameter values from the query. Follow these rules:
1. Use special syntax from documentation (e.g., "org:name" for GitHub)
2. Extract all mentioned values
3. Apply format constraints
4. Use defaults if not specified

Respond with JSON: { "parameters": { "param1": "value1", ... } }`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.4',
        messages: [
          { role: 'system', content: 'Extract API parameters from user queries. Respond only with JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const result = JSON.parse(response.data.choices[0].message.content);
    return result.parameters || {};

  } catch (error) {
    console.error('[DocAwarePlanner] Parameter extraction error:', error.message);
    return extractBasicParameters(query, { operationId: documentation.operationId });
  }
}

/**
 * Check whether an initial plan fully covers every part of the user's query.
 * If not, return an enriched plan with additional API and/or action steps appended.
 *
 * This is fully generic: it works for any set of operations loaded from OAS++ or
 * Schema++ specs. API-specific knowledge lives in the spec descriptions, not here.
 *
 * @param {string} query            - Original user query
 * @param {Object} plan             - Plan produced by generateDocAwarePlan
 * @param {Array}  allOperations    - All operations across all loaded specs
 * @returns {Promise<Object>}       - Enriched plan (original if already complete)
 */
async function enrichPlanForCompleteness(query, plan, allOperations) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return plan;

  const opsContext = allOperations.map(op => ({
    api: op.api,
    operationId: op.operationId,
    summary: op.summary || op.operation?.summary || op.operation?.description || '',
    examples: op.operation?.['x-agent-guidance'] || [],
  }));

  const currentSteps = plan.steps.map(s => ({
    stepNumber: s.stepNumber,
    stepType: s.stepType || 'api',
    ...(s.stepType === 'action'
      ? { action: s.action, purpose: s.purpose }
      : { api: s.api, operationId: s.operationId, purpose: s.purpose }),
  }));

  const nextStepNumber = plan.steps.length + 1;

  // Build grounding chain info — tells GPT-4o which operations are already called
  // internally by the existing plan steps so it doesn't add them as extra steps.
  const groundingLines = [];
  for (const step of plan.steps) {
    if (step.stepType === 'action') continue;
    const op = allOperations.find(o => o.api === step.api && o.operationId === step.operationId);
    const grounding = op?.operation?.['x-postcall-grounding'];
    if (grounding?.steps?.length > 0) {
      const internalCalls = grounding.steps.map(gs => gs.operationId).join(', ');
      groundingLines.push(
        `  - Step ${step.stepNumber} (${step.operationId}) automatically resolves its own parameters by internally calling: ${internalCalls}`
      );
    }
  }
  const groundingSection = groundingLines.length > 0
    ? `\nINTERNAL GROUNDING CHAINS — these operations are called automatically inside the steps above; do NOT add them as explicit steps:\n${groundingLines.join('\n')}\n`
    : '';

  const prompt = `You are reviewing an API execution plan for completeness.

USER QUERY: "${query}"

CURRENT PLAN STEPS:
${JSON.stringify(currentSteps, null, 2)}
${groundingSection}
AVAILABLE API OPERATIONS:
${JSON.stringify(opsContext, null, 2)}

AVAILABLE ACTION TYPES (non-API, local operations):
- open-url: Opens one or more URLs derived from a prior step's results in the system browser.
  Fields: { stepType: "action", action: "open-url", purpose: "...", urlTemplate: "..." }
  urlTemplate examples:
    "steps[0].data._links.webui"               – single URL from step 0
    "steps[0].data.results[*]._links.webui"    – open all result URLs from step 0
    "steps[0].data.results[*]._links.self"     – use self link if webui is unavailable
  Note: steps[N] is 0-based — steps[0] is the first step's result.

Does the current plan fully address EVERY part of the user's query?

Rules:
- Only add steps for sub-tasks that are genuinely NOT covered by the current plan.
- "show in browser" / "open in browser" / "display in browser" → add an open-url action step.
- "show content" / "get full content" / "display content" without "in browser" → add an API step that fetches the body (e.g. with expand=body.storage for Confluence).
- Do NOT add steps that duplicate what existing steps already do.
- New step numbers start from ${nextStepNumber}.

If the plan is complete:
{ "complete": true }

If additional steps are needed:
{
  "complete": false,
  "additionalSteps": [
    {
      "stepNumber": ${nextStepNumber},
      "stepType": "api",
      "api": "<api name>",
      "operationId": "<operationId>",
      "purpose": "<short description>",
      "parameters": {},
      "pathParameters": {},
      "entityValues": {},
      "useResultFrom": <prior step number or null>,
      "needsGrounding": false
    },
    {
      "stepNumber": ${nextStepNumber + 1},
      "stepType": "action",
      "action": "open-url",
      "purpose": "<short description>",
      "urlTemplate": "<steps[N].data.path.to.url>"
    }
  ]
}`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.4',
        messages: [
          {
            role: 'system',
            content: 'You are an API plan completeness checker. Respond only with valid JSON.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const result = JSON.parse(response.data.choices[0].message.content);

    if (result.complete) {
      console.log(`      ✓ Plan is complete`);
      return plan;
    }

    const added = result.additionalSteps || [];
    console.log(`      → Adding ${added.length} missing step(s):`);
    added.forEach(s => {
      const label = s.stepType === 'action' ? `action:${s.action}` : s.operationId;
      console.log(`        + Step ${s.stepNumber}: ${s.purpose}  [${label}]`);
    });

    return { ...plan, primaryStepCount: plan.steps.length, steps: [...plan.steps, ...added] };

  } catch (err) {
    console.error('[DocAwarePlanner] Completeness check failed:', err.message);
    return plan;
  }
}

module.exports = {
  generateDocAwarePlan,
  extractParametersWithDocs,
  validateParameters,
  enrichPlanForCompleteness,
};
