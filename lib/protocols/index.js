/**
 * Protocol Plugin Registry
 *
 * Protocols are plug-ins that handle a specific transport/query language.
 * Each plugin must implement:
 *
 *   name: string                         — unique identifier (e.g. 'http', 'graphql')
 *   detect(spec, schemaSpec): boolean    — returns true when this plugin owns the spec pair
 *   executeStep({ step, client, intent, userQuery, specs, schemaSpecs })
 *                             : Promise<{ operationId, data }>
 *
 * To add a new protocol, create lib/protocols/<name>-protocol.js and call
 * register(require('./<name>-protocol')) at the bottom of this file.
 */

const registry = [];

function register(plugin) {
  registry.push(plugin);
}

/**
 * Return the plugin that handles the given spec pair.
 * @throws if no registered plugin matches.
 */
function forSpec(spec, schemaSpec) {
  const plugin = registry.find(p => p.detect(spec, schemaSpec));
  if (!plugin) {
    const name = spec?.info?.title || schemaSpec?.info?.title || 'unknown';
    throw new Error(`No protocol plugin registered for spec: "${name}"`);
  }
  return plugin;
}

module.exports = { register, forSpec };

// ── Register built-in protocol plugins ───────────────────────────────────────
// Order matters: more specific detectors should come first.
// GraphQL checks for schemaSpec, HTTP checks for spec — both can coexist.
register(require('./graphql-protocol'));
register(require('./http-protocol'));
