/**
 * oas-writer.js
 *
 * Merges OAS++ extensions into the original spec and writes the output YAML.
 * Preserves all original spec content — only injects new x-postcall-* fields.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('yaml');

/**
 * Build the x-postcall-grounding block for an operation from the grounding chain.
 */
function buildGrounding(chain) {
  if (!chain) return null;
  return {
    steps: [{
      operationId: chain.resolverOperationId,
      description: chain.description || `Resolve ${chain.intentParam} to ${chain.groundingParam}`,
      parameters: {
        [chain.searchParam || 'name']: `{{intent.${chain.intentParam}}}`,
      },
      extract: {
        [chain.groundingParam]: chain.extractPath,
      },
      required: chain.required !== false,
      error_message: chain.errorMessage || `Could not find a match for '{{intent.${chain.intentParam}}}'.`,
    }],
  };
}

/**
 * Build x-postcall-entity-hints from enrichment data and grounding chain.
 */
function buildEntityHints(enrichment, chain) {
  const hints = { ...(enrichment?.entityHints || {}) };
  // Ensure the grounding intent param is always represented
  if (chain?.intentParam && !hints[chain.intentParam]) {
    hints[chain.intentParam] = chain.entityHint || `The name of the ${chain.intentParam.replace(/_name$/, '')} to look up`;
  }
  return Object.keys(hints).length > 0 ? hints : null;
}

/**
 * Inject OAS++ extensions into a single operation object (mutates a clone).
 */
function injectOperationExtensions(op, operationId, enrichment, groundingChain) {
  const out = { ...op };

  // x-agent-guidance
  const guidance = enrichment?.agentGuidance;
  if (guidance?.length > 0) {
    out['x-agent-guidance'] = guidance;
  }

  // x-postcall-entity-hints
  const hints = buildEntityHints(enrichment, groundingChain);
  if (hints) {
    out['x-postcall-entity-hints'] = hints;
  }

  // x-postcall-grounding
  const grounding = buildGrounding(groundingChain);
  if (grounding) {
    out['x-postcall-grounding'] = grounding;
  }

  return out;
}

/**
 * Generate the same fallback operationId used by spec-loader when spec has none.
 */
function generatedOpId(method, pathStr) {
  return `${method}_${pathStr.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/**
 * Clone spec paths, injecting OAS++ extensions for each operation.
 */
function buildEnrichedPaths(spec, enrichments, groundingChains) {
  const paths = {};

  for (const [pathStr, pathItem] of Object.entries(spec.paths || {})) {
    paths[pathStr] = {};

    for (const [key, value] of Object.entries(pathItem)) {
      const method = key.toLowerCase();
      const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

      if (!HTTP_METHODS.includes(method)) {
        // Preserve path-level fields (parameters, summary, etc.)
        paths[pathStr][key] = value;
        continue;
      }

      const op = value;
      // Use spec's operationId, or fall back to the generated key from spec-loader
      const specOpId    = op.operationId;
      const generatedId = generatedOpId(method, pathStr);
      const opId        = specOpId || generatedId;

      const enrichment    = enrichments[specOpId]    || enrichments[generatedId]    || null;
      const groundingChain = groundingChains[specOpId] || groundingChains[generatedId] || null;

      const injected = injectOperationExtensions(op, opId, enrichment, groundingChain);

      // Inject operationId into output if spec didn't have one — makes OAS++ self-contained
      if (!injected.operationId) {
        injected.operationId = generatedId;
      }

      paths[pathStr][key] = injected;
    }
  }

  return paths;
}

/**
 * Build the full OAS++ spec by injecting all extensions into the original spec.
 */
function buildOasPlus(spec, analysis, enrichments) {
  const groundingChains = analysis.groundingChains || {};

  // Deep clone info and inject auth extensions
  const info = { ...spec.info };
  if (analysis.authDiscovery && Object.keys(analysis.authDiscovery).length > 0) {
    info['x-postcall-auth-discovery'] = analysis.authDiscovery;
  }
  if (analysis.provisioningUrl) {
    info['x-postcall-provisioning-url'] = analysis.provisioningUrl;
  }
  if (analysis.authNotes) {
    info['x-postcall-auth-notes'] = analysis.authNotes;
  }

  return {
    openapi: spec.openapi,
    info,
    ...(spec.externalDocs ? { externalDocs: spec.externalDocs } : {}),
    servers: spec.servers,
    tags: spec.tags,
    paths: buildEnrichedPaths(spec, enrichments, groundingChains),
    components: spec.components,
    security: spec.security,
    // Strip undefined top-level keys
  };
}

/**
 * Remove undefined/null values from a plain object (shallow).
 * YAML serializer handles deep nulls fine, but top-level undefined keys cause issues.
 */
function stripUndefined(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  );
}

/**
 * Write the OAS++ spec to the output directory.
 *
 * @param {Object} spec       - Original OAS spec
 * @param {Object} analysis   - From global-analyzer
 * @param {Object} enrichments - From operation-enricher (operationId → guidance/hints)
 * @param {string} outputPath - Full path to write output YAML
 */
function writeOasPlus(spec, analysis, enrichments, outputPath) {
  const oasPlus = stripUndefined(buildOasPlus(spec, analysis, enrichments));

  // Serialize with YAML, using block style and reasonable line width
  const yamlStr = yaml.stringify(oasPlus, {
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

module.exports = { writeOasPlus, buildOasPlus };
