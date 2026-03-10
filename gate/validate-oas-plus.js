#!/usr/bin/env node
/**
 * PostCall POC: OAS++ Validation Gate
 * Rejects specs missing required PostCall extensions and mandatory OpenAPI fields.
 * Usage: node validate-oas-plus.js <path-to-openapi.yaml|json>
 */

const fs = require('fs');
const path = require('path');

function loadSpec(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.json')) return JSON.parse(raw);
  // Minimal YAML parse for demo (in production use 'yaml' or 'js-yaml')
  const yaml = require('yaml');
  return yaml.parse(raw);
}

function validateOASPlus(spec) {
  const errors = [];

  // --- Top-level OAS++ extensions ---
  if (!spec['x-postcall-auth-discovery'] && !spec['x-postcall-provisioning-url']) {
    errors.push('Missing auth discovery: require x-postcall-auth-discovery or x-postcall-provisioning-url');
  }

  // --- Per-path validation ---
  const paths = spec.paths || {};
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    const methods = ['get', 'post', 'put', 'patch', 'delete'];
    for (const method of methods) {
      const op = pathItem[method];
      if (!op) continue;

      const opId = op.operationId || `${method} ${pathKey}`;

      // Required: operationId
      if (!op.operationId) {
        errors.push(`Path ${method.toUpperCase()} ${pathKey}: missing operationId`);
      }

      // Parameters that are path/query required must have examples or schema with example
      const params = op.parameters || [];
      const hasAnyGrounding = params.some((p) => p['x-postcall-grounding']);
      for (const p of params) {
        if (p.required && (p.in === 'path' || p.in === 'query')) {
          const hasExample = p.example !== undefined || (p.schema && p.schema.example !== undefined);
          if (!hasExample) {
            errors.push(`Path ${method.toUpperCase()} ${pathKey} parameter "${p.name}": required parameter must have example (or schema.example)`);
          }
          // Path IDs in non-resolver operations should have grounding (or at least one param in the op has a chain)
          if (p.in === 'path' && p.name && (p.name.endsWith('Id') || p.name.endsWith('id'))) {
            const isResolverPath = pathKey.includes('lookup') || pathKey.includes('search');
            if (!isResolverPath && !p['x-postcall-grounding'] && !hasAnyGrounding) {
              errors.push(`Path ${method.toUpperCase()} ${pathKey} parameter "${p.name}": path ID should have x-postcall-grounding for agent resolution (or document as lookup endpoint)`);
            }
          }
        }
      }

      // Primary operations (non-resolver): recommend agent guidance
      const isResolver = op.operationId && (op.operationId.includes('find_') || op.operationId.includes('lookup') || op.operationId.includes('search'));
      if (!isResolver && !(op['x-agent-guidance'] && op['x-agent-guidance'].length > 0)) {
        errors.push(`Path ${method.toUpperCase()} ${pathKey}: non-resolver operation should have x-agent-guidance (array of example queries)`);
      }
    }
  }

  return errors;
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node validate-oas-plus.js <path-to-openapi.yaml|json>');
    process.exit(2);
  }
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error('File not found:', absPath);
    process.exit(1);
  }

  let spec;
  try {
    spec = loadSpec(absPath);
  } catch (e) {
    console.error('Failed to parse spec:', e.message);
    process.exit(1);
  }

  const errors = validateOASPlus(spec);
  if (errors.length > 0) {
    console.error('Validation FAILED (OAS++ gate):');
    errors.forEach((e) => console.error('  -', e));
    process.exit(1);
  }

  console.log('Validation PASSED: spec is agent-ready (OAS++).');
}

main();
