/**
 * Candidate Re-ranker
 *
 * After RAG retrieves the top-N candidates by vector similarity, this module
 * sends them to gpt-5.4 to re-order by true intent alignment — taking into
 * account named entities (person vs team vs project), parameter fit, and
 * operation semantics.  The model can also drop candidates that clearly
 * cannot fulfill the query.
 */

const axios = require('axios');

/**
 * Re-rank RAG candidates using gpt-5.4.
 *
 * @param {string} query       - Original user query
 * @param {Array}  candidates  - Top-N candidates from matchQueryTopN
 * @returns {Promise<Array>}   Re-ranked (and possibly filtered) candidates
 */
async function rerankCandidates(query, candidates) {
  if (candidates.length <= 1) return candidates;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return candidates;

  // Build a compact description of each candidate for the prompt
  const candidateDescriptions = candidates.map((c, i) => {
    const doc = c.documentation || {};
    const params = (doc.parameters || [])
      .map(p => `    • ${p.name}: ${p.description || p.name}`)
      .join('\n');
    return [
      `${i + 1}. operationId: ${c.operationId}  api: ${c.api}`,
      `   Summary: ${doc.summary || c.operationId}`,
      doc.description ? `   Description: ${doc.description}` : null,
      params ? `   Parameters:\n${params}` : null,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const prompt = `You are routing a user query to the best matching API operation.

User query: "${query}"

Candidate operations ranked by vector similarity:
${candidateDescriptions}

Your task:
1. Identify any named entities in the query (person names, team names, project names, products, locations, etc.)
2. Check whether each operation's parameters align with those entities
3. Re-order the candidates from best to worst match
4. Drop any candidate that clearly cannot fulfill the query

Respond with JSON:
{
  "ranked": [
    { "operationId": "...", "reason": "one-line explanation" }
  ],
  "dropped": [
    { "operationId": "...", "reason": "one-line explanation" }
  ]
}`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.4',
        messages: [
          {
            role: 'system',
            content: 'You route user queries to API operations based on intent and entity alignment. Respond only with valid JSON.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );

    const result = JSON.parse(response.data.choices[0].message.content);
    const ranked = result.ranked || [];
    const dropped = result.dropped || [];

    if (dropped.length > 0) {
      dropped.forEach(d => console.log(`        ✗ dropped  ${d.operationId}: ${d.reason}`));
    }
    ranked.forEach((r, i) =>
      console.log(`        ${i + 1}. ${r.operationId} — ${r.reason}`)
    );

    // Map operationIds back to original candidate objects (preserves all metadata)
    const reranked = ranked
      .map(r => candidates.find(c => c.operationId === r.operationId))
      .filter(Boolean);

    // Fall back to original order if the reranker returned nothing usable
    return reranked.length > 0 ? reranked : candidates;

  } catch (error) {
    console.log(`      ⚠ Re-ranker unavailable (${error.message}) — using original order`);
    return candidates;
  }
}

module.exports = { rerankCandidates };
