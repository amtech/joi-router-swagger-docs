'use strict';

const pathToRegex = require('path-to-regexp');
const j2s = require('joi-to-swagger');
const each = require('lodash/each');
const pick = require('lodash/pick');
const get = require('lodash/get');
const some = require('lodash/some');
const _ = require('lodash');
const mapValues = require('lodash/mapValues');
const captureRegex = /(:\w+)/g;

const JSON_SCHEMA_FIELDS = [
  'type',
  'required',

  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  /*'pattern',*/ 'maxItems',
  'minItems',
  'uniqueItems',
  'enum',
  'multipleOf'
];

exports.mergeSwaggerPaths = function mergeSwaggerPaths(
  paths,
  newPaths,
  options
) {
  const warn = options && options.warnFunc;

  each(newPaths, function(newPathItemObj, path) {
    let pathItemObj = (paths[path] = paths[path] || {});

    // Merge operations into path
    each(newPathItemObj, function(operationObj, method) {
      if (pathItemObj[method]) {
        // already exists!
        if (warn) warn(`${path}[${method}] exists in multiple routes`);
        return;
      }

      pathItemObj[method] = operationObj;
    });
  });

  return paths;
};

/**
 * For a given joi-router route, return an array of Swagger paths.
 * @param {object} route
 * @returns {object[]} paths
 */
exports.routeToSwaggerPaths = function routeToSwaggerPaths(route, options) {
  options = options || {};

  let paths = {};
  // let routeDesc = {
  //   responses: {
  //     200: {
  //       description: 'Success'
  //     }
  //   }
  // };

  let routeDesc = {
    // responses: {
    //   200: {
    //     description: 'Success'
    //   }
    // }
  };

  if (route.validate) {
    let type = route.validate.type;

    if (!type) {
      // do nothing
    } else if (type === 'json') {
      routeDesc.consumes = ['application/json'];
    } else if (type === 'form' || type === 'multipart') {
      throw new Error(`${type} type not supported`);
    }

    routeDesc.parameters = exports.validateToSwaggerParameters(
      route.validate,
      options.definitions
    );

    routeDesc.responses = exports.validateToSwaggerResponses(
      route.validate,
      options.definitions
    );

    // TODO: add responses from output schema
  }

  if (route.meta && route.meta.swagger) {
    Object.assign(routeDesc, route.meta.swagger);
  }

  // This sets default 'path' parameters so swagger-ui doesn't complain.
  let noPathParamsExist = !some(routeDesc.parameters, ['in', 'path']);
  let noPathValidatorExists = get(route, 'validate.path') === undefined;
  if (noPathParamsExist && noPathValidatorExists) {
    routeDesc.parameters = routeDesc.parameters || [];
    let pathCaptures = route.path.match(captureRegex);
    if (pathCaptures) {
      each(pathCaptures, function(pathParameter) {
        routeDesc.parameters.push({
          name: pathParameter.replace(':', ''),
          in: 'path',
          type: 'string',
          required: true
        });
      });
    }
  }

  let path = exports.swaggerizePath(route.path);

  if (options.prefix) {
    if (options.prefix.endsWith('/') || path.startsWith('/')) {
      path = `${options.prefix}${path}`;
    } else {
      path = `${options.prefix}/${path}`;
    }
  }

  let pathItemObj = (paths[path] = {});

  let methods = Array.isArray(route.method) ? route.method : [route.method];

  methods.forEach(function(method) {
    let operationObj = routeDesc;
    pathItemObj[method.toLowerCase()] = operationObj;
  });

  return paths;
};

function addSchemaParameters(parameters, location, schema, definitions) {
  let swaggerObject = j2s(schema).swagger;
  // console.log(swaggerObject);
  //does this exact object exist as a ref in definitions?! if so use the $ref syntax
  let possibleRef = _.get(definitions, swaggerObject.name);
  if (!_.isEmpty(possibleRef) && _.isEqual(possibleRef, swaggerObject)) {
    // console.log('match for ' + swaggerObject.name);
    // console.log(possibleRef);
  }
  if (swaggerObject.type === 'object' && swaggerObject.properties) {
    each(swaggerObject.properties, function(value, name) {
      let parameter = value;
      parameter.name = name;
      parameter.in = location;
      parameters.push(parameter);
    });
  }
}

/**
 * Convert a JSON schema object to the subset used by Swagger
 */
exports.jsonSchemaToSwagger = function(jsonSchema) {
  if (Array.isArray(jsonSchema)) {
    return jsonSchema.map(exports.jsonSchemaToSwagger);
  }

  let schema = pick(jsonSchema, JSON_SCHEMA_FIELDS);

  if (jsonSchema.items) {
    // FIXME HACK
    if (Array.isArray(jsonSchema.items)) {
      jsonSchema.items = jsonSchema.items[0];
    }

    schema.items = exports.jsonSchemaToSwagger(jsonSchema.items);
  }

  if (jsonSchema.properties) {
    schema.properties = mapValues(jsonSchema.properties, function(value) {
      return exports.jsonSchemaToSwagger(value);
    });
  }

  return schema;
};

/**
 * Convert the joi-router output to swagger
 */
exports.validateToSwaggerResponses = function(validate, definitions) {
  let finalResponses = {};
  let output = _.get(validate, 'output');
  if (!_.isEmpty(output)) {
    _.each(output, function(value, key) {
      let swagger = j2s(value.body, definitions).swagger;
      let joiDesc = _.get(value.body, '_description', 'No description listed');
      _.set(finalResponses, key, {
        description: joiDesc,
        schema: swagger
      });
    });
  }
  // console.log(finalResponses);
  return finalResponses;
};

/**
 * Convert joi-router validate object to swagger
 */
exports.validateToSwaggerParameters = function(validate, definitions) {
  let parameters = [];
  if (validate.header) {
    // console.log('header: ');
    addSchemaParameters(parameters, 'header', validate.header, definitions);
  }

  if (validate.query) {
    // console.log('query: ');
    addSchemaParameters(parameters, 'query', validate.query, definitions);
  }

  if (validate.path) {
    // console.log('path: ');
    // TODO: Write about in README.md
    addSchemaParameters(parameters, 'path', validate.path, definitions);
  }

  if (validate.body) {
    // console.log('body: ');
    if (!_.isEmpty(validate.body)) {
      let swaggerSchema = j2s(validate.body, definitions).swagger;
      let name = 'body';
      if (swaggerSchema['$ref']) {
        name = swaggerSchema['$ref'].split('/')[2];
      }
      if (
        validate.body._meta &&
        !_.isEmpty(_.find(validate.body._meta, 'swaggerName'))
      ) {
        name = _.find(validate.body._meta, 'swaggerName')['swaggerName'];
      }

      parameters.push({
        name: name,
        in: 'body',
        schema: swaggerSchema
      });
    }
  }
  return parameters;
};

/* Convert a joi-router path into a Swagger parameterized path,
 * e.g. /users/:userId becomes /users/{userId}
 *
 * FIXME: incomplete handling, escaping, etc
 * FIXME: throw error if a complex regex is used
 */
exports.swaggerizePath = function swaggerizePath(path) {
  let pathTokens = pathToRegex.parse(path);

  let segments = pathTokens.map(function(token) {
    let segment = token;

    if (token.name) {
      segment = `{${token.name}}`; //this means this is a complex regex group. for more info, read up on path-to-regexp, koa-joi-router uses it, it's great.
    } else {
      segment = token.replace('/', ''); //remove leading slash, to handle things like complex routes: /users/:userId/friends/:friendId
    }

    return segment;
  });

  return '/' + segments.join('/'); //path is normalized, just add that leading slash back to handle prefixes properly again.
};
