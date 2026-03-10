/**
 * Reasoning Planner for Multi-Step API Workflows
 *
 * This module enables the agent to:
 * 1. Analyze complex queries
 * 2. Plan multi-step API call sequences
 * 3. Execute plans with dynamic context
 * 4. Aggregate and format results
 */

const axios = require('axios');
require('dotenv').config();

/**
 * Generate execution plan using OpenAI
 */
async function generatePlan(query, availableOperations, specs) {
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!openaiKey) {
    // Fall back to simple rule-based planning
    return generateSimplePlan(query, availableOperations);
  }

  try {
    // Build context of available operations
    const operationsContext = availableOperations.map(op => {
      const guidance = op.operation['x-agent-guidance'] || [];
      return {
        api: op.api,
        operationId: op.operationId,
        summary: op.operation.summary || '',
        description: op.operation.description || '',
        examples: guidance,
        path: op.path,
        method: op.method,
      };
    });

    const prompt = `You are an API planning agent. Given a user query, create a step-by-step execution plan using available API operations.

User Query: "${query}"

Available Operations:
${JSON.stringify(operationsContext, null, 2)}

Analyze the query and create an execution plan. The plan should:
1. Break down the query into atomic API operations
2. Specify the order of execution
3. Indicate how to use results from one step in the next step
4. Handle cases where multiple operations might be needed

Respond with a JSON plan in this format:
{
  "reasoning": "Brief explanation of the plan",
  "steps": [
    {
      "stepNumber": 1,
      "api": "github",
      "operationId": "listUserRepos",
      "purpose": "Get list of repositories",
      "parameters": {
        "q": "repo-name",
        "sort": "updated"
      },
      "useResultFrom": null,
      "extractData": ["name", "owner.login"]
    }
  ],
  "expectedResult": "What the user will see at the end"
}

IMPORTANT: Include a "parameters" object with ALL required query/path parameters extracted from the user query.
For search operations, always include the "q" parameter with the search term from the query.

For simple single-operation queries, return a single step.
For complex queries that need multiple API calls, return multiple steps.`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.4',
        messages: [
          { role: 'system', content: 'You are an expert API planning agent. Respond only with valid JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const plan = JSON.parse(response.data.choices[0].message.content);
    return plan;

  } catch (error) {
    console.error('[Planner] OpenAI error:', error.message);
    return generateSimplePlan(query, availableOperations);
  }
}

/**
 * Simple rule-based planning (fallback when no OpenAI)
 */
function generateSimplePlan(query, availableOperations) {
  const queryLower = query.toLowerCase();

  // Rule 1: "list all repositories" needs just one call
  if (queryLower.includes('list') && queryLower.includes('repo')) {
    const listReposOp = availableOperations.find(op =>
      op.operationId === 'listUserRepos'
    );

    if (listReposOp) {
      return {
        reasoning: 'Single operation to list user repositories',
        steps: [
          {
            stepNumber: 1,
            api: listReposOp.api,
            operationId: 'listUserRepos',
            purpose: 'List all repositories for authenticated user',
            parameters: {},
            useResultFrom: null,
            extractData: null,
          }
        ],
        expectedResult: 'List of repositories with names and URLs',
      };
    }
  }

  // Rule 2: "list issues in repo" needs grounding + list issues
  if (queryLower.includes('issue')) {
    const listIssuesOp = availableOperations.find(op =>
      op.operationId === 'listIssues'
    );

    if (listIssuesOp) {
      return {
        reasoning: 'Resolve repo name to owner/repo, then list issues',
        steps: [
          {
            stepNumber: 1,
            api: listIssuesOp.api,
            operationId: 'listIssues',
            purpose: 'List issues in the specified repository',
            parameters: {},
            useResultFrom: null,
            extractData: null,
          }
        ],
        expectedResult: 'List of issues with titles and states',
      };
    }
  }

  // Rule 3: "list spaces" for Confluence
  if (queryLower.includes('space') || queryLower.includes('confluence')) {
    const listSpacesOp = availableOperations.find(op =>
      op.operationId === 'listSpaces'
    );

    if (listSpacesOp) {
      return {
        reasoning: 'Single operation to list Confluence spaces',
        steps: [
          {
            stepNumber: 1,
            api: listSpacesOp.api,
            operationId: 'listSpaces',
            purpose: 'List all Confluence spaces',
            parameters: {},
            useResultFrom: null,
            extractData: null,
          }
        ],
        expectedResult: 'List of Confluence spaces',
      };
    }
  }

  // Default: return first matching operation
  if (availableOperations.length > 0) {
    const firstOp = availableOperations[0];

    // Extract parameters from query for the operation
    const parameters = extractParametersFromQuery(query, firstOp);

    return {
      reasoning: `Using best match: ${firstOp.operationId}`,
      steps: [
        {
          stepNumber: 1,
          api: firstOp.api,
          operationId: firstOp.operationId,
          purpose: firstOp.operation.summary || 'Execute operation',
          parameters,
          useResultFrom: null,
          extractData: null,
        }
      ],
      expectedResult: 'API response',
    };
  }

  return null;
}

/**
 * Extract parameters from query for a specific operation
 */
function extractParametersFromQuery(query, operation) {
  const parameters = {};
  const queryLower = query.toLowerCase();

  // Special handling for search operations
  if (operation.operationId === 'searchRepos') {
    // Extract the search term - typically the main subject of the query
    // Remove common query words
    const searchTerm = query
      .toLowerCase()
      .replace(/^(find|search|show|get|list)\s+/, '')
      .replace(/\s+(repo|repository|repositories).*$/, '')
      .trim();

    if (searchTerm) {
      parameters.q = searchTerm;
    }
  } else if (operation.operationId === 'searchContent') {
    // Confluence content search
    const searchTerm = query
      .toLowerCase()
      .replace(/^(find|search|show|get)\s+/, '')
      .replace(/\s+(page|content|in confluence).*$/, '')
      .trim();

    if (searchTerm) {
      parameters.cql = `title ~ "${searchTerm}" OR text ~ "${searchTerm}"`;
    }
  }

  return parameters;
}

/**
 * Execute a multi-step plan
 * @param {Object} plan
 * @param {Object} specs        – REST OAS++ specs
 * @param {Object} schemaSpecs  – GraphQL Schema++ specs
 * @param {Object} clients
 * @param {Object} intent
 * @param {string} userQuery    – original natural-language query (for context resolution)
 */
async function executePlan(plan, specs, schemaSpecs, clients, intent, userQuery = '') {
  const { forSpec } = require('./protocols');
  const abortSignal = require('./abort-signal');

  console.log(`\n📋 Execution Plan:`);
  console.log(`   ${plan.reasoning}\n`);

  const results = [];

  for (const step of plan.steps) {
    if (abortSignal.isAborted()) {
      throw new Error('Operation aborted by user');
    }

    // ── Action step (non-API) ──────────────────────────────────────────────
    if (step.stepType === 'action') {
      console.log(`[Step ${step.stepNumber}/${plan.steps.length}] ${step.purpose}  [action:${step.action}]`);
      const actionData = await executeAction(step, results);
      results.push({ step: step.stepNumber, operationId: `action:${step.action}`, data: actionData });
      console.log(`      ✓ Complete\n`);
      continue;
    }

    // ── API step (REST or GraphQL via protocol plugin) ─────────────────────
    const protocol = forSpec(specs[step.api], schemaSpecs[step.api]);
    console.log(`[Step ${step.stepNumber}/${plan.steps.length}] ${step.purpose}  [${step.api} / ${protocol.name}]`);

    const client = clients[step.api];
    if (!client) {
      throw new Error(`No client available for API: ${step.api}`);
    }

    const stepResult = await protocol.executeStep({ step, client, intent, userQuery, specs, schemaSpecs });
    results.push({ step: step.stepNumber, ...stepResult });

    console.log(`      ✓ Complete\n`);
  }

  return {
    plan,
    results,
    finalResult: results[results.length - 1]?.data,
  };
}

/**
 * Dispatch a non-API action step to its executor.
 */
async function executeAction(step, priorResults) {
  if (step.action === 'open-url') {
    const { execute } = require('./actions/open-url');
    return execute({ urlTemplate: step.urlTemplate, stepResults: priorResults });
  }
  throw new Error(`Unknown action type: "${step.action}"`);
}

/**
 * Get all available operations from specs
 */
function getAllOperations(specs) {
  const operations = [];

  for (const [api, spec] of Object.entries(specs)) {
    if (!spec.paths) continue;

    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          operations.push({
            api,
            path,
            method,
            operationId: operation.operationId,
            operation,
          });
        }
      }
    }
  }

  return operations;
}

module.exports = {
  generatePlan,
  executePlan,
  getAllOperations,
};
