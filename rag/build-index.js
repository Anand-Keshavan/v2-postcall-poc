/**
 * PostCall POC — Phase 4: Build RAG index from OAS++ spec(s).
 * Extracts x-agent-guidance and operation summaries into searchable chunks per operation.
 * Only indexes "primary" operations (those with x-agent-guidance), not resolver-only ops.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Load a single OAS++ spec and extract chunks for RAG.
 * Each chunk: { text, operationId, summary, pathTemplate, method }.
 */
function extractChunksFromSpec(spec, sourcePath = '') {
  const chunks = [];
  const paths = spec.paths || {};
  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem[method];
      if (!op || !op.operationId) continue;
      const guidance = op['x-agent-guidance'];
      const summary = op.summary || op.operationId;
      const isResolver =
        op.operationId.startsWith('find_') ||
        op.operationId.includes('lookup') ||
        op.operationId.includes('search');
      // Index primary operations (have guidance) or any operation that has at least summary for discovery
      const texts = new Set();
      if (Array.isArray(guidance) && guidance.length > 0) {
        guidance.forEach((g) => texts.add(g));
      }
      if (summary) texts.add(summary);
      if (texts.size === 0 && isResolver) continue;
      if (texts.size === 0) texts.add(op.operationId);
      for (const text of texts) {
        chunks.push({
          text,
          tokens: tokenize(text),
          operationId: op.operationId,
          summary,
          pathTemplate,
          method: method.toUpperCase(),
          source: sourcePath,
        });
      }
    }
  }
  return chunks;
}

/**
 * Build index from a specs directory (YAML/JSON files).
 */
function buildIndex(specsDir) {
  const dir = path.resolve(specsDir);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'));
  const allChunks = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    const raw = fs.readFileSync(filePath, 'utf8');
    let spec;
    try {
      spec = file.endsWith('.json') ? JSON.parse(raw) : yaml.parse(raw);
    } catch (e) {
      console.warn(`Skipping ${file}: parse error`, e.message);
      continue;
    }
    const chunks = extractChunksFromSpec(spec, file);
    allChunks.push(...chunks);
  }
  return {
    chunks: allChunks,
    tokenize,
  };
}

module.exports = { buildIndex, extractChunksFromSpec, tokenize };
