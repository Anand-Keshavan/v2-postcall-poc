/**
 * PostCall POC — Phase 4: Retrieve operation by natural language query.
 * Uses word-overlap scoring (no external embedding API). Optional: OPENAI_API_KEY for embeddings.
 */

const { buildIndex } = require('./build-index.js');

function cosineSimilarity(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0,
    normA = 0,
    normB = 0;
  for (const k of keys) {
    const va = a[k] || 0;
    const vb = b[k] || 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function termFreq(tokens) {
  const tf = {};
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }
  return tf;
}

/**
 * Score query against chunks using word-overlap (TF cosine similarity).
 */
function scoreChunks(queryTokens, chunks) {
  const queryTf = termFreq(queryTokens);
  return chunks.map((chunk) => {
    const score = cosineSimilarity(queryTf, termFreq(chunk.tokens));
    return { ...chunk, score };
  });
}

/**
 * Retrieve top-k operations for a natural language query.
 * Returns [{ operationId, score, summary, pathTemplate, method, matched_text }, ...]
 * Deduplicated by operationId (best score per operation).
 */
function retrieve(index, query, topK = 5) {
  const queryTokens = index.tokenize(query);
  if (queryTokens.length === 0) return [];
  const scored = scoreChunks(queryTokens, index.chunks);
  scored.sort((a, b) => b.score - a.score);
  const byOp = new Map();
  for (const c of scored) {
    if (!byOp.has(c.operationId) && c.score > 0) {
      byOp.set(c.operationId, {
        operationId: c.operationId,
        score: c.score,
        summary: c.summary,
        pathTemplate: c.pathTemplate,
        method: c.method,
        matched_text: c.text,
      });
    }
  }
  return Array.from(byOp.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

module.exports = { retrieve, scoreChunks, cosineSimilarity };
