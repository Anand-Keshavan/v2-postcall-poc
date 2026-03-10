/**
 * Context-Aware Parameter Resolver (vector-search edition)
 *
 * Before running a grounding chain, the agent calls tryResolveFromContext().
 * It searches the in-memory vector store (context-store.js) for facts that
 * match the current query and can supply the parameters the grounding chain
 * would otherwise resolve via live API calls.
 *
 * This is entirely generic — no per-API logic anywhere.
 *
 * Algorithm
 * ---------
 * 1. For every (paramName, extractPath) pair in the grounding chain steps,
 *    determine which field to read from a matching fact item
 *    (e.g. "results[0].key" → field "key").
 *
 * 2. Build a search query from the current user intent values + the raw
 *    user query.  Intent values (entity names) are prepended because they
 *    provide the most specific signal.
 *
 * 3. Run semantic similarity search against all stored facts.
 *
 * 4. For each match (best-first), attempt to read the required field.
 *    Accept the first match that actually has a non-null value for the field.
 *
 * 5. If ALL grounding parameters are satisfied, return the resolved map.
 *    If ANY parameter cannot be found, return null so the caller falls back
 *    to the normal grounding chain.
 */

const { search, hasContext } = require('./context-store');

// ── Extract-path parsing ──────────────────────────────────────────────────────

/**
 * Parse an OAS++ grounding extract path into the dot-path within each item.
 *
 * Examples
 *   "results[0].key"       → "key"
 *   "users[0].id"          → "id"
 *   "items[0].owner.login" → "owner.login"
 *   "login"                → "login"
 */
function extractFieldPath(oasPath) {
  const match = oasPath.match(/^\w+\[\d+\]\.(.+)$/);
  return match ? match[1] : oasPath;
}

/**
 * Read a nested value from an object using dot notation.
 */
function getNestedValue(obj, dotPath) {
  return dotPath.split('.').reduce((cur, key) => cur?.[key], obj);
}

// ── Search query construction ─────────────────────────────────────────────────


/**
 * Build a TARGETED search query for a specific grounding step + param.
 *
 * Formula: "{resolverOperationId} {intentValues} {paramName}"
 *
 * The fact text is "{operationId} {collection}: field=val, ..." so prepending
 * the same operationId dramatically boosts cosine similarity (70-80% range).
 * Intent values (entity names like "Alice", "Engineering") anchor the search
 * to the right item within the result set.
 * The param name adds the field signal ("id", "key", "spaceKey", etc.).
 */
function buildSearchQuery(intent, stepOperationId, paramName) {
  const intentValues = Object.values(intent || {})
    .filter(v => typeof v === 'string' && v.trim().length > 0);

  return [stepOperationId, ...intentValues, paramName]
    .filter(Boolean)
    .join(' ');
}

// ── Main resolver ─────────────────────────────────────────────────────────────

/**
 * Attempt to satisfy all grounding parameters from the session context.
 *
 * @param {Object} grounding  – x-postcall-grounding block (with .steps)
 * @param {string} userQuery  – current user query
 * @param {Object} intent     – intent extracted by RAG
 * @returns {Promise<{params: Object, source: string}|null>}
 *   Resolved parameters, or null if the context cannot supply all of them.
 */
async function tryResolveFromContext(grounding, userQuery, intent) {
  if (!grounding?.steps?.length) return null;
  if (!hasContext()) return null;

  const resolvedParams = {};

  for (const step of grounding.steps) {
    if (!step.extract) continue;

    for (const [paramName, oasPath] of Object.entries(step.extract)) {
      const fieldPath = extractFieldPath(oasPath);

      // Build targeted query: "{resolverOperationId} {entityNames} {paramName}"
      // e.g. "searchUsers Alice user_id" or "listSpaces Engineering spaceKey"
      const searchQuery = buildSearchQuery(intent, step.operationId, paramName);

      console.log(`      → Context search: "${paramName}" via "${searchQuery}" (field: ${fieldPath})`);

      // Search the vector store for facts relevant to this query
      const matches = await search(searchQuery, 10);

      // Walk matches best-first; accept the first one that has the field
      // AND whose fact text contains at least one intent entity value.
      // This prevents "searchUsers Charlie" from matching an Alice fact.
      const intentValues = Object.values(intent || {})
        .filter(v => typeof v === 'string' && v.trim().length > 0);

      let resolved = false;
      for (const match of matches) {
        // Entity guard: if we have intent values, at least one must appear in
        // the fact text (case-insensitive).  Skips cross-entity false positives.
        if (intentValues.length > 0) {
          const factLower = match.text.toLowerCase();
          const entityMatch = intentValues.some(v => factLower.includes(v.toLowerCase()));
          if (!entityMatch) continue;
        }

        const value = getNestedValue(match.item, fieldPath);
        if (value !== undefined && value !== null) {
          resolvedParams[paramName] = value;
          console.log(
            `      ✓ ${paramName}=${value} ` +
            `(from ${match.operationId}, similarity ${(match.similarity * 100).toFixed(0)}%)`
          );
          resolved = true;
          break;
        }
      }

      if (!resolved) {
        console.log(`      ✗ ${paramName} not found in context — will use grounding chain`);
        return null; // one miss = fall back entirely
      }
    }
  }

  if (Object.keys(resolvedParams).length === 0) return null;

  return {
    params: resolvedParams,
    source: `session context (vector search)`,
  };
}

module.exports = { tryResolveFromContext };
