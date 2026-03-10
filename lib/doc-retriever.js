/**
 * Documentation Retrieval System
 *
 * Retrieves comprehensive API documentation for operations.
 * The documentation includes:
 * - Complete parameter descriptions with constraints
 * - Request/response schemas
 * - Examples
 * - Security requirements
 * - Special extensions (OAS++)
 */

/**
 * Retrieve full documentation for an operation
 *
 * @param {string} api - API name (e.g., 'github')
 * @param {string} operationId - Operation ID
 * @param {Object} indexEntry - Entry from RAG index (if available)
 * @returns {Object} Complete documentation object
 */
function retrieveDocumentation(api, operationId, indexEntry = null) {
  // If index entry has documentation, return it
  if (indexEntry && indexEntry.documentation) {
    return indexEntry.documentation;
  }

  // Fallback: basic documentation (shouldn't happen with doc-aware index)
  return {
    api,
    operationId,
    summary: indexEntry?.summary || '',
    description: '',
    parameters: [],
    responses: {},
    examples: [],
    extensions: {},
    security: [],
  };
}

/**
 * Format documentation for display to user or AI
 *
 * @param {Object} doc - Documentation object
 * @param {string} format - 'human' or 'ai'
 * @returns {string} Formatted documentation
 */
function formatDocumentation(doc, format = 'ai') {
  if (format === 'human') {
    return formatForHuman(doc);
  } else {
    return formatForAI(doc);
  }
}

/**
 * Format documentation for AI consumption (OpenAI prompts)
 */
function formatForAI(doc) {
  let text = '';

  // Basic info
  text += `API: ${doc.api}\n`;
  text += `Operation: ${doc.operationId}\n`;
  text += `Endpoint: ${doc.method} ${doc.path}\n\n`;

  if (doc.summary) {
    text += `Summary: ${doc.summary}\n`;
  }

  if (doc.description) {
    text += `Description: ${doc.description}\n\n`;
  }

  // Parameters
  if (doc.parameters && doc.parameters.length > 0) {
    text += `Parameters:\n`;

    doc.parameters.forEach(param => {
      text += `\n- ${param.name} (${param.in})${param.required ? ' [REQUIRED]' : ' [OPTIONAL]'}\n`;

      if (param.description) {
        text += `  Description: ${param.description}\n`;
      }

      if (param.schema) {
        if (param.schema.type) {
          text += `  Type: ${param.schema.type}`;
          if (param.schema.format) text += ` (${param.schema.format})`;
          text += '\n';
        }

        if (param.schema.enum) {
          text += `  Allowed values: ${param.schema.enum.join(', ')}\n`;
        }

        if (param.schema.pattern) {
          text += `  Pattern: ${param.schema.pattern}\n`;
        }

        if (param.schema.minimum !== undefined) {
          text += `  Minimum: ${param.schema.minimum}\n`;
        }

        if (param.schema.maximum !== undefined) {
          text += `  Maximum: ${param.schema.maximum}\n`;
        }

        if (param.schema.default !== undefined) {
          text += `  Default: ${param.schema.default}\n`;
        }
      }

      if (param.example) {
        text += `  Example: ${param.example}\n`;
      }
    });

    text += '\n';
  } else {
    text += 'Parameters: None\n\n';
  }

  // Request body
  if (doc.requestBody && doc.requestBody.required) {
    text += `Request Body: Required\n`;
    if (doc.requestBody.description) {
      text += `  ${doc.requestBody.description}\n`;
    }
    text += '\n';
  }

  // Examples
  if (doc.examples && doc.examples.length > 0) {
    text += `Examples:\n`;
    doc.examples.forEach(ex => {
      if (ex.type === 'query') {
        text += `  Query: "${ex.value}"\n`;
      } else if (ex.type === 'parameter') {
        text += `  ${ex.name}: ${ex.value}\n`;
      }
    });
    text += '\n';
  }

  // Special guidance from OAS++
  if (doc.extensions && doc.extensions.agentGuidance && doc.extensions.agentGuidance.length > 0) {
    text += `Agent Guidance (example queries):\n`;
    doc.extensions.agentGuidance.forEach(guidance => {
      text += `  - "${guidance}"\n`;
    });
    text += '\n';
  }

  // Response information
  if (doc.responses && Object.keys(doc.responses).length > 0) {
    text += `Expected Responses:\n`;
    Object.entries(doc.responses).forEach(([code, response]) => {
      text += `  ${code}: ${response.description}\n`;
    });
    text += '\n';
  }

  return text;
}

/**
 * Format documentation for human display
 */
function formatForHuman(doc) {
  let text = '';

  text += `\n╔════════════════════════════════════════════════════════════╗\n`;
  text += `║  ${doc.operationId.padEnd(56)} ║\n`;
  text += `╚════════════════════════════════════════════════════════════╝\n\n`;

  text += `${doc.method} ${doc.path}\n`;
  if (doc.summary) text += `${doc.summary}\n`;
  text += '\n';

  if (doc.description) {
    text += `Description:\n${doc.description}\n\n`;
  }

  // Parameters
  if (doc.parameters && doc.parameters.length > 0) {
    text += `Parameters:\n`;

    const required = doc.parameters.filter(p => p.required);
    const optional = doc.parameters.filter(p => !p.required);

    if (required.length > 0) {
      text += `\nRequired:\n`;
      required.forEach(param => {
        text += `  • ${param.name} (${param.in})\n`;
        if (param.description) {
          text += `    ${param.description}\n`;
        }
        if (param.example) {
          text += `    Example: ${param.example}\n`;
        }
      });
    }

    if (optional.length > 0) {
      text += `\nOptional:\n`;
      optional.forEach(param => {
        text += `  • ${param.name} (${param.in})\n`;
        if (param.description) {
          text += `    ${param.description}\n`;
        }
      });
    }

    text += '\n';
  }

  return text;
}

/**
 * Extract required parameters from documentation
 *
 * @param {Object} doc - Documentation object
 * @returns {Array} Array of required parameter objects
 */
function getRequiredParameters(doc) {
  if (!doc.parameters) return [];
  return doc.parameters.filter(p => p.required);
}

/**
 * Get parameter by name
 *
 * @param {Object} doc - Documentation object
 * @param {string} paramName - Parameter name
 * @returns {Object|null} Parameter object or null
 */
function getParameter(doc, paramName) {
  if (!doc.parameters) return null;
  return doc.parameters.find(p => p.name === paramName) || null;
}

/**
 * Validate parameter value against schema
 *
 * @param {Object} param - Parameter documentation
 * @param {any} value - Value to validate
 * @returns {Object} { valid: boolean, error: string|null }
 */
function validateParameter(param, value) {
  if (!param.schema) {
    return { valid: true, error: null };
  }

  const schema = param.schema;

  // Type validation
  if (schema.type) {
    const actualType = typeof value;
    const expectedType = schema.type === 'integer' ? 'number' : schema.type;

    if (actualType !== expectedType) {
      return {
        valid: false,
        error: `Expected ${schema.type}, got ${actualType}`
      };
    }
  }

  // Enum validation
  if (schema.enum && !schema.enum.includes(value)) {
    return {
      valid: false,
      error: `Value must be one of: ${schema.enum.join(', ')}`
    };
  }

  // Pattern validation
  if (schema.pattern && typeof value === 'string') {
    const regex = new RegExp(schema.pattern);
    if (!regex.test(value)) {
      return {
        valid: false,
        error: `Value must match pattern: ${schema.pattern}`
      };
    }
  }

  // Range validation
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return {
        valid: false,
        error: `Value must be >= ${schema.minimum}`
      };
    }

    if (schema.maximum !== undefined && value > schema.maximum) {
      return {
        valid: false,
        error: `Value must be <= ${schema.maximum}`
      };
    }
  }

  // Length validation
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return {
        valid: false,
        error: `Length must be >= ${schema.minLength}`
      };
    }

    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return {
        valid: false,
        error: `Length must be <= ${schema.maxLength}`
      };
    }
  }

  return { valid: true, error: null };
}

/**
 * Get default value for a parameter
 *
 * @param {Object} param - Parameter documentation
 * @returns {any} Default value or undefined
 */
function getDefaultValue(param) {
  if (param.schema && param.schema.default !== undefined) {
    return param.schema.default;
  }
  return undefined;
}

module.exports = {
  retrieveDocumentation,
  formatDocumentation,
  formatForAI,
  formatForHuman,
  getRequiredParameters,
  getParameter,
  validateParameter,
  getDefaultValue,
};
