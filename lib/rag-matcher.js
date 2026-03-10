/**
 * RAG-based Operation Matcher using Pre-built Vector Index
 * Loads pre-built embeddings from disk for fast startup
 * Matches natural language queries to operations using semantic similarity
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Index storage
let operationIndex = [];
let indexLoaded = false;
let hasFullDocumentation = false;

const INDEX_PATH = path.join(__dirname, '../.rag-index.json');
const DOC_INDEX_PATH = path.join(__dirname, '../.rag-index-docs.json');

/**
 * Get OpenAI API key from environment
 */
function getOpenAIKey() {
  return process.env.OPENAI_API_KEY || null;
}

/**
 * Get embedding from OpenAI (only used for query embeddings at runtime)
 */
async function getEmbedding(text) {
  const apiKey = getOpenAIKey();

  if (!apiKey) {
    return null;
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/embeddings',
      {
        model: 'text-embedding-3-small',
        input: text,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data.data[0].embedding;
  } catch (error) {
    console.error('[RAG] OpenAI embedding error:', error.message);
    return null;
  }
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Load pre-built RAG index from disk
 * Tries documentation-aware index first, falls back to basic index
 */
function loadIndex() {
  if (indexLoaded) {
    return true;
  }

  // Try documentation-aware index first
  if (fs.existsSync(DOC_INDEX_PATH)) {
    try {
      const data = fs.readFileSync(DOC_INDEX_PATH, 'utf8');
      const indexData = JSON.parse(data);

      operationIndex = indexData.index || [];
      indexLoaded = true;
      hasFullDocumentation = indexData.has_full_documentation || false;

      console.log(`[RAG] ✓ Loaded documentation-aware index: ${operationIndex.length} entries`);
      console.log(`[RAG]   Created: ${new Date(indexData.created_at).toLocaleString()}`);
      console.log(`[RAG]   Operations: ${indexData.total_operations}, Queries: ${indexData.total_queries}`);
      console.log(`[RAG]   📚 Full API documentation included\n`);

      return true;
    } catch (error) {
      console.error('[RAG] Failed to load documentation-aware index:', error.message);
      // Fall through to try basic index
    }
  }

  // Fall back to basic index
  if (fs.existsSync(INDEX_PATH)) {
    try {
      const data = fs.readFileSync(INDEX_PATH, 'utf8');
      const indexData = JSON.parse(data);

      operationIndex = indexData.index || [];
      indexLoaded = true;
      hasFullDocumentation = false;

      console.log(`[RAG] ✓ Loaded index: ${operationIndex.length} entries`);
      console.log(`[RAG]   Created: ${new Date(indexData.created_at).toLocaleString()}`);
      console.log(`[RAG]   Operations: ${indexData.total_operations}, Queries: ${indexData.total_queries}`);
      console.log(`[RAG]   ⚠  Build documentation-aware index for better results:`);
      console.log(`[RAG]      node scripts/build-doc-aware-index.js\n`);

      return true;
    } catch (error) {
      console.error('[RAG] Failed to load index:', error.message);
      return false;
    }
  }

  // No index found
  console.log('[RAG] ⚠ No pre-built index found');
  console.log('[RAG]   Run: node scripts/build-doc-aware-index.js (recommended)');
  console.log('[RAG]   Or: node scripts/build-rag-index.js (basic)');
  console.log('[RAG]   Falling back to keyword matching\n');
  return false;
}

/**
 * Build index from specs (legacy fallback when no pre-built index)
 */
async function buildIndex(specs) {
  console.log('[RAG] Building index from specs (legacy fallback)...');
  operationIndex = [];

  for (const [api, spec] of Object.entries(specs)) {
    for (const [pathStr, pathItem] of Object.entries(spec.paths || {})) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (typeof operation !== 'object' || !operation.operationId) continue;

        const guidance = operation['x-agent-guidance'] || [];

        // Create entry for each guidance example
        for (const query of guidance) {
          operationIndex.push({
            query,
            embedding: null, // No embedding in fallback mode
            api,
            operationId: operation.operationId,
            path: pathStr,
            method: method.toUpperCase(),
            summary: operation.summary || '',
          });
        }
      }
    }
  }

  indexLoaded = true;
  console.log(`[RAG] Indexed ${operationIndex.length} entries (keyword matching only)\n`);
}

/**
 * Match query to operation using RAG
 */
/**
 * Convert a scored index entry into a match result object.
 */
function toMatchResult(entry, query) {
  return {
    api: entry.api,
    operationId: entry.operationId,
    path: entry.path,
    method: entry.method,
    confidence: entry.score,
    intent: extractIntent(query, entry.query),
    matchedQuery: entry.query,
    documentation: entry.documentation || null,
    hasDocumentation: !!entry.documentation,
  };
}

/**
 * Return the top-N distinct operations (by operationId) ranked by similarity.
 * Each unique operationId appears at most once, using its highest-scored entry.
 *
 * @param {string} query
 * @param {number} n      – how many candidates to return (default 3)
 * @returns {Promise<Array>} sorted match results (best first)
 */
async function matchQueryTopN(query, n = 3) {
  if (!indexLoaded) {
    throw new Error('Index not loaded. Call loadIndex() or buildIndex() first.');
  }

  if (operationIndex.length === 0) return [];

  const hasEmbeddings = operationIndex.some(op => op.embedding && op.embedding.length > 0);

  let scored = [];

  if (hasEmbeddings && getOpenAIKey()) {
    const queryEmbedding = await getEmbedding(query);
    if (queryEmbedding) {
      scored = operationIndex
        .filter(op => op.embedding)
        .map(op => ({ ...op, score: cosineSimilarity(queryEmbedding, op.embedding) }))
        .sort((a, b) => b.score - a.score);
    }
  }

  // Fallback to keyword scoring if no embeddings
  if (scored.length === 0) {
    const queryLower = query.toLowerCase();
    scored = operationIndex.map(op => {
      const queryWords = queryLower.split(/\s+/);
      const indexWords = op.query.toLowerCase().split(/\s+/).filter(w => !w.includes('{'));
      const matchCount = queryWords.filter(qw =>
        indexWords.some(iw => iw.includes(qw) || qw.includes(iw))
      ).length;
      return { ...op, score: matchCount / Math.max(queryWords.length, 1) };
    }).sort((a, b) => b.score - a.score);
  }

  // Deduplicate: keep the best score per operationId
  const seen = new Set();
  const topN = [];
  for (const entry of scored) {
    if (entry.score < 0.2) break;
    if (!seen.has(entry.operationId)) {
      seen.add(entry.operationId);
      topN.push(toMatchResult(entry, query));
      if (topN.length >= n) break;
    }
  }

  return topN;
}

async function matchQuery(query) {
  const results = await matchQueryTopN(query, 1);
  return results.length > 0 ? results[0] : null;
}

/**
 * Extract intent parameters from query
 */
function extractIntent(query, templateQuery) {
  const intent = {};
  const queryLower = query.toLowerCase();
  const templateLower = templateQuery.toLowerCase();

  // Extract parameters from template like "show issues in {repo_name}"
  const paramPattern = /\{(\w+)\}/g;
  let match;

  while ((match = paramPattern.exec(templateLower)) !== null) {
    const paramName = match[1];
    const paramPlaceholder = match[0];

    // Split template around the parameter
    const parts = templateLower.split(paramPlaceholder);
    const before = parts[0];
    const after = parts[1] || '';

    // Find the parameter value in the query
    let startIdx = queryLower.indexOf(before);
    if (startIdx !== -1) {
      startIdx += before.length;
      let endIdx = queryLower.length;

      if (after) {
        const afterIdx = queryLower.indexOf(after, startIdx);
        if (afterIdx !== -1) {
          endIdx = afterIdx;
        }
      }

      const value = query.substring(startIdx, endIdx).trim();
      if (value) {
        intent[paramName] = value;
      }
    }
  }

  return intent;
}

/**
 * Get index statistics
 */
function getIndexStats() {
  return {
    loaded: indexLoaded,
    entries: operationIndex.length,
    hasEmbeddings: operationIndex.some(op => op.embedding),
    hasFullDocumentation,
    apis: [...new Set(operationIndex.map(op => op.api))],
    operations: [...new Set(operationIndex.map(op => op.operationId))],
  };
}

module.exports = {
  loadIndex,
  buildIndex,
  matchQuery,
  matchQueryTopN,
  getOpenAIKey,
  getIndexStats,
};
