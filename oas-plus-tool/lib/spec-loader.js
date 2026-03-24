/**
 * spec-loader.js
 *
 * Loads an OAS 3.x spec from YAML or JSON, resolves $ref references inline,
 * and returns a normalized spec object ready for analysis.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('yaml');

/**
 * Resolve a single $ref string against the spec's components.
 * Only resolves local refs (#/components/...).
 * Returns the referenced object, or null if not found.
 */
function resolveRef(ref, spec) {
  if (!ref || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let node = spec;
  for (const part of parts) {
    if (node == null || typeof node !== 'object') return null;
    node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node ?? null;
}

/**
 * Recursively resolve $refs in an object (shallow enough for our purposes).
 * Avoids circular loops via a depth limit.
 */
function deepResolve(obj, spec, depth = 0) {
  if (depth > 6 || obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => deepResolve(item, spec, depth + 1));

  if (obj.$ref) {
    const resolved = resolveRef(obj.$ref, spec);
    if (resolved) return deepResolve({ ...resolved }, spec, depth + 1);
    return obj;
  }

  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = deepResolve(v, spec, depth + 1);
  }
  return result;
}

/**
 * Extract top-level property names from a JSON schema object.
 * Handles allOf/oneOf/anyOf by merging.
 */
function schemaFieldNames(schema, spec, depth = 0) {
  if (!schema || depth > 3) return [];

  // Resolve ref
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, spec);
    return resolved ? schemaFieldNames(resolved, spec, depth + 1) : [];
  }

  // Merge allOf / oneOf / anyOf
  const combined = [...(schema.allOf || []), ...(schema.oneOf || []), ...(schema.anyOf || [])];
  if (combined.length > 0) {
    return [...new Set(combined.flatMap(s => schemaFieldNames(s, spec, depth + 1)))];
  }

  if (schema.type === 'array' && schema.items) {
    return schemaFieldNames(schema.items, spec, depth + 1);
  }

  if (schema.properties) {
    return Object.keys(schema.properties);
  }

  return [];
}

/**
 * Extract a condensed summary of all operations from the spec.
 * Returns an array of operation summary objects suitable for the OpenAI prompt.
 */
function extractOperationSummaries(spec) {
  const summaries = [];
  const paths = spec.paths || {};

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem[method];
      if (!op) continue;

      // Parameters: path + query only (most relevant for grounding)
      const params = (op.parameters || []).map(p => {
        const resolved = p.$ref ? resolveRef(p.$ref, spec) : p;
        if (!resolved) return null;
        const type = resolved.schema?.type || resolved.schema?.$ref?.split('/').pop() || 'string';
        return {
          name: resolved.name,
          in: resolved.in,
          required: !!resolved.required,
          type,
        };
      }).filter(Boolean);

      // Response 200 top-level field names
      const resp200 = op.responses?.['200'] || op.responses?.['201'];
      let responseFields = [];
      if (resp200) {
        const content = resp200.content?.['application/json']?.schema
                     || resp200.content?.['application/vnd.api.v10+json']?.schema;
        if (content) responseFields = schemaFieldNames(content, spec);
      }

      summaries.push({
        method: method.toUpperCase(),
        path: pathStr,
        operationId: op.operationId || `${method}_${pathStr.replace(/[^a-zA-Z0-9]/g, '_')}`,
        summary: op.summary || '',
        description: (op.description || '').slice(0, 200),
        tags: op.tags || [],
        params,
        responseFields,
      });
    }
  }

  return summaries;
}

/**
 * Load and parse an OAS 3.x spec file (YAML or JSON).
 *
 * @param {string} filePath - Absolute or relative path to spec file
 * @returns {{ spec: Object, summaries: Array, apiName: string }}
 */
function loadSpec(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`Spec file not found: ${abs}`);

  const raw = fs.readFileSync(abs, 'utf8');
  const ext = path.extname(abs).toLowerCase();

  let spec;
  if (ext === '.json') {
    spec = JSON.parse(raw);
  } else {
    spec = yaml.parse(raw);
  }

  if (!spec.openapi && !spec.swagger) {
    throw new Error(`File does not appear to be an OpenAPI spec: ${abs}`);
  }

  const summaries = extractOperationSummaries(spec);
  const apiName = path.basename(abs, ext)
    .replace(/-oas.*$/, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .toLowerCase();

  return { spec, summaries, apiName, filePath: abs };
}

module.exports = { loadSpec, resolveRef, schemaFieldNames, extractOperationSummaries };
