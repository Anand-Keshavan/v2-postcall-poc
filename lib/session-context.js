/**
 * Session Context Manager
 *
 * Maintains an in-memory store of all API results produced during the current
 * agent session.  Before running a grounding chain, the planner checks this
 * store first — if the required IDs are already present, the extra look-up
 * round-trips are skipped entirely.
 *
 * Each entry stores:
 *   operationId  – which operation produced the data
 *   api          – which API (github / confluence / nile / …)
 *   query        – the natural-language query that triggered the call
 *   data         – the raw response body
 *   timestamp    – when it was added
 */

const MAX_ENTRIES = 20; // keep the 20 most recent results

const _entries = [];

/**
 * Add an API result to the session context.
 * @param {string} api
 * @param {string} operationId
 * @param {string} query        – the user query that produced this result
 * @param {any}    data         – response body
 */
function addResult(api, operationId, query, data) {
  _entries.push({ api, operationId, query, data, timestamp: Date.now() });

  // Keep only the most recent MAX_ENTRIES entries
  if (_entries.length > MAX_ENTRIES) {
    _entries.splice(0, _entries.length - MAX_ENTRIES);
  }
}

/**
 * Return a snapshot of all session entries (newest last).
 */
function getEntries() {
  return [..._entries];
}

/**
 * Return true when the context is non-empty.
 */
function hasContext() {
  return _entries.length > 0;
}

/**
 * Clear all entries (e.g. when the user resets).
 */
function clear() {
  _entries.length = 0;
}

/**
 * Format context entries for inclusion in an OpenAI prompt.
 * Large response bodies are truncated to keep the prompt size manageable.
 */
function formatForPrompt() {
  if (_entries.length === 0) return 'No prior API results in this session.';

  return _entries.map((e, i) => {
    const preview = JSON.stringify(e.data);
    const body = preview.length > 600 ? preview.slice(0, 600) + '… (truncated)' : preview;
    return [
      `[Result ${i + 1}]`,
      `  API: ${e.api}  Operation: ${e.operationId}`,
      `  Query that produced this: "${e.query}"`,
      `  Response: ${body}`,
    ].join('\n');
  }).join('\n\n');
}

module.exports = { addResult, getEntries, hasContext, clear, formatForPrompt };
