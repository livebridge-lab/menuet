/*!
 * Menuet.
 * Copyright(c) 2017-present LiveBridge Co., Ltd.
 */
'use strict';

const express = require('express');
const requireDir = require('../../utils/require-dir');
const Context = require('./../context');
const pick = require('lodash/pick');
const difference = require('lodash/difference');

const BROWSER_USER_AGENT = /^Mozilla\//;

const CONFIG = Symbol.for('config');
const INTERCEPTORS = Symbol.for('interceptors');
const DEFAULT_RESOLVER = Symbol.for('defaultResolver');
const ERROR_RESOLVER = Symbol.for('errorResolver');
const GET_CONTROLLER = Symbol.for('getController');
const GET_RESOLVER = Symbol.for('getResolver');
const AJV_INSTANCE = Symbol.for('ajv');
const SCHEMA_VALIDATORS = Symbol.for('schema-validators');
const ROUTER = Symbol.for('router');

/**
 * Get schema validator and compile it when it hasn't been compiled.
 * @param {object} app
 * @param {string} key
 * @returns {function}
 */
const getSchemaValidator = (app, key) => {

  if (key === '*') {
    return data => data;
  }

  let validator = app[SCHEMA_VALIDATORS][key];

  if (!validator) {
    let ajv = app[AJV_INSTANCE];
    validator = app[SCHEMA_VALIDATORS][key] = ajv.getSchema(key);
  }

  return validator;
};

/**
 * Load routes.
 * @param {object} app
 * @param {string} routesDir
 * @returns {Promise}
 */
module.exports = async (app, routesDir) => {

  if (!routesDir) {
    return;
  }

  let router = express.Router(app[CONFIG].http.router), routes = [];

  await requireDir(routesDir, '.json', (definitions) => {
    routes = routes.concat(definitions.routes || definitions);
  });

  const defaultResolver = app[DEFAULT_RESOLVER];
  const errorResolver = app[ERROR_RESOLVER];

  console.log('Total count of APIs: '.green + `${routes.length}`.yellow);

  routes.forEach(definition => {

    if (!Array.isArray(definition.path)) {
      definition.path = [definition.path];
    }

    definition.paths = (definition.path || [])
      .map(path => {
        if (path) {
          if (typeof(path) === 'string') {
            return {path};
          }
          if (path.path) {
            return path;
          }
        }
      })
      .filter(path => (path && path.path));

    if (definition.paths.length === 0) {
      throw new Error(`[${definition.name}] path is required`);
    }

    if (typeof(definition.method) !== 'string') {
      throw new Error(`[${definition.paths[0].path}] method is required`);
    }

    definition.method = definition.method.toLowerCase();

    let handler = definition.handler ? app[GET_CONTROLLER](definition.handler) : null;

    if (typeof(handler) !== 'function') {
      throw new Error(`[${definition.paths[0].path}] handler is required`);
    }

    let interceptors = [];

    // set route's interceptors' queue
    (definition.interceptors || []).concat(definition.filters || []).forEach(interceptorConfig => {

      if (typeof(interceptorConfig) === 'string') {
        interceptorConfig = { name: interceptorConfig };
      }

      let interceptor = app[INTERCEPTORS][interceptorConfig.name];

      if (!interceptor) {
        throw new Error(`no such interceptor: '${interceptorConfig.name}'`);
      }

      interceptors.push(req => interceptor(req, interceptorConfig.options));
    });

    let validateParams, validateQuery, validateBody, validateResponse;

    // get validator for validating path parameters
    if (definition.params
        && !(validateParams = getSchemaValidator(app, definition.params))) {
      throw new Error(`form schema not found: ${definition.params}`);
    }

    // get validator for validating query data parse from request URL's query string
    if (definition.query
        && !(validateQuery = getSchemaValidator(app, definition.query))) {
      throw new Error(`form schema not found: ${definition.query}`);
    }

    // get validator for validating request body
    if (definition.body
        && !(validateBody = getSchemaValidator(app, definition.body))) {
      throw new Error(`form schema not found: ${definition.body}`);
    }

    // get validator for validating response data
    if (definition.response
       && !(validateResponse = getSchemaValidator(app, definition.response))) {
      throw new Error(`form schema not found: ${definition.response}`);
    }

    let resolvers = [];

    // set route's resolvers' queue
    (definition.resolvers || []).forEach(resolverConfig => {

      if (typeof(resolverConfig) === 'string') {
        resolverConfig = { name: resolverConfig };
      }

      const resolver = app[GET_RESOLVER](resolverConfig.name);

      if (!resolver) {
        throw new Error(`no such resolver: '${resolverConfig.name}'`);
      }

      resolvers.push((res, result) => resolver(res, resolverConfig.options, result));
    });

    // define routes
    definition.paths.forEach(pathConfig => {

      router[definition.method](pathConfig.path, async (req, res) => {

        //// referer URL is required when the user agent is a browser
        //if (BROWSER_USER_AGENT.test(req.get('user-agent')) && !req.get('referer')) {
        //  errorResolver(res, 'error.access-denied');
        //  res.end();
        //  return;
        //}

        let validated = false;
        let result = {};

        // call interceptors and handlers
        try {

          let paramsExtended = pathConfig.params || {};
          let queryExtended = pathConfig.query || {};

          Object.assign(req.params, paramsExtended);
          Object.assign(req.query, queryExtended);

          // call interceptors
          for (let interceptor of interceptors) {

            let paramKeys = Object.keys(req.params);
            let queryKeys = Object.keys(req.query);

            await interceptor(req);

            Object.assign(
              paramsExtended,
              pick(req.params, difference(Object.keys(req.params), paramKeys))
            );

            Object.assign(
              queryExtended,
              pick(req.query, difference(Object.keys(req.query), queryKeys))
            );
          }

          // validate path parameters
          if (validateParams) {
            await validateParams(req.params);
          } else {
            req.params = {};
          }

          Object.assign(req.params, paramsExtended);

          // validate query data parse from request URL's query string
          if (validateQuery) {
            await validateQuery(req.query);
          } else {
            req.query = {};
          }

          Object.assign(req.query, queryExtended);

          // validate request body
          if (validateBody) {
            await validateBody(req.body);
          } else {
            req.body = {};
          }

          validated = true;

          // call handler
          let data = await handler(new Context(app, req, res));

          if (res.finished) {
            return;
          }

          // resolve result data
          result = await defaultResolver(res, data);

          // run custom resolvers
          for (let resolver of resolvers) {
            await resolver(res, result);
          }

          // validate response data
          if (validateResponse) {
            await validateResponse(result);
          } else {
            // TODO
            //result = {};
          }

        // resolve error(s)
        } catch (e) {

          if (e.validation === true) {
            if (!validated) {
              e.name = 'RequestDataValidationError';
              e.statusCode = 400;
            } else {
              e.name = 'ResponseDataValidationError';
              e.statusCode = 500;
            }
          }

          result = await errorResolver(res, e);
        }

        res.json(result).end();
      });
    });
  });

  app[ROUTER] = router;
};
