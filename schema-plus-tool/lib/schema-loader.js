/**
 * schema-loader.js
 *
 * Loads a GraphQL SDL file, parses it with the `graphql` package, and extracts
 * structured operation summaries for the analyzer and enricher.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { buildSchema, parse, GraphQLObjectType, GraphQLNonNull,
        GraphQLList, GraphQLScalarType, GraphQLEnumType,
        GraphQLInputObjectType } = require('graphql');

/**
 * Unwrap NonNull and List wrappers to get the named type.
 */
function unwrapType(type) {
  if (type instanceof GraphQLNonNull || type instanceof GraphQLList) {
    return unwrapType(type.ofType);
  }
  return type;
}

/**
 * Produce a human-readable type string (e.g. "String!", "[Character]!").
 */
function typeString(type) {
  if (type instanceof GraphQLNonNull) return `${typeString(type.ofType)}!`;
  if (type instanceof GraphQLList)    return `[${typeString(type.ofType)}]`;
  return type.name;
}

/**
 * Extract field names from a GraphQL object type (top level only).
 */
function objectFieldNames(type) {
  if (!type || typeof type.getFields !== 'function') return [];
  return Object.keys(type.getFields());
}

/**
 * Extract all operation summaries from the Query type.
 * Returns an array of objects ready for OpenAI analysis.
 */
function extractOperationSummaries(schema) {
  const queryType = schema.getQueryType();
  if (!queryType) return [];

  const summaries = [];

  for (const [name, field] of Object.entries(queryType.getFields())) {
    const args = field.args.map(arg => ({
      name: arg.name,
      type: typeString(arg.type),
      required: arg.type instanceof GraphQLNonNull,
      description: arg.description || '',
      isInputObject: unwrapType(arg.type) instanceof GraphQLInputObjectType,
    }));

    const returnType   = unwrapType(field.type);
    const isList       = field.type instanceof GraphQLNonNull
      ? field.type.ofType instanceof GraphQLList
      : field.type instanceof GraphQLList;

    const responseFields = objectFieldNames(returnType);

    // If the return type wraps a paginated result (e.g. Characters { info, results })
    // look inside 'results' for the actual item fields
    let itemFields = responseFields;
    if (responseFields.includes('results')) {
      const resultsField = returnType.getFields?.()?.results;
      if (resultsField) {
        const itemType = unwrapType(resultsField.type);
        itemFields = objectFieldNames(itemType);
      }
    }

    summaries.push({
      operationId: name,
      returnTypeName: typeString(field.type),
      isList,
      isPaginated: responseFields.includes('info') && responseFields.includes('results'),
      description: field.description || '',
      args,
      responseFields,
      itemFields,
    });
  }

  return summaries;
}

/**
 * Extract all type definitions for context (non-scalar, non-built-in types).
 */
function extractTypeMap(schema) {
  const typeMap = {};
  for (const [name, type] of Object.entries(schema.getTypeMap())) {
    if (name.startsWith('__')) continue;
    if (type instanceof GraphQLScalarType) continue;
    if (name === 'Query' || name === 'Mutation' || name === 'Subscription') continue;

    if (type instanceof GraphQLObjectType) {
      typeMap[name] = {
        kind: 'type',
        fields: objectFieldNames(type),
      };
    } else if (type instanceof GraphQLInputObjectType) {
      typeMap[name] = {
        kind: 'input',
        fields: objectFieldNames(type),
      };
    } else if (type instanceof GraphQLEnumType) {
      typeMap[name] = {
        kind: 'enum',
        values: type.getValues().map(v => v.name),
      };
    }
  }
  return typeMap;
}

/**
 * Load a GraphQL SDL file.
 *
 * @param {string} filePath
 * @returns {{ schema, sdl, summaries, typeMap, apiName }}
 */
function loadSchema(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`Schema file not found: ${abs}`);

  const sdl = fs.readFileSync(abs, 'utf8');
  const schema = buildSchema(sdl);

  const summaries = extractOperationSummaries(schema);
  const typeMap   = extractTypeMap(schema);
  const apiName   = path.basename(abs, path.extname(abs)).replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

  return { schema, sdl, summaries, typeMap, apiName, filePath: abs };
}

module.exports = { loadSchema, typeString, unwrapType, objectFieldNames };
