/**
 * Action: open-url
 *
 * Opens one or more URLs derived from prior step results in the system browser.
 *
 * Step definition fields:
 *   urlTemplate  – path expression into stepResults, e.g.:
 *                    "steps[0].data._links.webui"          single URL
 *                    "steps[0].data.results[*]._links.webui" all results
 */

const { exec } = require('child_process');
const { link } = require('../terminal-link');

/**
 * Walk an object by dot-path (handles array[N] indexing).
 * Examples: "data.results", "data._links.base", "data.results[0].title"
 */
function getByPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((cur, key) => {
    if (cur == null) return null;
    const arrMatch = key.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) return cur[arrMatch[1]]?.[parseInt(arrMatch[2])];
    return cur[key];
  }, obj);
}

/**
 * Resolve a urlTemplate against the stepResults array.
 * Returns { urls: string[], stepIndex: number|null }
 *
 * Template format:
 *   steps[N].data.<path>          – single value
 *   steps[N].data.<path>[*].<sub> – array wildcard: collect sub-field from each item
 */
function resolveTemplate(template, stepResults) {
  const match = template.match(/^steps\[(\d+)\]\.(.+)$/);
  if (!match) return { urls: [], stepIndex: null };

  const stepIndex = parseInt(match[1]);
  const pathExpr = match[2]; // e.g. "data.results[*]._links.webui"

  const stepResult = stepResults[stepIndex];
  if (!stepResult) return { urls: [], stepIndex };

  const wildcardIdx = pathExpr.indexOf('[*]');
  let urls;

  if (wildcardIdx !== -1) {
    const arrayPath = pathExpr.slice(0, wildcardIdx);             // "data.results"
    const rest = pathExpr.slice(wildcardIdx + 3);                 // "._links.webui" or ""
    const itemPath = rest.startsWith('.') ? rest.slice(1) : rest; // "_links.webui"

    const array = getByPath(stepResult, arrayPath);
    if (!Array.isArray(array)) return { urls: [], stepIndex };
    urls = array
      .map(item => (itemPath ? getByPath(item, itemPath) : item))
      .filter(Boolean);
  } else {
    const val = getByPath(stepResult, pathExpr);
    urls = val ? [val] : [];
  }

  return { urls, stepIndex };
}

/**
 * Open one or more URLs in the system default browser.
 *
 * @param {Object} opts
 * @param {string}   opts.urlTemplate  - path expression (see module header)
 * @param {Array}    opts.stepResults  - accumulated results from reasoning-planner
 */
async function execute({ urlTemplate, stepResults }) {
  if (!urlTemplate) {
    console.log(`      ⚠ open-url: no urlTemplate provided`);
    return { opened: [] };
  }

  const { urls, stepIndex } = resolveTemplate(urlTemplate, stepResults);

  if (urls.length === 0) {
    console.log(`      ⚠ open-url: could not resolve URLs from template: ${urlTemplate}`);
    return { opened: [] };
  }

  // For relative paths, auto-discover base URL from the same step's response
  // (e.g. Confluence _links.base, or any API that returns a base in _links)
  const base = stepIndex !== null
    ? stepResults[stepIndex]?.data?._links?.base ?? null
    : null;

  const openCmd = process.platform === 'darwin' ? 'open'
                : process.platform === 'win32'   ? 'start'
                : 'xdg-open';

  const opened = [];
  for (const url of urls) {
    const fullUrl = url.startsWith('http') ? url
                  : base                   ? `${base}${url}`
                  : url;

    if (!fullUrl.startsWith('http')) {
      console.log(`      ⚠ Could not build absolute URL for: ${url}`);
      continue;
    }

    console.log(`      → Opening: ${link(fullUrl)}`);
    exec(`${openCmd} "${fullUrl}"`);
    opened.push(fullUrl);
  }

  return { opened };
}

module.exports = { execute };
