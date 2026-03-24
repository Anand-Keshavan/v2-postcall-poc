/**
 * schema-plus-writer.js
 *
 * Builds a Schema++ YAML document from the original SDL and the analysis/enrichment data.
 * Output format matches specs/forge-schema-plus.yaml exactly.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('yaml');

/**
 * Build x-postcall-grounding for an operation using the grounding chain.
 * Schema++ grounding uses `variables:` (not `parameters:`).
 */
function buildGrounding(chain) {
  if (!chain) return null;

  // Build the variables map for the grounding step
  // searchVariables may be nested (e.g. { filter: { name: "{{intent.xxx}}" } })
  // We flatten it to a single-level variables object for the step
  const stepVariables = {};
  if (chain.searchVariables) {
    for (const [k, v] of Object.entries(chain.searchVariables)) {
      if (typeof v === 'object') {
        // Flatten nested: { filter: { name: "..." } } → filter.name=... isn't supported
        // Store as-is and let the executor handle it via template expansion
        stepVariables[k] = v;
      } else {
        stepVariables[k] = v;
      }
    }
  } else {
    // Simple case: resolver takes a single name arg
    const intentRef = `{{intent.${chain.intentParam}}}`;
    stepVariables[chain.filterField?.split('.').pop() || 'name'] = intentRef;
  }

  return {
    steps: [{
      operationId: chain.resolverOperationId,
      description: chain.description || `Resolve ${chain.intentParam} to ${chain.groundingParam}`,
      variables: stepVariables,
      extract: {
        [chain.groundingParam]: chain.extractPath,
      },
      required: chain.required !== false,
      error_message: chain.errorMessage || `Could not find a match for '{{intent.${chain.intentParam}}}'.`,
    }],
  };
}

/**
 * Build the Schema++ variables block for an operation.
 * Merges enrichment variables with grounding-derived variable source info.
 */
function buildVariables(enrichment, chain) {
  const vars = enrichment?.variables || {};

  // If grounding is present, ensure the grounded variable has source: grounding
  if (chain) {
    const groundedParam = chain.groundingParam;
    if (vars[groundedParam]) {
      vars[groundedParam] = { ...vars[groundedParam], source: 'grounding', groundingParam: groundedParam };
    }
  }

  return Object.keys(vars).length > 0 ? vars : {};
}

/**
 * Build a single Schema++ operation entry.
 */
function buildOperation(opSummary, enrichment, groundingChain) {
  const op = {
    type: 'query',
    summary: enrichment?.summary || opSummary.description || opSummary.operationId,
    description: enrichment?.description || opSummary.description || '',
  };

  // x-agent-guidance
  if (enrichment?.agentGuidance?.length > 0) {
    op['x-agent-guidance'] = enrichment.agentGuidance;
  }

  // x-postcall-entity-hints
  const hints = enrichment?.entityHints;
  if (hints && Object.keys(hints).length > 0) {
    op['x-postcall-entity-hints'] = hints;
  }

  // x-postcall-grounding
  if (groundingChain) {
    op['x-postcall-grounding'] = buildGrounding(groundingChain);
  }

  // graphql query document
  if (enrichment?.graphqlQuery) {
    op.graphql = enrichment.graphqlQuery;
  }

  // variables
  const variables = buildVariables(enrichment, groundingChain);
  op.variables = Object.keys(variables).length > 0 ? variables : {};

  // response
  op.response = {
    dataPath: enrichment?.responseDataPath || opSummary.operationId,
  };

  return op;
}

/**
 * Build the complete Schema++ document.
 */
function buildSchemaPlus(sdl, summaries, analysis, enrichments, apiTitle, serverUrl, apiName) {
  const groundingChains = analysis.groundingChains || {};

  // Build info block
  const info = {
    title: `${apiTitle} GraphQL API (Schema++)`,
    version: '1.0.0',
    description: `${apiTitle} GraphQL API annotated with PostCall Schema++ extensions for agent-ready natural language access.\n\nExtensions included:\n- x-postcall-auth-discovery: Authentication metadata\n- x-postcall-grounding: Resolver chains for ID resolution\n- x-agent-guidance: Natural language query seeds for RAG indexing\n`,
  };

  if (analysis.authDiscovery && analysis.authDiscovery.type !== 'none') {
    info['x-postcall-auth-discovery'] = analysis.authDiscovery;
  } else {
    info['x-postcall-auth-discovery'] = { type: 'none' };
  }

  if (analysis.provisioningUrl) {
    info['x-postcall-provisioning-url'] = analysis.provisioningUrl;
  }

  if (analysis.authNotes) {
    info['x-postcall-auth-notes'] = analysis.authNotes;
  }

  // Build operations map (preserving order: resolvers first, then consumers)
  const operations = {};
  for (const op of summaries) {
    const enrichment    = enrichments[op.operationId];
    const groundingChain = groundingChains[op.operationId];
    operations[op.operationId] = buildOperation(op, enrichment, groundingChain);
  }

  return {
    graphqlSchemaPlus: '1.0.0',
    info,
    server: {
      url: serverUrl,
      protocol: 'graphql',
    },
    schema: sdl,
    operations,
  };
}

/**
 * Write Schema++ YAML to the output directory.
 *
 * @param {string} sdl          - Original SDL string
 * @param {Array}  summaries    - From schema-loader
 * @param {Object} analysis     - From global-analyzer
 * @param {Object} enrichments  - From operation-enricher
 * @param {string} apiTitle     - Human-readable API name
 * @param {string} serverUrl    - GraphQL endpoint URL
 * @param {string} apiName      - Short machine name
 * @param {string} outputPath   - Full path to write output
 */
function writeSchemaPlusYaml(sdl, summaries, analysis, enrichments, apiTitle, serverUrl, apiName, outputPath) {
  const schemaPlus = buildSchemaPlus(sdl, summaries, analysis, enrichments, apiTitle, serverUrl, apiName);

  const yamlStr = yaml.stringify(schemaPlus, {
    lineWidth: 120,
    indent: 2,
    blockQuote: true,
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yamlStr, 'utf8');

  return outputPath;
}

module.exports = { writeSchemaPlusYaml, buildSchemaPlus };
