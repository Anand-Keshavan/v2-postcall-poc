/**
 * Grounding Chain Auto-Detector
 *
 * Analyzes an OAS spec at ingestion/startup time to detect grounding chains for
 * every *_id parameter (path or required query).
 *
 * Algorithm:
 * 1. Scan all GET endpoints that accept a plain `name` parameter.
 * 2. For each such endpoint, inspect the 200 response schema for array properties
 *    whose items have an `id` field.  Register: entityType_id → resolver info.
 * 3. For each operation that has *_id params (or a generic `{id}` path param),
 *    look up the resolver and inject an `x-postcall-grounding` block.
 *
 * Rules:
 * - Only injects grounding where none already exists (manual spec grounding wins).
 * - Only handles simple name→id resolutions (endpoints with `name` param).
 *   Complex patterns (CQL, multi-step, body params) remain in the spec manually.
 */

/**
 * Resolve a $ref to its actual schema object within the spec.
 */
function resolveRef(schema, spec) {
  if (!schema || typeof schema !== 'object') return schema;
  if (!schema.$ref) return schema;

  const parts = schema.$ref.replace(/^#\//, '').split('/');
  let node = spec;
  for (const p of parts) {
    node = node?.[p];
  }
  return node;
}

/**
 * Simple English singularizer for common REST collection names.
 *   "users"      → "user"
 *   "categories" → "category"
 *   "products"   → "product"
 *   "reviews"    → "review"
 *   "orders"     → "order"
 */
function singularize(word) {
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Build a map from entity_id param name → resolver info, by scanning every
 * GET endpoint in the spec that has a `name` query parameter and returns
 * an array collection whose items carry an `id` field.
 *
 * @param {Object} spec - OpenAPI spec
 * @returns {Object} resolvers map  { "user_id": { operationId, nameParam, extractPath, entityType, intentParamName }, ... }
 */
function buildResolverMap(spec) {
  const resolvers = {};

  for (const [pathStr, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (method !== 'get' || !operation.operationId) continue;

      // Must have a plain `name` parameter (simple resolvers only)
      const nameParam = (operation.parameters || []).find(p => p.name === 'name');
      if (!nameParam) continue;

      // Get the 200 response JSON schema
      const contentSchema = operation.responses?.['200']?.content?.['application/json']?.schema;
      if (!contentSchema) continue;

      const schema = resolveRef(contentSchema, spec);
      if (!schema || schema.type !== 'object' || !schema.properties) continue;

      // Find array properties whose items have an `id` field
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        const resolved = resolveRef(propSchema, spec);
        if (!resolved || resolved.type !== 'array') continue;

        const itemSchema = resolveRef(resolved.items, spec);
        if (!itemSchema?.properties?.id) continue;

        // Derive entity type: "users" → "user"
        const entityType = singularize(propName);
        const paramName = `${entityType}_id`;

        resolvers[paramName] = {
          operationId: operation.operationId,
          nameParam: 'name',
          extractPath: `${propName}[0].id`,
          entityType,
          intentParamName: `${entityType}_name`,
        };
      }
    }
  }

  return resolvers;
}

/**
 * For a generic `{id}` path parameter, derive the entity type from the
 * path segment immediately preceding it.
 *
 *   /users/{id}                  → "user"
 *   /wiki/rest/api/content/{id}  → "content"
 *   /products/{id}               → "product"
 */
function entityFromPathContext(pathStr, paramName) {
  const segments = pathStr.split('/');
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] === `{${paramName}}`) {
      for (let j = i - 1; j >= 0; j--) {
        const seg = segments[j];
        if (seg && !seg.startsWith('{') && !/^\d+$/.test(seg)) {
          return singularize(seg.toLowerCase());
        }
      }
    }
  }
  return null;
}

/**
 * Collect all path + required-query parameters from an operation that look
 * like they need grounding (name ends with `_id`, or is the bare word `id`).
 *
 * Returns an array of { param, resolverKey } where resolverKey is the key to
 * look up in the resolver map.
 */
function collectIdParams(operation, pathStr) {
  const result = [];

  for (const param of operation.parameters || []) {
    if (param.in !== 'path' && !(param.in === 'query' && param.required)) continue;

    if (param.name.endsWith('_id')) {
      // e.g. "user_id" → resolver key "user_id"
      result.push({ param, resolverKey: param.name });
    } else if (param.name === 'id') {
      // Generic "id" — derive entity from path context
      const entity = entityFromPathContext(pathStr, 'id');
      if (entity) {
        result.push({ param, resolverKey: `${entity}_id` });
      }
    }
  }

  return result;
}

/**
 * Detect and inject `x-postcall-grounding` for every detectable *_id param
 * in the spec.  Mutates the spec object in-place.
 *
 * Operations that already have a manually-authored `x-postcall-grounding` are
 * left untouched.
 *
 * @param {Object} spec - OpenAPI spec (mutated in-place)
 * @returns {{ detected: string[], skipped: string[], noResolver: string[] }} report
 */
function detectAndInjectGrounding(spec) {
  const report = { detected: [], skipped: [], noResolver: [] };

  const resolvers = buildResolverMap(spec);

  if (Object.keys(resolvers).length === 0) {
    return report; // no simple name→id resolvers in this spec
  }

  for (const [pathStr, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      if (!operation.operationId) continue;

      // Respect manually-authored grounding
      if (operation['x-postcall-grounding']) {
        report.skipped.push(operation.operationId);
        continue;
      }

      const idParams = collectIdParams(operation, pathStr);
      if (idParams.length === 0) continue;

      const steps = [];

      for (const { param, resolverKey } of idParams) {
        const resolver = resolvers[resolverKey];
        if (!resolver) {
          report.noResolver.push(`${operation.operationId}:${param.name}`);
          continue;
        }

        steps.push({
          operationId: resolver.operationId,
          description: `Find ${resolver.entityType} by name`,
          parameters: {
            [resolver.nameParam]: `{{intent.${resolver.intentParamName}}}`,
          },
          extract: {
            [param.name]: resolver.extractPath,
          },
        });
      }

      if (steps.length > 0) {
        operation['x-postcall-grounding'] = { steps };
        report.detected.push(
          `${operation.operationId}: [${steps.map(s => `${s.operationId}→${Object.keys(s.extract)[0]}`).join(', ')}]`
        );
      }
    }
  }

  return report;
}

module.exports = { detectAndInjectGrounding, buildResolverMap };
