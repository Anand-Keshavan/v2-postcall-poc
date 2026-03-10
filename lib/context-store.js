/**
 * Session Context Vector Store
 *
 * Replaces the flat text accumulator in session-context.js.
 *
 * When any API response arrives, it is "exploded" into individual facts —
 * one fact per array item found anywhere in the response body.  Each fact is
 * a human-readable string (e.g. "listSpaces results: id=123, key=ENG, name=Engineering")
 * that is immediately embedded with text-embedding-3-small and stored in memory.
 *
 * At query time, the caller embeds a search string and does cosine-similarity
 * lookup against all stored facts.  The raw `item` object is returned so the
 * caller can extract whichever field it needs via a dot-path.
 *
 * This is completely generic — it works for any API without any per-API config.
 */

const axios = require('axios');

// ── Internal storage ──────────────────────────────────────────────────────────

const _facts = []; // { text, embedding, item, collectionName, operationId, api }

const SIMILARITY_THRESHOLD = 0.50; // minimum score to consider a fact relevant
const MAX_FACTS = 500;             // hard cap to avoid unbounded memory growth

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── OpenAI embedding ──────────────────────────────────────────────────────────

async function batchEmbed(texts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || texts.length === 0) return texts.map(() => null);

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/embeddings',
      { model: 'text-embedding-3-small', input: texts },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );
    // API guarantees results are in the same order as input (sorted by index)
    return response.data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  } catch (err) {
    console.warn(`[ContextStore] Batch embedding failed: ${err.message}`);
    return texts.map(() => null);
  }
}

// ── Fact extraction ───────────────────────────────────────────────────────────

/**
 * Recursively walk a response body and collect every array collection found
 * at the top level or one level deep.
 *
 * Returns [{ collectionName, items }]
 */
function findCollections(data) {
  const collections = [];

  if (Array.isArray(data)) {
    // The whole response is an array (e.g. GitHub listUserRepos)
    collections.push({ collectionName: 'items', items: data });
    return collections;
  }

  if (data && typeof data === 'object') {
    for (const [key, val] of Object.entries(data)) {
      if (Array.isArray(val) && val.length > 0) {
        collections.push({ collectionName: key, items: val });
      }
    }

    // Also store the top-level object itself as a single fact
    // (handles single-entity responses like getAuthenticatedUser)
    const scalarFields = Object.entries(data)
      .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object');
    if (scalarFields.length > 0 && collections.length === 0) {
      // Only create a top-level fact if there are no arrays
      collections.push({ collectionName: 'result', items: [data] });
    }
  }

  return collections;
}

/**
 * Turn a single array item into a descriptive fact string.
 * Only uses scalar (non-object) fields to keep the text clean.
 */
function itemToFactText(operationId, collectionName, item) {
  const pairs = Object.entries(item)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object' && typeof v !== 'function')
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ');

  return `${operationId} ${collectionName}: ${pairs}`;
}

/**
 * Explode an API response into individual embeddable facts.
 */
function extractFacts(api, operationId, sourceQuery, data) {
  const facts = [];
  const collections = findCollections(data);

  for (const { collectionName, items } of collections) {
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;

      const text = itemToFactText(operationId, collectionName, item);
      if (!text.includes('=')) continue; // no scalar fields found — skip

      facts.push({
        text,
        item,
        collectionName,
        operationId,
        api,
        sourceQuery,
        embedding: null,
      });
    }
  }

  return facts;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Store an API response in the context vector store.
 * Explodes the response into facts and embeds them in one batch call.
 *
 * @param {string} api
 * @param {string} operationId
 * @param {string} query        – original user query that triggered this call
 * @param {any}    data         – raw response body
 */
async function addResult(api, operationId, query, data) {
  const facts = extractFacts(api, operationId, query, data);
  if (facts.length === 0) return;

  const texts = facts.map(f => f.text);
  const embeddings = await batchEmbed(texts);

  let stored = 0;
  facts.forEach((fact, i) => {
    if (embeddings[i]) {
      _facts.push({ ...fact, embedding: embeddings[i] });
      stored++;
    }
  });

  // Trim to cap
  if (_facts.length > MAX_FACTS) {
    _facts.splice(0, _facts.length - MAX_FACTS);
  }

  console.log(`[ContextStore] +${stored} facts from ${operationId} (total: ${_facts.length})`);
}

/**
 * Semantic search across all stored facts.
 *
 * @param {string} queryText   – natural language query to embed and compare
 * @param {number} n           – return at most n results
 * @returns {Promise<Array<{text, item, collectionName, operationId, api, similarity}>>}
 */
async function search(queryText, n = 5) {
  const embedded = _facts.filter(f => f.embedding);
  if (embedded.length === 0) return [];

  const [queryEmbedding] = await batchEmbed([queryText]);
  if (!queryEmbedding) return [];

  return embedded
    .map(f => ({ ...f, similarity: cosineSimilarity(queryEmbedding, f.embedding) }))
    .filter(f => f.similarity >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, n);
}

function hasContext() {
  return _facts.some(f => f.embedding);
}

function clear() {
  _facts.length = 0;
}

function getFactCount() {
  return _facts.length;
}

module.exports = { addResult, search, hasContext, clear, getFactCount };
